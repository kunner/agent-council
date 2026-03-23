import { Router } from 'express'
import { authMiddleware, type AuthRequest } from '../middleware/auth.js'
import { createMessage, listMessages, clearMessages } from './message.service.js'
import { getCouncilOrchestrator } from '../adapters/council.orchestrator.js'

export const messageRouter: Router = Router()

messageRouter.use(authMiddleware)

// List messages
messageRouter.get(
  '/:projectId/rooms/:roomId/messages',
  async (req: AuthRequest, res, next) => {
    try {
      const projectId = req.params.projectId as string
      const roomId = req.params.roomId as string
      const limit = parseInt(req.query.limit as string) || 100
      const messages = await listMessages(projectId, roomId, limit)
      res.json({ messages })
    } catch (err) {
      next(err)
    }
  },
)

// Export all messages (for backup/download)
messageRouter.get(
  '/:projectId/rooms/:roomId/messages/export',
  async (req: AuthRequest, res, next) => {
    try {
      const projectId = req.params.projectId as string
      const roomId = req.params.roomId as string
      const messages = await listMessages(projectId, roomId, 10000)
      res.json({ messages, total: messages.length })
    } catch (err) {
      next(err)
    }
  },
)

// Clear all messages in a room
messageRouter.delete(
  '/:projectId/rooms/:roomId/messages',
  async (req: AuthRequest, res, next) => {
    try {
      const projectId = req.params.projectId as string
      const roomId = req.params.roomId as string
      await clearMessages(projectId, roomId)
      res.json({ success: true })
    } catch (err) {
      next(err)
    }
  },
)

// Send message (PM → triggers leader responses)
messageRouter.post(
  '/:projectId/rooms/:roomId/messages',
  async (req: AuthRequest, res, next) => {
    try {
      const projectId = req.params.projectId as string
      const roomId = req.params.roomId as string
      const { content, replyTo } = req.body

      if (!content) {
        res.status(400).json({ error: 'content is required' })
        return
      }

      // Save PM message
      const message = await createMessage(
        projectId,
        roomId,
        req.uid!,
        'PM',
        'human',
        { content, replyTo },
      )

      // Trigger leader responses asynchronously
      const orchestrator = getCouncilOrchestrator()
      orchestrator.handleHumanMessage(projectId, roomId, content).catch((err: unknown) => {
        console.error('[Orchestrator] Error handling human message:', err)
      })

      res.status(201).json({ message })
    } catch (err) {
      next(err)
    }
  },
)
