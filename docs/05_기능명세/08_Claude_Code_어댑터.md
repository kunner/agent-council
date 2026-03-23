---
status: DRAFT
priority: 2
last_updated: 2026-03-23
---

# Claude Code 어댑터 기능 명세

## 목차

1. [개요](#1-개요)
2. [Phase 1: CLI 어댑터 기능 명세](#2-phase-1-cli-어댑터-기능-명세)
3. [Phase 2: Channel 어댑터 기능 명세](#3-phase-2-channel-어댑터-기능-명세)
4. [컨텍스트 관리](#4-컨텍스트-관리)
5. [에러 처리](#5-에러-처리)
6. [리소스 관리](#6-리소스-관리)
7. [사용자 스토리 / 시나리오 예시](#7-사용자-스토리--시나리오-예시)

---

## 1. 개요

Council Server는 각 Agent Set의 리더/팀원 역할을 담당하는 Claude Code 세션을 생성·관리·통신한다. 이 기능이 "Claude Code 어댑터"이며, 시스템 전체에서 AI 에이전트와의 통신이 발생하는 유일한 진입점이다.

### 1.1 역할

```
PM 메시지 (Firestore)
      │
      ▼
Council Server (MessageRouter)
      │
      ▼
Claude Code 어댑터 (IClaudeAdapter)
      │
      ├── Phase 1: CliAdapter   → claude subprocess → stdout 파싱
      └── Phase 2: ChannelAdapter → MCP Channel 서버 → 양방향 실시간 통신
              │
              ▼
     Claude Code 세션 (Set당 1개)
              │
              ▼
     응답 파싱 → Firestore 저장 → UI 표시
```

어댑터는 **Strategy Pattern**으로 추상화된다. Council Server의 비즈니스 로직(`SetOrchestrator`, `MessageRouter`, `SessionManager`)은 `IClaudeAdapter` 인터페이스에만 의존하므로, Phase 1 → Phase 2 전환 시 상위 레이어 코드 변경이 없다.

### 1.2 어댑터 파일 위치

```
packages/server/src/adapters/
├── IClaudeAdapter.ts          ← 공통 인터페이스
├── ClaudeCliAdapter.ts        ← Phase 1 (참조: 00_설정_참조표.md § 8)
├── ClaudeChannelAdapter.ts    ← Phase 2 (참조: 00_설정_참조표.md § 8)
├── AdapterFactory.ts          ← ADAPTER_TYPE 환경변수로 자동 선택
├── AdapterError.ts            ← 공통 에러 타입
├── ContextBuilder.ts          ← 시스템 프롬프트 + 히스토리 구성
└── SessionManager.ts          ← Set별 어댑터 인스턴스 생명주기 관리
```

### 1.3 Phase 전환 방법

```typescript
// packages/server/src/config.ts
// ADAPTER_TYPE 환경변수 하나로 Phase 전환
// Phase 1: ADAPTER_TYPE=cli  (기본값)
// Phase 2: ADAPTER_TYPE=channel
export const adapterType =
  (process.env['ADAPTER_TYPE'] as 'cli' | 'channel') ?? 'cli'
```

---

## 2. Phase 1: CLI 어댑터 기능 명세

### 2.1 세션 생성 플로우

CLI 어댑터는 상태 비저장(stateless)이다. Set에 메시지를 전송할 때마다 독립 subprocess를 생성한다. "세션 생성"은 Set 메타데이터(worktree 경로, 역할 프롬프트)를 초기화하는 과정을 의미한다.

```
[Set 생성 요청] PM이 Set 생성
      │
      ▼
1. Firestore에 Set 문서 생성
   projects/{projectId}/sets/{setId}
   { status: 'idle', branch: 'set-b/backend', worktreePath: '/opt/agent-council/workspace/{projectId}/set-b' }
      │
      ▼
2. Git worktree 생성 (SetService → GitService)
   git -C /opt/agent-council/workspace/{projectId}/main \
     worktree add /opt/agent-council/workspace/{projectId}/set-b \
     set-b/backend
      │
      ▼
3. 초기 시스템 프롬프트 빌드 (ContextBuilder.buildSystemPrompt)
   - 블록 1: 역할 페르소나
   - 블록 2: 프로젝트 컨텍스트
   - 블록 3: 행동 규칙
   - 블록 4: (신규 세션이므로 생략)
      │
      ▼
4. SessionMeta 등록 (메모리 내, 토큰 카운터 초기화)
      │
      ▼
5. 리더 "입장" 메시지 전송
   ClaudeCliAdapter.send("Council Room에 입장했습니다. 자기소개하세요.", { systemPrompt })
      │
      ▼
6. claude subprocess 실행 (§ 2.3 참조)
      │
      ▼
7. 응답 파싱 → Firestore rooms/{roomId}/messages 저장 → UI 실시간 표시
```

### 2.2 리더 역할 시스템 프롬프트 구성

각 Set 리더의 시스템 프롬프트는 `ContextBuilder.buildSystemPrompt()`가 생성한다. 4개 블록으로 구성된다.

```typescript
// packages/server/src/adapters/ContextBuilder.ts

export interface SystemPromptOptions {
  /** Set 역할 설명 (예: "Spring Boot REST API 및 WebSocket 구현 담당") */
  role: string
  /** Set 이름 (예: "백엔드팀") */
  setName: string
  /** 프로젝트 이름 */
  projectName: string
  /** 기술 스택 설명 */
  techStack?: string
  /** 담당 Git 브랜치 */
  branch: string
  /** worktree 절대 경로 (참조: 00_설정_참조표.md § 4) */
  worktreePath: string
  /** 세션 복원 시 주입할 이전 상태 (신규 세션은 undefined) */
  restoreContext?: SessionRestoreContext
}
```

**블록 구성 예시 (백엔드팀 리더):**

```
[블록 1] 역할 페르소나
당신은 백엔드팀의 리더입니다.
RESTful API 설계, 데이터베이스 접근 레이어, WebSocket 실시간 처리를 담당합니다.
간결하고 실용적으로 소통합니다.

[블록 2] 프로젝트 컨텍스트
프로젝트명: 사내 메신저
기술 스택: Spring Boot 3.x, PostgreSQL 16, React 18 + TypeScript
확정된 결정사항:
  - SimpleBroker 사용 (Redis는 2차 스코프)
  - cursor 기반 페이지네이션 채택

[블록 3] 작업 환경 및 행동 규칙
담당 브랜치: set-b/backend
작업 디렉토리: /opt/agent-council/workspace/{projectId}/set-b
코드 작업은 위 디렉토리 내에서만 수행한다.
Council Room 메시지는 5문장 이내. 의사결정 필요 시 즉시 에스컬레이션.

[블록 4] 세션 복원 컨텍스트 (복원 시만 포함)
※ 이전 세션 종료 후 재시작. 아래 상태를 기반으로 작업을 이어갑니다.
마지막 스냅샷: 2026-03-23T10:00:00Z
완료: DB 스키마 설계, API 스펙 정의
진행 중: 채팅 API 구현 (70%)
주요 결정: SimpleBroker, cursor 페이지네이션
```

### 2.3 메시지 전송/수신 플로우

PM이 Council Room에 메시지를 입력하면 다음 플로우로 각 Set 리더에게 전달된다.

```
[PM 메시지 입력]
      │
      ▼
Firestore rooms/{roomId}/messages에 PM 메시지 저장
      │
      ▼
Council Server (Firestore onSnapshot 리스너 감지)
      │
      ▼
MessageRouter: 어느 Set 리더가 응답해야 하는지 판단
  ├── "@백엔드팀" 멘션 → Set B만 호출
  ├── 전체 공지 → 모든 활성 Set 순차/병렬 호출
  └── 특정 리더 발언 → 다음 응답 차례 Set 호출
      │
      ▼
SetOrchestrator.sendToLeader(setId, message)
      │
      ▼
ClaudeCliAdapter.send(message, { systemPrompt, timeoutMs: 120_000 })
      │
      ▼
claude subprocess 실행 (§ 2.4 참조)
      │
      ▼
stdout 스트리밍 수신 → 청크별 'chunk' 이벤트 발생 (WebSocket 타이핑 인디케이터)
      │
      ▼
응답 완료 → parseJsonResponse() → AdapterResponse 반환
      │
      ▼
Firestore rooms/{roomId}/messages에 리더 응답 저장
  {
    senderId: setId,
    senderName: "백엔드팀",
    senderType: "leader",
    content: response.content,
    metadata: {
      artifacts: [...],         // 생성/수정된 파일 목록
      commitHash: "abc1234",    // 커밋이 발생한 경우
      tokenUsage: response.usage.inputTokens + response.usage.outputTokens
    },
    timestamp: FieldValue.serverTimestamp()
  }
      │
      ▼
Firestore onSnapshot → 모든 클라이언트 UI 자동 업데이트
```

### 2.4 CLI 옵션 매핑

`claude` CLI 바이너리를 `child_process.spawn`으로 호출한다.

```bash
# 실제 실행 명령어 (개념 표현)
ANTHROPIC_API_KEY=<apiKey> claude \
  --model claude-opus-4-5 \
  --message "<PM 메시지 또는 오케스트레이터 지시>" \
  --system-prompt "<buildSystemPrompt() 결과>" \
  --output-format json \
  --stream \
  --allowedTools "Bash,Read,Write,Edit,Glob,Grep" \
  --max-turns 15 \
  --dangerously-skip-permissions
```

| CLI 옵션 | 매핑 값 | 설명 |
|---|---|---|
| `--message` | `SendOptions.message` | PM 메시지 또는 오케스트레이터 지시 |
| `--output-format json` | 고정 | 파싱 용이하도록 JSON 출력 |
| `--stream` | 고정 | 청크 단위 스트리밍 (타이핑 인디케이터용) |
| `--system-prompt` | `ContextBuilder.buildSystemPrompt()` 결과 | 역할+컨텍스트+행동규칙 |
| `--allowedTools` | `"Bash,Read,Write,Edit,Glob,Grep"` | 코드 작업에 필요한 도구 허용 |
| `--max-turns` | `15` | 도구 호출 포함 최대 턴 수 (단일 메시지 응답) |
| `--dangerously-skip-permissions` | 고정 | 서버 환경 비대화형 실행에 필수 |
| `cwd` (spawn 옵션) | `set.worktreePath` | `/opt/agent-council/workspace/{projectId}/set-{id}` |

> **보안 참고**: `--dangerously-skip-permissions`는 서버 환경에서 필수이나, `cwd`를 Set의 worktree로 제한하고 시스템 프롬프트에서 "담당 디렉토리 외 수정 금지"를 명시하여 파일 접근 범위를 제어한다.

### 2.5 응답 파싱 로직

`--output-format json --stream` 모드에서 stdout은 줄 단위 NDJSON 스트림이다.

```typescript
// packages/server/src/adapters/ClaudeCliAdapter.ts

private parseJsonResponse(rawOutput: string, startedAt: Date): AdapterResponse {
  const lines = rawOutput.split('\n').filter((l) => l.trim())

  let content = ''
  let inputTokens = 0
  let outputTokens = 0
  let stopReason: AdapterResponse['stopReason'] = 'end_turn'

  for (const line of lines) {
    try {
      const event = JSON.parse(line)

      // 텍스트 누적
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        content += event.delta.text
      }

      // 입력 토큰 수 (메시지 시작 이벤트)
      if (event.type === 'message_start') {
        inputTokens = event.message?.usage?.input_tokens ?? 0
      }

      // 출력 토큰 + 종료 이유 (메시지 델타 이벤트)
      if (event.type === 'message_delta') {
        outputTokens = event.usage?.output_tokens ?? 0
        stopReason = event.delta?.stop_reason ?? 'end_turn'
      }
    } catch {
      // 부분 청크 등 파싱 불가 줄은 무시
    }
  }

  if (!content) {
    throw new AdapterError(AdapterErrorCode.PARSE_ERROR, '응답에서 텍스트를 추출할 수 없습니다.')
  }

  return {
    content,
    usage: { inputTokens, outputTokens },
    stopReason,
    sessionId: `cli-${this.setId}`,
    durationMs: Date.now() - startedAt.getTime(),
  }
}
```

**아티팩트 감지**: 응답 텍스트에서 파일 경로 패턴을 추출하여 `metadata.artifacts`에 저장한다.

```typescript
// 아티팩트 감지: 코드 블록 파일명, "파일 생성/수정" 언급 패턴
function extractArtifacts(content: string): string[] {
  const artifacts: string[] = []

  // 마크다운 코드 블록 파일명 (예: ```java ChatController.java)
  const codeBlockPattern = /```\w*\s+([\w./\-]+\.\w+)/g
  for (const match of content.matchAll(codeBlockPattern)) {
    artifacts.push(match[1])
  }

  // "파일명 생성/수정/작성" 패턴
  const filePattern = /([\w./\-]+\.(java|ts|tsx|js|py|go|yaml|json|md))/g
  for (const match of content.matchAll(filePattern)) {
    if (!artifacts.includes(match[1])) artifacts.push(match[1])
  }

  return artifacts
}
```

**커밋 감지**: 응답에 커밋 해시(7자 이상 16진수)가 포함된 경우 `metadata.commitHash`에 저장한다.

```typescript
function extractCommitHash(content: string): string | undefined {
  const match = content.match(/\b([0-9a-f]{7,40})\b/)
  return match?.[1]
}
```

**인라인 액션 추출**: 리더 응답에 태스크 생성, 상태 변경 등 구조화된 지시가 포함된 경우 파싱한다.

```typescript
// 리더가 "[태스크 생성] 제목" 형식으로 인라인 액션을 포함시킬 수 있다
function extractInlineActions(content: string): InlineAction[] {
  const actions: InlineAction[] = []

  // [태스크 생성] 패턴
  const taskPattern = /\[태스크 생성\]\s+(.+)/g
  for (const match of content.matchAll(taskPattern)) {
    actions.push({ type: 'create_task', title: match[1].trim() })
  }

  // [PR 요청] 패턴
  const prPattern = /\[PR 요청\]/g
  if (prPattern.test(content)) {
    actions.push({ type: 'request_pr' })
  }

  return actions
}
```

### 2.6 다중 Set 동시 실행 전략

PM 메시지가 전체 리더에게 전달될 때 순차(Sequential) 또는 병렬(Parallel) 호출을 선택할 수 있다.

```typescript
// packages/server/src/council/MessageRouter.ts

export type MultiSetStrategy = 'sequential' | 'parallel'

/**
 * 순차 전략: 리더 A 응답 완료 → 리더 B 호출 → ...
 * 장점: 자연스러운 대화 흐름, 이전 리더 발언이 다음 리더 컨텍스트에 포함됨
 * 단점: 응답 시간이 Set 수에 비례
 *
 * 병렬 전략: 모든 리더 동시 호출 → Promise.allSettled
 * 장점: 빠른 전체 응답 시간
 * 단점: 리더 간 상호 참조 불가, 동시 subprocess 부담
 */
async function broadcastToAllSets(
  message: string,
  sets: AgentSet[],
  strategy: MultiSetStrategy = 'sequential',
): Promise<void> {
  if (strategy === 'parallel') {
    // 병렬: 모든 Set 동시 호출
    const results = await Promise.allSettled(
      sets.map((set) => orchestrator.sendToLeader(set.id, message))
    )
    // 실패한 Set에 대한 에러 처리
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        handleSetError(sets[i].id, result.reason)
      }
    })
  } else {
    // 순차: 리더 응답 후 Firestore에 저장, 다음 리더는 전체 히스토리 포함 호출
    for (const set of sets) {
      await orchestrator.sendToLeader(set.id, message)
      // 응답이 Firestore에 저장된 후 다음 리더 호출
      // → 다음 리더는 시스템 프롬프트에 최근 메시지로 이전 리더 발언을 포함
    }
  }
}
```

**기본 전략 선택 기준:**

| 상황 | 권장 전략 |
|---|---|
| 전체 공지, 상황 보고 요청 | `parallel` (빠른 응답) |
| 설계 논의, 의견 교환 | `sequential` (자연스러운 대화) |
| 특정 리더에게만 전달 | 단일 호출 (전략 무관) |
| PM 부재 시 작업 지시 | `parallel` (효율 우선) |

---

## 3. Phase 2: Channel 어댑터 기능 명세

### 3.1 MCP Channel 서버 등록

Phase 2는 커스텀 MCP Channel 서버를 구현하여 Claude Code 세션을 장기 유지한다. Set당 하나의 MCP 서버 인스턴스가 Claude Code 프로세스와 stdio(또는 WebSocket)로 연결된다.

```typescript
// packages/server/src/adapters/ClaudeChannelAdapter.ts

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

export class ClaudeChannelAdapter extends EventEmitter implements IClaudeAdapter {
  private mcpServer: Server | null = null

  async initialize(): Promise<void> {
    this.mcpServer = new Server(
      { name: `agent-council-${this.setId}`, version: '1.0.0' },
      { capabilities: { tools: {}, resources: {} } },
    )

    // Council Server가 Claude Code에 노출하는 Tool 등록
    this.registerCouncilTools()

    // Claude Code로부터 오는 응답/이벤트 핸들러 등록
    this.registerNotificationHandlers()

    const transport = new StdioServerTransport()
    await this.mcpServer.connect(transport)
  }
}
```

**Council Server가 노출하는 MCP Tool 목록:**

| 툴 이름 | 설명 | Claude가 호출하는 시점 |
|---|---|---|
| `council_send_message` | Council Room에 메시지 전송 | 리더가 Council Room에 발언할 때 |
| `council_update_task` | 태스크 상태 업데이트 | 작업 완료/진행 상태 변경 시 |
| `council_get_project_state` | 프로젝트 현재 상태 조회 | 세션 복원 후 맥락 파악 시 |
| `council_escalate` | 이슈를 Council Room으로 에스컬레이션 | 차단 이슈 발생 시 |
| `council_log` | Set 내부 로그 기록 | 팀원 작업 진행 상황 저장 시 |

### 3.2 장기 세션 유지 (tmux)

Council Server 재시작이나 네트워크 단절 시에도 Claude Code 세션을 유지하기 위해 `tmux`를 사용한다.

**tmux 세션 명명 규칙** (참조: `00_설정_참조표.md § 5`):

```
council-{projectId}-{setId}
```

**세션 시작:**

```typescript
// packages/server/src/adapters/TmuxSessionManager.ts

export class TmuxSessionManager {
  /**
   * tmux 세션 안에서 Claude Code를 실행.
   * Council Server 재시작 시에도 프로세스 유지.
   */
  async launchInTmux(setId: string, projectId: string, command: string, cwd: string): Promise<void> {
    // 00_설정_참조표.md § 5: council-{projectId}-{setId}
    const sessionName = `council-${projectId}-${setId}`

    const exists = await this.sessionExists(sessionName)
    if (exists) {
      // 기존 세션이 살아있으면 재사용
      return
    }

    // 새 tmux 세션 생성
    await execAsync(`tmux new-session -d -s ${sessionName} -c "${cwd}"`)
    await execAsync(`tmux send-keys -t ${sessionName} '${command}' Enter`)
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

**Council Server 재시작 후 복원 절차:**

```
Council Server 부팅
  │
  ▼
Firestore에서 활성 Set 목록 로드
  │
  ▼
각 Set에 대해:
  ├── tmux 세션 존재 확인 (council-{projectId}-{setId})
  │     ├── 세션 살아있음 → 기존 세션에 재연결 (컨텍스트 보존)
  │     └── 세션 없음 → 새 세션 시작 + 컨텍스트 주입 (§ 5.3 참조)
  │
  └── Firestore Set 문서 sessionStatus 업데이트
```

### 3.3 Agent Teams 활성화

Set 내부에서 리더가 팀원(sub-agent)을 생성하여 병렬 작업하는 기능을 활성화한다.

```typescript
// Claude Code 세션 시작 시 Agent Teams 환경변수 설정
const claudeProcess = spawn('claude', ['--channel', '--dangerously-skip-permissions'], {
  cwd: set.worktreePath,
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: apiKey,
    // Agent Teams 활성화: 리더가 sub-agent(팀원)를 spawn할 수 있음
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    // 팀원 수 제한 (리소스 관리, 기본 팀원 2명 기준)
    CLAUDE_CODE_MAX_SUBAGENTS: String(set.teammates ?? 2),
  },
})
```

**Agent Teams 동작 원리:**

```
Set B 리더 Claude Code (--channel 모드)
  │
  │ 복잡한 태스크 수신: "채팅 API 구현"
  │
  ├── 태스크 분해
  │
  ├── 팀원 1 spawn (sub-agent)
  │   └── "ChatController.java 구현" → worktree 내 파일 작성
  │
  ├── 팀원 2 spawn (sub-agent, 병렬)
  │   └── "ChatService.java 구현" → worktree 내 파일 작성
  │
  ├── 팀원 완료 보고 수신 → 리더가 통합
  │
  └── git commit → council_send_message("채팅 API 구현 완료") 호출
```

팀원 간 내부 통신 로그는 Council Room에 직접 노출되지 않는다. `council_log` Tool 호출을 통해 `projects/{projectId}/sets/{setId}/logs` 서브컬렉션에만 저장되며, UI에서 접기/펼치기로 확인 가능하다.

### 3.4 양방향 실시간 통신

**notification → Claude (서버 → Claude Code 방향):**

```typescript
// Council Room에 새 메시지가 오면 Channel을 통해 리더에게 전달
async function notifyLeaderViaChannel(setId: string, notification: string): Promise<void> {
  const session = sessions.get(setId)
  if (!session) return

  // MCP notification으로 Claude Code 세션에 이벤트 전송
  session.channelServer.enqueue({
    id: `msg-${Date.now()}`,
    content: notification,
    sender: 'council',
    timestamp: new Date().toISOString(),
  })
}

// 예: PR 머지 후 관련 Set에 자동 알림
await notifyLeaderViaChannel(
  'set-c',
  '[시스템 알림] Set B의 백엔드 API가 main에 머지되었습니다. API 연동을 시작할 수 있습니다.',
)
```

**tool call → reply (Claude Code → 서버 방향):**

```typescript
// Claude가 council_send_message 툴을 호출하면 MCP 서버가 처리
this.mcpServer.setRequestHandler(
  { method: 'tools/call' } as any,
  async (request: any) => {
    const { name, arguments: args } = request.params

    if (name === 'council_send_message') {
      // Firestore에 리더 메시지 저장 → UI 실시간 반영
      await firestoreService.addMessage(roomId, {
        senderId: setId,
        senderName: set.name,
        senderType: 'leader',
        content: args.content,
        timestamp: FieldValue.serverTimestamp(),
      })
      return { content: [{ type: 'text', text: '메시지가 전송되었습니다.' }] }
    }

    // ... 기타 council_* 툴 처리
  }
)
```

**응답 스트리밍 이벤트:**

```typescript
// Claude Code가 text_delta 알림을 보낼 때마다 WebSocket으로 브로드캐스트
this.mcpServer.setNotificationHandler(
  { method: 'notifications/message' } as any,
  (notification: any) => {
    const { type, data } = notification.params

    switch (type) {
      case 'text_delta':
        // 타이핑 인디케이터: WebSocket으로 클라이언트에 청크 전송
        wsServer.broadcast({ type: 'leader_typing', setId, chunk: data.text })
        break

      case 'message_complete':
        // 응답 완료: 대기 중인 Promise resolve
        pendingResolver?.resolve({ content: data.content, ... })
        break

      case 'tool_use':
        // 팀원 작업 로그 수집
        firestoreService.addSetLog(setId, {
          content: `[${data.tool_name}] ${JSON.stringify(data.input).slice(0, 200)}`,
          type: 'code',
        })
        break
    }
  }
)
```

### 3.5 Set 내부 팀원 로그 수집

팀원(sub-agent)의 모든 도구 사용과 진행 상황이 Firestore `sets/{setId}/logs` 서브컬렉션에 수집된다.

```typescript
// Channel 이벤트에서 로그 추출 및 저장
channelAdapter.on('tool_use', async ({ toolName, input, output, teammateId }) => {
  await db.collection(`projects/${projectId}/sets/${setId}/logs`).add({
    content: `[${toolName}] ${JSON.stringify(input).slice(0, 300)}`,
    type: determineLogType(toolName),   // 'code' | 'info' | 'error'
    teammateId,
    relatedFile: extractFilePath(input),
    timestamp: FieldValue.serverTimestamp(),
  })
})

function determineLogType(toolName: string): SetLog['type'] {
  if (['Write', 'Edit', 'MultiEdit'].includes(toolName)) return 'code'
  if (toolName === 'Bash') return 'info'
  return 'info'
}
```

---

## 4. 컨텍스트 관리

### 4.1 대화 히스토리 선별

각 Set 리더에게 전달하는 대화 히스토리는 전체 Firestore 메시지에서 선별된다. 무제한으로 전달할 수 없으므로 `ContextBuilder.buildConversationHistory()`가 토큰 예산 내에서 최적 선별을 수행한다.

**선별 전략:**

```
전체 Council Room 메시지 (Firestore)
      │
      ▼
1. 최근 N개 메시지 (MIN_RECENT_MESSAGES = 10)
   → 토큰 예산 무관하게 항상 포함
      │
      ▼
2. 나머지 예산 내에서 최신 메시지부터 역순으로 추가
   → 예산 초과 시 더 오래된 메시지 제외
      │
      ▼
3. 스냅샷이 있을 경우 스냅샷 이전 메시지 → 스냅샷 요약으로 대체
   (메시지 수십 개를 수백 토큰 요약문으로 압축)
      │
      ▼
4. 최종 선별된 히스토리 → 시스템 프롬프트 뒤에 추가
```

```typescript
// packages/server/src/adapters/ContextBuilder.ts

const MIN_RECENT_MESSAGES = 10

export function buildConversationHistory(
  messages: ConversationMessage[],
  budget: Partial<TokenBudget> = {},
): ConversationMessage[] {
  const maxTokens = budget.maxHistoryTokens ?? 60_000

  const result: ConversationMessage[] = []
  let tokenSum = 0

  // 역순으로 순회 (최신 메시지 우선)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    const tokens = msg.tokenCount ?? estimateTokens(msg.content)

    // 최근 N개는 예산 초과에도 강제 포함
    const isRecent = messages.length - i <= MIN_RECENT_MESSAGES

    if (isRecent || tokenSum + tokens <= maxTokens) {
      result.unshift(msg)
      tokenSum += tokens
    } else {
      break  // 예산 초과, 이전 메시지는 버림
    }
  }

  return result
}
```

### 4.2 토큰 예산 관리

Claude 모델의 컨텍스트 윈도우(200K 토큰)를 목적별로 분배한다. 모든 수치는 `00_설정_참조표.md § 8` 세션 메모리 기준과 연동된다.

```
컨텍스트 윈도우: 200,000 토큰
┌──────────────────────────────────────────────────────────────┐
│  시스템 프롬프트                              최대 8,000      │
│  ├── 역할 페르소나:          ~500 토큰                        │
│  ├── 프로젝트 컨텍스트:      ~300 토큰                        │
│  ├── 작업 환경 + 행동 규칙:  ~400 토큰                        │
│  └── 세션 복원 컨텍스트:     ~2,000~6,000 토큰 (복원 시만)    │
├──────────────────────────────────────────────────────────────┤
│  대화 히스토리                               최대 60,000      │
│  ├── 오래된 메시지 (스냅샷 요약으로 대체 가능)                  │
│  ├── 중간 메시지 (예산 범위 내 최대)                           │
│  └── 최근 10개 메시지 (항상 보존)                              │
├──────────────────────────────────────────────────────────────┤
│  출력 예약 (응답 생성 여유)                   16,000           │
├──────────────────────────────────────────────────────────────┤
│  여유 버퍼 (도구 결과, 기타)                  나머지 (~116,000) │
└──────────────────────────────────────────────────────────────┘
```

```typescript
// packages/server/src/adapters/IContextBuilder.ts

export const DEFAULT_TOKEN_BUDGET: TokenBudget = {
  contextWindowSize: 200_000,      // Claude 모델 컨텍스트 윈도우
  maxSystemPromptTokens: 8_000,    // 시스템 프롬프트 상한
  maxHistoryTokens: 60_000,        // 대화 히스토리 상한
  reservedForOutput: 16_000,       // 응답 출력 예약
}
```

**토큰 초과 시 트리밍 우선순위:**

1. 스냅샷 이전 오래된 메시지 제거 (스냅샷 요약으로 대체)
2. 복원 컨텍스트에서 덜 중요한 항목 제거 (완료된 태스크 목록 등)
3. 중간 메시지 추가 제거
4. 최근 10개 메시지는 절대 제거하지 않음

**토큰 수 추정 함수** (로컬 근사값, API 호출 없이 계산):

```typescript
function estimateTokens(text: string): number {
  // 한국어 문자: 평균 ~0.7 토큰/문자
  // 영어/기타: 평균 ~0.25 토큰/문자
  const koreanChars = (text.match(/[\uAC00-\uD7A3]/g) ?? []).length
  const otherChars = text.length - koreanChars
  return Math.ceil(koreanChars * 0.7 + otherChars * 0.25)
}
```

---

## 5. 에러 처리

### 5.1 에러 분류 및 처리 전략

```typescript
// packages/server/src/adapters/AdapterError.ts

export enum AdapterErrorCode {
  // 재시도 가능 에러
  TIMEOUT        = 'TIMEOUT',         // 응답 대기 시간 초과
  RATE_LIMIT     = 'RATE_LIMIT',       // Anthropic API Rate Limit
  NETWORK_ERROR  = 'NETWORK_ERROR',    // 네트워크 연결 오류

  // 세션 재생성 필요 에러
  SESSION_DEAD   = 'SESSION_DEAD',     // 세션 프로세스 종료됨
  SPAWN_FAILED   = 'SPAWN_FAILED',     // subprocess 시작 실패

  // 즉시 실패 (재시도 불필요)
  AUTH_ERROR          = 'AUTH_ERROR',           // API 키 유효하지 않음
  CONTEXT_TOO_LONG    = 'CONTEXT_TOO_LONG',     // 컨텍스트 윈도우 초과
  PARSE_ERROR         = 'PARSE_ERROR',          // 응답 파싱 실패
  CONCURRENT_SEND     = 'CONCURRENT_SEND',      // 이미 응답 대기 중 (중복 호출)
}
```

| 에러 코드 | 재시도 가능 | 세션 재생성 | Council Room 알림 |
|---|---|---|---|
| `TIMEOUT` | 최대 3회 (지수 백오프) | 반복 시 YES | "리더가 응답하는 데 시간이 걸리고 있습니다..." |
| `RATE_LIMIT` | 최대 3회 | NO | "API 한도 초과. 잠시 후 재시도합니다." |
| `NETWORK_ERROR` | 최대 3회 | NO | "네트워크 오류. 재시도 중..." |
| `SESSION_DEAD` | NO (즉시 재생성) | YES | "리더 세션이 재시작됩니다..." |
| `SPAWN_FAILED` | NO (즉시 재생성) | YES | "세션 시작 실패. 재시도 중..." |
| `AUTH_ERROR` | NO | NO | "API 키가 유효하지 않습니다. 설정을 확인하세요." |
| `CONTEXT_TOO_LONG` | YES (히스토리 줄인 후) | NO | (내부 처리, 자동 트리밍) |
| `PARSE_ERROR` | NO | NO | "응답 파싱 오류. 로그를 확인하세요." |

### 5.2 타임아웃 처리

```typescript
// packages/server/src/adapters/ClaudeCliAdapter.ts

// 타임아웃 기본값: 120초 (참조: 00_설정_참조표.md § 8)
// Channel 어댑터는 장기 작업을 위해 300초 적용
const DEFAULT_TIMEOUT_CLI     = 120_000  // 2분
const DEFAULT_TIMEOUT_CHANNEL = 300_000  // 5분

private createTimeoutPromise(timeoutMs: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      // 실행 중인 subprocess 종료
      this.process?.kill('SIGTERM')
      this.process = null

      reject(new AdapterError(
        AdapterErrorCode.TIMEOUT,
        `응답 대기 시간 초과 (${timeoutMs / 1000}초). 세션을 재생성합니다.`,
      ))
    }, timeoutMs)
  })
}
```

`SendOptions.timeoutMs`로 호출별 오버라이드 가능:

```typescript
// 짧은 상태 확인
await adapter.send('현재 상태를 한 줄로 보고하라.', { timeoutMs: 30_000 })

// 장시간 코드 생성 작업
await adapter.send('인증 모듈 전체를 구현하라.', { timeoutMs: 600_000 })
```

### 5.3 Rate Limit 지수 백오프

```typescript
// packages/server/src/adapters/ClaudeCliAdapter.ts

// 기본 재시도 설정
const DEFAULT_MAX_RETRIES  = 3
const DEFAULT_BASE_DELAY   = 5_000   // 5초
const DEFAULT_MAX_DELAY    = 30_000  // 최대 30초

private async executeWithRetry(fn: () => Promise<AdapterResponse>, timeoutMs: number) {
  let lastError: AdapterError | undefined

  for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
    try {
      return await Promise.race([fn(), this.createTimeoutPromise(timeoutMs)])
    } catch (err) {
      if (!(err instanceof AdapterError)) throw err

      lastError = err

      if (err.code === AdapterErrorCode.RATE_LIMIT && attempt < this.config.maxRetries) {
        // 지수 백오프: 5s → 10s → 20s (최대 30s)
        const delay = Math.min(
          this.config.retryDelayMs * Math.pow(2, attempt),
          DEFAULT_MAX_DELAY,
        )
        // Council Room에 재시도 알림
        await notifyCouncilRoom(`API 한도 초과. ${delay / 1000}초 후 재시도... (${attempt + 1}/${this.config.maxRetries})`)
        await sleep(delay)
        continue
      }

      throw err
    }
  }

  throw lastError!
}
```

### 5.4 세션 죽음 자동 재시작 + 컨텍스트 주입

세션이 예상치 못하게 종료되면 `SessionManager.restore()`가 자동 재시작을 시도한다.

```
세션 종료 감지 (프로세스 exit 이벤트 또는 TIMEOUT 반복)
      │
      ▼
Council Room 알림: "리더 세션을 재시작합니다..."
      │
      ▼
SessionManager.restore(setId)
      │
      ├── Firestore에서 최신 스냅샷 로드
      │   projects/{projectId}/snapshots/{latest}
      │
      ├── 최근 메시지 30개 로드
      │   projects/{projectId}/rooms/{roomId}/messages (최근 30개)
      │
      ├── ContextBuilder.buildSystemPrompt({ restoreContext: ... })
      │   → 블록 4 (세션 복원 컨텍스트) 포함
      │
      └── 새 세션으로 초기화 메시지 전송
          "세션이 복원되었습니다. 이전 작업 상태를 확인하고 준비 완료 여부를 보고하라."
                │
                ▼
          Council Room: "리더 세션 복원 완료. 작업을 이어갑니다."
```

```typescript
// packages/server/src/adapters/SessionManager.ts

async restore(setId: string): Promise<IClaudeAdapter> {
  const existing = this.sessions.get(setId)

  // 살아있는 세션이 있으면 그대로 반환
  if (existing && existing.adapter.getStatus().state !== 'terminated') {
    return existing.adapter
  }

  // 스냅샷 + 최근 메시지로 복원 컨텍스트 구성
  const restoreContext = await this.loadRestoreContext(setId)

  const config: AdapterConfig = {
    apiKey: await this.getApiKey(setId),
    workingDirectory: restoreContext.setMeta.worktreePath,
    timeoutMs: 120_000,
    maxRetries: DEFAULT_MAX_RETRIES,
    retryDelayMs: DEFAULT_BASE_DELAY,
  }

  return this.create(setId, config, restoreContext)
}
```

---

## 6. 리소스 관리

### 6.1 동시 세션 상한

Oracle Cloud Ampere (24GB RAM) 환경 기준이다. 모든 수치는 `00_설정_참조표.md § 8`을 단일 진실 공급원으로 사용한다.

| 항목 | 값 (참조: 00_설정_참조표.md § 8) |
|---|---|
| 동시 세션 상한 | **8개** |
| 세션당 예상 메모리 | **~1.5~2GB** |
| 전체 세션 메모리 상한 | ~16GB (OS/서버 여유 8GB 확보) |

```typescript
// packages/server/src/adapters/ResourceLimiter.ts

export class ResourceLimiter {
  // 동시 세션 상한: 00_설정_참조표.md § 8
  private readonly MAX_CONCURRENT_SESSIONS = 8

  private activeSessions = new Set<string>()

  canCreateSession(): boolean {
    return this.activeSessions.size < this.MAX_CONCURRENT_SESSIONS
  }

  register(setId: string): void {
    if (!this.canCreateSession()) {
      throw new AdapterError(
        AdapterErrorCode.RESOURCE_LIMIT,
        `동시 세션 한도 초과 (최대 ${this.MAX_CONCURRENT_SESSIONS}개). ` +
        `현재 활성: ${this.activeSessions.size}개. ` +
        `유휴 Set을 종료한 후 다시 시도하세요.`,
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

### 6.2 유휴 세션 정리 정책

PM 부재 시간에 따른 세션 관리 정책은 `SessionManager.applyAbsencePolicy()`가 실행한다.

```typescript
// packages/server/src/adapters/SessionManager.ts

async applyAbsencePolicy(projectId: string, absentSinceMs: number): Promise<void> {
  const THIRTY_MIN = 30 * 60_000
  const TWO_HOURS  = 2  * 60 * 60_000

  const projectSessions = this.list(projectId)

  for (const session of projectSessions) {
    if (absentSinceMs > TWO_HOURS) {
      // PM 부재 2시간 초과: 스냅샷 저장 후 세션 종료 (리소스 해제)
      await this.saveSnapshot(session.setId)
      await this.destroy(session.setId, 'pm_absent_2h')

    } else if (absentSinceMs > THIRTY_MIN) {
      // PM 부재 30분~2시간: 신규 작업 시작 금지, 현재 작업만 마무리
      session.status = 'idle'
      // 리더에게 신규 작업 중단 지시 (Channel 어댑터에서만 적용)
      if (session.adapterType === 'channel') {
        await this.notifyLeader(session.setId,
          '[정책] PM이 자리를 비웠습니다. 진행 중인 작업만 마무리하고 신규 작업은 시작하지 마세요.'
        )
      }
    }
    // PM 부재 30분 이내: 아무 조치 없음, 세션 유지
  }
}
```

**정책 요약:**

```
PM 활성 (브라우저 열림)
  → 모든 세션 유지, 정상 동작

PM 부재 0~30분
  → 세션 유지, 진행 중 작업 계속 수행

PM 부재 30분~2시간
  → 세션 유지, 신규 작업 시작 금지, 현재 작업만 마무리

PM 부재 2시간 초과
  → 스냅샷 저장 후 idle 세션 종료 (리소스 해제)
  → 복귀 시 SessionManager.restore()로 컨텍스트 주입 후 재개
```

**5분마다 유휴 세션 검사:**

```typescript
// packages/server/src/adapters/IdleSessionReaper.ts

export class IdleSessionReaper {
  start(): void {
    setInterval(async () => {
      const sessions = await this.adapter.listSessions()
      const now = Date.now()

      for (const session of sessions) {
        const idleMs = now - session.lastActiveAt.getTime()
        const TWO_HOURS = 2 * 60 * 60_000

        if (idleMs > TWO_HOURS) {
          // 스냅샷 저장 후 세션 종료
          await this.saveSnapshot(session.setId)
          await this.adapter.terminateSession(session.setId)

          // Firestore Set 상태 업데이트
          await firestoreService.updateSet(session.setId, {
            sessionStatus: 'sleeping',  // tmux 유지, 프로세스만 종료
          })
        }
      }
    }, 5 * 60_000)  // 5분 간격
  }
}
```

---

## 7. 사용자 스토리 / 시나리오 예시

### 7.1 시나리오: 신규 프로젝트 시작

```
PM: "사내 메신저 시스템을 React + Spring Boot로 만들자"
     → 프로젝트 생성, Council Room 개설
     → Set 3개 생성: 아키텍처팀(set-a), 백엔드팀(set-b), 프론트팀(set-c)

[Council Server 내부 동작]
1. 각 Set에 대해 Git worktree 생성
   /opt/agent-council/workspace/{projectId}/set-a  (set-a/architecture 브랜치)
   /opt/agent-council/workspace/{projectId}/set-b  (set-b/backend 브랜치)
   /opt/agent-council/workspace/{projectId}/set-c  (set-c/frontend 브랜치)

2. 시스템 프롬프트 빌드 (ContextBuilder) + 세션 초기화

3. 순차 전략으로 입장 메시지 전송
   ClaudeCliAdapter.send("Council Room에 입장. 자기소개하세요.", { systemPrompt: ... })

[Council Room 표시]
🎯 아키텍처팀: 안녕하세요. 아키텍처팀 리더입니다. DB 스키마와 API 인터페이스 설계를 담당합니다.
🟢 백엔드팀: 백엔드팀 리더입니다. Spring Boot REST API와 WebSocket 구현을 맡겠습니다.
🔵 프론트팀: 프론트팀 리더입니다. React 기반 UI 구현을 담당합니다.
```

### 7.2 시나리오: Rate Limit 발생 후 자동 복구

```
PM: "채팅 API 구현 상황을 전체 보고해줘"
     → MessageRouter: 병렬 전략으로 3개 Set 동시 호출

[Set B 응답 중 Rate Limit 발생]
RATE_LIMIT 에러 감지
→ Council Room: "API 한도 초과. 5초 후 재시도... (1/3)"
→ sleep(5_000)
→ 재시도 → 성공

[Council Room 표시]
⚙️ 시스템: Set B 응답 지연 중... (Rate Limit, 재시도 중)
🟢 백엔드팀: 채팅 API 구현 70% 완료. ChatController, ChatService 구현 완료. WebSocket 핸들러 작업 중.
```

### 7.3 시나리오: PM 2시간 부재 후 복귀

```
[PM 복귀 감지 - Firestore 접속 이벤트]
     │
     ▼
SessionManager.restore() 호출

[Set B 세션 상태 확인]
tmux has-session -t council-{projectId}-set-b → 세션 없음

[스냅샷 기반 복원]
Firestore snapshots 최신 문서 로드:
  {
    summary: "백엔드 API 70% 구현 완료",
    completedTasks: ["DB 스키마", "API 스펙"],
    inProgressTasks: [{ task: "채팅 API", set: "Set B", progress: "70%" }],
    decisions: ["SimpleBroker", "cursor 페이지네이션"],
  }

시스템 프롬프트 블록 4 포함하여 새 세션 시작
→ ClaudeCliAdapter.send("세션 복원 완료. 현재 상태 보고하라.", { systemPrompt: 복원_컨텍스트 포함 })

[Council Room 표시]
⚙️ 시스템: Set B 세션을 복원했습니다.
🟢 백엔드팀: 이전 작업을 확인했습니다. 채팅 API 구현이 70% 진행 중이었습니다.
             WebSocket 핸들러 구현을 이어서 진행하겠습니다.
```

### 7.4 시나리오: Channel 어댑터에서 Agent Teams 동작

```
PM: "채팅 기능 전체를 구현해줘" → Set B 리더에게 전달

[Set B 리더 Claude Code (--channel 모드, AGENT_TEAMS=1)]
리더: 태스크 분해
  → 팀원 1 (sub-agent) spawn: "ChatController.java 구현"
  → 팀원 2 (sub-agent) spawn: "ChatService.java + Repository 구현"
  → 병렬 실행 (각자 worktree 내 파일 작업)

[Firestore logs 수집]
projects/{projectId}/sets/set-b/logs:
  { type: 'code', content: '[Write] ChatController.java', teammateId: 'tm-1' }
  { type: 'code', content: '[Write] ChatService.java', teammateId: 'tm-2' }
  { type: 'info', content: '[Bash] ./gradlew test', teammateId: 'tm-1' }
  { type: 'commit', content: 'feat: 채팅 API 구현 (abc1234)' }

[리더가 council_send_message 호출]
→ Firestore rooms/{roomId}/messages에 저장

[Council Room 표시]
🟢 백엔드팀: 채팅 API 구현 완료했습니다.
  - POST /api/messages, GET /api/messages, WebSocket STOMP 핸들러
  - 커밋: abc1234
  프론트팀에서 연동 시작 가능합니다.

┌─ 🟢 백엔드팀 내부 작업 ─────────────────── ▼ 펼치기 ─┐
│  마지막 업데이트: 방금 전                              │
│  팀원-1: ChatController.java 구현 완료  ✅             │
│  팀원-2: ChatService.java 구현 완료     ✅             │
│  통합 테스트 통과                       ✅             │
└──────────────────────────────────────────────────────┘
```

---

## 관련 문서 참조

- [01_아키텍처/03_Claude_Code_연동.md](../01_아키텍처/03_Claude_Code_연동.md) — Phase 1/2 아키텍처 설계, 어댑터 인터페이스 전체 구현 코드
- [03_API설계/03_Claude_Adapter_인터페이스.md](../03_API설계/03_Claude_Adapter_인터페이스.md) — IClaudeAdapter, ISessionManager, IContextBuilder 인터페이스 상세 정의
- [00_설정_참조표.md](../00_설정_참조표.md) — 세션 상한(8개), 메모리(~2GB), tmux 명명, worktree 경로 등 모든 설정값
- [05_기능명세/03_Agent_Set.md](03_Agent_Set.md) — Set 생명주기, 역할 프롬프트 블록 구성, 에스컬레이션 패턴
