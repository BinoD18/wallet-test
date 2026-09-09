import { Router } from 'express'
import { pool } from '../db'

export const satelliteRouter = Router()

satelliteRouter.get('/satellite/plans', async (req, res) => {
  const r = await pool.query(
    `SELECT * FROM product_catalog
     WHERE category IN ('satellite_voice','satellite_data','satellite_iot') AND active = true`,
  )
  res.json(r.rows)
})

// File d'attente des commandes satellite en attente de provisioning manuel (§5)
satelliteRouter.get('/satellite/pending-provisioning', async (req, res) => {
  const r = await pool.query(
    `SELECT o.*, pc.plan_code, pc.requires_hardware, pc.hardware_sku, pc.activation_lead_time_days
     FROM orders o
     JOIN product_catalog pc ON pc.id = o.product_id
     WHERE o.status = 'pending_manual_provisioning'
     ORDER BY o.created_at ASC`,
  )
  res.json(r.rows)
})

// Support/ops : faire avancer manuellement une commande satellite après activation côté agrégateur
satelliteRouter.post('/satellite/orders/:id/mark-activated', async (req, res) => {
  const { providerReference } = req.body
  const r = await pool.query(
    `UPDATE orders SET status = 'activated', provider_reference = $1
     WHERE id = $2 AND status = 'pending_manual_provisioning' RETURNING *`,
    [providerReference ?? null, req.params.id],
  )
  if (r.rowCount === 0) return res.status(404).json({ error: 'Commande introuvable ou déjà traitée' })
  res.json(r.rows[0])
})
