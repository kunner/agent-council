---
status: DRAFT
priority: 3
last_updated: 2026-03-23
---

# Phase 2 구현 순서 가이드

## Phase 2 목표

**"Git 워크플로우 완성 + Set 내부 Agent Teams + 세션 관리"**

Phase 1이 "AI 리더들이 대화하며 코드를 작성하는 최소 동작 버전"이었다면,
Phase 2는 **실제 개발 현장에서 쓸 수 있는 완전한 개발 루프**를 완성하는 단계다.

완성 기준: `대화 → 태스크 → 코딩 → PR → 리뷰 → 머지` 전체 사이클이 끊김 없이 동작

---

## Phase 1 → Phase 2 전환 조건

Phase 2를 시작하기 전에 Phase 1의 모든 항목이 완료되어야 한다.

### Phase 1 완료 기준 체크리스트

| 항목 | 검증 방법 |
|---|---|
| 웹 브라우저에서 PM이 메시지를 보내면 AI 리더 3명 이상이 역할에 맞게 응답 | 실제 대화 시연 |
| 리더 간 대화가 자연스럽게 이어짐 (상호 참조, 합의) | 대화 흐름 확인 |
| 프로젝트 생성 → Set 생성 → Git worktree 생성 자동 완료 | 파일시스템 확인 |
| 리더의 지시로 실제 코드가 Set 브랜치에 커밋됨 | `git log` 확인 |
| Firestore 실시간 리스너로 채팅 메시지 동기화 | 멀티 탭 테스트 |
| Firebase Auth (Google) 로그인 동작 | 실제 로그인 |
| Cloudflare Pages + 도메인 외부 접속 가능 | 외부 URL 접속 |
| Oracle Ampere에 Council Server 배포 완료 | 서버 상태 확인 |

**모든 항목이 체크되지 않으면 Phase 2를 시작하지 않는다.**
미완료 항목이 있을 경우 Phase 1을 먼저 완성한다.

---

## 구현 순서 개요

Phase 2는 6개 Step으로 구성된다. 각 Step은 **완전히 독립 동작 가능한 단위**로 설계되었으며,
Step 순서는 의존성 기준으로 정렬되어 있다.

```
Step 1: Git 워크플로우 완성         ← PR·머지·rebase 자동화
Step 2: 태스크 보드                 ← 칸반 UI + 대화 연동
Step 3: MCP Channel 어댑터          ← 장기 세션 + Agent Teams 활성화
Step 4: Set 내부 팀워크             ← 팀원 로그 수집 + UI 표시
Step 5: 세션 관리                   ← 스냅샷 + 복원 + PM 부재 정책
Step 6: BYOK                        ← 사용자별 API 키 암호화 저장
```

Step 1~2는 병렬 진행 가능.
Step 3은 Step 1 완료 후 시작 (worktree 기반 세션이 전제).
Step 4는 Step 3 완료 후 시작 (Agent Teams Channel 필요).
Step 5는 Step 3 완료 후 시작 (장기 세션 구조 전제).
Step 6은 어느 시점에나 독립 진행 가능.

---

## Step 1: Git 워크플로우 완성

### 목표

Set별 worktree 생명주기를 완전히 자동화하고, GitHub PR 생성/머지/rebase를 Council Server가 주도한다.

### 선행 조건

- Phase 1의 Git 기본 연동 완료 (`git init`, `clone`, `status`)
- `packages/server/src/git/` 디렉토리 기본 구조 존재
- Set 생성 시 worktree 경로가 Firestore `sets/{setId}.worktreePath`에 저장된 상태

### 구현 세부 항목

#### 1-1. Worktree 자동 관리

Set 생성/삭제 시 worktree를 자동으로 생성하고 정리한다.

```
생성 흐름:
  Set 생성 이벤트
    → git worktree add /workspace/{projectId}/{setId} {branchName}
    → Firestore sets/{setId}.worktreePath 업데이트
    → 성공/실패 결과를 Council Room 시스템 메시지로 전송

삭제 흐름:
  Set 삭제 이벤트 또는 프로젝트 완료
    → git worktree remove /workspace/{projectId}/{setId} --force
    → Firestore 경로 정리
    → 연관 브랜치 삭제 여부 PM에게 확인 후 처리
```

브랜치 네이밍 규칙: `set-{setId}/{topic}` (예: `set-b/backend`)
worktree 루트: `/workspace/{projectId}/`

#### 1-2. GitHub API 연동 (PR 생성/머지)

Council Server에서 GitHub REST API를 호출하여 PR을 자동 생성한다.

```
PR 생성 트리거:
  1. 리더가 "PR 올립니다" 또는 "작업 완료" 발언
  2. Council Server가 발언을 인식하고 PR 생성 실행

PR 생성 흐름:
  → GitHub API: POST /repos/{owner}/{repo}/pulls
    { title, body, head: branchName, base: 'main' }
  → 생성된 PR URL을 Firestore projects/{id}/pullRequests에 저장
  → Council Room 시스템 메시지: "[시스템] PR #{n} '{title}' 생성됨"

머지 흐름:
  PM이 "머지해주세요" → GitHub API: PUT /repos/{owner}/{repo}/pulls/{n}/merge
    { merge_method: 'squash' | 'merge' | 'rebase' }
  → 머지 성공 → Step 1-4 (rebase) 트리거
```

필요한 설정:
- `projects/{id}/git/config.githubToken`: 암호화된 GitHub PAT (repo 권한)
- `packages/server/src/git/github.client.ts`: Octokit 또는 fetch 기반 클라이언트

#### 1-3. Git 이벤트 감지 → Council 알림

Council Server가 주기적으로 worktree 상태를 폴링하거나 파일시스템 이벤트를 감지하여 Council Room에 자동 알림을 보낸다.

```
감지 방식: 5초 주기 폴링 (chokidar 또는 setInterval + git status)

감지 이벤트 및 알림 메시지:
  - 새 커밋 푸시됨
      "[시스템] Set B가 set-b/backend에 {n}개 커밋을 푸시했습니다."
      "  - {커밋 메시지 1}"
      "  - {커밋 메시지 2}"

  - PR 상태 변경 (open → merged/closed)
      "[시스템] PR #{n} '{title}'이 {상태}되었습니다."

  - 충돌 감지
      "[시스템] Set C의 worktree에서 충돌이 감지되었습니다. (src/App.tsx)"
      "Set C 리더에게 알림 전송."
```

알림 메시지는 Firestore `rooms/{roomId}/messages`에 `senderType: 'system'`으로 저장.

#### 1-4. 머지 후 자동 Rebase

특정 Set의 PR이 main에 머지되면, 다른 Set의 worktree들을 자동으로 rebase한다.

```
머지 완료 이벤트 수신
  → main 브랜치 pull (로컬 갱신)
  → 머지한 Set 외의 모든 활성 Set에 대해:
       cd /workspace/{projectId}/{setId}
       git fetch origin main
       git rebase origin/main

  → 각 Set별 결과 Council Room 알림:
       성공: "✅ Set A: rebase 성공 (main ahead {n} → {m})"
       충돌: "⚠️ Set C: 충돌 발생 ({파일명}) — Set C 리더에게 해결 요청"

  → 충돌 발생 시:
       Set 상태를 'blocked'로 변경
       Firestore sets/{setId}.status = 'blocked'
       해당 Set 리더에게 Council Room에서 @멘션
```

### 완료 조건

- [ ] Set 생성 시 worktree가 자동으로 생성되고 Firestore에 경로 저장됨
- [ ] 리더 발언으로 PR이 GitHub에 자동 생성되고 Council Room에 링크 공유됨
- [ ] PM "머지해주세요" 발언으로 PR이 머지됨
- [ ] 머지 후 다른 Set worktree가 자동 rebase되고 결과가 Council Room에 표시됨
- [ ] Git 이벤트(커밋, PR 생성, 머지)가 Council Room에 시스템 메시지로 나타남

### 리스크

| 리스크 | 대응 |
|---|---|
| GitHub PAT 권한 부족 (repo 스코프 없음) | 프로젝트 생성 시 토큰 권한 검증 및 오류 메시지 명확화 |
| Rebase 중 충돌로 worktree 손상 | `git rebase --abort` 폴백 + 수동 해결 안내 메시지 |
| 로컬 전용 프로젝트 (GitHub 없음) | GitHub 미연동 시 PR 기능 비활성화, 로컬 브랜치 머지만 지원 |
| 동시 rebase 경합 | 락 파일 기반 순차 처리 (`/workspace/{id}/.rebase.lock`) |

---

## Step 2: 태스크 보드

### 목표

Council 대화에서 합의된 내용을 태스크로 등록하고, 칸반 보드로 시각화한다.
태스크·브랜치·PR이 하나의 흐름으로 연결된다.

### 선행 조건

- Firestore `projects/{id}/tasks` 컬렉션 스키마 확정 (PLAN.md 6.1 참고)
- Web UI 기본 라우팅 완료 (`/p/{id}` Council Room 화면 동작)
- `@hello-pangea/dnd` 또는 `dnd-kit` 패키지 설치 완료

### 구현 세부 항목

#### 2-1. 칸반 UI 구현

Right Panel의 "보드" 탭에 4열 칸반 보드를 구현한다.

```
열 구성: Backlog | In Progress | Review | Done
추가 상태: Blocked (열 없이 카드에 배지 표시)

카드 정보 표시:
  - 태스크 제목
  - 담당 Set (Set 색상 도트 + 이름)
  - 우선순위 배지 (Critical/High/Medium/Low)
  - 연결된 PR 링크 (있을 경우)
  - 진행률 바 (0~100%, Set 로그 기반)

데스크톱: Right Panel 내 4열 표시
모바일: 하단 탭 → 풀스크린, 가로 스와이프로 열 전환
```

컴포넌트 위치: `packages/web/src/components/board/`

#### 2-2. 대화 → 태스크 연동 ("태스크로 등록해")

Council Room 대화에서 PM 또는 리더가 특정 발언을 하면 Council Server가 태스크를 자동 생성한다.

```
트리거 발언 패턴:
  - "태스크로 등록해"
  - "작업 항목으로 추가해"
  - "백로그에 올려줘"
  - 리더가 자체적으로 "태스크 생성: ..." 형식으로 발언

처리 흐름:
  PM: "좋아, 태스크로 등록해"
    → Council Server가 직전 대화 컨텍스트에서 태스크 정보 추출
      { title, description, assignedSetId, priority }
    → Firestore tasks 컬렉션에 생성
    → Council Room에 태스크 인라인 카드 표시:
         "[📋 태스크 생성됨]
          채팅 API 구현 | Set B | High
          [보드에서 보기]"
    → 태스크를 생성한 메시지 ID를 createdFromMessageId에 저장

직접 등록:
  PM이 보드 UI의 "+ 태스크 추가" 버튼으로 폼 입력
```

#### 2-3. 태스크 의존성 관리

태스크 간 선행 조건을 명시적으로 관리하여 작업 순서를 제어한다.

```
의존성 데이터 구조:
  tasks/{taskId}
    .dependencies: ["task-001", "task-002"]   ← 선행 태스크 ID 목록

의존성 표시 (UI):
  - 태스크 카드에 "⛔ 대기 중: task-001 완료 필요" 배지 표시
  - 선행 태스크가 done이 아닌 경우 해당 태스크를 blocked 상태로 자동 설정

의존성 순서 제어 (서버):
  태스크 상태가 done으로 변경될 때:
    → 해당 태스크를 dependencies에 포함한 모든 태스크를 조회
    → 조회된 태스크의 모든 선행 태스크가 done인지 확인
    → 조건 충족 시 태스크 상태를 blocked → backlog로 자동 전환
    → Council Room 시스템 메시지: "[시스템] {태스크 제목} 선행 작업 완료 → 작업 가능 상태"

태스크 생성 시 의존성 입력:
  - 보드 UI "+ 태스크 추가" 폼에 "선행 태스크" 다중 선택 필드 추가
  - 대화에서 자동 생성 시: "B태스크는 A태스크 완료 후 시작" 발언 패턴 감지
```

컴포넌트 위치: `packages/web/src/components/board/TaskDependencyBadge.tsx`

#### 2-4. 태스크 ↔ 브랜치 ↔ PR 연결

태스크·브랜치·PR은 단방향이 아닌 양방향으로 연결된다.

```
연결 데이터 구조:
  tasks/{taskId}
    .branch: "set-b/backend"        ← 담당 Set의 현재 브랜치
    .pullRequestUrl: "https://..."  ← 생성된 PR URL

  pullRequests/{prId}
    .relatedTaskIds: ["task-001"]   ← 연결된 태스크 ID 목록

UI 표시:
  - 태스크 카드 클릭 → 연결된 PR 링크 표시
  - PR 시스템 메시지에 "관련 태스크: [태스크 제목]" 표시
  - 태스크 상태 자동 전환:
      코드 커밋 시 → in_progress
      PR 생성 시 → review
      PR 머지 시 → done
```

#### 2-5. 드래그앤드롭

보드에서 카드를 끌어 열을 이동할 수 있다.

```
구현: @hello-pangea/dnd의 DragDropContext + Droppable + Draggable

동작 규칙:
  - PM만 드래그앤드롭으로 상태 변경 가능 (Set 리더는 읽기 전용)
  - 이동 완료 시 Firestore tasks/{id}.status 즉시 업데이트
  - 모바일에서는 드래그앤드롭 대신 카드 탭 → 상태 변경 드롭다운

터치 지원: @hello-pangea/dnd 터치 백엔드 활성화
```

### 완료 조건

- [ ] 4열 칸반 보드가 Right Panel 보드 탭에 렌더링됨
- [ ] "태스크로 등록해" 발언으로 태스크가 생성되고 보드에 나타남
- [ ] 태스크 카드에 담당 Set, 우선순위, PR 링크가 표시됨
- [ ] PR 머지 시 태스크 상태가 자동으로 done으로 전환됨
- [ ] 데스크톱에서 드래그앤드롭으로 열 이동이 동작함
- [ ] 모바일에서 가로 스와이프로 열 전환이 동작함

### 리스크

| 리스크 | 대응 |
|---|---|
| 발언에서 태스크 정보 추출 정확도 낮음 | 추출 후 확인 카드 표시, PM이 수정 가능한 인라인 폼 제공 |
| 드래그앤드롭 모바일 터치 이벤트 충돌 | 모바일에서 드래그앤드롭 비활성화 후 탭 기반 UI로 대체 |
| Firestore 실시간 업데이트와 낙관적 UI 불일치 | 상태 업데이트를 Firestore 응답 후 확정 (낙관적 업데이트 사용 안 함) |

---

## Step 3: MCP Channel 어댑터

### 목표

Phase 1의 CLI 기반 Claude Code 호출(`claude --message ...`)을 MCP Channel 기반 장기 세션으로 전환한다.
이를 통해 각 Set이 지속적인 컨텍스트를 유지하고, Agent Teams가 Set 내부에서 동작한다.

### 선행 조건

- Step 1 완료 (worktree 경로가 확정된 상태)
- Claude Code MCP Channel Protocol 문서 숙지
- `packages/server/src/adapters/` 디렉토리에 Phase 1 CLI 어댑터 코드 존재

### 구현 세부 항목

#### 3-1. CLI → Channel 전환

Phase 1 CLI 어댑터를 Channel 어댑터로 교체한다.

```
기존 (Phase 1):
  CouncilServer → spawn('claude', ['--message', prompt]) → stdout 파싱

신규 (Phase 2):
  CouncilServer → MCP Channel Server → Claude Code Session (장기 유지)

어댑터 인터페이스는 동일하게 유지 (Adapter 패턴):
  interface ClaudeAdapter {
    sendMessage(sessionId: string, message: string): Promise<string>
    startSession(setId: string, worktreePath: string): Promise<string>
    stopSession(sessionId: string): Promise<void>
    isAlive(sessionId: string): Promise<boolean>
  }

  CliAdapter: 기존 구현 (폴백용으로 보존)
  ChannelAdapter: 신규 구현

  어댑터 선택은 환경변수로 제어:
    CLAUDE_ADAPTER=channel (기본값, Phase 2)
    CLAUDE_ADAPTER=cli (폴백)
```

#### 3-2. 커스텀 Channel 서버 구현

각 Set마다 하나의 MCP Channel 서버 인스턴스를 실행한다.

```
위치: packages/server/src/adapters/channel/

구현 구조:
  ChannelServer
    ├── 포트 할당: 각 Set마다 고유 포트 (예: 8100 + setIndex)
    ├── Claude Code 세션 연결 (channel:// 프로토콜)
    ├── 메시지 큐: 순서 보장 (FIFO)
    └── Heartbeat: 30초 주기 ping/pong

세션 식별:
  sessionId = "{projectId}:{setId}"
  tmux 세션명 = "council-{projectId}-{setId}"

Council Server ↔ Channel Server 통신:
  내부 HTTP API (localhost 전용)
    POST /session/{id}/message   ← 메시지 전송
    GET  /session/{id}/status    ← 세션 상태 확인
    POST /session/{id}/start     ← 세션 시작
    POST /session/{id}/stop      ← 세션 종료
```

#### 3-3. 장기 세션 유지

Channel 서버가 tmux 세션을 통해 Claude Code 프로세스를 장기 유지한다.

```
tmux 세션 생명주기:
  시작: tmux new-session -d -s "council-{id}" -c {worktreePath}
        tmux send-keys -t "council-{id}" "claude --channel ..." Enter

  상태 확인: tmux has-session -t "council-{id}" && echo "alive"

  재시작 (세션 죽은 경우):
    1. tmux kill-session -t "council-{id}" 2>/dev/null
    2. 새 tmux 세션으로 재시작
    3. 스냅샷 컨텍스트 주입 (Step 5 연동)

세션 목록 관리:
  Firestore WebSocket 상태와 별개로 서버 메모리에서 관리
  서버 재시작 시: Firestore의 활성 Set 목록으로 세션 복구
```

#### 3-4. Agent Teams 활성화

Channel 어댑터로 전환하면 Set 내부에서 Agent Teams를 사용할 수 있다.

```
활성화 방법:
  Claude Code 세션 시작 시 시스템 프롬프트에 팀 구성 포함:
    "당신은 {팀이름} 리더입니다.
     팀원 {n}명이 당신의 지시를 받아 작업합니다.
     팀원에게 sub-task를 위임하고 결과를 취합해 Council Room에 보고하세요."

팀원 호출 방식 (Agent Teams):
  리더 → claude spawn "팀원 역할 프롬프트"
    팀원이 worktree 내에서 코드 작성
    완료 후 결과를 리더에게 반환

Set 내부 대화는 Council Room에 노출되지 않음:
  팀원 로그 → Firestore sets/{setId}/logs/{logId}
  Council Room에는 리더의 요약 발언만 표시
```

### 완료 조건

- [ ] `CLAUDE_ADAPTER=channel`로 설정 시 장기 세션이 시작됨
- [ ] tmux 세션 목록에 Set별 세션이 확인됨 (`tmux ls`)
- [ ] 브라우저를 닫고 다시 열어도 기존 세션이 살아있고 대화가 이어짐
- [ ] `CLAUDE_ADAPTER=cli`로 전환 시 Phase 1 동작 그대로 폴백됨
- [ ] Agent Teams를 통해 팀원이 코드를 작성하고 리더에게 결과를 반환함

### 리스크

| 리스크 | 대응 |
|---|---|
| MCP Channel Protocol API가 변경됨 (리서치 프리뷰) | Adapter 패턴 유지, CLI 폴백 항상 동작 보장 |
| tmux 세션이 예상치 못하게 종료됨 | 30초 주기 heartbeat + 자동 재시작 로직 구현 |
| Set이 많아질수록 포트 관리 복잡 | 동적 포트 할당 + 포트 맵 메모리 관리 |
| Agent Teams 내 팀원 간 컨텍스트 불일치 | 리더가 각 팀원 호출 시 공유 컨텍스트를 매번 주입 |

---

## Step 4: Set 내부 팀워크

### 목표

Set 내부에서 팀원들이 수행하는 작업 로그를 수집하고, Council Room에서 PM이 접기/펼치기로 확인할 수 있게 한다.

### 선행 조건

- Step 3 완료 (Channel 어댑터 + Agent Teams 동작)
- Firestore `sets/{setId}/logs` 서브컬렉션 스키마 확정

### 구현 세부 항목

#### 4-1. 팀원 로그 수집

팀원의 모든 작업 이벤트를 Firestore에 기록한다.

```
로그 생성 시점:
  - 팀원이 파일 생성/수정 완료
  - 코드 컴파일/빌드 결과
  - 테스트 실행 결과
  - 오류 발생
  - 팀원 작업 완료 (리더에게 결과 반환)

로그 항목 구조 (Firestore):
  sets/{setId}/logs/{logId}
    content: "B-1: ChatController.java 생성 완료 (240줄)"
    type: 'info' | 'code' | 'error' | 'progress'
    teammateIndex: 1        ← 팀원 번호
    timestamp: Timestamp

로그 수집 방법:
  Channel 어댑터가 팀원의 stdout/이벤트를 인터셉트하여
  Firestore에 저장 (PM이 실시간으로 볼 수 있음)
```

#### 4-2. Council Room 요약 표시

리더가 Council Room에 보고할 때 팀 내부 진행 상황이 함께 표시된다.

```
표시 형식 (Council Room 채팅 인라인):
  ┌─ 🟢 백엔드팀 내부 작업 ──────────── ▲ 접기 ─┐
  │ B-1: Entity + Repository 완료        ✅      │
  │ B-2: WebSocket 핸들러 작업 중        🔄      │
  │ B-3: REST API 대기 중               ⏳      │
  └────────────────────────────────────────────┘

표시 조건:
  - 리더가 보고 메시지를 보낼 때 해당 Set의 최신 로그 3~5개 첨부
  - 시스템 메시지 (커밋, PR)에도 연관 로그 자동 첨부

컴포넌트 위치:
  packages/web/src/components/chat/InternalLogBlock.tsx
```

#### 4-3. 접기/펼치기 UI

기본 상태는 접힘. 클릭/탭으로 펼쳐 전체 로그 확인.

```
상태 관리:
  각 로그 블록의 펼침 상태는 로컬 UI 상태 (Zustand 불필요, useState)
  Firestore에 저장하지 않음

접힌 상태:
  "🟢 백엔드팀 내부 작업 (3개 로그) ▶ 펼치기"

펼친 상태:
  전체 로그 목록 표시 + "▲ 접기" 버튼

모바일:
  탭하여 펼치기 (터치 이벤트)
  펼쳐진 상태에서 스크롤 가능
```

### 완료 조건

- [ ] 팀원이 작업할 때마다 Firestore `logs` 서브컬렉션에 기록됨
- [ ] Council Room에서 리더 메시지 아래에 내부 로그 블록이 표시됨
- [ ] 클릭/탭으로 접기/펼치기가 동작함
- [ ] 모바일에서도 접기/펼치기가 터치로 동작함

### 리스크

| 리스크 | 대응 |
|---|---|
| 로그가 너무 많아 Firestore 쓰기 한도 초과 | 로그는 최근 50개만 유지 (오래된 것은 자동 삭제 또는 아카이브) |
| 상세 로그 노출로 Council Room이 복잡해짐 | 기본값 접힘 + 요약 1줄만 표시 |

---

## Step 5: 세션 관리

### 목표

PM이 자리를 비웠다 돌아와도 리더들이 이전 맥락을 파악한 상태에서 대화를 이어간다.
스냅샷 자동 생성 + tmux 세션 유지 + 세션 복원의 3-레이어 구조를 구현한다.

### 선행 조건

- Step 3 완료 (tmux 기반 세션 구조 동작)
- Firestore `projects/{id}/snapshots` 서브컬렉션 스키마 확정 (PLAN.md 7.5 참고)

### 구현 세부 항목

#### 5-1. 스냅샷 자동 생성

프로젝트 상태를 구조화된 JSON으로 Firestore에 저장한다.

```
스냅샷 생성 트리거:
  - PR 머지 시 (자동)
  - 태스크 상태 변경 시 (in_progress → done, 자동)
  - PM 명시 요청 "상태 저장" (수동)
  - 30분 주기 자동 저장 (세션 활성 중)
  - Council Room 일시정지/종료 시 (자동)

스냅샷 저장 위치:
  Firestore: projects/{projectId}/snapshots/{snapshotId}

스냅샷 생성 로직 위치:
  packages/server/src/session/snapshot.service.ts

스냅샷 포함 정보:
  {
    trigger: "pr_merged" | "task_done" | "manual" | "periodic" | "pause",
    summary: "프로젝트 요약 한 줄",
    completedTasks: [태스크 제목 배열],
    inProgressTasks: [{ task, set, progress }],
    decisions: [리더들이 합의한 주요 결정사항],
    gitState: {
      mainCommits: n,
      openPRs: [PR 제목 배열],
      branches: { "set-b/backend": "ahead 3" }
    },
    recentMessageIds: [최근 30개 메시지 ID]
  }
```

#### 5-2. tmux 세션 유지

PM이 없어도 Claude Code 세션이 서버에서 계속 실행된다.

```
세션 유지 정책 (PLAN.md 7.5 기반):

  PM 활성 (브라우저 열림):
    → 세션 유지, 리더들 정상 동작

  PM 부재 0~30분:
    → 세션 유지, 진행 중 작업 계속
    → 의사결정 필요한 건 큐 보관

  PM 부재 30분~2시간:
    → 세션 유지, 신규 작업 시작 안 함
    → 현재 작업만 마무리

  PM 부재 2시간 초과:
    → 스냅샷 저장 후 세션 종료 (리소스 해제)
    → tmux kill-session

PM 활성 감지 방법:
  WebSocket heartbeat 기반:
    클라이언트가 30초마다 ping 전송
    Council Server에서 마지막 ping 시각 추적
    마지막 ping으로부터 경과 시간으로 부재 여부 판단
```

#### 5-3. 세션 복원 + 컨텍스트 주입

PM이 돌아왔을 때 세션이 죽어있으면 최신 스냅샷으로 복원한다.

```
복원 흐름:

  PM 복귀 (브라우저 열림)
    → Council Server에 WebSocket 연결
    → 각 Set 세션 상태 확인 (tmux has-session)

  세션 살아있음:
    → 기존 세션에 재연결 (컨텍스트 100% 보존)
    → UI에 "세션 재연결됨" 표시

  세션 죽어있음:
    → Firestore에서 최신 스냅샷 로드
    → 스냅샷 없으면 최근 메시지 30개로 요약 자동 생성
    → 새 tmux 세션 시작 + 컨텍스트 주입:

        시스템 프롬프트 구성:
          "당신은 {팀이름} 리더입니다.
           프로젝트: {projectName} ({techStack})
           현재 상태: {inProgressTasks 요약}
           완료된 작업: {completedTasks}
           주요 결정사항:
             - {decisions[0]}
             - {decisions[1]}
           최근 대화: {최근 30개 메시지 요약}
           Git 상태: {branch} (ahead {n})"

    → 리더가 맥락 파악 후 "세션이 재시작되었습니다. 이어서 진행합니다." 발언
    → Council Room에 재개 알림 표시

세션 복원 UI:
  PM 복귀 시 "⟳ 세션을 복원하는 중..." 로딩 표시
  복원 완료 후 "세션 복원 완료 (스냅샷: 2026-03-23 14:30)" 표시
```

#### 5-4. PM 부재 정책 구현

Council Server에 PM 활성 상태를 추적하는 모니터링 루프를 구현한다.

```
구현 위치: packages/server/src/session/presence.service.ts

PM 상태 추적:
  lastSeenAt: number (Unix timestamp, WebSocket heartbeat 기준)

모니터링 루프 (1분 주기 확인):
  const absenceDuration = Date.now() - lastSeenAt

  if (absenceDuration < 30min):
    상태 유지, 아무 동작 없음

  else if (absenceDuration < 2h):
    각 Set 리더에게 메시지:
      "PM이 {n}분 동안 자리를 비웠습니다.
       진행 중인 작업만 완료하고 신규 작업은 대기합니다."
    Set 상태를 'idle' (신규 작업 시작 금지)

  else (2h 초과):
    스냅샷 생성 (trigger: "pm_absent")
    tmux 세션 순차 종료
    Council Room 시스템 메시지:
      "[시스템] PM 부재 2시간 초과. 세션을 종료합니다.
       복귀 시 스냅샷으로 자동 복원됩니다."
```

### 완료 조건

- [ ] PR 머지, 태스크 완료, 30분 주기로 스냅샷이 Firestore에 자동 생성됨
- [ ] PM이 브라우저를 닫은 후 30분 내 세션이 유지됨 (tmux 확인)
- [ ] PM이 2시간 이상 부재 후 세션이 자동 종료됨
- [ ] PM 복귀 시 기존 세션 재연결 또는 스냅샷 기반 복원이 동작함
- [ ] 복원 후 리더가 "이어서 진행합니다" 발언으로 맥락 파악 확인

### 리스크

| 리스크 | 대응 |
|---|---|
| 스냅샷 생성 중 Firestore 쓰기 실패 | 재시도 로직 (3회), 실패 시 로컬 파일에 백업 저장 |
| 컨텍스트 주입 프롬프트가 너무 길어 토큰 초과 | 최근 메시지를 요약하여 주입 (전체 원문 대신) |
| WebSocket 끊김을 PM 부재로 오인 | 네트워크 재연결 시 30초 유예 후 부재 판정 |
| tmux 세션 종료 후 재시작 시 포트 충돌 | 세션 시작 전 기존 포트 해제 확인 |

---

## Step 6: BYOK (Bring Your Own Key)

### 목표

사용자별로 Anthropic API 키를 등록하여 서버의 단일 API 키 의존성을 제거한다.
키는 AES-256으로 암호화하여 Firestore에 저장하고, 세션 시작 시에만 복호화한다.

### 선행 조건

- Firebase Auth 사용자 인증 완료 (Phase 1)
- Firestore `users/{userId}.apiKeyEncrypted` 필드 존재
- 서버 환경변수 `ENCRYPTION_KEY` (32바이트 AES 키) 설정

### 구현 세부 항목

#### 6-1. API 키 등록 UI

설정 화면(`/settings`)에 API 키 등록 폼을 구현한다.

```
화면 위치: packages/web/src/pages/settings/

UI 구성:
  [Anthropic API 키]
  ┌────────────────────────────────────────┐
  │ sk-ant-...                  [저장] [삭제] │
  └────────────────────────────────────────┘
  ⚠️ 키는 AES-256으로 암호화되어 저장됩니다.

  [인증 방식]
  ○ API 키 사용  ● Max 플랜 사용 (인증 파일 업로드)

  [저장] 클릭 시:
    1. 클라이언트에서 Council Server로 POST /api/user/api-key 전송
    2. Council Server에서 AES-256 암호화 후 Firestore 저장
    3. 성공 응답 → "저장되었습니다" 토스트

  입력값 검증:
    - sk-ant- 로 시작하는지 확인
    - 최소 길이 체크
    - 저장 전 Anthropic API로 유효성 검증 (선택)
```

#### 6-2. AES-256 암호화/복호화

서버 측에서만 암호화/복호화를 수행한다.

```
구현 위치: packages/server/src/auth/crypto.service.ts

암호화 (키 저장 시):
  import { createCipheriv, randomBytes } from 'crypto'

  암호화 키: 서버 환경변수 ENCRYPTION_KEY (hex 32바이트)
  IV: 매번 새로 생성 (16바이트 random)
  알고리즘: aes-256-cbc

  저장 형식: "iv:암호화된데이터" (Base64 인코딩)
  Firestore: users/{userId}.apiKeyEncrypted = "{iv}:{encrypted}"

복호화 (세션 시작 시):
  Firestore에서 apiKeyEncrypted 읽기
  iv와 encrypted 분리
  createDecipheriv로 복호화
  복호화된 키는 메모리에서만 사용, 로그에 절대 기록 안 함

보안 원칙:
  - 복호화된 키를 Firestore에 다시 쓰지 않음
  - 로그(console, Grafana)에 키 값 출력 금지
  - 키를 클라이언트(브라우저)로 전달하지 않음
```

#### 6-3. 사용자별 세션 격리

각 사용자의 Claude Code 세션이 해당 사용자의 API 키만 사용한다.

```
세션 시작 시 키 주입:
  1. 세션 시작 요청에서 userId 확인 (Firebase Auth JWT 검증)
  2. Firestore users/{userId}.apiKeyEncrypted 로드
  3. 복호화 → ANTHROPIC_API_KEY 환경변수로 tmux 세션에 주입:
       tmux send-keys -t "council-{id}"
         "export ANTHROPIC_API_KEY='{decryptedKey}' && claude --channel ..."

  키 미등록 시:
    서버 환경변수 ANTHROPIC_API_KEY 폴백 사용 (개발/테스트용)
    UI에 "API 키가 설정되지 않았습니다. 서버 기본 키를 사용 중입니다." 경고 표시

세션 격리:
  tmux 세션 이름에 userId 포함:
    "council-{userId}-{projectId}-{setId}"
  다른 사용자의 세션에 접근 불가 (서버 레벨 격리)
```

### 완료 조건

- [ ] 설정 화면에서 Anthropic API 키를 입력하고 저장할 수 있음
- [ ] 저장된 키가 Firestore에 암호화된 형태로 확인됨
- [ ] 세션 시작 시 해당 사용자의 키가 Claude Code에 주입됨
- [ ] 키 미등록 사용자는 서버 기본 키로 폴백됨
- [ ] 복호화된 키가 로그나 응답에 노출되지 않음

### 리스크

| 리스크 | 대응 |
|---|---|
| 서버 ENCRYPTION_KEY 유출 시 모든 키 노출 | Oracle Ampere 환경변수 보안 관리, 정기 키 로테이션 |
| 잘못된 API 키 저장으로 세션 시작 실패 | 저장 전 간단한 유효성 검증 (Anthropic API 테스트 호출) |
| AES-256 구현 버그 | Node.js 내장 `crypto` 모듈 사용 (외부 라이브러리 최소화) |

---

## Phase 2 완료 기준

Phase 2가 완성되었다고 볼 수 있는 조건은 아래 시나리오가 끊김 없이 동작하는 것이다.

### 최종 검증 시나리오

```
1. PM이 Council Room에서 기능 논의
   "채팅 메시지 전송 기능을 구현하자"
   → 리더들이 설계 논의

2. 합의 후 태스크 등록
   PM: "태스크로 등록해"
   → 태스크 카드가 보드 Backlog에 생성됨

3. Set B 리더가 백엔드 팀원에게 지시
   → 팀원이 worktree에서 코드 작성
   → Set 내부 로그가 Council Room에 접기/펼치기로 표시됨

4. 작업 완료 → 브랜치 커밋
   → "Set B가 3개 커밋을 푸시했습니다" 시스템 메시지 자동 표시

5. 리더: "작업 완료. PR 올립니다."
   → PR이 GitHub에 자동 생성되고 Council Room에 링크 공유
   → 보드에서 태스크 상태 → Review

6. QA Set 리더가 코드 리뷰
   → 리뷰 코멘트가 Council 대화에 기록

7. PM: "머지해주세요."
   → PR이 main에 머지됨
   → 다른 Set worktree 자동 rebase
   → 태스크 상태 → Done

8. PM이 자리를 2시간 비움
   → 스냅샷 자동 저장
   → 세션 자동 종료

9. PM 복귀
   → 스냅샷 기반 세션 자동 복원
   → 리더: "이어서 진행하겠습니다."
```

### Phase 2 성공 기준 체크리스트

| 항목 | 검증 방법 |
|---|---|
| 대화 → 태스크 등록 자동 동작 | "태스크로 등록해" 발언 후 보드 확인 |
| 태스크 → 브랜치 → PR 연결 | 카드 클릭으로 PR 링크 확인 |
| PR 머지 → 태스크 자동 done 전환 | 머지 후 보드 상태 확인 |
| 머지 후 다른 Set rebase 자동 실행 | git log 확인 |
| Set 내부 팀워크 Council Room에 표시 | 로그 블록 접기/펼치기 확인 |
| 세션 재개 시 리더가 맥락 파악 | 복귀 후 리더 첫 발언 내용 확인 |
| 칸반 보드 드래그앤드롭 동작 | 카드 이동 + Firestore 상태 변경 확인 |
| 사용자별 API 키 독립 동작 | 두 계정으로 동시 접속 테스트 |

---

## 참고 문서

- PLAN.md §3 프로젝트 & 코드 관리 — Git 워크플로우 상세 설계
- PLAN.md §4 UI 설계 — 칸반 보드, Git 패널, 접기/펼치기 UI 설계
- PLAN.md §5.5 Claude Code 연동 방식 — CLI vs Channel 비교
- PLAN.md §7 핵심 플로우 — 전체 대화→코드→PR 루프 흐름
- PLAN.md §7.5 세션 관리 & 대화 재개 — 스냅샷 구조 및 복원 전략
- PLAN.md §10 기술적 도전과 리스크 — 각 컴포넌트별 리스크 상세
- `../00_설정_참조표.md` — 워크스페이스 경로, tmux 명명, 세션 제한값, 전역 설정값 단일 출처
