import { PoolClient } from 'pg'
import { pool } from '../db'

export type LedgerReferenceType = 'topup' | 'purchase' | 'refund' | 'adjustment' | 'reward'
export type LedgerEntryType = 'credit' | 'debit'

export class InsufficientFundsError extends Error {
  constructor() {
    super('Solde insuffisant')
    this.name = 'InsufficientFundsError'
  }
}

/**
 * Règle d'or (voir architecture-technique.md §1) :
 * `wallets.balance` n'est JAMAIS modifié directement en code métier.
 * On calcule le nouveau solde à partir de la somme des ledger_entries,
 * on insère la nouvelle ligne, puis on met à jour wallets.balance pour
 * qu'il reflète (et non détermine) cette vérité comptable.
 *
 * Verrouillage : SELECT ... FOR UPDATE sur le wallet pour sérialiser
 * les écritures concurrentes sur le même wallet et éviter les races.
 */
async function appendLedgerEntry(
  client: PoolClient,
  walletId: string,
  type: LedgerEntryType,
  amount: number,
  referenceType: LedgerReferenceType,
  referenceId: string | null,
) {
  if (amount <= 0) throw new Error('Le montant doit être strictement positif')

  const walletRes = await client.query(
    `SELECT id, balance, status FROM wallets WHERE id = $1 FOR UPDATE`,
    [walletId],
  )
  if (walletRes.rowCount === 0) throw new Error('Wallet introuvable')
  const wallet = walletRes.rows[0]
  if (wallet.status !== 'active') throw new Error(`Wallet ${wallet.status}, opération refusée`)

  const currentBalance = Number(wallet.balance)
  const delta = type === 'credit' ? amount : -amount
  const newBalance = Number((currentBalance + delta).toFixed(4))

  if (type === 'debit' && newBalance < 0) {
    throw new InsufficientFundsError()
  }

  const entryRes = await client.query(
    `INSERT INTO ledger_entries (wallet_id, type, amount, balance_after, reference_type, reference_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [walletId, type, amount, newBalance, referenceType, referenceId],
  )

  await client.query(
    `UPDATE wallets SET balance = $1, updated_at = now() WHERE id = $2`,
    [newBalance, walletId],
  )

  return entryRes.rows[0]
}

export async function creditWallet(
  walletId: string,
  amount: number,
  referenceType: LedgerReferenceType,
  referenceId: string | null,
) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const entry = await appendLedgerEntry(client, walletId, 'credit', amount, referenceType, referenceId)
    await client.query('COMMIT')
    return entry
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

export async function debitWallet(
  walletId: string,
  amount: number,
  referenceType: LedgerReferenceType,
  referenceId: string | null,
) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const entry = await appendLedgerEntry(client, walletId, 'debit', amount, referenceType, referenceId)
    await client.query('COMMIT')
    return entry
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

/** Recalcule le solde depuis les ledger_entries — sert d'audit / réparation d'incohérence. */
export async function reconcileWalletBalance(walletId: string) {
  const res = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN type='credit' THEN amount ELSE -amount END), 0) AS computed_balance
     FROM ledger_entries WHERE wallet_id = $1`,
    [walletId],
  )
  const computed = Number(res.rows[0].computed_balance)
  await pool.query(`UPDATE wallets SET balance = $1, updated_at = now() WHERE id = $2`, [computed, walletId])
  return computed
}
