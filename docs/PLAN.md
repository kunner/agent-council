# Agent Council - 설계 계획서

> **이 문서는 프로젝트 전체 비전과 개요를 담은 마스터 문서입니다. 각 섹션의 상세 스펙은 해당 문서를 참조하세요. 설정값은 `00_설정_참조표.md`가 정규 소스입니다.**

## 1. 프로젝트 비전

**"여러 AI 에이전트 팀의 리더들이 하나의 대화방에서 회의하며, 각 팀은 내부적으로 독립 작업을 수행하는 멀티팀 오케스트레이션 시스템"**

```
┌──────────────────────────────────────────────────┐
│                 Council Room (대화방)               │
│                                                    │
│  👤 Human (PM)                                     │
│  🎯 Leader A (아키텍처팀)                            │
│  🎯 Leader B (백엔드팀)                              │
│  🎯 Leader C (프론트팀)                              │
│  🎯 Leader D (QA팀)                                 │
│                                                    │
│  리더 간 대화 + PM 개입 = 의사결정                     │
└──────────┬───────────┬───────────┬────────────────┘
           │           │           │
     ┌─────▼─────┐ ┌──▼──────┐ ┌─▼────────┐
     │ Set A     │ │ Set B   │ │ Set C    │  ...
     │ 리더+팀원3 │ │ 리더+팀원3│ │ 리더+팀원3│
     │ (내부작업) │ │ (내부작업)│ │ (내부작업)│
     └───────────┘ └─────────┘ └──────────┘
```

---

## 2. 핵심 개념

### 2.1 Council Room (의사회 대화방)
- 리더들과 PM이 참여하는 **공유 대화 공간**
- 메신저 채팅방처럼 동작: 실시간 메시지, 순서 보장
- 의사결정, 이슈 에스컬레이션, 인터페이스 협의가 이루어지는 곳

### 2.2 Agent Set (에이전트 팀)
- 리더 1명 + 팀원 N명으로 구성된 작업 단위
- 리더는 Council Room에 참여하여 다른 팀과 소통
- 팀원은 리더의 지시를 받아 실제 코딩/분석 수행
- 내부 대화는 Council Room에 노출되지 않음

### 2.3 Human (PM)
- Council Room에 참여하여 방향 설정, 의사결정
- 특정 리더에게 직접 지시 가능
- 전체 진행 상황을 한눈에 파악

### 2.4 Project (프로젝트)
- Council의 **작업 대상** — 하나의 Git 리포지토리에 대응
- Council Room은 반드시 하나의 Project에 종속됨
- Project 없이 Council은 "말만 하는 회의"에 불과함

```
Project
├── Git Repository          ← 실제 소스코드
├── Council Room            ← 대화/의사결정
├── Workspaces              ← Set별 독립 작업 공간
│   ├── Set A → worktree (set-a/architecture)
│   ├── Set B → worktree (set-b/backend)
│   └── Set C → worktree (set-c/frontend)
├── Board                   ← 태스크 보드 (칸반)
└── Artifacts               ← PR, 빌드 결과, 문서
```

### 2.5 Workspace (작업 공간)
- 각 Set에 할당되는 **격리된 코드 작업 환경**
- Git worktree 기반 — 같은 repo지만 **독립 브랜치에서 동시 작업**
- Set 내부의 Claude Code 세션은 자기 worktree에서만 작업
- 충돌 없이 병렬 개발 가능

```
/workspace/{projectId}/
├── main/                    ← 메인 브랜치 (읽기 전용 참조)
├── set-a/                   ← git worktree: set-a/architecture
├── set-b/                   ← git worktree: set-b/backend
└── set-c/                   ← git worktree: set-c/frontend
```

### 2.6 Board (태스크 보드)
- 프로젝트의 작업 항목을 관리하는 **칸반 보드**
- Council 대화에서 합의된 내용이 태스크로 변환됨
- 각 태스크는 담당 Set에 할당

```
┌─────────┬────────────┬───────────┬──────────┬──────────┐
│ Backlog │ In Progress│ Review    │ Blocked  │ Done     │
├─────────┼────────────┼───────────┼──────────┼──────────┤
│ 파일전송 │ API설계    │ 로그인UI  │          │ DB스키마  │
│ 읽음표시 │ (Set B)    │ (Set C)   │          │ (Set A)  │
│         │ 테스트     │           │          │          │
│         │ (Set D)    │           │          │          │
└─────────┴────────────┴───────────┴──────────┴──────────┘
```

> 📄 상세: `05_기능명세/01_프로젝트_관리.md`, `05_기능명세/02_Council_Room.md`, `05_기능명세/03_Agent_Set.md`

---

## 3. 프로젝트 & 코드 관리

### 3.1 Git 워크플로우

```
main ──────────────────────────────────────●── 최종 머지
        \                                  ↑
         ├── set-a/architecture ─── PR ──→ 리뷰 → 머지
         │     (DB 스키마, API 스펙)         ↑ 리더 합의
         │                                  │
         ├── set-b/backend ──────── PR ──→ 리뷰 → 머지
         │     (Spring Boot API)            ↑ 리더 합의
         │                                  │
         ├── set-c/frontend ─────── PR ──→ 리뷰 → 머지
         │     (React UI)                   ↑ 리더 합의
         │                                  │
         └── set-d/qa ───────────── PR ──→ 리뷰 → 머지
               (테스트 코드)                 ↑ 리더 합의
```

**브랜치 전략:**
- `main` — 안정 브랜치, 리더 합의 후에만 머지
- `set-{id}/{topic}` — Set별 작업 브랜치, worktree로 체크아웃
- 머지 순서는 Council 대화에서 리더들이 합의 (예: 백엔드 먼저 → 프론트 → QA)

### 3.2 코드 리뷰 & 머지 프로세스

```
1. Set B 리더: "백엔드 API 구현 완료. PR 올립니다."
   → Council Server가 자동으로 PR 생성 (GitHub API)
   → PR 링크가 Council Room에 공유됨

2. Set D 리더 (QA): "PR 코드 리뷰합니다."
   → QA Set 팀원이 코드 리뷰 + 테스트 실행
   → 결과를 Council Room에 보고

3. Set A 리더 (아키텍처): "API 스펙과 일치 확인. 승인."

4. PM: "머지해주세요."
   → Council Server가 PR 머지 실행
   → 다른 Set들의 worktree에 main 변경사항 자동 rebase/merge
```

### 3.3 프로젝트 생명주기

```
┌─────────────────────────────────────────────────────┐
│                   프로젝트 생명주기                    │
│                                                       │
│  1. 생성     PM이 프로젝트 생성                        │
│              ├── Git repo 초기화 (또는 기존 repo 연결)  │
│              ├── Council Room 자동 생성                │
│              └── 기본 CLAUDE.md 생성                   │
│                                                       │
│  2. 설계     Council에서 아키텍처 논의                  │
│              ├── 리더들이 설계 합의                     │
│              ├── 태스크 보드에 항목 등록                 │
│              └── Set별 브랜치/worktree 생성             │
│                                                       │
│  3. 개발     Set들이 병렬 작업                         │
│              ├── 각 Set이 자기 worktree에서 코딩       │
│              ├── 이슈 발생 → Council 에스컬레이션       │
│              └── 완료된 태스크 → PR 생성                │
│                                                       │
│  4. 통합     PR 리뷰 & 머지                           │
│              ├── Council에서 리뷰 합의                  │
│              ├── main으로 순차 머지                     │
│              └── 충돌 발생 시 Council에서 해결 논의      │
│                                                       │
│  5. 검증     QA Set이 통합 테스트                      │
│              ├── main 브랜치에서 전체 테스트             │
│              ├── 버그 → 태스크 보드에 등록 → 재작업      │
│              └── 통과 → PM에게 보고                     │
│                                                       │
│  6. 완료     PM이 프로젝트 완료 처리                    │
│              ├── worktree 정리                         │
│              ├── Council 히스토리 아카이브               │
│              └── 결과 요약 문서 자동 생성                │
└─────────────────────────────────────────────────────┘
```

### 3.4 프로젝트 유형

#### A. 신규 프로젝트 (빈 repo에서 시작)
```
PM: "사내 메신저 시스템을 React + Spring Boot로 만들자"
→ 빈 Git repo 생성
→ 아키텍처 Set이 초기 구조 잡고 main에 커밋
→ 나머지 Set들이 브랜치 따서 작업 시작
```

#### B. 기존 프로젝트 (이미 있는 repo에 기능 추가)
```
PM: "이 프로젝트에 파일 전송 기능을 추가하자"
  (GitHub repo URL 또는 로컬 경로 입력)
→ 기존 repo 클론
→ 리더들이 기존 코드 분석 후 작업 분배
→ 기존 코드 구조/컨벤션 준수하며 개발
```

#### C. 분석 프로젝트 (코드 수정 없이 분석만)
```
PM: "이 코드베이스의 보안 취약점을 분석해줘"
→ 기존 repo 클론 (읽기 전용)
→ Set들이 분석 후 문서로 결과 산출
→ 코드 수정 없이 리포트만 생성
```

### 3.5 태스크 보드 상세

```typescript
interface Task {
  id: string
  projectId: string
  title: string
  description: string
  status: 'backlog' | 'in_progress' | 'review' | 'done' | 'blocked'
  assignedSetId?: string           // 담당 Set
  priority: 'critical' | 'high' | 'medium' | 'low'
  dependencies: string[]           // 선행 태스크 ID
  branch?: string                  // 관련 Git 브랜치
  pullRequestUrl?: string          // 관련 PR
  createdFromMessageId?: string    // 이 태스크를 만든 Council 메시지
  createdAt: Timestamp
  updatedAt: Timestamp
}
```

**태스크 생성 방식:**
```
방법 1 — Council 대화에서 자동 추출
  리더A: "DB 스키마부터 만들어야 합니다"
  PM: "좋아, 태스크로 등록해"
  → [태스크 생성] DB 스키마 설계 — Set A 할당

방법 2 — PM이 직접 등록
  PM이 보드 UI에서 직접 태스크 추가

방법 3 — 리더가 내부 작업 분해 후 등록
  리더B: "백엔드 작업을 세분화했습니다: API 3개, WebSocket 1개"
  → 4개 서브태스크 자동 생성
```

> 📄 상세: `05_기능명세/04_태스크_보드.md`, `05_기능명세/05_Git_워크플로우.md`, `05_기능명세/06_코드_리뷰.md`

---

## 4. UI 설계

### 4.1 설계 원칙

```
1. 대화가 중심이다
   - Council Room 채팅이 항상 주인공
   - 다른 정보(보드, Git, 로그)는 대화를 보조하는 역할

2. 정보는 숨기지 않되, 단계적으로 드러낸다
   - 모바일에서도 모든 정보에 접근 가능
   - 다만 기본 뷰는 대화, 나머지는 탭/스와이프로 도달
   - "3탭 이내에 모든 정보 접근 가능" 원칙

3. 상태는 항상 보인다
   - Set 상태(작업 중/대기/완료)는 어떤 화면에서든 확인 가능
   - 새 메시지, PR, 태스크 변경은 실시간 뱃지로 표시

4. 맥락 전환을 최소화한다
   - 채팅에서 태스크 등록, PR 확인이 인라인으로 가능
   - 별도 페이지로 이동하지 않아도 핵심 작업 수행 가능
```

### 4.2 화면 구성

#### 데스크톱 레이아웃 (≥1024px) — 3패널 구조

```
┌──────────────────────────────────────────────────────────────┐
│  🏠 Agent Council          프로젝트: 사내 메신저    [설정] [👤] │
├────────────┬─────────────────────────────┬───────────────────┤
│            │                             │                   │
│  Left      │  Center                     │  Right            │
│  Panel     │  Panel                      │  Panel            │
│  (280px)   │  (flex)                     │  (320px)          │
│            │                             │                   │
│ ┌────────┐ │  Council Room               │ ┌───────────────┐ │
│ │프로젝트 │ │                             │ │ 탭: 보드|Git|로그│ │
│ │ 목록   │ │  🎯 아키텍트: DB 스키마는    │ │               │ │
│ │        │ │     이렇게 가겠습니다.       │ │ [보드 선택시]  │ │
│ │ ● 메신저│ │                             │ │ ┌─Backlog──┐  │ │
│ │   쇼핑몰│ │  🟢 백엔드: 동의합니다.     │ │ │ 파일전송  │  │ │
│ │        │ │     다만 인덱스 추가가...    │ │ │ 읽음표시  │  │ │
│ │        │ │                             │ │ ├─Working──┤  │ │
│ ├────────┤ │  🔵 프론트: API 스펙 확인    │ │ │ API구현   │  │ │
│ │ Set    │ │     했습니다. 한 가지...     │ │ │  (Set B)  │  │ │
│ │ 상태   │ │                             │ │ ├─Review───┤  │ │
│ │        │ │  👤 나: 좋아, 진행하자.      │ │ │ 로그인UI  │  │ │
│ │ 🎯 아키 │ │                             │ │ │  (Set C)  │  │ │
│ │   ✅ 완료│ │  [시스템] Set B가 3개 커밋  │ │ ├─Done─────┤  │ │
│ │ 🟢 백엔 │ │  을 푸시했습니다. ▶ 상세    │ │ │ DB스키마  │  │ │
│ │   🔄 작업│ │                             │ │ └──────────┘  │ │
│ │ 🔵 프론 │ │                             │ │               │ │
│ │   🔄 작업│ │  ┌─ Set B 내부 로그 ──────┐│ │ [Git 선택시]  │ │
│ │ 🟡 QA  │ │  │ ▶ 접기/펼치기           ││ │ main: 5 commits│ │
│ │   ⏳ 대기│ │  │ B-1: Entity 구현 완료   ││ │ PR #3: open   │ │
│ │        │ │  │ B-2: WebSocket 작업 중  ││ │ set-b: +3     │ │
│ │        │ │  └────────────────────────┘│ │               │ │
│ └────────┘ │                             │ └───────────────┘ │
│            │  ┌────────────────────────┐ │                   │
│            │  │ 메시지 입력...     [전송]│ │                   │
│            │  └────────────────────────┘ │                   │
├────────────┴─────────────────────────────┴───────────────────┤
│  Set B: WebSocket 핸들러 구현 중 (43%)  │  토큰: 12.4K  │ ⏱ 32분 │
└──────────────────────────────────────────────────────────────┘
```

**패널 설명:**
- **Left**: 프로젝트 목록 + 현재 프로젝트의 Set 상태 요약
- **Center**: Council Room 채팅 (메인). 시스템 알림, Set 내부 로그 인라인 표시
- **Right**: 컨텍스트 패널 — 탭으로 보드/Git/로그 전환
- **Bottom Bar**: 현재 진행 상황 요약 (프로그레스, 토큰 사용량, 경과 시간)

#### 태블릿 레이아웃 (768px~1023px) — 2패널

```
┌──────────────────────────────────────────┐
│  🏠 Agent Council    사내 메신저   [≡] [👤]│
├─────────────────────────┬────────────────┤
│                         │                │
│  Council Room           │  Context Panel │
│  (채팅 - flex)           │  (280px)       │
│                         │  탭: 보드|Git   │
│  (데스크톱과 동일)       │  (데스크톱 Right│
│                         │   패널과 동일)  │
│                         │                │
├─────────────────────────┴────────────────┤
│  [메시지 입력...]                  [전송] │
├──────────────────────────────────────────┤
│  Set B: 작업 중 (43%)  │  토큰: 12.4K    │
└──────────────────────────────────────────┘
```

- Left 패널(프로젝트 목록)은 햄버거 메뉴(≡)로 접힘
- Context Panel은 접기/펼치기 가능

#### 모바일 레이아웃 (<768px) — 풀스크린 + 바텀 탭

```
┌─────────────────────────┐
│ 🏠 사내 메신저     [≡] [👤]│
├─────────────────────────┤
│                         │
│  🎯 아키텍트:            │
│  DB 스키마는 이렇게     │
│  가겠습니다.             │
│                         │
│  🟢 백엔드:              │
│  동의합니다. 다만...     │
│                         │
│  👤 나:                  │
│  좋아, 진행하자.         │
│                         │
│  ┌─ 시스템 알림 ───────┐│
│  │ Set B: 3 커밋 푸시  ││
│  │ ▶ 탭하여 상세 보기  ││
│  └─────────────────────┘│
│                         │
│  ┌─ Set B 로그 (접힘) ─┐│
│  │ ▶ 탭하여 펼치기     ││
│  └─────────────────────┘│
│                         │
├─────────────────────────┤
│ [메시지 입력...]  [전송] │
├─────────────────────────┤
│  💬    📋    🔀    ⚙️   │
│  채팅  보드   Git  설정  │
└─────────────────────────┘
```

**모바일 핵심 원칙:**
- 기본 화면은 **채팅 풀스크린**
- 하단 탭 바로 **보드, Git, 설정**에 1탭으로 접근
- Set 내부 로그, 시스템 알림은 **접기/펼치기**로 노이즈 최소화
- Set 상태는 **상단 바에 컬러 도트**로 요약 표시

### 4.3 핵심 UI 컴포넌트

#### 메시지 타입별 표시

```
┌─ Human 메시지 ─────────────────────────┐
│  👤 나                        14:30    │
│  좋아, 진행하자.                        │
└─────────────────────────────────────────┘

┌─ Leader 메시지 ────────────────────────┐
│  🟢 백엔드팀                   14:31    │
│  API 구현 완료했습니다.                  │
│  엔드포인트 5개 + WebSocket 핸들러.     │
│                                         │
│  📎 artifacts: ChatController.java 외 3 │
│  🔗 Branch: set-b/backend (+5 commits)  │
└─────────────────────────────────────────┘

┌─ System 메시지 ────────────────────────┐
│  ⚙️ 시스템                     14:35    │
│  PR #3 "백엔드 채팅 API" 생성됨         │
│  set-b/backend → main | +423 -12       │
│  [PR 보기] [코드 리뷰 요청]             │
└─────────────────────────────────────────┘

┌─ Set 내부 로그 (접기/펼치기) ──────────┐
│  🟢 백엔드팀 내부 작업        ▼ 펼치기  │
│  ├ B-1: Entity + Repository 완료  ✅   │
│  ├ B-2: WebSocket 핸들러 작업 중  🔄   │
│  └ B-3: REST API 대기 중         ⏳   │
└─────────────────────────────────────────┘

┌─ Task 인라인 카드 ─────────────────────┐
│  📋 태스크 생성됨                       │
│  ┌────────────────────────────────┐    │
│  │ 채팅 API 구현                   │    │
│  │ Set B 할당 | 🔴 High           │    │
│  │ [보드에서 보기]                  │    │
│  └────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

#### 칸반 보드

```
데스크톱: 5열 가로 스크롤 없이 표시
┌──────────┬────────────┬──────────┬──────────┬──────────┐
│ Backlog  │ In Progress│ Review   │ Blocked  │ Done     │
│ (3)      │ (2)        │ (1)      │ (0)      │ (4)      │
├──────────┼────────────┼──────────┼──────────┼──────────┤
│┌────────┐│┌────────┐  │┌────────┐│          │┌────────┐│
││파일전송 │││API구현  │  ││로그인UI ││          ││DB스키마 ││
││        │││🟢SetB  │  ││🔵SetC  ││          ││🎯SetA  ││
││        │││■■■■□ 70%│  ││■■□□□ 40%││          ││✅       ││
│└────────┘│└────────┘  │└────────┘│          │└────────┘│
│┌────────┐│┌────────┐  │          │          │┌────────┐│
││읽음표시 │││테스트   │  │          │          ││API스펙  ││
││        │││🟡SetD  │  │          │          ││✅       ││
│└────────┘│└────────┘  │          │          │└────────┘│
└──────────┴────────────┴──────────┴──────────┴──────────┘

모바일: 가로 스와이프 또는 단일 열 + 필터
┌─────────────────────────┐
│ [Backlog▼] 필터: 전체 ▼  │
├─────────────────────────┤
│ ┌─────────────────────┐ │
│ │ 파일전송             │ │
│ │ 미할당 | Medium      │ │
│ └─────────────────────┘ │
│ ┌─────────────────────┐ │
│ │ 읽음표시             │ │
│ │ 미할당 | Low         │ │
│ └─────────────────────┘ │
│                         │
│   ← 스와이프: Working → │
└─────────────────────────┘
```

#### Git 상태 패널

```
데스크톱 (Right Panel 탭):
┌───────────────────────┐
│ 🔀 Git 상태            │
├───────────────────────┤
│ main: 5 commits       │
│ 마지막: "feat: DB 스키마"│
│                       │
│ 열린 PR:              │
│ ┌───────────────────┐ │
│ │ #3 백엔드 채팅 API │ │
│ │ 🟢 SetB → main    │ │
│ │ +423 -12 | 8 files │ │
│ │ [보기] [머지]       │ │
│ └───────────────────┘ │
│                       │
│ 브랜치:               │
│ 🟢 set-b/backend  +3  │
│ 🔵 set-c/frontend +7  │
│ 🟡 set-d/qa       +0  │
└───────────────────────┘

모바일 (하단 탭 → Git):
동일 내용, 풀스크린 표시
```

### 4.4 반응형 전략 요약

| 요소 | 데스크톱 (≥1024) | 태블릿 (768~1023) | 모바일 (<768) |
|---|---|---|---|
| **레이아웃** | 3패널 동시 표시 | 2패널 (Left 접힘) | 풀스크린 + 바텀 탭 |
| **채팅** | Center 패널 | Left 패널 | 기본 화면 |
| **보드** | Right 탭 | Right 탭 | 바텀 탭 → 풀스크린 |
| **Git** | Right 탭 | Right 탭 | 바텀 탭 → 풀스크린 |
| **Set 상태** | Left 패널 상시 | 상단 바 요약 | 상단 컬러 도트 |
| **Set 로그** | 채팅 인라인 펼침 | 채팅 인라인 펼침 | 탭하여 펼침 |
| **프로젝트 목록** | Left 패널 상시 | 햄버거 메뉴 | 햄버거 메뉴 |
| **Bottom Bar** | 상시 표시 | 상시 표시 | 없음 (상단에 요약) |
| **입력** | 하단 고정 | 하단 고정 | 키보드 위 고정 |

### 4.5 화면 목록

| 화면 | 경로 | 설명 |
|---|---|---|
| 로그인 | `/login` | Firebase Auth (Google/GitHub) |
| 대시보드 | `/` | 프로젝트 목록, 최근 활동 |
| 프로젝트 생성 | `/new` | 신규/기존 repo/분석 선택 |
| Council Room | `/p/{id}` | 메인 작업 화면 (채팅 + 컨텍스트) |
| 태스크 보드 | `/p/{id}/board` | 칸반 (모바일 전용 풀스크린) |
| Git 현황 | `/p/{id}/git` | 브랜치, PR (모바일 전용 풀스크린) |
| 설정 | `/settings` | API 키, 프로필, 테마 |

> 데스크톱에서는 `/p/{id}` 하나에서 보드/Git이 탭으로 통합되므로
> 별도 라우트로 이동할 필요가 거의 없음

### 4.6 UI 기술 선택

| 항목 | 선택 | 이유 |
|---|---|---|
| 프레임워크 | React + TypeScript | 생태계, Claude Code 호환 |
| 빌드 | Vite | 빠른 HMR, Cloudflare Pages 호환 |
| UI 라이브러리 | shadcn/ui + Tailwind CSS | 커스터마이징 자유, 번들 최소화 |
| 상태관리 | Zustand | 경량, Firestore 리스너와 궁합 |
| 실시간 | Firestore onSnapshot | 내장 실시간 리스너 |
| 라우팅 | React Router v7 | 표준 |
| 마크다운 | react-markdown | 코드 블록, 리더 응답 렌더링 |
| 칸반 | @hello-pangea/dnd | 드래그앤드롭 (dnd-kit 대안) |
| 코드 하이라이팅 | Shiki | 아티팩트 코드 표시 |
| 차트 | Recharts | 토큰 사용량, 진행률 (경량) |

### 4.7 테마 & 디자인 토큰

```
컬러 시스템:
- 배경: 다크 모드 기본 (개발 도구 특성상), 라이트 모드 지원
- Set 컬러: 리더마다 고유 색상 할당 (최대 8색)
  🎯 #8B5CF6 (보라)  — 아키텍처
  🟢 #22C55E (초록)  — 백엔드
  🔵 #3B82F6 (파랑)  — 프론트엔드
  🟡 #EAB308 (노랑)  — QA
  🟠 #F97316 (주황)  — DevOps
  🔴 #EF4444 (빨강)  — 보안
  🩷 #EC4899 (핑크)  — 디자인
  🩵 #06B6D4 (시안)  — 데이터

- 시스템 메시지: muted (gray-500)
- PM 메시지: primary (blue-600)
- 상태 색상: success/warning/error 표준

타이포그래피:
- 채팅: system-ui (가독성 우선)
- 코드: JetBrains Mono / Fira Code
- 사이즈: 14px 기본 (채팅), 13px (로그/코드), 12px (메타)
```

> 📄 상세: `04_UI_UX/01_화면_설계.md`, `04_UI_UX/02_반응형_가이드.md`, `04_UI_UX/03_컴포넌트_명세.md`, `04_UI_UX/04_디자인_시스템.md`

---

## 5. 시스템 아키텍처

### 5.1 인프라 개요

```
브라우저 (어디서든)
    │ https://council.yourdomain.com
    ▼
┌──────────────────────────────────────────────────────┐
│  Oracle Cloud Ampere (24GB RAM / 200GB SSD)          │
│                                                       │
│  ┌─────────────┐  ┌────────────────────────────────┐ │
│  │ Nginx       │  │ Council Server (Node.js)       │ │
│  │ 리버스프록시  │→│ - Room/Set/Session 관리         │ │
│  │ SSL (Let's  │  │ - Claude Code 어댑터            │ │
│  │  Encrypt)   │  │ - WebSocket 프록시              │ │
│  └─────────────┘  └────────────────────────────────┘ │
│                      포트: 3001 (상세: 00_설정_참조표.md)│
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │ Claude Code 세션들 (Set당 1개)                    │ │
│  │ Set A | Set B | Set C | ...                      │ │
│  └─────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
        │                          │
        ▼                          ▼
┌───────────────┐          ┌───────────────┐
│ Firebase      │          │ Cloudflare    │
│ - Auth        │          │ - CDN (Web UI)│
│ - Firestore   │          │ - Pages       │
│ - Storage     │          │ - DNS         │
│ (무료 Spark)  │          │ (무료 플랜)    │
└───────────────┘          └───────────────┘
```

> Firestore 리전: 상세 `00_설정_참조표.md`

### 5.2 기술 스택 + 무료 인프라 활용

| 계층 | 기술 | 비용 | 비고 |
|---|---|---|---|
| **DNS/CDN** | Cloudflare | 무료 | DNS, SSL, DDoS 보호, 캐싱 |
| **Web UI 호스팅** | Cloudflare Pages | 무료 | React SPA 배포, 월 500회 빌드 |
| **SSL 인증서** | Let's Encrypt (서버) / Cloudflare (CDN) | 무료 | 자동 갱신 |
| **사용자 인증** | Firebase Auth | 무료 | 월 10,000 MAU (소셜 로그인, 상세: `01_아키텍처/02_인프라_배포.md`) |
| **채팅 DB** | Firebase Firestore | 무료 (Spark) | 일 50K 읽기, 20K 쓰기, 1GB 저장 |
| **파일 저장** | Firebase Storage | 무료 (Spark) | 5GB 저장, 일 1GB 다운로드 |
| **서버** | Oracle Cloud Ampere | 무료 (Always Free) | ARM 24GB RAM, 200GB SSD |
| **Council Server** | Node.js + TypeScript | — | 서버에서 실행, 포트 3001 |
| **실시간 통신** | Firestore onSnapshot + WebSocket 폴백 | — | Firestore 실시간 리스너 우선 |
| **Claude Code 연동** | MCP Channel Protocol | — | 공식 채널 프로토콜 |
| **모니터링** | Uptime Kuma (셀프호스트) | 무료 | 서버 상태 모니터링 |
| **로그** | Grafana Cloud | 무료 | 월 50GB 로그, 10K 메트릭 |

> **월 고정 비용: $0** (Claude API 토큰 비용 제외)

### 5.3 무료 인프라 상세

#### Firebase (Spark 플랜 — 무료)

```
용도별 매핑:

Firebase Auth        → 사용자 로그인 (Google/GitHub OAuth)
                       월 10,000 MAU 무료 (상세: 01_아키텍처/02_인프라_배포.md)

Firestore           → 채팅 메시지, Room, Set 메타데이터
                       실시간 리스너(onSnapshot)로 WebSocket 대체 가능
                       일 50K 읽기 / 20K 쓰기 / 1GB 저장

Firebase Storage     → 코드 아티팩트, 로그 파일 등 첨부
                       5GB 저장 / 일 1GB 다운로드

Firebase Hosting     → (사용 안 함 — Cloudflare Pages 사용)
```

**Firestore 실시간 리스너의 이점:**
- 메시지가 Firestore에 추가되면 모든 클라이언트에 **자동 푸시**
- 별도 WebSocket 서버 부담 없음 (Council Server의 역할 경량화)
- 오프라인 지원 내장 (네트워크 끊겼다 복구 시 자동 동기화)

```typescript
// 클라이언트에서 실시간 메시지 구독
const messagesRef = collection(db, `rooms/${roomId}/messages`)
const q = query(messagesRef, orderBy('timestamp'))

onSnapshot(q, (snapshot) => {
  snapshot.docChanges().forEach((change) => {
    if (change.type === 'added') {
      displayMessage(change.doc.data())
    }
  })
})
```

#### Cloudflare (무료 플랜)

```
Cloudflare DNS       → 도메인 네임서버 (council.yourdomain.com)
Cloudflare CDN       → 정적 자산 캐싱, 글로벌 배포
Cloudflare Pages     → React SPA 빌드 & 호스팅
                       Git push → 자동 빌드/배포
                       프리뷰 URL (PR별 자동 생성)
Cloudflare SSL       → 엣지 SSL (브라우저 ↔ Cloudflare)
```

#### Oracle Cloud (Always Free Tier)

```
Ampere A1 (ARM)      → Council Server (포트 3001) + Claude Code 세션 실행
                       24GB RAM / 4 OCPU / 200GB SSD
                       상세: 00_설정_참조표.md § 8
```

### 5.4 Firestore vs WebSocket — 역할 분담

```
┌──────────────────────────────────────────────────┐
│  Firestore (영속 데이터 + 실시간 동기화)            │
│                                                    │
│  rooms/{roomId}                                    │
│    ├── name, description, status                   │
│    ├── messages/{msgId}     ← 실시간 리스너        │
│    │     ├── content, sender, timestamp             │
│    │     └── metadata (artifacts, status)           │
│    └── sets/{setId}                                │
│          ├── name, role, status                     │
│          └── internalLogs/{logId}  ← 접기/펼치기용  │
│                                                    │
│  users/{userId}                                    │
│    ├── profile (이름, 아바타)                        │
│    └── apiKeys/{keyId}  ← 암호화 저장               │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│  Council Server WebSocket (휘발성 상태)             │
│                                                    │
│  - Claude Code 세션 상태 (alive/dead)               │
│  - 타이핑 인디케이터 ("리더A가 생각 중...")           │
│  - Set 내부 실시간 프로그레스 (작업 중... 40%)       │
│  - 세션 heartbeat                                  │
└──────────────────────────────────────────────────┘
```

**원칙**: 저장해야 하는 것 → Firestore, 순간적인 것 → WebSocket

### 5.5 Claude Code 연동 방식

두 가지 접근법을 단계적으로 적용:

**Phase 1 — CLI 기반 (빠른 프로토타입)**
```
Council Server → claude --message "..." → stdout 파싱
```
- `claude` CLI를 subprocess로 실행
- `--output-format json` 으로 구조화된 응답 수신
- 가장 단순하지만, 세션 유지가 안 됨 (매번 새 세션)

**Phase 2 — Channel 기반 (목표 아키텍처)**
```
Council Server ←→ Custom MCP Channel ←→ Claude Code Session
```
- 커스텀 MCP Channel 서버 구현
- 각 Set마다 장기 실행 Claude Code 세션 유지
- 양방향 실시간 통신
- Agent Teams 활성화하여 Set 내부 팀워크

### 5.6 인증 구조

```
┌─────────────────────────────────────────────────┐
│  Level 1: 사용자 인증 — Firebase Auth             │
│                                                   │
│  - Google / GitHub 소셜 로그인                     │
│  - 사용자별 Council Room 격리                      │
│  - Firestore Security Rules로 데이터 접근 제어     │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│  Level 2: Claude API 인증 — BYOK                  │
│                                                   │
│  - 사용자가 Anthropic API 키 등록 (설정 화면)       │
│  - 서버에서 암호화 저장 (Firestore + AES-256)      │
│  - Claude Code 세션 시작 시 복호화하여 주입         │
│  - Max 플랜 사용 시: 인증 토큰 파일 업로드 지원     │
│                                                   │
│  Phase 1: 서버 환경변수로 단일 키 (개발용)          │
│  Phase 2: 사용자별 BYOK                           │
└─────────────────────────────────────────────────┘
```

### 5.7 배포 파이프라인

```
GitHub Push
    │
    ├─→ Cloudflare Pages (Web UI)
    │   - 자동 빌드 & 배포
    │   - PR별 프리뷰 URL
    │
    └─→ GitHub Actions → Oracle Ampere (Council Server)
        - Docker build (ARM)
        - SSH deploy 또는 Watchtower 자동 업데이트
```

> 📄 상세: `01_아키텍처/01_시스템_아키텍처.md`, `01_아키텍처/02_인프라_배포.md`, `01_아키텍처/03_Claude_Code_연동.md`, `01_아키텍처/04_세션_관리.md`

---

## 6. 데이터 모델 (Firestore)

> 필드 상세는 정규 스키마 문서 참조

### 6.1 컬렉션 구조

```
firestore/
├── users/{userId}
│
├── projects/{projectId}
│   ├── git/
│   │   └── config
│   │
│   ├── rooms/{roomId}
│   │   └── messages/{messageId}
│   │
│   ├── sets/{setId}
│   │   └── logs/{logId}
│   │
│   ├── tasks/{taskId}
│   │
│   ├── pullRequests/{prId}
│   │
│   └── snapshots/{snapshotId}
│
└── usage/{userId}
    └── monthly/{YYYY-MM}
```

**주요 enum 값 (요약):**

```typescript
ProjectStatus: 'planning' | 'in_progress' | 'review' | 'completed' | 'archived' | 'paused'
SetStatus:     'idle' | 'working' | 'waiting' | 'done' | 'error'
TaskStatus:    'backlog' | 'in_progress' | 'review' | 'done' | 'blocked'
```

**핵심 필드 메모:**
- `projects/{projectId}/git/config.githubTokenEncrypted` — 암호화된 GitHub PAT
- `users/{userId}.apiKeyEncrypted` — AES-256 암호화된 Anthropic API 키

> 📄 정규 스키마: `02_데이터설계/01_Firestore_스키마.md`
> 📄 보안 규칙: `02_데이터설계/02_Security_Rules.md`
> 📄 메시지 프로토콜: `02_데이터설계/03_메시지_프로토콜.md`

---

## 7. 핵심 플로우

### 7.1 프로젝트 시작
```
1. PM이 Firebase Auth로 로그인
2. 프로젝트 생성
   - 신규: 프로젝트명, 기술 스택 입력 → 빈 Git repo 초기화
   - 기존: GitHub repo URL 입력 → 서버에 클론
   - 분석: 대상 repo URL → 읽기 전용 클론
3. Council Room 자동 생성 (프로젝트에 종속)
4. PM이 목표 입력: "사내 메신저 시스템을 React + Spring Boot로 만들자"
5. Council Server가 초기 Set 구성 제안 (또는 PM이 직접 지정)
6. 각 Set에 대해:
   - Git worktree 생성 (set-{id}/{topic} 브랜치)
   - Claude Code 세션 시작 (worktree 경로에서)
7. 리더들이 Council Room에 입장하며 자기소개
   → 각 메시지가 Firestore에 저장 → 실시간 리스너로 UI 자동 업데이트
```

### 7.2 대화 → 태스크 → 코드 루프
```
1. [대화] 리더 A가 메시지 → Firestore → 모든 클라이언트 자동 수신
2. [대화] 리더들이 논의, 합의 도출
3. [태스크] PM 또는 리더가 합의 내용을 태스크로 등록
   → Firestore tasks 컬렉션에 생성
   → 담당 Set 할당, 보드 UI에 표시
4. [코드] 담당 Set 리더가 자기 worktree에서 팀원에게 작업 지시
   → 팀원이 코드 작성 (Set 내부, Council Room에는 요약만)
5. [코드] 작업 완료 → Set 브랜치에 커밋
6. [PR] 리더가 "작업 완료" 보고 → Council Server가 PR 자동 생성
   → PR 정보가 Firestore pullRequests에 저장
   → Council Room에 PR 링크 공유
7. [리뷰] 다른 Set 리더(특히 QA)가 코드 리뷰
   → 리뷰 코멘트가 Council 대화 + PR에 동시 기록
8. [머지] PM 승인 → main에 머지
   → 다른 Set의 worktree에 자동 rebase
   → 태스크 상태 → done
9. 다음 태스크로 반복
```

### 7.3 Set 내부 작업 (Council Room 외부)
```
1. 리더가 팀원에게 태스크 분배
2. 팀원 간 내부 커뮤니케이션 (Agent Teams)
3. 팀원이 worktree 내에서 코드 작성/수정
4. 이슈 발생 시 리더가 판단:
   - 내부 해결 가능 → 팀 내부에서 처리
   - 다른 팀 협의 필요 → Council Room에 에스컬레이션
   - Git 충돌 → Council Room에서 관련 Set 리더와 해결
5. 작업 완료 → 브랜치에 커밋 → 리더가 Council Room에 보고
```

### 7.4 Git 이벤트 → Council 알림
```
Council Server가 Git 이벤트를 감지하여 자동으로 Council Room에 알림:

  [시스템] Set B가 set-b/backend 브랜치에 3개 커밋을 푸시했습니다.
          - feat: 채팅 API 엔드포인트 구현
          - feat: WebSocket STOMP 핸들러
          - fix: CORS 설정 추가

  [시스템] PR #3 "백엔드 채팅 API" 가 생성되었습니다.
          set-b/backend → main | +423 -12 | 파일 8개

  [시스템] PR #3이 main에 머지되었습니다.
          Set A, Set C의 worktree를 자동 rebase합니다...
          ✅ Set A: rebase 성공
          ⚠️ Set C: 충돌 발생 (src/App.tsx) → Set C 리더에게 알림
```

### 7.5 세션 관리 & 대화 재개

Claude Code 세션은 기본적으로 휘발성이다. 브라우저를 닫거나 시간이 지나면 세션 컨텍스트가 사라진다.
이를 해결하기 위해 3개 레이어로 대화 연속성을 보장한다.

#### Layer 1 — 대화 히스토리 (자동 해결)
```
모든 메시지가 Firestore에 저장되어 있으므로,
PM이 브라우저를 다시 열면 이전 대화를 그대로 볼 수 있다.
→ UI 수준에서는 이미 해결됨
```

#### Layer 2 — 프로젝트 상태 스냅샷

Council Server가 주기적으로 + 주요 이벤트 시점에 "프로젝트 상태 요약"을 자동 생성하여 Firestore에 저장.

```
Firestore: projects/{projectId}/snapshots/{snapshotId}

{
  "createdAt": "2026-03-23T14:30:00Z",
  "trigger": "pr_merged",              // 스냅샷 생성 이유
  "summary": "사내 메신저 프로젝트 - Phase 1 진행 중",
  "completedTasks": ["DB 스키마 설계", "API 스펙 정의"],
  "inProgressTasks": [
    { "task": "백엔드 API 구현", "set": "Set B", "progress": "70%" },
    { "task": "프론트 UI", "set": "Set C", "progress": "40%" }
  ],
  "decisions": [
    "1차에서는 SimpleBroker 사용, Redis는 2차로",
    "cursor 기반 페이지네이션 채택",
    "소셜 로그인은 2차 스코프"
  ],
  "gitState": {
    "mainCommits": 5,
    "openPRs": ["#4 프론트 로그인 UI"],
    "branches": {
      "set-b/backend": "ahead 3",
      "set-c/frontend": "ahead 7"
    }
  },
  "recentMessages": 30                 // 최근 N개 메시지 ID 참조
}
```

**스냅샷 생성 시점:**
- PR 머지 시
- 태스크 상태 변경 시 (in_progress → done)
- PM이 명시적으로 "상태 저장" 요청 시
- 30분 주기 자동 저장 (세션 활성 상태일 때)
- Council Room 일시정지/종료 시

#### Layer 3 — Claude Code 세션 복원

PM이 돌아왔을 때 세션을 복원하는 두 가지 전략:

```
전략 A: 세션 유지 (기본)
┌─────────────────────────────────────────────┐
│ Council Server가 tmux 세션으로 Claude Code   │
│ 프로세스를 유지. PM이 없어도 세션은 살아있음.  │
│                                              │
│ PM 복귀 → 기존 세션에 그대로 연결             │
│ 장점: 컨텍스트 100% 보존                      │
│ 단점: 서버 리소스 점유, 장시간 방치 시 낭비    │
└─────────────────────────────────────────────┘

전략 B: 세션 재생성 + 컨텍스트 주입 (폴백)
┌─────────────────────────────────────────────┐
│ 세션이 타임아웃/종료된 경우:                   │
│                                              │
│ 1. 최신 스냅샷을 Firestore에서 로드           │
│ 2. 새 Claude Code 세션 시작                   │
│ 3. 시스템 프롬프트에 컨텍스트 주입:            │
│                                              │
│    "당신은 백엔드팀 리더입니다.                │
│     프로젝트: 사내 메신저 (React+Spring Boot)  │
│     현재 상태: API 구현 70% 완료              │
│     완료된 작업: DB 스키마, API 스펙           │
│     주요 결정사항:                            │
│     - SimpleBroker 사용 (Redis는 2차)         │
│     - cursor 페이지네이션                     │
│     최근 대화: [최근 30개 메시지]              │
│     Git 상태: set-b/backend (ahead 3)"        │
│                                              │
│ 4. 리더가 맥락을 파악한 상태로 대화 재개       │
└─────────────────────────────────────────────┘
```

**복원 우선순위:**
```
PM 복귀
  ├── 기존 세션 살아있음? → 전략 A (그대로 연결)
  └── 세션 죽음?
       ├── 스냅샷 있음? → 전략 B (재생성 + 주입)
       └── 스냅샷 없음? → Firestore 메시지에서 요약 생성 → 전략 B
```

#### 자동 세션 관리 정책

```
┌─────────────────────────────────────────┐
│ PM 활성 상태 (브라우저 열림)              │
│ → 세션 유지, 리더들 정상 동작             │
├─────────────────────────────────────────┤
│ PM 부재 30분 이내                        │
│ → 세션 유지, 진행 중 작업은 계속 수행     │
│ → 의사결정 필요한 건 큐에 보관            │
├─────────────────────────────────────────┤
│ PM 부재 30분~2시간                       │
│ → 세션 유지, 신규 작업 시작하지 않음      │
│ → 현재 작업만 마무리                     │
├─────────────────────────────────────────┤
│ PM 부재 2시간 초과                       │
│ → 스냅샷 저장 후 세션 종료 (리소스 해제)  │
│ → 복귀 시 전략 B로 재개                  │
└─────────────────────────────────────────┘
```

> 📄 상세: `05_기능명세/08_Claude_Code_어댑터.md`, `05_기능명세/09_세션_관리.md`

---

## 8. 구현 로드맵

### Phase 1: Council 프로토타입 (MVP)
> 목표: 프로젝트를 만들고, 리더들이 대화하며 실제 코드를 생성하는 최소 버전

- [ ] **프로젝트 셋업**
  - [ ] 모노레포 구성 (packages: server, web, shared)
  - [ ] Firebase 프로젝트 생성 + Firestore/Auth 활성화
  - [ ] Cloudflare Pages 연결
- [ ] **Council Server 코어**
  - [ ] Node.js + TypeScript 기본 구조
  - [ ] Firestore 연동 (메시지 읽기/쓰기)
  - [ ] WebSocket 서버 (타이핑 등 휘발성 이벤트)
- [ ] **프로젝트 관리**
  - [ ] 프로젝트 생성 (신규 repo 초기화 / 기존 repo 클론)
  - [ ] 프로젝트 목록/상세 UI
  - [ ] Git 기본 연동 (init, clone, status)
- [ ] **Claude Code CLI 어댑터**
  - [ ] subprocess로 claude 호출
  - [ ] 응답 파싱 → Firestore 메시지로 변환
  - [ ] 단일 API 키 (환경변수)
- [ ] **Web Chat UI**
  - [ ] Firebase Auth 로그인 (Google)
  - [ ] 프로젝트 대시보드 (프로젝트 목록 + 상태)
  - [ ] 채팅방 UI (Firestore 실시간 리스너)
  - [ ] 리더별 색상/아이콘 구분
  - [ ] PM 메시지 입력
- [ ] **Set 관리**
  - [ ] Set 생성/삭제 UI
  - [ ] 리더 역할 프롬프트 설정
  - [ ] Set별 Git worktree 자동 생성
- [ ] **배포**
  - [ ] Cloudflare Pages에 Web UI 배포
  - [ ] Oracle Ampere에 Council Server 배포
  - [ ] 도메인 연결 + SSL

**결과물**: 웹에서 프로젝트를 만들고, AI 리더들이 대화하며 실제 코드를 각자 브랜치에 작성

### Phase 2: 코드 관리 & 팀워크
> 목표: Git 워크플로우 완성 + Set 내부 Agent Teams 동작

- [ ] **Git 워크플로우**
  - [ ] Set별 worktree 생명주기 관리
  - [ ] 자동 PR 생성 (GitHub API)
  - [ ] Council Room에서 PR 리뷰/승인/머지
  - [ ] 머지 후 다른 Set worktree 자동 rebase
  - [ ] Git 이벤트 → Council 알림 (커밋, PR, 머지)
- [ ] **태스크 보드**
  - [ ] 칸반 UI (Backlog → In Progress → Review → Blocked → Done)
  - [ ] Council 대화에서 태스크 등록 ("태스크로 등록해")
  - [ ] 태스크 ↔ Set ↔ 브랜치 ↔ PR 연결
  - [ ] 의존성 표시 및 순서 제어
- [ ] **Claude Code Channel 어댑터**
  - [ ] 커스텀 MCP Channel 서버 구현
  - [ ] 장기 세션 유지
  - [ ] Agent Teams 활성화하여 Set 내부 팀워크
- [ ] **Set 내부 작업 현황**
  - [ ] 팀원 작업 로그 수집 → Firestore 서브컬렉션
  - [ ] Council Room에 요약 표시
  - [ ] UI에서 접기/펼치기
- [ ] **세션 관리**
  - [ ] 프로젝트 상태 스냅샷 자동 생성
  - [ ] 세션 유지 (tmux)
  - [ ] 세션 복원 + 컨텍스트 주입 (폴백)
  - [ ] PM 부재 시 자동 세션 관리 정책
- [ ] **사용자별 BYOK**
  - [ ] API 키 등록 UI
  - [ ] 암호화 저장/복호화 로직

**결과물**: 완전한 개발 루프 — 대화 → 태스크 → 코딩 → PR → 리뷰 → 머지

### Phase 3: 고도화
> 목표: 실용적인 개발 도구로 발전

- [ ] **스마트 오케스트레이션**
  - [ ] 자동 Set 구성 (목표 분석 → 적절한 팀 자동 생성)
  - [ ] 의존성 감지 (백엔드 API 완료 → 프론트 연동 자동 트리거)
  - [ ] 병렬/순차 작업 자동 스케줄링
- [ ] **프로젝트 고도화**
  - [ ] CLAUDE.md 자동 생성/공유
  - [ ] Set 간 코드 아티팩트 공유
  - [ ] 빌드/테스트 자동 실행 (CI 연동)
  - [ ] 프로젝트 템플릿 (React+Spring, Next.js 등)
- [ ] **운영 기능**
  - [ ] 비용 추적 (토큰 사용량 → Firestore usage 컬렉션)
  - [ ] 작업 히스토리/리플레이
  - [ ] Grafana Cloud 모니터링 연동
  - [ ] 프로젝트 아카이브 & 결과 보고서 자동 생성

> 📄 상세: `06_구현가이드/01_프로젝트_셋업.md`, `06_구현가이드/02_Phase1_구현순서.md`, `06_구현가이드/03_Phase2_구현순서.md`

---

## 9. 디렉토리 구조 (계획)

```
agent-council/
├── docs/
│   └── PLAN.md                    # 이 문서
├── packages/
│   ├── server/                    # Council Server
│   │   ├── src/
│   │   │   ├── project/           # 프로젝트 생명주기, 설정
│   │   │   ├── council/           # Room, Message 관리
│   │   │   ├── sets/              # Agent Set 생명주기, worktree
│   │   │   ├── tasks/             # 태스크 보드 관리
│   │   │   ├── git/               # Git 연동 (worktree, branch, PR)
│   │   │   ├── session/           # 세션 관리, 스냅샷, 복원
│   │   │   ├── adapters/          # Claude Code 연동 (CLI, Channel)
│   │   │   ├── firebase/          # Firestore, Auth Admin SDK
│   │   │   └── ws/                # WebSocket (휘발성 이벤트)
│   │   ├── Dockerfile
│   │   └── package.json
│   ├── web/                       # Web Chat UI
│   │   ├── src/
│   │   │   ├── pages/             # 페이지 (대시보드, 프로젝트, 채팅, 보드)
│   │   │   ├── components/        # 채팅, 칸반 보드, Git 상태 UI
│   │   │   ├── hooks/             # Firestore 리스너, WebSocket
│   │   │   ├── stores/            # Zustand 스토어
│   │   │   └── firebase/          # Firebase 클라이언트 설정
│   │   └── package.json
│   └── shared/                    # 공유 타입, 유틸
│       └── package.json
├── firebase/
│   ├── firestore.rules            # Security Rules
│   ├── firestore.indexes.json     # 복합 인덱스
│   └── firebase.json              # Firebase 프로젝트 설정
├── .github/
│   └── workflows/
│       └── deploy.yml             # CI/CD
├── CLAUDE.md
├── package.json                   # Workspace root (pnpm)
└── README.md
```

---

## 10. 기술적 도전과 리스크

### 10.1 Claude Code 세션 관리
- **문제**: 여러 Claude Code 세션을 동시에 장기 실행해야 함
- **리스크**: 메모리/CPU 리소스, 세션 타임아웃
- **대응**: Phase 1에서 CLI 기반으로 먼저 검증, Phase 2에서 Channel로 전환

### 10.2 컨텍스트 일관성
- **문제**: 각 Set 리더가 Council 대화의 전체 맥락을 유지해야 함
- **리스크**: 긴 대화에서 컨텍스트 윈도우 초과
- **대응**: 메시지 요약, 중요 결정사항만 컨텍스트에 주입

### 10.3 작업 디렉토리 충돌
- **문제**: 여러 Set이 같은 코드베이스를 동시에 수정
- **리스크**: 파일 충돌, 덮어쓰기
- **대응**: Git worktree 활용하여 Set별 독립 브랜치, 리더 합의 후 머지

### 10.4 Channel API 안정성
- **문제**: Channels가 아직 리서치 프리뷰
- **리스크**: API 변경, 기능 제거 가능성
- **대응**: Adapter 패턴으로 연동부 격리, CLI 폴백 유지

### 10.5 Firestore 무료 한도
- **문제**: Spark 플랜 일 50K 읽기 / 20K 쓰기
- **리스크**: 활발한 Council 세션에서 한도 초과 가능
- **대응**: 메시지 배치 쓰기, 클라이언트 캐싱, 필요 시 Blaze 종량제 전환 ($0.06/10만 읽기)

### 10.6 인증 키 보안
- **문제**: 사용자 API 키를 서버에 저장
- **리스크**: 키 유출
- **대응**: AES-256 암호화, 서버 환경변수로 암호화 키 관리, 메모리에서만 복호화

> 📄 보안 상세: `05_기능명세/07_인증_보안.md`

---

## 11. 비용 구조

### 무료 구간 (개발 + 소규모 사용)

| 서비스 | 무료 한도 | 예상 사용량 | 여유 |
|---|---|---|---|
| Oracle Ampere | 24GB/200GB | 상세: 00_설정_참조표.md § 8 | 충분 |
| Firebase Auth | 월 10,000 MAU | 수십 회 | 충분 |
| Firestore | 일 50K 읽기 | 일 ~5K-10K | 충분 |
| Firebase Storage | 5GB | ~100MB | 충분 |
| Cloudflare Pages | 월 500 빌드 | 월 ~30 빌드 | 충분 |
| Cloudflare CDN | 무제한 | — | 충분 |
| Grafana Cloud | 50GB 로그 | ~1GB | 충분 |

### 유일한 실비용

| 항목 | 비용 |
|---|---|
| 도메인 (선택) | ~$10-15/년 |
| Claude API 토큰 | 종량제 (또는 Max 플랜 $200/월) |

> 📄 인프라 상세: `01_아키텍처/02_인프라_배포.md`

---

## 12. 성공 기준

### MVP (Phase 1)
- [ ] 웹 브라우저에서 접속하여 PM이 메시지를 보내면 3개 이상의 AI 리더가 각자 역할에 맞게 응답
- [ ] 리더 간 대화가 자연스럽게 이어짐 (상호 참조, 질문, 합의)
- [ ] 프로젝트 생성 → 리더 대화 → 실제 코드가 Git 브랜치에 커밋되는 전체 루프
- [ ] Cloudflare Pages + 도메인으로 외부 접속 가능

### Phase 2
- [ ] 대화 → 태스크 등록 → 코딩 → PR → 리뷰 → 머지의 완전한 개발 사이클
- [ ] Set 내부 팀워크가 동작하고, Council Room에 요약 보고
- [ ] 세션 재개 시 리더가 이전 맥락을 파악한 상태로 대화 이어감
- [ ] 태스크 보드에서 프로젝트 진행 상황을 한눈에 파악

### 최종
- [ ] PM이 최소한의 개입으로 중규모 프로젝트 진행 가능
- [ ] 기존 GitHub 프로젝트에 기능 추가도 Council로 수행
- [ ] 세션 비용 대비 생산성 향상 체감
- [ ] 월 운영비 $0 (API 토큰 제외)
