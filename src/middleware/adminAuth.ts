import { Request, Response, NextFunction } from 'express'

export function requireAdminKey(req: Request, res: Response, next: NextFunction) {
  const key = req.header('X-Admin-Key')
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Non autorisé' })
  }
  next()
}
