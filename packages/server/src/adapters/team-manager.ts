import { createSet, listSets, updateSetStatus } from '../sets/set.service.js'
import { createMessage } from '../council/message.service.js'
import { saveSessionId } from '../session/session-manager.js'
import type { AgentSet, ClaudeModel } from '@agent-council/shared'

interface RecruitRequest {
  name: string
  model: ClaudeModel
  role: string
}

interface DismissRequest {
  name: string
}

const RECRUIT_REGEX = /\[RECRUIT:([^:]+):([^:]+):([^\]]+)\]/g
const DISMISS_REGEX = /\[DISMISS:([^\]]+)\]/g

/**
 * Parse leader response for team management commands
 */
export function parseTeamCommands(content: string): {
  recruits: RecruitRequest[]
  dismissals: DismissRequest[]
  cleanContent: string
} {
  const recruits: RecruitRequest[] = []
  const dismissals: DismissRequest[] = []

  let match
  while ((match = RECRUIT_REGEX.exec(content)) !== null) {
    recruits.push({
      name: match[1]!.trim(),
      model: match[2]!.trim() as ClaudeModel,
      role: match[3]!.trim(),
    })
  }

  while ((match = DISMISS_REGEX.exec(content)) !== null) {
    dismissals.push({ name: match[1]!.trim() })
  }

  // Remove command tags from displayed content
  const cleanContent = content
    .replace(RECRUIT_REGEX, '')
    .replace(DISMISS_REGEX, '')
    .trim()

  return { recruits, dismissals, cleanContent }
}

/**
 * Execute recruit: create set + worktree
 */
export async function recruitTeamMember(
  projectId: string,
  roomId: string,
  request: RecruitRequest,
): Promise<AgentSet> {
  // Create the set
  const set = await createSet(projectId, {
    name: request.name,
    role: request.role,
    model: request.model,
  })

  // System message
  await createMessage(projectId, roomId, 'system', '시스템', 'system', {
    content: `👋 ${request.name}이(가) 회의에 참여했습니다. (${request.model})`,
  })

  return set
}

/**
 * Execute dismiss: deactivate team member
 */
export async function dismissTeamMember(
  projectId: string,
  roomId: string,
  teamName: string,
  sets: AgentSet[],
): Promise<void> {
  const target = sets.find((s) => s.name === teamName || s.alias === teamName)
  if (!target) return

  await updateSetStatus(projectId, target.id, 'idle')

  // Mark as inactive in Firestore
  const { getFirestore } = await import('../firebase/admin.js')
  const db = getFirestore()
  await db.doc(`projects/${projectId}/sets/${target.id}`).update({ isActive: false })

  await createMessage(projectId, roomId, 'system', '시스템', 'system', {
    content: `👋 ${teamName}이(가) 회의에서 나갔습니다.`,
  })
}

/**
 * Auto-create leader set when project is created
 */
export async function createLeaderSet(
  projectId: string,
  roomId: string,
): Promise<AgentSet> {
  const set = await createSet(projectId, {
    name: '팀장',
    role: '프로젝트 총괄 코디네이터. 대화를 주도하고, 필요한 전문가를 불러오고, 작업을 조율합니다.',
    model: 'sonnet',
    alias: 'leader',
  })

  // Mark as leader and active
  const { getFirestore } = await import('../firebase/admin.js')
  const db = getFirestore()
  await db.doc(`projects/${projectId}/sets/${set.id}`).update({
    isLeader: true,
    isActive: true,
  })

  await createMessage(projectId, roomId, 'system', '시스템', 'system', {
    content: '🎯 팀장이 참여했습니다. 대화를 시작하세요.',
  })

  return set
}
