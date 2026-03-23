---
status: DRAFT
priority: 1
last_updated: 2026-03-23
---

# Claude Adapter 인터페이스 설계

## 목차

1. [개요 및 설계 철학](#1-개요-및-설계-철학)
2. [Adapter 패턴 설계 (Strategy Pattern)](#2-adapter-패턴-설계-strategy-pattern)
3. [핵심 인터페이스 정의](#3-핵심-인터페이스-정의)
4. [CLI 어댑터 구현 상세](#4-cli-어댑터-구현-상세)
5. [Channel 어댑터 구현 상세 (Phase 2)](#5-channel-어댑터-구현-상세-phase-2)
6. [컨텍스트 빌더 상세](#6-컨텍스트-빌더-상세)
7. [에러 처리](#7-에러-처리)
8. [팩토리 패턴 (자동 선택)](#8-팩토리-패턴-자동-선택)

---

## 1. 개요 및 설계 철학

### 1.1 배경

Agent Council은 각 Agent Set의 리더가 Claude Code 세션과 통신해야 한다. 이 통신 방식은 프로젝트 단계에 따라 두 가지 구현이 필요하다.

- **Phase 1**: `claude` CLI를 subprocess로 실행하는 CLI 어댑터 (빠른 프로토타이핑)
- **Phase 2**: MCP Channel 프로토콜을 통한 장기 세션 유지 어댑터 (목표 아키텍처)

두 구현은 **동일한 인터페이스**를 공유하므로, Council Server의 비즈니스 로직은 어댑터 교체 시에도 수정이 없다.

### 1.2 설계 목표

```
┌──────────────────────────────────────────────────────────────┐
│  Council Server (비즈니스 로직)                                │
│  - SetOrchestrator, MessageRouter, SessionManager            │
│  - 어댑터가 CLI인지 Channel인지 알 필요 없음                    │
└──────────────────────┬───────────────────────────────────────┘
                       │ IClaudeAdapter 인터페이스
          ┌────────────┴─────────────┐
          │                          │
   ┌──────▼──────────┐      ┌────────▼───────────────┐
   │ ClaudeCliAdapter│      │ ClaudeChannelAdapter   │
   │ (Phase 1)       │      │ (Phase 2)              │
   │                 │      │                        │
   │ claude CLI      │      │ MCP Channel            │
   │ subprocess      │      │ Protocol               │
   └─────────────────┘      └────────────────────────┘
```

**핵심 원칙:**
- 어댑터는 교체 가능 (Strategy Pattern)
- 인터페이스는 비동기 스트리밍 기반 (응답이 길어질 수 있음)
- 세션 생명주기는 어댑터 내부에서 관리
- 에러는 공통 타입으로 정규화

---

## 2. Adapter 패턴 설계 (Strategy Pattern)

### 2.1 전체 구조

```typescript
// packages/server/src/adapters/index.ts

/**
 * Claude Code 연동 어댑터 모듈 공개 API
 *
 * 외부 코드는 이 파일에서만 import하며, 구체 구현 클래스에
 * 직접 의존하지 않는다.
 */

export type { IClaudeAdapter, AdapterConfig, SendOptions, AdapterResponse } from './IClaudeAdapter'
export type { ISessionManager, SessionInfo, SessionStatus } from './ISessionManager'
export type { IContextBuilder, ContextSnapshot, SystemPromptOptions } from './IContextBuilder'
export { AdapterFactory } from './AdapterFactory'
export { AdapterError, AdapterErrorCode } from './AdapterError'
```

### 2.2 어댑터 교체 흐름

```
설정 파일 (config.ts)
  └── ADAPTER_TYPE: 'cli' | 'channel'
        │
        ▼
  AdapterFactory.create(config)
        │
        ├── 'cli'     → new ClaudeCliAdapter(config)
        └── 'channel' → new ClaudeChannelAdapter(config)
              │
              ▼
        IClaudeAdapter (동일 인터페이스)
              │
              ▼
  SetOrchestrator.sendMessage(adaptedMessage)
```

---

## 3. 핵심 인터페이스 정의

### 3.1 IClaudeAdapter

Claude Code 세션에 메시지를 보내고 응답을 받는 핵심 인터페이스.

```typescript
// packages/server/src/adapters/IClaudeAdapter.ts

import { EventEmitter } from 'node:events'

/**
 * 어댑터 설정 (CLI / Channel 공통)
 */
export interface AdapterConfig {
  /** Anthropic API 키 (BYOK 또는 환경변수) */
  apiKey: string
  /** Claude 모델 ID */
  model?: string
  /** 작업 디렉토리 (worktree 경로) */
  workingDirectory: string
  /** 최대 응답 대기 시간 (ms). 기본값: 120_000 */
  timeoutMs?: number
  /** Rate Limit 재시도 횟수. 기본값: 3 */
  maxRetries?: number
  /** Rate Limit 재시도 대기 시간 (ms). 기본값: 5_000 */
  retryDelayMs?: number
}

/**
 * send() 호출 옵션
 */
export interface SendOptions {
  /** 타임아웃 오버라이드 (해당 호출에만 적용) */
  timeoutMs?: number
  /** 스트리밍 응답 활성화 여부. 기본값: true */
  stream?: boolean
  /** 이 메시지에 대한 추가 시스템 프롬프트 접미 (임시 주입) */
  systemSuffix?: string
}

/**
 * 어댑터 응답 구조 (스트림 완료 후 최종값)
 */
export interface AdapterResponse {
  /** 응답 텍스트 전체 */
  content: string
  /** 소비된 토큰 수 */
  usage: {
    inputTokens: number
    outputTokens: number
  }
  /** 응답 완료 이유 */
  stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'
  /** 세션 ID (어댑터 내부 식별자) */
  sessionId: string
  /** 응답 생성 시간 (ms) */
  durationMs: number
}

/**
 * 스트리밍 응답 이벤트 타입
 */
export interface AdapterStreamEvents {
  /** 텍스트 청크 수신 */
  chunk: (text: string) => void
  /** 응답 완료 */
  done: (response: AdapterResponse) => void
  /** 에러 발생 */
  error: (error: AdapterError) => void
  /** 타이핑 인디케이터 (WebSocket 브로드캐스트용) */
  thinking: () => void
}

/**
 * Claude Code 어댑터 핵심 인터페이스.
 *
 * CLI 어댑터와 Channel 어댑터가 모두 이 인터페이스를 구현한다.
 * Council Server의 비즈니스 로직은 이 인터페이스에만 의존한다.
 */
export interface IClaudeAdapter extends EventEmitter {
  /**
   * Claude에게 메시지를 전송하고 응답을 반환한다.
   *
   * stream: true (기본값)일 때 'chunk' 이벤트가 순차 발생하고,
   * 완료되면 'done' 이벤트 + Promise resolve가 함께 일어난다.
   *
   * @param message 사용자/오케스트레이터 메시지
   * @param options 호출별 옵션
   * @returns 최종 응답 (스트림이 완전히 완료된 후)
   */
  send(message: string, options?: SendOptions): Promise<AdapterResponse>

  /**
   * 응답 스트림 이벤트 구독 (EventEmitter 방식).
   *
   * 사용 예:
   *   adapter.on('chunk', (text) => broadcastToWebSocket(text))
   *   adapter.on('done', (response) => saveToFirestore(response))
   *   adapter.on('error', (err) => handleError(err))
   */
  on<K extends keyof AdapterStreamEvents>(
    event: K,
    listener: AdapterStreamEvents[K]
  ): this

  /**
   * 어댑터 현재 상태를 반환한다.
   */
  getStatus(): AdapterStatus

  /**
   * 세션을 종료하고 리소스를 해제한다.
   *
   * CLI 어댑터: subprocess 종료
   * Channel 어댑터: MCP 연결 해제
   */
  terminate(): Promise<void>
}

/**
 * 어댑터 상태
 */
export type AdapterStatus =
  | { state: 'idle' }                          // 대기 중 (전송 가능)
  | { state: 'sending'; startedAt: Date }      // 전송 중
  | { state: 'streaming'; startedAt: Date }    // 스트리밍 수신 중
  | { state: 'terminated' }                    // 종료됨
  | { state: 'error'; error: AdapterError }    // 에러 상태
```

### 3.2 ISessionManager

Set별 어댑터 인스턴스의 생명주기를 관리한다.

```typescript
// packages/server/src/adapters/ISessionManager.ts

import type { IClaudeAdapter, AdapterConfig } from './IClaudeAdapter'

/**
 * 세션 정보 (Firestore 저장 대상)
 */
export interface SessionInfo {
  /** 세션 고유 ID */
  sessionId: string
  /** 소속 Set ID */
  setId: string
  /** 소속 프로젝트 ID */
  projectId: string
  /** 세션 생성 시각 */
  createdAt: Date
  /** 마지막 활동 시각 */
  lastActiveAt: Date
  /** 현재 상태 */
  status: SessionStatus
  /** 어댑터 타입 */
  adapterType: 'cli' | 'channel'
  /** 총 소비 토큰 */
  totalTokensUsed: number
}

export type SessionStatus =
  | 'starting'    // 세션 시작 중
  | 'active'      // 정상 동작 중
  | 'idle'        // 유휴 (30분 이상 비활성)
  | 'sleeping'    // 일시 중단 (tmux 세션 유지 중)
  | 'stopping'    // 세션 종료 중
  | 'stopped'     // 종료됨 (재생성 필요)
  | 'error'       // 에러 상태

/**
 * 세션 복원에 필요한 컨텍스트 데이터
 */
export interface SessionRestoreContext {
  /** 가장 최근 스냅샷 (없으면 undefined) */
  latestSnapshot?: ProjectSnapshot
  /** Firestore에서 로드한 최근 메시지 */
  recentMessages: ConversationMessage[]
  /** 프로젝트 메타데이터 */
  projectMeta: {
    name: string
    type: 'new' | 'existing' | 'analysis'
    techStack?: string
  }
  /** Set 역할 및 설정 */
  setMeta: {
    name: string
    role: string
    branch: string
    worktreePath: string
  }
}

/**
 * 세션 관리자 인터페이스.
 *
 * Set별로 IClaudeAdapter 인스턴스를 생성/재사용/복원한다.
 * Council Server 부팅 시 세션 복원을 담당한다.
 */
export interface ISessionManager {
  /**
   * 새 Claude 세션을 생성하고 IClaudeAdapter를 반환한다.
   *
   * - Git worktree 경로에서 세션 시작
   * - 세션 정보를 Firestore에 저장
   * - 어댑터 타입은 팩토리를 통해 config에서 자동 결정
   *
   * @param setId 세션을 생성할 Set ID
   * @param config 어댑터 설정
   * @param restoreContext 복원 컨텍스트 (재생성 시 주입)
   */
  create(
    setId: string,
    config: AdapterConfig,
    restoreContext?: SessionRestoreContext
  ): Promise<IClaudeAdapter>

  /**
   * 기존 세션을 복원한다.
   *
   * 복원 우선순위:
   * 1. 어댑터 인스턴스가 메모리에 살아있음 → 그대로 반환
   * 2. tmux 세션이 살아있음 (Channel) → 재연결
   * 3. 세션이 없음 → 새로 생성 + 컨텍스트 주입
   *
   * @param setId 복원할 Set ID
   */
  restore(setId: string): Promise<IClaudeAdapter>

  /**
   * 세션을 종료하고 Firestore 상태를 업데이트한다.
   *
   * @param setId 종료할 Set ID
   * @param reason 종료 이유 (로그용)
   */
  destroy(setId: string, reason?: string): Promise<void>

  /**
   * 현재 활성 세션 목록을 반환한다.
   *
   * @param projectId 특정 프로젝트로 필터링 (없으면 전체)
   */
  list(projectId?: string): SessionInfo[]

  /**
   * 세션 상태를 조회한다.
   *
   * @param setId 조회할 Set ID
   */
  getSession(setId: string): SessionInfo | undefined

  /**
   * PM 부재 정책에 따라 세션을 자동 관리한다.
   *
   * - 30분 이내 부재: 세션 유지
   * - 30분~2시간 부재: 신규 작업 중단, 현재 작업만 마무리
   * - 2시간 초과 부재: 스냅샷 저장 후 세션 종료
   */
  applyAbsencePolicy(projectId: string, absentSinceMs: number): Promise<void>
}
```

### 3.3 IContextBuilder

Claude에게 전달할 시스템 프롬프트와 대화 히스토리를 구성한다.

```typescript
// packages/server/src/adapters/IContextBuilder.ts

/**
 * 시스템 프롬프트 생성 옵션
 */
export interface SystemPromptOptions {
  /** Set 역할 설명 */
  role: string
  /** Set 이름 (예: "백엔드팀") */
  setName: string
  /** 프로젝트 이름 */
  projectName: string
  /** 프로젝트 기술 스택 */
  techStack?: string
  /** Git 브랜치명 */
  branch: string
  /** worktree 경로 */
  worktreePath: string
  /** 복원 시 주입할 프로젝트 상태 요약 */
  restoreContext?: SessionRestoreContext
}

/**
 * 대화 히스토리 항목
 */
export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  /** 토큰 수 (알고 있을 경우) */
  tokenCount?: number
}

/**
 * 컨텍스트 빌드 결과
 */
export interface BuiltContext {
  /** 최종 시스템 프롬프트 */
  systemPrompt: string
  /** Claude에게 전달할 대화 히스토리 */
  messages: ConversationMessage[]
  /** 현재 컨텍스트의 예상 토큰 수 */
  estimatedTokens: number
  /** 트리밍 여부 (토큰 초과로 일부 메시지 제거됨) */
  wasTrimmed: boolean
}

/**
 * 프로젝트 상태 스냅샷 (Firestore 저장 구조와 동일)
 */
export interface ProjectSnapshot {
  createdAt: Date
  trigger: 'pr_merged' | 'task_done' | 'manual' | 'scheduled' | 'session_end' | 'pm_away'
  summary: string
  completedTasks: string[]
  inProgressTasks: Array<{
    task: string
    set: string
    progress: string
  }>
  decisions: string[]
  gitState: {
    mainCommits: number
    openPRs: string[]
    branches: Record<string, string>
  }
  recentMessageIds: string[]
}

/**
 * 토큰 예산 설정
 */
export interface TokenBudget {
  /** 컨텍스트 윈도우 총 크기 (기본: 200_000) */
  contextWindowSize: number
  /** 시스템 프롬프트에 할당할 최대 토큰 */
  maxSystemPromptTokens: number
  /** 대화 히스토리에 할당할 최대 토큰 */
  maxHistoryTokens: number
  /** 응답을 위해 예약할 토큰 (출력 예산) */
  reservedForOutput: number
}

/**
 * 컨텍스트 빌더 인터페이스.
 *
 * 각 Set 리더에게 맞는 시스템 프롬프트와 대화 히스토리를 구성한다.
 * 토큰 예산 내에서 최대한 많은 컨텍스트를 유지한다.
 */
export interface IContextBuilder {
  /**
   * Set 리더의 시스템 프롬프트를 생성한다.
   *
   * 포함 내용:
   * - 역할 정의 (리더 역할 + 팀 구성)
   * - 프로젝트 맥락 (이름, 기술 스택, 목표)
   * - 작업 환경 (worktree 경로, 브랜치)
   * - 행동 지침 (Council Room 예절, 보고 형식)
   * - 복원 시: 이전 상태 요약 + 중요 결정사항
   *
   * @param options 시스템 프롬프트 옵션
   */
  buildSystemPrompt(options: SystemPromptOptions): string

  /**
   * 대화 히스토리를 토큰 예산 내로 구성한다.
   *
   * 전략:
   * 1. 전체 히스토리 토큰 수 계산
   * 2. 예산 초과 시: 오래된 메시지부터 제거
   * 3. 단, 스냅샷 이전 메시지는 스냅샷 요약으로 대체
   * 4. 최근 N개 메시지는 항상 유지
   *
   * @param messages 전체 대화 히스토리 (시간순)
   * @param budget 토큰 예산
   */
  buildConversationHistory(
    messages: ConversationMessage[],
    budget?: Partial<TokenBudget>
  ): ConversationMessage[]

  /**
   * 시스템 프롬프트 + 대화 히스토리를 합쳐서 최종 컨텍스트를 반환한다.
   *
   * @param options 시스템 프롬프트 옵션
   * @param messages 전체 대화 히스토리
   * @param budget 토큰 예산
   */
  buildSnapshot(
    options: SystemPromptOptions,
    messages: ConversationMessage[],
    budget?: Partial<TokenBudget>
  ): BuiltContext

  /**
   * 텍스트의 예상 토큰 수를 반환한다.
   *
   * 실제 API 호출 없이 로컬에서 근사값 계산 (tiktoken 또는 단순 추정).
   */
  estimateTokens(text: string): number
}
```

---

## 4. CLI 어댑터 구현 상세

### 4.1 claude CLI 옵션 매핑

Phase 1에서는 `claude` CLI 바이너리를 Node.js `child_process.spawn`으로 실행한다.

```
Council Server                           claude CLI
─────────────────                        ──────────────────
send(message, options)
  │
  ├── 시스템 프롬프트 → --system-prompt "<text>"
  ├── 메시지            → --message "<text>"
  ├── 모델 지정         → --model claude-opus-4-5
  ├── 최대 토큰         → --max-tokens 8192
  ├── 출력 형식         → --output-format json
  ├── 스트리밍          → --stream
  └── 작업 디렉토리     → cwd 옵션 (spawn 옵션)

환경변수:
  ANTHROPIC_API_KEY=<apiKey>
  CLAUDE_MAX_TURNS=1         (단일 응답, 대화 루프 없음)
```

**실제 실행 명령어 예시:**

```bash
ANTHROPIC_API_KEY=sk-ant-xxx claude \
  --model claude-opus-4-5 \
  --system-prompt "당신은 백엔드팀 리더입니다..." \
  --message "채팅 API 구현 상황을 보고해주세요." \
  --max-tokens 8192 \
  --output-format json \
  --stream
```

### 4.2 Subprocess Lifecycle

```
create()                         terminate()
   │                                 │
   ▼                                 ▼
spawn()                          process.kill('SIGTERM')
   │                                 │
   ├── stdout (JSON 스트림)            ├── 5초 대기
   ├── stderr (에러/경고)              └── 여전히 살아있으면 SIGKILL
   └── close (프로세스 종료)

상태 전이:
  idle → sending → streaming → idle  (정상)
  idle → sending → error             (에러)
  * → terminated                     (terminate() 호출)
```

### 4.3 CLI 어댑터 구현 스켈레톤

```typescript
// packages/server/src/adapters/ClaudeCliAdapter.ts

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type {
  IClaudeAdapter,
  AdapterConfig,
  AdapterResponse,
  AdapterStatus,
  SendOptions,
  AdapterStreamEvents,
} from './IClaudeAdapter'
import { AdapterError, AdapterErrorCode } from './AdapterError'

export class ClaudeCliAdapter extends EventEmitter implements IClaudeAdapter {
  private readonly config: Required<AdapterConfig>
  private process: ChildProcess | null = null
  private status: AdapterStatus = { state: 'idle' }
  private sessionId: string

  constructor(config: AdapterConfig) {
    super()
    this.sessionId = `cli-${Date.now()}-${Math.random().toString(36).slice(2)}`
    this.config = {
      model: 'claude-opus-4-5',
      timeoutMs: 120_000,
      maxRetries: 3,
      retryDelayMs: 5_000,
      ...config,
    }
  }

  async send(message: string, options?: SendOptions): Promise<AdapterResponse> {
    if (this.status.state === 'terminated') {
      throw new AdapterError(
        AdapterErrorCode.SESSION_DEAD,
        '세션이 이미 종료되었습니다. restore()로 재생성하세요.'
      )
    }

    if (this.status.state === 'sending' || this.status.state === 'streaming') {
      throw new AdapterError(
        AdapterErrorCode.CONCURRENT_SEND,
        '이미 응답 대기 중입니다. 이전 send()가 완료될 때까지 기다리세요.'
      )
    }

    const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs
    const startedAt = new Date()
    this.status = { state: 'sending', startedAt }

    return this.executeWithRetry(
      () => this.spawnAndCollect(message, options, startedAt),
      timeoutMs
    )
  }

  getStatus(): AdapterStatus {
    return this.status
  }

  async terminate(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.process?.kill('SIGKILL')
          resolve()
        }, 5_000)

        this.process!.on('close', () => {
          clearTimeout(timer)
          resolve()
        })
      })
      this.process = null
    }
    this.status = { state: 'terminated' }
    this.removeAllListeners()
  }

  // ── 내부 구현 ─────────────────────────────────────────

  private async spawnAndCollect(
    message: string,
    options: SendOptions | undefined,
    startedAt: Date
  ): Promise<AdapterResponse> {
    const args = this.buildCliArgs(message, options)
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: this.config.apiKey,
      CLAUDE_MAX_TURNS: '1',
    }

    this.process = spawn('claude', args, {
      cwd: this.config.workingDirectory,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    this.status = { state: 'streaming', startedAt }
    this.emit('thinking')

    return new Promise<AdapterResponse>((resolve, reject) => {
      let rawOutput = ''
      let stderrOutput = ''

      this.process!.stdout!.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        rawOutput += text
        this.handleStreamChunk(text)
      })

      this.process!.stderr!.on('data', (chunk: Buffer) => {
        stderrOutput += chunk.toString('utf8')
      })

      this.process!.on('close', (code) => {
        this.process = null

        if (code !== 0) {
          const error = this.parseStderrError(stderrOutput, code)
          this.status = { state: 'error', error }
          this.emit('error', error)
          reject(error)
          return
        }

        try {
          const response = this.parseJsonResponse(rawOutput, startedAt)
          this.status = { state: 'idle' }
          this.emit('done', response)
          resolve(response)
        } catch (parseError) {
          const error = new AdapterError(
            AdapterErrorCode.PARSE_ERROR,
            `CLI 응답 파싱 실패: ${parseError}`,
            { raw: rawOutput }
          )
          this.status = { state: 'error', error }
          this.emit('error', error)
          reject(error)
        }
      })

      this.process!.on('error', (err) => {
        const error = new AdapterError(
          AdapterErrorCode.SPAWN_FAILED,
          `claude CLI 실행 실패: ${err.message}`,
          { cause: err }
        )
        this.status = { state: 'error', error }
        this.emit('error', error)
        reject(error)
      })
    })
  }

  /**
   * claude CLI 인수 배열 구성
   */
  private buildCliArgs(message: string, options?: SendOptions): string[] {
    const args: string[] = [
      '--model', this.config.model,
      '--message', message,
      '--max-tokens', '8192',
      '--output-format', 'json',
    ]

    // 시스템 프롬프트 주입 (systemSuffix 또는 config에 설정된 경우)
    const systemPrompt = options?.systemSuffix ?? (this.config as any).systemPrompt
    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt)
    }

    if (options?.stream !== false) {
      args.push('--stream')
    }

    return args
  }

  /**
   * stdout 스트림 청크 처리.
   *
   * --output-format json --stream 의 출력 형식:
   *
   * {"type":"content_block_delta","delta":{"type":"text_delta","text":"안"}}
   * {"type":"content_block_delta","delta":{"type":"text_delta","text":"녕"}}
   * {"type":"message_stop","usage":{"input_tokens":123,"output_tokens":45}}
   *
   * 각 줄이 독립적인 JSON 이벤트다.
   */
  private handleStreamChunk(rawText: string): void {
    const lines = rawText.split('\n').filter((l) => l.trim())

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as CliStreamEvent

        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          this.emit('chunk', event.delta.text)
        }
        // message_stop, message_delta 등은 parseJsonResponse에서 최종 처리
      } catch {
        // 파싱 불가 줄은 무시 (부분 청크일 수 있음)
      }
    }
  }

  /**
   * 완료된 전체 출력에서 최종 AdapterResponse 구성
   */
  private parseJsonResponse(rawOutput: string, startedAt: Date): AdapterResponse {
    const lines = rawOutput.split('\n').filter((l) => l.trim())

    let content = ''
    let inputTokens = 0
    let outputTokens = 0
    let stopReason: AdapterResponse['stopReason'] = 'end_turn'

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as CliStreamEvent

        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          content += event.delta.text
        }

        if (event.type === 'message_delta' && event.usage) {
          outputTokens = event.usage.output_tokens ?? 0
          stopReason = (event.delta?.stop_reason ?? 'end_turn') as AdapterResponse['stopReason']
        }

        if (event.type === 'message_start' && event.message?.usage) {
          inputTokens = event.message.usage.input_tokens ?? 0
        }
      } catch {
        // 파싱 불가 줄 무시
      }
    }

    if (!content) {
      throw new Error('응답에서 텍스트 콘텐츠를 추출할 수 없습니다.')
    }

    return {
      content,
      usage: { inputTokens, outputTokens },
      stopReason,
      sessionId: this.sessionId,
      durationMs: Date.now() - startedAt.getTime(),
    }
  }

  /**
   * stderr 내용에서 구조화된 에러 생성
   */
  private parseStderrError(stderr: string, exitCode: number | null): AdapterError {
    // Rate Limit 패턴
    if (stderr.includes('rate_limit_error') || stderr.includes('429')) {
      return new AdapterError(
        AdapterErrorCode.RATE_LIMIT,
        'Anthropic API Rate Limit 초과. 잠시 후 재시도합니다.',
        { exitCode, stderr }
      )
    }

    // 인증 에러
    if (stderr.includes('authentication_error') || stderr.includes('401')) {
      return new AdapterError(
        AdapterErrorCode.AUTH_ERROR,
        'API 키가 유효하지 않습니다.',
        { exitCode, stderr }
      )
    }

    // 컨텍스트 초과
    if (stderr.includes('context_length_exceeded') || stderr.includes('too long')) {
      return new AdapterError(
        AdapterErrorCode.CONTEXT_TOO_LONG,
        '컨텍스트 길이가 초과되었습니다. ContextBuilder로 히스토리를 줄이세요.',
        { exitCode, stderr }
      )
    }

    // 일반 에러
    return new AdapterError(
      AdapterErrorCode.UNKNOWN,
      `claude CLI가 비정상 종료되었습니다. (code=${exitCode})`,
      { exitCode, stderr }
    )
  }

  /**
   * Rate Limit 재시도 로직이 포함된 실행 래퍼
   */
  private async executeWithRetry(
    fn: () => Promise<AdapterResponse>,
    timeoutMs: number
  ): Promise<AdapterResponse> {
    let lastError: AdapterError | undefined

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await Promise.race([
          fn(),
          this.createTimeoutPromise(timeoutMs),
        ])
      } catch (err) {
        if (err instanceof AdapterError) {
          lastError = err

          // Rate Limit이면 재시도
          if (err.code === AdapterErrorCode.RATE_LIMIT && attempt < this.config.maxRetries) {
            const delay = this.config.retryDelayMs * Math.pow(2, attempt) // 지수 백오프
            await sleep(delay)
            this.status = { state: 'sending', startedAt: new Date() }
            continue
          }

          // 그 외 에러는 즉시 throw
          throw err
        }
        throw err
      }
    }

    throw lastError!
  }

  private createTimeoutPromise(timeoutMs: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        // 실행 중인 subprocess 강제 종료
        if (this.process) {
          this.process.kill('SIGTERM')
          this.process = null
        }

        reject(
          new AdapterError(
            AdapterErrorCode.TIMEOUT,
            `응답 대기 시간 초과 (${timeoutMs}ms). 세션을 재생성합니다.`
          )
        )
      }, timeoutMs)
    })
  }
}

// ── 내부 타입 (CLI 스트림 이벤트 구조) ────────────────────

interface CliStreamEvent {
  type: string
  delta?: {
    type?: string
    text?: string
    stop_reason?: string
  }
  message?: {
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  usage?: {
    input_tokens?: number
    output_tokens?: number
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
```

### 4.4 JSON 응답 구조

`claude --output-format json --stream` 실행 시 stdout에 출력되는 이벤트 스트림:

```jsonc
// 메시지 시작 (입력 토큰 포함)
{"type":"message_start","message":{"id":"msg_xxx","role":"assistant","usage":{"input_tokens":523,"output_tokens":1}}}

// 콘텐츠 블록 시작
{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

// 텍스트 청크 (여러 번 수신)
{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"채팅 API 구현 상황을 "}}
{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"보고드립니다."}}

// 콘텐츠 블록 완료
{"type":"content_block_stop","index":0}

// 메시지 델타 (출력 토큰 + 종료 이유)
{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":247}}

// 메시지 완료
{"type":"message_stop"}
```

---

## 5. Channel 어댑터 구현 상세 (Phase 2)

### 5.1 설계 개요

Phase 2에서는 커스텀 MCP Channel 서버를 구현하여 Claude Code 세션을 장기 유지한다. CLI 어댑터와 달리 매 요청마다 subprocess를 생성하지 않고, 하나의 세션을 계속 재사용한다.

```
Council Server
     │
     │  Channel Protocol (JSON-RPC over stdio/TCP)
     ▼
MCP Channel Server (Node.js)
     │
     │  MCP SDK
     ▼
Claude Code Session (장기 실행)
     │
     ├── Council Room 메시지 수신 → 리더 응답 생성
     ├── Agent Teams (Set 내부 팀원 관리)
     └── Tool 사용 (파일 편집, 명령 실행 등)
```

### 5.2 MCP Server 초기화

```typescript
// packages/server/src/adapters/ClaudeChannelAdapter.ts

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { EventEmitter } from 'node:events'
import type {
  IClaudeAdapter,
  AdapterConfig,
  AdapterResponse,
  AdapterStatus,
  SendOptions,
} from './IClaudeAdapter'
import { AdapterError, AdapterErrorCode } from './AdapterError'

/**
 * Channel 어댑터 구현 (Phase 2 — MCP Channel Protocol 기반).
 *
 * CLI 어댑터와 동일한 IClaudeAdapter 인터페이스를 구현한다.
 * 내부적으로 MCP 서버를 유지하며 세션을 장기 실행한다.
 */
export class ClaudeChannelAdapter extends EventEmitter implements IClaudeAdapter {
  private readonly config: Required<AdapterConfig>
  private mcpServer: Server | null = null
  private transport: StdioServerTransport | null = null
  private status: AdapterStatus = { state: 'idle' }
  private sessionId: string

  // 응답 대기 중인 Promise resolver (단일 인플라이트 요청)
  private pendingResolver: {
    resolve: (response: AdapterResponse) => void
    reject: (error: AdapterError) => void
  } | null = null

  constructor(config: AdapterConfig) {
    super()
    this.sessionId = `channel-${Date.now()}-${Math.random().toString(36).slice(2)}`
    this.config = {
      model: 'claude-opus-4-5',
      timeoutMs: 300_000, // Channel은 더 긴 타임아웃 (장기 작업)
      maxRetries: 3,
      retryDelayMs: 5_000,
      ...config,
    }
  }

  /**
   * MCP 서버를 초기화하고 Claude Code 세션을 시작한다.
   * create()는 SessionManager에서 호출된다. (생성자에서 호출하지 않음)
   */
  async initialize(): Promise<void> {
    this.mcpServer = new Server(
      {
        name: `agent-council-set-${this.sessionId}`,
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    )

    this.registerToolHandlers()
    this.registerNotificationHandlers()

    this.transport = new StdioServerTransport()
    await this.mcpServer.connect(this.transport)
  }

  async send(message: string, options?: SendOptions): Promise<AdapterResponse> {
    if (this.status.state === 'terminated') {
      throw new AdapterError(AdapterErrorCode.SESSION_DEAD, '세션이 종료되었습니다.')
    }

    if (!this.mcpServer) {
      throw new AdapterError(AdapterErrorCode.SESSION_DEAD, 'MCP 서버가 초기화되지 않았습니다.')
    }

    const startedAt = new Date()
    this.status = { state: 'sending', startedAt }
    this.emit('thinking')

    return new Promise<AdapterResponse>((resolve, reject) => {
      const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs

      const timer = setTimeout(() => {
        this.pendingResolver = null
        reject(new AdapterError(AdapterErrorCode.TIMEOUT, `응답 타임아웃 (${timeoutMs}ms)`))
      }, timeoutMs)

      this.pendingResolver = {
        resolve: (response) => {
          clearTimeout(timer)
          resolve({ ...response, sessionId: this.sessionId })
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      }

      // MCP를 통해 메시지 전송 (구체 구현은 Channel API 스펙에 따름)
      this.sendViaMcp(message, options).catch((err) => {
        clearTimeout(timer)
        this.pendingResolver = null
        reject(err)
      })
    })
  }

  getStatus(): AdapterStatus {
    return this.status
  }

  async terminate(): Promise<void> {
    if (this.mcpServer) {
      await this.mcpServer.close()
      this.mcpServer = null
      this.transport = null
    }
    this.status = { state: 'terminated' }
    this.removeAllListeners()
  }

  // ── MCP 핸들러 등록 ────────────────────────────────────

  /**
   * Claude Code가 사용할 수 있는 Tool 핸들러를 등록한다.
   *
   * Council Server가 노출하는 Tool 목록:
   * - council_send_message: Council Room에 메시지 전송
   * - council_update_task: 태스크 상태 업데이트
   * - council_get_project_state: 프로젝트 현재 상태 조회
   * - council_escalate: 이슈를 Council Room으로 에스컬레이션
   */
  private registerToolHandlers(): void {
    if (!this.mcpServer) return

    // 예시: council_send_message 툴
    this.mcpServer.setRequestHandler(
      { method: 'tools/call' } as any,
      async (request: any) => {
        const { name, arguments: args } = request.params

        switch (name) {
          case 'council_send_message':
            return this.handleSendMessageTool(args)
          case 'council_update_task':
            return this.handleUpdateTaskTool(args)
          case 'council_get_project_state':
            return this.handleGetProjectStateTool()
          case 'council_escalate':
            return this.handleEscalateTool(args)
          default:
            throw new Error(`알 수 없는 툴: ${name}`)
        }
      }
    )
  }

  /**
   * Claude Code로부터 오는 Notification 핸들러.
   *
   * 주요 알림:
   * - text_delta: 스트리밍 텍스트 청크
   * - message_complete: 응답 완료 (최종 토큰 사용량 포함)
   * - tool_use: 도구 사용 시작
   * - error: 세션 내부 에러
   */
  private registerNotificationHandlers(): void {
    if (!this.mcpServer) return

    this.mcpServer.setNotificationHandler(
      { method: 'notifications/message' } as any,
      (notification: any) => {
        const { type, data } = notification.params

        switch (type) {
          case 'text_delta':
            this.status = { state: 'streaming', startedAt: new Date() }
            this.emit('chunk', data.text as string)
            break

          case 'message_complete':
            if (this.pendingResolver) {
              const response: AdapterResponse = {
                content: data.content as string,
                usage: {
                  inputTokens: data.usage?.input_tokens ?? 0,
                  outputTokens: data.usage?.output_tokens ?? 0,
                },
                stopReason: data.stop_reason ?? 'end_turn',
                sessionId: this.sessionId,
                durationMs: data.duration_ms ?? 0,
              }
              this.status = { state: 'idle' }
              this.emit('done', response)
              this.pendingResolver.resolve(response)
              this.pendingResolver = null
            }
            break

          case 'error':
            {
              const error = new AdapterError(
                AdapterErrorCode.SESSION_ERROR,
                data.message as string,
                data
              )
              this.status = { state: 'error', error }
              this.emit('error', error)
              if (this.pendingResolver) {
                this.pendingResolver.reject(error)
                this.pendingResolver = null
              }
            }
            break
        }
      }
    )
  }

  // ── Tool 핸들러 구현 ────────────────────────────────────

  private async handleSendMessageTool(args: Record<string, unknown>) {
    // Council Room 메시지 전송 → Firestore에 저장
    // 실제 구현은 FirestoreService를 주입받아 처리
    return { content: [{ type: 'text', text: '메시지가 전송되었습니다.' }] }
  }

  private async handleUpdateTaskTool(args: Record<string, unknown>) {
    // 태스크 상태 업데이트 → Firestore tasks/{taskId} 업데이트
    return { content: [{ type: 'text', text: '태스크 상태가 업데이트되었습니다.' }] }
  }

  private async handleGetProjectStateTool() {
    // 프로젝트 현재 상태 반환 (최신 스냅샷)
    return { content: [{ type: 'text', text: JSON.stringify({ status: 'ok' }) }] }
  }

  private async handleEscalateTool(args: Record<string, unknown>) {
    // Council Room으로 이슈 에스컬레이션
    return { content: [{ type: 'text', text: '이슈가 에스컬레이션되었습니다.' }] }
  }

  private async sendViaMcp(message: string, options?: SendOptions): Promise<void> {
    // MCP Channel을 통해 Claude Code 세션에 메시지 전달
    // 구체 구현은 Channel API 정식 스펙 발표 후 확정
    // 현재는 플레이스홀더
    throw new Error('Channel 어댑터 sendViaMcp는 Phase 2에서 구현됩니다.')
  }
}
```

### 5.3 세션 유지 전략 (tmux)

```
Council Server 시작
     │
     ├── Set A → tmux new-session -s "council-{projectId}-{setId-a}" -d
     │            ├── worktree: /opt/agent-council/workspace/{projectId}/{setId-a}
     │            └── claude code 실행 (MCP Channel 모드)
     │
     ├── Set B → tmux new-session -s "council-{projectId}-{setId-b}" -d
     │            └── worktree: /opt/agent-council/workspace/{projectId}/{setId-b}
     │
     └── Set C → tmux new-session -s "council-{projectId}-{setId-c}" -d
                  └── worktree: /opt/agent-council/workspace/{projectId}/{setId-c}

Council Server 재시작 (배포, 크래시 등)
     │
     └── 기존 tmux 세션 확인 (tmux ls | grep "council-{projectId}")
           ├── 살아있음 → 재연결 (attach)
           └── 없음     → 새 세션 생성 + 컨텍스트 주입
```

---

## 6. 컨텍스트 빌더 상세

### 6.1 리더별 시스템 프롬프트 템플릿

```typescript
// packages/server/src/adapters/ContextBuilder.ts

import type {
  IContextBuilder,
  SystemPromptOptions,
  ConversationMessage,
  BuiltContext,
  TokenBudget,
  ProjectSnapshot,
} from './IContextBuilder'

/**
 * 기본 토큰 예산 설정
 */
const DEFAULT_TOKEN_BUDGET: TokenBudget = {
  contextWindowSize: 200_000,
  maxSystemPromptTokens: 8_000,
  maxHistoryTokens: 60_000,
  reservedForOutput: 16_000,
}

/**
 * 최근 N개 메시지는 토큰 예산과 무관하게 항상 포함
 */
const MIN_RECENT_MESSAGES = 10

export class ContextBuilder implements IContextBuilder {
  buildSystemPrompt(options: SystemPromptOptions): string {
    const sections: string[] = []

    // 1. 역할 정의
    sections.push(this.buildRoleSection(options))

    // 2. 프로젝트 맥락
    sections.push(this.buildProjectSection(options))

    // 3. 작업 환경
    sections.push(this.buildEnvironmentSection(options))

    // 4. 행동 지침
    sections.push(this.buildBehaviorSection())

    // 5. 복원 시: 이전 상태 요약 (있을 경우)
    if (options.restoreContext) {
      sections.push(this.buildRestoreSection(options.restoreContext))
    }

    return sections.filter(Boolean).join('\n\n---\n\n')
  }

  buildConversationHistory(
    messages: ConversationMessage[],
    budget?: Partial<TokenBudget>
  ): ConversationMessage[] {
    const resolved: TokenBudget = { ...DEFAULT_TOKEN_BUDGET, ...budget }
    const maxTokens = resolved.maxHistoryTokens

    // 최근 메시지부터 토큰 계산 (역순)
    const result: ConversationMessage[] = []
    let tokenSum = 0

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      const tokens = msg.tokenCount ?? this.estimateTokens(msg.content)

      // 최근 N개는 무조건 포함
      if (messages.length - i <= MIN_RECENT_MESSAGES) {
        result.unshift(msg)
        tokenSum += tokens
        continue
      }

      // 예산 내에서 추가
      if (tokenSum + tokens <= maxTokens) {
        result.unshift(msg)
        tokenSum += tokens
      } else {
        // 예산 초과 → 여기서 중단
        break
      }
    }

    return result
  }

  buildSnapshot(
    options: SystemPromptOptions,
    messages: ConversationMessage[],
    budget?: Partial<TokenBudget>
  ): BuiltContext {
    const systemPrompt = this.buildSystemPrompt(options)
    const trimmedMessages = this.buildConversationHistory(messages, budget)

    const systemTokens = this.estimateTokens(systemPrompt)
    const historyTokens = trimmedMessages.reduce(
      (sum, m) => sum + (m.tokenCount ?? this.estimateTokens(m.content)),
      0
    )

    return {
      systemPrompt,
      messages: trimmedMessages,
      estimatedTokens: systemTokens + historyTokens,
      wasTrimmed: trimmedMessages.length < messages.length,
    }
  }

  estimateTokens(text: string): number {
    // 근사 추정: 한국어 포함 시 문자당 ~0.7 토큰, 영어는 ~0.25 토큰
    // 실제 정밀도는 낮지만 예산 관리 용도로 충분
    const koreanChars = (text.match(/[\uAC00-\uD7A3]/g) ?? []).length
    const otherChars = text.length - koreanChars
    return Math.ceil(koreanChars * 0.7 + otherChars * 0.25)
  }

  // ── 프롬프트 섹션 빌더 ──────────────────────────────────

  private buildRoleSection(options: SystemPromptOptions): string {
    return `# 역할

당신은 **${options.setName}의 리더**입니다.

${options.role}

## 위치
당신은 Agent Council 시스템의 Council Room에 참여하는 AI 리더입니다.
다른 팀의 리더들과 협력하여 소프트웨어 개발 프로젝트를 진행합니다.`
  }

  private buildProjectSection(options: SystemPromptOptions): string {
    const lines = [
      `# 프로젝트`,
      ``,
      `- **프로젝트명**: ${options.projectName}`,
    ]

    if (options.techStack) {
      lines.push(`- **기술 스택**: ${options.techStack}`)
    }

    return lines.join('\n')
  }

  private buildEnvironmentSection(options: SystemPromptOptions): string {
    return `# 작업 환경

- **담당 브랜치**: \`${options.branch}\`
- **작업 디렉토리**: \`${options.worktreePath}\`

코드 작업은 반드시 위 디렉토리 내에서만 수행하세요.
다른 팀의 worktree(\`set-*/\`)에는 접근하지 마세요.`
  }

  private buildBehaviorSection(): string {
    return `# 행동 지침

## Council Room 규칙
1. **간결하게 보고하세요.** 긴 코드 블록보다 요약을 우선하세요.
2. **의사결정이 필요할 때만 말하세요.** 내부 작업 진행은 보고하지 않아도 됩니다.
3. **다른 팀과 충돌 시 먼저 제안하고 합의를 구하세요.**
4. **PM의 지시는 최우선으로 처리하세요.**

## 보고 형식
작업 완료 보고 시:
- 무엇을 완료했는지 (한 줄 요약)
- 생성/수정한 주요 파일 목록 (있을 경우)
- 다음 단계 또는 다른 팀에게 필요한 것

## 도구 사용
- 코드 작성: \`claude\` 내장 도구 사용
- Council Room 메시지 전송: \`council_send_message\` 도구
- 태스크 상태 갱신: \`council_update_task\` 도구
- 이슈 에스컬레이션: \`council_escalate\` 도구`
  }

  private buildRestoreSection(context: import('./ISessionManager').SessionRestoreContext): string {
    const lines = [`# 이전 작업 상태 (세션 복원)`]

    if (context.latestSnapshot) {
      const snap = context.latestSnapshot
      lines.push(``, `## 프로젝트 요약`, snap.summary)

      if (snap.completedTasks.length > 0) {
        lines.push(``, `## 완료된 작업`)
        snap.completedTasks.forEach((t) => lines.push(`- ${t}`))
      }

      if (snap.inProgressTasks.length > 0) {
        lines.push(``, `## 진행 중인 작업`)
        snap.inProgressTasks.forEach((t) =>
          lines.push(`- ${t.task} (${t.set}, ${t.progress})`)
        )
      }

      if (snap.decisions.length > 0) {
        lines.push(``, `## 주요 결정사항`)
        snap.decisions.forEach((d) => lines.push(`- ${d}`))
      }

      if (snap.gitState) {
        lines.push(
          ``,
          `## Git 상태`,
          `- main 커밋 수: ${snap.gitState.mainCommits}`,
          `- 열린 PR: ${snap.gitState.openPRs.join(', ') || '없음'}`
        )
      }
    }

    lines.push(
      ``,
      `## 최근 대화`,
      `아래 대화 히스토리를 참고하여 이전 맥락을 파악하고 작업을 이어나가세요.`
    )

    return lines.join('\n')
  }
}
```

### 6.2 토큰 예산 관리 전략

```
컨텍스트 윈도우 (200,000 토큰)
┌────────────────────────────────────────────────────────┐
│  시스템 프롬프트                           최대 8,000   │
│  ├── 역할 정의: ~500                                   │
│  ├── 프로젝트 맥락: ~300                               │
│  ├── 작업 환경: ~200                                   │
│  ├── 행동 지침: ~500                                   │
│  └── 복원 컨텍스트 (있을 시): ~2,000~6,000            │
├────────────────────────────────────────────────────────┤
│  대화 히스토리                            최대 60,000  │
│  ├── 오래된 메시지 (스냅샷으로 대체 가능)               │
│  ├── 중간 메시지                                       │
│  └── 최근 10개 메시지 (항상 보존)                      │
├────────────────────────────────────────────────────────┤
│  예약 공간 (출력)                         16,000       │
├────────────────────────────────────────────────────────┤
│  여유 버퍼                                나머지       │
└────────────────────────────────────────────────────────┘

트리밍 우선순위 (토큰 초과 시):
1. 오래된 메시지 제거 (스냅샷 이전)
2. 스냅샷으로 오래된 구간 요약 대체
3. 복원 컨텍스트에서 덜 중요한 항목 제거
4. 최근 10개 메시지는 절대 제거하지 않음
```

---

## 7. 에러 처리

### 7.1 에러 타입 정의

```typescript
// packages/server/src/adapters/AdapterError.ts

export enum AdapterErrorCode {
  // 타임아웃
  TIMEOUT = 'TIMEOUT',

  // API 에러
  RATE_LIMIT = 'RATE_LIMIT',
  AUTH_ERROR = 'AUTH_ERROR',
  CONTEXT_TOO_LONG = 'CONTEXT_TOO_LONG',

  // 세션 에러
  SESSION_DEAD = 'SESSION_DEAD',
  SESSION_ERROR = 'SESSION_ERROR',
  CONCURRENT_SEND = 'CONCURRENT_SEND',

  // CLI 에러
  SPAWN_FAILED = 'SPAWN_FAILED',
  PARSE_ERROR = 'PARSE_ERROR',

  // 기타
  UNKNOWN = 'UNKNOWN',
}

export class AdapterError extends Error {
  readonly code: AdapterErrorCode
  readonly context?: Record<string, unknown>

  constructor(
    code: AdapterErrorCode,
    message: string,
    context?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'AdapterError'
    this.code = code
    this.context = context
  }

  /**
   * 재시도 가능한 에러인지 여부
   */
  isRetryable(): boolean {
    return [
      AdapterErrorCode.RATE_LIMIT,
      AdapterErrorCode.TIMEOUT,
    ].includes(this.code)
  }

  /**
   * 세션 재생성이 필요한 에러인지 여부
   */
  requiresSessionRestart(): boolean {
    return [
      AdapterErrorCode.SESSION_DEAD,
      AdapterErrorCode.SESSION_ERROR,
      AdapterErrorCode.SPAWN_FAILED,
    ].includes(this.code)
  }
}
```

### 7.2 에러별 처리 전략

```
에러 발생
  │
  ├── TIMEOUT
  │   ├── 재시도 가능: YES (최대 3회, 지수 백오프)
  │   ├── 세션 재생성: 타임아웃이 반복되면 YES
  │   └── Council Room 알림: "리더A가 응답하는 데 시간이 걸리고 있습니다..."
  │
  ├── RATE_LIMIT
  │   ├── 재시도 가능: YES (지수 백오프: 5s → 10s → 20s)
  │   ├── 세션 재생성: NO
  │   └── Council Room 알림: "API 한도 초과. 잠시 후 재시도합니다."
  │
  ├── AUTH_ERROR
  │   ├── 재시도 가능: NO
  │   ├── 세션 재생성: NO
  │   └── Council Room 알림: "API 키가 유효하지 않습니다. 설정을 확인하세요."
  │       → SetOrchestrator가 해당 Set을 일시 중지
  │
  ├── CONTEXT_TOO_LONG
  │   ├── 재시도 가능: YES (히스토리 줄인 후)
  │   ├── 세션 재생성: NO
  │   └── ContextBuilder.buildConversationHistory() 재호출 (더 공격적인 트리밍)
  │
  ├── SESSION_DEAD / SPAWN_FAILED
  │   ├── 재시도 가능: NO (즉시 재생성)
  │   ├── 세션 재생성: YES → SessionManager.restore()
  │   └── Council Room 알림: "리더A 세션이 재시작됩니다..."
  │
  └── UNKNOWN
      ├── 재시도 가능: NO
      ├── 세션 재생성: 상황에 따라
      └── 에러 로그 + Council Room 알림
```

### 7.3 에러 처리 통합 예시 (SetOrchestrator)

```typescript
// packages/server/src/sets/SetOrchestrator.ts (발췌)

import { AdapterError, AdapterErrorCode } from '../adapters/AdapterError'
import type { ISessionManager } from '../adapters/ISessionManager'

export class SetOrchestrator {
  constructor(
    private readonly sessionManager: ISessionManager,
    // ... 기타 의존성
  ) {}

  async sendToLeader(setId: string, message: string): Promise<string> {
    let adapter = await this.sessionManager.restore(setId)

    try {
      const response = await adapter.send(message)
      return response.content
    } catch (err) {
      if (!(err instanceof AdapterError)) throw err

      if (err.requiresSessionRestart()) {
        // 세션 재생성
        await this.sessionManager.destroy(setId, err.message)
        adapter = await this.sessionManager.restore(setId)
        // 재생성 후 1회 재시도
        const response = await adapter.send(message)
        return response.content
      }

      if (err.isRetryable()) {
        // 재시도는 어댑터 내부에서 이미 처리됨
        // 여기까지 왔다면 최대 재시도 초과
        throw err
      }

      throw err
    }
  }
}
```

---

## 8. 팩토리 패턴 (자동 선택)

### 8.1 팩토리 인터페이스

```typescript
// packages/server/src/adapters/AdapterFactory.ts

import type { IClaudeAdapter, AdapterConfig } from './IClaudeAdapter'
import { ClaudeCliAdapter } from './ClaudeCliAdapter'
import { ClaudeChannelAdapter } from './ClaudeChannelAdapter'

/**
 * 환경 설정
 */
export interface CouncilConfig {
  /**
   * 사용할 어댑터 타입.
   *
   * 'auto' (기본값): ADAPTER_TYPE 환경변수 참조,
   *   없으면 'cli' 선택
   */
  adapterType?: 'cli' | 'channel' | 'auto'

  /**
   * Claude 모델 ID.
   * 기본값: 'claude-opus-4-5'
   */
  defaultModel?: string

  /**
   * 글로벌 타임아웃 (ms).
   * CLI 기본값: 120_000
   * Channel 기본값: 300_000
   */
  timeoutMs?: number
}

/**
 * 어댑터 팩토리.
 *
 * 설정에 따라 ClaudeCliAdapter 또는 ClaudeChannelAdapter를 생성한다.
 * 비즈니스 로직은 반환된 IClaudeAdapter에만 의존한다.
 */
export class AdapterFactory {
  private static resolveType(config: CouncilConfig): 'cli' | 'channel' {
    const type = config.adapterType ?? 'auto'

    if (type === 'auto') {
      const envType = process.env['ADAPTER_TYPE'] as 'cli' | 'channel' | undefined
      return envType ?? 'cli'
    }

    return type
  }

  /**
   * 설정에 따라 적절한 어댑터를 생성한다.
   *
   * @param adapterConfig 어댑터별 설정 (API 키, 경로 등)
   * @param councilConfig 전역 Council 설정
   */
  static async create(
    adapterConfig: AdapterConfig,
    councilConfig: CouncilConfig = {}
  ): Promise<IClaudeAdapter> {
    const type = this.resolveType(councilConfig)

    switch (type) {
      case 'cli': {
        return new ClaudeCliAdapter({
          ...adapterConfig,
          model: adapterConfig.model ?? councilConfig.defaultModel ?? 'claude-opus-4-5',
          timeoutMs: adapterConfig.timeoutMs ?? councilConfig.timeoutMs ?? 120_000,
        })
      }

      case 'channel': {
        const adapter = new ClaudeChannelAdapter({
          ...adapterConfig,
          model: adapterConfig.model ?? councilConfig.defaultModel ?? 'claude-opus-4-5',
          timeoutMs: adapterConfig.timeoutMs ?? councilConfig.timeoutMs ?? 300_000,
        })
        // Channel 어댑터는 초기화 단계가 별도로 필요
        await adapter.initialize()
        return adapter
      }

      default:
        throw new Error(`알 수 없는 어댑터 타입: ${type}`)
    }
  }

  /**
   * 현재 환경에서 사용 가능한 어댑터 타입을 감지한다.
   *
   * - claude CLI 바이너리 존재 여부 확인
   * - MCP Channel 라이브러리 설치 여부 확인
   */
  static async detectAvailableAdapters(): Promise<{
    cli: boolean
    channel: boolean
  }> {
    const { execSync } = await import('node:child_process')

    let cliAvailable = false
    let channelAvailable = false

    try {
      execSync('claude --version', { stdio: 'ignore' })
      cliAvailable = true
    } catch {
      // claude CLI 없음
    }

    try {
      await import('@modelcontextprotocol/sdk/server/index.js')
      channelAvailable = true
    } catch {
      // MCP SDK 없음
    }

    return { cli: cliAvailable, channel: channelAvailable }
  }
}
```

### 8.2 설정 파일 예시

```typescript
// packages/server/src/config.ts

import type { CouncilConfig } from './adapters/AdapterFactory'

export const councilConfig: CouncilConfig = {
  // Phase 1: CLI 어댑터 사용
  // Phase 2로 전환 시 'channel'로 변경하거나 ADAPTER_TYPE=channel 환경변수 설정
  adapterType: (process.env['ADAPTER_TYPE'] as 'cli' | 'channel') ?? 'cli',

  defaultModel: process.env['CLAUDE_MODEL'] ?? 'claude-opus-4-5',

  timeoutMs: Number(process.env['ADAPTER_TIMEOUT_MS'] ?? 120_000),
}
```

### 8.3 SessionManager에서의 팩토리 사용

```typescript
// packages/server/src/adapters/SessionManager.ts

import { AdapterFactory } from './AdapterFactory'
import { ContextBuilder } from './ContextBuilder'
import type { ISessionManager, SessionInfo, SessionRestoreContext } from './ISessionManager'
import type { IClaudeAdapter, AdapterConfig } from './IClaudeAdapter'

export class SessionManager implements ISessionManager {
  // setId → adapter 인스턴스 맵
  private readonly sessions = new Map<string, {
    adapter: IClaudeAdapter
    info: SessionInfo
  }>()

  private readonly contextBuilder = new ContextBuilder()

  async create(
    setId: string,
    config: AdapterConfig,
    restoreContext?: SessionRestoreContext
  ): Promise<IClaudeAdapter> {
    // 이미 살아있는 세션이 있으면 반환
    const existing = this.sessions.get(setId)
    if (existing && existing.adapter.getStatus().state !== 'terminated') {
      return existing.adapter
    }

    // 복원 컨텍스트가 있으면 시스템 프롬프트에 주입
    let systemPromptSuffix: string | undefined
    if (restoreContext) {
      const builtContext = this.contextBuilder.buildSnapshot(
        {
          role: restoreContext.setMeta.role,
          setName: restoreContext.setMeta.name,
          projectName: restoreContext.projectMeta.name,
          techStack: restoreContext.projectMeta.techStack,
          branch: restoreContext.setMeta.branch,
          worktreePath: restoreContext.setMeta.worktreePath,
          restoreContext,
        },
        restoreContext.recentMessages
      )
      systemPromptSuffix = builtContext.systemPrompt
    }

    const adapter = await AdapterFactory.create(
      { ...config, workingDirectory: restoreContext?.setMeta.worktreePath ?? config.workingDirectory },
      { adapterType: 'auto' }
    )

    const info: SessionInfo = {
      sessionId: `session-${setId}-${Date.now()}`,
      setId,
      projectId: '', // 호출자가 채움
      createdAt: new Date(),
      lastActiveAt: new Date(),
      status: 'active',
      adapterType: process.env['ADAPTER_TYPE'] === 'channel' ? 'channel' : 'cli',
      totalTokensUsed: 0,
    }

    this.sessions.set(setId, { adapter, info })

    return adapter
  }

  async restore(setId: string): Promise<IClaudeAdapter> {
    const existing = this.sessions.get(setId)

    if (existing) {
      const { state } = existing.adapter.getStatus()
      if (state !== 'terminated') {
        return existing.adapter
      }
    }

    // 세션이 없거나 종료됨 → Firestore에서 복원 컨텍스트 로드 후 재생성
    // (실제 구현에서는 FirestoreService 주입 필요)
    const restoreContext = await this.loadRestoreContext(setId)

    // config는 Firestore에서 로드한 Set 메타 기반으로 구성
    const config: AdapterConfig = {
      apiKey: process.env['ANTHROPIC_API_KEY'] ?? '',
      workingDirectory: restoreContext.setMeta.worktreePath,
    }

    return this.create(setId, config, restoreContext)
  }

  async destroy(setId: string, reason?: string): Promise<void> {
    const existing = this.sessions.get(setId)
    if (existing) {
      await existing.adapter.terminate()
      existing.info.status = 'terminated'
      this.sessions.delete(setId)
    }
  }

  list(projectId?: string): SessionInfo[] {
    return Array.from(this.sessions.values())
      .filter((s) => !projectId || s.info.projectId === projectId)
      .map((s) => s.info)
  }

  getSession(setId: string): SessionInfo | undefined {
    return this.sessions.get(setId)?.info
  }

  async applyAbsencePolicy(projectId: string, absentSinceMs: number): Promise<void> {
    const THIRTY_MIN = 30 * 60 * 1000
    const TWO_HOURS = 2 * 60 * 60 * 1000

    const projectSessions = this.list(projectId)

    for (const session of projectSessions) {
      if (absentSinceMs > TWO_HOURS) {
        // 2시간 초과: 스냅샷 저장 후 세션 종료
        await this.saveSnapshot(session.setId)
        await this.destroy(session.setId, 'pm_absent_2h')
      } else if (absentSinceMs > THIRTY_MIN) {
        // 30분~2시간: 신규 작업 시작 금지 (상태만 업데이트)
        session.status = 'idle'
      }
      // 30분 이내: 세션 유지, 아무것도 안 함
    }
  }

  // ── 내부 메서드 ──────────────────────────────────────────

  private async loadRestoreContext(setId: string): Promise<SessionRestoreContext> {
    // Firestore에서 최신 스냅샷 + 최근 메시지 로드
    // 실제 구현에서는 FirestoreService 주입 필요
    throw new Error('SessionManager.loadRestoreContext(): FirestoreService 연동 필요')
  }

  private async saveSnapshot(setId: string): Promise<void> {
    // Firestore에 현재 상태 스냅샷 저장
    // 실제 구현에서는 FirestoreService 주입 필요
  }
}
```

---

## 관련 문서

- [PLAN.md](../PLAN.md) — 전체 아키텍처 및 Claude Code 연동 전략 (5.5절)
- `02_데이터설계/` — Firestore 스키마 (snapshots, sessions 컬렉션)
- `05_기능명세/08_Claude_Code_어댑터.md` — CLI·Channel 어댑터 상세 구현 명세
- `05_기능명세/` — SetOrchestrator 기능 명세
- `06_구현가이드/` — Phase 1 구현 순서 및 환경 설정
- `../00_설정_참조표.md` — 세션 제한값, tmux 명명, 포트, 전역 설정값 단일 출처
