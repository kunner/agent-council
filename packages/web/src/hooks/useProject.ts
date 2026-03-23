import { useState, useEffect } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../firebase/config'
import type { Project } from '@agent-council/shared'

export function useProject(projectId: string | undefined) {
  const [project, setProject] = useState<Project | null>(null)

  useEffect(() => {
    if (!projectId) return

    const ref = doc(db, `projects/${projectId}`)
    const unsubscribe = onSnapshot(ref, (snap) => {
      if (snap.exists()) {
        setProject({ id: snap.id, ...snap.data() } as Project)
      }
    })

    return unsubscribe
  }, [projectId])

  return { project }
}
