import { Router } from 'express'
import { authMiddleware, type AuthRequest } from '../middleware/auth.js'
import { getGitStatus, initProjectRepo } from './git.service.js'

export const gitRouter: Router = Router()

gitRouter.use(authMiddleware)

// Initialize git repo for existing project
gitRouter.post('/:projectId/git/init', async (req: AuthRequest, res, next) => {
  try {
    const repoPath = initProjectRepo(req.params.projectId as string)
    res.json({ success: true, repoPath })
  } catch (err) {
    next(err)
  }
})

gitRouter.get('/:projectId/git/status', async (req: AuthRequest, res, next) => {
  try {
    const status = getGitStatus(req.params.projectId as string)
    res.json(status)
  } catch (err) {
    next(err)
  }
})
