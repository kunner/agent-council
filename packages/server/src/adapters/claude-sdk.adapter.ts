import { query } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeModel } from '@agent-council/shared'

export interface ClaudeResponse {
  content: string
  tokenUsage?: number
  sessionId?: string
}

const MODEL_MAP: Record<ClaudeModel, string> = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
}

export async function sendToSession(params: {
  message: string
  systemPrompt: string
  cwd?: string
  model?: ClaudeModel
  sessionId?: string
  maxTurns?: number
}): Promise<ClaudeResponse> {
  const model = MODEL_MAP[params.model ?? 'sonnet']

  // API 키를 제외한 env를 전달 → Max 플랜 OAuth 인증 사용 (추가 비용 없음)
  const sdkEnv = { ...process.env }
  delete sdkEnv.ANTHROPIC_API_KEY

  const result = query({
    prompt: params.message,
    options: {
      cwd: params.cwd ?? process.cwd(),
      model,
      systemPrompt: params.systemPrompt,
      resume: params.sessionId ?? undefined,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: params.maxTurns ?? 3,
      persistSession: true,
      env: sdkEnv,
    },
  })

  let content = ''
  let sessionId: string | undefined
  let totalTokens = 0

  for await (const message of result) {
    if (message.type === 'assistant' && message.message) {
      // Extract text from content blocks
      const textBlocks = message.message.content?.filter(
        (block: any) => block.type === 'text'
      ) ?? []
      for (const block of textBlocks) {
        content += (block as any).text ?? ''
      }
      // Track usage
      if (message.message.usage) {
        totalTokens += (message.message.usage as any).input_tokens ?? 0
        totalTokens += (message.message.usage as any).output_tokens ?? 0
      }
    }
    if (message.type === 'result') {
      sessionId = message.session_id
      if (message.subtype === 'success' && message.result) {
        content = message.result
      }
    }
  }

  return {
    content: content.trim(),
    tokenUsage: totalTokens || undefined,
    sessionId,
  }
}
