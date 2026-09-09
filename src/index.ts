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
app.use('/api', paymentsRouter) // expose /api/payments/cinetpay/init et /api/webhooks/cinetpay

const port = process.env.PORT ? Number(process.env.PORT) : 8090
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[laflhai-wallet-service] à l'écoute sur le port ${port}`)
  startCatalogSyncJob()
})
