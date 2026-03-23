---
status: DRAFT
priority: 1
last_updated: 2026-03-23
---

# Phase 1 구현 순서 가이드

## Phase 1 목표 재확인

> **"프로젝트를 만들고, 리더들이 대화하며 실제 코드를 생성하는 최소 버전"**

Phase 1이 끝나면 다음이 동작해야 한다:

- 웹 브라우저에서 접속 → PM이 메시지를 입력하면 3개 이상의 AI 리더가 각자 역할에 맞게 응답
- 리더 간 대화가 자연스럽게 이어짐 (상호 참조, 질문, 합의)
- 프로젝트 생성 → 리더 대화 → **실제 코드가 Git 브랜치에 커밋**되는 전체 루프
- Cloudflare Pages + 도메인으로 외부 접속 가능

---

## 구현 단계 개요 (의존성 기반)

```
Step 1: shared 패키지       ─┐
Step 2: Firebase 기반 구조  ─┤─→ Step 3: Server 코어 ─→ Step 4: Claude Code 어댑터
                              └─→ Step 5: Web UI 기본 ─→ Step 6: Set 관리
                                                         ↓
                                                   Step 7: 통합 테스트
                                                         ↓
                                                   Step 8: 배포
```

---

## Step 1: shared 패키지 (타입 정의)

### 예상 소요
0.5일

### 선행 조건
- pnpm workspace 루트 설정 완료
- Node.js 20+, TypeScript 5+ 설치

### 완료 조건
- `packages/shared/src/types/` 아래 모든 인터페이스 정의
- `packages/shared`를 `server`, `web`에서 `import`해도 타입 오류 없음
- `tsc --noEmit` 통과

### 주요 파일

```
packages/shared/
├── src/
│   ├── types/
│   │   ├── project.ts      # Project, ProjectType, ProjectStatus
│   │   ├── room.ts         # Room, Message, MessageType
│   │   ├── set.ts          # AgentSet, SetStatus, SetLog
│   │   ├── task.ts         # Task, TaskStatus, TaskPriority
│   │   └── user.ts         # User, UserProfile
│   ├── constants/
│   │   ├── colors.ts       # SET_COLORS (8색 팔레트)
│   │   └── limits.ts       # FIRESTORE_LIMITS, SESSION_TIMEOUTS
│   └── index.ts            # 전체 re-export
└── package.json
```

### 핵심 타입 힌트

`packages/shared/src/types/room.ts`:
```typescript
export interface Message {
  id: string
  roomId: string
  senderId: string
  senderName: string
  senderType: 'human' | 'leader' | 'system'
  content: string
  replyTo?: string
  metadata?: MessageMetadata
  timestamp: Timestamp  // firebase/firestore Timestamp
}

export interface MessageMetadata {
  artifacts?: string[]
  taskRefs?: string[]
  commitHash?: string
  pullRequestUrl?: string
  tokenUsage?: number
  setColor?: string
}
```

`packages/shared/src/types/set.ts`:
```typescript
export interface AgentSet {
  id: string
  projectId: string
  name: string           // "아키텍처팀"
  role: string           // 리더 역할 시스템 프롬프트
  status: SetStatus
  color: string          // "#8B5CF6"
  branch: string         // "set-a/architecture"
  worktreePath: string   // "/workspace/{projectId}/set-a"
  teammates: number
  createdAt: Timestamp
}

export type SetStatus = 'idle' | 'working' | 'waiting' | 'done'
```

`packages/shared/src/constants/colors.ts`:
```typescript
// PLAN.md 4.7 테마 & 디자인 토큰에서 정의된 8색
export const SET_COLORS = [
  { name: '아키텍처', hex: '#8B5CF6', emoji: '🎯' },
  { name: '백엔드',   hex: '#22C55E', emoji: '🟢' },
  { name: '프론트',   hex: '#3B82F6', emoji: '🔵' },
  { name: 'QA',       hex: '#EAB308', emoji: '🟡' },
  { name: 'DevOps',   hex: '#F97316', emoji: '🟠' },
  { name: '보안',     hex: '#EF4444', emoji: '🔴' },
  { name: '디자인',   hex: '#EC4899', emoji: '🩷' },
  { name: '데이터',   hex: '#06B6D4', emoji: '🩵' },
] as const
```

### 구현 힌트
- `firebase/firestore`의 `Timestamp` 타입을 직접 의존하지 말 것. 대신 `CreatedAt: { seconds: number; nanoseconds: number }` 형태의 중립 타입을 정의하거나, shared에서 `firebase/firestore`를 peerDependency로 추가.
- Phase 1에서는 Board/PR 타입은 stub 수준으로만 정의해도 됨 (Phase 2에서 확장).

---

## Step 2: Firebase 기반 구조

### 예상 소요
0.5일

### 선행 조건
- Firebase 프로젝트 콘솔에서 생성 완료
- Firestore, Firebase Auth 활성화
- Firebase CLI 설치 (`npm i -g firebase-tools`)

### 완료 조건
- `firebase deploy --only firestore:rules` 성공
- `firebase deploy --only firestore:indexes` 성공
- Firebase 콘솔에서 Security Rules 적용 확인
- Google 로그인으로 테스트 인증 성공

### 주요 파일

```
firebase/
├── firebase.json             # 프로젝트 설정
├── .firebaserc               # 프로젝트 ID
├── firestore.rules           # Security Rules
└── firestore.indexes.json    # 복합 인덱스
```

### Security Rules

`firebase/firestore.rules` (PLAN.md 6.2에서 그대로 적용):
```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null
        && request.auth.uid == userId;
    }

    match /projects/{projectId} {
      allow read, write: if request.auth != null
        && resource.data.ownerId == request.auth.uid;

      match /rooms/{roomId} {
        allow read, write: if request.auth != null
          && get(/databases/$(database)/documents/projects/$(projectId)).data.ownerId
             == request.auth.uid;

        match /messages/{messageId} {
          allow read, create: if request.auth != null;
        }
      }

      match /sets/{setId} {
        allow read: if request.auth != null;
        allow write: if request.auth != null
          && get(/databases/$(database)/documents/projects/$(projectId)).data.ownerId
             == request.auth.uid;

        match /logs/{logId} {
          allow read: if request.auth != null;
          allow create: if request.auth != null;
        }
      }

      match /tasks/{taskId} {
        allow read: if request.auth != null;
        allow write: if request.auth != null
          && get(/databases/$(database)/documents/projects/$(projectId)).data.ownerId
             == request.auth.uid;
      }
    }
  }
}
```

### 복합 인덱스

`firebase/firestore.indexes.json`:
```json
{
  "indexes": [
    {
      "collectionGroup": "messages",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "roomId", "order": "ASCENDING" },
        { "fieldPath": "timestamp", "order": "ASCENDING" }
      ]
    },
    {
      "collectionGroup": "messages",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "senderType", "order": "ASCENDING" },
        { "fieldPath": "timestamp", "order": "DESCENDING" }
      ]
    }
  ]
}
```

### 구현 힌트
- `firebase.json`에서 `"emulators"` 섹션을 추가하면 로컬 개발 시 에뮬레이터 사용 가능. Phase 1에서는 실제 Firestore 사용해도 무방 (Spark 무료 한도 내).
- Auth에서 Google 제공업체 활성화 후, 승인된 도메인에 `localhost`와 최종 도메인을 모두 추가할 것.

---

## Step 3: Server 코어

### 예상 소요
1.5일

### 선행 조건
- Step 1 (shared 타입) 완료
- Step 2 (Firebase 설정) 완료
- Firebase Admin SDK 서비스 계정 JSON 확보

### 완료 조건
- `GET /health` → `{ status: 'ok' }` 응답
- `POST /api/projects` → Firestore에 프로젝트 문서 생성
- `GET /api/projects/:id` → 프로젝트 조회
- `POST /api/projects/:id/rooms/:roomId/messages` → 메시지 쓰기
- `GET /api/projects/:id/rooms/:roomId/messages` → 메시지 목록 읽기
- WebSocket 연결 후 `ping` → `pong` 응답

### 주요 파일

```
packages/server/src/
├── index.ts                  # 진입점, Express 앱 + WS 서버 시작
├── firebase/
│   └── admin.ts              # Firebase Admin SDK 초기화 (싱글턴)
├── project/
│   ├── project.router.ts     # /api/projects CRUD 라우트
│   └── project.service.ts    # Firestore 읽기/쓰기 로직
├── council/
│   ├── message.router.ts     # /api/projects/:id/rooms/:roomId/messages
│   └── message.service.ts    # 메시지 Firestore 읽기/쓰기
├── ws/
│   └── ws.server.ts          # WebSocket 서버 (타이핑 인디케이터 등)
└── middleware/
    ├── auth.ts               # Firebase ID 토큰 검증 미들웨어
    └── error.ts              # 전역 에러 핸들러
```

### 핵심 코드 힌트

`packages/server/src/firebase/admin.ts`:
```typescript
import * as admin from 'firebase-admin'

let app: admin.app.App | null = null

export function getFirebaseAdmin(): admin.app.App {
  if (!app) {
    app = admin.initializeApp({
      credential: admin.credential.cert(
        JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON!)
      ),
    })
  }
  return app
}

export function getFirestore(): admin.firestore.Firestore {
  return getFirebaseAdmin().firestore()
}
```

`packages/server/src/middleware/auth.ts`:
```typescript
import { Request, Response, NextFunction } from 'express'
import { getFirebaseAdmin } from '../firebase/admin'

export async function authMiddleware(
  req: Request, res: Response, next: NextFunction
) {
  const token = req.headers.authorization?.split('Bearer ')[1]
  if (!token) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const decoded = await getFirebaseAdmin().auth().verifyIdToken(token)
    req.user = decoded   // Express Request 타입 확장 필요
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}
```

`packages/server/src/project/project.service.ts` (핵심 메서드만):
```typescript
// 프로젝트 생성: Firestore projects/{projectId} 문서 생성
// + 기본 Council Room (rooms/main) 자동 생성
export async function createProject(
  ownerId: string,
  data: CreateProjectDto
): Promise<Project>

// 프로젝트 조회: ownerId 일치 여부 검증 포함
export async function getProject(
  projectId: string,
  requesterId: string
): Promise<Project>
```

### 구현 힌트
- Express 타입 확장 (`req.user`)은 `packages/server/src/types/express.d.ts`에 선언.
- Phase 1에서는 WebSocket 서버는 최소 구현만: 연결 관리, heartbeat, `typing` 이벤트 브로드캐스트. 복잡한 로직은 Step 4 이후에 추가.
- 환경변수는 `dotenv`로 로드. `.env.example` 파일도 함께 커밋.

---

## Step 4: Claude Code CLI 어댑터

### 예상 소요
2일 (Phase 1에서 가장 핵심적이고 까다로운 단계)

### 선행 조건
- Step 3 (Server 코어) 완료
- 서버에 `claude` CLI 설치 및 인증 완료
- `ANTHROPIC_API_KEY` 환경변수 설정

### 완료 조건
- `claude --version` 실행 성공 확인
- 단일 메시지 전송 → Claude 응답 파싱 → Firestore 메시지로 저장
- 리더 역할별 시스템 프롬프트 적용 확인 (응답 톤/역할이 구분됨)
- PM 메시지 입력 → 3개 리더가 순차/병렬로 응답 → Council Room에 표시

### 주요 파일

```
packages/server/src/adapters/
├── claude-cli.adapter.ts     # subprocess 실행 + 응답 파싱
├── leader.prompts.ts         # 리더 역할별 시스템 프롬프트 템플릿
└── council.orchestrator.ts   # 멀티 Set 대화 오케스트레이션
```

### 핵심 코드 힌트

`packages/server/src/adapters/claude-cli.adapter.ts`:
```typescript
import { spawn } from 'child_process'

export interface ClaudeResponse {
  content: string
  tokenUsage?: number
  stopReason?: string
}

export async function callClaude(
  message: string,
  systemPrompt: string,
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>
): Promise<ClaudeResponse> {
  // --output-format json으로 구조화된 응답 수신
  // --system 으로 역할 프롬프트 전달
  // stdin에 대화 이력 주입 (JSON Lines 형식)
  const args = [
    '--output-format', 'json',
    '--system', systemPrompt,
    '--message', message,
  ]

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, {
      env: { ...process.env },
      cwd: process.env.WORKSPACE_BASE_PATH,
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (chunk) => { stdout += chunk })
    proc.stderr.on('data', (chunk) => { stderr += chunk })

    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr))
      try {
        const parsed = JSON.parse(stdout)
        resolve({
          content: parsed.result ?? parsed.content ?? stdout,
          tokenUsage: parsed.usage?.total_tokens,
        })
      } catch {
        // JSON 파싱 실패 시 raw text 반환
        resolve({ content: stdout.trim() })
      }
    })
  })
}
```

`packages/server/src/adapters/leader.prompts.ts`:
```typescript
// 리더 역할 시스템 프롬프트 생성기
// AgentSet의 role 필드 + 프로젝트 컨텍스트를 결합
export function buildLeaderSystemPrompt(params: {
  setName: string        // "백엔드팀"
  role: string           // 사용자가 입력한 역할 설명
  projectName: string
  projectDescription: string
  otherLeaders: Array<{ name: string; role: string }>
  recentMessages: Array<{ sender: string; content: string }>
}): string {
  return `당신은 "${params.setName}" 리더입니다.

## 역할
${params.role}

## 프로젝트
- 이름: ${params.projectName}
- 설명: ${params.projectDescription}

## 다른 팀 리더들
${params.otherLeaders.map(l => `- ${l.name}: ${l.role}`).join('\n')}

## Council Room 대화 규칙
1. 자신의 전문 영역에서 의견을 제시하세요
2. 다른 리더의 의견을 존중하되, 기술적 문제는 명확히 지적하세요
3. PM의 결정을 최우선으로 따르세요
4. 응답은 간결하게 (5줄 이내), 코드가 필요하면 코드 블록 사용
5. 다른 리더에게 질문할 때는 이름을 명시하세요 (예: "백엔드팀, API 스펙...")

## 최근 대화
${params.recentMessages.map(m => `${m.sender}: ${m.content}`).join('\n')}
`
}
```

`packages/server/src/adapters/council.orchestrator.ts`:
```typescript
// PM 메시지가 들어오면 각 Set 리더에게 순서대로 응답 요청
// 이전 리더의 응답을 다음 리더의 컨텍스트에 포함 (대화가 이어지도록)
export class CouncilOrchestrator {
  // PM 메시지 수신 → 등록된 모든 리더 Set에 응답 요청
  // 각 응답은 Firestore에 즉시 저장 (스트리밍 효과)
  async handleHumanMessage(
    projectId: string,
    roomId: string,
    humanMessage: string
  ): Promise<void>

  // 특정 리더에게 직접 지시 (PM이 @멘션할 때)
  async handleDirectMessage(
    projectId: string,
    roomId: string,
    targetSetId: string,
    message: string
  ): Promise<void>
}
```

### 멀티 Set 응답 순서 전략

Phase 1에서는 순차 실행이 안전하다:
```
PM 메시지 → 리더A 응답 (Firestore 저장) → 리더B 응답 (이전 대화 포함) → 리더C 응답
```

- 각 리더에게 이전 리더들의 응답을 컨텍스트로 포함시켜 전달
- 리더 응답이 Firestore에 저장되면 Web UI가 실시간으로 표시 (자연스러운 대화 흐름)
- 병렬 실행은 Phase 2에서 도입 (컨텍스트 일관성 확보 후)

### 구현 힌트
- `claude` CLI 옵션은 버전마다 다를 수 있음. 먼저 `claude --help`로 사용 가능한 플래그를 확인.
- `--output-format stream-json`을 사용하면 스트리밍 응답 가능 (UX 향상). Phase 1에서는 `json`으로 단순화.
- 응답 타임아웃: 60초 제한 설정 (Claude가 오래 걸릴 수 있음).
- 에러 시 Council Room에 `senderType: 'system'`으로 에러 메시지 기록.

---

## Step 5: Web UI 기본

### 예상 소요
2일

### 선행 조건
- Step 2 (Firebase 설정) 완료 (Auth + Firestore)
- Step 3 (Server 코어) 완료 (API 엔드포인트)

### 완료 조건
- `/login` → Google 로그인 성공 → `/`로 리다이렉트
- `/` → 프로젝트 목록 표시 (빈 상태 포함)
- `/new` → 프로젝트 생성 폼 → 서버 API 호출 → 생성 완료
- `/p/:id` → Council Room 채팅 UI 렌더링
- 메시지 입력 → 전송 → Firestore에 저장 → 화면에 즉시 표시 (실시간 리스너)
- 리더 응답이 오면 색상/이모지가 구분되어 표시

### 주요 파일

```
packages/web/src/
├── main.tsx                  # React 진입점
├── App.tsx                   # 라우터 설정
├── firebase/
│   └── config.ts             # Firebase 클라이언트 초기화
├── pages/
│   ├── LoginPage.tsx         # /login
│   ├── DashboardPage.tsx     # / (프로젝트 목록)
│   ├── NewProjectPage.tsx    # /new
│   └── CouncilRoomPage.tsx   # /p/:id (메인 화면)
├── components/
│   ├── chat/
│   │   ├── MessageList.tsx   # 메시지 목록 (스크롤 자동 하단)
│   │   ├── MessageItem.tsx   # 개별 메시지 (human/leader/system 구분)
│   │   └── MessageInput.tsx  # 입력창 + 전송 버튼
│   └── layout/
│       ├── AppLayout.tsx     # 3패널 레이아웃 (데스크톱)
│       └── SetStatusList.tsx # Left 패널: Set 상태 목록
├── hooks/
│   ├── useMessages.ts        # Firestore onSnapshot → 메시지 스트림
│   ├── useProject.ts         # 프로젝트 단일 문서 구독
│   └── useAuth.ts            # Firebase Auth 상태
└── stores/
    ├── authStore.ts          # Zustand: 로그인 사용자
    └── projectStore.ts       # Zustand: 현재 프로젝트/룸 ID
```

### 핵심 코드 힌트

`packages/web/src/hooks/useMessages.ts`:
```typescript
import { collection, query, orderBy, onSnapshot } from 'firebase/firestore'
import { db } from '../firebase/config'
import { Message } from '@agent-council/shared'

export function useMessages(projectId: string, roomId: string) {
  const [messages, setMessages] = useState<Message[]>([])

  useEffect(() => {
    if (!projectId || !roomId) return

    const ref = collection(db, `projects/${projectId}/rooms/${roomId}/messages`)
    const q = query(ref, orderBy('timestamp', 'asc'))

    const unsubscribe = onSnapshot(q, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          setMessages((prev) => [...prev, change.doc.data() as Message])
        }
      })
    })

    return unsubscribe
  }, [projectId, roomId])

  return messages
}
```

`packages/web/src/components/chat/MessageItem.tsx` (스타일 힌트):
```typescript
// senderType별 색상 처리
// 'human'   → PM 색상 (blue-600), 우측 정렬
// 'leader'  → AgentSet.color 값 사용, 좌측 정렬
// 'system'  → gray-500, 중앙 정렬, 작은 폰트

function getSenderStyle(msg: Message) {
  if (msg.senderType === 'human')  return 'text-blue-600 text-right'
  if (msg.senderType === 'system') return 'text-gray-500 text-center text-sm'
  return 'text-left'  // leader: inline style로 set color 적용
}
```

### 구현 힌트
- `react-markdown` + `shiki`를 MessageItem에 적용하면 리더의 코드 블록이 깔끔하게 표시됨.
- 메시지 목록은 새 메시지 추가 시 자동 스크롤 다운: `useEffect`에서 `scrollIntoView()` 호출.
- Phase 1에서 Right Panel(보드/Git)은 플레이스홀더("Phase 2에서 추가 예정")로 비워도 됨.
- Firebase 클라이언트 설정값(`apiKey`, `projectId` 등)은 환경변수로 분리 (`VITE_` 접두사).

---

## Step 6: Set 관리

### 예상 소요
1.5일

### 선행 조건
- Step 3 (Server 코어) 완료 — Git 관련 API 추가
- Step 5 (Web UI 기본) 완료 — UI 컴포넌트 기반 존재

### 완료 조건
- Set 생성 UI에서 이름, 역할 프롬프트, 팀원 수 입력 → 서버 API 호출 → Firestore 저장
- Set 생성 시 서버에서 Git worktree 자동 생성
- Set 목록이 Left Panel에 색상/상태와 함께 표시
- Set 상태(idle/working/done) 변경이 실시간으로 UI에 반영

### 주요 파일

```
packages/server/src/
├── sets/
│   ├── set.router.ts         # /api/projects/:id/sets CRUD
│   ├── set.service.ts        # Firestore 읽기/쓰기 + 색상 자동 할당
│   └── worktree.service.ts   # Git worktree 생성/삭제
└── git/
    └── git.service.ts        # git init, clone, worktree add

packages/web/src/
├── pages/
│   └── CouncilRoomPage.tsx   # Set 관리 버튼 추가
└── components/
    └── sets/
        ├── SetCreateModal.tsx # Set 생성 모달
        └── SetCard.tsx        # Left Panel에 표시되는 Set 상태 카드
```

### 핵심 코드 힌트

`packages/server/src/sets/worktree.service.ts`:
```typescript
import { execSync } from 'child_process'
import path from 'path'

export async function createWorktree(params: {
  projectId: string
  setId: string
  branchName: string      // "set-a/architecture"
  repoPath: string        // "/workspace/{projectId}/main"
}): Promise<string> {
  const worktreePath = path.join(
    process.env.WORKSPACE_BASE_PATH!,
    params.projectId,
    params.setId
  )

  // git worktree add -b {branch} {path}
  execSync(
    `git worktree add -b ${params.branchName} ${worktreePath}`,
    { cwd: params.repoPath }
  )

  return worktreePath
}
```

`packages/server/src/sets/set.service.ts` (색상 자동 할당):
```typescript
import { SET_COLORS } from '@agent-council/shared'

// 프로젝트의 기존 Set 수를 세어 다음 색상 자동 할당
export async function getNextSetColor(projectId: string): Promise<string> {
  const snapshot = await db.collection(`projects/${projectId}/sets`).count().get()
  const count = snapshot.data().count
  return SET_COLORS[count % SET_COLORS.length].hex
}
```

### 구현 힌트
- `WORKSPACE_BASE_PATH` 환경변수로 워크스페이스 루트 경로 관리 (예: `/srv/workspace`).
- Phase 1에서는 Git repo 초기화를 Set 생성 전에 미리 해두어야 함. 프로젝트 생성 시 다음 순서로 실행:
  ```bash
  # 신규 프로젝트: git init
  git init /workspace/{projectId}/main
  cd /workspace/{projectId}/main && git commit --allow-empty -m "init"

  # 기존 프로젝트: git clone
  git clone {repoUrl} /workspace/{projectId}/main

  # Set worktree 생성 전 상태 확인
  git -C /workspace/{projectId}/main status
  ```
- worktree 생성 실패 시 Firestore의 Set 문서도 롤백해야 함 (트랜잭션 처리 필요).
- Set 삭제 시 `git worktree remove --force` 실행하여 디스크 정리.

---

## Step 7: 통합 테스트

### 예상 소요
1일

### 선행 조건
- Step 1~6 모두 완료

### 완료 조건
- 아래 "통합 테스트 시나리오" 전체 통과

### 테스트 시나리오 A: 기본 대화 흐름

```
1. 브라우저에서 /login 접속 → Google 로그인
2. /new에서 프로젝트 생성
   - 이름: "테스트 메신저 앱"
   - 타입: 신규
   → 프로젝트 생성 확인, /p/{id}로 이동
3. Set 3개 생성
   - Set A: "아키텍처팀" / 역할: "전체 설계, DB 스키마, API 스펙 담당"
   - Set B: "백엔드팀" / 역할: "Node.js + Express API 구현 담당"
   - Set C: "프론트팀" / 역할: "React UI 구현 담당"
4. PM 메시지 입력: "안녕하세요, 간단한 채팅 앱을 만들어봅시다. 먼저 아키텍처부터 논의해주세요."
5. 검증:
   - 리더 A, B, C가 순서대로 응답
   - 각 응답이 서로 다른 색상으로 표시
   - 리더들이 서로의 의견을 참조하는 대화
```

### 테스트 시나리오 B: 실제 코드 생성 확인

```
6. PM 메시지: "아키텍처팀, 간단한 User와 Message 엔티티를 TypeScript 인터페이스로 정의해주세요."
7. 검증:
   - Set A 리더가 TypeScript 코드 블록이 포함된 응답
   - 코드 블록이 Shiki로 하이라이팅 표시
8. PM 메시지: "백엔드팀, Set A가 정의한 인터페이스를 바탕으로 기본 Express 서버 코드를 작성하고 set-b/backend 브랜치에 커밋해주세요."
9. 검증:
   - Set B 리더가 코드 작성 후 "커밋 완료" 메시지
   - 서버의 /workspace/{projectId}/set-b 디렉토리에 실제 파일 존재
   - git log set-b/backend에 커밋 기록
```

### 테스트 시나리오 C: 오류 복원력

```
10. Set 하나의 claude 응답을 의도적으로 타임아웃 발생시키기
11. 검증:
    - Council Room에 시스템 메시지로 에러 표시
    - 다른 Set들은 정상 동작 계속
    - 해당 Set 상태가 'error' 또는 'idle'로 표시
```

### 체크리스트

- [ ] Firestore 실시간 리스너: 메시지 추가 → 1초 이내 UI 반영
- [ ] 3개 리더 순차 응답: 각 응답이 독립적으로 Firestore에 저장
- [ ] 리더별 색상 구분: 3개 Set이 서로 다른 색상
- [ ] Git worktree: 3개 Set의 독립 디렉토리 존재 확인
- [ ] 코드 커밋: Set B 브랜치에 실제 커밋 존재
- [ ] 인증: 로그아웃 후 재로그인 → 이전 대화 그대로 표시
- [ ] 에러 처리: 잘못된 API 키 → 시스템 메시지로 에러 표시
- [ ] 모바일 반응형: 375px 뷰포트에서 채팅 사용 가능

---

## Step 8: 배포

### 예상 소요
0.5일

### 선행 조건
- Step 7 (통합 테스트) 통과
- Cloudflare Pages 프로젝트 생성
- Oracle Ampere 서버 접근 가능 (SSH)
- 도메인 구매 (선택)

### 완료 조건
- `https://council.yourdomain.com` 에서 외부 접속 가능
- HTTPS 정상 (Cloudflare SSL)
- 서버 재시작 후에도 Council Server 자동 복구

### Cloudflare Pages 배포 (Web UI)

```bash
# packages/web에서 빌드
pnpm --filter web build

# Cloudflare Pages 연결 방법 1: Git 연동 (권장)
# - GitHub repo → Cloudflare Pages → 자동 빌드
# - Build command: pnpm --filter web build
# - Build output: packages/web/dist
# - Environment variables: VITE_FIREBASE_* 설정

# Cloudflare Pages 연결 방법 2: CLI 직접 배포
npx wrangler pages deploy packages/web/dist --project-name agent-council
```

`packages/web/.env.production` (예시, 실제 값으로 교체):
```
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
VITE_SERVER_URL=https://api.yourdomain.com
```

### Oracle Ampere 서버 배포 (Council Server)

```bash
# Oracle Ampere에 SSH 접속 후:

# 1. Docker 설치 (ARM64)
curl -fsSL https://get.docker.com | sh

# 2. 리포지토리 클론
git clone https://github.com/yourname/agent-council.git /opt/agent-council

# 3. 환경변수 파일 생성
cat > /opt/agent-council/packages/server/.env << 'EOF'
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
ANTHROPIC_API_KEY=sk-ant-...
WORKSPACE_BASE_PATH=/srv/workspace
PORT=3001
EOF

# 4. Docker Compose로 실행
cd /opt/agent-council
docker compose up -d

# 5. Nginx 리버스 프록시 설정 (api.yourdomain.com → localhost:3001)
```

`packages/server/Dockerfile`:
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
RUN npm i -g pnpm && pnpm install --frozen-lockfile
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server
RUN pnpm --filter server build

FROM node:20-alpine
# claude CLI 설치
# Docker 환경에서 Claude CLI는 ANTHROPIC_API_KEY 환경변수가 설정되면 비대화형 모드로 자동 인증됨
# (별도의 `claude auth` 명령 실행 불필요)
RUN npm i -g @anthropic-ai/claude-code
WORKDIR /app
COPY --from=builder /app/packages/server/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
CMD ["node", "dist/index.js"]
```

`docker-compose.yml` (루트):
```yaml
services:
  server:
    build:
      context: .
      dockerfile: packages/server/Dockerfile
    ports:
      - "3001:3001"
    env_file:
      - packages/server/.env
    volumes:
      - /srv/workspace:/srv/workspace
    restart: unless-stopped
```

### Nginx 설정 힌트

```nginx
# /etc/nginx/sites-available/agent-council
server {
    listen 443 ssl;
    server_name api.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        # WebSocket 지원
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

### 구현 힌트
- `certbot` + Let's Encrypt로 SSL 인증서 발급 (`certbot --nginx -d api.yourdomain.com`).
- Cloudflare 쪽은 오리진 서버 SSL을 "Full (strict)"로 설정해야 HTTPS가 정상 작동.
- Oracle Ampere는 인그레스 규칙에서 포트 80, 443 열어야 함 (VCN Security List).

---

## 전체 일정 요약

| Step | 내용 | 예상 소요 | 선행 조건 |
|------|------|-----------|-----------|
| 1 | shared 패키지 (타입 정의) | 0.5일 | 없음 |
| 2 | Firebase 기반 구조 | 0.5일 | 없음 |
| 3 | Server 코어 | 1.5일 | Step 1, 2 |
| 4 | Claude Code CLI 어댑터 | 2일 | Step 3 |
| 5 | Web UI 기본 | 2일 | Step 2, 3 |
| 6 | Set 관리 | 1.5일 | Step 3, 5 |
| 7 | 통합 테스트 | 1일 | Step 1~6 |
| 8 | 배포 | 0.5일 | Step 7 |
| **합계** | | **9.5일** | |

Step 1~2는 병렬 진행 가능, Step 4~5도 병렬 진행 가능 → **실제 소요: 약 7~8일**

> **Step 4~5 병렬 진행 시 주의**: Web UI(Step 5)는 PM 메시지 전송 및 Firestore 리스너까지 먼저 구현하고, 리더 응답 표시는 Step 4(Claude Code 어댑터) 완료 후 통합한다. 즉, Step 5에서 `MessageInput` → Firestore 저장 → `useMessages` 리스너로 메시지 표시까지 완성한 뒤, Step 4 완료 시 서버 응답 메시지가 자동으로 같은 UI에 표시되는 방식으로 통합한다.

---

## 실제 Council 세션으로 간단한 프로젝트 만들어보기

Phase 1 완료 후 다음 시나리오로 시스템 전체를 검증한다.

### 목표 프로젝트
**"간단한 할 일 관리 API"** — Node.js + TypeScript, 파일 기반 저장 (DB 없이)

### 예상 Council 대화 흐름

```
[PM] 할 일을 추가/조회/삭제할 수 있는 REST API를 만들어봅시다.
     Node.js + TypeScript, 파일 기반 저장, 테스트 포함해주세요.

[아키텍처팀 🎯] 엔드포인트를 먼저 정의하겠습니다.
     POST /todos, GET /todos, DELETE /todos/:id
     todos.json 파일로 저장, Todo 인터페이스: { id, text, done, createdAt }

[백엔드팀 🟢] 아키텍처팀 설계 기반으로 Express 서버를 구현하겠습니다.
     파일 읽기/쓰기는 fs.promises 사용, 동시성은 Phase 1에서는 단순화.

[QA팀 🟡] 백엔드팀 구현 완료 후 Jest로 통합 테스트 작성하겠습니다.
     각 엔드포인트에 대해 성공/실패 케이스 커버.

[PM] 좋아요, 백엔드팀부터 시작해주세요.

[백엔드팀 🟢] 구현 완료했습니다. set-b/backend 브랜치에 커밋했습니다.
     - src/index.ts: Express 서버
     - src/todos.ts: CRUD 로직
     - src/types.ts: Todo 인터페이스

[시스템] Set B가 set-b/backend에 3개 커밋을 푸시했습니다.
```

### 검증 포인트

1. **실제 파일 존재 확인**: `/srv/workspace/{projectId}/set-b/src/index.ts`
2. **git log 확인**: `git log set-b/backend --oneline` → 3개 커밋
3. **코드 실행 확인**: set-b worktree에서 `npm start` → API 응답
4. **대화 히스토리**: 브라우저 새로고침 후에도 이전 메시지 모두 표시
5. **리더 색상 구분**: 3명의 리더가 서로 다른 색상으로 명확히 구분

---

## 관련 문서

- [PLAN.md](../PLAN.md) — 전체 설계 계획 (데이터 모델, 아키텍처 다이어그램)
- `01_Phase1_준비사항.md` — 환경 세팅, 계정/키 발급 체크리스트 (미작성 예정)
- [../00_설정_참조표.md](../00_설정_참조표.md) — 포트, 경로, Firebase 설정, 전역 설정값 단일 출처
- [../02_데이터설계/](../02_데이터설계/) — Firestore 스키마 상세
- [../03_API설계/](../03_API설계/) — Server API 스펙 상세
