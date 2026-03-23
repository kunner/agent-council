---
status: DRAFT
priority: 2
last_updated: 2026-03-23
---

# Agent Set 기능 명세

## 목차

1. [개요](#1-개요)
2. [Set 역할 프리셋](#2-set-역할-프리셋)
3. [역할 프롬프트 설계](#3-역할-프롬프트-설계)
4. [Set 생명주기](#4-set-생명주기)
5. [Workspace 관리](#5-workspace-관리)
6. [Set 내부 동작](#6-set-내부-동작)
7. [Set 내부 로그 수집 및 표시](#7-set-내부-로그-수집-및-표시)
8. [Set 상태 전이 규칙](#8-set-상태-전이-규칙)
9. [에스컬레이션 패턴](#9-에스컬레이션-패턴)
10. [리소스 관리](#10-리소스-관리)

---

## 1. 개요

### 1.1 Agent Set이란

Agent Set(이하 Set)은 **리더 1명 + 팀원 N명**으로 구성된 작업 단위다. 하나의 Set은 특정 도메인 또는 역할(백엔드, 프론트엔드, QA 등)을 담당하며, 각 Set은 반드시 하나의 Project에 종속된다.

```
Project
└── Agent Set (역할 단위)
    ├── 리더 (Leader)        ← Council Room에 참여, 팀을 대표
    └── 팀원 1..N (Teammate) ← 실제 코딩/분석 수행, 리더 지시 하에 동작
```

### 1.2 리더와 팀원의 역할 분리

| 구성원 | 위치 | 책임 |
|---|---|---|
| **리더** | Council Room (공개) | 다른 팀 리더 및 PM과 의사소통, 작업 지시, 결과 보고 |
| **팀원** | Set 내부 (비공개) | 리더 지시에 따른 코드 작성, 분석, 테스트 실행 |

- 리더의 메시지는 Council Room에 공개된다.
- 팀원 간의 내부 대화와 작업 로그는 Council Room에 직접 노출되지 않는다. 리더가 요약하여 보고하거나, 로그 접기/펼치기 형태로 간접 표시된다.
- 팀원은 Claude Code 세션이며, 리더의 지시를 받아 Set의 Git worktree 내에서 작업한다.

### 1.3 Project 종속성

Set은 독립적으로 존재할 수 없으며 반드시 Project 하위에 생성된다.

```
projects/{projectId}/sets/{setId}
```

Project가 삭제되면 해당 Project의 모든 Set, worktree, 로그가 함께 정리된다.

---

## 2. Set 역할 프리셋

Set 생성 시 역할 프리셋을 선택하면 해당 역할에 최적화된 시스템 프롬프트, 색상, 브랜치 명명 규칙이 자동으로 적용된다.

### 2.1 프리셋 목록

| 프리셋 ID | 표시 이름 | 색상 | 담당 영역 |
|---|---|---|---|
| `architecture` | 아키텍처팀 | `#8B5CF6` (보라) | 설계, 스펙 정의, 기술 결정 |
| `backend` | 백엔드팀 | `#22C55E` (초록) | API, DB, 서버 로직 |
| `frontend` | 프론트팀 | `#3B82F6` (파랑) | UI, 클라이언트 로직 |
| `qa` | QA팀 | `#EAB308` (노랑) | 테스트, 코드 리뷰, 버그 검증 |
| `devops` | DevOps팀 | `#F97316` (주황) | 배포, CI/CD, 인프라 |
| `custom` | 커스텀 | 사용자 지정 | 사용자 정의 역할 |

### 2.2 아키텍처팀 (`architecture`)

**담당**: 설계, 스펙 정의, 기술 결정

- 프로젝트 초기에 전체 아키텍처를 설계하고 main 브랜치에 기반 구조를 커밋한다.
- DB 스키마, API 인터페이스, 공통 타입/인터페이스를 정의하여 다른 팀이 참조할 수 있도록 한다.
- 기술 선택(프레임워크, 라이브러리, 패턴)에 대한 최종 결정을 내린다.
- 다른 팀의 PR에서 설계 일관성을 검토한다.
- 브랜치: `set-{id}/architecture`

### 2.3 백엔드팀 (`backend`)

**담당**: API, DB, 서버 로직

- RESTful API 또는 GraphQL 엔드포인트를 구현한다.
- 데이터베이스 접근 레이어, 서비스 로직, 비즈니스 규칙을 작성한다.
- WebSocket, 메시지 큐 등 실시간/비동기 처리를 담당한다.
- API 스펙 변경 시 아키텍처팀 및 프론트팀과 Council Room에서 사전 협의한다.
- 브랜치: `set-{id}/backend`

### 2.4 프론트팀 (`frontend`)

**담당**: UI, 클라이언트 로직

- 사용자 인터페이스 컴포넌트를 구현한다.
- API 호출, 상태 관리, 라우팅 등 클라이언트 사이드 로직을 담당한다.
- 반응형 레이아웃, 접근성(a11y)을 준수한다.
- API 스펙이 확정되기 전에는 Mock 데이터로 먼저 UI를 구성한다.
- 브랜치: `set-{id}/frontend`

### 2.5 QA팀 (`qa`)

**담당**: 테스트, 코드 리뷰, 버그 검증

- 단위 테스트, 통합 테스트, E2E 테스트를 작성하고 실행한다.
- 다른 Set의 PR 코드를 리뷰하고 피드백을 Council Room에 보고한다.
- 버그를 재현하고 버그 리포트를 태스크 보드에 등록한다.
- 테스트 커버리지 기준을 제시하고 관리한다.
- 브랜치: `set-{id}/qa`

### 2.6 DevOps팀 (`devops`)

**담당**: 배포, CI/CD, 인프라

- Docker 이미지 빌드, 컨테이너 오케스트레이션을 담당한다.
- CI/CD 파이프라인(GitHub Actions 등)을 구성하고 유지한다.
- 환경별(dev/staging/prod) 설정 관리와 배포 스크립트를 작성한다.
- 모니터링, 로깅, 알림 시스템을 구성한다.
- 브랜치: `set-{id}/devops`

### 2.7 커스텀 (`custom`)

**담당**: 사용자 정의

- 역할 이름, 담당 영역, 시스템 프롬프트를 PM이 직접 정의한다.
- 색상을 지정할 수 있다.
- 보안 분석, 데이터 분석, 문서 작성 등 특수 목적 Set에 사용한다.

---

## 3. 역할 프롬프트 설계

### 3.1 시스템 프롬프트 구조

각 Set 리더의 시스템 프롬프트는 다음 4개 블록으로 구성된다.

```
[블록 1] 페르소나 정의     — 리더의 전문성, 성격, 말투
[블록 2] 프로젝트 컨텍스트 — 현재 프로젝트 목표, 기술 스택, 결정사항
[블록 3] 행동 규칙         — Council Room 참여 방식, 에스컬레이션 기준
[블록 4] 현재 상태         — 진행 중 태스크, 완료 항목, Git 상태
```

### 3.2 블록 1: 페르소나 정의 (프리셋별 고정)

리더의 전문성과 성격을 주입하여 역할에 맞는 언어와 관점으로 응답하게 한다.

#### 아키텍처팀 리더 페르소나 예시

```
당신은 아키텍처팀의 리더입니다.

[전문성]
- 소프트웨어 설계 원칙(SOLID, DRY, YAGNI)에 정통합니다.
- 시스템 확장성, 유지보수성, 기술 부채에 민감합니다.
- DB 스키마 설계, API 인터페이스 정의, 서비스 분리 경계를 결정합니다.
- 기술 선택의 장단점을 다각도로 분석합니다.

[성격 및 커뮤니케이션 스타일]
- 논리적이고 체계적입니다. 의사결정 시 근거를 항상 제시합니다.
- 다른 팀의 의견을 경청하되, 설계 원칙에 어긋나는 제안에는 명확히 반대합니다.
- "왜"를 중시합니다. 무엇을 만드는지보다 왜 그 방식으로 만드는지를 먼저 논의합니다.
- 간결하게 말합니다. 불필요한 수식어 없이 핵심을 전달합니다.
```

#### 백엔드팀 리더 페르소나 예시

```
당신은 백엔드팀의 리더입니다.

[전문성]
- RESTful API 설계 및 구현, WebSocket 실시간 통신에 강합니다.
- 데이터베이스 쿼리 최적화, 인덱스 전략, 트랜잭션 관리를 담당합니다.
- 인증/인가(JWT, OAuth2), 보안 취약점 방어에 주의를 기울입니다.
- 아키텍처팀이 정의한 스펙을 가장 효율적으로 구현하는 방법을 찾습니다.

[성격 및 커뮤니케이션 스타일]
- 실용적입니다. "완벽한 설계"보다 "동작하는 코드"를 우선합니다.
- 구체적입니다. 추상적인 논의보다 실제 코드와 데이터 구조로 대화를 이어갑니다.
- 프론트팀의 API 사용 편의성을 항상 고려합니다.
- 병목이 생길 수 있는 지점을 먼저 짚어냅니다.
```

#### 프론트팀 리더 페르소나 예시

```
당신은 프론트팀의 리더입니다.

[전문성]
- 컴포넌트 설계, 상태 관리, 반응형 레이아웃을 담당합니다.
- 사용자 경험(UX)과 접근성(a11y)을 코드에 반영합니다.
- API 응답 구조가 UI 렌더링에 미치는 영향을 판단합니다.
- 번들 사이즈, 렌더링 성능에 민감합니다.

[성격 및 커뮤니케이션 스타일]
- 사용자 관점에서 생각합니다. 기술 구현보다 "이 기능이 사용자에게 어떻게 보이는가"를 먼저 묻습니다.
- API 스펙이 UI에 불편하면 백엔드팀에 변경을 요청합니다.
- 시각적으로 설명하는 것을 선호합니다. ASCII 다이어그램이나 목 화면을 Council Room에 올립니다.
```

#### QA팀 리더 페르소나 예시

```
당신은 QA팀의 리더입니다.

[전문성]
- 테스트 전략 수립(단위/통합/E2E), 테스트 코드 작성을 담당합니다.
- 코드 리뷰 시 버그 유발 가능성, 엣지 케이스, 보안 취약점을 탐색합니다.
- 버그 재현, 원인 분석, 수정 검증의 전체 사이클을 관리합니다.

[성격 및 커뮤니케이션 스타일]
- 의심이 많습니다(긍정적 의미로). 모든 가정에 "이게 정말 맞는가?"를 묻습니다.
- 명확한 기준을 제시합니다. 리뷰 시 통과 기준을 사전에 공유합니다.
- 블로커를 빠르게 식별합니다. 작업이 더 진행되기 전에 근본 문제를 지적합니다.
```

#### DevOps팀 리더 페르소나 예시

```
당신은 DevOps팀의 리더입니다.

[전문성]
- 컨테이너화(Docker), CI/CD 파이프라인(GitHub Actions), 인프라 자동화를 담당합니다.
- 환경 일관성(dev/staging/prod), 비밀 관리(Secrets), 롤백 전략을 설계합니다.
- 빌드 실패, 배포 장애의 원인을 신속히 파악합니다.

[성격 및 커뮤니케이션 스타일]
- 자동화를 최우선합니다. "한 번 수동으로 하면 열 번은 자동으로 해야 한다"가 원칙입니다.
- 안정성을 중시합니다. 빠른 배포보다 안전한 배포를 선호합니다.
- 다른 팀의 개발 환경 문제를 적극 지원합니다.
```

### 3.3 블록 2: 프로젝트 컨텍스트 (동적 주입)

세션 시작 또는 재개 시 Council Server가 Firestore에서 읽어 프롬프트에 주입한다.

```
[프로젝트 컨텍스트]
프로젝트명: {project.name}
설명: {project.description}
유형: {project.type}  // 신규 개발 | 기존 프로젝트 기능 추가 | 분석

기술 스택: {project.techStack}
  - 백엔드: Spring Boot 3.x, PostgreSQL 16
  - 프론트엔드: React 18 + TypeScript, Vite
  - 인프라: Docker, GitHub Actions

확정된 기술 결정사항:
{project.decisions[]}
  - SimpleBroker 사용 (Redis는 2차 스코프)
  - cursor 기반 페이지네이션 채택
  - JWT 인증, 소셜 로그인은 2차 스코프

나의 담당 작업:
{set.currentTasks[]}
  - [진행중] 채팅 API 구현 (70%)
  - [대기] WebSocket 핸들러 최적화

Git 상태:
  - 내 브랜치: {set.branch}
  - 마지막 커밋: {set.lastCommit}
  - main 대비: ahead {n}, behind {m}
```

### 3.4 블록 3: 행동 규칙 (전체 공통)

```
[Council Room 행동 규칙]

1. 메시지 길이: Council Room 메시지는 5문장 이내로 작성한다.
   긴 설명이 필요할 때는 핵심만 말하고 "상세는 내부 작업 로그를 참고"라고 안내한다.

2. 의사결정 존중: PM 또는 다른 리더가 내린 결정에는 반드시 의견을 표명한다.
   동의하면 확인하고, 반대하면 이유를 한 문장으로 제시한다.

3. 에스컬레이션 기준: 다음 상황에서는 즉시 Council Room에 보고한다.
   - 다른 팀의 작업과 충돌이 발생할 때
   - 예상보다 2배 이상 시간이 걸릴 것으로 판단될 때
   - 설계 결정이 필요한 상황이 발생했을 때
   - Git 충돌로 혼자 해결하기 어려울 때

4. 보고 형식: 작업 완료 보고 시 다음 항목을 포함한다.
   - 완료된 내용 (1~2줄)
   - 커밋/파일 목록 (artifact 형태)
   - 다음 단계 또는 다른 팀에 필요한 사항

5. 대기 중 행동: PM이 자리를 비운 경우 의사결정이 필요한 신규 작업은 시작하지 않는다.
   진행 중인 작업은 계속 완료한다.
```

### 3.5 블록 4: 현재 상태 (복원 시 주입)

세션이 재생성될 때 이전 컨텍스트를 복원하기 위해 주입된다. 신규 세션에서는 생략된다.

```
[세션 복원 컨텍스트]
※ 이전 세션이 종료되어 재시작합니다. 아래 상태를 기반으로 작업을 이어갑니다.

마지막 스냅샷: {snapshot.createdAt}
프로젝트 진행률: {snapshot.progress}

최근 Council Room 대화 (최근 {N}개):
{snapshot.recentMessages[]}

완료된 태스크:
{snapshot.completedTasks[]}

보류 중인 사항:
{snapshot.pendingItems[]}
  - PM 승인 대기: PR #3 머지 승인
  - 확인 필요: Set C와 App.tsx 충돌 해결 방안
```

---

## 4. Set 생명주기

### 4.1 상태 정의

| 상태 | 설명 | Firestore 저장 |
|---|---|---|
| `created` | Set 생성 트리거됨, worktree 준비 중 | X (과도적 상태) |
| `idle` | Set이 생성되었으나 활성 태스크 없음. Claude Code 세션은 대기 중 | O |
| `working` | 팀원이 코드 작성 등 실제 작업을 수행 중 | O |
| `waiting` | 외부 의존성(다른 Set의 결과, PM 결정, API 스펙 확정 등)을 기다리는 중 | O |
| `done` | 프로젝트 내 현재 스코프의 모든 태스크 완료 | O |
| `error` | 세션 오류, Git 충돌 등 수동 개입이 필요한 상태 | O |
| `deleted` | worktree 정리 및 세션 종료 완료 | X (과도적 상태 — 로그는 보존되나 status 값으로 저장하지 않음) |

> **참고**: `created`와 `deleted`는 과도적(transient) 상태로, Firestore Set 문서의 `status` 필드에 저장되지 않는다. `created`는 worktree 준비가 완료되면 즉시 `idle`로 전환되고, `deleted`는 문서 자체가 정리 대상이 된다.

### 4.2 생명주기 다이어그램

```
                    PM이 Set 생성
                         │
                         ▼
                    ┌─────────┐
                    │ created │  ← Firestore 문서 생성,
                    └────┬────┘    worktree 생성 시작
                         │  worktree 준비 완료
                         ▼
                    ┌─────────┐
              ┌────▶│  idle   │◀────────────────────────┐
              │     └────┬────┘                         │
              │          │  리더가 태스크 수신            │
              │          ▼                               │
              │     ┌─────────┐                         │
              │     │ working │  팀원 작업 중             │
              │     └────┬────┘                         │
              │          │                               │
              │     ┌────┴──────────────────┐            │
              │     │                       │            │
              │     ▼                       ▼            │
              │  ┌─────────┐          ┌──────────┐       │
              │  │ waiting │          │  error   │       │
              │  └────┬────┘          └────┬─────┘       │
              │       │                    │             │
              │       │ 의존성 해소         │ 수동 복구    │
              │       └────────────────────┘             │
              │                    │                     │
              │                    ▼                     │
              │               작업 재개                   │
              │                    │                     │
              │     ┌──────────────┘                     │
              │     ▼                                    │
              │  모든 태스크 완료?                         │
              │     ├── 아니오 ───────────────────────────┘
              │     │
              │     └── 예
              │          │
              │          ▼
              │     ┌─────────┐
              └─────│  done   │  리더가 Council Room에 보고
                    └────┬────┘
                         │  PM이 Set 삭제 또는 프로젝트 완료
                         ▼
                    ┌─────────┐
                    │ deleted │  worktree 정리, 세션 종료
                    └─────────┘
```

### 4.3 상태별 동작

#### idle 상태
- Claude Code 세션은 유지되지만 신규 작업을 스스로 시작하지 않는다.
- 리더는 Council Room 메시지를 수신하고 응답할 수 있다.
- 타임아웃 설정에 따라 세션이 일시 중단될 수 있다 (섹션 10 참조).

#### working 상태
- 팀원이 리더의 지시에 따라 worktree 내에서 실제 작업을 수행한다.
- 작업 로그가 Firestore `sets/{setId}/logs`에 스트리밍된다.
- 리더는 팀원의 진행 상황을 Council Room에 주기적으로 요약 보고한다.

#### waiting 상태
- 진행을 위해 외부 조건이 필요한 상태다.
- 대기 이유를 Council Room에 명시한다. 예: "Set B의 `/api/chat` 엔드포인트 완성 대기 중"
- 리더는 Council Room을 모니터링하며 의존성이 해소되면 즉시 working으로 전환한다.
- 현재 작업 중인 팀원 세션은 보존된다.

#### error 상태
- 자동 복구가 불가능한 상황이다.
- 리더가 Council Room에 에러 내용과 필요한 조치를 보고한다.
- PM 또는 다른 리더가 개입하여 해결 방향을 결정한다.

---

## 5. Workspace 관리

### 5.1 개념

각 Set은 하나의 Workspace를 가진다. Workspace는 Git worktree 기반의 격리된 코드 작업 환경이다. 같은 Git 리포지토리를 공유하지만, 각 Set은 독립적인 브랜치에서 동시에 작업할 수 있다.

```
/opt/agent-council/workspace/{projectId}/
├── .git-repo/     ← Git bare 리포지토리 (실제 .git 데이터)
├── main/          ← main 브랜치 worktree. 읽기 전용 참조용.
├── set-a/         ← git worktree: set-a/architecture 브랜치
├── set-b/         ← git worktree: set-b/backend 브랜치
├── set-c/         ← git worktree: set-c/frontend 브랜치
└── set-d/         ← git worktree: set-d/qa 브랜치
```

### 5.2 브랜치 명명 규칙

```
set-{setId}/{role-slug}

예시:
  set-a/architecture
  set-b/backend
  set-c/frontend
  set-d/qa
  set-e/devops
  set-f/custom-security   ← 커스텀 Set의 경우 슬러그를 직접 지정
```

- `setId`는 생성 순서에 따라 알파벳(a, b, c...)을 부여한다.
- 동일 프로젝트 내 브랜치 이름은 중복될 수 없다.
- 브랜치 이름에는 소문자, 숫자, 하이픈만 허용한다.

### 5.3 Worktree 생성 절차

Set 생성 시 Council Server가 다음 절차를 자동으로 수행한다.

```
1. bare 리포지토리가 없으면 git clone --bare 또는 git init --bare 실행
   → /opt/agent-council/workspace/{projectId}/.git-repo/

2. main worktree가 없으면 생성
   git -C /opt/agent-council/workspace/{projectId}/.git-repo worktree add \
     /opt/agent-council/workspace/{projectId}/main main

3. Set 브랜치 + worktree 생성
   git -C /opt/agent-council/workspace/{projectId}/.git-repo worktree add \
     -b set-{id}/{role} \
     /opt/agent-council/workspace/{projectId}/set-{id} \
     main

4. Firestore sets/{setId} 문서 업데이트
   {
     branch: "set-{id}/{role}",
     worktreePath: "/opt/agent-council/workspace/{projectId}/set-{id}",
     status: "idle"
   }

5. Claude Code 세션 시작 (tmux 세션명: council-{projectId}-{setId})
   - worktreePath를 작업 디렉토리로 지정
   - 시스템 프롬프트(블록 1~3) 주입
```

### 5.4 Worktree 삭제 절차

Set 삭제 또는 프로젝트 완료 시 다음 순서로 정리한다.

```
1. 미커밋 변경사항 확인
   → 있으면 Council Room에 경고 후 PM 확인 요청

2. Claude Code 세션 종료 (tmux 세션 kill: council-{projectId}-{setId})

3. git worktree remove 실행
   git -C /opt/agent-council/workspace/{projectId}/.git-repo worktree remove \
     /opt/agent-council/workspace/{projectId}/set-{id}

4. 브랜치 삭제 (선택적, PM 확인 후)
   git -C /opt/agent-council/workspace/{projectId}/.git-repo branch -d set-{id}/{role}

5. Firestore sets/{setId} 문서 status: 'deleted' 로 업데이트
   → 로그는 보존 (히스토리 참조를 위해)
```

### 5.5 main 브랜치 동기화

PR이 main에 머지되면 Council Server가 자동으로 다른 Set의 worktree를 동기화한다.

```
PR #3 머지됨 (set-b/backend → main)
  ↓
Council Server가 다른 Set 목록 조회
  ↓
각 Set 워크트리에서 git rebase origin/main 시도
  ├── 성공: "[시스템] Set C: main rebase 완료"
  └── 충돌: "[시스템] Set C: 충돌 발생 (src/App.tsx)"
       └── Set C 리더에게 알림 → error 상태로 전환
```

---

## 6. Set 내부 동작

### 6.1 리더-팀원 통신 구조

리더와 팀원은 **Agent Teams** 프로토콜을 통해 통신한다. Phase 1(CLI 기반)에서는 리더가 순차적으로 팀원 Claude Code 세션을 호출하는 방식으로 구현하고, Phase 2에서 MCP Channel 기반의 병렬 팀워크로 전환한다.

```
리더 (Claude Code 세션)
  │
  ├── 태스크 분해: "API 구현을 3개 서브태스크로 분리"
  │
  ├── 팀원 1에게 지시
  │   └── "ChatController.java 구현. 엔드포인트: POST /api/messages"
  │       └── 팀원 1 → worktree에서 파일 작성 → 완료 보고
  │
  ├── 팀원 2에게 지시 (병렬 또는 순차)
  │   └── "ChatService.java 구현. Repository 주입, 비즈니스 로직 담당"
  │       └── 팀원 2 → worktree에서 파일 작성 → 완료 보고
  │
  └── 리더가 결과 통합 → git commit → Council Room 보고
```

### 6.2 팀원 수 설정

Set 생성 또는 설정에서 팀원 수(teammates)를 지정할 수 있다.

| 팀원 수 | 권장 사용 상황 |
|---|---|
| 1명 | 단순 태스크, 순차 작업이 명확한 경우 |
| 2~3명 | 일반적인 기능 구현. 리더 + 팀원 2명이 기본값 |
| 4~5명 | 복잡한 기능, 병렬 작업이 많은 경우 |
| 6명 이상 | 리소스 소비 주의. 대규모 리팩토링 등 특수 상황에만 사용 |

기본값: **팀원 2명** (리더 포함 총 3명)

팀원은 Claude Code 세션이며, 각 팀원은 동일한 worktree를 공유한다. 동시에 같은 파일을 편집하는 충돌을 방지하기 위해 리더가 작업을 파일/모듈 단위로 분리하여 지시한다.

### 6.3 팀원 간 통신

팀원은 리더를 통해서만 다른 팀원과 소통한다. 팀원이 리더에게 보고하면, 리더가 필요에 따라 다른 팀원에게 전달한다.

```
팀원 1: "ChatController 완료. ChatService의 saveMessage() 메서드가
         필요한데 아직 없습니다."
  ↓ 리더가 중개
팀원 2: "ChatService.java에 saveMessage() 추가합니다."
  ↓
팀원 2: "saveMessage() 구현 완료."
  ↓ 리더가 통합
리더: "ChatController + ChatService 통합 완료. 커밋합니다."
```

### 6.4 Set 내부 작업 흐름

```
[전체 흐름]

리더가 태스크 수신 (Council Room 또는 태스크 보드)
  │
  ├─ 태스크 분석
  │   ├── 외부 의존성 확인 (다른 Set의 결과물 필요?)
  │   │   └── 있으면 → waiting 상태 + Council Room에 의존성 공지
  │   └── 내부 분해 (서브태스크로 쪼개기)
  │
  ├─ 팀원 배정 및 작업 시작 → working 상태
  │   ├── 팀원 1: 서브태스크 A
  │   └── 팀원 2: 서브태스크 B (병렬 가능한 경우)
  │
  ├─ 작업 모니터링
  │   ├── 팀원 완료 보고 수신
  │   ├── 코드 리뷰 (리더가 간단히 검토)
  │   └── 이슈 발생 시:
  │       ├── 내부 해결 가능 → 팀원에게 재지시
  │       └── 외부 협의 필요 → Council Room 에스컬레이션
  │
  ├─ 결과 통합
  │   ├── git add + git commit (의미 있는 커밋 단위로)
  │   └── 로그 업데이트 (Firestore logs 서브컬렉션)
  │
  └─ 보고
      ├── Council Room에 완료 메시지 전송
      ├── 태스크 상태를 'in_progress' → 'review' 또는 'done' 으로 업데이트
      └── 필요 시 PR 생성 요청
```

---

## 7. Set 내부 로그 수집 및 표시

### 7.1 로그 수집

팀원의 모든 작업 출력이 Firestore `sets/{setId}/logs` 서브컬렉션에 저장된다.

```typescript
interface SetLog {
  id: string
  setId: string
  content: string
  type: 'info' | 'code' | 'error' | 'progress' | 'commit'
  teammateId?: string     // 어느 팀원이 생성했는지
  relatedFile?: string    // 관련 파일 경로
  timestamp: Timestamp
}
```

**로그 유형별 예시:**

```
[info]     "ChatController.java 파일 생성 시작"
[code]     "public class ChatController { ... }" (코드 스니펫)
[progress] "엔드포인트 구현 중... 3/5 완료"
[error]    "컴파일 오류: Cannot resolve symbol 'ChatService'"
[commit]   "feat: 채팅 API 엔드포인트 구현 (abc1234)"
```

### 7.2 Council Room 표시

Set 내부 로그는 Council Room에 **접기/펼치기** 형태로 표시된다. 기본 상태는 접힘이며, PM이 클릭하여 확인할 수 있다.

```
┌─ 🟢 백엔드팀 내부 작업        ▼ 펼치기  ─┐
│  마지막 업데이트: 2분 전                   │
│  B-1: ChatController 구현       ✅ 완료   │
│  B-2: ChatService 구현          🔄 진행중 │
│  B-3: 통합 테스트               ⏳ 대기   │
└───────────────────────────────────────────┘

[펼친 상태]
┌─ 🟢 백엔드팀 내부 작업        ▲ 접기   ─┐
│  B-1: ChatController 구현       ✅ 완료   │
│    └─ ChatController.java 생성           │
│    └─ 엔드포인트 3개 구현 완료            │
│    └─ 커밋: feat: add chat endpoints     │
│                                          │
│  B-2: ChatService 구현          🔄 진행중│
│    └─ ChatService.java 작성 중           │
│    └─ saveMessage() 구현 완료            │
│    └─ getHistory() 구현 중...            │
│                                          │
│  B-3: 통합 테스트               ⏳ 대기  │
│    └─ B-2 완료 후 시작 예정              │
└───────────────────────────────────────────┘
```

### 7.3 로그 요약 자동화

리더가 Council Room에 작업 완료를 보고할 때, 내부 로그를 기반으로 자동 요약문을 생성한다.

```
[리더 보고 예시]
백엔드팀 리더: "채팅 API 구현 완료했습니다.
  - 엔드포인트 3개: POST /api/messages, GET /api/messages, DELETE /api/messages/{id}
  - WebSocket STOMP 핸들러 구현 완료
  - 커밋 3개 푸시 완료

  프론트팀에서 연동 시작할 수 있습니다. API 문서는 /docs/api/chat.md 참조."
```

---

## 8. Set 상태 전이 규칙

### 8.1 자동 전이

Council Server가 이벤트를 감지하여 자동으로 상태를 전환한다.

| 이벤트 | 현재 상태 | 전환 상태 | 처리 |
|---|---|---|---|
| Set 생성 완료 (worktree 준비) | `created` | `idle` | — |
| 리더가 태스크 수신 및 작업 시작 | `idle` | `working` | Firestore 업데이트, Council Room 알림 |
| 팀원이 모든 서브태스크 완료 | `working` | `idle` | 리더가 Council Room에 보고 |
| 외부 의존성 감지 | `working` | `waiting` | 대기 사유 Council Room 공지 |
| 의존성 해소 (관련 PR 머지 등) | `waiting` | `working` | 리더가 자동으로 작업 재개 |
| Git 충돌 감지 | `working` | `error` | 리더가 에러 내용 Council Room 보고 |
| PM 세션 종료 후 2시간 | `working` | `idle` (진행 중 작업만 마무리 후) | 스냅샷 저장 |
| 모든 할당 태스크 완료 | `working` | `done` | 리더가 Council Room에 완료 보고 |

### 8.2 수동 전이

PM 또는 리더가 명시적으로 상태를 변경할 수 있다.

| 조작 | 가능한 전환 | 비고 |
|---|---|---|
| PM이 "Set 일시정지" | `working` → `idle` | 현재 팀원 작업은 현재 단계 완료 후 중단 |
| PM이 "Set 재개" | `idle` → `working` | 이전 태스크 컨텍스트 복원 후 재개 |
| PM이 "Set 오류 해제" | `error` → `idle` | 오류 원인 해결 후 PM이 수동 해제 |
| 리더가 "대기 상태 진입" | `working` → `waiting` | 리더가 Council Room에서 사유 명시 |
| PM이 "완료 취소" | `done` → `idle` | 추가 작업이 생긴 경우 |

### 8.3 상태 전이 제약

- `deleted` 상태는 되돌릴 수 없다.
- `done` → `working` 직접 전환은 허용하지 않는다. 반드시 `idle`을 거친다.
- `error` 상태에서 자동 복구는 없다. PM의 수동 개입이 필요하다.

---

## 9. 에스컬레이션 패턴

### 9.1 에스컬레이션 트리거

리더가 다음 상황을 감지하면 즉시 Council Room에 에스컬레이션한다.

```
트리거 1: 다른 팀과의 인터페이스 불일치
  예) "Set B의 API 응답 구조가 아키텍처 스펙과 다릅니다.
       /api/messages 응답에 cursor 필드가 없습니다."

트리거 2: 예상 시간 초과
  예) "WebSocket 인증 구현이 예상보다 복잡합니다.
       원래 2시간 예상이었으나 현재 4시간 이상 필요할 것으로 보입니다.
       소셜 로그인 없이 JWT 토큰만으로 먼저 구현할까요?"

트리거 3: 설계 결정 필요
  예) "채팅 메시지 삭제 정책 결정이 필요합니다.
       Hard delete vs Soft delete. 어떤 방식으로 할까요?"

트리거 4: Git 충돌 (자동 해결 불가)
  예) "main rebase 중 src/config/AppConfig.java에서 충돌이 발생했습니다.
       아키텍처팀과 함께 검토가 필요합니다."

트리거 5: 외부 의존성 대기
  예) "프론트팀 API 연동을 위해 Set B의 /api/messages 엔드포인트가
       필요합니다. 완료 예정 시간이 언제인가요?"
```

### 9.2 에스컬레이션 메시지 형식

```
[에스컬레이션 형식]

🚨 에스컬레이션 (트리거: {트리거 유형})
담당: {Set 이름}
상황: {1~2줄로 현재 상황 설명}
필요한 것: {결정/정보/도움 요청}
영향: {이 문제가 해결되지 않으면 어떤 작업이 블로킹되는지}
```

예시:

```
🚨 에스컬레이션 (트리거: 설계 결정 필요)
담당: 백엔드팀
상황: 채팅 메시지 삭제 API 구현 중 정책 결정이 필요합니다.
      Hard delete는 구현이 단순하지만 복구 불가. Soft delete는 복잡하지만 복원 가능.
필요한 것: 삭제 방식 결정 (Hard 또는 Soft)
영향: 결정 전까지 DELETE /api/messages/{id} 구현 블로킹
```

### 9.3 에스컬레이션 해소 흐름

```
리더가 에스컬레이션 메시지 전송
  │
  ▼
Council Room에서 관련 리더들 + PM 논의
  │
  ├── PM 또는 리더들이 결정 내림
  │   예) "Soft delete로 합니다. deleted_at 컬럼 추가."
  │
  └── 결정이 아키텍처 변경을 수반하면 아키텍처팀 리더가 스펙 문서 업데이트
       → 해당 Set이 작업 재개
```

### 9.4 에스컬레이션 vs 내부 처리 판단 기준

```
내부 처리:
  - 해결에 다른 팀의 코드나 결정이 필요하지 않다
  - 구현 세부사항 (어느 파일에 어떻게 작성할지)
  - 팀원 간 작업 조율

에스컬레이션:
  - 다른 팀의 API 스펙이나 인터페이스에 영향을 미친다
  - 아키텍처 결정(패턴, 라이브러리 선택, 데이터 구조)이 필요하다
  - PM의 우선순위 결정이 필요하다
  - 예상 일정이 크게 변경된다
  - Git 충돌로 merge 방향 결정이 필요하다
```

---

## 10. 리소스 관리

### 10.1 Set당 리소스 기준

Oracle Cloud Ampere(24GB RAM / 4 OCPU)를 기반으로 한다.

| 항목 | 권장 한도 | 비고 |
|---|---|---|
| 동시 활성 Set 수 | 최대 6개 | `working` 상태 기준 |
| Set당 Claude Code 세션 수 | 리더 1 + 팀원 최대 5 | 총 6 세션/Set |
| Set당 권장 팀원 수 | 2~3명 | 기본값 2명 |
| Set당 메모리 예상 사용량 | ~1.5~2GB | 팀원 수에 따라 변동 |
| 전체 동시 세션 상한 | 24개 | 24GB / 1GB per session |
| worktree당 디스크 | ~500MB~2GB | 프로젝트 크기에 따라 다름 |

### 10.2 세션 관리 정책

```
[PM 활성 상태]
모든 Set 세션 유지, 정상 동작

[PM 부재 0~30분]
모든 Set 세션 유지
진행 중인 작업 계속 수행
의사결정 필요한 신규 작업은 큐에 보관

[PM 부재 30분~2시간]
세션 유지
신규 작업 시작하지 않음
현재 working 중인 태스크만 마무리

[PM 부재 2시간 초과]
현재 스냅샷 저장 (Firestore snapshots 컬렉션)
idle 상태의 Set 세션 종료 (리소스 해제)
working 상태는 현재 서브태스크 완료 후 세션 종료
재개 시 전략 B(컨텍스트 주입)로 복원
```

### 10.3 메모리 임계치 초과 시 동작

```
총 메모리 사용량이 20GB 초과 시:
  1. idle 상태의 Set 세션 먼저 종료
  2. done 상태의 Set 세션 종료
  3. waiting 상태의 Set 세션 일시 중단 (스냅샷 저장)
  → 조치 후에도 부족하면 Council Room에 경고 표시
```

### 10.4 Claude 세션 수 상한

```
프로젝트 단위 상한: 리더 6명 + 팀원 18명 = 총 24 Claude Code 세션
Set 단위 상한: 리더 1명 + 팀원 5명 = 총 6 Claude Code 세션
단일 Set 권장: 리더 1명 + 팀원 2명 = 총 3 Claude Code 세션
```

PM이 Set 생성 시 팀원 수를 지정하며, 시스템은 현재 총 세션 수가 상한을 넘지 않는지 확인하고 초과 시 경고를 표시한다.

### 10.5 토큰 사용량 추적

각 세션의 토큰 사용량은 Firestore `usage/{userId}/monthly/{YYYY-MM}` 에 기록된다.

```typescript
{
  totalTokens: number,
  totalSessions: number,
  byProject: { [projectId]: number },
  bySets: { [setId]: number }    // Set별 토큰 사용량 세분화
}
```

Council Room 하단 바에 현재 세션의 누적 토큰 사용량이 표시된다.

---

## 부록: Firestore 데이터 구조 (Set 관련)

```
projects/{projectId}/sets/{setId}
  ├── name: string                  // "백엔드팀"
  ├── preset: string                // "backend" | "frontend" | ... | "custom"
  ├── role: string                  // 역할 설명 (커스텀 시 PM 입력)
  ├── status: string                // "idle" | "working" | "waiting" | "done" | "error"
  ├── teammates: number             // 팀원 수 (리더 제외)
  ├── color: string                 // "#22C55E"
  ├── branch: string                // "set-b/backend"
  ├── worktreePath: string          // "/workspace/{projectId}/set-b"
  ├── systemPrompt: string          // 현재 적용 중인 시스템 프롬프트
  ├── sessionStatus: string         // "active" | "suspended" | "terminated"
  ├── lastActiveAt: Timestamp
  ├── createdAt: Timestamp
  └── updatedAt: Timestamp

projects/{projectId}/sets/{setId}/logs/{logId}
  ├── content: string
  ├── type: string                  // "info" | "code" | "error" | "progress" | "commit"
  ├── teammateId: string?
  ├── relatedFile: string?
  └── timestamp: Timestamp
```

---

*관련 문서*
- [PLAN.md](../PLAN.md) - 전체 시스템 설계 계획
- [01_아키텍처/](../01_아키텍처/) - 시스템 아키텍처
- [02_데이터설계/](../02_데이터설계/) - Firestore 전체 데이터 모델
- [05_기능명세/02_Council_Room.md](02_Council_Room.md) - Council Room 기능 명세
- [05_기능명세/01_프로젝트_관리.md](01_프로젝트_관리.md) - 프로젝트 기능 명세
- [../00_설정_참조표.md](../00_설정_참조표.md) — 워크스페이스 경로, tmux 명명 규칙, 전역 설정값 단일 출처
