import { getFirestore } from '../firebase/admin.js'
import type { AgentSet, CreateSetDto } from '@agent-council/shared'
import { SET_COLORS } from '@agent-council/shared'
import { FieldValue } from 'firebase-admin/firestore'
import { createWorktree, removeWorktree } from '../git/git.service.js'

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

  const alias = dto.alias ?? dto.name.toLowerCase().replace(/\s+/g, '').replace(/팀$/, '')

  const agentSet = {
    projectId,
    name: dto.name,
    alias,
    role: dto.role,
    model: dto.model ?? 'sonnet' as const,
    status: 'idle' as const,
    color: colorEntry.hex,
    branch: branchName,
    worktreePath: '', // Set after worktree creation
    teammates: dto.teammates ?? 0,
    createdAt: FieldValue.serverTimestamp(),
  }

  await setRef.set(agentSet)

  // Create git worktree for this set
  try {
    const worktreePath = createWorktree(projectId, setId, branchName)
    await setRef.update({ worktreePath })
  } catch (err) {
    console.error(`[Git] Failed to create worktree for set ${setId}:`, err)
  }

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

export async function deleteSet(projectId: string, setId: string): Promise<void> {
  const db = getFirestore()

  // Remove git worktree
  try {
    removeWorktree(projectId, setId)
  } catch (err) {
    console.error(`[Git] Failed to remove worktree for set ${setId}:`, err)
  }

  await db.doc(`projects/${projectId}/sets/${setId}`).delete()
}
