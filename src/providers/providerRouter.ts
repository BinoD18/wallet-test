import { pool } from '../db'
import { ProviderCandidate, TelecomProvider } from './types'
import { TwilioProvider } from './twilioProvider'
import { TelnyxProvider } from './telnyxProvider'
import { AfricasTalkingProvider } from './africasTalkingProvider'

export class NoProviderAvailableError extends Error {
  constructor(category: string, destinationCountry: string) {
    super(`Aucun fournisseur disponible pour ${category} / ${destinationCountry}`)
    this.name = 'NoProviderAvailableError'
  }
}

export interface RoutingDecision {
  providerId: string
  providerName: string
  adapter: TelecomProvider
  reason: string
  alternativesConsidered: { providerId: string; providerName: string; costProvider: number }[]
}

const RELIABILITY_THRESHOLD_PREMIUM = 0.98
const FAILURE_RATE_SKIP_THRESHOLD = 0.05

/** Registre des adaptateurs concrets — étendre ici pour Airalo/eSIM Go/agrégateurs satellite. */
const ADAPTERS: Record<string, () => TelecomProvider> = {
  twilio: () => new TwilioProvider(),
  telnyx: () => new TelnyxProvider(),
  africas_talking: () => new AfricasTalkingProvider(),
}

/**
 * Implémente l'algorithme de sélection décrit dans architecture-technique.md §4 :
 * 1. Filtre par catégorie + pays + actif + hors circuit-breaker
 * 2. Filtre par fiabilité si tier "premium"
 * 3. Trie par coût réel (cost_provider), pas le prix affiché à l'utilisateur
 * 4. Pondère par le taux d'échec récent (bascule sur le suivant si trop élevé)
 */
export async function selectProvider(
  category: string,
  destinationCountry: string,
  tier: 'standard' | 'premium' = 'standard',
): Promise<RoutingDecision> {
  const res = await pool.query(
    `SELECT pc.id AS product_id, pa.id AS provider_id, pa.provider_name, pc.cost_provider,
            pa.reliability_score, pa.recent_failure_rate, pa.active, pa.circuit_open_until
     FROM product_catalog pc
     JOIN provider_accounts pa ON pa.id = pc.provider_id
     WHERE pc.category = $1
       AND (pc.destination_country = $2 OR pc.destination_country IS NULL)
       AND pc.active = true
       AND pa.active = true
       AND (pa.circuit_open_until IS NULL OR pa.circuit_open_until < now())`,
    [category, destinationCountry],
  )

  let candidates: ProviderCandidate[] = res.rows.map((r: any) => ({
    providerId: r.provider_id,
    providerName: r.provider_name,
    costProvider: Number(r.cost_provider),
    reliabilityScore: Number(r.reliability_score),
    recentFailureRate: Number(r.recent_failure_rate),
    active: r.active,
    circuitOpenUntil: r.circuit_open_until,
  }))

  if (candidates.length === 0) {
    throw new NoProviderAvailableError(category, destinationCountry)
  }

  // 2. Filtrer par tier de qualité si demandé
  if (tier === 'premium') {
    const filtered = candidates.filter((c) => c.reliabilityScore >= RELIABILITY_THRESHOLD_PREMIUM)
    if (filtered.length > 0) candidates = filtered
  }

  // 3. Trier par coût réel ascendant
  candidates.sort((a, b) => a.costProvider - b.costProvider)

  // 4. Pondération santé/latence récente — pas seulement le prix
  let primary = candidates[0]
  let reason = 'moins cher parmi les candidats actifs'
  if (primary.recentFailureRate > FAILURE_RATE_SKIP_THRESHOLD) {
    const fallback = candidates[1]
    if (fallback) {
      reason = `taux d'échec récent de ${primary.providerName} trop élevé (${primary.recentFailureRate}), bascule sur ${fallback.providerName}`
      primary = fallback
    } else {
      reason = `seul candidat disponible malgré un taux d'échec élevé (${primary.recentFailureRate})`
    }
  }

  const factory = ADAPTERS[primary.providerName]
  if (!factory) {
    throw new Error(`Aucun adapter implémenté pour le fournisseur "${primary.providerName}"`)
  }

  return {
    providerId: primary.providerId,
    providerName: primary.providerName,
    adapter: factory(),
    reason,
    alternativesConsidered: candidates
      .filter((c) => c.providerId !== primary.providerId)
      .map((c) => ({ providerId: c.providerId, providerName: c.providerName, costProvider: c.costProvider })),
  }
}

/**
 * Circuit breaker : à appeler après un échec d'appel fournisseur.
 * Si 3 échecs consécutifs sur une fenêtre courte, on sort le fournisseur
 * du pool temporairement (architecture-technique.md §4).
 */
export async function recordProviderFailure(providerId: string) {
  const res = await pool.query(
    `INSERT INTO provider_health_log (provider_id, is_up) VALUES ($1, false) RETURNING id`,
    [providerId],
  )

  const recent = await pool.query(
    `SELECT is_up FROM provider_health_log
     WHERE provider_id = $1 ORDER BY checked_at DESC LIMIT 3`,
    [providerId],
  )
  const lastThree = recent.rows.map((r: any) => r.is_up)
  const allFailed = lastThree.length === 3 && lastThree.every((up: boolean) => up === false)

  if (allFailed) {
    await pool.query(
      `UPDATE provider_accounts SET circuit_open_until = now() + interval '10 minutes' WHERE id = $1`,
      [providerId],
    )
  }
  return { entryId: res.rows[0].id, circuitOpened: allFailed }
}

export async function recordProviderSuccess(providerId: string, latencyMs?: number) {
  await pool.query(
    `INSERT INTO provider_health_log (provider_id, is_up, latency_ms) VALUES ($1, true, $2)`,
    [providerId, latencyMs ?? null],
  )
}
