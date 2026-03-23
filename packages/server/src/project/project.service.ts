import { getFirestore } from '../firebase/admin.js'
import type { Project, CreateProjectDto, Room } from '@agent-council/shared'
import { FieldValue } from 'firebase-admin/firestore'

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

export async function listProjects(ownerId: string): Promise<Project[]> {
  const db = getFirestore()
  const snapshot = await db
    .collection('projects')
    .where('ownerId', '==', ownerId)
    .orderBy('createdAt', 'desc')
    .get()

  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Project)
}
