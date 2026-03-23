import { getFirestore } from '../firebase/admin.js'
import type { AgentSet, CreateSetDto } from '@agent-council/shared'
import { SET_COLORS } from '@agent-council/shared'
import { FieldValue } from 'firebase-admin/firestore'

export async function createSet(
  projectId: string,
  dto: CreateSetDto,
): Promise<AgentSet> {
  const db = getFirestore()
  const setsRef = db.collection(`projects/${projectId}/sets`)

  // Auto-assign color based on existing set count
  const countSnapshot = await setsRef.count().get()
  const count = countSnapshot.data().count
  const colorEntry = SET_COLORS[count % SET_COLORS.length]!

  const setRef = setsRef.doc()
  const setId = setRef.id

  const branchName = `set-${setId.slice(0, 6)}/${dto.name.toLowerCase().replace(/\s+/g, '-')}`

  const agentSet = {
    projectId,
    name: dto.name,
    role: dto.role,
    status: 'idle' as const,
    color: colorEntry.hex,
    branch: branchName,
    worktreePath: '', // Set after worktree creation
    teammates: dto.teammates ?? 0,
    createdAt: FieldValue.serverTimestamp(),
  }

  await setRef.set(agentSet)

  const doc = await setRef.get()
  return { id: doc.id, ...doc.data() } as AgentSet
}

export async function listSets(projectId: string): Promise<AgentSet[]> {
  const db = getFirestore()
  const snapshot = await db
    .collection(`projects/${projectId}/sets`)
    .orderBy('createdAt', 'asc')
    .get()

  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as AgentSet)
}

export async function updateSetStatus(
  projectId: string,
  setId: string,
  status: AgentSet['status'],
): Promise<void> {
  const db = getFirestore()
  await db.doc(`projects/${projectId}/sets/${setId}`).update({ status })
}
