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
  const isResume = !!params.sessionId

  // API 키가 있으면 사용, 없으면 Max 플랜 OAuth
  const sdkEnv = { ...process.env }
  if (!sdkEnv.ANTHROPIC_API_KEY) {
    delete sdkEnv.ANTHROPIC_API_KEY
  }

  const result = query({
    prompt: params.message,
    options: {
      cwd: params.cwd ?? process.cwd(),
      model,
      // 세션 재개 시 시스템 프롬프트를 appendSystemPrompt로 전달
      // (이전 대화 컨텍스트가 이미 세션에 있으므로 중복 방지)
      ...(isResume
        ? { appendSystemPrompt: params.systemPrompt }
        : { systemPrompt: params.systemPrompt }
      ),
      resume: params.sessionId ?? undefined,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      // maxTurns 제한 없음 — CLI처럼 필요한 만큼 도구 사용
      // API 키 사용 시에만 비용 제한을 위해 설정
      ...(sdkEnv.ANTHROPIC_API_KEY
        ? { maxTurns: params.maxTurns ?? 5 }
        : {}
      ),
      persistSession: true,
      env: sdkEnv,
    },
  })

  let content = ''
  let sessionId: string | undefined
  let totalTokens = 0

  for await (const message of result) {
    if (message.type === 'assistant' && message.message) {
      const textBlocks = message.message.content?.filter(
        (block: any) => block.type === 'text'
      ) ?? []
      for (const block of textBlocks) {
        content += (block as any).text ?? ''
      }
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
