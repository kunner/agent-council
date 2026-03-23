import type { ClaudeModel } from '@agent-council/shared'
import { getFirestore } from '../firebase/admin.js'

interface ActiveSession {
  projectId: string
  setId: string
  sessionId: string
  model: ClaudeModel
  lastActivity: number
}

const activeSessions = new Map<string, ActiveSession>()

// Max idle time before auto-cleanup (30 minutes)
const MAX_IDLE_MS = 30 * 60 * 1000

function sessionKey(projectId: string, setId: string): string {
  return `${projectId}:${setId}`
}

export async function getSessionId(
  projectId: string,
  setId: string,
): Promise<string | undefined> {
  // Check in-memory first
  const key = sessionKey(projectId, setId)
  const active = activeSessions.get(key)
  if (active) {
    active.lastActivity = Date.now()
    return active.sessionId
  }

  // Check Firestore
  const db = getFirestore()
  const doc = await db.doc(`projects/${projectId}/sets/${setId}`).get()
  if (doc.exists) {
    const data = doc.data()
    if (data?.sessionId) return data.sessionId as string
  }

  return undefined
}

export async function saveSessionId(
  projectId: string,
  setId: string,
  sessionId: string,
  model: ClaudeModel,
): Promise<void> {
  const key = sessionKey(projectId, setId)
  activeSessions.set(key, {
    projectId,
    setId,
    sessionId,
    model,
    lastActivity: Date.now(),
  })

  // Persist to Firestore
  const db = getFirestore()
  await db.doc(`projects/${projectId}/sets/${setId}`).update({ sessionId })
}

export function removeSession(projectId: string, setId: string): void {
  const key = sessionKey(projectId, setId)
  activeSessions.delete(key)
}

export function getActiveSessionCount(): number {
  return activeSessions.size
}

export function getActiveSessions(): ActiveSession[] {
  return Array.from(activeSessions.values())
}

// Cleanup idle sessions periodically
setInterval(() => {
  const now = Date.now()
  for (const [key, session] of activeSessions) {
    if (now - session.lastActivity > MAX_IDLE_MS) {
      activeSessions.delete(key)
      console.log(`[SessionManager] Cleaned up idle session: ${key}`)
    }
  }
}, 5 * 60 * 1000) // Check every 5 minutes
