import 'dotenv/config'
import express from 'express'
import pinoHttp from 'pino-http'
import { walletRouter } from './routes/wallet.routes'
import { paymentsRouter } from './routes/payments.routes'
import { ordersRouter } from './routes/orders.routes'
import { esimRouter } from './routes/esim.routes'
import { satelliteRouter } from './routes/satellite.routes'
import { startCatalogSyncJob } from './jobs/syncCatalog'

const app = express()
app.use(express.json())
app.use(pinoHttp())

app.get('/health', (_req, res) => res.json({ ok: true, service: 'laflhai-wallet-service' }))

app.use('/api', walletRouter)
app.use('/api', ordersRouter)
app.use('/api', esimRouter)
app.use('/api', satelliteRouter)

// paymentsRouter expose /payments/cinetpay/init (API) et /webhooks/cinetpay (notify_url CinetPay)
// monté à la racine pour correspondre exactement à CINETPAY_NOTIFY_URL=https://api.laflhai.com/webhooks/cinetpay
app.use('/', paymentsRouter)

const port = process.env.PORT ? Number(process.env.PORT) : 8090
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[laflhai-wallet-service] à l'écoute sur le port ${port}`)
  startCatalogSyncJob()
})
