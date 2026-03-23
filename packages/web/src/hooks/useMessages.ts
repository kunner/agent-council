import { useState, useEffect, useCallback } from 'react'
import {
  collection, query, orderBy, onSnapshot,
  limitToLast, getDocs, limit, endBefore,
  type QueryDocumentSnapshot,
} from 'firebase/firestore'
import { db } from '../firebase/config'
import type { Message } from '@agent-council/shared'

const PAGE_SIZE = 50

export function useMessages(projectId: string | undefined, roomId: string = 'main') {
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [firstDoc, setFirstDoc] = useState<QueryDocumentSnapshot | null>(null)

  useEffect(() => {
    if (!projectId) return

    const ref = collection(db, `projects/${projectId}/rooms/${roomId}/messages`)
    // Load only the latest PAGE_SIZE messages
    const q = query(ref, orderBy('timestamp', 'asc'), limitToLast(PAGE_SIZE))

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const msgs: Message[] = []
      snapshot.forEach((doc) => {
        msgs.push({ id: doc.id, ...doc.data() } as Message)
      })
      setMessages(msgs)
      setLoading(false)
      // If we got exactly PAGE_SIZE, there might be more
      setHasMore(snapshot.size >= PAGE_SIZE)
      // Keep reference to first document for pagination
      if (snapshot.docs.length > 0) {
        setFirstDoc(snapshot.docs[0]!)
      }
    })

    return unsubscribe
  }, [projectId, roomId])

  const loadMore = useCallback(async () => {
    if (!projectId || !firstDoc || loadingMore) return

    setLoadingMore(true)
    try {
      const ref = collection(db, `projects/${projectId}/rooms/${roomId}/messages`)
      const q = query(
        ref,
        orderBy('timestamp', 'asc'),
        endBefore(firstDoc),
        limitToLast(PAGE_SIZE),
      )
      const snapshot = await getDocs(q)
      const olderMsgs: Message[] = []
      snapshot.forEach((doc) => {
        olderMsgs.push({ id: doc.id, ...doc.data() } as Message)
      })

      if (olderMsgs.length > 0) {
        setMessages((prev) => [...olderMsgs, ...prev])
        setFirstDoc(snapshot.docs[0]!)
      }
      setHasMore(snapshot.size >= PAGE_SIZE)
    } finally {
      setLoadingMore(false)
    }
  }, [projectId, roomId, firstDoc, loadingMore])

  return { messages, loading, hasMore, loadingMore, loadMore }
}
