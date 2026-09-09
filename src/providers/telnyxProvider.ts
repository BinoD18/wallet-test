import { TelecomProvider, CallResult, SmsResult, EsimResult, RateSheet } from './types'

const TELNYX_API_BASE = 'https://api.telnyx.com/v2'

export class TelnyxProvider implements TelecomProvider {
  readonly name = 'telnyx'

  private headers() {
    return {
      Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
      'Content-Type': 'application/json',
    }
  }

  async placeCall(from: string, to: string, walletId: string): Promise<CallResult> {
    try {
      const res = await fetch(`${TELNYX_API_BASE}/calls`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          connection_id: process.env.TELNYX_CONNECTION_ID,
          to,
          from,
        }),
      })
      const data = (await res.json()) as any
      if (!res.ok) return { success: false, error: data?.errors?.[0]?.detail ?? 'Erreur Telnyx inconnue' }
      return { success: true, providerCallId: data.data?.call_control_id }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendSms(to: string, body: string, walletId: string): Promise<SmsResult> {
    try {
      const res = await fetch(`${TELNYX_API_BASE}/messages`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          from: process.env.TELNYX_MESSAGING_NUMBER,
          to,
          text: body,
        }),
      })
      const data = (await res.json()) as any
      if (!res.ok) return { success: false, error: data?.errors?.[0]?.detail ?? 'Erreur Telnyx inconnue' }
      return { success: true, providerMessageId: data.data?.id }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async provisionEsim(): Promise<EsimResult> {
    return { success: false, error: 'Telnyx ne propose pas de provisioning eSIM' }
  }

  async getRates(destinationCountry: string): Promise<RateSheet> {
    // Endpoint réel Telnyx Pricing API à brancher : /v2/pricing
    return { destinationCountry, currency: 'USD', smsCost: 0.01, voiceCostPerMinute: 0.008 }
  }
}
