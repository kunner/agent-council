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

const PASS_MARKERS = ['[PASS]', '[패스]', '[pass]']

export class CouncilOrchestrator {
  private activeTasks = new Map<string, ActiveTask>()

  /**
   * 회의체 방식 오케스트레이션
   *
   * PM 메시지가 오면:
   * 1. @멘션이 있으면 해당 팀만 응답
   * 2. @all이면 모든 팀 병렬 응답
   * 3. 일반 메시지 → 모든 팀이 보고, 관련 있으면 자발 응답 (PASS 가능)
   * 4. 응답한 팀의 메시지에서 다른 팀 멘션 → 후속 대화
   */
  async handleHumanMessage(
    projectId: string,
    roomId: string,
    humanMessage: string,
  ): Promise<void> {
    // Interrupt: 이전 작업 취소
    const taskKey = `${projectId}:${roomId}`
    const existing = this.activeTasks.get(taskKey)
    if (existing) {
      existing.abortController.abort()
      this.activeTasks.delete(taskKey)
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

      const db = getFirestore()
      const projectDoc = await db.collection('projects').doc(projectId).get()
      const project = projectDoc.data() as Project

      const recentMessages = await listMessages(projectId, roomId, 30)
      const recentForPrompt = recentMessages.map((m) => ({
        sender: m.senderName,
        content: m.content,
      }))

      // 명시적 멘션 파싱
      const explicitMentions = this.parseMentions(humanMessage, sets)
      const isExplicit = explicitMentions !== null

      // Round 1: 모든 팀에게 메시지 전달 (병렬)
      const targetSets = isExplicit ? explicitMentions : sets
      const responses = await this.askAllTeams(
        targetSets, projectId, roomId, humanMessage,
        project, sets, recentForPrompt, abortController.signal,
        isExplicit, // 명시적 멘션이면 반드시 응답, 아니면 자발적
      )

      if (abortController.signal.aborted) return

      // Round 2: 응답 중 다른 팀 멘션이 있으면 자연스러운 후속 대화
      const respondedIds = new Set(responses.map((r) => r.set.id))
      const mentionedInResponses = this.findMentionedTeams(responses, sets, respondedIds)

      if (mentionedInResponses.length > 0 && !abortController.signal.aborted) {
        const updatedMessages = await listMessages(projectId, roomId, 30)
        const updatedForPrompt = updatedMessages.map((m) => ({
          sender: m.senderName,
          content: m.content,
        }))

        await this.askAllTeams(
          mentionedInResponses, projectId, roomId,
          '대화에서 당신의 팀이 언급되었습니다.',
          project, sets, updatedForPrompt, abortController.signal,
          true, // 멘션됐으니 반드시 응답
        )
      }
    } finally {
      this.activeTasks.delete(taskKey)
    }
  }

  /**
   * 멘션 파싱
   * @all → 전체 (명시적)
   * @팀이름 → 해당 팀들 (명시적)
   * 없음 → null (자발적 판단 모드)
   */
  private parseMentions(message: string, sets: AgentSet[]): AgentSet[] | null {
    if (message.includes('@all') || message.includes('@전체')) {
      return sets
    }

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

    return mentioned.length > 0 ? mentioned : null // null = 멘션 없음
  }

  /**
   * 응답에서 멘션된 다른 팀 찾기
   */
  private findMentionedTeams(
    responses: Array<{ set: AgentSet; content: string }>,
    allSets: AgentSet[],
    alreadyRespondedIds: Set<string>,
  ): AgentSet[] {
    const mentioned = new Set<string>()

    for (const { content } of responses) {
      for (const set of allSets) {
        if (alreadyRespondedIds.has(set.id)) continue
        const nameWithoutSuffix = set.name.replace(/팀$/, '')
        const patterns = [set.name, nameWithoutSuffix]
        if (set.alias) patterns.push(set.alias)
        if (patterns.some((p) => content.includes(p))) {
          mentioned.add(set.id)
        }
      }
    }

    return allSets.filter((s) => mentioned.has(s.id))
  }

  /**
   * 모든 대상 팀에게 병렬로 메시지 전달
   * mustRespond=false면 팀이 [PASS]로 응답할 수 있음 (자발적 참여)
   */
  private async askAllTeams(
    targetSets: AgentSet[],
    projectId: string,
    roomId: string,
    message: string,
    project: Project,
    allSets: AgentSet[],
    recentMessages: Array<{ sender: string; content: string }>,
    signal: AbortSignal,
    mustRespond: boolean,
  ): Promise<Array<{ set: AgentSet; content: string }>> {
    if (signal.aborted) return []

    await Promise.all(
      targetSets.map((set) => updateSetStatus(projectId, set.id, 'working')),
    )

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
          mustRespond,
        })

        const response = await callClaude(message, systemPrompt, set.worktreePath || undefined)

        if (signal.aborted) throw new Error('Aborted')

        // [PASS] 응답이면 메시지를 저장하지 않음
        const isPassed = PASS_MARKERS.some((m) => response.content.trim().startsWith(m))
        if (isPassed) {
          await updateSetStatus(projectId, set.id, 'idle')
          return null
        }

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
      if (result.status === 'fulfilled' && result.value) {
        responses.push(result.value)
      } else if (result.status === 'rejected' && !signal.aborted) {
        console.error(`[Orchestrator] Error from "${set.name}":`, result.reason)
        await updateSetStatus(projectId, set.id, 'error')
        await createMessage(projectId, roomId, 'system', '시스템', 'system', {
          content: `⚠️ ${set.name}의 응답 중 오류: ${(result.reason as Error).message}`,
        })
      } else {
        // fulfilled with null = PASS
        await updateSetStatus(projectId, set.id, 'idle')
      }
    }

    return responses
  }
}
