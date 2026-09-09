import { Router } from 'express'
import { pool } from '../db'

export const esimRouter = Router()

esimRouter.get('/esim/plans', async (req, res) => {
  const { country, region } = req.query
  const r = await pool.query(
    `SELECT * FROM product_catalog WHERE category = 'esim_data' AND active = true
       AND ($1::text IS NULL OR destination_country = $1)
       AND ($2::text IS NULL OR region_code = $2)`,
    [country ?? null, region ?? null],
  )
  res.json(r.rows)
})

esimRouter.get('/esim/profiles/:orderId', async (req, res) => {
  const r = await pool.query(`SELECT * FROM esim_profiles WHERE order_id = $1`, [req.params.orderId])
  if (r.rowCount === 0) return res.status(404).json({ error: 'Profil eSIM introuvable' })
  res.json(r.rows[0])
})

// Marque le profil comme activé une fois que l'utilisateur a scanné le QR / installé le LPA
esimRouter.post('/esim/profiles/:orderId/activate', async (req, res) => {
  const r = await pool.query(
    `UPDATE esim_profiles SET status = 'activated' WHERE order_id = $1 RETURNING *`,
    [req.params.orderId],
  )
  if (r.rowCount === 0) return res.status(404).json({ error: 'Profil eSIM introuvable' })
  await pool.query(`UPDATE orders SET status = 'activated' WHERE id = $1`, [req.params.orderId])
  res.json(r.rows[0])
})
