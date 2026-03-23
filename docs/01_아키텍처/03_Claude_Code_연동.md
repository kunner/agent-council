---
status: DRAFT
priority: 2
last_updated: 2026-03-23
---

# Claude Code 연동 설계

## 개요

Agent Council은 각 Agent Set의 리더/팀원을 Claude Code 세션으로 구동한다. Council Server는 Claude Code와 두 가지 방식으로 통신한다.

- **Phase 1 — CLI 어댑터**: `claude` CLI를 subprocess로 호출. 빠른 프로토타입에 적합하지만 세션 유지가 안 됨.
- **Phase 2 — MCP Channel 어댑터**: 커스텀 MCP Channel 서버를 통한 장기 양방향 세션. 목표 아키텍처.

어댑터는 인터페이스로 추상화되어 있어 Phase 1 → Phase 2 전환 시 상위 레이어 코드 변경이 불필요하다.

```
packages/server/src/adapters/
├── IClaudeAdapter.ts          ← 공통 인터페이스
├── ClaudeCliAdapter.ts        ← Phase 1: subprocess
└── ClaudeChannelAdapter.ts    ← Phase 2: MCP Channel
```

---

## 1. 어댑터 인터페이스

Phase 1과 Phase 2는 동일한 인터페이스를 구현한다. 상위 레이어(Set 관리, Council Room)는 어댑터 종류를 알 필요가 없다.

```typescript
// packages/server/src/adapters/IClaudeAdapter.ts

export interface ClaudeMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface ClaudeResponse {
  /** 리더의 최종 텍스트 응답 */
  content: string
  /** 응답 생성에 사용된 토큰 수 */
  inputTokens: number
  outputTokens: number
  /** 세션 ID (어댑터가 관리) */
  sessionId: string
  /** 도구 호출 결과 목록 (파일 편집, bash 실행 등) */
  toolUses?: ToolUseResult[]
  /** 응답 생성까지 걸린 시간 (ms) */
  durationMs: number
}

export interface ToolUseResult {
  toolName: string
  input: Record<string, unknown>
  output: string
}

export interface SendMessageOptions {
  /** Set ID — 세션 격리에 사용 */
  setId: string
  /** 메시지 내용 */
  message: string
  /** 시스템 프롬프트 (첫 호출 또는 재생성 시) */
  systemPrompt?: string
  /** 타임아웃 (ms). 기본값: 120_000 */
  timeoutMs?: number
}

export interface IClaudeAdapter {
  /**
   * Claude에 메시지를 전송하고 응답을 반환한다.
   * 세션이 없으면 새로 생성한다.
   */
  sendMessage(options: SendMessageOptions): Promise<ClaudeResponse>

  /**
   * Set에 연결된 세션을 종료하고 리소스를 해제한다.
   */
  terminateSession(setId: string): Promise<void>

  /**
   * 현재 실행 중인 모든 세션 목록을 반환한다.
   */
  listSessions(): Promise<SessionInfo[]>

  /**
   * 어댑터 종류를 반환한다.
   */
  readonly adapterType: 'cli' | 'channel'
}

export interface SessionInfo {
  setId: string
  sessionId: string
  startedAt: Date
  lastActiveAt: Date
  tokenCount: number
  isAlive: boolean
}
```

---

## 2. Phase 1: CLI 어댑터

### 2.1 개요

`claude` CLI를 Node.js `child_process.spawn`으로 호출한다. 각 호출은 독립 프로세스이므로 세션 상태가 유지되지 않는다. 대신 구현이 단순하고 즉시 사용 가능하다.

```
Council Server
    │
    ├─ spawn('claude', ['--message', '...', '--output-format', 'json', '-p'])
    │       │
    │       └─ stdout: JSON 응답
    │          stderr: 오류 메시지
    │
    └─ 응답 파싱 → Firestore 저장 → Council Room 표시
```

### 2.2 claude CLI 명령어 옵션

```bash
# 기본 호출 패턴
claude \
  --message "당신은 백엔드팀 리더입니다. API 설계 방향을 제안해주세요." \
  --output-format json \
  -p \
  --system "리더 역할 시스템 프롬프트" \
  --allowedTools "Bash,Read,Write,Edit" \
  --max-turns 10 \
  --dangerously-skip-permissions
```

| 옵션 | 설명 |
|---|---|
| `--message "..."` | 전송할 메시지. 멀티라인은 `$'...\n...'` 형식 사용 |
| `-p` | 비대화형 모드 (print mode). Council Server 필수 옵션 |
| `--output-format json` | 응답을 JSON으로 출력. 파싱 용이 |
| `--system "..."` | 시스템 프롬프트 직접 전달 |
| `--allowedTools "..."` | 허용할 도구 목록 (쉼표 구분) |
| `--max-turns N` | 도구 호출 포함 최대 턴 수 |
| `--dangerously-skip-permissions` | 서버 환경에서 권한 확인 프롬프트 비활성화 |
| `--no-stream` | 스트리밍 비활성화 (JSON 출력 시 자동 적용) |

> **주의**: `--dangerously-skip-permissions`는 서버 환경의 비대화형 실행에서 필요하다. 각 Set의 worktree 디렉토리를 `cwd`로 지정하여 파일 접근 범위를 제한한다.

### 2.3 응답 JSON 구조

`--output-format json` 옵션 사용 시 stdout에서 아래 구조를 반환한다.

```typescript
// claude CLI --output-format json 응답 구조
interface ClaudeCliJsonResponse {
  type: 'result'
  subtype: 'success' | 'error_max_turns' | 'error_during_execution'
  result: string                    // 최종 텍스트 응답
  session_id: string                // 세션 식별자 (재사용 불가, 참고용)
  is_error: boolean
  num_turns: number                 // 실제 사용된 턴 수
  total_cost_usd: number            // 비용 (USD)
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
  }
}
```

스트리밍 모드(`--output-format stream-json`)를 사용하면 줄 단위 NDJSON으로 진행 상황을 실시간 수신할 수 있다.

```typescript
// stream-json 이벤트 타입 예시
type StreamEvent =
  | { type: 'system'; subtype: 'init'; session_id: string }
  | { type: 'assistant'; message: { content: ContentBlock[] } }
  | { type: 'result'; subtype: 'success'; result: string; usage: UsageInfo }
  | { type: 'tool_use'; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }
```

### 2.4 subprocess 관리

```typescript
// packages/server/src/adapters/ClaudeCliAdapter.ts

import { spawn, ChildProcess } from 'child_process'
import { IClaudeAdapter, SendMessageOptions, ClaudeResponse } from './IClaudeAdapter'

export class ClaudeCliAdapter implements IClaudeAdapter {
  readonly adapterType = 'cli' as const

  // Set별 마지막 응답 타임스탬프 (세션 격리용 메타데이터)
  private sessionMeta = new Map<string, { startedAt: Date; tokenCount: number }>()

  async sendMessage(options: SendMessageOptions): Promise<ClaudeResponse> {
    const { setId, projectId, message, systemPrompt, timeoutMs = 120_000 } = options

    const args = this.buildArgs(message, systemPrompt)
    const worktreePath = this.resolveWorktree(projectId, setId)

    return this.runProcess(args, worktreePath, setId, timeoutMs)
  }

  private buildArgs(message: string, systemPrompt?: string): string[] {
    const args = [
      '--message', message,
      '--output-format', 'json',
      '-p',
      '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep',
      '--max-turns', '15',
      '--dangerously-skip-permissions',
    ]

    if (systemPrompt) {
      args.push('--system', systemPrompt)
    }

    return args
  }

  private runProcess(
    args: string[],
    cwd: string,
    setId: string,
    timeoutMs: number,
  ): Promise<ClaudeResponse> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now()
      const child: ChildProcess = spawn('claude', args, {
        cwd,
        env: {
          ...process.env,
          // BYOK: 사용자 API 키를 환경변수로 주입
          ANTHROPIC_API_KEY: this.getApiKey(setId),
        },
      })

      let stdout = ''
      let stderr = ''

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      // 타임아웃 처리
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new ClaudeAdapterError('TIMEOUT', `Set ${setId}: ${timeoutMs}ms 초과`, setId))
      }, timeoutMs)

      child.on('close', (code) => {
        clearTimeout(timer)

        if (code !== 0) {
          reject(new ClaudeAdapterError(
            'PROCESS_EXIT',
            `claude 프로세스 종료 코드 ${code}: ${stderr.slice(0, 500)}`,
            setId,
          ))
          return
        }

        try {
          const response = this.parseResponse(stdout, setId, Date.now() - startTime)
          this.updateSessionMeta(setId, response.inputTokens + response.outputTokens)
          resolve(response)
        } catch (err) {
          reject(new ClaudeAdapterError('PARSE_ERROR', `JSON 파싱 실패: ${stdout.slice(0, 200)}`, setId))
        }
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        reject(new ClaudeAdapterError('SPAWN_ERROR', `프로세스 시작 실패: ${err.message}`, setId))
      })
    })
  }

  private parseResponse(stdout: string, setId: string, durationMs: number): ClaudeResponse {
    // stdout에서 마지막 JSON 객체 추출 (진행 메시지 이후 최종 결과)
    const lines = stdout.trim().split('\n')
    const lastJson = lines.findLast(line => line.startsWith('{'))
    if (!lastJson) throw new Error('JSON 응답 없음')

    const raw = JSON.parse(lastJson)

    if (raw.is_error) {
      throw new ClaudeAdapterError('API_ERROR', raw.result, setId)
    }

    return {
      content: raw.result,
      inputTokens: raw.usage?.input_tokens ?? 0,
      outputTokens: raw.usage?.output_tokens ?? 0,
      sessionId: raw.session_id ?? `cli-${setId}`,
      durationMs,
    }
  }

  private updateSessionMeta(setId: string, tokens: number): void {
    const existing = this.sessionMeta.get(setId)
    if (existing) {
      existing.tokenCount += tokens
    } else {
      this.sessionMeta.set(setId, { startedAt: new Date(), tokenCount: tokens })
    }
  }

  private resolveWorktree(projectId: string, setId: string): string {
    // Set 서비스에서 worktree 경로를 조회; 경로 형식: /opt/agent-council/workspace/{projectId}/{setId}
    return `/opt/agent-council/workspace/${projectId}/${setId}`
  }

  private getApiKey(setId: string): string {
    // Phase 1: 서버 환경변수 단일 키
    // Phase 2: 사용자별 BYOK (암호화 저장소에서 복호화)
    return process.env.ANTHROPIC_API_KEY ?? ''
  }

  async terminateSession(setId: string): Promise<void> {
    // CLI 어댑터는 stateless이므로 메타데이터만 정리
    this.sessionMeta.delete(setId)
  }

  async listSessions() {
    return Array.from(this.sessionMeta.entries()).map(([setId, meta]) => ({
      setId,
      sessionId: `cli-${setId}`,
      startedAt: meta.startedAt,
      lastActiveAt: meta.startedAt, // CLI는 lastActive 추적 불가
      tokenCount: meta.tokenCount,
      isAlive: false, // CLI는 상시 연결 아님
    }))
  }
}

export class ClaudeAdapterError extends Error {
  constructor(
    public readonly code: 'TIMEOUT' | 'PROCESS_EXIT' | 'PARSE_ERROR' | 'SPAWN_ERROR' | 'API_ERROR',
    message: string,
    public readonly setId: string,
  ) {
    super(message)
    this.name = 'ClaudeAdapterError'
  }
}
```

### 2.5 시스템 프롬프트 구성

CLI 어댑터에서 리더 역할과 프로젝트 컨텍스트를 시스템 프롬프트로 주입한다.

```typescript
// packages/server/src/adapters/prompts/buildLeaderSystemPrompt.ts

export interface LeaderPromptContext {
  setName: string           // "백엔드팀"
  setRole: string           // "Spring Boot REST API 및 WebSocket 구현 담당"
  projectName: string       // "사내 메신저"
  projectGoal: string       // "React + Spring Boot 기반 실시간 메신저"
  branch: string            // "set-b/backend"
  worktreePath: string      // "/workspace/proj-001/set-b"
  teammates: number         // 팀원 수
  snapshot?: ProjectSnapshot // 세션 복원 시 이전 상태
  recentMessages?: string[] // 최근 Council 대화 요약
}

export function buildLeaderSystemPrompt(ctx: LeaderPromptContext): string {
  const snapshotSection = ctx.snapshot
    ? `
## 현재 프로젝트 상태 (세션 복원)
- 완료된 작업: ${ctx.snapshot.completedTasks.join(', ')}
- 진행 중: ${ctx.snapshot.inProgressTasks.map(t => `${t.task} (${t.progress})`).join(', ')}
- 주요 결정사항:
${ctx.snapshot.decisions.map(d => `  - ${d}`).join('\n')}
- Git 상태: ${ctx.branch} (${ctx.snapshot.gitState.branches?.[ctx.branch] ?? 'up-to-date'})
`
    : ''

  const recentMessagesSection = ctx.recentMessages?.length
    ? `
## 최근 Council 대화 (요약)
${ctx.recentMessages.join('\n')}
`
    : ''

  return `당신은 Agent Council의 ${ctx.setName} 리더입니다.

## 역할
${ctx.setRole}

## 프로젝트
- 이름: ${ctx.projectName}
- 목표: ${ctx.projectGoal}

## 작업 환경
- 담당 브랜치: ${ctx.branch}
- 작업 디렉토리: ${ctx.worktreePath}
- 팀원 수: ${ctx.teammates}명
${snapshotSection}${recentMessagesSection}
## 행동 원칙
1. Council Room에서는 다른 팀 리더들과 협력하여 의사결정을 내린다.
2. 기술적 내용은 핵심만 간결하게 전달한다. 불필요한 장황함을 피한다.
3. 다른 팀의 의견을 경청하고 통합 관점에서 판단한다.
4. 자신의 worktree(${ctx.worktreePath}) 외 경로는 수정하지 않는다.
5. 작업 완료 시 구체적인 결과물(파일명, 커밋 메시지)을 보고한다.
6. 차단 이슈 발생 시 즉시 Council Room에 에스컬레이션한다.

현재 Council Room 메시지에 응답하라.`
}
```

### 2.6 Set별 세션 격리

CLI 어댑터는 각 호출이 독립 프로세스이므로 세션 격리는 `cwd` 지정으로 구현한다.

```typescript
// Set A: /workspace/proj-001/set-a (아키텍처팀 worktree)
// Set B: /workspace/proj-001/set-b (백엔드팀 worktree)
// Set C: /workspace/proj-001/set-c (프론트팀 worktree)

// 각 spawn 호출은 해당 Set의 worktree를 cwd로 사용
const child = spawn('claude', args, { cwd: set.worktreePath })
```

Set 간 컨텍스트 혼용을 방지하기 위해 시스템 프롬프트에 담당 경로를 명시하고, Claude Code가 해당 경로 외부를 수정하려는 경우 이를 지시사항으로 제한한다.

---

## 3. Phase 2: MCP Channel 어댑터

### 3.1 Channel 프로토콜 개요

MCP Channel은 Claude Code의 실험적 기능(`experimental/claude/channel`)으로, 외부 서버가 Claude Code 세션과 양방향 실시간 통신을 유지하는 메커니즘이다.

```
Council Server
    │
    │  장기 연결 유지 (stdio 또는 WebSocket)
    │
    ▼
┌─────────────────────────────────────┐
│  Custom MCP Channel Server          │
│  (Council Server 내부 또는 사이드카)  │
│                                     │
│  - notification → Claude로 전송     │
│  - tool call 결과 ← Claude에서 수신  │
└─────────────────────────────────────┘
    │
    │  MCP 프로토콜 (JSON-RPC 2.0)
    │
    ▼
┌─────────────────────────────────────┐
│  Claude Code 세션                   │
│  (Set당 1개, 장기 실행)              │
│                                     │
│  - Agent Teams 활성화               │
│  - worktree에서 코드 작업            │
│  - Council 메시지 수신 및 응답        │
└─────────────────────────────────────┘
```

Channel 프로토콜의 핵심 특성:
- Claude Code 세션이 **종료되지 않고 지속** 실행됨
- Council Server가 언제든지 새 메시지를 Claude에 **push** 할 수 있음
- Claude가 도구 실행 결과를 **비동기로 스트리밍** 반환함
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` 환경변수로 Set 내부 팀워크 활성화

### 3.2 커스텀 Channel 서버 구현

Channel 서버는 MCP 서버 스펙(JSON-RPC 2.0)을 구현하되, `channel` 관련 메서드를 추가로 처리한다.

```typescript
// packages/server/src/adapters/channel/ChannelServer.ts

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { EventEmitter } from 'events'

export interface ChannelMessage {
  id: string
  content: string
  sender: string      // Council Room 발신자 이름
  timestamp: string
}

export interface ChannelServerOptions {
  setId: string
  worktreePath: string
  onResponse: (response: string) => Promise<void>
  onToolUse: (toolName: string, input: unknown) => Promise<void>
  onProgress: (message: string) => Promise<void>
}

export class ChannelServer extends EventEmitter {
  private server: Server
  private pendingMessages: ChannelMessage[] = []
  private isClaudeReady = false

  constructor(private options: ChannelServerOptions) {
    super()
    this.server = new Server(
      { name: `council-channel-${options.setId}`, version: '1.0.0' },
      { capabilities: { tools: {}, resources: {}, prompts: {} } },
    )
    this.setupHandlers()
  }

  private setupHandlers(): void {
    // Claude가 메시지를 요청할 때 응답
    this.server.setRequestHandler('channel/receive', async () => {
      if (this.pendingMessages.length === 0) {
        return { messages: [] }
      }
      const messages = [...this.pendingMessages]
      this.pendingMessages = []
      return { messages }
    })

    // Claude가 응답을 전송할 때 처리
    this.server.setRequestHandler('channel/send', async (request) => {
      const { content } = request.params as { content: string }
      await this.options.onResponse(content)
      return { success: true }
    })

    // Claude가 진행 상황을 보고할 때
    this.server.setRequestHandler('channel/progress', async (request) => {
      const { message } = request.params as { message: string }
      await this.options.onProgress(message)
      return { success: true }
    })
  }

  /**
   * Council Room 메시지를 Claude에 전달하기 위해 큐에 추가
   */
  enqueue(message: ChannelMessage): void {
    this.pendingMessages.push(message)
    this.emit('message_queued', message)
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport()
    await this.server.connect(transport)
    this.isClaudeReady = true
    this.emit('ready')
  }
}
```

### 3.3 Channel 어댑터 구현

```typescript
// packages/server/src/adapters/ClaudeChannelAdapter.ts

import { spawn, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { IClaudeAdapter, SendMessageOptions, ClaudeResponse, SessionInfo } from './IClaudeAdapter'
import { ChannelServer } from './channel/ChannelServer'

interface ManagedSession {
  setId: string
  process: ChildProcess
  channelServer: ChannelServer
  startedAt: Date
  lastActiveAt: Date
  tokenCount: number
  responseQueue: Array<{
    resolve: (value: ClaudeResponse) => void
    reject: (reason: Error) => void
    startTime: number
    timeoutHandle: ReturnType<typeof setTimeout>
  }>
}

// EventEmitter를 상속하여 tool_use, progress 이벤트를 외부에 전달
export class ClaudeChannelAdapter extends EventEmitter implements IClaudeAdapter {
  readonly adapterType = 'channel' as const

  private sessions = new Map<string, ManagedSession>()

  constructor() {
    super()  // EventEmitter 초기화 필수
  }

  async sendMessage(options: SendMessageOptions): Promise<ClaudeResponse> {
    const { setId, message, systemPrompt, timeoutMs = 120_000 } = options

    // 세션이 없으면 생성
    if (!this.sessions.has(setId)) {
      await this.createSession(setId, systemPrompt)
    }

    const session = this.sessions.get(setId)!

    return new Promise<ClaudeResponse>((resolve, reject) => {
      const startTime = Date.now()

      const timeoutHandle = setTimeout(() => {
        reject(new Error(`Set ${setId}: Channel 응답 타임아웃 (${timeoutMs}ms)`))
        // 타임아웃 발생 시 세션 재생성 필요 플래그
        this.markSessionStale(setId)
      }, timeoutMs)

      session.responseQueue.push({ resolve, reject, startTime, timeoutHandle })

      // 메시지를 Channel 서버 큐에 추가
      session.channelServer.enqueue({
        id: `msg-${Date.now()}`,
        content: message,
        sender: 'council',
        timestamp: new Date().toISOString(),
      })

      session.lastActiveAt = new Date()
    })
  }

  private async createSession(setId: string, projectId: string, systemPrompt?: string): Promise<void> {
    const worktreePath = this.resolveWorktree(projectId, setId)

    // Channel 서버 생성 (응답 처리 콜백 포함)
    const channelServer = new ChannelServer({
      setId,
      worktreePath,
      onResponse: async (content: string) => {
        this.handleResponse(setId, content)
      },
      onToolUse: async (toolName, input) => {
        // 도구 사용 로그를 Firestore에 기록 (EventEmitter.emit 직접 사용)
        this.emit('tool_use', { setId, toolName, input })
      },
      onProgress: async (message) => {
        // 진행 상황을 Set 로그로 전송
        this.emit('progress', { setId, message })
      },
    })

    // Claude Code 프로세스 시작 (Channel 모드)
    const claudeProcess = spawn('claude', [
      '--channel',  // Channel 모드 활성화
      '--dangerously-skip-permissions',
      ...(systemPrompt ? ['--system', systemPrompt] : []),
    ], {
      cwd: worktreePath,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: this.getApiKey(setId),
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',  // Agent Teams 활성화
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const session: ManagedSession = {
      setId,
      process: claudeProcess,
      channelServer,
      startedAt: new Date(),
      lastActiveAt: new Date(),
      tokenCount: 0,
      responseQueue: [],
    }

    this.sessions.set(setId, session)

    claudeProcess.on('exit', (code) => {
      // 예상치 못한 프로세스 종료 처리
      this.handleSessionDeath(setId, code)
    })

    await channelServer.start()
  }

  private handleResponse(setId: string, content: string): void {
    const session = this.sessions.get(setId)
    if (!session) return

    const pending = session.responseQueue.shift()
    if (!pending) return

    clearTimeout(pending.timeoutHandle)

    pending.resolve({
      content,
      inputTokens: 0,   // Channel 모드에서는 usage 이벤트로 별도 수신
      outputTokens: 0,
      sessionId: `channel-${setId}`,
      durationMs: Date.now() - pending.startTime,
    })
  }

  private handleSessionDeath(setId: string, code: number | null): void {
    const session = this.sessions.get(setId)
    if (!session) return

    // 대기 중인 요청 전부 실패 처리
    for (const pending of session.responseQueue) {
      clearTimeout(pending.timeoutHandle)
      pending.reject(new Error(`Set ${setId} 세션 종료 (코드: ${code})`))
    }

    this.sessions.delete(setId)
  }

  private markSessionStale(setId: string): void {
    // 타임아웃 발생 세션은 다음 요청 시 재생성하도록 제거
    this.sessions.delete(setId)
  }

  async terminateSession(setId: string): Promise<void> {
    const session = this.sessions.get(setId)
    if (!session) return

    session.process.kill('SIGTERM')
    this.sessions.delete(setId)
  }

  async listSessions(): Promise<SessionInfo[]> {
    return Array.from(this.sessions.values()).map(s => ({
      setId: s.setId,
      sessionId: `channel-${s.setId}`,
      startedAt: s.startedAt,
      lastActiveAt: s.lastActiveAt,
      tokenCount: s.tokenCount,
      isAlive: !s.process.killed,
    }))
  }

  private resolveWorktree(projectId: string, setId: string): string {
    // 경로 형식: /opt/agent-council/workspace/{projectId}/{setId}
    return `/opt/agent-council/workspace/${projectId}/${setId}`
  }

  private getApiKey(setId: string): string {
    return process.env.ANTHROPIC_API_KEY ?? ''
  }
  // emit()은 EventEmitter 상속으로 제공됨 — 별도 선언 불필요
}
```

### 3.4 양방향 통신 흐름

```
[Council Room에서 PM 메시지 수신]
         │
         ▼
ChannelAdapter.sendMessage({ setId: 'set-b', message: '...' })
         │
         ├─ 세션 없음? → createSession() → Claude Code 프로세스 시작
         │
         ▼
channelServer.enqueue(message)
         │
         ▼ (Claude Code가 Channel에서 메시지 폴링)
[Claude Code — 메시지 수신 및 처리]
         │
         ├─ 필요 시 도구 실행 (Bash, Write, Edit ...)
         │    └─ channelServer.onToolUse() → Firestore 로그 저장
         │
         ├─ 진행 상황 보고
         │    └─ channelServer.onProgress() → UI 프로그레스 업데이트
         │
         └─ 최종 응답 전송
              └─ channelServer.onResponse() → Firestore 메시지 저장 → UI 표시
```

**notification → Claude (단방향 푸시):**

```typescript
// 타 Set 작업 완료 알림을 현재 Set 리더에게 전달
async function notifySetLeader(setId: string, notification: string): Promise<void> {
  const adapter = getAdapter() // IClaudeAdapter
  await adapter.sendMessage({
    setId,
    message: `[시스템 알림] ${notification}`,
    timeoutMs: 30_000,
  })
}

// 예: PR 머지 후 연관 Set에 알림
await notifySetLeader('set-c', 'Set B의 백엔드 API가 main에 머지되었습니다. API 연동을 시작할 수 있습니다.')
```

### 3.5 Agent Teams 연동

`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 환경변수를 설정하면 Claude Code가 Set 내부에서 sub-agent(팀원)를 자동으로 생성하여 작업을 병렬 처리한다.

```typescript
// Set 생성 시 Agent Teams 활성화
const claudeProcess = spawn('claude', ['--channel', '--dangerously-skip-permissions'], {
  cwd: worktreePath,
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: apiKey,
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    // 팀원 수 제한 (리소스 관리)
    CLAUDE_CODE_MAX_SUBAGENTS: '3',
  },
})
```

Agent Teams 동작 방식:
- 리더 Claude Code가 복잡한 작업을 받으면 내부적으로 sub-agent(팀원)를 spawn
- 팀원들은 리더의 worktree 내에서 독립적으로 파일 작업 수행
- 팀원 완료 결과는 리더에게 취합되어 Council Room에 요약 보고
- Set 내부 통신은 Council Room에 노출되지 않음 (Firestore logs 서브컬렉션에만 저장)

```typescript
// Set 내부 로그 수집 (팀원 활동 포함)
channelServer.on('tool_use', async ({ setId, toolName, input }) => {
  await db.collection(`projects/${projectId}/sets/${setId}/logs`).add({
    content: `[${toolName}] ${JSON.stringify(input).slice(0, 200)}`,
    type: 'code',
    timestamp: FieldValue.serverTimestamp(),
  })
})
```

### 3.6 장기 세션 유지 전략

```typescript
// packages/server/src/adapters/SessionKeepAlive.ts

export class SessionKeepAlive {
  private timers = new Map<string, ReturnType<typeof setInterval>>()

  /**
   * 세션 heartbeat 시작 (30초마다 tmux has-session으로 프로세스 생존 확인)
   * Phase 1: tmux has-session 사용 — API 호출 없이 토큰 낭비 없음
   * Phase 2 (Channel): 별도 채널 ping 사용
   */
  start(projectId: string, setId: string, adapter: IClaudeAdapter): void {
    const sessionName = `council-${projectId}-${setId}`
    const timer = setInterval(async () => {
      try {
        // Phase 1: tmux has-session으로 프로세스 생존 확인 (토큰 소비 없음)
        const { execSync } = await import('child_process')
        execSync(`tmux has-session -t ${sessionName}`, { stdio: 'ignore' })
      } catch {
        // heartbeat 실패 → 세션 재생성은 다음 실제 요청 시 자동 처리
        this.stop(setId)
      }
    }, 30_000)

    this.timers.set(setId, timer)
  }

  stop(setId: string): void {
    const timer = this.timers.get(setId)
    if (timer) {
      clearInterval(timer)
      this.timers.delete(setId)
    }
  }

  stopAll(): void {
    for (const setId of this.timers.keys()) {
      this.stop(setId)
    }
  }
}
```

tmux를 통한 프로세스 영속성:

```typescript
// packages/server/src/adapters/channel/TmuxSessionManager.ts

export class TmuxSessionManager {
  /**
   * tmux 세션 안에서 Claude Code를 실행하여
   * Council Server 재시작 시에도 프로세스 유지
   */
  async launchInTmux(projectId: string, setId: string, command: string, cwd: string): Promise<number> {
    // tmux 세션명 규칙: council-{projectId}-{setId}
    const sessionName = `council-${projectId}-${setId}`

    // 기존 tmux 세션 확인
    const exists = await this.sessionExists(sessionName)
    if (exists) {
      await this.killSession(sessionName)
    }

    // 새 tmux 세션 생성 및 명령 실행
    await execAsync(`tmux new-session -d -s ${sessionName} -c ${cwd}`)
    await execAsync(`tmux send-keys -t ${sessionName} '${command}' Enter`)

    // PID 조회
    const pid = await this.getPid(sessionName)
    return pid
  }

  async sessionExists(sessionName: string): Promise<boolean> {
    try {
      await execAsync(`tmux has-session -t ${sessionName}`)
      return true
    } catch {
      return false
    }
  }

  async killSession(sessionName: string): Promise<void> {
    await execAsync(`tmux kill-session -t ${sessionName}`)
  }
}
```

---

## 4. 에러 처리 및 재시도 전략

### 4.1 에러 분류

```typescript
// packages/server/src/adapters/errors.ts

export const ADAPTER_ERROR_CODES = {
  // 일시적 오류 — 재시도 가능
  TIMEOUT: 'TIMEOUT',
  RATE_LIMITED: 'RATE_LIMITED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  SESSION_DEAD: 'SESSION_DEAD',

  // 영구적 오류 — 재시도 불필요
  INVALID_API_KEY: 'INVALID_API_KEY',
  CONTEXT_TOO_LONG: 'CONTEXT_TOO_LONG',
  CONTENT_POLICY: 'CONTENT_POLICY',
  SPAWN_ERROR: 'SPAWN_ERROR',
  PARSE_ERROR: 'PARSE_ERROR',
} as const

export type AdapterErrorCode = typeof ADAPTER_ERROR_CODES[keyof typeof ADAPTER_ERROR_CODES]

const RETRYABLE_CODES: AdapterErrorCode[] = [
  'TIMEOUT',
  'RATE_LIMITED',
  'NETWORK_ERROR',
  'SESSION_DEAD',
]

export function isRetryable(code: AdapterErrorCode): boolean {
  return RETRYABLE_CODES.includes(code)
}
```

### 4.2 재시도 래퍼

```typescript
// packages/server/src/adapters/withRetry.ts

export interface RetryOptions {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  onRetry?: (attempt: number, error: Error) => void
}

const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts = { ...DEFAULT_RETRY, ...options }
  let lastError: Error

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err as Error

      // ClaudeAdapterError인 경우 재시도 여부 판단
      if (err instanceof ClaudeAdapterError && !isRetryable(err.code)) {
        throw err  // 재시도 불필요한 오류는 즉시 throw
      }

      if (attempt === opts.maxAttempts) break

      // 지수 백오프 + 지터
      const delay = Math.min(
        opts.baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 1000,
        opts.maxDelayMs,
      )

      opts.onRetry?.(attempt, lastError)
      await sleep(delay)
    }
  }

  throw lastError!
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
```

### 4.3 세션 복원 통합

```typescript
// packages/server/src/session/SessionRestorer.ts

import { IClaudeAdapter } from '../adapters/IClaudeAdapter'
import { buildLeaderSystemPrompt, LeaderPromptContext } from '../adapters/prompts/buildLeaderSystemPrompt'

export class SessionRestorer {
  constructor(
    private adapter: IClaudeAdapter,
    private firestoreService: FirestoreService,
  ) {}

  /**
   * Set 세션 복원 시도.
   * 1순위: 기존 세션 ping 성공 → 연결 유지
   * 2순위: 스냅샷 기반 재생성
   * 3순위: 메시지 히스토리 요약 기반 재생성
   */
  async restore(setId: string, projectId: string): Promise<void> {
    const sessions = await this.adapter.listSessions()
    const existing = sessions.find(s => s.setId === setId && s.isAlive)

    if (existing) {
      // 전략 A: 기존 세션 유지
      return
    }

    // 전략 B: 스냅샷 기반 재생성
    const snapshot = await this.firestoreService.getLatestSnapshot(projectId)
    const setDoc = await this.firestoreService.getSet(projectId, setId)
    const recentMessages = await this.firestoreService.getRecentMessages(projectId, 30)

    const ctx: LeaderPromptContext = {
      setName: setDoc.name,
      setRole: setDoc.role,
      projectName: snapshot?.summary ?? '프로젝트',
      projectGoal: '',
      branch: setDoc.branch,
      worktreePath: setDoc.worktreePath,
      teammates: setDoc.teammates,
      snapshot,
      recentMessages: recentMessages.map(m => `${m.senderName}: ${m.content.slice(0, 200)}`),
    }

    const systemPrompt = buildLeaderSystemPrompt(ctx)

    // 새 세션 시작 (컨텍스트 주입된 시스템 프롬프트로)
    await this.adapter.sendMessage({
      setId,
      message: '세션이 복원되었습니다. 현재 상태를 확인하고 준비 완료 여부를 보고하라.',
      systemPrompt,
      timeoutMs: 60_000,
    })
  }
}
```

---

## 5. 리소스 관리

### 5.1 동시 세션 수 제한

Oracle Ampere (24GB RAM) 환경 기준으로 세션 수 상한을 설정한다.

```typescript
// packages/server/src/adapters/ResourceLimiter.ts

export interface ResourceLimits {
  /** 동시 활성 Claude Code 세션 최대 수 */
  maxConcurrentSessions: number
  /** 단일 세션 최대 메모리 (MB) */
  maxMemoryPerSessionMb: number
  /** 전체 세션 메모리 상한 (MB) */
  maxTotalMemoryMb: number
  /** 세션 유휴 타임아웃 — 이후 자동 종료 (ms) */
  idleTimeoutMs: number
}

// Oracle Ampere 24GB 기준 권장값 (세션당 ~1.5~2GB 실측 기준)
export const DEFAULT_LIMITS: ResourceLimits = {
  maxConcurrentSessions: 8,        // Set 최대 8개 (24GB RAM 기준)
  maxMemoryPerSessionMb: 2_048,    // 세션당 최대 2GB
  maxTotalMemoryMb: 16_384,        // 전체 16GB (OS/서버 여유 8GB)
  idleTimeoutMs: 2 * 60 * 60_000, // PM 부재 2시간 후 세션 종료
}

export class ResourceLimiter {
  private activeSessions = new Set<string>()

  constructor(private limits: ResourceLimits = DEFAULT_LIMITS) {}

  canCreateSession(): boolean {
    return this.activeSessions.size < this.limits.maxConcurrentSessions
  }

  register(setId: string): void {
    if (!this.canCreateSession()) {
      throw new Error(
        `세션 한도 초과: 최대 ${this.limits.maxConcurrentSessions}개까지 허용. ` +
        `현재: ${this.activeSessions.size}개`
      )
    }
    this.activeSessions.add(setId)
  }

  release(setId: string): void {
    this.activeSessions.delete(setId)
  }

  get activeCount(): number {
    return this.activeSessions.size
  }
}
```

### 5.2 유휴 세션 자동 종료

```typescript
// packages/server/src/adapters/IdleSessionReaper.ts

export class IdleSessionReaper {
  private reapTimer?: ReturnType<typeof setInterval>

  constructor(
    private adapter: IClaudeAdapter,
    private idleTimeoutMs: number,
    private onReap: (setId: string) => Promise<void>,
  ) {}

  start(): void {
    // 5분마다 유휴 세션 검사
    this.reapTimer = setInterval(async () => {
      const sessions = await this.adapter.listSessions()
      const now = Date.now()

      for (const session of sessions) {
        const idleMs = now - session.lastActiveAt.getTime()
        if (idleMs > this.idleTimeoutMs) {
          await this.adapter.terminateSession(session.setId)
          await this.onReap(session.setId)
        }
      }
    }, 5 * 60_000)
  }

  stop(): void {
    if (this.reapTimer) {
      clearInterval(this.reapTimer)
    }
  }
}
```

### 5.3 어댑터 팩토리

Phase 1/2 전환을 단일 설정으로 제어한다.

```typescript
// packages/server/src/adapters/AdapterFactory.ts

import { IClaudeAdapter } from './IClaudeAdapter'
import { ClaudeCliAdapter } from './ClaudeCliAdapter'
import { ClaudeChannelAdapter } from './ClaudeChannelAdapter'
import { ResourceLimiter } from './ResourceLimiter'

export type AdapterPhase = 'cli' | 'channel'

export function createAdapter(phase: AdapterPhase = 'cli'): IClaudeAdapter {
  switch (phase) {
    case 'cli':
      return new ClaudeCliAdapter()
    case 'channel':
      return new ClaudeChannelAdapter()
    default:
      throw new Error(`알 수 없는 어댑터 타입: ${phase}`)
  }
}

// 전역 싱글턴 (Council Server 내부)
let _adapter: IClaudeAdapter | null = null

export function getAdapter(): IClaudeAdapter {
  if (!_adapter) {
    const phase = (process.env.CLAUDE_ADAPTER_PHASE as AdapterPhase) ?? 'cli'
    _adapter = createAdapter(phase)
  }
  return _adapter
}

// 환경변수로 Phase 전환
// Phase 1: CLAUDE_ADAPTER_PHASE=cli
// Phase 2: CLAUDE_ADAPTER_PHASE=channel
```

---

## 6. 관련 문서

- `PLAN.md` § 5.5 — Claude Code 연동 방식 (개요)
- `PLAN.md` § 7.5 — 세션 관리 & 대화 재개
- `PLAN.md` § 8 — 구현 로드맵 (Phase 1/2 범위)
- `PLAN.md` § 10.1 — Claude Code 세션 관리 리스크
- `PLAN.md` § 10.4 — Channel API 안정성 리스크
- `../05_기능명세/08_Claude_Code_어댑터.md` — CLI·Channel 어댑터 상세 구현 명세
- `../00_설정_참조표.md` — 세션 제한값, tmux 명명 규칙, 포트, 전역 설정값 단일 출처
