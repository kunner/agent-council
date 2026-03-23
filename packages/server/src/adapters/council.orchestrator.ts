import { sendToSession } from './claude-sdk.adapter.js'
import { buildLeaderSystemPrompt } from './leader.prompts.js'
import { createMessage, listMessages } from '../council/message.service.js'
import { listSets, updateSetStatus } from '../sets/set.service.js'
import { getFirestore } from '../firebase/admin.js'
import { getSessionId, saveSessionId } from '../session/session-manager.js'
import { parseTeamCommands, recruitTeamMember, dismissTeamMember } from './team-manager.js'
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
   * SDK 세션 기반 회의체 오케스트레이션
   *
   * 1. PM 메시지 → 팀장 세션에 전달 (항상)
   * 2. 팀장 응답 파싱 → RECRUIT/DISMISS 처리
   * 3. 멘션된 활성 팀원만 순차 응답
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
      const allSets = await listSets(projectId)
      const activeSets = allSets.filter((s) => s.isActive !== false)

      if (activeSets.length === 0) {
        await createMessage(projectId, roomId, 'system', '시스템', 'system', {
          content: '⚠️ 활성 팀이 없습니다.',
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

      // Explicit @mention parsing
      const explicitTargets = this.parseExplicitMentions(humanMessage, activeSets)

      // Find leader
      const leader = activeSets.find((s) => s.isLeader) ?? activeSets[0]!
      const nonLeaders = activeSets.filter((s) => s.id !== leader.id)

      // Step 1: Leader always responds first
      if (abort.signal.aborted) return
      const leaderResponse = await this.askTeamMember(
        leader, projectId, roomId, humanMessage,
        project, activeSets, gitInfo, abort.signal,
      )

      if (abort.signal.aborted || !leaderResponse) return

      // Step 2: Parse leader response for RECRUIT/DISMISS
      const { recruits, dismissals } = parseTeamCommands(leaderResponse.content)

      for (const recruit of recruits) {
        if (abort.signal.aborted) break
        await recruitTeamMember(projectId, roomId, recruit)
      }
      for (const dismiss of dismissals) {
        if (abort.signal.aborted) break
        const refreshedSets = await listSets(projectId)
        await dismissTeamMember(projectId, roomId, dismiss.name, refreshedSets)
      }

      // Refresh sets after recruits/dismissals
      const updatedSets = await listSets(projectId)
      const updatedActive = updatedSets.filter((s) => s.isActive !== false && s.id !== leader.id)

      // Step 3: Determine which non-leader teams should respond
      let respondingTeams: AgentSet[]

      if (explicitTargets) {
        // Explicit mention → only those teams (excluding leader who already responded)
        respondingTeams = explicitTargets.filter((s) => s.id !== leader.id)
      } else {
        // Check if leader mentioned any teams in their response
        const mentionedTeams = this.findMentionedTeams(leaderResponse.content, updatedActive)
        respondingTeams = mentionedTeams.length > 0 ? mentionedTeams : []
        // If no specific mentions but there are active non-leaders, let them decide (with PASS)
        if (respondingTeams.length === 0 && updatedActive.length > 0) {
          respondingTeams = updatedActive
        }
      }

      // Step 4: Non-leader teams respond sequentially
      for (const set of respondingTeams) {
        if (abort.signal.aborted) break
        await this.askTeamMember(
          set, projectId, roomId, humanMessage,
          project, updatedSets.filter((s) => s.isActive !== false), gitInfo, abort.signal,
        )
      }
    } finally {
      this.activeTasks.delete(taskKey)
    }
  }

  private async askTeamMember(
    set: AgentSet,
    projectId: string,
    roomId: string,
    message: string,
    project: Project,
    allActiveSets: AgentSet[],
    gitInfo: { repoUrl?: string; repoName?: string } | null,
    signal: AbortSignal,
  ): Promise<{ content: string } | null> {
    if (signal.aborted) return null

    // Get latest conversation context
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
        otherLeaders: allActiveSets.filter((s) => s.id !== set.id).map((s) => ({ name: s.name, role: s.role })),
        recentMessages: recentForPrompt,
        isLeadSet: set.isLeader === true,
        mustRespond: set.isLeader === true,
        gitRepoInfo: gitInfo,
      })

      // Get or create session
      const existingSessionId = await getSessionId(projectId, set.id)

      const response = await sendToSession({
        message,
        systemPrompt,
        cwd: set.worktreePath || undefined,
        model: set.model ?? 'sonnet',
        sessionId: existingSessionId,
        maxTurns: set.isLeader ? 5 : 3,
      })

      if (signal.aborted) return null

      // Save session ID for future resumption
      if (response.sessionId) {
        await saveSessionId(projectId, set.id, response.sessionId, set.model ?? 'sonnet')
      }

      // Check for PASS
      const isPassed = PASS_MARKERS.some((m) => response.content.trim().startsWith(m))
      if (isPassed) {
        await updateSetStatus(projectId, set.id, 'idle')
        return null
      }

      // For leader: clean RECRUIT/DISMISS tags before displaying
      let displayContent = response.content
      if (set.isLeader) {
        const { cleanContent } = parseTeamCommands(response.content)
        displayContent = cleanContent
      }

      if (displayContent.trim()) {
        await createMessage(
          projectId, roomId, set.id, set.name, 'leader',
          { content: displayContent },
          { tokenUsage: response.tokenUsage, setColor: set.color },
        )
      }

      await updateSetStatus(projectId, set.id, 'idle')
      return { content: response.content }
    } catch (err) {
      if (signal.aborted) return null
      console.error(`[Orchestrator] Error from "${set.name}":`, err)
      await updateSetStatus(projectId, set.id, 'error')
      await createMessage(projectId, roomId, 'system', '시스템', 'system', {
        content: `⚠️ ${set.name} 응답 오류: ${(err as Error).message}`,
      })
      return null
    }
  }

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

  private findMentionedTeams(content: string, teams: AgentSet[]): AgentSet[] {
    return teams.filter((set) => {
      const patterns = [set.name, set.name.replace(/팀$/, '')]
      if (set.alias) patterns.push(set.alias)
      return patterns.some((p) => content.includes(p))
    })
  }
}
