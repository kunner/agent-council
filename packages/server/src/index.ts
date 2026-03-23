import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { Server as SocketIOServer } from 'socket.io'
import { initFirebase } from './firebase/admin.js'
import { projectRouter } from './project/project.router.js'
import { messageRouter } from './council/message.router.js'
import { setRouter } from './sets/set.router.js'
import { setupWebSocket } from './ws/ws.server.js'
import { errorHandler } from './middleware/error.js'

const PORT = parseInt(process.env.PORT ?? '3001', 10)

async function main() {
  // Initialize Firebase Admin
  initFirebase()

  const app = express()
  const httpServer = createServer(app)

  // Middleware
  app.use(cors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
    credentials: true,
  }))
  app.use(express.json())

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  // API routes
  app.use('/api/projects', projectRouter)
  app.use('/api/projects', messageRouter)
  app.use('/api/projects', setRouter)

  // Error handler
  app.use(errorHandler)

  // WebSocket
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
      credentials: true,
    },
  })
  setupWebSocket(io)

  httpServer.listen(PORT, () => {
    console.log(`[Council Server] Running on port ${PORT}`)
  })
}

main().catch(console.error)
