import { Router } from 'express'
import { authMiddleware, type AuthRequest } from '../middleware/auth.js'
import { createProject, getProject, listProjects } from './project.service.js'

export const projectRouter: Router = Router()

// All project routes require auth
projectRouter.use(authMiddleware)

// List projects
projectRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const projects = await listProjects(req.uid!)
    res.json({ projects })
  } catch (err) {
    next(err)
  }
})

// Get project
projectRouter.get('/:projectId', async (req: AuthRequest, res, next) => {
  try {
    const project = await getProject(req.params.projectId as string, req.uid!)
    if (!project) {
      res.status(404).json({ error: 'Project not found' })
      return
    }
    res.json({ project })
  } catch (err) {
    next(err)
  }
})

// Create project
projectRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const { name, description, type, repoUrl } = req.body
    if (!name || !description || !type) {
      res.status(400).json({ error: 'name, description, and type are required' })
      return
    }
    const project = await createProject(req.uid!, { name, description, type, repoUrl })
    res.status(201).json({ project })
  } catch (err) {
    next(err)
  }
})
