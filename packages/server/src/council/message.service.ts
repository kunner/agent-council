import { getFirestore } from '../firebase/admin.js'
import type { Message, SendMessageDto } from '@agent-council/shared'
import { FieldValue } from 'firebase-admin/firestore'

export async function createMessage(
  projectId: string,
  roomId: string,
  senderId: string,
  senderName: string,
  senderType: 'human' | 'leader' | 'system',
  dto: SendMessageDto,
  metadata?: Message['metadata'],
): Promise<Message> {
  const db = getFirestore()
  const ref = db
    .collection(`projects/${projectId}/rooms/${roomId}/messages`)
    .doc()

  // Strip undefined values — Firestore rejects them
  const cleanMeta = metadata
    ? Object.fromEntries(Object.entries(metadata).filter(([, v]) => v !== undefined))
    : null

  const msg = {
    roomId,
    senderId,
    senderName,
    senderType,
    content: dto.content,
    replyTo: dto.replyTo ?? null,
    metadata: Object.keys(cleanMeta ?? {}).length > 0 ? cleanMeta : null,
    timestamp: FieldValue.serverTimestamp(),
  }

  await ref.set(msg)

  const doc = await ref.get()
  return { id: doc.id, ...doc.data() } as Message
}

export async function listMessages(
  projectId: string,
  roomId: string,
  limit = 100,
): Promise<Message[]> {
  const db = getFirestore()
  const snapshot = await db
    .collection(`projects/${projectId}/rooms/${roomId}/messages`)
    .orderBy('timestamp', 'asc')
    .limit(limit)
    .get()

  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Message)
}

export async function clearMessages(
  projectId: string,
  roomId: string,
): Promise<number> {
  const db = getFirestore()
  const ref = db.collection(`projects/${projectId}/rooms/${roomId}/messages`)
  let total = 0

  // Firestore batch limit is 500 — delete in chunks
  while (true) {
    const snapshot = await ref.limit(500).get()
    if (snapshot.empty) break

    const batch = db.batch()
    snapshot.docs.forEach((doc) => batch.delete(doc.ref))
    await batch.commit()
    total += snapshot.size
  }

  return total
}
