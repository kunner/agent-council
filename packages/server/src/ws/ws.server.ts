import type { Server as SocketIOServer } from 'socket.io'

export function setupWebSocket(io: SocketIOServer): void {
  io.on('connection', (socket) => {
    console.log(`[WS] Client connected: ${socket.id}`)

    // Join project room
    socket.on('join:project', (projectId: string) => {
      socket.join(`project:${projectId}`)
      console.log(`[WS] ${socket.id} joined project:${projectId}`)
    })

    // Typing indicator
    socket.on('typing:start', (data: { projectId: string; roomId: string; userName: string }) => {
      socket.to(`project:${data.projectId}`).emit('typing:start', {
        roomId: data.roomId,
        userName: data.userName,
      })
    })

    socket.on('typing:stop', (data: { projectId: string; roomId: string; userName: string }) => {
      socket.to(`project:${data.projectId}`).emit('typing:stop', {
        roomId: data.roomId,
        userName: data.userName,
      })
    })

    // Set status updates (server-push)
    socket.on('disconnect', () => {
      console.log(`[WS] Client disconnected: ${socket.id}`)
    })
  })
}
