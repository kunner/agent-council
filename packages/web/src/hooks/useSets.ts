import { useState, useEffect } from 'react'
import { collection, query, orderBy, onSnapshot } from 'firebase/firestore'
import { db } from '../firebase/config'
import type { AgentSet } from '@agent-council/shared'

export function useSets(projectId: string | undefined) {
  const [sets, setSets] = useState<AgentSet[]>([])

  useEffect(() => {
    if (!projectId) return

    const ref = collection(db, `projects/${projectId}/sets`)
    const q = query(ref, orderBy('createdAt', 'asc'))

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const result: AgentSet[] = []
      snapshot.forEach((doc) => {
        result.push({ id: doc.id, ...doc.data() } as AgentSet)
      })
      setSets(result)
    })

    return unsubscribe
  }, [projectId])

  return { sets }
}
