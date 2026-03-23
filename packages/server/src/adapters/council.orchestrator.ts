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
   * 회의체 오케스트레이션
   *
   * @멘션 → 해당 팀만 응답
   * @all → 모든 팀 병렬 (각자 [PASS] 가능)
   * 일반 메시지 → 팀장 먼저 → 나머지 팀은 팀장 응답을 본 뒤 자발적 참여
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

      // Git config 조회 (연결된 repo 정보)
      const gitConfigDoc = await db.doc(`projects/${projectId}/git/config`).get()
      const gitInfo = gitConfigDoc.exists
        ? gitConfigDoc.data() as { repoUrl?: string; repoName?: string }
        : null

      const recentMessages = await listMessages(projectId, roomId, 30)
      const recentForPrompt = recentMessages.map((m) => ({
        sender: m.senderName,
        content: m.content,
      }))

      const explicitMentions = this.parseMentions(humanMessage, sets)

      if (explicitMentions) {
        // 명시적 멘션: 해당 팀만 병렬 응답 (반드시)
        await this.askTeams(
          explicitMentions, projectId, roomId, humanMessage,
          project, sets, recentForPrompt, abort.signal, true, gitInfo,
        )
      } else {
        // 일반 메시지: 팀장 먼저 → 나머지 자발적
        const leadSet = sets[0]!
        const otherSets = sets.slice(1)

        // Step 1: 팀장 응답
        const leadResponse = await this.askTeams(
          [leadSet], projectId, roomId, humanMessage,
          project, sets, recentForPrompt, abort.signal, true, gitInfo,
        )

        if (abort.signal.aborted || otherSets.length === 0) return

        // Step 2: 나머지 팀은 팀장 응답을 포함한 최신 컨텍스트로 자발적 참여
        const updatedMessages = await listMessages(projectId, roomId, 30)
        const updatedForPrompt = updatedMessages.map((m) => ({
          sender: m.senderName,
          content: m.content,
        }))

        const otherResponses = await this.askTeams(
          otherSets, projectId, roomId, humanMessage,
          project, sets, updatedForPrompt, abort.signal, false, gitInfo,
        )

        // Step 3: 누군가 다른 팀을 멘션했으면 후속 대화
        if (abort.signal.aborted) return
        const allResponses = [...leadResponse, ...otherResponses]
        const respondedIds = new Set(allResponses.map((r) => r.set.id))
        const mentionedTeams = this.findMentionedTeams(allResponses, sets, respondedIds)

        if (mentionedTeams.length > 0) {
          const latestMessages = await listMessages(projectId, roomId, 30)
          const latestForPrompt = latestMessages.map((m) => ({
            sender: m.senderName,
            content: m.content,
          }))
          await this.askTeams(
            mentionedTeams, projectId, roomId,
            '대화에서 당신의 팀이 언급되었습니다.',
            project, sets, latestForPrompt, abort.signal, true, gitInfo,
          )
        }
      }
    } finally {
      this.activeTasks.delete(taskKey)
    }
  }

  private parseMentions(message: string, sets: AgentSet[]): AgentSet[] | null {
    // @all 또는 자연어로 전체를 부르는 표현 감지
    const allPatterns = ['@all', '@전체', '다들', '모두', '여러분', '전원', '각 팀', '각자']
    if (allPatterns.some((p) => message.includes(p))) return sets

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

  private findMentionedTeams(
    responses: Array<{ set: AgentSet; content: string }>,
    allSets: AgentSet[],
    alreadyRespondedIds: Set<string>,
  ): AgentSet[] {
    const mentioned = new Set<string>()
    for (const { content } of responses) {
      for (const set of allSets) {
        if (alreadyRespondedIds.has(set.id)) continue
        const patterns = [set.name, set.name.replace(/팀$/, '')]
        if (set.alias) patterns.push(set.alias)
        if (patterns.some((p) => content.includes(p))) mentioned.add(set.id)
      }
    }
    return allSets.filter((s) => mentioned.has(s.id))
  }

  private async askTeams(
    targetSets: AgentSet[],
    projectId: string,
    roomId: string,
    message: string,
    project: Project,
    allSets: AgentSet[],
    recentMessages: Array<{ sender: string; content: string }>,
    signal: AbortSignal,
    mustRespond: boolean,
    gitInfo: { repoUrl?: string; repoName?: string } | null,
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
          gitRepoInfo: gitInfo,
        })

        const response = await callClaude(message, systemPrompt, set.worktreePath || undefined)
        if (signal.aborted) throw new Error('Aborted')

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
        await updateSetStatus(projectId, set.id, 'error')
        await createMessage(projectId, roomId, 'system', '시스템', 'system', {
          content: `⚠️ ${set.name} 응답 오류: ${(result.reason as Error).message}`,
        })
      } else {
        await updateSetStatus(projectId, set.id, 'idle')
      }
    }
    return responses
  }
}
