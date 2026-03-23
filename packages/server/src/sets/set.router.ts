import { Router } from 'express'
import { authMiddleware, type AuthRequest } from '../middleware/auth.js'
import { createSet, listSets, deleteSet } from './set.service.js'

export const setRouter: Router = Router()

setRouter.use(authMiddleware)

// List sets
setRouter.get('/:projectId/sets', async (req: AuthRequest, res, next) => {
  try {
    const sets = await listSets(req.params.projectId as string)
    res.json({ sets })
  } catch (err) {
    next(err)
  }
})

// Create set
setRouter.post('/:projectId/sets', async (req: AuthRequest, res, next) => {
  try {
    const { name, role, teammates, alias } = req.body
    if (!name || !role) {
      res.status(400).json({ error: 'name and role are required' })
      return
    }
    const set = await createSet(req.params.projectId as string, { name, role, teammates, alias })
    res.status(201).json({ set })
  } catch (err) {
    next(err)
  }
})

// Delete set
setRouter.delete('/:projectId/sets/:setId', async (req: AuthRequest, res, next) => {
  try {
    await deleteSet(req.params.projectId as string, req.params.setId as string)
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})
