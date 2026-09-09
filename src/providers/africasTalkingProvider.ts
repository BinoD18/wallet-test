import { TelecomProvider, CallResult, SmsResult, EsimResult, RateSheet } from './types'

const AT_API_BASE = 'https://api.africastalking.com/version1'

/**
 * Africa's Talking — spécialisé Afrique (SMS, voix, USSD, airtime, mobile money).
 * Recommandé en primaire sur les corridors africains (architecture-technique.md §2).
 */
export class AfricasTalkingProvider implements TelecomProvider {
  readonly name = 'africas_talking'

  private headers() {
    return {
      apiKey: process.env.AFRICAS_TALKING_API_KEY ?? '',
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    }
  }

  async placeCall(from: string, to: string, walletId: string): Promise<CallResult> {
    try {
      const res = await fetch(`${AT_API_BASE}/voice/call`, {
        method: 'POST',
        headers: this.headers(),
        body: new URLSearchParams({
          username: process.env.AFRICAS_TALKING_USERNAME ?? '',
          from,
          to,
        }),
      })
      const data = (await res.json()) as any
      if (!res.ok) return { success: false, error: data?.errorMessage ?? 'Erreur Africa\'s Talking inconnue' }
      return { success: true, providerCallId: data.entries?.[0]?.sessionId }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendSms(to: string, body: string, walletId: string): Promise<SmsResult> {
    try {
      const res = await fetch(`${AT_API_BASE}/messaging`, {
        method: 'POST',
        headers: this.headers(),
        body: new URLSearchParams({
          username: process.env.AFRICAS_TALKING_USERNAME ?? '',
          to,
          message: body,
        }),
      })
      const data = (await res.json()) as any
      if (!res.ok) return { success: false, error: data?.errorMessage ?? 'Erreur Africa\'s Talking inconnue' }
      return { success: true, providerMessageId: data.SMSMessageData?.Recipients?.[0]?.messageId }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async provisionEsim(): Promise<EsimResult> {
    return { success: false, error: "Africa's Talking ne propose pas de provisioning eSIM" }
  }

  async getRates(destinationCountry: string): Promise<RateSheet> {
    // Endpoint réel: tarifs disponibles via le dashboard / API pricing Africa's Talking
    return { destinationCountry, currency: 'USD', smsCost: 0.01, voiceCostPerMinute: 0.02 }
  }
}
