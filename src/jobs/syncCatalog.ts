import cron from 'node-cron'
import { pool } from '../db'
import { TwilioProvider } from '../providers/twilioProvider'
import { TelnyxProvider } from '../providers/telnyxProvider'
import { AfricasTalkingProvider } from '../providers/africasTalkingProvider'

/**
 * §4 : getRates() ne doit pas être appelé en temps réel à chaque transaction.
 * Ce job resynchronise product_catalog.cost_provider périodiquement (toutes les 6h par défaut)
 * plutôt que de coder les tarifs en dur ou de les interroger à la demande.
 */
const adapters = [new TwilioProvider(), new TelnyxProvider(), new AfricasTalkingProvider()]

export async function syncCatalogOnce() {
  const countriesRes = await pool.query(
    `SELECT DISTINCT destination_country FROM product_catalog WHERE destination_country IS NOT NULL`,
  )

  for (const { destination_country: country } of countriesRes.rows) {
    for (const adapter of adapters) {
      try {
        const rates = await adapter.getRates(country)
        const providerRes = await pool.query(`SELECT id FROM provider_accounts WHERE provider_name = $1`, [
          adapter.name,
        ])
        if (providerRes.rowCount === 0) continue
        const providerId = providerRes.rows[0].id

        if (rates.smsCost !== undefined) {
          await pool.query(
            `UPDATE product_catalog SET cost_provider = $1, synced_at = now()
             WHERE provider_id = $2 AND category = 'sms' AND destination_country = $3`,
            [rates.smsCost, providerId, country],
          )
        }
        if (rates.voiceCostPerMinute !== undefined) {
          await pool.query(
            `UPDATE product_catalog SET cost_provider = $1, synced_at = now()
             WHERE provider_id = $2 AND category IN ('voice_intl','voice_mobile') AND destination_country = $3`,
            [rates.voiceCostPerMinute, providerId, country],
          )
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[syncCatalog] échec sync ${adapter.name} / ${country}`, e)
      }
    }
  }
}

export function startCatalogSyncJob() {
  // Toutes les 6 heures — ajuster selon la volatilité tarifaire du fournisseur
  cron.schedule('0 */6 * * *', () => {
    syncCatalogOnce().catch((e) => console.error('[syncCatalog] job échoué', e))
  })
}
