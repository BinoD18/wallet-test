/**
 * Contrat unique côté backend (architecture-technique.md §1).
 * Chaque fournisseur (TwilioProvider, TelnyxProvider, AfricasTalkingProvider...)
 * implémente cette interface. Le ProviderRouter ne connaît que ce contrat,
 * jamais les détails d'un fournisseur en particulier.
 */
export interface CallResult {
  success: boolean
  providerCallId?: string
  error?: string
}

export interface SmsResult {
  success: boolean
  providerMessageId?: string
  error?: string
}

export interface EsimResult {
  success: boolean
  iccid?: string
  lpaString?: string
  error?: string
}

export interface RateSheet {
  destinationCountry: string
  smsCost?: number
  voiceCostPerMinute?: number
  currency: string
}

export interface TelecomProvider {
  readonly name: string
  placeCall(from: string, to: string, walletId: string): Promise<CallResult>
  sendSms(to: string, body: string, walletId: string): Promise<SmsResult>
  provisionEsim(planId: string, walletId: string): Promise<EsimResult>
  getRates(destinationCountry: string): Promise<RateSheet>
}

export interface ProviderCandidate {
  providerId: string
  providerName: string
  costProvider: number
  reliabilityScore: number
  recentFailureRate: number
  active: boolean
  circuitOpenUntil: Date | null
}
