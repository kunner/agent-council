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

interface ActiveTask {
  projectId: string
  roomId: string
  abortController: AbortController
}

export class CouncilOrchestrator {
  private activeTasks = new Map<string, ActiveTask>()

  /**
   * PM 메시지를 분석하여 적절한 응답 전략을 실행
   *
   * 전략:
   * - @all → 모든 팀 병렬 응답
   * - @팀이름 → 해당 팀만 응답
   * - 일반 메시지 → 팀장(첫 번째 Set)만 응답
   * - 리더 응답에서 다른 팀 멘션 → 후속 라운드
   */
  async handleHumanMessage(
    projectId: string,
    roomId: string,
    humanMessage: string,
  ): Promise<void> {
    // Interrupt: 이전 작업이 있으면 취소
    const taskKey = `${projectId}:${roomId}`
    const existing = this.activeTasks.get(taskKey)
    if (existing) {
      existing.abortController.abort()
      this.activeTasks.delete(taskKey)
      await createMessage(projectId, roomId, 'system', '시스템', 'system', {
        content: '⏹ 이전 응답을 중단하고 새 메시지를 처리합니다.',
      })
    }

    const abortController = new AbortController()
    this.activeTasks.set(taskKey, { projectId, roomId, abortController })

    try {
      const sets = await listSets(projectId)
      if (sets.length === 0) {
        await createMessage(projectId, roomId, 'system', '시스템', 'system', {
          content: '⚠️ 등록된 팀이 없습니다. 먼저 에이전트 팀을 추가해주세요.',
        })
        return
      }

      // 메시지 분석: 멘션 파싱
      const targetSets = this.parseMentions(humanMessage, sets)

      // Get project info
      const db = getFirestore()
      const projectDoc = await db.collection('projects').doc(projectId).get()
      const project = projectDoc.data() as Project

      // Get recent messages for context
      const recentMessages = await listMessages(projectId, roomId, 30)
      const recentForPrompt = recentMessages.map((m) => ({
        sender: m.senderName,
        content: m.content,
      }))

      // Round 1: 대상 팀에게 응답 요청
      let responses: Array<{ set: AgentSet; content: string }>

      if (targetSets.length === 1) {
        // 단일 팀: 직접 응답
        responses = await this.askSingleLeader(
          targetSets[0]!, projectId, roomId, humanMessage,
          project, sets, recentForPrompt, abortController.signal,
        )
      } else {
        // 다수 팀: 병렬 응답
        responses = await this.askLeadersParallel(
          targetSets, projectId, roomId, humanMessage,
          project, sets, recentForPrompt, abortController.signal,
        )
      }

      if (abortController.signal.aborted) return

      // Round 2: 후속 라운드 — 리더 응답에서 다른 팀 멘션 감지
      const mentionedInResponses = this.detectMentionsInResponses(responses, sets, targetSets)
      if (mentionedInResponses.length > 0 && !abortController.signal.aborted) {
        // 최신 컨텍스트로 갱신
        const updatedMessages = await listMessages(projectId, roomId, 30)
        const updatedForPrompt = updatedMessages.map((m) => ({
          sender: m.senderName,
          content: m.content,
        }))

        await createMessage(projectId, roomId, 'system', '시스템', 'system', {
          content: `💬 ${mentionedInResponses.map((s) => s.name).join(', ')}이(가) 언급되어 추가 응답합니다.`,
        })

        await this.askLeadersParallel(
          mentionedInResponses, projectId, roomId,
          '이전 대화에서 당신의 팀이 언급되었습니다. 관련 의견을 제시해주세요.',
          project, sets, updatedForPrompt, abortController.signal,
        )
      }
    } finally {
      this.activeTasks.delete(taskKey)
    }
  }

  /**
   * 멘션 파싱
   * @all → 모든 팀
   * @팀이름 → 해당 팀
   * 없음 → 첫 번째 팀 (팀장)
   */
  private parseMentions(message: string, sets: AgentSet[]): AgentSet[] {
    if (message.includes('@all') || message.includes('@전체')) {
      return sets
    }

    const mentioned: AgentSet[] = []
    for (const set of sets) {
      // @백엔드팀 또는 @백엔드 형태 지원
      const nameWithoutSuffix = set.name.replace(/팀$/, '')
      if (
        message.includes(`@${set.name}`) ||
        message.includes(`@${nameWithoutSuffix}`) ||
        (set.alias && message.includes(`@${set.alias}`))
      ) {
        mentioned.push(set)
      }
    }

    if (mentioned.length > 0) return mentioned

    // 멘션 없으면 → 팀장 (첫 번째 Set)
    return [sets[0]!]
  }

  /**
   * 리더 응답에서 다른 팀 멘션 감지
   */
  private detectMentionsInResponses(
    responses: Array<{ set: AgentSet; content: string }>,
    allSets: AgentSet[],
    alreadyResponded: AgentSet[],
  ): AgentSet[] {
    const respondedIds = new Set(alreadyResponded.map((s) => s.id))
    const mentioned = new Set<string>()

    for (const { content } of responses) {
      for (const set of allSets) {
        if (respondedIds.has(set.id)) continue
        const nameWithoutSuffix = set.name.replace(/팀$/, '')
        if (content.includes(set.name) || content.includes(nameWithoutSuffix)) {
          mentioned.add(set.id)
        }
      }
    }

    return allSets.filter((s) => mentioned.has(s.id))
  }

  /**
   * 단일 리더에게 응답 요청
   */
  private async askSingleLeader(
    set: AgentSet,
    projectId: string,
    roomId: string,
    message: string,
    project: Project,
    allSets: AgentSet[],
    recentMessages: Array<{ sender: string; content: string }>,
    signal: AbortSignal,
  ): Promise<Array<{ set: AgentSet; content: string }>> {
    if (signal.aborted) return []

    try {
      await updateSetStatus(projectId, set.id, 'working')

      const systemPrompt = buildLeaderSystemPrompt({
        setName: set.name,
        role: set.role,
        projectName: project.name,
        projectDescription: project.description,
        otherLeaders: allSets.filter((s) => s.id !== set.id).map((s) => ({ name: s.name, role: s.role })),
        recentMessages,
        isLeadSet: allSets.length > 0 && allSets[0]!.id === set.id,
      })

      const response = await callClaude(message, systemPrompt, set.worktreePath || undefined)

      if (signal.aborted) return []

      await createMessage(
        projectId, roomId, set.id, set.name, 'leader',
        { content: response.content },
        { tokenUsage: response.tokenUsage, setColor: set.color },
      )

      await updateSetStatus(projectId, set.id, 'idle')
      return [{ set, content: response.content }]
    } catch (err) {
      if (signal.aborted) return []
      console.error(`[Orchestrator] Error from "${set.name}":`, err)
      await updateSetStatus(projectId, set.id, 'error')
      await createMessage(projectId, roomId, 'system', '시스템', 'system', {
        content: `⚠️ ${set.name} 리더의 응답 중 오류가 발생했습니다: ${(err as Error).message}`,
      })
      return []
    }
  }

  /**
   * 여러 리더에게 병렬 응답 요청
   */
  private async askLeadersParallel(
    targetSets: AgentSet[],
    projectId: string,
    roomId: string,
    message: string,
    project: Project,
    allSets: AgentSet[],
    recentMessages: Array<{ sender: string; content: string }>,
    signal: AbortSignal,
  ): Promise<Array<{ set: AgentSet; content: string }>> {
    if (signal.aborted) return []

    // 모든 대상 팀 상태를 working으로
    await Promise.all(
      targetSets.map((set) => updateSetStatus(projectId, set.id, 'working')),
    )

    // 병렬 호출
    const results = await Promise.allSettled(
      targetSets.map(async (set) => {
        if (signal.aborted) throw new Error('Aborted')

        const systemPrompt = buildLeaderSystemPrompt({
          setName: set.name,
          role: set.role,
          projectName: project.name,
          projectDescription: project.description,
          otherLeaders: allSets.filter((s) => s.id !== set.id).map((s) => ({ name: s.name, role: s.role })),
          recentMessages,
          isLeadSet: allSets.length > 0 && allSets[0]!.id === set.id,
        })

        const response = await callClaude(message, systemPrompt, set.worktreePath || undefined)

        if (signal.aborted) throw new Error('Aborted')

        await createMessage(
          projectId, roomId, set.id, set.name, 'leader',
          { content: response.content },
          { tokenUsage: response.tokenUsage, setColor: set.color },
        )

        await updateSetStatus(projectId, set.id, 'idle')
        return { set, content: response.content }
      }),
    )

    const responses: Array<{ set: AgentSet; content: string }> = []
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!
      const set = targetSets[i]!
      if (result.status === 'fulfilled') {
        responses.push(result.value)
      } else if (!signal.aborted) {
        console.error(`[Orchestrator] Error from "${set.name}":`, result.reason)
        await updateSetStatus(projectId, set.id, 'error')
        await createMessage(projectId, roomId, 'system', '시스템', 'system', {
          content: `⚠️ ${set.name} 리더의 응답 중 오류가 발생했습니다: ${(result.reason as Error).message}`,
        })
      }
    }

    return responses
  }
}
