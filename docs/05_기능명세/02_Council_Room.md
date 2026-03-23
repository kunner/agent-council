---
status: DRAFT
priority: 2
last_updated: 2026-03-23
---

# Council Room 기능 명세

## 목차

1. [개념 및 역할](#1-개념-및-역할)
2. [Room 생성 플로우](#2-room-생성-플로우)
3. [Room purpose 유형](#3-room-purpose-유형)
4. [메시지 흐름](#4-메시지-흐름)
5. [리더 참여/퇴장 관리](#5-리더-참여퇴장-관리)
6. [대화 턴 관리](#6-대화-턴-관리)
7. [인라인 액션](#7-인라인-액션)
8. [대화 컨텍스트 관리](#8-대화-컨텍스트-관리)
9. [메시지 검색](#9-메시지-검색)
10. [Room 상태 관리 (일시정지/재개/종료)](#10-room-상태-관리)
11. [에러 케이스](#11-에러-케이스)
12. [데이터 모델 요약](#12-데이터-모델-요약)

---

## 1. 개념 및 역할

### 1.1 Council Room이란

Council Room은 하나의 **프로젝트에 종속된 리더 간 대화 공간**이다. 메신저 채팅방처럼 동작하되, 참여자가 인간 PM과 여러 Claude 리더로 구성된다는 점에서 일반 채팅방과 다르다.

```
Project
└── Council Room (1개 이상)
    ├── Human (PM) — 방향 설정, 의사결정, 승인
    ├── Leader A   — 아키텍처팀 리더 (Claude Code 세션)
    ├── Leader B   — 백엔드팀 리더  (Claude Code 세션)
    ├── Leader C   — 프론트팀 리더  (Claude Code 세션)
    └── Leader D   — QA팀 리더     (Claude Code 세션)
```

**핵심 특성:**

- **프로젝트 종속**: Council Room은 반드시 하나의 Project에 귀속된다. Project 없이 Room은 존재할 수 없다.
- **실시간 공유 공간**: 모든 참여자가 동일한 메시지 스트림을 본다. Firestore `onSnapshot`으로 새 메시지가 즉시 푸시된다.
- **의사결정 채널**: 단순 대화가 아니라 아키텍처 합의, 이슈 에스컬레이션, 인터페이스 협의, PR 승인 등 실질적 의사결정이 이루어지는 곳이다.
- **Set 내부와의 경계**: 각 Set(팀) 내부의 작업 대화는 Council Room에 노출되지 않는다. 리더가 요약하여 보고하는 형식으로만 공유된다.

### 1.2 Council Room vs Set 내부 대화

| 구분 | Council Room | Set 내부 대화 |
|---|---|---|
| 참여자 | PM + 모든 리더 | 리더 + 해당 팀원만 |
| 가시성 | 프로젝트 전체 공유 | 해당 Set만 열람 가능 |
| 목적 | 의사결정, 합의, 에스컬레이션 | 태스크 분배, 세부 구현 논의 |
| 저장 위치 | `projects/{id}/rooms/{roomId}/messages` | `projects/{id}/sets/{setId}/logs` |
| UI 표시 | 메인 채팅 패널 | 접기/펼치기 인라인 로그 |

---

## 2. Room 생성 플로우

### 2.1 프로젝트 생성 시 자동 생성

프로젝트가 생성되면 **메인 Council Room이 자동으로 생성**된다. PM이 별도로 Room을 만들 필요가 없다.

```
sequenceDiagram
    actor PM
    participant UI as Web UI
    participant CS as Council Server
    participant FS as Firestore

    PM->>UI: 프로젝트 생성 요청\n(이름, 유형, Git 정보)
    UI->>CS: POST /api/projects
    CS->>FS: projects/{projectId} 문서 생성
    CS->>FS: projects/{projectId}/rooms/main 문서 생성\n(purpose: "메인 회의", status: "active")
    CS->>FS: projects/{projectId}/rooms/main/messages/\n[시스템 메시지] "프로젝트가 생성되었습니다."
    FS-->>UI: onSnapshot 트리거 → UI 실시간 반영
    CS-->>UI: { projectId, roomId: "main" }
    UI->>PM: Council Room 화면으로 이동
```

**자동 생성 Room 초기값:**

```typescript
{
  id: "main",
  name: "메인 회의",
  purpose: "main",
  status: "active",
  createdAt: Timestamp.now(),
  participantSetIds: [],   // 리더들이 입장하면 채워짐
  messageCount: 0,
  lastMessageAt: null,
}
```

### 2.2 추가 Room 생성

PM은 메인 Room 외에 목적별 Room을 추가로 생성할 수 있다.

```
sequenceDiagram
    actor PM
    participant UI as Web UI
    participant CS as Council Server
    participant FS as Firestore
    participant Leader as 리더 세션들

    PM->>UI: [+ 새 Room] 클릭
    UI->>PM: Room 생성 모달\n(이름, purpose 선택, 초대할 리더 선택)
    PM->>UI: 입력 완료 후 [생성]
    UI->>CS: POST /api/projects/{projectId}/rooms\n{ name, purpose, inviteSetIds }
    CS->>FS: rooms/{roomId} 문서 생성
    CS->>Leader: 초대된 리더 세션에 Room 입장 알림
    Leader-->>FS: 입장 메시지 기록
    FS-->>UI: onSnapshot → 새 Room 탭 표시
    CS-->>UI: { roomId }
```

**생성 규칙:**

- 하나의 프로젝트에 최대 10개의 Room까지 생성 가능
- 메인 Room(`purpose: "main"`)은 삭제 불가
- 추가 Room은 PM만 생성 가능
- Room 이름은 프로젝트 내 유일해야 함

---

## 3. Room purpose 유형

Room의 `purpose` 필드는 Council Server가 해당 Room에 어떤 리더를 자동 초대하고, 어떤 시스템 메시지를 보낼지 결정하는 데 사용된다.

| purpose | 한국어 이름 | 자동 참여 리더 | 설명 |
|---|---|---|---|
| `main` | 메인 회의 | 전체 리더 | 프로젝트 전반적 논의, 의사결정. 프로젝트 생성 시 자동 생성 |
| `design` | 설계 논의 | 아키텍처 + 백엔드 + 프론트 | API 스펙, DB 스키마, 인터페이스 합의 |
| `bug_triage` | 버그 트리아지 | QA + 담당 Set 리더 | 버그 재현, 우선순위 결정, 수정 담당 배정 |
| `code_review` | 코드 리뷰 | PR 작성 Set + QA | PR 기반 코드 리뷰, 리뷰 코멘트 집계 |
| `integration` | 통합 논의 | 전체 리더 | 브랜치 머지 순서, 충돌 해결, rebase 전략 |
| `custom` | 사용자 정의 | PM이 수동 지정 | 그 외 임시 목적의 논의 공간 |

**purpose별 시스템 프롬프트 힌트:**

Council Server는 리더에게 메시지를 전달할 때 Room의 purpose를 컨텍스트에 포함시켜, 리더가 해당 Room의 성격에 맞게 응답하도록 유도한다.

```typescript
const purposeHints: Record<RoomPurpose, string> = {
  main:         "이 방은 프로젝트 전반의 의사결정 공간입니다. 전략적 관점으로 의견을 제시하세요.",
  design:       "이 방은 기술 설계 논의 공간입니다. 구체적인 인터페이스와 스키마를 중심으로 논의하세요.",
  bug_triage:   "이 방은 버그 트리아지 공간입니다. 재현 여부, 심각도, 수정 담당을 빠르게 결정하세요.",
  code_review:  "이 방은 코드 리뷰 공간입니다. 코드 품질, 스펙 준수 여부, 테스트 커버리지를 검토하세요.",
  integration:  "이 방은 통합 논의 공간입니다. 머지 순서와 충돌 해결 방안을 합의하세요.",
  custom:       "이 방은 사용자 정의 목적 공간입니다.",
}
```

---

## 4. 메시지 흐름

### 4.1 PM 메시지 흐름

```
sequenceDiagram
    actor PM
    participant UI as Web UI
    participant CS as Council Server
    participant FS as Firestore
    participant Claude as 리더 세션들 (Claude Code)

    PM->>UI: 메시지 입력 후 [전송]
    UI->>FS: rooms/{roomId}/messages 에 직접 write\n{ senderId, senderType: "human", content, timestamp }
    FS-->>UI: onSnapshot → 자신의 메시지 즉시 표시
    FS-->>CS: onSnapshot 트리거 (Council Server가 Firestore 리스닝)

    CS->>CS: 메시지 분석\n- @멘션 파싱 (특정 리더 지정 여부)\n- 액션 키워드 감지 ("태스크로 등록해", "PR 봐줘" 등)

    alt 특정 리더 멘션 (@백엔드팀)
        CS->>Claude: 해당 리더 세션에만 메시지 전달
    else 전체 메시지 (멘션 없음)
        CS->>Claude: 모든 활성 리더 세션에 메시지 전달\n(응답 순서는 턴 관리 참조 §6)
    end

    Claude-->>CS: 리더 응답 생성
    CS->>FS: rooms/{roomId}/messages 에 리더 메시지 write
    FS-->>UI: onSnapshot → 모든 클라이언트에 실시간 표시
```

**PM 직접 Firestore 쓰기 이유:**
PM 메시지는 Claude 처리가 필요 없으므로, UI에서 Council Server를 거치지 않고 Firestore에 직접 기록한다. 이렇게 하면 레이턴시가 낮아지고 Council Server 부하가 줄어든다. Council Server는 Firestore 리스너를 통해 PM 메시지를 감지하고 리더 세션에 전달한다.

### 4.2 Claude 리더 메시지 흐름

```
sequenceDiagram
    participant CS as Council Server
    participant Claude as 리더 세션 (Claude Code)
    participant FS as Firestore
    participant UI as 모든 클라이언트

    CS->>Claude: 메시지 컨텍스트 전달\n(대화 히스토리 + 프로젝트 상태 + purpose 힌트)

    Claude->>CS: 스트리밍 응답 시작 (토큰 단위)
    CS->>UI: WebSocket 타이핑 인디케이터 전송\n"백엔드팀이 응답 중..."

    loop 응답 생성 중
        Claude->>CS: 토큰 스트림
        CS->>UI: WebSocket streaming chunk (선택적, 미리보기)
    end

    Claude->>CS: 응답 완료
    CS->>FS: rooms/{roomId}/messages 에 리더 메시지 write\n{ senderType: "leader", setId, content, metadata }
    CS->>UI: WebSocket 타이핑 인디케이터 종료
    FS-->>UI: onSnapshot → 확정 메시지 표시 (스트리밍 미리보기 대체)
```

**메시지 metadata 구조:**

```typescript
interface LeaderMessageMetadata {
  artifacts?: string[]        // 생성/수정된 파일 경로 목록
  taskRefs?: string[]         // 대화 중 언급/생성된 태스크 ID
  commitHash?: string         // 관련 Git 커밋 해시
  pullRequestUrl?: string     // 관련 PR URL
  tokenUsage?: number         // 이 응답 생성에 사용된 토큰 수
  inlineActions?: InlineAction[] // 메시지에 포함된 액션 버튼 정의 (§7 참조)
  thinkingDuration?: number   // 응답 생성 소요 시간 (ms)
}
```

### 4.3 System 자동 메시지

Council Server가 특정 이벤트를 감지하면 자동으로 시스템 메시지를 Room에 기록한다. 시스템 메시지는 `senderType: "system"`으로 표시되며 회색 박스로 렌더링된다.

**시스템 메시지 트리거 목록:**

| 이벤트 | 메시지 예시 | 포함 액션 버튼 |
|---|---|---|
| 프로젝트 생성 | "프로젝트 '사내 메신저'가 생성되었습니다." | — |
| 리더 입장 | "백엔드팀 리더가 Council에 참여했습니다." | — |
| Git 커밋 푸시 | "Set B가 set-b/backend에 3개 커밋을 푸시했습니다. \n- feat: 채팅 API..." | [커밋 상세 보기] |
| PR 생성 | "PR #3 '백엔드 채팅 API'가 생성되었습니다. set-b/backend → main \| +423 -12" | [PR 보기] [코드 리뷰 요청] |
| PR 머지 | "PR #3이 main에 머지되었습니다. Set A, C worktree를 rebase합니다..." | — |
| rebase 완료 | "✅ Set A: rebase 성공 / ⚠️ Set C: 충돌 발생 (src/App.tsx)" | [충돌 해결 요청] |
| 태스크 상태 변경 | "태스크 '채팅 API 구현'이 In Progress → Done으로 변경되었습니다." | [보드에서 보기] |
| 태스크 생성 | "태스크 'DB 스키마 설계'가 생성되어 Set A에 할당되었습니다." | [보드에서 보기] |
| 세션 타임아웃 | "⚠️ 백엔드팀 세션이 응답 없음(120초). 재시작을 시도합니다..." | [수동 재시작] |
| 세션 복원 | "✅ 백엔드팀 세션이 복원되었습니다. 이전 컨텍스트 주입 완료." | — |
| Room 일시정지 | "Council Room이 일시정지되었습니다. 리더 응답이 중단됩니다." | [재개] |
| Room 종료 | "Council Room이 종료되었습니다. 히스토리는 보존됩니다." | — |

**시스템 메시지 Firestore 구조:**

```typescript
{
  senderId: "system",
  senderName: "시스템",
  senderType: "system",
  content: string,           // 메시지 본문 (마크다운 지원)
  metadata: {
    eventType: SystemEventType,
    eventPayload: object,    // 이벤트별 추가 데이터 (커밋 정보, PR 번호 등)
    inlineActions?: InlineAction[],
  },
  timestamp: Timestamp,
}
```

---

## 5. 리더 참여/퇴장 관리

### 5.1 리더 입장 플로우

Council Server가 Set을 생성하면 해당 Set의 리더 세션이 Council Room에 참여한다.

```
sequenceDiagram
    participant CS as Council Server
    participant Session as 리더 세션 (Claude Code)
    participant FS as Firestore
    participant UI as Web UI

    CS->>Session: 세션 시작 (시스템 프롬프트 + 역할 + 프로젝트 컨텍스트)
    Session->>CS: 세션 준비 완료 신호
    CS->>FS: sets/{setId}.status = "idle"\nsets/{setId}.sessionAlive = true
    CS->>FS: rooms/{roomId}/messages 에 입장 시스템 메시지 기록
    CS->>Session: 입장 인사 요청 ("Council Room에 입장하여 자기소개를 해주세요")
    Session->>CS: 자기소개 응답
    CS->>FS: rooms/{roomId}/messages 에 리더 자기소개 메시지 기록
    FS-->>UI: onSnapshot → 입장 메시지 + 자기소개 표시
    FS-->>UI: onSnapshot → Left Panel Set 상태 업데이트 (초록 점 표시)
```

**입장 시 리더에게 주입되는 시스템 프롬프트 구조:**

```
당신은 {setName}의 리더입니다.
역할: {role 프롬프트}
프로젝트: {projectName} ({projectDescription})
현재 참여 중인 Council Room: {roomName} (목적: {purposeHint})

참여 중인 다른 리더들:
- {otherLeaderName}: {otherLeaderRole}
...

Council Room 규칙:
- 다른 리더의 발언을 존중하고 건설적으로 응답하세요.
- 의사결정이 필요한 사안은 PM에게 명확히 에스컬레이션하세요.
- Set 내부 작업 세부사항은 요약하여 보고하세요.
- 응답은 간결하게 (대화체, 3~5문장 권장). 긴 내용은 아티팩트로 첨부하세요.
```

### 5.2 리더 퇴장 플로우

**정상 퇴장 (Room 종료 또는 Set 삭제):**

```
CS->>Session: 퇴장 알림 ("Council Room이 종료됩니다. 마무리 발언을 해주세요.")
Session->>CS: 마무리 메시지
CS->>FS: 마무리 메시지 기록
CS->>Session: 세션 종료
CS->>FS: sets/{setId}.sessionAlive = false
CS->>FS: 퇴장 시스템 메시지 기록
```

**비정상 퇴장 (세션 크래시/타임아웃):**

```
CS->>FS: sets/{setId}.sessionAlive = false
CS->>FS: 세션 오류 시스템 메시지 기록 (⚠️ 표시)
CS->>CS: 재시작 시도 로직 실행 (§11 에러 케이스 참조)
```

### 5.3 리더 상태 표시

Left Panel의 Set 상태는 Firestore `sets/{setId}.status`를 실시간으로 반영한다.

| status 값 | UI 표시 | 의미 |
|---|---|---|
| `idle` | 🟢 (초록 점) | 세션 활성, 대기 중 |
| `working` | 🔄 (회전 아이콘) | 현재 응답 생성 중 |
| `waiting` | ⏳ (모래시계) | 다른 Set의 완료 또는 PM 응답 대기 |
| `done` | ✅ (체크) | 할당된 작업 완료 |
| `error` | ❌ (빨간 X) | 세션 오류 |
| `paused` | ⏸ (일시정지) | Room 일시정지로 응답 중단 (UI 표시 전용 — Firestore Set 문서에 저장되는 status 값이 아님. Room이 paused 상태일 때 Set 카드에 표시하는 시각적 상태) |

---

## 6. 대화 턴 관리

여러 리더가 동시에 응답하면 메시지가 뒤섞이거나 응답이 충돌할 수 있다. Council Server는 턴 큐(Turn Queue)를 통해 응답 순서를 관리한다.

### 6.1 턴 큐 구조

```typescript
interface TurnQueue {
  roomId: string
  currentTurn: ActiveTurn | null   // 현재 응답 중인 리더
  queue: PendingTurn[]              // 대기 중인 응답 요청
  mode: TurnMode
}

interface ActiveTurn {
  setId: string
  startedAt: number               // Date.now()
  timeoutMs: number               // 기본 120,000ms (2분)
}

interface PendingTurn {
  setId: string
  triggeredBy: string             // 트리거가 된 메시지 ID
  priority: number                // 낮을수록 먼저 (1: 멘션된 리더, 2: 일반)
  enqueuedAt: number
}

type TurnMode = "sequential" | "parallel" | "mention_only"
```

### 6.2 턴 모드

**Sequential 모드 (기본):**
한 번에 한 명의 리더만 응답한다. PM 메시지가 오면 Council Server가 리더들을 순서대로 응답시킨다. 응답 순서는 아래 우선순위를 따른다.

1. `@멘션`된 리더 (예: "@백엔드팀 API 설계 어떻게 할 거야?")
2. 직전 발언자에게 직접 질문받은 리더
3. 역할상 관련도가 높은 리더 (Council Server가 판단)
4. 나머지 리더 (입장 순서대로)

```
PM: "인증 방식 어떻게 할까요?"

턴 큐:
  [1] 아키텍처팀 (역할 관련도 최고)
  [2] 백엔드팀   (구현 담당)
  [3] 프론트팀   (사용 측)
  [4] QA팀       (검증 담당)

실행:
  → 아키텍처팀 응답 → Firestore 저장
  → 백엔드팀 응답 → Firestore 저장
  → 프론트팀 응답 → Firestore 저장
  → QA팀 응답 → Firestore 저장
```

**Parallel 모드 (PM이 명시적 설정 시):**
모든 리더가 동시에 응답을 생성한다. 응답이 완료되는 순서대로 Firestore에 기록된다. 빠른 브레인스토밍에 유용하지만, 리더들이 서로의 응답을 참고하지 못한다.

**Mention-only 모드 (PM이 설정 시):**
`@멘션`된 리더만 응답한다. 특정 리더에게만 지시를 내릴 때 사용.

### 6.3 턴 타임아웃

리더가 설정 시간 내에 응답하지 않으면 Council Server가 타임아웃 처리한다.

```
sequenceDiagram
    participant CS as Council Server
    participant FS as Firestore
    participant UI as Web UI

    CS->>CS: 턴 시작 (timeoutMs = 120,000)
    Note over CS: ... 120초 경과 ...
    CS->>FS: 타임아웃 시스템 메시지 기록\n"⏱️ 백엔드팀이 120초 내에 응답하지 않았습니다."
    CS->>CS: 다음 턴으로 이동 (큐 pop)
    CS->>UI: WebSocket 타이핑 인디케이터 제거
```

### 6.4 리더 간 상호 참조

Sequential 모드에서 나중에 응답하는 리더는 앞선 리더들의 응답을 컨텍스트로 받는다. 이를 통해 리더 간 자연스러운 대화가 형성된다.

```typescript
// Council Server가 리더에게 전달하는 컨텍스트 예시
const context = {
  triggerMessage: {
    sender: "PM",
    content: "인증 방식 어떻게 할까요?"
  },
  previousResponses: [
    {
      sender: "아키텍처팀",
      content: "JWT + Refresh Token 방식을 권장합니다. Redis로 Refresh Token을 관리하면..."
    }
  ],
  yourTurn: "백엔드팀"
}
```

---

## 7. 인라인 액션

대화 내에서 별도 페이지 이동 없이 핵심 액션을 수행할 수 있다.

### 7.1 지원하는 인라인 액션 목록

| 액션 유형 | 트리거 조건 | UI 컴포넌트 | 실행 결과 |
|---|---|---|---|
| 태스크 등록 | "태스크로 등록해" 키워드 또는 리더가 제안 | 태스크 카드 인라인 표시 | Firestore tasks에 생성, 보드에 표시 |
| PR 보기 | PR 생성 시스템 메시지 | [PR 보기] 버튼 | GitHub PR 페이지 열기 (새 탭) |
| 코드 리뷰 요청 | PR 생성 시스템 메시지 | [코드 리뷰 요청] 버튼 | QA 리더에게 리뷰 요청 메시지 자동 발송 |
| PR 머지 | PM이 승인 발언 | [머지] 버튼 (PM만 표시) | Council Server → GitHub API 머지 실행 |
| 리더에게 지시 | 태스크 카드 | [작업 시작] 버튼 | 해당 리더 세션에 태스크 착수 지시 |
| 충돌 해결 요청 | rebase 충돌 시스템 메시지 | [충돌 해결 요청] | 충돌 당사자 리더에게 해결 지시 |
| 세션 재시작 | 세션 오류 시스템 메시지 | [수동 재시작] | 해당 Set 세션 강제 재시작 |
| 상태 저장 | 언제든지 | [상태 저장] 버튼 (입력창 근처) | 현재 프로젝트 스냅샷 즉시 생성 |

### 7.2 태스크 등록 인라인 플로우

```
sequenceDiagram
    actor PM
    participant UI as Web UI
    participant CS as Council Server
    participant FS as Firestore

    PM->>UI: "DB 스키마 설계를 태스크로 등록해줘"
    UI->>FS: PM 메시지 기록
    FS-->>CS: PM 메시지 감지
    CS->>CS: "태스크로 등록" 키워드 감지
    CS->>UI: WebSocket → 태스크 등록 모달 트리거
    UI->>PM: 태스크 카드 편집 UI 표시\n(제목 자동 추출: "DB 스키마 설계"\n 담당 Set, 우선순위 선택)
    PM->>UI: [등록] 확인
    UI->>CS: POST /api/projects/{id}/tasks
    CS->>FS: tasks/{taskId} 문서 생성
    CS->>FS: rooms/{roomId}/messages 에 태스크 카드 메시지 기록\n(senderType: "system", metadata.inlineActions: [{type: "view_board"}])
    FS-->>UI: 보드에 태스크 추가 + 채팅에 카드 표시
```

**채팅 내 태스크 카드 렌더링:**

```
┌─ 📋 태스크 등록됨 ──────────────────────────┐
│                                               │
│  DB 스키마 설계                               │
│  담당: 🎯 아키텍처팀   우선순위: 🔴 High     │
│  상태: Backlog                                │
│                                               │
│  [보드에서 보기]   [작업 시작]                │
└───────────────────────────────────────────────┘
```

### 7.3 PR 인라인 리뷰 플로우

```
sequenceDiagram
    actor PM
    participant CS as Council Server
    participant QALeader as QA 리더 세션
    participant FS as Firestore

    Note over FS: 시스템 메시지: "PR #3 생성됨"
    PM->>CS: [코드 리뷰 요청] 버튼 클릭
    CS->>QALeader: 리뷰 요청 메시지 전달\n(PR diff, 파일 목록, 관련 태스크 컨텍스트)
    QALeader->>CS: 리뷰 코멘트 생성
    CS->>FS: 리뷰 코멘트 메시지 기록 (senderType: "leader")
    CS->>FS: pullRequests/{prId}.reviewNotes 에 코멘트 추가
    FS-->>PM: 채팅에 리뷰 결과 표시
```

---

## 8. 대화 컨텍스트 관리

리더 세션에 전달되는 메시지 히스토리는 컨텍스트 윈도우 한계를 고려하여 구성된다.

### 8.1 컨텍스트 구성 전략

Council Server는 리더에게 메시지를 전달할 때 다음 3개 레이어를 조합한다.

```
┌─────────────────────────────────────────────────────┐
│  Layer 1: 고정 컨텍스트 (매 요청 포함)               │
│  - 리더 역할 프롬프트                                 │
│  - 프로젝트 기본 정보                                 │
│  - Room purpose 힌트                                 │
│  - 현재 태스크 보드 상태 (진행 중 태스크만)            │
│  - Git 현재 상태 (브랜치, 열린 PR)                    │
│  예상 토큰: ~500~1,000                               │
├─────────────────────────────────────────────────────┤
│  Layer 2: 스냅샷 컨텍스트 (세션 시작 시 또는 복원 시) │
│  - 최신 프로젝트 상태 스냅샷                          │
│  - 주요 의사결정 사항                                 │
│  예상 토큰: ~500~1,500                               │
├─────────────────────────────────────────────────────┤
│  Layer 3: 슬라이딩 윈도우 메시지 히스토리             │
│  - 최근 N개 메시지 (기본값: 30개)                     │
│  - 시스템 메시지는 요약 형태로 압축                   │
│  - Set 내부 로그는 제외                              │
│  예상 토큰: ~2,000~8,000                             │
└─────────────────────────────────────────────────────┘
```

### 8.2 슬라이딩 윈도우 크기 조정

```typescript
interface ContextWindowConfig {
  maxMessages: number           // 기본: 30
  maxTokensForHistory: number   // 기본: 8,000
  systemMessageCompression: boolean  // 시스템 메시지 압축 여부 (기본: true)
  includeInternalLogs: boolean  // Set 내부 로그 포함 여부 (기본: false)
}

// 토큰 예산 초과 시 오래된 메시지부터 제거
function trimHistory(messages: Message[], budget: number): Message[] {
  let totalTokens = 0
  const result: Message[] = []
  for (const msg of [...messages].reverse()) {
    const tokens = estimateTokens(msg.content)
    if (totalTokens + tokens > budget) break
    result.unshift(msg)
    totalTokens += tokens
  }
  return result
}
```

### 8.3 시스템 메시지 압축

여러 시스템 메시지(Git 커밋, 태스크 변경 등)는 컨텍스트 구성 시 요약 형태로 압축된다.

```
원본 (3개 시스템 메시지):
  [시스템] Set B가 3개 커밋 푸시: feat: 채팅 API, feat: WebSocket, fix: CORS
  [시스템] PR #3 '백엔드 채팅 API' 생성됨
  [시스템] 태스크 '백엔드 API 구현' In Progress → Review

압축 후 (1개):
  [시스템 요약] Set B: 커밋 3개 푸시, PR #3 생성, 태스크 '백엔드 API 구현' Review 상태
```

### 8.4 리더별 컨텍스트 차별화

같은 Room이라도 리더마다 받는 컨텍스트가 다를 수 있다.

```typescript
function buildContextForLeader(setId: string, roomId: string): ContextPayload {
  const set = getSet(setId)
  const recentMessages = getRecentMessages(roomId, 30)
  const snapshot = getLatestSnapshot(set.projectId)

  return {
    role: set.role,
    project: getProjectSummary(set.projectId),
    myTasks: getTasksForSet(setId),       // 자기 Set의 태스크만
    allTasks: getInProgressTasks(),        // 전체 진행 중 태스크
    myBranch: getBranchStatus(set.branch), // 자기 브랜치 상태
    recentMessages,
    snapshot,
    purposeHint: getRoomPurposeHint(roomId),
  }
}
```

---

## 9. 메시지 검색

### 9.1 검색 범위

- 기본: 현재 열려 있는 Room의 메시지
- 확장: 같은 프로젝트 내 모든 Room 검색 (체크박스로 전환)

### 9.2 검색 기능 명세

| 기능 | 설명 |
|---|---|
| 키워드 검색 | 메시지 본문에서 텍스트 검색 (대소문자 구분 없음) |
| 발신자 필터 | PM / 특정 리더 / 시스템으로 필터링 |
| 날짜 범위 필터 | 기간 지정 검색 |
| 태스크 연결 검색 | 특정 태스크 ID와 연결된 메시지 검색 |
| PR 연결 검색 | 특정 PR과 연결된 메시지 검색 |
| 검색 결과 하이라이트 | 키워드가 포함된 메시지를 채팅 뷰에서 하이라이트 |
| 검색 결과 클릭 | 해당 메시지로 채팅 뷰 스크롤 이동 |

### 9.3 검색 구현

Firestore는 전문 검색(Full-text search)을 지원하지 않으므로, 두 가지 방법을 단계적으로 적용한다.

**Phase 1 — 클라이언트 사이드 검색:**

```typescript
// 최근 500개 메시지를 메모리에서 검색 (소규모 프로젝트에 적합)
function searchMessages(messages: Message[], query: string): Message[] {
  const lower = query.toLowerCase()
  return messages.filter(m => m.content.toLowerCase().includes(lower))
}
```

**Phase 2 — Firestore 복합 쿼리 + 클라이언트 필터링:**

```typescript
// 발신자 필터 + 날짜 범위는 Firestore 쿼리로, 키워드는 클라이언트에서
const q = query(
  collection(db, `rooms/${roomId}/messages`),
  where('senderType', '==', filterType),
  where('timestamp', '>=', startDate),
  where('timestamp', '<=', endDate),
  orderBy('timestamp', 'desc'),
  limit(200)
)
```

---

## 10. Room 상태 관리

### 10.1 상태 전이 다이어그램

```
         프로젝트 생성
              │
              ▼
         ┌─────────┐
         │ active  │◄─────── 재개(resume)
         └────┬────┘
              │ 일시정지(pause)
              ▼
         ┌─────────┐
         │ paused  │
         └────┬────┘
              │ 종료(complete)
              ▼
         ┌───────────┐
         │ completed │
         └───────────┘
```

**상태별 동작:**

| 상태 | 리더 응답 | PM 메시지 | 시스템 메시지 | 새 Room 생성 |
|---|---|---|---|---|
| `active` | 정상 동작 | 가능 | 자동 기록 | 가능 |
| `paused` | 중단 | 가능 (큐 보관) | 기록됨 | 불가 |
| `completed` | 불가 | 읽기 전용 | 기록 안 됨 | 불가 |

### 10.2 일시정지 플로우

```
sequenceDiagram
    actor PM
    participant CS as Council Server
    participant Session as 리더 세션들
    participant FS as Firestore

    PM->>CS: PATCH /api/projects/{id}/rooms/{roomId}\n{ status: "paused" }
    CS->>FS: rooms/{roomId}.status = "paused"
    CS->>Session: 일시정지 알림 (현재 응답 중이면 완료 후 중단)
    CS->>FS: 일시정지 시스템 메시지 기록
    CS->>FS: 스냅샷 자동 저장 (세션 상태 보존)
    FS-->>PM: UI → Room 상태 배지 "일시정지"로 변경
    Note over CS,Session: PM 메시지는 큐에 보관 (최대 50개)\n재개 시 순서대로 처리
```

### 10.3 재개 플로우

```
sequenceDiagram
    actor PM
    participant CS as Council Server
    participant Session as 리더 세션들
    participant FS as Firestore

    PM->>CS: PATCH /api/projects/{id}/rooms/{roomId}\n{ status: "active" }
    CS->>FS: rooms/{roomId}.status = "active"

    alt 세션 아직 살아있음
        CS->>Session: 재개 알림
    else 세션 종료됨
        CS->>CS: 스냅샷 로드 + 새 세션 시작 + 컨텍스트 주입
    end

    CS->>CS: 큐에 보관된 PM 메시지 순서대로 처리
    CS->>FS: 재개 시스템 메시지 기록
    FS-->>PM: UI → Room 상태 배지 "활성"으로 변경
```

### 10.4 종료 플로우

```
sequenceDiagram
    actor PM
    participant CS as Council Server
    participant Session as 리더 세션들
    participant FS as Firestore

    PM->>CS: PATCH /api/projects/{id}/rooms/{roomId}\n{ status: "completed" }
    CS->>Session: 종료 예고 ("Council Room이 종료됩니다. 마무리 발언을 해주세요.")
    Session->>CS: 마무리 메시지 (각 리더)
    CS->>FS: 마무리 메시지들 기록
    CS->>FS: 프로젝트 최종 스냅샷 저장
    CS->>Session: 세션 종료 (tmux 세션 kill)
    CS->>FS: rooms/{roomId}.status = "completed"
    CS->>FS: 종료 시스템 메시지 기록
    FS-->>PM: UI → Room 읽기 전용 표시
```

**종료 시 유의사항:**
- 종료된 Room의 메시지는 영구 보존된다 (Firestore에 남음)
- 메인 Room(`purpose: "main"`)은 프로젝트가 `completed` 또는 `archived` 상태일 때만 종료 가능
- 프로젝트 아카이브 시 모든 Room이 자동으로 `completed` 상태로 전환된다

---

## 11. 에러 케이스

### 11.1 Claude 세션 크래시

```
sequenceDiagram
    participant CS as Council Server
    participant Session as 리더 세션 (크래시)
    participant FS as Firestore
    participant UI as Web UI

    Session--xCS: 프로세스 종료 (예기치 않은 종료)
    CS->>CS: 세션 heartbeat 실패 감지 (10초 간격 체크)
    CS->>FS: sets/{setId}.sessionAlive = false\nsets/{setId}.status = "error"
    CS->>FS: 에러 시스템 메시지 기록\n"⚠️ 백엔드팀 세션이 비정상 종료되었습니다. 재시작 시도 중..."
    FS-->>UI: Set 상태 ❌ 표시

    CS->>CS: 자동 재시작 (최대 3회 시도, 지수 백오프: 5s, 15s, 45s)

    alt 재시작 성공
        CS->>CS: 스냅샷 로드 + 컨텍스트 주입
        CS->>FS: sets/{setId}.sessionAlive = true\nstatus = "idle"
        CS->>FS: 복원 성공 시스템 메시지 기록
        FS-->>UI: Set 상태 🟢 복원
    else 재시작 실패 (3회 모두 실패)
        CS->>FS: 영구 실패 시스템 메시지 기록\n"❌ 백엔드팀 세션 복원 실패. 수동 재시작이 필요합니다."
        CS->>UI: WebSocket → PM에게 알림 푸시
        FS-->>UI: [수동 재시작] 버튼 표시
    end
```

### 11.2 응답 타임아웃

리더가 메시지를 받은 후 `timeoutMs` (기본 120초) 내에 응답하지 않으면:

```typescript
async function handleTurnTimeout(setId: string, roomId: string) {
  // 1. 타임아웃 시스템 메시지 기록
  await writeSystemMessage(roomId, {
    content: `⏱️ ${getSetName(setId)}이(가) 120초 내에 응답하지 않았습니다. 다음 순서로 넘어갑니다.`,
    eventType: 'turn_timeout',
    eventPayload: { setId, timeoutMs: 120_000 }
  })

  // 2. 현재 턴 종료, 다음 턴으로 이동
  turnQueue.advanceToNext(roomId)

  // 3. 해당 리더 세션에 ping (살아있는지 확인)
  const alive = await pingSession(setId)
  if (!alive) {
    // 크래시로 처리 (§11.1 플로우로 이동)
    handleSessionCrash(setId, roomId)
  }
}
```

### 11.3 Rate Limit (Anthropic API)

```typescript
async function handleRateLimit(setId: string, error: RateLimitError) {
  const retryAfterMs = error.retryAfter * 1000  // API 헤더에서 추출

  // 1. Rate limit 시스템 메시지 기록
  await writeSystemMessage(roomId, {
    content: `⚠️ ${getSetName(setId)}: API 한도 초과. ${Math.ceil(retryAfterMs / 1000)}초 후 재시도합니다.`,
    eventType: 'rate_limit',
    eventPayload: { setId, retryAfterMs }
  })

  // 2. 해당 리더 응답을 지연 큐로 이동
  turnQueue.delayTurn(setId, retryAfterMs)

  // 3. 대기 중 타이머 UI 표시 (WebSocket)
  wsServer.broadcast(roomId, {
    type: 'rate_limit_countdown',
    setId,
    remainingMs: retryAfterMs
  })

  // 4. 대기 후 자동 재시도
  await sleep(retryAfterMs)
  turnQueue.requeueTurn(setId)
}
```

### 11.4 Firestore 쓰기 실패

메시지 Firestore 저장에 실패하면 UI에 일시 오류를 표시하고, 재시도 로직을 실행한다.

```typescript
// 클라이언트 측 재시도
async function writeMessageWithRetry(message: Message, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await addDoc(messagesRef, message)
      return
    } catch (err) {
      if (attempt === maxRetries) {
        // 최종 실패 시 로컬 큐에 보관 후 사용자에게 표시
        localQueue.push(message)
        showErrorToast("메시지 전송 실패. 네트워크 연결을 확인하세요.")
        return
      }
      await sleep(Math.pow(2, attempt) * 500)  // 500ms, 1s, 2s
    }
  }
}
```

### 11.5 에러 케이스 요약표

| 에러 상황 | 감지 방법 | 자동 복구 | PM 알림 |
|---|---|---|---|
| 세션 크래시 | heartbeat 실패 (10초 간격) | 최대 3회 자동 재시작 | 3회 실패 시 |
| 응답 타임아웃 | 타이머 (기본 120초) | 다음 턴으로 이동 | 타임아웃 발생 시 |
| Rate limit | API 429 응답 | 지정 시간 후 자동 재시도 | 발생 시 카운트다운 표시 |
| Firestore 쓰기 실패 | 예외 처리 | 최대 3회 재시도 | 최종 실패 시 토스트 |
| 컨텍스트 윈도우 초과 | 토큰 카운트 | 히스토리 자동 트리밍 | 없음 (자동 처리) |
| 세션 메모리 부족 | OOM 신호 | 세션 재시작 + 컨텍스트 주입 | 재시작 발생 시 |
| GitHub API 실패 | HTTP 오류 응답 | 재시도 없음 | 즉시 시스템 메시지 |

---

## 12. 데이터 모델 요약

### 12.1 Firestore 컬렉션 경로

```
projects/{projectId}/rooms/{roomId}
  ├── name: string
  ├── purpose: "main" | "design" | "bug_triage" | "code_review" | "integration" | "custom"
  ├── status: "active" | "paused" | "completed"
  ├── participantSetIds: string[]
  ├── turnMode: "sequential" | "parallel" | "mention_only"
  ├── messageCount: number
  ├── lastMessageAt: Timestamp | null
  ├── createdAt: Timestamp
  └── updatedAt: Timestamp

projects/{projectId}/rooms/{roomId}/messages/{messageId}
  ├── senderId: string             // userId (PM) 또는 setId (리더) 또는 "system"
  ├── senderName: string
  ├── senderType: "human" | "leader" | "system"
  ├── content: string              // 마크다운 허용
  ├── replyTo?: string             // 답장 대상 messageId
  ├── metadata?: {
  │     artifacts?: string[]
  │     taskRefs?: string[]
  │     commitHash?: string
  │     pullRequestUrl?: string
  │     tokenUsage?: number
  │     inlineActions?: InlineAction[]
  │     eventType?: SystemEventType
  │     eventPayload?: object
  │     thinkingDuration?: number
  │   }
  ├── isEdited?: boolean
  ├── editedAt?: Timestamp
  └── timestamp: Timestamp
```

### 12.2 InlineAction 타입 정의

```typescript
type InlineActionType =
  | "view_pr"
  | "request_code_review"
  | "merge_pr"
  | "view_board"
  | "start_task"
  | "resolve_conflict"
  | "restart_session"
  | "save_snapshot"
  | "view_commit"

interface InlineAction {
  type: InlineActionType
  label: string              // 버튼에 표시될 텍스트
  payload: object            // 액션 실행에 필요한 데이터 (prId, taskId 등)
  visibleTo?: "pm_only" | "all"  // 기본: "all"
  disabled?: boolean
}
```

### 12.3 Firestore 복합 인덱스 (필요 목록)

```json
[
  {
    "collectionGroup": "messages",
    "queryScope": "COLLECTION",
    "fields": [
      { "fieldPath": "senderType", "order": "ASCENDING" },
      { "fieldPath": "timestamp", "order": "DESCENDING" }
    ]
  },
  {
    "collectionGroup": "messages",
    "queryScope": "COLLECTION",
    "fields": [
      { "fieldPath": "metadata.taskRefs", "arrayConfig": "CONTAINS" },
      { "fieldPath": "timestamp", "order": "DESCENDING" }
    ]
  },
  {
    "collectionGroup": "rooms",
    "queryScope": "COLLECTION",
    "fields": [
      { "fieldPath": "status", "order": "ASCENDING" },
      { "fieldPath": "createdAt", "order": "DESCENDING" }
    ]
  }
]
```

---

## 관련 문서

- [PLAN.md](../PLAN.md) — §2.1 Council Room, §7.1~7.2 핵심 플로우
- [01_아키텍처/](../01_아키텍처/) — Council Server 구조
- [02_데이터설계/](../02_데이터설계/) — Firestore 스키마 전체
- [05_기능명세/01_프로젝트_관리.md](./01_프로젝트_관리.md) — 프로젝트 생성 플로우 (연계)
- [05_기능명세/03_Agent_Set.md](./03_Agent_Set.md) — Set 내부 작업 상세
- [../00_설정_참조표.md](../00_설정_참조표.md) — Firestore 경로, 포트, 전역 설정값 단일 출처
