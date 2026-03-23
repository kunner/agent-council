---
status: DRAFT
priority: 1
last_updated: 2026-03-23
---

# Firestore 스키마 설계

## 목차

1. [컬렉션/서브컬렉션 구조 개요](#1-컬렉션서브컬렉션-구조-개요)
2. [컬렉션 상세 명세](#2-컬렉션-상세-명세)
   - [users](#21-users)
   - [projects](#22-projects)
   - [rooms (서브컬렉션)](#23-rooms-서브컬렉션)
   - [messages (서브컬렉션)](#24-messages-서브컬렉션)
   - [sets (서브컬렉션)](#25-sets-서브컬렉션)
   - [logs (서브컬렉션)](#26-logs-서브컬렉션)
   - [tasks (서브컬렉션)](#27-tasks-서브컬렉션)
   - [pullRequests (서브컬렉션)](#28-pullrequests-서브컬렉션)
   - [snapshots (서브컬렉션)](#29-snapshots-서브컬렉션)
   - [usage](#210-usage)
3. [TypeScript 인터페이스 정의](#3-typescript-인터페이스-정의)
4. [Firestore 인덱스 설계](#4-firestore-인덱스-설계)
5. [주요 쿼리 패턴](#5-주요-쿼리-패턴)
6. [데이터 관계도](#6-데이터-관계도)
7. [Firestore 제약사항 고려](#7-firestore-제약사항-고려)
8. [마이그레이션 전략](#8-마이그레이션-전략)
9. [Spark 플랜 무료 한도 최적화](#9-spark-플랜-무료-한도-최적화)

---

## 1. 컬렉션/서브컬렉션 구조 개요

```
firestore/
├── users/{userId}                          # 사용자 프로필 + API 키
│
├── projects/{projectId}                    # 프로젝트 최상위 단위
│   ├── git/config                          # Git 연동 설정 (단일 문서)
│   ├── rooms/{roomId}                      # Council Room (대화방)
│   │   └── messages/{messageId}            # 채팅 메시지
│   ├── sets/{setId}                        # Agent Set (팀)
│   │   └── logs/{logId}                    # Set 내부 작업 로그
│   ├── tasks/{taskId}                      # 태스크 보드 항목
│   ├── pullRequests/{prId}                 # PR 추적
│   └── snapshots/{snapshotId}             # 프로젝트 상태 스냅샷
│
└── usage/{userId}                          # 토큰 사용량 추적
    └── monthly/{YYYY-MM}                   # 월별 집계
```

**설계 원칙:**
- `projects` 하위에 모든 작업 데이터를 집중하여 **소유자 기반 접근 제어**를 단순화
- 실시간 업데이트가 필요한 `messages`, `logs`는 서브컬렉션으로 분리하여 문서 크기 1MB 제한 회피
- `usage`는 최상위 컬렉션으로 분리하여 사용량 쿼리를 프로젝트 쿼리와 독립적으로 처리

---

## 2. 컬렉션 상세 명세

### 2.1 users

**경로**: `users/{userId}`

사용자 인증 정보와 설정을 저장한다. `userId`는 Firebase Auth의 UID와 동일하다.

| 필드 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `displayName` | `string` | 필수 | — | Firebase Auth에서 가져온 표시 이름 |
| `email` | `string` | 필수 | — | 사용자 이메일 |
| `photoURL` | `string` | 선택 | `null` | 프로필 이미지 URL |
| `apiKeyEncrypted` | `string` | 선택 | `null` | AES-256으로 암호화된 Anthropic API 키 |
| `authMethod` | `'api_key' \| 'max_plan'` | 필수 | `'api_key'` | Claude 인증 방식 |
| `settings` | `UserSettings` | 선택 | `{}` | UI 설정 (테마, 언어 등) |
| `createdAt` | `Timestamp` | 필수 | 서버 시간 | 계정 생성 시각 |
| `updatedAt` | `Timestamp` | 필수 | 서버 시간 | 마지막 업데이트 시각 |

**UserSettings 중첩 객체:**

| 필드 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `theme` | `'dark' \| 'light' \| 'system'` | `'dark'` | UI 테마 |
| `language` | `string` | `'ko'` | 인터페이스 언어 |
| `notificationsEnabled` | `boolean` | `true` | 브라우저 알림 활성화 |

---

### 2.2 projects

**경로**: `projects/{projectId}`

프로젝트의 메타데이터를 저장하는 최상위 단위다. 하나의 Git 리포지토리에 대응한다.

| 필드 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `name` | `string` | 필수 | — | 프로젝트 이름 (예: "사내 메신저") |
| `description` | `string` | 선택 | `''` | 프로젝트 설명 |
| `ownerId` | `string` | 필수 | — | 생성자의 Firebase Auth UID |
| `type` | `'new' \| 'existing' \| 'analysis'` | 필수 | — | 프로젝트 유형 |
| `status` | `ProjectStatus` | 필수 | `'planning'` | 프로젝트 진행 상태 |
| `techStack` | `string[]` | 선택 | `[]` | 기술 스택 태그 (예: ["React", "Spring Boot"]) |
| `defaultRoomId` | `string` | 선택 | `null` | 기본 Council Room ID (자동 생성됨) |
| `activeSetIds` | `string[]` | 선택 | `[]` | 현재 활성 Set ID 목록 |
| `createdAt` | `Timestamp` | 필수 | 서버 시간 | 생성 시각 |
| `updatedAt` | `Timestamp` | 필수 | 서버 시간 | 마지막 업데이트 시각 |

**ProjectStatus 값:**
- `'planning'` — 초기 설계 단계
- `'in_progress'` — 개발 진행 중
- `'review'` — 통합 리뷰 단계
- `'paused'` — 일시 중단
- `'completed'` — 완료
- `'archived'` — 아카이브됨

**git/config 서브문서** (`projects/{projectId}/git/config`):

단일 문서로, Git 연동 설정을 보관한다.

| 필드 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `repoUrl` | `string` | 선택 | `null` | GitHub 리포지토리 URL |
| `localPath` | `string` | 필수 | — | 서버 내 절대 경로 (예: `/workspace/proj-abc`) |
| `defaultBranch` | `string` | 필수 | `'main'` | 기본 브랜치명 |
| `isRemote` | `boolean` | 필수 | `false` | GitHub 원격 저장소 연동 여부 |
| `githubTokenEncrypted` | `string` | 선택 | `null` | 암호화된 GitHub Personal Access Token |
| `updatedAt` | `Timestamp` | 필수 | 서버 시간 | 마지막 업데이트 시각 |

---

### 2.3 rooms (서브컬렉션)

**경로**: `projects/{projectId}/rooms/{roomId}`

Council Room은 리더들과 PM이 대화하는 공유 채팅 공간이다. 하나의 프로젝트에 여러 방이 존재할 수 있다(예: 메인 회의실, 설계 논의방).

| 필드 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `name` | `string` | 필수 | — | 방 이름 (예: "메인 회의") |
| `purpose` | `string` | 선택 | `''` | 방의 목적 설명 |
| `status` | `'active' \| 'paused' \| 'completed'` | 필수 | `'active'` | 방 상태 |
| `participantSetIds` | `string[]` | 선택 | `[]` | 참여 중인 Set ID 목록 |
| `messageCount` | `number` | 필수 | `0` | 총 메시지 수 (페이지네이션 참조용) |
| `lastMessageAt` | `Timestamp` | 선택 | `null` | 마지막 메시지 시각 (목록 정렬용) |
| `createdAt` | `Timestamp` | 필수 | 서버 시간 | 생성 시각 |

---

### 2.4 messages (서브컬렉션)

**경로**: `projects/{projectId}/rooms/{roomId}/messages/{messageId}`

Council Room의 채팅 메시지를 저장한다. Firestore 실시간 리스너(`onSnapshot`)로 클라이언트에 즉시 전달된다.

| 필드 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `senderId` | `string` | 필수 | — | 발신자 ID (userId 또는 setId) |
| `senderName` | `string` | 필수 | — | 발신자 표시 이름 |
| `senderType` | `'human' \| 'leader' \| 'system'` | 필수 | — | 발신자 유형 |
| `senderColor` | `string` | 선택 | `null` | 리더의 UI 표시 색상 코드 (예: `#22C55E`) |
| `content` | `string` | 필수 | — | 메시지 본문 (마크다운 허용) |
| `replyTo` | `string` | 선택 | `null` | 답장 대상 메시지 ID |
| `metadata` | `MessageMetadata` | 선택 | `null` | 첨부 메타데이터 |
| `isInternalLog` | `boolean` | 필수 | `false` | Set 내부 로그 요약 메시지 여부 (접기/펼치기) |
| `timestamp` | `Timestamp` | 필수 | 서버 시간 | 메시지 생성 시각 |

**MessageMetadata 중첩 객체:**

| 필드 | 타입 | 설명 |
|---|---|---|
| `artifacts` | `ArtifactRef[]` | 생성/수정/삭제된 파일 참조 목록 |
| `taskRefs` | `string[]` | 관련 태스크 ID 목록 |
| `commitHash` | `string` | 관련 Git 커밋 해시 (단일) |
| `commitHashes` | `string[]` | 관련 Git 커밋 해시 목록 |
| `pullRequestUrl` | `string` | 관련 PR URL |
| `pullRequestId` | `string` | Firestore pullRequests 문서 ID |
| `branch` | `string` | 관련 브랜치명 |
| `tokenUsage` | `TokenUsage` | 이 응답에 사용된 토큰 상세 |
| `actions` | `InlineAction[]` | 인라인 액션 버튼 목록 |
| `systemEvent` | `SystemEventPayload` | 시스템 이벤트 페이로드 |
| `sessionRestored` | `boolean` | 세션 복원 여부 |
| `snapshotId` | `string` | 관련 스냅샷 ID |

**ArtifactRef 중첩 객체:**

| 필드 | 타입 | 설명 |
|---|---|---|
| `path` | `string` | 파일 경로 (worktree 기준 상대 경로) |
| `type` | `'created' \| 'modified' \| 'deleted'` | 변경 유형 |
| `language` | `string` | 코드 하이라이팅용 언어 힌트 (선택) |
| `storageUrl` | `string` | Firebase Storage URL (선택) |

**TokenUsage 중첩 객체:**

| 필드 | 타입 | 설명 |
|---|---|---|
| `inputTokens` | `number` | 입력 토큰 수 |
| `outputTokens` | `number` | 출력 토큰 수 |
| `totalTokens` | `number` | 전체 토큰 수 |
| `cacheReadTokens` | `number` | 프롬프트 캐시 히트 토큰 (선택) |
| `cacheWriteTokens` | `number` | 프롬프트 캐시 쓰기 토큰 (선택) |

**SystemEventType 값:**
- `'git_push'` — 브랜치에 커밋 푸시됨
- `'git_branch'` — 브랜치 생성/삭제
- `'pr_created'` — PR 생성
- `'pr_merged'` — PR 머지
- `'pr_closed'` — PR 닫힘
- `'pr_review_requested'` — PR 리뷰 요청
- `'task_created'` — 태스크 생성
- `'task_updated'` — 태스크 상태 변경
- `'task_blocked'` — 태스크 블로킹됨
- `'set_status_changed'` — Set 상태 변경
- `'session_started'` — 세션 시작
- `'session_ended'` — 세션 종료
- `'session_restored'` — 세션 복원
- `'session_timeout_warning'` — 세션 타임아웃 경고
- `'snapshot_created'` — 스냅샷 생성
- `'rebase_completed'` — Rebase 완료
- `'rebase_conflict'` — Rebase 충돌 발생

> **문서 크기 주의**: `content` 필드에 대용량 코드 블록을 직접 저장하지 않는다. 코드 아티팩트는 Firebase Storage에 업로드하고 URL만 `metadata.artifacts`에 저장한다.

---

### 2.5 sets (서브컬렉션)

**경로**: `projects/{projectId}/sets/{setId}`

Agent Set은 리더 1명 + 팀원 N명으로 구성된 작업 단위다.

| 필드 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `name` | `string` | 필수 | — | 팀 이름 (예: "백엔드팀") |
| `role` | `string` | 필수 | — | 리더 역할 프롬프트 (시스템 프롬프트로 주입됨) |
| `status` | `SetStatus` | 필수 | `'idle'` | 현재 작업 상태 |
| `teammates` | `number` | 필수 | `1` | 팀원 수 (리더 포함) |
| `color` | `string` | 필수 | — | UI 표시 색상 코드 (예: `#22C55E`) |
| `branch` | `string` | 선택 | `null` | 작업 브랜치명 (예: `set-b/backend`) |
| `worktreePath` | `string` | 선택 | `null` | 서버 내 worktree 절대 경로 |
| `currentTaskId` | `string` | 선택 | `null` | 현재 진행 중인 태스크 ID |
| `progress` | `number` | 선택 | `0` | 현재 태스크 진행률 (0~100) |
| `preset` | `string` | 선택 | `null` | 사전 정의된 역할 프리셋 이름 |
| `systemPrompt` | `string` | 선택 | `null` | 커스텀 시스템 프롬프트 (role 필드 재정의 시) |
| `sessionStatus` | `string` | 선택 | `'none'` | 세션 상태 (`'none'` \| `'starting'` \| `'alive'` \| `'dead'`) |
| `sessionAlive` | `boolean` | 필수 | `false` | Claude Code 세션 생존 여부 (서버가 업데이트) |
| `lastActiveAt` | `Timestamp` | 선택 | `null` | 마지막 활동 시각 |
| `createdAt` | `Timestamp` | 필수 | 서버 시간 | 생성 시각 |
| `updatedAt` | `Timestamp` | 필수 | 서버 시간 | 마지막 업데이트 시각 |

**SetStatus 값:**
- `'idle'` — 대기 중
- `'working'` — 작업 진행 중
- `'waiting'` — PM 또는 다른 팀 응답 대기
- `'done'` — 현재 태스크 완료
- `'error'` — 오류 발생

---

### 2.6 logs (서브컬렉션)

**경로**: `projects/{projectId}/sets/{setId}/logs/{logId}`

Set 내부 작업 로그. Council Room에 노출되지 않으며, UI에서 접기/펼치기로 확인한다.

| 필드 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `content` | `string` | 필수 | — | 로그 내용 |
| `type` | `'info' \| 'code' \| 'error' \| 'progress'` | 필수 | `'info'` | 로그 유형 |
| `agentId` | `string` | 선택 | `null` | 로그를 생성한 팀원 에이전트 ID |
| `taskId` | `string` | 선택 | `null` | 관련 태스크 ID |
| `timestamp` | `Timestamp` | 필수 | 서버 시간 | 로그 생성 시각 |

> **보관 정책**: 로그는 태스크 완료 후 30일이 지나면 삭제하거나 Firebase Storage로 아카이브한다. 무제한 축적 시 Spark 플랜 1GB 저장 한도에 영향을 줄 수 있다.

---

### 2.7 tasks (서브컬렉션)

**경로**: `projects/{projectId}/tasks/{taskId}`

칸반 보드의 태스크 항목. Council 대화에서 합의된 내용이 태스크로 변환된다.

| 필드 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `title` | `string` | 필수 | — | 태스크 제목 |
| `description` | `string` | 선택 | `''` | 상세 설명 |
| `status` | `TaskStatus` | 필수 | `'backlog'` | 칸반 상태 |
| `assignedSetId` | `string` | 선택 | `null` | 담당 Set ID |
| `priority` | `'critical' \| 'high' \| 'medium' \| 'low'` | 필수 | `'medium'` | 우선순위 |
| `dependencies` | `string[]` | 선택 | `[]` | 선행 태스크 ID 목록 |
| `branch` | `string` | 선택 | `null` | 관련 Git 브랜치명 |
| `pullRequestId` | `string` | 선택 | `null` | 관련 PR의 Firestore 문서 ID |
| `pullRequestUrl` | `string` | 선택 | `null` | GitHub PR URL |
| `blockedReason` | `string` | 선택 | `null` | 블로킹 사유 (status가 `'blocked'`일 때) |
| `blockedFromStatus` | `TaskStatus` | 선택 | `null` | 블로킹 전 이전 상태 |
| `creationMethod` | `'human' \| 'leader' \| 'system'` | 선택 | `'human'` | 태스크 생성 주체 |
| `parentTaskId` | `string` | 선택 | `null` | 부모 태스크 ID (서브태스크인 경우) |
| `subTaskIds` | `string[]` | 선택 | `[]` | 서브태스크 ID 목록 |
| `createdFromMessageId` | `string` | 선택 | `null` | 이 태스크를 생성한 Council 메시지 ID |
| `roomId` | `string` | 선택 | `null` | 태스크 생성 출처 Room ID |
| `completedAt` | `Timestamp` | 선택 | `null` | 완료 시각 |
| `createdAt` | `Timestamp` | 필수 | 서버 시간 | 생성 시각 |
| `updatedAt` | `Timestamp` | 필수 | 서버 시간 | 마지막 업데이트 시각 |

**TaskStatus 값:**
- `'backlog'` — 미착수
- `'in_progress'` — 진행 중
- `'review'` — 리뷰 대기
- `'done'` — 완료
- `'blocked'` — 의존성 또는 이슈로 블로킹됨

---

### 2.8 pullRequests (서브컬렉션)

**경로**: `projects/{projectId}/pullRequests/{prId}`

GitHub PR을 추적하는 문서. Council Server가 GitHub API를 통해 PR 생성 시 자동으로 생성된다.

| 필드 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `title` | `string` | 필수 | — | PR 제목 |
| `description` | `string` | 선택 | `''` | PR 설명 |
| `githubPrNumber` | `number` | 선택 | `null` | GitHub PR 번호 (`#3` 형태로 표시) |
| `githubPrUrl` | `string` | 선택 | `null` | GitHub PR URL |
| `sourceBranch` | `string` | 필수 | — | 소스 브랜치 (예: `set-b/backend`) |
| `targetBranch` | `string` | 필수 | — | 타겟 브랜치 (예: `main`) |
| `setId` | `string` | 필수 | — | PR을 생성한 Set ID |
| `status` | `PullRequestStatus` | 필수 | `'open'` | PR 상태 |
| `diffStats` | `DiffStats` | 선택 | `null` | 변경 통계 |
| `reviewNotes` | `string[]` | 선택 | `[]` | Council에서의 리뷰 코멘트 목록 |
| `relatedTaskIds` | `string[]` | 선택 | `[]` | 관련 태스크 ID 목록 |
| `reviewStatus` | `ReviewStatus` | 선택 | `'pending'` | 리뷰 프로세스 상태 (git status와 별도) |
| `reviewerSetIds` | `string[]` | 선택 | `[]` | 리뷰 담당 Set ID 목록 |
| `reviewRounds` | `number` | 선택 | `0` | 리뷰 라운드 수 |
| `autoReviewResult` | `string` | 선택 | `null` | 자동 리뷰 결과 요약 |
| `approvedBy` | `string[]` | 선택 | `[]` | 승인한 리더/PM의 ID 목록 |
| `createdAt` | `Timestamp` | 필수 | 서버 시간 | PR 생성 시각 |
| `mergedAt` | `Timestamp` | 선택 | `null` | 머지 완료 시각 |
| `closedAt` | `Timestamp` | 선택 | `null` | PR 닫힌 시각 |

> **두 가지 상태 필드 주의**: `status`는 Git 관점의 PR 상태(`open`/`merged`/`closed` 등)이고, `reviewStatus`는 리뷰 프로세스 상태(`pending`/`in_review`/`approved`/`changes_requested`)다. 두 필드는 독립적으로 관리된다.

**ReviewStatus 값:**
- `'pending'` — 리뷰 미시작
- `'in_review'` — 리뷰 진행 중
- `'approved'` — 리뷰 승인
- `'changes_requested'` — 수정 요청됨

**PullRequestStatus 값:**
- `'open'` — 열림
- `'reviewing'` — 리뷰 진행 중
- `'approved'` — 승인됨
- `'merged'` — 머지 완료
- `'closed'` — 닫힘 (머지 없이)

**DiffStats 중첩 객체:**

| 필드 | 타입 | 설명 |
|---|---|---|
| `additions` | `number` | 추가된 줄 수 |
| `deletions` | `number` | 삭제된 줄 수 |
| `filesChanged` | `number` | 변경된 파일 수 |

---

### 2.9 snapshots (서브컬렉션)

**경로**: `projects/{projectId}/snapshots/{snapshotId}`

세션 복원을 위한 프로젝트 상태 스냅샷. Council Server가 주기적으로 또는 주요 이벤트 시점에 자동 생성한다.

| 필드 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `trigger` | `SnapshotTrigger` | 필수 | — | 스냅샷 생성 이유 |
| `summary` | `string` | 필수 | — | 프로젝트 현황 요약 (LLM 컨텍스트 주입용) |
| `completedTasks` | `string[]` | 선택 | `[]` | 완료된 태스크 제목 목록 |
| `inProgressTasks` | `SnapshotTask[]` | 선택 | `[]` | 진행 중인 태스크 요약 |
| `decisions` | `string[]` | 선택 | `[]` | Council에서 내려진 주요 결정사항 |
| `gitState` | `SnapshotGitState` | 선택 | `null` | Git 상태 요약 |
| `recentMessageIds` | `string[]` | 선택 | `[]` | 최근 30개 메시지 ID (컨텍스트 복원 시 참조) |
| `tokenUsageAtSnapshot` | `number` | 선택 | `0` | 스냅샷 시점의 누적 토큰 사용량 |
| `createdAt` | `Timestamp` | 필수 | 서버 시간 | 스냅샷 생성 시각 |

**SnapshotTrigger 값:**
- `'pr_merged'` — PR 머지 후
- `'task_done'` — 태스크 완료 후
- `'manual'` — PM 수동 요청
- `'scheduled'` — 30분 주기 자동
- `'session_end'` — 세션 종료 시
- `'pm_away'` — PM 2시간 부재 시

**SnapshotTask 중첩 객체:**

| 필드 | 타입 | 설명 |
|---|---|---|
| `taskId` | `string` | 태스크 ID |
| `title` | `string` | 태스크 제목 |
| `setName` | `string` | 담당 Set 이름 |
| `progress` | `string` | 진행률 (예: "70%") |

**SnapshotGitState 중첩 객체:**

| 필드 | 타입 | 설명 |
|---|---|---|
| `mainCommits` | `number` | main 브랜치 커밋 수 |
| `openPRs` | `string[]` | 열린 PR 제목 목록 |
| `branches` | `Record<string, string>` | 브랜치별 상태 (예: `{ "set-b/backend": "ahead 3" }`) |

---

### 2.10 usage

**경로**: `usage/{userId}/monthly/{YYYY-MM}`

사용자별 월간 토큰 사용량을 집계한다. 비용 추적 및 한도 경고에 활용한다.

| 필드 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `totalTokens` | `number` | 필수 | `0` | 월간 총 토큰 사용량 |
| `totalSessions` | `number` | 필수 | `0` | 월간 총 세션 수 |
| `totalMessages` | `number` | 필수 | `0` | 월간 총 메시지 수 |
| `byProject` | `Record<string, number>` | 선택 | `{}` | 프로젝트별 토큰 사용량 집계 |
| `estimatedCost` | `number` | 선택 | `0` | 예상 비용 (USD, 참고용) |
| `updatedAt` | `Timestamp` | 필수 | 서버 시간 | 마지막 업데이트 시각 |

---

## 3. TypeScript 인터페이스 정의

`packages/shared/src/types/firestore.ts`에 위치하며, 서버와 클라이언트 양쪽에서 공유한다.

```typescript
import { Timestamp } from 'firebase/firestore'

// ─── 공통 타입 ───────────────────────────────────────────────

export type ProjectStatus = 'planning' | 'in_progress' | 'review' | 'paused' | 'completed' | 'archived'
export type SetStatus = 'idle' | 'working' | 'waiting' | 'done' | 'error'
export type TaskStatus = 'backlog' | 'in_progress' | 'review' | 'done' | 'blocked'
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low'
export type PullRequestStatus = 'open' | 'reviewing' | 'approved' | 'merged' | 'closed'
export type ReviewStatus = 'pending' | 'in_review' | 'approved' | 'changes_requested'
export type MessageSenderType = 'human' | 'leader' | 'system'
export type LogType = 'info' | 'code' | 'error' | 'progress'
export type AuthMethod = 'api_key' | 'max_plan'
export type SnapshotTrigger = 'pr_merged' | 'task_done' | 'manual' | 'scheduled' | 'session_end' | 'pm_away'
export type SystemEventType =
  | 'git_push'
  | 'git_branch'
  | 'pr_created'
  | 'pr_merged'
  | 'pr_closed'
  | 'pr_review_requested'
  | 'task_created'
  | 'task_updated'
  | 'task_blocked'
  | 'set_status_changed'
  | 'session_started'
  | 'session_ended'
  | 'session_restored'
  | 'session_timeout_warning'
  | 'snapshot_created'
  | 'rebase_completed'
  | 'rebase_conflict'

// SystemEventPayload — 상세 정의는 03_메시지_프로토콜.md 참조
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SystemEventPayload = Record<string, any> & { type: SystemEventType }

// ─── users/{userId} ──────────────────────────────────────────

export interface UserSettings {
  theme: 'dark' | 'light' | 'system'
  language: string
  notificationsEnabled: boolean
}

export interface User {
  displayName: string
  email: string
  photoURL: string | null
  apiKeyEncrypted: string | null
  authMethod: AuthMethod
  settings: Partial<UserSettings>
  createdAt: Timestamp
  updatedAt: Timestamp
}

// ─── projects/{projectId} ────────────────────────────────────

export interface Project {
  name: string
  description: string
  ownerId: string
  type: 'new' | 'existing' | 'analysis'
  status: ProjectStatus
  techStack: string[]
  defaultRoomId: string | null
  activeSetIds: string[]
  createdAt: Timestamp
  updatedAt: Timestamp
}

// ─── projects/{projectId}/git/config ─────────────────────────

export interface GitConfig {
  repoUrl: string | null
  localPath: string
  defaultBranch: string
  isRemote: boolean
  githubTokenEncrypted: string | null
  updatedAt: Timestamp
}

// ─── projects/{projectId}/rooms/{roomId} ─────────────────────

export interface Room {
  name: string
  purpose: string
  status: 'active' | 'paused' | 'completed'
  participantSetIds: string[]
  messageCount: number
  lastMessageAt: Timestamp | null
  createdAt: Timestamp
}

// ─── projects/{projectId}/rooms/{roomId}/messages/{messageId} ─

export interface ArtifactRef {
  path: string
  type: 'created' | 'modified' | 'deleted'
  language?: string
  storageUrl?: string
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface InlineAction {
  id: string
  label: string
  type: 'link' | 'command' | 'task_create' | 'review_request' | 'merge'
  payload: Record<string, unknown>
}

export interface MessageMetadata {
  artifacts?: ArtifactRef[]
  taskRefs?: string[]
  commitHash?: string
  commitHashes?: string[]
  pullRequestUrl?: string
  pullRequestId?: string
  branch?: string
  tokenUsage?: TokenUsage
  actions?: InlineAction[]
  systemEvent?: SystemEventPayload
  sessionRestored?: boolean
  snapshotId?: string
}

export interface Message {
  senderId: string
  senderName: string
  senderType: MessageSenderType
  senderColor: string | null
  content: string
  replyTo: string | null
  metadata: MessageMetadata | null
  isInternalLog: boolean
  timestamp: Timestamp
}

// ─── projects/{projectId}/sets/{setId} ───────────────────────

export interface AgentSet {
  name: string
  role: string
  status: SetStatus
  teammates: number
  color: string
  branch: string | null
  worktreePath: string | null
  currentTaskId: string | null
  progress: number
  preset: string | null
  systemPrompt: string | null
  sessionStatus: 'none' | 'starting' | 'alive' | 'dead'
  sessionAlive: boolean
  lastActiveAt: Timestamp | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

// ─── projects/{projectId}/sets/{setId}/logs/{logId} ──────────

export interface SetLog {
  content: string
  type: LogType
  agentId: string | null
  taskId: string | null
  timestamp: Timestamp
}

// ─── projects/{projectId}/tasks/{taskId} ─────────────────────

export interface Task {
  title: string
  description: string
  status: TaskStatus
  assignedSetId: string | null
  priority: TaskPriority
  dependencies: string[]
  branch: string | null
  pullRequestId: string | null
  pullRequestUrl: string | null
  blockedReason: string | null
  blockedFromStatus: TaskStatus | null
  creationMethod: 'human' | 'leader' | 'system'
  parentTaskId: string | null
  subTaskIds: string[]
  createdFromMessageId: string | null
  roomId: string | null
  completedAt: Timestamp | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

// ─── projects/{projectId}/pullRequests/{prId} ────────────────

export interface DiffStats {
  additions: number
  deletions: number
  filesChanged: number
}

export interface PullRequest {
  title: string
  description: string
  githubPrNumber: number | null
  githubPrUrl: string | null
  sourceBranch: string
  targetBranch: string
  setId: string
  status: PullRequestStatus        // Git 관점 상태 (open/merged/closed 등)
  reviewStatus: ReviewStatus       // 리뷰 프로세스 상태 (pending/in_review/approved 등)
  reviewerSetIds: string[]
  reviewRounds: number
  autoReviewResult: string | null
  diffStats: DiffStats | null
  reviewNotes: string[]
  relatedTaskIds: string[]
  approvedBy: string[]
  createdAt: Timestamp
  mergedAt: Timestamp | null
  closedAt: Timestamp | null
}

// ─── projects/{projectId}/snapshots/{snapshotId} ─────────────

export interface SnapshotTask {
  taskId: string
  title: string
  setName: string
  progress: string
}

export interface SnapshotGitState {
  mainCommits: number
  openPRs: string[]
  branches: Record<string, string>
}

export interface Snapshot {
  trigger: SnapshotTrigger
  summary: string
  completedTasks: string[]
  inProgressTasks: SnapshotTask[]
  decisions: string[]
  gitState: SnapshotGitState | null
  recentMessageIds: string[]
  tokenUsageAtSnapshot: number
  createdAt: Timestamp
}

// ─── usage/{userId}/monthly/{YYYY-MM} ────────────────────────

export interface MonthlyUsage {
  totalTokens: number
  totalSessions: number
  totalMessages: number
  byProject: Record<string, number>
  estimatedCost: number
  updatedAt: Timestamp
}

// ─── 문서 ID가 포함된 래퍼 타입 (클라이언트용) ─────────────────

export interface WithId<T> {
  id: string
  data: T
}

export type ProjectWithId = WithId<Project>
export type RoomWithId = WithId<Room>
export type MessageWithId = WithId<Message>
export type AgentSetWithId = WithId<AgentSet>
export type TaskWithId = WithId<Task>
export type PullRequestWithId = WithId<PullRequest>
export type SnapshotWithId = WithId<Snapshot>
```

---

## 4. Firestore 인덱스 설계

### 4.1 복합 인덱스

복합 인덱스는 `firebase/firestore.indexes.json`에 정의한다.

```json
{
  "indexes": [
    {
      "comment": "프로젝트 목록 조회 — 소유자별 최근 업데이트순",
      "collectionGroup": "projects",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "ownerId", "order": "ASCENDING" },
        { "fieldPath": "updatedAt", "order": "DESCENDING" }
      ]
    },
    {
      "comment": "메시지 실시간 조회 — Room별 시간순 정렬",
      "collectionGroup": "messages",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "senderType", "order": "ASCENDING" },
        { "fieldPath": "timestamp", "order": "ASCENDING" }
      ]
    },
    {
      "comment": "메시지 시스템 이벤트 필터 — Room별 이벤트 타입별 조회",
      "collectionGroup": "messages",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "isInternalLog", "order": "ASCENDING" },
        { "fieldPath": "timestamp", "order": "ASCENDING" }
      ]
    },
    {
      "comment": "태스크 상태별 조회 — 칸반 보드 컬럼 렌더링",
      "collectionGroup": "tasks",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "ASCENDING" }
      ]
    },
    {
      "comment": "태스크 Set별 + 상태별 조회 — Set 작업 현황 필터",
      "collectionGroup": "tasks",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "assignedSetId", "order": "ASCENDING" },
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "updatedAt", "order": "DESCENDING" }
      ]
    },
    {
      "comment": "PR 상태별 조회 — Git 패널 열린 PR 목록",
      "collectionGroup": "pullRequests",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    },
    {
      "comment": "PR Set별 + 상태별 조회 — 특정 Set의 PR 이력",
      "collectionGroup": "pullRequests",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "setId", "order": "ASCENDING" },
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    },
    {
      "comment": "Set 로그 태스크별 + 시간순 조회 — 태스크별 로그 필터",
      "collectionGroup": "logs",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "taskId", "order": "ASCENDING" },
        { "fieldPath": "timestamp", "order": "ASCENDING" }
      ]
    },
    {
      "comment": "스냅샷 트리거별 최신 조회 — 세션 복원 시 최신 스냅샷 로드",
      "collectionGroup": "snapshots",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "trigger", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    }
  ],
  "fieldOverrides": [
    {
      "comment": "messages.timestamp — 단일 필드 내림차순 인덱스 (페이지네이션)",
      "collectionGroup": "messages",
      "fieldPath": "timestamp",
      "indexes": [
        { "order": "ASCENDING", "queryScope": "COLLECTION" },
        { "order": "DESCENDING", "queryScope": "COLLECTION" }
      ]
    },
    {
      "comment": "tasks.updatedAt — 최근 수정 태스크 조회",
      "collectionGroup": "tasks",
      "fieldPath": "updatedAt",
      "indexes": [
        { "order": "DESCENDING", "queryScope": "COLLECTION" }
      ]
    },
    {
      "comment": "snapshots.createdAt — 최신 스냅샷 1개 조회",
      "collectionGroup": "snapshots",
      "fieldPath": "createdAt",
      "indexes": [
        { "order": "DESCENDING", "queryScope": "COLLECTION" }
      ]
    }
  ]
}
```

### 4.2 인덱스 설계 원칙

- **등호 필터(`==`)는 항상 앞에**, 범위 필터(`>`, `<`, `orderBy`)는 뒤에 배치
- `timestamp` 기반 `orderBy`가 거의 모든 컬렉션에서 사용되므로, 단일 필드 인덱스는 기본 자동 생성으로 충분
- Firestore는 컬렉션 그룹 쿼리(`collectionGroup`)를 위한 별도 인덱스가 필요하지만, 이 프로젝트는 부모 경로가 명확하므로 `COLLECTION` 스코프만 사용
- 인덱스 수가 많을수록 쓰기 비용이 증가하므로 **실제 사용 쿼리에 필요한 것만** 생성

---

## 5. 주요 쿼리 패턴

### 5.1 메시지 조회

#### 실시간 리스너 (신규 메시지 수신)

```typescript
import { collection, query, orderBy, onSnapshot, limit } from 'firebase/firestore'
import { db } from '@/firebase/client'
import type { Message } from '@council/shared'

// 최근 50개 메시지 구독 — 컴포넌트 마운트 시 호출
function subscribeToMessages(
  projectId: string,
  roomId: string,
  onMessage: (messages: Array<Message & { id: string }>) => void
): () => void {
  const messagesRef = collection(db, `projects/${projectId}/rooms/${roomId}/messages`)
  const q = query(messagesRef, orderBy('timestamp', 'asc'), limit(50))

  const unsubscribe = onSnapshot(q, (snapshot) => {
    const messages = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...(doc.data() as Message),
    }))
    onMessage(messages)
  })

  return unsubscribe // 컴포넌트 언마운트 시 호출하여 리스너 해제
}

// 증분 업데이트 — 새 메시지만 처리
function subscribeToNewMessages(
  projectId: string,
  roomId: string,
  onNewMessage: (message: Message & { id: string }) => void
): () => void {
  const messagesRef = collection(db, `projects/${projectId}/rooms/${roomId}/messages`)
  const q = query(messagesRef, orderBy('timestamp', 'asc'))

  const unsubscribe = onSnapshot(q, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === 'added') {
        onNewMessage({ id: change.doc.id, ...(change.doc.data() as Message) })
      }
    })
  })

  return unsubscribe
}
```

#### 페이지네이션 (과거 메시지 로드)

```typescript
import {
  collection, query, orderBy, limit, startAfter,
  getDocs, DocumentSnapshot
} from 'firebase/firestore'

const PAGE_SIZE = 30

// 초기 로드
async function loadInitialMessages(
  projectId: string,
  roomId: string
): Promise<{ messages: Array<Message & { id: string }>; lastDoc: DocumentSnapshot | null }> {
  const messagesRef = collection(db, `projects/${projectId}/rooms/${roomId}/messages`)
  const q = query(messagesRef, orderBy('timestamp', 'desc'), limit(PAGE_SIZE))
  const snapshot = await getDocs(q)

  const messages = snapshot.docs
    .map((doc) => ({ id: doc.id, ...(doc.data() as Message) }))
    .reverse() // 시간순으로 다시 뒤집기

  return {
    messages,
    lastDoc: snapshot.docs[snapshot.docs.length - 1] ?? null,
  }
}

// 이전 메시지 더 불러오기 (무한 스크롤)
async function loadMoreMessages(
  projectId: string,
  roomId: string,
  cursor: DocumentSnapshot
): Promise<{ messages: Array<Message & { id: string }>; lastDoc: DocumentSnapshot | null }> {
  const messagesRef = collection(db, `projects/${projectId}/rooms/${roomId}/messages`)
  const q = query(
    messagesRef,
    orderBy('timestamp', 'desc'),
    startAfter(cursor),
    limit(PAGE_SIZE)
  )
  const snapshot = await getDocs(q)

  const messages = snapshot.docs
    .map((doc) => ({ id: doc.id, ...(doc.data() as Message) }))
    .reverse()

  return {
    messages,
    lastDoc: snapshot.docs[snapshot.docs.length - 1] ?? null,
  }
}
```

---

### 5.2 태스크 필터링

```typescript
import { collection, query, where, orderBy, getDocs, onSnapshot } from 'firebase/firestore'
import type { Task, TaskStatus } from '@council/shared'

// 상태별 태스크 조회 — 칸반 컬럼 렌더링
async function getTasksByStatus(
  projectId: string,
  status: TaskStatus
): Promise<Array<Task & { id: string }>> {
  const tasksRef = collection(db, `projects/${projectId}/tasks`)
  const q = query(
    tasksRef,
    where('status', '==', status),
    orderBy('createdAt', 'asc')
  )
  const snapshot = await getDocs(q)
  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Task) }))
}

// Set별 + 상태별 태스크 실시간 구독
function subscribeToSetTasks(
  projectId: string,
  setId: string,
  status: TaskStatus,
  onUpdate: (tasks: Array<Task & { id: string }>) => void
): () => void {
  const tasksRef = collection(db, `projects/${projectId}/tasks`)
  const q = query(
    tasksRef,
    where('assignedSetId', '==', setId),
    where('status', '==', status),
    orderBy('updatedAt', 'desc')
  )
  return onSnapshot(q, (snapshot) => {
    onUpdate(snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Task) })))
  })
}

// 전체 칸반 보드 실시간 구독 — 한 번의 쿼리로 모든 상태 가져오기
function subscribeToAllTasks(
  projectId: string,
  onUpdate: (tasks: Array<Task & { id: string }>) => void
): () => void {
  const tasksRef = collection(db, `projects/${projectId}/tasks`)
  const q = query(tasksRef, orderBy('createdAt', 'asc'))
  return onSnapshot(q, (snapshot) => {
    onUpdate(snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Task) })))
  })
}
```

---

### 5.3 PR 조회

```typescript
import { collection, query, where, orderBy, getDocs } from 'firebase/firestore'
import type { PullRequest, PullRequestStatus } from '@council/shared'

// 열린 PR 목록 — Git 패널 표시
async function getOpenPullRequests(
  projectId: string
): Promise<Array<PullRequest & { id: string }>> {
  const prsRef = collection(db, `projects/${projectId}/pullRequests`)
  const q = query(
    prsRef,
    where('status', 'in', ['open', 'reviewing', 'approved']),
    orderBy('createdAt', 'desc')
  )
  const snapshot = await getDocs(q)
  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as PullRequest) }))
}

// 특정 Set의 PR 이력
async function getPullRequestsBySet(
  projectId: string,
  setId: string
): Promise<Array<PullRequest & { id: string }>> {
  const prsRef = collection(db, `projects/${projectId}/pullRequests`)
  const q = query(
    prsRef,
    where('setId', '==', setId),
    orderBy('createdAt', 'desc')
  )
  const snapshot = await getDocs(q)
  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as PullRequest) }))
}

// 상태별 PR 실시간 구독
function subscribeToPullRequests(
  projectId: string,
  status: PullRequestStatus,
  onUpdate: (prs: Array<PullRequest & { id: string }>) => void
): () => void {
  const prsRef = collection(db, `projects/${projectId}/pullRequests`)
  const q = query(
    prsRef,
    where('status', '==', status),
    orderBy('createdAt', 'desc')
  )
  return onSnapshot(q, (snapshot) => {
    onUpdate(snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as PullRequest) })))
  })
}
```

---

### 5.4 사용량 집계

```typescript
import { doc, getDoc, setDoc, updateDoc, increment, serverTimestamp } from 'firebase/firestore'
import type { MonthlyUsage } from '@council/shared'

// 현재 월 키 생성
function getCurrentMonthKey(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

// 토큰 사용량 증분 업데이트 (서버 SDK — 원자적 연산)
async function incrementTokenUsage(
  userId: string,
  projectId: string,
  tokens: number
): Promise<void> {
  const monthKey = getCurrentMonthKey()
  const usageRef = doc(db, `usage/${userId}/monthly/${monthKey}`)

  await setDoc(
    usageRef,
    {
      totalTokens: increment(tokens),
      totalMessages: increment(1),
      [`byProject.${projectId}`]: increment(tokens),
      updatedAt: serverTimestamp(),
    },
    { merge: true } // 문서가 없으면 생성, 있으면 병합
  )
}

// 월간 사용량 조회
async function getMonthlyUsage(
  userId: string,
  monthKey?: string
): Promise<MonthlyUsage | null> {
  const key = monthKey ?? getCurrentMonthKey()
  const usageRef = doc(db, `usage/${userId}/monthly/${key}`)
  const snapshot = await getDoc(usageRef)
  return snapshot.exists() ? (snapshot.data() as MonthlyUsage) : null
}
```

---

### 5.5 세션 복원용 최신 스냅샷 조회

```typescript
import { collection, query, orderBy, limit, getDocs } from 'firebase/firestore'
import type { Snapshot } from '@council/shared'

// 세션 복원 시 가장 최신 스냅샷 1개 로드
async function getLatestSnapshot(
  projectId: string
): Promise<(Snapshot & { id: string }) | null> {
  const snapshotsRef = collection(db, `projects/${projectId}/snapshots`)
  const q = query(snapshotsRef, orderBy('createdAt', 'desc'), limit(1))
  const snapshot = await getDocs(q)

  if (snapshot.empty) return null
  const doc = snapshot.docs[0]
  return { id: doc.id, ...(doc.data() as Snapshot) }
}
```

---

## 6. 데이터 관계도

```
┌─────────────────────────────────────────────────────────────────────┐
│                          ERD (Entity Relationship Diagram)           │
└─────────────────────────────────────────────────────────────────────┘

users                          usage
──────                         ──────────────────
userId (PK)                    userId (FK → users)
displayName                    │
email                          └─ monthly/{YYYY-MM}
apiKeyEncrypted                    totalTokens
authMethod                         byProject{}
                                   ...

     │ owns (1:N)
     ▼

projects
────────────────────────────────────
projectId (PK)
ownerId (FK → users)
name, type, status
defaultRoomId (FK → rooms)
activeSetIds[] (FK → sets)
     │
     ├─ git/config (1:1)
     │     localPath, repoUrl, ...
     │
     ├─ rooms (1:N) ──────────────────────────────────────────────────
     │   roomId (PK)                                                  │
     │   status, messageCount                                         │
     │        │                                                       │
     │        └─ messages (1:N)                                      │
     │               messageId (PK)                                   │
     │               senderId (FK → users | sets)                     │
     │               senderType: human|leader|system                  │
     │               metadata.taskRefs[] (FK → tasks)                │
     │               metadata.pullRequestId (FK → pullRequests)      │
     │               timestamp                                        │
     │                                                                │
     ├─ sets (1:N) ────────────────────────────────────────────────── ┘
     │   setId (PK)
     │   name, role, status, color
     │   branch → Git 브랜치 (논리적 참조)
     │   currentTaskId (FK → tasks)
     │        │
     │        └─ logs (1:N)
     │               logId (PK)
     │               type, content
     │               taskId (FK → tasks)
     │               timestamp
     │
     ├─ tasks (1:N)
     │   taskId (PK)
     │   assignedSetId (FK → sets)
     │   status: backlog|in_progress|review|done|blocked
     │   dependencies[] (self-ref FK → tasks)
     │   pullRequestId (FK → pullRequests)
     │   createdFromMessageId (FK → messages)
     │
     ├─ pullRequests (1:N)
     │   prId (PK)
     │   setId (FK → sets)
     │   status: open|reviewing|approved|merged|closed
     │   relatedTaskIds[] (FK → tasks)
     │   githubPrNumber → GitHub PR (외부 참조)
     │
     └─ snapshots (1:N)
           snapshotId (PK)
           trigger, summary
           recentMessageIds[] (FK → messages)
           createdAt

─────────────────────────────────────────────────────────────────────
관계 요약:
  users      1 ── N  projects       (소유)
  projects   1 ── N  rooms          (포함)
  rooms      1 ── N  messages       (포함)
  projects   1 ── N  sets           (포함)
  sets       1 ── N  logs           (포함)
  projects   1 ── N  tasks          (포함)
  projects   1 ── N  pullRequests   (포함)
  projects   1 ── N  snapshots      (포함)
  sets       1 ── N  tasks          (할당, 선택적)
  sets       1 ── N  pullRequests   (생성, 1:N)
  tasks      N ── N  tasks          (의존성, 자기참조)
  tasks      1 ── 1  pullRequests   (연결, 선택적)
  messages   1 ── N  tasks          (생성 출처, 역방향)
```

---

## 7. Firestore 제약사항 고려

### 7.1 문서 크기 1MB 제한

| 컬렉션 | 위험 필드 | 대응책 |
|---|---|---|
| `messages` | `content` (마크다운/코드) | 코드 블록이 10KB 초과 시 Firebase Storage 업로드 후 URL 저장 |
| `snapshots` | `summary`, `decisions[]` | 텍스트 요약은 2,000자 이내로 제한 |
| `sets` | `role` (시스템 프롬프트) | 역할 프롬프트는 4,000자 이내로 제한 |
| `tasks` | `description` | 상세 설명은 5,000자 이내로 제한 |

**구체적 기준:**
- `messages.content`: 64KB 초과 시 Storage로 오프로드 (평균 메시지 << 1KB이므로 실질적으로 문제 없음)
- 하나의 문서가 **500KB를 초과하면 경고**, 900KB를 초과하면 쓰기 거부 후 분할

### 7.2 컬렉션 깊이 제한 (최대 100)

현재 설계의 최대 깊이:
```
projects / {id} / rooms / {id} / messages / {id}   → 깊이 6 (안전)
projects / {id} / sets  / {id} / logs     / {id}   → 깊이 6 (안전)
usage    / {id} / monthly / {YYYY-MM}              → 깊이 4 (안전)
```
100 깊이 제한에서 충분히 여유롭다.

### 7.3 쓰기 속도 제한 (초당 1회/문서)

**위험 시나리오**: 여러 Set이 동시에 로그를 쓰거나, 다수 클라이언트가 동일 문서를 동시에 업데이트하는 경우.

**대응책:**
- `sets/{setId}` 문서의 `progress` 필드는 **1초에 최대 1회**만 업데이트 (클라이언트 디바운스 적용)
- `rooms/{roomId}.messageCount`는 `increment()` 원자 연산 사용, 단 직접 읽기 대신 `messages` 서브컬렉션 크기로 추론
- `usage` 집계는 서버 측 Cloud Functions 배치 처리 대신, 세션 종료 시 **단일 원자 업데이트**로 처리

### 7.4 트랜잭션 사용 범위

트랜잭션이 필요한 작업:
1. **태스크 상태 전이** (`in_progress → done`): 동시 업데이트 방지
2. **PR 머지**: `pullRequests.status = 'merged'` + `tasks.status = 'done'` 동시 업데이트
3. **Set 할당**: 동일 태스크에 두 Set이 동시에 할당되는 경쟁 조건 방지

```typescript
import { runTransaction, doc } from 'firebase/firestore'

// 태스크 완료 처리 — 원자적 업데이트
async function completeTask(projectId: string, taskId: string, prId: string): Promise<void> {
  const taskRef = doc(db, `projects/${projectId}/tasks/${taskId}`)
  const prRef = doc(db, `projects/${projectId}/pullRequests/${prId}`)

  await runTransaction(db, async (transaction) => {
    const taskDoc = await transaction.get(taskRef)
    if (!taskDoc.exists()) throw new Error('Task not found')
    if (taskDoc.data().status === 'done') return // 이미 완료됨

    transaction.update(taskRef, { status: 'done', completedAt: serverTimestamp() })
    transaction.update(prRef, { status: 'merged', mergedAt: serverTimestamp() })
  })
}
```

---

## 8. 마이그레이션 전략

### 8.1 스키마 버전 관리

각 컬렉션 최상위 문서에 `schemaVersion` 필드를 추가하여 버전을 추적한다.

```typescript
// 향후 projects 문서에 추가
interface Project {
  // ... 기존 필드
  schemaVersion: number  // 현재: 1
}
```

### 8.2 무중단 마이그레이션 원칙

**필드 추가** (하위 호환):
- 새 필드는 항상 **선택(optional)** 으로 추가
- 기존 문서는 읽을 때 기본값으로 처리 (TypeScript `??` 연산자 활용)
- 배포 후 새 코드가 점진적으로 새 필드를 채워 넣음

**필드 제거** (3단계 프로세스):
```
1단계 (현재 배포): 코드에서 필드 읽기/쓰기 중단, deprecated 주석 추가
2단계 (다음 배포): 타입 정의에서 제거, 기존 데이터는 무시
3단계 (배치 작업): Cloud Functions 또는 스크립트로 Firestore에서 필드 물리적 삭제
```

**필드 타입 변경** (가장 위험):
```
1단계: 새 필드명으로 새 타입 필드 추가 (예: statusV2)
2단계: 쓰기 코드를 새 필드로 전환, 읽기 코드는 두 필드 모두 지원
3단계: 기존 데이터를 새 필드로 마이그레이션 (배치)
4단계: 구 필드 읽기 코드 제거 후 3단계 방식으로 구 필드 삭제
```

### 8.3 마이그레이션 스크립트 위치

```
packages/server/src/migrations/
├── v001_add_schema_version.ts
├── v002_rename_field_example.ts
└── run-migration.ts           # 버전별 순차 실행
```

### 8.4 롤백 전략

- Firestore는 문서 히스토리를 7일간 보관 (Spark 플랜 포함)
- 마이그레이션 전 **영향 받는 컬렉션 전체를 JSON 내보내기** (`firebase firestore:export`)
- 롤백 시 구 버전 코드를 먼저 재배포한 뒤, 필요 시 내보낸 백업으로 복원

---

## 9. Spark 플랜 무료 한도 최적화

### 9.1 무료 한도 현황

| 항목 | 무료 한도 | 예상 일간 사용량 | 여유 |
|---|---|---|---|
| Firestore 읽기 | 50,000 / 일 | ~5,000~8,000 | 충분 |
| Firestore 쓰기 | 20,000 / 일 | ~1,000~3,000 | 충분 |
| Firestore 삭제 | 20,000 / 일 | ~100 | 충분 |
| Firestore 저장 | 1 GB | ~100 MB | 충분 |
| Firebase Storage | 5 GB | ~50 MB | 충분 |

> **예상 사용량 산정 기준**: 활성 세션 1개, Set 4개, 시간당 메시지 60개, 8시간 세션 기준

### 9.2 읽기 최적화

**실시간 리스너 최적화:**
```typescript
// BAD: 불필요하게 넓은 범위 구독
const q = query(collection(db, `projects/${projectId}/tasks`))

// GOOD: 화면에 필요한 범위만 구독 (예: 현재 활성 상태만)
const q = query(
  collection(db, `projects/${projectId}/tasks`),
  where('status', 'in', ['in_progress', 'review']),
  limit(20)
)
```

**클라이언트 캐싱 활용:**
```typescript
// Firestore SDK의 오프라인 캐시를 활성화하면 읽기 비용 절감
import { initializeFirestore, persistentLocalCache } from 'firebase/firestore'

const db = initializeFirestore(app, {
  localCache: persistentLocalCache() // 브라우저 IndexedDB에 캐시
})
```

**Zustand 스토어를 캐시 계층으로 활용:**
```typescript
// 이미 로드한 프로젝트/메시지는 스토어에서 읽기 (Firestore 재요청 없음)
const cachedProject = useProjectStore((state) => state.projects[projectId])
if (!cachedProject) {
  // 스토어에 없을 때만 Firestore 조회
  await fetchAndCacheProject(projectId)
}
```

### 9.3 쓰기 최적화

**배치 쓰기 활용:**
```typescript
import { writeBatch, doc } from 'firebase/firestore'

// 여러 문서를 한 번에 업데이트 — 트랜잭션 비용 최소화
async function updateMultipleTaskStatuses(
  projectId: string,
  updates: Array<{ taskId: string; status: TaskStatus }>
): Promise<void> {
  const batch = writeBatch(db)
  updates.forEach(({ taskId, status }) => {
    const ref = doc(db, `projects/${projectId}/tasks/${taskId}`)
    batch.update(ref, { status, updatedAt: serverTimestamp() })
  })
  await batch.commit() // 최대 500개 문서 허용
}
```

**Set 진행률 업데이트 디바운스:**
```typescript
// Set이 작업 중 매초 progress를 업데이트하면 쓰기 한도 소진
// 5초 디바운스로 쓰기 횟수를 1/5로 줄임
import { debounce } from 'lodash-es'

const updateSetProgress = debounce(async (setId: string, progress: number) => {
  await updateDoc(doc(db, `projects/${projectId}/sets/${setId}`), { progress })
}, 5000)
```

**휘발성 데이터는 WebSocket으로:**
```
Firestore 저장 불필요 → WebSocket으로 처리:
- 타이핑 인디케이터 ("리더 A가 생각 중...")
- 실시간 진행률 바 (매초 업데이트)
- 세션 heartbeat

→ 이를 모두 Firestore에 쓰면 일 수천 회 불필요한 쓰기 발생
```

### 9.4 저장 용량 최적화

**메시지 TTL 설정 (Cloud Functions 미사용 대안):**
- Spark 플랜에서는 Cloud Functions를 사용할 수 없으므로, **Council Server가 주기적으로 오래된 로그를 정리**
- `logs` 컬렉션: 30일 이상된 항목 삭제
- `snapshots` 컬렉션: 최신 10개만 유지, 나머지 삭제

**코드 아티팩트 외부 저장:**
```
메시지에 코드 블록 직접 저장 → X (문서 크기 증가, 읽기 비용 증가)
Firebase Storage에 파일 업로드 후 URL 참조 → O
```

### 9.5 한도 초과 대응 계획

```
단계 1 — 모니터링 (무료)
  Grafana Cloud로 일간 읽기/쓰기 카운터 추적
  80% 도달 시 알림 발송

단계 2 — 최적화 (무료)
  쿼리 범위 축소, 캐싱 강화, 배치 쓰기 확대

단계 3 — Blaze 전환 (종량제)
  읽기: $0.06 / 10만 건 → 50만 읽기 시 $0.18/일 (~$5.4/월)
  쓰기: $0.18 / 10만 건 → 10만 쓰기 시 $0.18/일 (~$5.4/월)
  개인 프로젝트 수준에서 월 $10 미만 예상
```

---

## 관련 문서

- [PLAN.md](../PLAN.md) — 전체 설계 계획 (섹션 6: 데이터 모델, 섹션 5.4: Firestore vs WebSocket)
- [02_Security_Rules.md](./02_Security_Rules.md) — Firestore Security Rules 상세 (예정)
- [03_메시지_프로토콜.md](./03_메시지_프로토콜.md) — 메시지 타입, 포맷, Council↔Server 통신 규약
- [../00_설정_참조표.md](../00_설정_참조표.md) — Firestore 컬렉션 경로, 포트, 전역 설정값 단일 출처
