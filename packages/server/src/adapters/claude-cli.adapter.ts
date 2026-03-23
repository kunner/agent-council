import Anthropic from '@anthropic-ai/sdk'

export interface ClaudeResponse {
  content: string
  tokenUsage?: number
}

const MODEL = process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5-20251001'

// Singleton SDK client
let client: Anthropic | null = null

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    })
  }
  return client
}

export async function callClaude(
  message: string,
  systemPrompt: string,
  _workDir?: string,
): Promise<ClaudeResponse> {
  const anthropic = getClient()

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: message }],
  })

  const content = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')

  return {
    content,
    tokenUsage: response.usage.input_tokens + response.usage.output_tokens,
  }
}
