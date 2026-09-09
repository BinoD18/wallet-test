import { TelecomProvider, CallResult, SmsResult, EsimResult, RateSheet } from './types'

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01'

export class TwilioProvider implements TelecomProvider {
  readonly name = 'twilio'

  private authHeader() {
    const sid = process.env.TWILIO_ACCOUNT_SID
    const token = process.env.TWILIO_AUTH_TOKEN
    return 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64')
  }

  async placeCall(from: string, to: string, walletId: string): Promise<CallResult> {
    try {
      const sid = process.env.TWILIO_ACCOUNT_SID
      const res = await fetch(`${TWILIO_API_BASE}/Accounts/${sid}/Calls.json`, {
        method: 'POST',
        headers: {
          Authorization: this.authHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ From: from, To: to, Url: 'https://laflhai.com/twiml/bridge' }),
      })
      const data = (await res.json()) as any
      if (!res.ok) return { success: false, error: data?.message ?? 'Erreur Twilio inconnue' }
      return { success: true, providerCallId: data.sid }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendSms(to: string, body: string, walletId: string): Promise<SmsResult> {
    try {
      const sid = process.env.TWILIO_ACCOUNT_SID
      const res = await fetch(`${TWILIO_API_BASE}/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: this.authHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, Body: body, MessagingServiceSid: process.env.TWILIO_MESSAGING_SID ?? '' }),
      })
      const data = (await res.json()) as any
      if (!res.ok) return { success: false, error: data?.message ?? 'Erreur Twilio inconnue' }
      return { success: true, providerMessageId: data.sid }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async provisionEsim(): Promise<EsimResult> {
    // Twilio ne fait pas d'eSIM — le ProviderRouter ne devrait jamais router ici pour esim_data.
    return { success: false, error: 'Twilio ne propose pas de provisioning eSIM' }
  }

  async getRates(destinationCountry: string): Promise<RateSheet> {
    // Twilio Pricing API — endpoint réel: /v1/Voice/Countries/{iso} et /v1/Messaging/Countries/{iso}
    return { destinationCountry, currency: 'USD', smsCost: 0.245, voiceCostPerMinute: 0.15 }
  }
}
