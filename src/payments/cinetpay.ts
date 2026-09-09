import { pool } from '../db'
import { creditWallet } from '../services/ledgerService'

const CINETPAY_BASE = 'https://api-checkout.cinetpay.com/v2'

export interface InitPaymentParams {
  userId: string
  walletId: string
  amount: number
  currency: 'XOF' | 'USD' | 'EUR'
  customerEmail?: string
}

/**
 * 1. Init côté backend (architecture-technique.md §3).
 * Crée d'abord une ligne `payment_transactions` en pending, utilise son id
 * comme merchant_transaction_id (garantit l'unicité et la traçabilité).
 */
export async function initCinetPayPayment(params: InitPaymentParams) {
  const txRes = await pool.query(
    `INSERT INTO payment_transactions (user_id, wallet_id, provider, amount, currency, status)
     VALUES ($1,$2,'cinetpay',$3,$4,'pending') RETURNING *`,
    [params.userId, params.walletId, params.amount, params.currency],
  )
  const tx = txRes.rows[0]

  const apiKey = process.env.CINETPAY_API_KEY_CI
  const siteId = process.env.CINETPAY_SITE_ID_CI

  const res = await fetch(`${CINETPAY_BASE}/payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apikey: apiKey,
      site_id: siteId,
      transaction_id: tx.id, // merchant_transaction_id = notre id interne, jamais généré par CinetPay
      amount: params.amount,
      currency: params.currency,
      description: 'Recharge crédit LAFLHAI',
      customer_email: params.customerEmail,
      notify_url: process.env.CINETPAY_NOTIFY_URL,
      return_url: process.env.CINETPAY_RETURN_URL,
    }),
  })
  const data = (await res.json()) as any

  if (!res.ok || data.code !== '201') {
    await pool.query(`UPDATE payment_transactions SET status = 'failed', raw_payload = $1 WHERE id = $2`, [
      JSON.stringify(data),
      tx.id,
    ])
    throw new Error(`Échec init CinetPay: ${data?.message ?? 'erreur inconnue'}`)
  }

  await pool.query(`UPDATE payment_transactions SET raw_payload = $1 WHERE id = $2`, [JSON.stringify(data), tx.id])

  return { transactionId: tx.id, paymentUrl: data.data?.payment_url as string }
}

/**
 * 4. Vérification obligatoire — rappelle CinetPay en `check status`
 * pour confirmer le montant et l'ID avant de créditer.
 * Ne JAMAIS créditer sur la seule foi du payload webhook.
 */
async function checkCinetPayStatus(transactionId: string) {
  const apiKey = process.env.CINETPAY_API_KEY_CI
  const siteId = process.env.CINETPAY_SITE_ID_CI

  const res = await fetch(`${CINETPAY_BASE}/payment/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apikey: apiKey, site_id: siteId, transaction_id: transactionId }),
  })
  return (await res.json()) as any
}

/**
 * 3+4+5. Handler du webhook `notify_url`.
 * Idempotent : vérifie que la transaction n'a pas déjà été créditée
 * avant d'insérer un nouveau ledger_entries (un webhook peut être
 * renvoyé plusieurs fois par CinetPay).
 */
export async function handleCinetPayWebhook(body: { cpm_trans_id: string }) {
  const transactionId = body.cpm_trans_id
  if (!transactionId) throw new Error('cpm_trans_id manquant')

  const txRes = await pool.query(`SELECT * FROM payment_transactions WHERE id = $1`, [transactionId])
  if (txRes.rowCount === 0) throw new Error('Transaction inconnue')
  const tx = txRes.rows[0]

  // Idempotence : déjà traité, on ne recrédite pas
  if (tx.status === 'accepted') {
    return { alreadyProcessed: true, transaction: tx }
  }

  const status = await checkCinetPayStatus(transactionId)

  if (status.data?.status === 'ACCEPTED') {
    // Vérifie que le montant confirmé correspond à celui attendu
    const confirmedAmount = Number(status.data.amount)
    if (Math.abs(confirmedAmount - Number(tx.amount)) > 0.01) {
      throw new Error('Montant CinetPay confirmé différent du montant attendu — transaction rejetée')
    }

    await pool.query(
      `UPDATE payment_transactions SET status = 'accepted', provider_transaction_id = $1, raw_payload = $2 WHERE id = $3`,
      [status.data.operator_id ?? transactionId, JSON.stringify(status), transactionId],
    )

    const entry = await creditWallet(tx.wallet_id, confirmedAmount, 'topup', tx.id)
    return { alreadyProcessed: false, credited: true, ledgerEntry: entry }
  }

  await pool.query(`UPDATE payment_transactions SET status = 'refused', raw_payload = $1 WHERE id = $2`, [
    JSON.stringify(status),
    transactionId,
  ])
  return { alreadyProcessed: false, credited: false, providerStatus: status.data?.status }
}
