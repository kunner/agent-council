import { Router } from 'express'
import { authMiddleware, type AuthRequest } from '../middleware/auth.js'
import { getGitStatus, initProjectRepo, cloneProjectRepo, removeProjectRepo } from './git.service.js'
import { getFirestore } from '../firebase/admin.js'

export const gitRouter: Router = Router()

gitRouter.use(authMiddleware)

// Initialize empty git repo
gitRouter.post('/:projectId/git/init', async (req: AuthRequest, res, next) => {
  try {
    const projectId = req.params.projectId as string
    const repoPath = initProjectRepo(projectId)

    // Save git config to Firestore
    const db = getFirestore()
    await db.doc(`projects/${projectId}/git/config`).set({
      type: 'local',
      repoUrl: null,
      localPath: repoPath,
      isPrivate: false,
      connectedAt: new Date().toISOString(),
    }, { merge: true })

    const status = getGitStatus(projectId)
    res.json({ success: true, ...status })
  } catch (err) {
    next(err)
  }
})

// Clone existing repo
gitRouter.post('/:projectId/git/clone', async (req: AuthRequest, res, next) => {
  try {
    const projectId = req.params.projectId as string
    const { repoUrl, token } = req.body
    if (!repoUrl) {
      res.status(400).json({ error: 'repoUrl is required' })
      return
    }
    const repoPath = cloneProjectRepo(projectId, repoUrl, token)

    // Extract repo name from URL
    const repoName = repoUrl.replace(/\.git$/, '').split('/').slice(-2).join('/')

    // Save git config to Firestore
    const db = getFirestore()
    await db.doc(`projects/${projectId}/git/config`).set({
      type: 'remote',
      repoUrl,
      repoName,
      localPath: repoPath,
      isPrivate: !!token,
      connectedAt: new Date().toISOString(),
    }, { merge: true })

    const status = getGitStatus(projectId)
    res.json({ success: true, ...status })
  } catch (err) {
    next(err)
  }
})

// Disconnect git repo
gitRouter.delete('/:projectId/git', async (req: AuthRequest, res, next) => {
  try {
    const projectId = req.params.projectId as string
    removeProjectRepo(projectId)

    const db = getFirestore()
    await db.doc(`projects/${projectId}/git/config`).delete()

    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// Get git status + config
gitRouter.get('/:projectId/git/status', async (req: AuthRequest, res, next) => {
  try {
    const projectId = req.params.projectId as string
    const status = getGitStatus(projectId)

    // Get saved config from Firestore
    const db = getFirestore()
    const configDoc = await db.doc(`projects/${projectId}/git/config`).get()
    const config = configDoc.exists ? configDoc.data() : null

    res.json({ ...status, config })
  } catch (err) {
    next(err)
  }
})
