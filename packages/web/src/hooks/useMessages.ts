import { useState, useEffect } from 'react'
import { collection, query, orderBy, onSnapshot } from 'firebase/firestore'
import { db } from '../firebase/config'
import type { Message } from '@agent-council/shared'

export function useMessages(projectId: string | undefined, roomId: string = 'main') {
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!projectId) return

    const ref = collection(db, `projects/${projectId}/rooms/${roomId}/messages`)
    const q = query(ref, orderBy('timestamp', 'asc'))

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const msgs: Message[] = []
      snapshot.forEach((doc) => {
        msgs.push({ id: doc.id, ...doc.data() } as Message)
      })
      setMessages(msgs)
      setLoading(false)
    })

    return unsubscribe
  }, [projectId, roomId])

  return { messages, loading }
}
