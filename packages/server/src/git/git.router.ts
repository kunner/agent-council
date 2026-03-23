import { Router } from 'express'
import { authMiddleware, type AuthRequest } from '../middleware/auth.js'
import { getGitStatus } from './git.service.js'

export const gitRouter: Router = Router()

gitRouter.use(authMiddleware)

gitRouter.get('/:projectId/git/status', async (req: AuthRequest, res, next) => {
  try {
    const status = getGitStatus(req.params.projectId as string)
    res.json(status)
  } catch (err) {
    next(err)
  }
})
