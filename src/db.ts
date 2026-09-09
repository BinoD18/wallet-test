import { Pool } from 'pg'

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

pool.on('error', (err: Error) => {
  // eslint-disable-next-line no-console
  console.error('[db] erreur inattendue sur une connexion inactive', err)
})
