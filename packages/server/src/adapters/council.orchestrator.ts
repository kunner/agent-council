import { callClaude } from './claude-cli.adapter.js'
import { buildLeaderSystemPrompt } from './leader.prompts.js'
import { createMessage, listMessages } from '../council/message.service.js'
import { listSets, updateSetStatus } from '../sets/set.service.js'
import { getFirestore } from '../firebase/admin.js'
import type { Project, AgentSet } from '@agent-council/shared'

let instance: CouncilOrchestrator | null = null

export function getCouncilOrchestrator(): CouncilOrchestrator {
  if (!instance) {
    instance = new CouncilOrchestrator()
  }
  return instance
}

const PASS_MARKERS = ['[PASS]', '[패스]', '[pass]']

export class CouncilOrchestrator {
  private activeTasks = new Map<string, AbortController>()

  /**
   * 회의체 오케스트레이션 — 순차 대화 방식
   *
   * 핵심 원칙: 실제 회의처럼, 한 명씩 발언하고, 앞사람 말을 듣고 이어갑니다.
   *
   * 1. @멘션 → 해당 팀만 순차 응답
   * 2. 일반 메시지 → 팀장부터 순차, 각 팀은 이전 발언을 보고 판단
   *    - 새로운 관점이 있으면 발언
   *    - 이미 다뤄진 내용이면 [PASS]
   */
  async handleHumanMessage(
    projectId: string,
    roomId: string,
    humanMessage: string,
  ): Promise<void> {
    const taskKey = `${projectId}:${roomId}`
    const existing = this.activeTasks.get(taskKey)
    if (existing) existing.abort()

    const abort = new AbortController()
    this.activeTasks.set(taskKey, abort)

    try {
      const sets = await listSets(projectId)
      if (sets.length === 0) {
        await createMessage(projectId, roomId, 'system', '시스템', 'system', {
          content: '⚠️ 등록된 팀이 없습니다. 먼저 에이전트 팀을 추가해주세요.',
        })
        return
      }

      const db = getFirestore()
      const projectDoc = await db.collection('projects').doc(projectId).get()
      const project = projectDoc.data() as Project

      const gitConfigDoc = await db.doc(`projects/${projectId}/git/config`).get()
      const gitInfo = gitConfigDoc.exists
        ? gitConfigDoc.data() as { repoUrl?: string; repoName?: string }
        : null

      // 명시적 @멘션 파싱
      const explicitTargets = this.parseExplicitMentions(humanMessage, sets)
      const targetSets = explicitTargets ?? sets // 멘션 없으면 전체 팀 참여

      // 순차 대화: 팀장(첫 번째)부터 한 명씩
      for (const set of targetSets) {
        if (abort.signal.aborted) break

        // 매번 최신 대화 이력을 가져옴 (이전 팀의 응답이 포함됨)
        const recentMessages = await listMessages(projectId, roomId, 30)
        const recentForPrompt = recentMessages.map((m) => ({
          sender: m.senderName,
          content: m.content,
        }))

        await updateSetStatus(projectId, set.id, 'working')

        try {
          const systemPrompt = buildLeaderSystemPrompt({
            setName: set.name,
            role: set.role,
            projectName: project.name,
            projectDescription: project.description,
            otherLeaders: sets.filter((s) => s.id !== set.id).map((s) => ({ name: s.name, role: s.role })),
            recentMessages: recentForPrompt,
            isLeadSet: sets[0]!.id === set.id,
            mustRespond: explicitTargets !== null, // 명시적 멘션이면 반드시 응답
            gitRepoInfo: gitInfo,
          })

          const response = await callClaude(
            humanMessage, systemPrompt,
            set.worktreePath || undefined,
            set.model ?? 'sonnet',
          )

          if (abort.signal.aborted) break

          const isPassed = PASS_MARKERS.some((m) => response.content.trim().startsWith(m))

          if (!isPassed) {
            await createMessage(
              projectId, roomId, set.id, set.name, 'leader',
              { content: response.content },
              { tokenUsage: response.tokenUsage, setColor: set.color },
            )
          }

          await updateSetStatus(projectId, set.id, 'idle')
        } catch (err) {
          if (abort.signal.aborted) break
          console.error(`[Orchestrator] Error from "${set.name}":`, err)
          await updateSetStatus(projectId, set.id, 'error')
          await createMessage(projectId, roomId, 'system', '시스템', 'system', {
            content: `⚠️ ${set.name} 응답 오류: ${(err as Error).message}`,
          })
        }
      }
    } finally {
      this.activeTasks.delete(taskKey)
    }
  }

  /**
   * 명시적 @멘션만 파싱
   */
  private parseExplicitMentions(message: string, sets: AgentSet[]): AgentSet[] | null {
    if (message.includes('@all') || message.includes('@전체')) return sets

    const mentioned: AgentSet[] = []
    for (const set of sets) {
      const nameWithoutSuffix = set.name.replace(/팀$/, '')
      if (
        message.includes(`@${set.name}`) ||
        message.includes(`@${nameWithoutSuffix}`) ||
        (set.alias && message.includes(`@${set.alias}`))
      ) {
        mentioned.push(set)
      }
    }
    return mentioned.length > 0 ? mentioned : null
  }
}
