import { Router } from 'express'
import { pool } from '../db'
import { debitWallet, InsufficientFundsError } from '../services/ledgerService'
import { getWalletByUser } from '../services/walletService'
import { selectProvider, recordProviderFailure, recordProviderSuccess, NoProviderAvailableError } from '../providers/providerRouter'

export const ordersRouter = Router()

/**
 * Achat d'un service (appel, SMS, eSIM). Flux :
 * 1. Charger le produit du catalogue
 * 2. Débiter le wallet (ledger d'abord — jamais l'inverse)
 * 3. Router vers le fournisseur le plus adapté (ProviderRouter §4)
 * 4. Appeler le fournisseur via son adapter
 * 5. Logger la décision de routage pour explicabilité, mettre à jour le statut
 */
ordersRouter.post('/orders', async (req, res) => {
  const { userId, productId, quantity, destinationNumber, smsBody, tier } = req.body
  if (!userId || !productId || !quantity) {
    return res.status(400).json({ error: 'userId, productId, quantity requis' })
  }

  try {
    const productRes = await pool.query(`SELECT * FROM product_catalog WHERE id = $1 AND active = true`, [productId])
    if (productRes.rowCount === 0) return res.status(404).json({ error: 'Produit introuvable ou inactif' })
    const product = productRes.rows[0]

    const wallet = await getWalletByUser(userId)
    if (!wallet) return res.status(404).json({ error: 'Wallet introuvable' })

    const totalPrice = Number(product.price_user) * Number(quantity)

    // Crée l'order en pending AVANT le débit, pour avoir un reference_id stable
    const orderRes = await pool.query(
      `INSERT INTO orders (user_id, product_id, quantity, total_price, status)
       VALUES ($1,$2,$3,$4,'pending') RETURNING *`,
      [userId, productId, quantity, totalPrice],
    )
    let order = orderRes.rows[0]

    try {
      await debitWallet(wallet.id, totalPrice, 'purchase', order.id)
    } catch (e) {
      if (e instanceof InsufficientFundsError) {
        await pool.query(`UPDATE orders SET status = 'failed' WHERE id = $1`, [order.id])
        return res.status(402).json({ error: 'Solde insuffisant' })
      }
      throw e
    }

    const decision = await selectProvider(
      product.category,
      product.destination_country ?? destinationNumber?.slice(0, 3) ?? '',
      tier === 'premium' ? 'premium' : 'standard',
    )

    await pool.query(
      `UPDATE orders SET selected_provider = $1, routing_reason = $2, alternatives_considered = $3, status = 'provisioning'
       WHERE id = $4`,
      [decision.providerId, decision.reason, JSON.stringify(decision.alternativesConsidered), order.id],
    )

    const startedAt = Date.now()
    let providerResult: any
    let finalStatus = 'completed'
    let providerReference: string | null = null

    if (product.category === 'sms') {
      providerResult = await decision.adapter.sendSms(destinationNumber, smsBody ?? '', wallet.id)
      providerReference = providerResult.providerMessageId ?? null
    } else if (product.category === 'voice_intl' || product.category === 'voice_mobile') {
      providerResult = await decision.adapter.placeCall(process.env.LAFLHAI_CALLER_ID ?? '', destinationNumber, wallet.id)
      providerReference = providerResult.providerCallId ?? null
    } else if (product.category === 'esim_data') {
      providerResult = await decision.adapter.provisionEsim(product.plan_code, wallet.id)
      providerReference = providerResult.iccid ?? null
      finalStatus = providerResult.success ? 'ready' : 'failed'
    } else if (product.category.startsWith('satellite')) {
      // Satellite : rarement instantané (architecture-technique.md §5) — provisioning manuel
      finalStatus = 'pending_manual_provisioning'
      providerResult = { success: true }
    } else {
      finalStatus = 'failed'
      providerResult = { success: false, error: 'Catégorie de produit non gérée' }
    }

    if (!providerResult.success && finalStatus !== 'pending_manual_provisioning') {
      finalStatus = 'failed'
      await recordProviderFailure(decision.providerId)
      // Remboursement automatique si le fournisseur a échoué après débit
      await pool.query(
        `INSERT INTO ledger_entries (wallet_id, type, amount, balance_after, reference_type, reference_id)
         SELECT $1, 'credit', $2, balance + $2, 'refund', $3 FROM wallets WHERE id = $1`,
        [wallet.id, totalPrice, order.id],
      )
      await pool.query(`UPDATE wallets SET balance = balance + $1 WHERE id = $2`, [totalPrice, wallet.id])
    } else {
      await recordProviderSuccess(decision.providerId, Date.now() - startedAt)
    }

    const updated = await pool.query(
      `UPDATE orders SET status = $1, provider_reference = $2 WHERE id = $3 RETURNING *`,
      [finalStatus, providerReference, order.id],
    )
    order = updated.rows[0]

    if (product.category === 'esim_data' && finalStatus === 'ready') {
      await pool.query(
        `INSERT INTO esim_profiles (order_id, esim_iccid, esim_lpa_string, status) VALUES ($1,$2,$3,'ready')`,
        [order.id, providerResult.iccid, providerResult.lpaString],
      )
    }

    res.status(201).json({ order, routing: decision.reason, providerResult })
  } catch (e: any) {
    if (e instanceof NoProviderAvailableError) return res.status(503).json({ error: e.message })
    res.status(500).json({ error: e.message })
  }
})

ordersRouter.get('/orders/:id', async (req, res) => {
  const r = await pool.query(`SELECT * FROM orders WHERE id = $1`, [req.params.id])
  if (r.rowCount === 0) return res.status(404).json({ error: 'Order introuvable' })
  res.json(r.rows[0])
})
