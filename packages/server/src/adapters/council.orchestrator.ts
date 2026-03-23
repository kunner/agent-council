import { callClaude } from './claude-cli.adapter.js'
import { buildLeaderSystemPrompt } from './leader.prompts.js'
import { createMessage, listMessages } from '../council/message.service.js'
import { listSets, updateSetStatus } from '../sets/set.service.js'
import { getFirestore } from '../firebase/admin.js'
import type { Project } from '@agent-council/shared'

let instance: CouncilOrchestrator | null = null

export function getCouncilOrchestrator(): CouncilOrchestrator {
  if (!instance) {
    instance = new CouncilOrchestrator()
  }
  return instance
}

export class CouncilOrchestrator {
  async handleHumanMessage(
    projectId: string,
    roomId: string,
    humanMessage: string,
  ): Promise<void> {
    const sets = await listSets(projectId)
    if (sets.length === 0) {
      await createMessage(projectId, roomId, 'system', '시스템', 'system', {
        content: '⚠️ 등록된 Set이 없습니다. 먼저 Set을 생성해주세요.',
      })
      return
    }

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

    // Sequential: each leader responds one by one
    for (const set of sets) {
      try {
        await updateSetStatus(projectId, set.id, 'working')

        const otherLeaders = sets
          .filter((s) => s.id !== set.id)
          .map((s) => ({ name: s.name, role: s.role }))

        const systemPrompt = buildLeaderSystemPrompt({
          setName: set.name,
          role: set.role,
          projectName: project.name,
          projectDescription: project.description,
          otherLeaders,
          recentMessages: recentForPrompt,
        })

        const response = await callClaude(humanMessage, systemPrompt, set.worktreePath || undefined)

        await createMessage(
          projectId,
          roomId,
          set.id,
          set.name,
          'leader',
          { content: response.content },
          {
            tokenUsage: response.tokenUsage,
            setColor: set.color,
          },
        )

        // Add this leader's response to context for next leader
        recentForPrompt.push({
          sender: set.name,
          content: response.content,
        })

        await updateSetStatus(projectId, set.id, 'idle')
      } catch (err) {
        console.error(`[Orchestrator] Error from set "${set.name}":`, err)
        await updateSetStatus(projectId, set.id, 'error')
        await createMessage(projectId, roomId, 'system', '시스템', 'system', {
          content: `⚠️ ${set.name} 리더의 응답 중 오류가 발생했습니다: ${(err as Error).message}`,
        })
      }
    }
  }
}
