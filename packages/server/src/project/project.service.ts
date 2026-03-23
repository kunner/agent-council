import { getFirestore } from '../firebase/admin.js'
import type { Project, CreateProjectDto, Room } from '@agent-council/shared'
import { FieldValue } from 'firebase-admin/firestore'
import { initProjectRepo, cloneProjectRepo } from '../git/git.service.js'

export async function createProject(
  ownerId: string,
  dto: CreateProjectDto,
): Promise<Project> {
  const db = getFirestore()
  const projectRef = db.collection('projects').doc()

  const now = FieldValue.serverTimestamp()
  const project: Omit<Project, 'id' | 'createdAt' | 'updatedAt'> & {
    createdAt: typeof now
    updatedAt: typeof now
  } = {
    name: dto.name,
    description: dto.description,
    ownerId,
    type: dto.type,
    status: 'planning',
    createdAt: now,
    updatedAt: now,
  }

  await projectRef.set(project)

  // Create default "main" council room
  const roomRef = projectRef.collection('rooms').doc('main')
  const room: Omit<Room, 'id' | 'createdAt'> & { createdAt: typeof now } = {
    name: '메인 회의실',
    purpose: 'main',
    status: 'active',
    createdAt: now,
  }
  await roomRef.set(room)

  // Initialize Git repo based on project type
  try {
    if (dto.type === 'existing' && dto.repoUrl) {
      cloneProjectRepo(projectRef.id, dto.repoUrl)
    } else {
      initProjectRepo(projectRef.id)
    }
  } catch (err) {
    console.error('[Git] Failed to initialize repo:', err)
  }

  const doc = await projectRef.get()
  return { id: doc.id, ...doc.data() } as Project
}

export async function getProject(
  projectId: string,
  requesterId: string,
): Promise<Project | null> {
  const db = getFirestore()
  const doc = await db.collection('projects').doc(projectId).get()
  if (!doc.exists) return null

  const data = doc.data()!
  if (data.ownerId !== requesterId) return null

  return { id: doc.id, ...data } as Project
}

export async function updateProject(
  projectId: string,
  requesterId: string,
  updates: Partial<Pick<Project, 'name' | 'description' | 'status'>>,
): Promise<Project | null> {
  const db = getFirestore()
  const ref = db.collection('projects').doc(projectId)
  const doc = await ref.get()
  if (!doc.exists || doc.data()!.ownerId !== requesterId) return null

  await ref.update({ ...updates, updatedAt: FieldValue.serverTimestamp() })
  const updated = await ref.get()
  return { id: updated.id, ...updated.data() } as Project
}

export async function deleteProject(
  projectId: string,
  requesterId: string,
): Promise<boolean> {
  const db = getFirestore()
  const ref = db.collection('projects').doc(projectId)
  const doc = await ref.get()
  if (!doc.exists || doc.data()!.ownerId !== requesterId) return false

  // Delete subcollections (rooms/messages, sets, tasks)
  const batch = db.batch()
  const subs = ['rooms/main/messages', 'sets', 'tasks']
  for (const sub of subs) {
    const snap = await ref.collection(sub.split('/').pop()!).get()
    snap.docs.forEach((d) => batch.delete(d.ref))
  }
  batch.delete(ref)
  await batch.commit()
  return true
}

export async function listProjects(ownerId: string): Promise<Project[]> {
  const db = getFirestore()
  const snapshot = await db
    .collection('projects')
    .where('ownerId', '==', ownerId)
    .get()

  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Project)
}
