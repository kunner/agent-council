import { Router } from 'express'
import { authMiddleware, type AuthRequest } from '../middleware/auth.js'
import { createSet, listSets, deleteSet } from './set.service.js'
import { createLeaderSet } from '../adapters/team-manager.js'
import { removeSession } from '../session/session-manager.js'

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

// Initialize leader for existing project
setRouter.post('/:projectId/sets/init-leader', async (req: AuthRequest, res, next) => {
  try {
    const projectId = req.params.projectId as string
    const existingSets = await listSets(projectId)
    const hasLeader = existingSets.some((s) => s.isLeader)
    if (hasLeader) {
      res.json({ success: true, message: 'Leader already exists' })
      return
    }
    const leader = await createLeaderSet(projectId, 'main')
    res.status(201).json({ set: leader })
  } catch (err) {
    next(err)
  }
})

// Reset session for a set (clear session, start fresh)
setRouter.post('/:projectId/sets/:setId/reset-session', async (req: AuthRequest, res, next) => {
  try {
    const projectId = req.params.projectId as string
    const setId = req.params.setId as string
    // Clear session from memory and Firestore
    removeSession(projectId, setId)
    const { getFirestore } = await import('../firebase/admin.js')
    const db = getFirestore()
    await db.doc(`projects/${projectId}/sets/${setId}`).update({ sessionId: null })
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// Reset all sessions for a project
setRouter.post('/:projectId/sets/reset-all-sessions', async (req: AuthRequest, res, next) => {
  try {
    const projectId = req.params.projectId as string
    const sets = await listSets(projectId)
    const { getFirestore } = await import('../firebase/admin.js')
    const db = getFirestore()
    for (const set of sets) {
      removeSession(projectId, set.id)
      await db.doc(`projects/${projectId}/sets/${set.id}`).update({ sessionId: null })
    }
    res.json({ success: true, count: sets.length })
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
