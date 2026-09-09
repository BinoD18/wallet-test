import { Router } from 'express'
import { pool } from '../db'
import { getOrCreateWallet, getWalletHistory } from '../services/walletService'
import { creditWallet } from '../services/ledgerService'

export const walletRouter = Router()

// Crée un utilisateur + son wallet XOF par défaut
walletRouter.post('/users', async (req, res) => {
  const { phoneNumber, email, countryCode } = req.body
  if (!phoneNumber || !countryCode) {
    return res.status(400).json({ error: 'phoneNumber et countryCode requis' })
  }
  try {
    const userRes = await pool.query(
      `INSERT INTO users (phone_number, email, country_code) VALUES ($1,$2,$3) RETURNING *`,
      [phoneNumber, email ?? null, countryCode],
    )
    const user = userRes.rows[0]
    const wallet = await getOrCreateWallet(user.id, 'XOF')
    res.status(201).json({ user, wallet })
  } catch (e: any) {
    if (e.code === '23505') return res.status(409).json({ error: 'Numéro déjà enregistré' })
    res.status(500).json({ error: e.message })
  }
})

walletRouter.get('/users/:userId/wallet', async (req, res) => {
  try {
    const wallet = await getOrCreateWallet(req.params.userId, (req.query.currency as any) ?? 'XOF')
    res.json(wallet)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * Crédite une récompense "Watch & Earn" (voir www/watch-earn.js et wallet-api.js
 * dans LaflhaiTV-WE-complete-fix-v5). Le solde local reste la vérité UX immédiate ;
 * ceci synchronise vers le vrai wallet serveur pour retrait réel/audit.
 * Idempotent par (user, adId, jour) via watch_earn_rewards.
 *
 * Anti-fraude minimal côté serveur (ne jamais faire confiance au seul
 * client pour du crédit réel) : watchedSec minimum + montant plafonné.
 */
const WATCH_EARN_MIN_WATCH_SEC = 15
const WATCH_EARN_REWARD_MAX = 5 // FCFA — garde-fou, ajuster selon CPM réel

walletRouter.post('/rewards/watch-earn', async (req, res) => {
  const { userId, amount, adId, watchedSec } = req.body
  if (!userId || !amount || !adId) {
    return res.status(400).json({ error: 'userId, amount et adId requis' })
  }
  if (Number(watchedSec ?? 0) < WATCH_EARN_MIN_WATCH_SEC) {
    return res.status(400).json({ error: `watchedSec doit être >= ${WATCH_EARN_MIN_WATCH_SEC}s` })
  }
  if (Number(amount) <= 0 || Number(amount) > WATCH_EARN_REWARD_MAX) {
    return res.status(400).json({ error: 'Montant de récompense hors bornes' })
  }
  try {
    const wallet = await getOrCreateWallet(userId, 'XOF')

    const inserted = await pool.query(
      `INSERT INTO watch_earn_rewards (user_id, ad_id, watched_sec, amount)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, ad_id, reward_date) DO NOTHING
       RETURNING *`,
      [userId, adId, watchedSec ?? 0, amount],
    )

    if (inserted.rowCount === 0) {
      return res.status(200).json({ alreadyCredited: true })
    }

    const entry = await creditWallet(wallet.id, Number(amount), 'reward', inserted.rows[0].id)
    res.status(201).json({ alreadyCredited: false, ledgerEntry: entry })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

walletRouter.get('/wallets/:walletId/history', async (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 50
    const history = await getWalletHistory(req.params.walletId, limit)
    res.json(history)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})
