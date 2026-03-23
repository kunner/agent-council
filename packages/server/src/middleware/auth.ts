import { Request, Response, NextFunction } from 'express'
import { getAuth } from '../firebase/admin.js'

export interface AuthRequest extends Request {
  uid?: string
}

export async function authMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = req.headers.authorization?.split('Bearer ')[1]
  if (!token) {
    res.status(401).json({ error: 'Missing authorization token' })
    return
  }

  try {
    const decoded = await getAuth().verifyIdToken(token)
    req.uid = decoded.uid
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}
