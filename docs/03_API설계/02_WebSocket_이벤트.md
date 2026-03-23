---
status: DRAFT
priority: 1
last_updated: 2026-03-23
---

# WebSocket 이벤트 설계

## 목차

1. [Firestore vs WebSocket 역할 분담 원칙](#1-firestore-vs-websocket-역할-분담-원칙)
2. [Socket.IO 연결 관리](#2-socketio-연결-관리)
3. [연결 라이프사이클](#3-연결-라이프사이클)
4. [이벤트 카탈로그](#4-이벤트-카탈로그)
   - [typing:start / typing:stop](#41-typingstart--typingstop)
   - [set:progress](#42-setprogress)
   - [session:heartbeat](#43-sessionheartbeat)
   - [session:status](#44-sessionstatus)
   - [set:status](#45-setstatus)
   - [claude:streaming](#46-claudestreaming)
   - [git:push](#47-gitpush)
   - [git:conflict](#48-gitconflict)
5. [재연결 전략](#5-재연결-전략)
6. [클라이언트 구독 패턴](#6-클라이언트-구독-패턴)
7. [서버 브로드캐스트 패턴](#7-서버-브로드캐스트-패턴)

---

## 1. Firestore vs WebSocket 역할 분담 원칙

### 핵심 원칙

> **영속(persist)해야 하는 것 → Firestore, 순간적(volatile)인 것 → WebSocket**

Agent Council의 실시간 통신은 두 채널이 협력하여 동작한다.

```
┌─────────────────────────────────────────────────────────┐
│  Firestore (영속 데이터 + 자동 실시간 동기화)              │
│                                                          │
│  - Council Room 메시지 (채팅 히스토리)                    │
│  - Set 메타데이터 (이름, 역할, 색상, 브랜치)               │
│  - 태스크 보드 상태 (Backlog / Working / Review / Done)   │
│  - Set 내부 작업 로그 (접기/펼치기용)                      │
│  - PR 정보 및 Git 이벤트 결과                             │
│  - 프로젝트 스냅샷                                        │
│                                                          │
│  → onSnapshot으로 자동 푸시, 오프라인 복구 내장            │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  Council Server WebSocket — Socket.IO (휘발성 상태)       │
│                                                          │
│  - 타이핑 인디케이터 ("리더A가 생각 중...")                │
│  - Set 내부 실시간 진행률 (작업 중... 43%)                │
│  - Claude Code 세션 heartbeat (alive/dead 감지)           │
│  - 세션 상태 전환 알림 (reconnecting → alive)             │
│  - Claude 응답 스트리밍 (토큰 단위 실시간 출력)            │
│  - set:status 즉각 전환 (idle → working → done)          │
│                                                          │
│  → 저장 불필요, 연결 끊기면 사라져도 무방                  │
└─────────────────────────────────────────────────────────┘
```

### 분류 기준표

| 데이터 | 저장 필요 | 지연 허용 | 채널 |
|--------|-----------|-----------|------|
| 채팅 메시지 | O | 수백ms | Firestore |
| 태스크 상태 | O | 수백ms | Firestore |
| Set 내부 로그 | O | 수초 | Firestore |
| 타이핑 인디케이터 | X | 즉각 | WebSocket |
| 진행률 (%) | X | 즉각 | WebSocket |
| 세션 heartbeat | X | 즉각 | WebSocket |
| Claude 스트리밍 토큰 | X | 즉각 | WebSocket |
| set:status 전환 | 최종값만 O | 즉각 | WebSocket + Firestore 동기화 |

### set:status의 이중 처리

`set:status` 이벤트는 예외적으로 두 채널을 모두 사용한다.

- **WebSocket**: 즉각적인 UI 반응 (0~50ms)
- **Firestore**: 최종 상태값 영속 저장 (재접속 후 복원용)

```
Set 상태 변경
    │
    ├─→ WebSocket broadcast  → 현재 접속 중인 클라이언트 즉각 반영
    └─→ Firestore write      → sets/{setId}.status 업데이트 (재접속 복원용)
```

---

## 2. Socket.IO 연결 관리

### 서버 URL

```
Production:  wss://council.yourdomain.com       (포트 443, Cloudflare 경유)
Development: ws://localhost:3001                 (REST API 포트 3000과 별도)
```

> **포트 주의**: WebSocket 서버(Council Server)는 **포트 3001**에서 실행된다. REST API(`/api`)는 포트 3000. 클라이언트는 `VITE_SERVER_URL=http://localhost:3001`로 설정할 것.

### Namespace 구조

```
/council      — 기본 네임스페이스 (연결 관리, 인증)
/room         — Council Room 이벤트 (typing, streaming)
/set          — Agent Set 이벤트 (progress, status)
/session      — Claude Code 세션 이벤트 (heartbeat, status)
```

네임스페이스를 분리하면 관심사별로 이벤트 핸들러를 격리할 수 있고, 특정 네임스페이스만 재연결할 수 있다.

### Room 구조

각 네임스페이스 안에서 `projectId` 기반 room으로 격리한다.

```
/room 네임스페이스
  ├── room:project-abc123        ← 프로젝트 전체 브로드캐스트
  └── room:project-abc123:set-a  ← Set A 전용 (Set 내부 이벤트)

/set 네임스페이스
  └── set:project-abc123         ← 해당 프로젝트의 모든 Set 이벤트

/session 네임스페이스
  └── session:project-abc123     ← 해당 프로젝트의 세션 이벤트
```

### 인증 흐름

WebSocket 연결 시 Firebase Auth ID 토큰으로 인증한다.

**서버 미들웨어 (TypeScript):**

```typescript
// packages/server/src/ws/middleware/auth.ts
import { Socket } from 'socket.io'
import { adminAuth } from '../firebase/admin'

export async function authenticateSocket(
  socket: Socket,
  next: (err?: Error) => void
): Promise<void> {
  const token = socket.handshake.auth.token as string | undefined

  if (!token) {
    return next(new Error('AUTH_REQUIRED'))
  }

  try {
    const decoded = await adminAuth.verifyIdToken(token)
    socket.data.userId = decoded.uid
    socket.data.email = decoded.email
    next()
  } catch {
    next(new Error('AUTH_INVALID'))
  }
}
```

**클라이언트 연결 (TypeScript):**

```typescript
// packages/web/src/lib/socket.ts
import { io, Socket } from 'socket.io-client'
import { getAuth } from 'firebase/auth'

async function createAuthenticatedSocket(namespace: string): Promise<Socket> {
  const auth = getAuth()
  const user = auth.currentUser
  if (!user) throw new Error('Not authenticated')

  const token = await user.getIdToken()

  return io(`${import.meta.env.VITE_SERVER_URL}${namespace}`, {
    auth: { token },
    transports: ['websocket'],
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
  })
}
```

---

## 3. 연결 라이프사이클

```
클라이언트                           서버
    │                                 │
    │── connect ──────────────────→   │  TCP 핸드셰이크
    │                                 │
    │← connected ─────────────────    │  연결 확립
    │                                 │
    │── authenticate (token) ──────→  │  Firebase Auth 검증
    │                                 │
    │← auth:success ──────────────    │  인증 완료 + userId
    │                                 │
    │── join:project (projectId) ──→  │  프로젝트 room 입장
    │                                 │
    │← room:joined ───────────────    │  room 입장 확인
    │                                 │
    │    [이벤트 송수신 구간]           │
    │◄────────────────────────────►   │
    │                                 │
    │── disconnect ────────────────→  │  명시적 종료
    │   또는 네트워크 끊김              │
    │                                 │
    │    [재연결 시도]                  │
    │── connect (retry) ────────────→ │
    │── authenticate (새 token) ────→ │  (토큰 만료 가능성 있으므로 재발급)
    │── join:project (projectId) ────→│  room 재입장
    │                                 │
    │← state:restore ─────────────    │  연결 복원 (필요 시 missed 이벤트 요약)
```

### 라이프사이클 이벤트

| 이벤트 | 방향 | 설명 |
|--------|------|------|
| `connect` | client → server | Socket.IO 내장, TCP 연결 |
| `auth:login` | client → server | Firebase ID 토큰 전송 |
| `auth:success` | server → client | 인증 완료 확인 |
| `auth:error` | server → client | 인증 실패 사유 |
| `join:project` | client → server | 프로젝트 room 입장 요청 |
| `room:joined` | server → client | room 입장 확인 |
| `room:left` | server → client | room 이탈 확인 |
| `state:restore` | server → client | 재연결 시 상태 복원 데이터 |
| `disconnect` | client → server | Socket.IO 내장, 연결 종료 |

---

## 4. 이벤트 카탈로그

### 공통 페이로드 필드

모든 이벤트는 다음 공통 필드를 포함한다.

```typescript
interface BasePayload {
  projectId: string   // 프로젝트 ID
  timestamp: number   // Unix ms (Date.now()) — REST API의 ISO 8601 Timestamp와 다름
}
```

> **타임스탬프 형식 주의**: WebSocket 이벤트의 `timestamp`는 **Unix milliseconds (number)** 타입이다. REST API 응답의 `Timestamp` 필드(`string`, ISO 8601)와 혼동하지 않도록 주의할 것.

---

### 4.1 typing:start / typing:stop

리더(Claude Code 세션)가 응답을 생성 중임을 UI에 표시한다. "리더A가 생각 중..." 인디케이터.

**네임스페이스**: `/room`

**방향**: server → client (브로드캐스트)

**이벤트명**: `typing:start`, `typing:stop`

#### 페이로드 스키마

```typescript
interface TypingPayload extends BasePayload {
  setId: string       // 어떤 Set의 리더가 생각 중인지
  setName: string     // "백엔드팀"
  setColor: string    // "#22C55E"
}
```

#### 예시

```json
// typing:start
{
  "projectId": "proj-abc123",
  "setId": "set-b",
  "setName": "백엔드팀",
  "setColor": "#22C55E",
  "timestamp": 1742688000000
}

// typing:stop (동일 구조)
{
  "projectId": "proj-abc123",
  "setId": "set-b",
  "setName": "백엔드팀",
  "setColor": "#22C55E",
  "timestamp": 1742688003500
}
```

#### 서버 발행 (TypeScript)

```typescript
// packages/server/src/ws/handlers/typing.ts
import { Server } from 'socket.io'

export function emitTyping(
  io: Server,
  projectId: string,
  setId: string,
  setName: string,
  setColor: string,
  event: 'typing:start' | 'typing:stop'
): void {
  io.of('/room')
    .to(`room:${projectId}`)
    .emit(event, {
      projectId,
      setId,
      setName,
      setColor,
      timestamp: Date.now(),
    })
}
```

#### 클라이언트 수신 (TypeScript)

```typescript
// packages/web/src/hooks/useTypingIndicator.ts
import { useEffect, useState } from 'react'
import { Socket } from 'socket.io-client'

interface TypingSet {
  setId: string
  setName: string
  setColor: string
}

export function useTypingIndicator(socket: Socket, projectId: string) {
  const [typingSet, setTypingSet] = useState<TypingSet | null>(null)

  useEffect(() => {
    function onTypingStart(payload: TypingSet & { projectId: string }) {
      if (payload.projectId !== projectId) return
      setTypingSet({
        setId: payload.setId,
        setName: payload.setName,
        setColor: payload.setColor,
      })
    }

    function onTypingStop(payload: { projectId: string; setId: string }) {
      if (payload.projectId !== projectId) return
      setTypingSet((prev) =>
        prev?.setId === payload.setId ? null : prev
      )
    }

    socket.on('typing:start', onTypingStart)
    socket.on('typing:stop', onTypingStop)

    return () => {
      socket.off('typing:start', onTypingStart)
      socket.off('typing:stop', onTypingStop)
    }
  }, [socket, projectId])

  return typingSet
}
```

#### 발행 시점

| 시점 | 이벤트 |
|------|--------|
| Claude Code 세션이 응답 생성 시작 | `typing:start` |
| 응답 생성 완료 (첫 토큰 발행 또는 오류) | `typing:stop` |
| 세션 종료/타임아웃 | `typing:stop` |

---

### 4.2 set:progress

Set이 현재 수행 중인 작업의 진행률을 실시간으로 전달한다. 하단 상태 바의 "Set B: WebSocket 핸들러 구현 중 (43%)" 표시에 사용된다.

**네임스페이스**: `/set`

**방향**: server → client

**이벤트명**: `set:progress`

#### 페이로드 스키마

```typescript
interface SetProgressPayload extends BasePayload {
  setId: string
  setName: string
  task: string          // "WebSocket 핸들러 구현 중"
  progress: number      // 0~100 (정수)
  detail?: string       // 선택적 세부 메시지 "B-2/3 완료"
  tokenCount?: number   // 현재까지 사용한 토큰 수
}
```

#### 예시

```json
{
  "projectId": "proj-abc123",
  "setId": "set-b",
  "setName": "백엔드팀",
  "task": "WebSocket 핸들러 구현 중",
  "progress": 43,
  "detail": "B-2/3 서브태스크 완료",
  "tokenCount": 12400,
  "timestamp": 1742688005000
}
```

#### 서버 발행 (TypeScript)

```typescript
// packages/server/src/ws/handlers/progress.ts
import { Server } from 'socket.io'

export interface ProgressUpdate {
  setId: string
  setName: string
  task: string
  progress: number
  detail?: string
  tokenCount?: number
}

export function emitSetProgress(
  io: Server,
  projectId: string,
  update: ProgressUpdate
): void {
  io.of('/set')
    .to(`set:${projectId}`)
    .emit('set:progress', {
      projectId,
      ...update,
      timestamp: Date.now(),
    })
}
```

#### 클라이언트 수신 (TypeScript)

```typescript
// packages/web/src/hooks/useSetProgress.ts
import { useEffect, useState } from 'react'
import { Socket } from 'socket.io-client'

interface SetProgressState {
  [setId: string]: {
    task: string
    progress: number
    detail?: string
    tokenCount?: number
    updatedAt: number
  }
}

export function useSetProgress(socket: Socket, projectId: string) {
  const [progressMap, setProgressMap] = useState<SetProgressState>({})

  useEffect(() => {
    function onProgress(payload: SetProgressPayload) {
      if (payload.projectId !== projectId) return
      setProgressMap((prev) => ({
        ...prev,
        [payload.setId]: {
          task: payload.task,
          progress: payload.progress,
          detail: payload.detail,
          tokenCount: payload.tokenCount,
          updatedAt: payload.timestamp,
        },
      }))
    }

    socket.on('set:progress', onProgress)
    return () => socket.off('set:progress', onProgress)
  }, [socket, projectId])

  return progressMap
}
```

#### 발행 주기

진행률은 Council Server가 Claude Code 세션에서 수신하는 출력을 파싱하여 산출한다.

| 발행 조건 | 설명 |
|-----------|------|
| 서브태스크 완료 시 | 이산적 진행 (0 → 33 → 66 → 100) |
| 코드 파일 저장 시 | 파일 단위 진행 |
| 최소 5초 간격 스로틀 | 너무 잦은 업데이트 방지 |
| 태스크 완료 시 | progress: 100 강제 발행 |

---

### 4.3 session:heartbeat

Council Server가 주기적으로 Claude Code 세션의 생존 여부를 확인하고 결과를 클라이언트에 전달한다.

**네임스페이스**: `/session`

**방향**: server → client

**이벤트명**: `session:heartbeat`

#### 페이로드 스키마

```typescript
interface SessionHeartbeatPayload extends BasePayload {
  setId: string
  sessionPid?: number    // Claude Code 프로세스 PID (alive 시)
  uptimeSeconds: number  // 세션 시작 후 경과 시간 (초)
  memoryMB?: number      // 프로세스 메모리 사용량 (MB)
  isAlive: boolean
}
```

#### 예시

```json
// 정상 heartbeat
{
  "projectId": "proj-abc123",
  "setId": "set-b",
  "sessionPid": 42817,
  "uptimeSeconds": 1920,
  "memoryMB": 312,
  "isAlive": true,
  "timestamp": 1742688010000
}

// 세션 불응
{
  "projectId": "proj-abc123",
  "setId": "set-b",
  "sessionPid": null,
  "uptimeSeconds": 0,
  "memoryMB": null,
  "isAlive": false,
  "timestamp": 1742688010000
}
```

#### 서버 heartbeat 루프 (TypeScript)

```typescript
// packages/server/src/session/heartbeat.ts
import { Server } from 'socket.io'
import { SessionManager } from './SessionManager'

const HEARTBEAT_INTERVAL_MS = 15_000 // 15초

export function startHeartbeatLoop(io: Server, sessions: SessionManager): void {
  setInterval(() => {
    for (const [key, session] of sessions.entries()) {
      const { projectId, setId } = session
      const isAlive = sessions.isAlive(key)
      const stats = isAlive ? sessions.getStats(key) : null

      io.of('/session')
        .to(`session:${projectId}`)
        .emit('session:heartbeat', {
          projectId,
          setId,
          sessionPid: stats?.pid ?? null,
          uptimeSeconds: stats?.uptimeSeconds ?? 0,
          memoryMB: stats?.memoryMB ?? null,
          isAlive,
          timestamp: Date.now(),
        })
    }
  }, HEARTBEAT_INTERVAL_MS)
}
```

#### 발행 주기

- **15초** 간격으로 Council Server가 모든 활성 세션에 대해 발행
- 세션이 죽으면 `isAlive: false`로 한 번 더 발행 후 `session:status` 이벤트 후속 발행

---

### 4.4 session:status

Claude Code 세션의 상태가 전환될 때 발행된다. heartbeat과 달리 **상태 변화** 시에만 발행된다.

**네임스페이스**: `/session`

**방향**: server → client

**이벤트명**: `session:status`

#### 페이로드 스키마

```typescript
type SessionState = 'alive' | 'dead' | 'reconnecting' | 'starting'

interface SessionStatusPayload extends BasePayload {
  setId: string
  setName: string
  previous: SessionState
  current: SessionState
  reason?: string       // 상태 전환 사유 (예: "timeout", "manual_restart")
  retryAttempt?: number // reconnecting 시 몇 번째 재시도인지
}
```

#### 상태 전환 다이어그램

```
               start
                 │
                 ▼
           ┌─────────┐
      ┌───►│  alive  │◄────────────────────┐
      │    └────┬────┘                     │
      │         │ 응답 없음/프로세스 종료    │
      │         ▼                          │
      │    ┌──────────────┐                │
      │    │ reconnecting │── 성공 ────────┘
      │    └──────┬───────┘
      │           │ 최대 재시도 초과
      │           ▼
      │    ┌──────────────┐
      │    │     dead     │
      │    └──────────────┘
      │
      │ (PM이 수동 재시작)
      └── starting ─── alive
```

#### 예시

```json
// 세션 복구 중
{
  "projectId": "proj-abc123",
  "setId": "set-b",
  "setName": "백엔드팀",
  "previous": "alive",
  "current": "reconnecting",
  "reason": "process_timeout",
  "retryAttempt": 1,
  "timestamp": 1742688060000
}

// 복구 성공
{
  "projectId": "proj-abc123",
  "setId": "set-b",
  "setName": "백엔드팀",
  "previous": "reconnecting",
  "current": "alive",
  "reason": "session_restored",
  "timestamp": 1742688075000
}

// 복구 실패
{
  "projectId": "proj-abc123",
  "setId": "set-b",
  "setName": "백엔드팀",
  "previous": "reconnecting",
  "current": "dead",
  "reason": "max_retries_exceeded",
  "timestamp": 1742688120000
}
```

#### 클라이언트 수신 (TypeScript)

```typescript
// packages/web/src/hooks/useSessionStatus.ts
import { useEffect, useState } from 'react'
import { Socket } from 'socket.io-client'
import { toast } from 'sonner'

type SessionState = 'alive' | 'dead' | 'reconnecting' | 'starting'

interface SessionStatusMap {
  [setId: string]: {
    state: SessionState
    updatedAt: number
  }
}

export function useSessionStatus(socket: Socket, projectId: string) {
  const [statusMap, setStatusMap] = useState<SessionStatusMap>({})

  useEffect(() => {
    function onSessionStatus(payload: SessionStatusPayload) {
      if (payload.projectId !== projectId) return

      setStatusMap((prev) => ({
        ...prev,
        [payload.setId]: {
          state: payload.current,
          updatedAt: payload.timestamp,
        },
      }))

      // 주요 상태 전환은 토스트로 알림
      if (payload.current === 'dead') {
        toast.error(`${payload.setName} 세션이 종료되었습니다.`)
      } else if (payload.current === 'alive' && payload.previous === 'reconnecting') {
        toast.success(`${payload.setName} 세션이 복구되었습니다.`)
      }
    }

    socket.on('session:status', onSessionStatus)
    return () => socket.off('session:status', onSessionStatus)
  }, [socket, projectId])

  return statusMap
}
```

---

### 4.5 set:status

Set의 작업 상태가 전환될 때 발행된다. Firestore의 `sets/{setId}.status`와 동기화되지만, **WebSocket이 선행 발행**되어 UI가 즉각 반응한다.

**네임스페이스**: `/set`

**방향**: server → client

**이벤트명**: `set:status`

#### 페이로드 스키마

```typescript
type SetStatus = 'idle' | 'working' | 'waiting' | 'done'

interface SetStatusPayload extends BasePayload {
  setId: string
  setName: string
  setColor: string
  previous: SetStatus
  current: SetStatus
  taskTitle?: string   // 현재 작업 중인 태스크명 (working 시)
  taskId?: string      // 관련 태스크 ID
  reason?: string      // 전환 사유 (예: "task_assigned", "awaiting_review")
}
```

#### 상태 정의

| 상태 | 의미 | UI 표현 |
|------|------|---------|
| `idle` | 대기 중, 할당된 태스크 없음 | 회색 도트 |
| `working` | 태스크 수행 중 | 초록 점멸 도트 |
| `waiting` | 다른 Set의 작업 또는 PM 결정 대기 | 노란 도트 |
| `done` | 현재 스프린트 태스크 완료 | 파란 체크 도트 |

#### 예시

```json
// 태스크 시작
{
  "projectId": "proj-abc123",
  "setId": "set-b",
  "setName": "백엔드팀",
  "setColor": "#22C55E",
  "previous": "idle",
  "current": "working",
  "taskTitle": "채팅 API 엔드포인트 구현",
  "taskId": "task-xyz789",
  "reason": "task_assigned",
  "timestamp": 1742688000000
}

// PR 리뷰 대기
{
  "projectId": "proj-abc123",
  "setId": "set-b",
  "setName": "백엔드팀",
  "setColor": "#22C55E",
  "previous": "working",
  "current": "waiting",
  "taskTitle": "채팅 API 엔드포인트 구현",
  "taskId": "task-xyz789",
  "reason": "awaiting_review",
  "timestamp": 1742688300000
}
```

#### 서버 발행 (TypeScript)

```typescript
// packages/server/src/ws/handlers/setStatus.ts
import { Server } from 'socket.io'
import { firestoreAdmin } from '../firebase/admin'

export async function transitionSetStatus(
  io: Server,
  projectId: string,
  setId: string,
  current: SetStatus,
  options: {
    setName: string
    setColor: string
    previous: SetStatus
    taskTitle?: string
    taskId?: string
    reason?: string
  }
): Promise<void> {
  const payload: SetStatusPayload = {
    projectId,
    setId,
    setName: options.setName,
    setColor: options.setColor,
    previous: options.previous,
    current,
    taskTitle: options.taskTitle,
    taskId: options.taskId,
    reason: options.reason,
    timestamp: Date.now(),
  }

  // 1. WebSocket 선행 발행 (즉각 UI 반응)
  io.of('/set')
    .to(`set:${projectId}`)
    .emit('set:status', payload)

  // 2. Firestore 영속 저장 (재접속 복원용)
  await firestoreAdmin
    .doc(`projects/${projectId}/sets/${setId}`)
    .update({ status: current, updatedAt: new Date() })
}
```

---

### 4.6 claude:streaming

Claude Code 세션의 응답을 토큰 단위로 클라이언트에 스트리밍한다. 응답 완료 전에도 텍스트가 실시간으로 나타나도록 한다.

**네임스페이스**: `/room`

**방향**: server → client

**이벤트명**: `claude:streaming`

#### 페이로드 스키마

```typescript
type StreamingChunkType = 'token' | 'complete' | 'error' | 'interrupt'

interface ClaudeStreamingPayload extends BasePayload {
  streamId: string           // 스트리밍 세션 고유 ID (UUID)
  setId: string
  chunkType: StreamingChunkType
  token?: string             // chunkType === 'token' 일 때의 텍스트 조각
  fullText?: string          // chunkType === 'complete' 일 때의 전체 텍스트
  messageId?: string         // complete 시 Firestore에 저장된 메시지 ID
  errorCode?: string         // chunkType === 'error' 일 때
  tokenCount?: number        // complete 시 총 사용 토큰
}
```

#### 스트리밍 흐름

```
Claude Code 세션
    │  token: "채"
    │  token: "팅"
    │  token: " API"
    │  token: "를"
    │  ...
    ▼
Council Server
    │  claude:streaming { chunkType: 'token', token: '채' }
    │  claude:streaming { chunkType: 'token', token: '팅' }
    │  ...
    │  claude:streaming { chunkType: 'complete', fullText: '...', messageId: 'msg-xyz' }
    ▼
클라이언트 UI
    │  버블에 토큰 누적 표시
    │  complete 수신 → Firestore 메시지로 교체 (hydration)
```

#### 예시

```json
// 토큰 스트리밍 중
{
  "projectId": "proj-abc123",
  "streamId": "stream-7f3a2b",
  "setId": "set-b",
  "chunkType": "token",
  "token": "채팅 API",
  "timestamp": 1742688001100
}

// 스트리밍 완료
{
  "projectId": "proj-abc123",
  "streamId": "stream-7f3a2b",
  "setId": "set-b",
  "chunkType": "complete",
  "fullText": "채팅 API 구현 완료했습니다. 엔드포인트 5개 + WebSocket 핸들러.",
  "messageId": "msg-firestore-id-123",
  "tokenCount": 87,
  "timestamp": 1742688003800
}

// 오류
{
  "projectId": "proj-abc123",
  "streamId": "stream-7f3a2b",
  "setId": "set-b",
  "chunkType": "error",
  "errorCode": "CONTEXT_LIMIT_EXCEEDED",
  "timestamp": 1742688004200
}
```

#### 서버 스트리밍 발행 (TypeScript)

```typescript
// packages/server/src/ws/handlers/streaming.ts
import { Server } from 'socket.io'
import { v4 as uuidv4 } from 'uuid'
import { saveMessageToFirestore } from '../firebase/messages'

export async function streamClaudeResponse(
  io: Server,
  projectId: string,
  setId: string,
  responseStream: AsyncIterable<string>
): Promise<void> {
  const streamId = uuidv4()
  const roomTarget = io.of('/room').to(`room:${projectId}`)
  const tokens: string[] = []

  // typing:start
  roomTarget.emit('typing:start', {
    projectId,
    setId,
    timestamp: Date.now(),
  })

  try {
    for await (const token of responseStream) {
      tokens.push(token)
      roomTarget.emit('claude:streaming', {
        projectId,
        streamId,
        setId,
        chunkType: 'token',
        token,
        timestamp: Date.now(),
      })
    }

    // Firestore에 완전한 메시지 저장
    const fullText = tokens.join('')
    const messageId = await saveMessageToFirestore(projectId, {
      senderId: setId,
      senderType: 'leader',
      content: fullText,
    })

    roomTarget.emit('claude:streaming', {
      projectId,
      streamId,
      setId,
      chunkType: 'complete',
      fullText,
      messageId,
      tokenCount: tokens.length,
      timestamp: Date.now(),
    })
  } catch (error) {
    const errorCode = error instanceof Error ? error.message : 'UNKNOWN_ERROR'
    roomTarget.emit('claude:streaming', {
      projectId,
      streamId,
      setId,
      chunkType: 'error',
      errorCode,
      timestamp: Date.now(),
    })
  } finally {
    // typing:stop
    roomTarget.emit('typing:stop', {
      projectId,
      setId,
      timestamp: Date.now(),
    })
  }
}
```

#### 클라이언트 스트리밍 수신 (TypeScript)

```typescript
// packages/web/src/hooks/useClaudeStreaming.ts
import { useEffect, useState, useCallback } from 'react'
import { Socket } from 'socket.io-client'

interface StreamingMessage {
  streamId: string
  setId: string
  text: string
  isComplete: boolean
  messageId?: string    // complete 후 Firestore ID
}

export function useClaudeStreaming(socket: Socket, projectId: string) {
  const [streamingMessages, setStreamingMessages] = useState<
    Map<string, StreamingMessage>
  >(new Map())

  const removeStream = useCallback((streamId: string) => {
    setStreamingMessages((prev) => {
      const next = new Map(prev)
      next.delete(streamId)
      return next
    })
  }, [])

  useEffect(() => {
    function onStreaming(payload: ClaudeStreamingPayload) {
      if (payload.projectId !== projectId) return

      setStreamingMessages((prev) => {
        const next = new Map(prev)

        if (payload.chunkType === 'token') {
          const existing = next.get(payload.streamId)
          next.set(payload.streamId, {
            streamId: payload.streamId,
            setId: payload.setId,
            text: (existing?.text ?? '') + (payload.token ?? ''),
            isComplete: false,
          })
        } else if (payload.chunkType === 'complete') {
          next.set(payload.streamId, {
            streamId: payload.streamId,
            setId: payload.setId,
            text: payload.fullText ?? '',
            isComplete: true,
            messageId: payload.messageId,
          })
          // Firestore 메시지가 onSnapshot으로 도착하면 스트리밍 버블 제거
          // (messageId로 매칭하여 중복 방지)
        } else if (payload.chunkType === 'error') {
          next.delete(payload.streamId)
        }

        return next
      })
    }

    socket.on('claude:streaming', onStreaming)
    return () => socket.off('claude:streaming', onStreaming)
  }, [socket, projectId])

  return { streamingMessages, removeStream }
}
```

---

### 4.7 git:push

Set 브랜치에 커밋이 푸시되었을 때 발행된다. 클라이언트는 이 이벤트를 수신하여 Git 상태 패널을 갱신한다.

**네임스페이스**: `/set`

**방향**: server → client

**이벤트명**: `git:push`

#### 페이로드 스키마

```typescript
interface GitPushPayload extends BasePayload {
  setId: string
  setName: string
  branch: string
  commitHash: string         // 푸시된 최신 커밋 해시 (short)
  commitMessage: string      // 커밋 메시지
  changedFiles: number       // 변경된 파일 수
  additions: number          // 추가된 라인 수
  deletions: number          // 삭제된 라인 수
}
```

#### 예시

```json
{
  "projectId": "proj-abc123",
  "setId": "set-b",
  "setName": "백엔드팀",
  "branch": "set-b/chat-api",
  "commitHash": "a3f9c21",
  "commitMessage": "feat: 채팅 API 엔드포인트 5개 구현",
  "changedFiles": 8,
  "additions": 312,
  "deletions": 14,
  "timestamp": 1742688300000
}
```

#### 발행 시점

| 시점 | 설명 |
|------|------|
| Set 리더가 `git push` 수행 완료 | Council Server의 Git 훅 또는 폴링으로 감지 |

---

### 4.8 git:conflict

PR 머지 또는 rebase 중 충돌이 발생했을 때 발행된다. PM에게 개입이 필요함을 알린다.

**네임스페이스**: `/set`

**방향**: server → client

**이벤트명**: `git:conflict`

#### 페이로드 스키마

```typescript
interface GitConflictPayload extends BasePayload {
  setId: string
  setName: string
  branch: string             // 충돌이 발생한 Set 브랜치
  targetBranch: string       // 충돌 대상 브랜치 (보통 main)
  conflictFiles: string[]    // 충돌 발생 파일 경로 목록
  prId?: string              // 관련 PR ID (있을 경우)
  reason: 'merge' | 'rebase' // 충돌 발생 작업 유형
}
```

#### 예시

```json
{
  "projectId": "proj-abc123",
  "setId": "set-b",
  "setName": "백엔드팀",
  "branch": "set-b/chat-api",
  "targetBranch": "main",
  "conflictFiles": [
    "src/main/java/com/example/chat/ChatController.java",
    "src/main/resources/application.yml"
  ],
  "prId": "pr_001",
  "reason": "rebase",
  "timestamp": 1742688400000
}
```

#### 발행 시점

| 시점 | 설명 |
|------|------|
| PR 머지 시 충돌 감지 | `POST /api/projects/:id/git/merge` 처리 중 |
| Set worktree rebase 시 충돌 감지 | 다른 PR 머지 후 자동 rebase 과정 |

---

## 5. 재연결 전략

### Exponential Backoff 설정

```typescript
// packages/web/src/lib/socket.ts
import { io } from 'socket.io-client'

function createSocket(namespace: string) {
  return io(`${import.meta.env.VITE_SERVER_URL}${namespace}`, {
    auth: async (cb) => {
      // 재연결 시마다 토큰 재발급 (만료 대비)
      const token = await getAuth().currentUser?.getIdToken(true)
      cb({ token })
    },
    transports: ['websocket'],
    // Socket.IO 내장 재연결 옵션
    reconnection: true,
    reconnectionAttempts: 5,       // 최대 5회 시도
    reconnectionDelay: 1000,       // 첫 재시도 1초 후
    reconnectionDelayMax: 30000,   // 최대 대기 30초
    randomizationFactor: 0.5,      // ±50% 지터 (서버 thundering herd 방지)
    timeout: 10000,                // 연결 타임아웃 10초
  })
}
```

**재시도 대기 시간 (지터 포함):**

| 시도 | 기본 대기 | 실제 범위 (±50%) |
|------|-----------|-----------------|
| 1회 | 1초 | 0.5~1.5초 |
| 2회 | 2초 | 1.0~3.0초 |
| 3회 | 4초 | 2.0~6.0초 |
| 4회 | 8초 | 4.0~12.0초 |
| 5회 | 16초 | 8.0~24.0초 (최대 30초) |

### 재연결 후 상태 복구

재연결 시 서버는 `state:restore` 이벤트로 클라이언트가 놓친 상태를 요약 전달한다.

```typescript
// packages/server/src/ws/handlers/restore.ts
import { Socket } from 'socket.io'
import { getProjectState } from '../project/state'

export async function handleReconnect(
  socket: Socket,
  projectId: string
): Promise<void> {
  const state = await getProjectState(projectId)

  socket.emit('state:restore', {
    projectId,
    sets: state.sets.map((s) => ({
      setId: s.id,
      status: s.status,
      sessionAlive: s.sessionAlive,
    })),
    timestamp: Date.now(),
  })
}
```

### 재연결 불가 시 처리

5회 시도 모두 실패하면 UI에 수동 새로고침 안내를 표시한다.

```typescript
// packages/web/src/hooks/useSocket.ts
socket.on('reconnect_failed', () => {
  toast.error('서버 연결에 실패했습니다. 페이지를 새로고침해 주세요.', {
    duration: Infinity,
    action: {
      label: '새로고침',
      onClick: () => window.location.reload(),
    },
  })
})
```

---

## 6. 클라이언트 구독 패턴

### 통합 훅: useCouncilSocket

프로젝트별 WebSocket 연결과 모든 이벤트 구독을 하나의 훅으로 관리한다.

```typescript
// packages/web/src/hooks/useCouncilSocket.ts
import { useEffect, useRef, useState } from 'react'
import { io, Socket } from 'socket.io-client'
import { getAuth } from 'firebase/auth'

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error'

interface CouncilSocketState {
  connectionState: ConnectionState
  sockets: {
    room: Socket | null
    set: Socket | null
    session: Socket | null
  }
}

export function useCouncilSocket(projectId: string): CouncilSocketState {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('connecting')
  const socketsRef = useRef<CouncilSocketState['sockets']>({
    room: null,
    set: null,
    session: null,
  })

  useEffect(() => {
    if (!projectId) return

    async function getToken() {
      return (await getAuth().currentUser?.getIdToken()) ?? ''
    }

    const namespaces = ['/room', '/set', '/session'] as const
    const keys = ['room', 'set', 'session'] as const

    const newSockets = namespaces.map((ns) =>
      io(`${import.meta.env.VITE_SERVER_URL}${ns}`, {
        auth: async (cb: (data: { token: string }) => void) => {
          cb({ token: await getToken() })
        },
        query: { projectId },
        transports: ['websocket'],
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 30000,
        randomizationFactor: 0.5,
      })
    )

    newSockets.forEach((socket, i) => {
      socketsRef.current[keys[i]] = socket

      socket.on('connect', () => {
        socket.emit('join:project', { projectId })
        setConnectionState('connected')
      })
      socket.on('disconnect', () => setConnectionState('disconnected'))
      socket.on('connect_error', () => setConnectionState('error'))
      socket.on('reconnect_failed', () => setConnectionState('error'))
    })

    return () => {
      newSockets.forEach((socket) => socket.disconnect())
      socketsRef.current = { room: null, set: null, session: null }
    }
  }, [projectId])

  return { connectionState, sockets: socketsRef.current }
}
```

### 이벤트별 전용 훅 사용 예시

```typescript
// packages/web/src/pages/CouncilRoom.tsx
import { useCouncilSocket } from '../hooks/useCouncilSocket'
import { useTypingIndicator } from '../hooks/useTypingIndicator'
import { useSetProgress } from '../hooks/useSetProgress'
import { useSessionStatus } from '../hooks/useSessionStatus'
import { useClaudeStreaming } from '../hooks/useClaudeStreaming'

export function CouncilRoom({ projectId }: { projectId: string }) {
  const { sockets, connectionState } = useCouncilSocket(projectId)

  const typingSet = useTypingIndicator(sockets.room!, projectId)
  const progressMap = useSetProgress(sockets.set!, projectId)
  const sessionStatusMap = useSessionStatus(sockets.session!, projectId)
  const { streamingMessages } = useClaudeStreaming(sockets.room!, projectId)

  return (
    <div>
      {/* ... */}
      {typingSet && (
        <TypingIndicator
          setName={typingSet.setName}
          color={typingSet.setColor}
        />
      )}
      {[...streamingMessages.values()].map((msg) => (
        <StreamingBubble key={msg.streamId} message={msg} />
      ))}
    </div>
  )
}
```

---

## 7. 서버 브로드캐스트 패턴

### 범위별 브로드캐스트

```typescript
// packages/server/src/ws/broadcast.ts
import { Server } from 'socket.io'

/**
 * 프로젝트 전체 클라이언트에게 발행
 * 용도: set:status, set:progress, session:status, session:heartbeat
 */
export function broadcastToProject(
  io: Server,
  namespace: '/room' | '/set' | '/session',
  projectId: string,
  event: string,
  payload: object
): void {
  io.of(namespace)
    .to(`${namespace.slice(1)}:${projectId}`)
    .emit(event, payload)
}

/**
 * 특정 Set의 room에만 발행
 * 용도: Set 내부 상세 로그 (Council Room 외부)
 */
export function broadcastToSet(
  io: Server,
  projectId: string,
  setId: string,
  event: string,
  payload: object
): void {
  io.of('/room')
    .to(`room:${projectId}:${setId}`)
    .emit(event, payload)
}

/**
 * 특정 사용자(소켓)에게만 발행
 * 용도: auth:success, room:joined, state:restore
 */
export function emitToSocket(
  socket: { emit: (event: string, data: unknown) => void },
  event: string,
  payload: object
): void {
  socket.emit(event, payload)
}
```

### 이벤트 → 브로드캐스트 범위 요약

| 이벤트 | 네임스페이스 | room 범위 | 발행 조건 |
|--------|------------|-----------|----------|
| `typing:start` | `/room` | `room:{projectId}` | 리더 응답 생성 시작 |
| `typing:stop` | `/room` | `room:{projectId}` | 응답 완료/오류 |
| `claude:streaming` | `/room` | `room:{projectId}` | 토큰 수신마다 |
| `set:progress` | `/set` | `set:{projectId}` | 진행률 변경 (5초 스로틀) |
| `set:status` | `/set` | `set:{projectId}` | 상태 전환 시 |
| `git:push` | `/set` | `set:{projectId}` | Set 브랜치 푸시 감지 시 |
| `git:conflict` | `/set` | `set:{projectId}` | 머지/rebase 충돌 발생 시 |
| `session:heartbeat` | `/session` | `session:{projectId}` | 15초 주기 |
| `session:status` | `/session` | `session:{projectId}` | 상태 변화 시 |
| `state:restore` | 모두 | 개별 소켓 | 재연결 시 |

### 서버 진입점 예시 (TypeScript)

```typescript
// packages/server/src/ws/index.ts
import { Server } from 'socket.io'
import { createServer } from 'http'
import { authenticateSocket } from './middleware/auth'
import { handleReconnect } from './handlers/restore'

export function setupWebSocketServer(httpServer: ReturnType<typeof createServer>): Server {
  const io = new Server(httpServer, {
    cors: {
      origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket'],
  })

  // 모든 네임스페이스에 인증 미들웨어 적용
  for (const ns of ['/room', '/set', '/session']) {
    io.of(ns).use(authenticateSocket)
  }

  // /room 네임스페이스 핸들러
  io.of('/room').on('connection', (socket) => {
    socket.on('join:project', async ({ projectId }: { projectId: string }) => {
      await socket.join(`room:${projectId}`)
      socket.emit('room:joined', { projectId })
      await handleReconnect(socket, projectId)
    })
  })

  // /set 네임스페이스 핸들러
  io.of('/set').on('connection', (socket) => {
    socket.on('join:project', async ({ projectId }: { projectId: string }) => {
      await socket.join(`set:${projectId}`)
      socket.emit('room:joined', { projectId })
    })
  })

  // /session 네임스페이스 핸들러
  io.of('/session').on('connection', (socket) => {
    socket.on('join:project', async ({ projectId }: { projectId: string }) => {
      await socket.join(`session:${projectId}`)
      socket.emit('room:joined', { projectId })
    })
  })

  return io
}
```

---

## 관련 문서

- [PLAN.md](../PLAN.md) — 5.4절: Firestore vs WebSocket 역할 분담
- [01_아키텍처](../01_아키텍처/) — Council Server 구조
- [02_데이터설계](../02_데이터설계/) — Firestore 컬렉션 스키마
- [../00_설정_참조표.md](../00_설정_참조표.md) — 포트(3001), WebSocket 연결 설정, 전역 설정값 단일 출처
