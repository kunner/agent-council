# Agent Council — 회고 및 향후 계획

> 작성일: 2026-03-24
> 프로젝트 기간: 2026-03-23 ~ 2026-03-24 (2일)

---

## 1. 원래 목표

"여러 AI 에이전트 팀의 리더들이 하나의 대화방에서 회의하며, 실제 코드를 개발하는 멀티팀 오케스트레이션 시스템"

### 핵심 비전
- 메신저 채팅방처럼 PM과 여러 AI 팀이 실시간으로 대화
- 각 팀은 실제 코드를 읽고 수정할 수 있는 Claude Code 세션
- 팀장이 자동으로 팀원을 불러오고, 작업을 분배하는 자연스러운 회의체
- Claude Code Channels를 활용한 세션 간 통신
- Max 플랜으로 추가 비용 없이 운영

### 영감
- Claude Code의 Channels 기능 (2026-03-20 발표)
- Agent Teams (실험 기능)
- Claude IPC MCP, Google A2A 등 에이전트 간 통신 프로토콜

---

## 2. 실제 구현 과정

### Phase 1: 웹 채팅앱 구축 (Day 1)

**설계 문서 작성** (31개 문서, 37,533줄)
- 아키텍처, 데이터설계, API설계, UI/UX, 기능명세, 구현가이드, 운영
- 문서 간 교차 검증 수행 (CRITICAL 19건 발견 및 수정)

**모노레포 구축** (pnpm workspace)
- `packages/shared` — 공유 TypeScript 타입 + 상수
- `packages/server` — Express + Socket.IO + Firebase Admin
- `packages/web` — React + Vite + Tailwind + Firebase Auth

**기본 기능 구현**
- Firebase Auth (Google 로그인) + Firestore (실시간 메시지)
- 프로젝트 CRUD, 설정 페이지
- Council Room 채팅 UI (3패널: 팀 목록 / 채팅 / 컨텍스트)
- Git 저장소 연동 (clone/init, worktree, 브랜치 관리)
- 모바일 반응형 (햄버거 메뉴, 바텀 탭)
- 메시지 페이지네이션, HTML 백업 다운로드

### Phase 2: AI 대화 시스템 반복 개선 (Day 1~2)

**1차: Anthropic Messages API 직접 호출**
- 가장 단순한 방식. 텍스트만 주고받음
- 문제: 코드 접근 불가, 세션 없음, 매번 새로 시작

**2차: Claude Code CLI subprocess (`claude -p`)**
- `--append-system-prompt`, `--permission-mode bypassPermissions`
- 문제: 프로세스 spawn 오버헤드 (호출당 2-3초), CLI 옵션 호환성 이슈

**3차: Anthropic SDK 직접 호출**
- `@anthropic-ai/sdk` — HTTP API 직접 호출
- 속도 개선 (오버헤드 거의 없음)
- 문제: 여전히 코드 접근 불가, API 키 종량 과금

**4차: Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)**
- Claude Code를 subprocess로 spawn, 세션 유지/재개
- 실제 코드 읽기/쓰기 가능 (worktree 접근)
- 문제: 여전히 API 호출 기반, Max 플랜과 속도 트레이드오프

### Phase 3: 대화 오케스트레이션 패턴 시행착오

| 패턴 | 시도 | 결과 |
|------|------|------|
| 전체 병렬 | PM 메시지 → 4팀 동시 응답 | 같은 말 4번 반복 |
| 팀장 위임 | 팀장 → 작업 분배 → 팀원 실행 → 팀장 검토 | 명령 체계, 대화가 아님 |
| 자발적 참여 | 모든 팀이 보고 PASS/응답 결정 | 병렬이라 서로 못 보고 중복 |
| AI 라우터 | Claude가 누가 답할지 판단 | 추가 API 호출, 오탐 |
| 순차 대화 | 팀장 먼저 → 나머지 순서대로 | 가장 나았지만 여전히 부자연스러움 |
| 동적 팀 구성 | 팀장이 RECRUIT/DISMISS로 팀원 관리 | 팀장이 혼자 다 함, 팀원을 안 부름 |

### 핵심 깨달음

**"API/SDK를 통한 AI 세션 관리는 근본적으로 잘못된 접근이다"**

```
잘못된 구조 (구현한 것):
  웹 UI → Express 서버 → API/SDK → Claude → 응답 → Firestore → 웹 UI
  (미들맨이 너무 많음, 각 단계에서 오버헤드)

올바른 구조 (해야 했던 것):
  개발자 → tmux에서 Claude Code 직접 실행 (Max 플랜, 네이티브 속도)
  결과 → context-hub에 자동 동기화 (Knowledge Base로 축적)
  웹 UI → 프로젝트 관리 / 지식 검색 / 활동 피드 (뷰어 역할만)
```

---

## 3. 무엇이 잘못됐나

### 아키텍처 오류
1. **Claude Code를 API로 감싸려 한 것** — CLI/SDK 모두 미들맨. 네이티브 실행이 맞음
2. **웹 UI가 AI 세션을 직접 관리** — 웹은 뷰어여야 함, 세션 관리는 tmux의 일
3. **Phase 1/2 분리** — "빠른 프로토타입"으로 API 호출을 선택한 것이 방향을 틀어놓음
4. **Channels를 안 쓴 것** — 처음부터 Channels 기반이었어야 함

### 비용 문제
- Opus API 호출: 메시지당 $0.3~$1 (도구 호출 포함)
- Max 플랜($200/월)을 쓰면서 API 키 과금을 별도로 낸 기간이 있었음
- SDK가 Max 플랜 OAuth를 쓸 수 있다는 걸 늦게 파악

### 대화 품질 문제
- 모든 팀이 같은 말 반복 (병렬 응답)
- 팀장이 혼자 다 해결 (RECRUIT 안 함)
- 보고서 형식 답변 (대화체가 아님)
- 자기 역할 소개 반복
- 존댓말/반말 혼용

---

## 4. 무엇을 배웠나

### 기술적 교훈
- Claude Code SDK는 CLI subprocess를 spawn하는 래퍼 — 순수 라이브러리가 아님
- Max 플랜 OAuth 인증은 SDK에서도 사용 가능 (ANTHROPIC_API_KEY 제거)
- 세션 재개(resume) 시 시스템 프롬프트에 히스토리를 중복 주입하면 안 됨
- maxTurns 제한은 비용 제어용이지 Max 플랜에서는 불필요

### 제품 교훈
- AI 에이전트 "팀 회의"는 실제 회의와 다름 — 순차적이어야 대화가 됨
- "회의체"보다 "1:1 대화 + 필요할 때 전문가 소환"이 자연스러움
- 프롬프트로 행동을 제어하는 데는 한계가 있음 (특히 haiku)
- 모델 등급이 대화 품질에 결정적 영향 (haiku vs sonnet vs opus)

### 프로젝트 관리 교훈
- 37,000줄 설계 문서를 먼저 쓰고 시작했지만, 실제 구현에서 거의 다 바뀜
- "빠른 프로토타입"이 방향을 잡을 수도, 틀어놓을 수도 있음
- 사용자 피드백 루프가 빨랐던 것은 좋았음 (실시간 테스트 → 즉시 수정)

---

## 5. 성과물

### 유지할 것
- **Firebase 인프라**: Auth, Firestore — 사용자 관리, 데이터 저장에 유효
- **Git 서비스**: repo clone/init, worktree 관리, status API
- **웹 UI 프레임**: React + Vite + Tailwind 기반 — 프로젝트 관리 뷰어로 재활용 가능
- **설계 문서**: 아키텍처 패턴, 데이터 모델, UI 설계 등 참고 자료로 가치 있음
- **HTML 백업/내보내기 기능**: 대화 아카이브에 유용

### 버릴 것
- **API/SDK 기반 AI 어댑터**: claude-cli.adapter, claude-sdk.adapter 전부
- **오케스트레이터**: 순차/병렬/라우터 등 모든 패턴
- **세션 매니저**: 서버에서 AI 세션을 관리하는 구조 자체
- **팀 매니저**: RECRUIT/DISMISS 파싱 기반 동적 팀 관리
- **리더 프롬프트 시스템**: 프롬프트로 행동을 제어하려는 접근

### 코드 통계
- 총 커밋: 17개
- 구현 코드: ~10,000줄 (TypeScript)
- 설계 문서: ~37,000줄 (Markdown)
- npm 패키지: 468개 설치

---

## 6. 향후 계획: context-hub 통합

### 핵심 결정
**agent-council은 독립 프로젝트가 아니라 context-hub의 기능으로 통합한다.**

context-hub (`/Users/kunner/IdeaProjects/context-hub`)는 이미 다음을 보유:
- 프로젝트 관리 (GitHub 연동, 코드 분석)
- Knowledge Base (결정사항, 버그픽스, 패턴, 인사이트)
- 시맨틱 검색 (파일명 → 키워드 → 벡터 에스컬레이션)
- LLM 통합 (Anthropic, OpenRouter, Claude CLI)
- 세션/개발자 추적
- Go + PostgreSQL + Voyage 벡터 검색

### 추가할 것: `council` 기능

```
context-hub에 추가:
├── council 런처 (Go CLI → tmux 세션 생성 + Claude Code 실행)
├── 세션 결과 자동 아카이브 (KnowledgeUnit으로 축적)
├── 태스크 시작 시 유사 경험 시맨틱 검색 → 컨텍스트 주입
├── 활동 피드 (웹 UI에서 누가 뭘 하고 있는지)
└── 대화 뷰어 (웹 UI에서 세션 로그 열람)
```

### 아키텍처

```
개발자 (로컬 PC):
  council start gjcu
  → tmux 세션 자동 생성
  → Claude Code 실행 (Max 플랜, 네이티브 속도)
  → 작업 중 결과가 context-hub에 자동 동기화
  → 종료 시 대화 아카이브

context-hub 서버:
  ├── Knowledge Base (모든 세션의 경험 축적)
  ├── 프로젝트 관리 (태스크 보드)
  ├── 시맨틱 검색 (유사 작업 경험 검색)
  └── 웹 UI (대시보드, 지식 검색, 활동 피드)

5명 개발 팀:
  - 각자 자기 Max 플랜 사용
  - 각자 로컬에서 Claude Code 실행
  - 결과가 중앙 Knowledge Base에 축적
  - 다른 사람의 경험을 검색하여 활용
```

### 비용 구조

```
변경 전 (agent-council):
  서버에서 AI 호출 → API 키 과금 또는 Max 플랜 rate limit

변경 후 (context-hub + council):
  각 개발자가 자기 Max 플랜 사용 → 추가 비용 $0
  context-hub 서버 → Oracle Free Tier (AI 호출 없음, DB + 웹만)
```

### 로드맵

1. **context-hub에 council CLI 추가** — tmux 런처 기본 기능
2. **Claude Code 훅 연동** — 세션 종료 시 결과를 Knowledge Base에 자동 저장
3. **태스크 ↔ 세션 연결** — 태스크 시작 시 유사 경험 주입
4. **웹 UI 활동 피드** — 팀원 작업 현황 실시간 표시
5. **(향후) 원격 모드** — 서버에서 tmux 세션 실행, 웹/SSH로 접속

---

## 7. 결론

agent-council 프로젝트는 2일간의 집중 개발을 통해 **"AI 에이전트 팀 협업"의 올바른 아키텍처가 무엇인지**를 발견하는 과정이었다.

핵심 교훈: **AI 세션을 API로 감싸서 관리하려 하지 말고, 네이티브로 실행하고 결과만 수집하라.**

이 프로젝트에서 얻은 경험과 코드는 context-hub에 통합되어, 실제로 팀이 사용할 수 있는 개발 도구로 발전할 예정이다.
