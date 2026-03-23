import Anthropic from '@anthropic-ai/sdk'
import type { ClaudeModel } from '@agent-council/shared'
import fs from 'fs'
import path from 'path'

export interface ClaudeResponse {
  content: string
  tokenUsage?: number
}

const MODEL_MAP: Record<ClaudeModel, string> = {
  opus: 'claude-opus-4-20250514',
  sonnet: 'claude-sonnet-4-20250514',
  haiku: 'claude-haiku-4-5-20251001',
}

let client: Anthropic | null = null

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    })
  }
  return client
}

/**
 * worktree에서 코드 컨텍스트를 수집
 */
function getCodeContext(worktreePath: string): string {
  if (!worktreePath || !fs.existsSync(worktreePath)) return ''

  try {
    // 1. 디렉토리 구조 (3레벨까지, node_modules 등 제외)
    const tree = listDir(worktreePath, 3)

    // 2. 핵심 파일 읽기
    const keyFiles = [
      'README.md', 'package.json', 'pom.xml', 'build.gradle',
      'CLAUDE.md', '.env.example',
    ]
    const fileContents: string[] = []
    for (const name of keyFiles) {
      const filePath = path.join(worktreePath, name)
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8').slice(0, 2000)
        fileContents.push(`--- ${name} ---\n${content}`)
      }
    }

    let context = `\n## 코드베이스 정보 (worktree: ${worktreePath})\n`
    context += `### 디렉토리 구조\n\`\`\`\n${tree}\n\`\`\`\n`
    if (fileContents.length > 0) {
      context += `### 핵심 파일\n\`\`\`\n${fileContents.join('\n\n')}\n\`\`\`\n`
    }
    return context
  } catch {
    return ''
  }
}

function listDir(dirPath: string, maxDepth: number, depth = 0): string {
  if (depth >= maxDepth) return ''
  const indent = '  '.repeat(depth)
  const ignore = ['node_modules', '.git', 'dist', 'build', '.next', 'target', '__pycache__', '.omc']
  let result = ''

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (ignore.includes(entry.name)) continue
      if (entry.name.startsWith('.') && depth === 0 && entry.name !== '.env.example') continue
      result += `${indent}${entry.isDirectory() ? '📁' : '📄'} ${entry.name}\n`
      if (entry.isDirectory()) {
        result += listDir(path.join(dirPath, entry.name), maxDepth, depth + 1)
      }
    }
  } catch { /* ignore */ }
  return result
}

export async function callClaude(
  message: string,
  systemPrompt: string,
  worktreePath?: string,
  model: ClaudeModel = 'sonnet',
): Promise<ClaudeResponse> {
  const anthropic = getClient()
  const modelId = MODEL_MAP[model] ?? MODEL_MAP.sonnet

  // worktree가 있으면 코드 컨텍스트를 시스템 프롬프트에 추가
  const codeContext = worktreePath ? getCodeContext(worktreePath) : ''
  const fullSystemPrompt = systemPrompt + codeContext

  const response = await anthropic.messages.create({
    model: modelId,
    max_tokens: 4096,
    system: fullSystemPrompt,
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
