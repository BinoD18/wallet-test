import { pool } from '../db'

export async function getOrCreateWallet(userId: string, currency: 'XOF' | 'USD' | 'EUR' = 'XOF') {
  const existing = await pool.query(
    `SELECT * FROM wallets WHERE user_id = $1 AND currency = $2`,
    [userId, currency],
  )
  if ((existing.rowCount ?? 0) > 0) return existing.rows[0]

  const created = await pool.query(
    `INSERT INTO wallets (user_id, currency) VALUES ($1, $2) RETURNING *`,
    [userId, currency],
  )
  return created.rows[0]
}

export async function getWalletByUser(userId: string, currency = 'XOF') {
  const res = await pool.query(`SELECT * FROM wallets WHERE user_id = $1 AND currency = $2`, [userId, currency])
  return res.rows[0] ?? null
}

export async function getWalletHistory(walletId: string, limit = 50) {
  const res = await pool.query(
    `SELECT * FROM ledger_entries WHERE wallet_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [walletId, limit],
  )
  return res.rows
}
