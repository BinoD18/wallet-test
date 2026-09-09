import { Router } from 'express'
import { initCinetPayPayment, handleCinetPayWebhook } from '../payments/cinetpay'
import { getOrCreateWallet } from '../services/walletService'

export const paymentsRouter = Router()

// 1-2. Init + checkout — appelé par l'app mobile quand l'utilisateur choisit un montant
paymentsRouter.post('/payments/cinetpay/init', async (req, res) => {
  const { userId, amount, currency, customerEmail } = req.body
  if (!userId || !amount) return res.status(400).json({ error: 'userId et amount requis' })
  try {
    const wallet = await getOrCreateWallet(userId, currency ?? 'XOF')
    const result = await initCinetPayPayment({
      userId,
      walletId: wallet.id,
      amount,
      currency: currency ?? 'XOF',
      customerEmail,
    })
    res.json(result)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// 3. Webhook notify_url — le point de vérité, jamais la redirection success_url seule
paymentsRouter.post('/webhooks/cinetpay', async (req, res) => {
  try {
    const result = await handleCinetPayWebhook(req.body)
    // Toujours répondre 200 rapidement (traitement déjà synchrone ici car léger)
    res.status(200).json(result)
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error('[cinetpay webhook] erreur', e)
    // On répond 200 quand même pour éviter un rejeu en boucle sur une erreur définitive de notre côté,
    // mais on logge pour investigation manuelle.
    res.status(200).json({ error: e.message })
  }
})
