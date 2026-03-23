---
status: DRAFT
priority: 1
last_updated: 2026-03-23
---

# Agent Council — REST API 명세서

## 목차

1. [API 개요](#1-api-개요)
2. [프로젝트 API](#2-프로젝트-api)
3. [Set API](#3-set-api)
4. [태스크 API](#4-태스크-api)
5. [Git API](#5-git-api)
6. [세션 API](#6-세션-api)
7. [사용자 API](#7-사용자-api)

---

## 1. API 개요

### 1.1 베이스 URL

```
Production:  https://council.yourdomain.com/api
Development: http://localhost:3000/api
```

모든 엔드포인트는 `/api` 접두사를 공유한다. 브라우저 요청은 Cloudflare CDN을 통해 Oracle Ampere 서버의 Council Server(Node.js)로 라우팅된다.

### 1.2 인증 방식

Council Server는 Firebase Auth에서 발급된 **ID Token(JWT)** 을 사용하여 요청을 인증한다.

```
Authorization: Bearer <firebase-id-token>
```

- 클라이언트는 Firebase SDK의 `getIdToken()` 으로 토큰을 발급받아 헤더에 첨부한다.
- 토큰 유효기간은 1시간이며, 클라이언트가 자동으로 갱신한다.
- 서버는 Firebase Admin SDK로 토큰을 검증하고 `userId`를 추출한다.
- 인증 실패 시 `401 Unauthorized`를 반환한다.
- 프로젝트 소유권 불일치 시 `403 Forbidden`을 반환한다.

```typescript
// 클라이언트 토큰 첨부 예시
const token = await firebase.auth().currentUser?.getIdToken()
fetch('/api/projects', {
  headers: { Authorization: `Bearer ${token}` }
})
```

### 1.3 공통 응답 형식

모든 응답은 다음 구조를 따른다.

```typescript
// 성공 응답 (단일 리소스)
interface ApiResponse<T> {
  success: true
  data: T
}

// 성공 응답 (목록)
interface ApiListResponse<T> {
  success: true
  data: T[]
  pagination?: {
    total: number
    page: number
    limit: number
    hasNext: boolean
  }
}

// 에러 응답
interface ApiErrorResponse {
  success: false
  error: {
    code: string       // 에러 코드 (예: PROJECT_NOT_FOUND)
    message: string    // 사람이 읽을 수 있는 설명
    details?: unknown  // 추가 디버깅 정보 (개발 환경에서만)
  }
}
```

**HTTP 상태 코드 규칙:**

| 상태 코드 | 의미 |
|---|---|
| `200 OK` | 조회/수정 성공 |
| `201 Created` | 리소스 생성 성공 |
| `204 No Content` | 삭제 성공 (응답 바디 없음) |
| `400 Bad Request` | 잘못된 요청 파라미터 |
| `401 Unauthorized` | 인증 토큰 누락/만료/유효하지 않음 |
| `403 Forbidden` | 인증은 됐지만 해당 리소스 접근 권한 없음 |
| `404 Not Found` | 리소스 없음 |
| `409 Conflict` | 리소스 상태 충돌 (예: 이미 실행 중인 프로젝트 재시작) |
| `422 Unprocessable Entity` | 유효성 검사 실패 (필드 수준 오류) |
| `500 Internal Server Error` | 서버 내부 오류 |

### 1.4 공통 에러 코드

```typescript
type ErrorCode =
  // 인증
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'TOKEN_EXPIRED'
  // 리소스
  | 'PROJECT_NOT_FOUND'
  | 'SET_NOT_FOUND'
  | 'TASK_NOT_FOUND'
  | 'SESSION_NOT_FOUND'
  // 상태
  | 'PROJECT_ALREADY_RUNNING'
  | 'PROJECT_NOT_RUNNING'
  | 'PROJECT_ALREADY_PAUSED'
  | 'SESSION_INACTIVE'
  | 'CONFLICT'
  // 입력
  | 'VALIDATION_ERROR'
  | 'MISSING_REQUIRED_FIELD'
  | 'INVALID_FIELD_VALUE'
  // Git
  | 'GIT_REPO_NOT_FOUND'
  | 'GIT_CLONE_FAILED'
  | 'GIT_PR_CREATION_FAILED'
  | 'GIT_MERGE_CONFLICT'
  | 'GIT_BRANCH_NOT_FOUND'
  // 서버
  | 'INTERNAL_ERROR'
  | 'CLAUDE_SESSION_UNAVAILABLE'
```

### 1.5 공통 타입 정의

```typescript
type Timestamp = string  // ISO 8601: "2026-03-23T14:30:00Z"

type ProjectStatus = 'planning' | 'in_progress' | 'paused' | 'review' | 'completed' | 'archived'
type ProjectType   = 'new' | 'existing' | 'analysis'
type SetStatus     = 'idle' | 'working' | 'waiting' | 'done'
type TaskStatus    = 'backlog' | 'in_progress' | 'review' | 'done' | 'blocked'
type TaskPriority  = 'critical' | 'high' | 'medium' | 'low'
type PRStatus      = 'open' | 'reviewing' | 'approved' | 'merged' | 'closed'
```

---

## 2. 프로젝트 API

### 2.1 프로젝트 생성

프로젝트를 생성한다. 유형에 따라 신규 Git 저장소 초기화, 기존 저장소 클론, 분석 전용 클론을 수행한다.

**`POST /api/projects`**

#### 요청 바디

```typescript
type CreateProjectBody =
  | CreateNewProjectBody
  | CreateExistingProjectBody
  | CreateAnalysisProjectBody

interface CreateNewProjectBody {
  type: 'new'
  name: string           // 필수, 1~100자
  description?: string
  techStack?: string[]   // 예: ["React", "Spring Boot", "PostgreSQL"]
}

interface CreateExistingProjectBody {
  type: 'existing'
  name: string
  description?: string
  repoUrl: string        // GitHub HTTPS URL (예: https://github.com/user/repo)
  githubToken?: string   // Private repo 접근용 GitHub PAT
  branch?: string        // 기본값: "main"
}

interface CreateAnalysisProjectBody {
  type: 'analysis'
  name: string
  description?: string
  repoUrl: string        // 분석 대상 저장소 URL
  githubToken?: string
}
```

#### 응답 바디 `201 Created`

```typescript
interface ProjectResponse {
  id: string
  name: string
  description: string
  ownerId: string
  type: ProjectType
  status: ProjectStatus
  techStack: string[]
  git: {
    repoUrl?: string
    localPath: string
    defaultBranch: string
    isRemote: boolean
  }
  sets: SetSummary[]      // 기본적으로 빈 배열
  createdAt: Timestamp
  updatedAt: Timestamp
}

interface SetSummary {
  id: string
  name: string
  status: SetStatus
  color: string
  branch: string
}
```

#### 에러 케이스

| 코드 | 상태 | 조건 |
|---|---|---|
| `VALIDATION_ERROR` | 422 | name이 비어 있거나 100자 초과 |
| `MISSING_REQUIRED_FIELD` | 400 | `existing`/`analysis` 유형인데 `repoUrl` 누락 |
| `GIT_CLONE_FAILED` | 500 | 저장소 클론 실패 (URL 오류, 접근 권한 없음 등) |

#### curl 예시

```bash
# 신규 프로젝트
curl -X POST https://council.yourdomain.com/api/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "new",
    "name": "사내 메신저",
    "description": "React + Spring Boot 기반 사내 메신저",
    "techStack": ["React", "TypeScript", "Spring Boot", "PostgreSQL"]
  }'

# 기존 저장소 연결
curl -X POST https://council.yourdomain.com/api/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "existing",
    "name": "파일 전송 기능 추가",
    "repoUrl": "https://github.com/myorg/messenger",
    "githubToken": "ghp_xxxxxxxxxxxx",
    "branch": "main"
  }'
```

---

### 2.2 프로젝트 목록 조회

인증된 사용자의 프로젝트 목록을 반환한다.

**`GET /api/projects`**

#### 쿼리 파라미터

```typescript
interface GetProjectsQuery {
  status?: ProjectStatus      // 상태 필터
  type?: ProjectType          // 유형 필터
  page?: number               // 기본값: 1
  limit?: number              // 기본값: 20, 최대: 100
  sort?: 'createdAt' | 'updatedAt' | 'name'  // 기본값: updatedAt
  order?: 'asc' | 'desc'     // 기본값: desc
}
```

#### 응답 바디 `200 OK`

```typescript
interface GetProjectsResponse {
  success: true
  data: ProjectListItem[]
  pagination: {
    total: number
    page: number
    limit: number
    hasNext: boolean
  }
}

interface ProjectListItem {
  id: string
  name: string
  description: string
  type: ProjectType
  status: ProjectStatus
  techStack: string[]
  sets: SetSummary[]
  activeTasks: number        // in_progress 상태 태스크 수
  lastActivity: Timestamp    // 마지막 메시지/커밋 시각
  createdAt: Timestamp
  updatedAt: Timestamp
}
```

#### curl 예시

```bash
# 진행 중인 프로젝트만 조회
curl "https://council.yourdomain.com/api/projects?status=in_progress&limit=10" \
  -H "Authorization: Bearer $TOKEN"
```

---

### 2.3 프로젝트 상세 조회

**`GET /api/projects/:id`**

#### 경로 파라미터

| 파라미터 | 타입 | 설명 |
|---|---|---|
| `id` | string | 프로젝트 ID |

#### 응답 바디 `200 OK`

```typescript
interface ProjectDetailResponse {
  success: true
  data: ProjectDetail
}

interface ProjectDetail {
  id: string
  name: string
  description: string
  ownerId: string
  type: ProjectType
  status: ProjectStatus
  techStack: string[]
  git: {
    repoUrl?: string
    localPath: string
    defaultBranch: string
    isRemote: boolean
    // githubToken은 보안상 응답에 포함하지 않음
  }
  sets: SetDetail[]
  defaultRoomId: string      // 기본 Council Room ID
  taskSummary: {
    backlog: number
    in_progress: number
    review: number
    done: number
    blocked: number
  }
  latestSnapshot?: {
    id: string
    createdAt: Timestamp
    trigger: string
    summary: string
  }
  createdAt: Timestamp
  updatedAt: Timestamp
}

interface SetDetail {
  id: string
  name: string
  role: string
  status: SetStatus
  teammates: number
  color: string
  branch: string
  worktreePath: string
}
```

#### 에러 케이스

| 코드 | 상태 | 조건 |
|---|---|---|
| `PROJECT_NOT_FOUND` | 404 | 해당 ID의 프로젝트 없음 |
| `FORBIDDEN` | 403 | 다른 사용자의 프로젝트 접근 시도 |

#### curl 예시

```bash
curl "https://council.yourdomain.com/api/projects/proj_abc123" \
  -H "Authorization: Bearer $TOKEN"
```

---

### 2.4 프로젝트 수정

**`PATCH /api/projects/:id`**

부분 업데이트(Partial Update)를 수행한다. 포함된 필드만 수정한다.

#### 요청 바디

```typescript
interface UpdateProjectBody {
  name?: string
  description?: string
  githubToken?: string       // GitHub PAT 갱신 (암호화 저장)
  defaultBranch?: string
}
```

#### 응답 바디 `200 OK`

```typescript
interface UpdateProjectResponse {
  success: true
  data: ProjectResponse      // 수정된 프로젝트 전체 정보
}
```

#### 에러 케이스

| 코드 | 상태 | 조건 |
|---|---|---|
| `PROJECT_NOT_FOUND` | 404 | 프로젝트 없음 |
| `FORBIDDEN` | 403 | 소유자가 아님 |
| `VALIDATION_ERROR` | 422 | name이 100자 초과 등 |

#### curl 예시

```bash
curl -X PATCH "https://council.yourdomain.com/api/projects/proj_abc123" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "사내 메신저 v2", "description": "파일 전송 기능 추가"}'
```

---

### 2.5 프로젝트 삭제/아카이브

**`DELETE /api/projects/:id`**

기본 동작은 **아카이브**(소프트 삭제)다. `permanent=true` 쿼리 파라미터 지정 시 물리 삭제를 수행한다.

#### 쿼리 파라미터

```typescript
interface DeleteProjectQuery {
  permanent?: boolean    // 기본값: false (아카이브)
}
```

#### 응답

- **아카이브**: `200 OK` + 아카이브된 프로젝트 객체 (`status: 'archived'`)
- **물리 삭제**: `204 No Content`

#### 에러 케이스

| 코드 | 상태 | 조건 |
|---|---|---|
| `PROJECT_NOT_FOUND` | 404 | 프로젝트 없음 |
| `FORBIDDEN` | 403 | 소유자가 아님 |
| `PROJECT_ALREADY_RUNNING` | 409 | 활성 세션 있는 상태에서 삭제 시도 (먼저 중단 필요) |

#### curl 예시

```bash
# 아카이브
curl -X DELETE "https://council.yourdomain.com/api/projects/proj_abc123" \
  -H "Authorization: Bearer $TOKEN"

# 완전 삭제
curl -X DELETE "https://council.yourdomain.com/api/projects/proj_abc123?permanent=true" \
  -H "Authorization: Bearer $TOKEN"
```

---

### 2.6 Council 시작

프로젝트의 Council 세션을 시작한다. 각 Set에 대해 Git worktree를 생성하고, Claude Code 세션을 띄운다. 리더들이 Council Room에 입장 메시지를 보낸다.

**`POST /api/projects/:id/start`**

#### 요청 바디

```typescript
interface StartProjectBody {
  goal?: string              // PM의 초기 지시사항 (선택적)
  resumeFromSnapshot?: string // 특정 스냅샷 ID를 기반으로 세션 복원
}
```

#### 응답 바디 `200 OK`

```typescript
interface StartProjectResponse {
  success: true
  data: {
    projectId: string
    status: 'in_progress'
    sessions: SessionInfo[]
    roomId: string            // Council Room ID
    resumedFrom?: string      // 복원된 스냅샷 ID
  }
}

interface SessionInfo {
  setId: string
  setName: string
  sessionId: string
  status: 'starting' | 'active'
  worktreePath: string
  branch: string
}
```

#### 에러 케이스

| 코드 | 상태 | 조건 |
|---|---|---|
| `PROJECT_NOT_FOUND` | 404 | 프로젝트 없음 |
| `PROJECT_ALREADY_RUNNING` | 409 | 이미 활성 세션이 있음 |
| `CLAUDE_SESSION_UNAVAILABLE` | 500 | Claude Code 세션 시작 실패 |

#### curl 예시

```bash
curl -X POST "https://council.yourdomain.com/api/projects/proj_abc123/start" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"goal": "사내 메신저 시스템을 React + Spring Boot로 만들자"}'
```

---

### 2.7 Council 일시정지

**`POST /api/projects/:id/pause`**

진행 중인 작업을 마무리하고 세션을 일시정지한다. 스냅샷을 자동으로 생성한다.

#### 요청 바디

```typescript
interface PauseProjectBody {
  reason?: string             // 일시정지 사유 (선택적, 로그에 기록)
  waitForCompletion?: boolean // 현재 진행 중 작업 완료 대기 여부 (기본값: true)
}
```

#### 응답 바디 `200 OK`

```typescript
interface PauseProjectResponse {
  success: true
  data: {
    projectId: string
    status: 'paused'           // 일시정지 상태
    snapshotId: string         // 자동 생성된 스냅샷 ID
    pausedAt: Timestamp
  }
}
```

#### 에러 케이스

| 코드 | 상태 | 조건 |
|---|---|---|
| `PROJECT_NOT_RUNNING` | 409 | 실행 중이지 않은 프로젝트 정지 시도 |
| `PROJECT_ALREADY_PAUSED` | 409 | 이미 정지된 프로젝트 |

#### curl 예시

```bash
curl -X POST "https://council.yourdomain.com/api/projects/proj_abc123/pause" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "오늘 작업 종료", "waitForCompletion": true}'
```

---

### 2.8 Council 재개

**`POST /api/projects/:id/resume`**

일시정지된 프로젝트를 재개한다. 세션이 살아있으면 그대로 연결하고, 없으면 최신 스냅샷으로 복원한다.

#### 요청 바디

```typescript
interface ResumeProjectBody {
  snapshotId?: string          // 특정 스냅샷에서 재개 (기본: 최신 스냅샷)
}
```

#### 응답 바디 `200 OK`

`StartProjectResponse` 와 동일한 구조.

#### 에러 케이스

| 코드 | 상태 | 조건 |
|---|---|---|
| `PROJECT_ALREADY_RUNNING` | 409 | 이미 실행 중 |
| `SESSION_NOT_FOUND` | 404 | 스냅샷 없이 세션도 없는 경우 |

#### curl 예시

```bash
curl -X POST "https://council.yourdomain.com/api/projects/proj_abc123/resume" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

---

## 3. Set API

### 3.1 Set 생성

**`POST /api/projects/:id/sets`**

새 Agent Set을 생성한다. Set 생성 시 Git worktree와 브랜치가 자동으로 준비된다.

#### 요청 바디

```typescript
interface CreateSetBody {
  name: string               // 예: "백엔드팀", "프론트팀"
  role: string               // 리더 역할 프롬프트 (시스템 프롬프트로 사용)
  teammates?: number         // 리더를 제외한 팀원 수 (기본값: 3)
  color?: string             // UI 표시 색상 (hex, 기본값: 자동 할당)
  branch?: string            // 브랜치명 (기본값: "set-{id}/{slug}")
}
```

#### 응답 바디 `201 Created`

```typescript
interface CreateSetResponse {
  success: true
  data: {
    id: string
    projectId: string
    name: string
    role: string
    status: SetStatus
    teammates: number
    color: string
    branch: string
    worktreePath: string
    createdAt: Timestamp
  }
}
```

#### 에러 케이스

| 코드 | 상태 | 조건 |
|---|---|---|
| `PROJECT_NOT_FOUND` | 404 | 프로젝트 없음 |
| `VALIDATION_ERROR` | 422 | name 또는 role이 비어 있음 |

#### curl 예시

```bash
curl -X POST "https://council.yourdomain.com/api/projects/proj_abc123/sets" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "백엔드팀",
    "role": "당신은 백엔드 아키텍트이자 팀 리더입니다. Spring Boot와 PostgreSQL 전문가로서...",
    "teammates": 3,
    "color": "#22C55E"
  }'
```

---

### 3.2 Set 목록 조회

**`GET /api/projects/:id/sets`**

#### 응답 바디 `200 OK`

```typescript
interface GetSetsResponse {
  success: true
  data: SetDetail[]
}
```

`SetDetail` 타입은 [2.3 프로젝트 상세 조회](#23-프로젝트-상세-조회) 참조.

#### curl 예시

```bash
curl "https://council.yourdomain.com/api/projects/proj_abc123/sets" \
  -H "Authorization: Bearer $TOKEN"
```

---

### 3.3 Set 수정

**`PATCH /api/projects/:id/sets/:setId`**

#### 요청 바디

```typescript
interface UpdateSetBody {
  name?: string
  role?: string              // 리더 역할 프롬프트 수정 (다음 세션부터 적용)
  teammates?: number
  color?: string
}
```

#### 응답 바디 `200 OK`

```typescript
interface UpdateSetResponse {
  success: true
  data: SetDetail
}
```

#### 에러 케이스

| 코드 | 상태 | 조건 |
|---|---|---|
| `SET_NOT_FOUND` | 404 | 해당 Set 없음 |
| `FORBIDDEN` | 403 | 소유자가 아님 |

#### curl 예시

```bash
curl -X PATCH "https://council.yourdomain.com/api/projects/proj_abc123/sets/set_xyz789" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "백엔드팀 (API)", "teammates": 4}'
```

---

### 3.4 Set 삭제

**`DELETE /api/projects/:id/sets/:setId`**

Set을 삭제한다. 연결된 Git worktree도 함께 정리된다.

#### 응답 `204 No Content`

#### 에러 케이스

| 코드 | 상태 | 조건 |
|---|---|---|
| `SET_NOT_FOUND` | 404 | 해당 Set 없음 |
| `FORBIDDEN` | 403 | 소유자가 아님 |
| `CONFLICT` | 409 | Set이 현재 작업 중(`working` 상태)인 경우 |

#### curl 예시

```bash
curl -X DELETE "https://council.yourdomain.com/api/projects/proj_abc123/sets/set_xyz789" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 4. 태스크 API

### 4.1 태스크 생성

**`POST /api/projects/:id/tasks`**

#### 요청 바디

```typescript
interface CreateTaskBody {
  title: string                          // 필수, 1~200자
  description?: string
  status?: TaskStatus                    // 기본값: 'backlog'
  assignedSetId?: string                 // 담당 Set ID
  priority?: TaskPriority                // 기본값: 'medium'
  dependencies?: string[]                // 선행 태스크 ID 목록
  branch?: string                        // 관련 Git 브랜치
  createdFromMessageId?: string          // 이 태스크를 생성한 Council 메시지 ID
}
```

#### 응답 바디 `201 Created`

```typescript
interface CreateTaskResponse {
  success: true
  data: TaskDetail
}

interface TaskDetail {
  id: string
  projectId: string
  title: string
  description: string
  status: TaskStatus
  assignedSetId?: string
  assignedSetName?: string     // Set 이름 (조인)
  priority: TaskPriority
  dependencies: string[]
  branch?: string
  pullRequestUrl?: string
  createdFromMessageId?: string
  createdAt: Timestamp
  updatedAt: Timestamp
}
```

#### 에러 케이스

| 코드 | 상태 | 조건 |
|---|---|---|
| `PROJECT_NOT_FOUND` | 404 | 프로젝트 없음 |
| `SET_NOT_FOUND` | 404 | `assignedSetId`가 존재하지 않는 Set을 가리킴 |
| `VALIDATION_ERROR` | 422 | title이 비어 있거나 200자 초과 |

#### curl 예시

```bash
curl -X POST "https://council.yourdomain.com/api/projects/proj_abc123/tasks" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "채팅 API 구현",
    "description": "WebSocket STOMP + REST API 5개 엔드포인트 구현",
    "priority": "high",
    "assignedSetId": "set_xyz789",
    "dependencies": ["task_schema001"]
  }'
```

---

### 4.2 태스크 목록 조회

**`GET /api/projects/:id/tasks`**

#### 쿼리 파라미터

```typescript
interface GetTasksQuery {
  status?: TaskStatus | TaskStatus[]    // 복수 필터: ?status=backlog&status=in_progress
  assignedSetId?: string
  priority?: TaskPriority
  page?: number
  limit?: number
  sort?: 'createdAt' | 'updatedAt' | 'priority'
  order?: 'asc' | 'desc'
}
```

#### 응답 바디 `200 OK`

```typescript
interface GetTasksResponse {
  success: true
  data: TaskDetail[]
  pagination: {
    total: number
    page: number
    limit: number
    hasNext: boolean
  }
}
```

#### curl 예시

```bash
# 진행 중 + 리뷰 태스크 조회
curl "https://council.yourdomain.com/api/projects/proj_abc123/tasks?status=in_progress&status=review" \
  -H "Authorization: Bearer $TOKEN"
```

---

### 4.3 태스크 상세 조회

**`GET /api/projects/:id/tasks/:taskId`**

#### 응답 바디 `200 OK`

```typescript
interface GetTaskResponse {
  success: true
  data: TaskDetail
}
```

---

### 4.4 태스크 수정

**`PATCH /api/projects/:id/tasks/:taskId`**

#### 요청 바디

> **주의**: `status`와 `assignedSetId`는 이 엔드포인트에서 무시됨. 각각 전용 엔드포인트(`/status`, `/assign`)를 사용할 것.

```typescript
interface UpdateTaskBody {
  title?: string
  description?: string
  priority?: TaskPriority
  branch?: string
  pullRequestUrl?: string
  dependencies?: string[]
}
```

#### 응답 바디 `200 OK`

```typescript
interface UpdateTaskResponse {
  success: true
  data: TaskDetail
}
```

---

### 4.5 태스크 상태 변경

**`PATCH /api/projects/:id/tasks/:taskId/status`**

상태 변경에 특화된 엔드포인트. 상태 전환 유효성을 별도로 검증한다.

#### 요청 바디

```typescript
interface UpdateTaskStatusBody {
  status: TaskStatus
  note?: string              // 상태 변경 사유 (Council Room에 시스템 메시지로 기록)
}
```

#### 상태 전환 규칙

```
backlog    → in_progress, blocked
in_progress → review, blocked, backlog
review     → done, in_progress
done       → backlog (재오픈)
blocked    → backlog, in_progress
```

#### 응답 바디 `200 OK`

```typescript
interface UpdateTaskStatusResponse {
  success: true
  data: TaskDetail
}
```

#### 에러 케이스

| 코드 | 상태 | 조건 |
|---|---|---|
| `TASK_NOT_FOUND` | 404 | 태스크 없음 |
| `INVALID_FIELD_VALUE` | 422 | 허용되지 않는 상태 전환 |

#### curl 예시

```bash
curl -X PATCH "https://council.yourdomain.com/api/projects/proj_abc123/tasks/task_001/status" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "in_progress", "note": "Set B가 작업을 시작합니다."}'
```

---

### 4.6 태스크 Set 할당

**`PATCH /api/projects/:id/tasks/:taskId/assign`**

#### 요청 바디

```typescript
interface AssignTaskBody {
  setId: string | null       // null: 할당 해제
}
```

#### 응답 바디 `200 OK`

```typescript
interface AssignTaskResponse {
  success: true
  data: TaskDetail
}
```

#### curl 예시

```bash
# Set에 할당
curl -X PATCH "https://council.yourdomain.com/api/projects/proj_abc123/tasks/task_001/assign" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"setId": "set_xyz789"}'

# 할당 해제
curl -X PATCH "https://council.yourdomain.com/api/projects/proj_abc123/tasks/task_001/assign" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"setId": null}'
```

---

### 4.7 태스크 삭제

**`DELETE /api/projects/:id/tasks/:taskId`**

#### 응답 `204 No Content`

#### 에러 케이스

| 코드 | 상태 | 조건 |
|---|---|---|
| `TASK_NOT_FOUND` | 404 | 태스크 없음 |
| `FORBIDDEN` | 403 | 소유자가 아님 |

---

## 5. Git API

### 5.1 Git 상태 조회

**`GET /api/projects/:id/git/status`**

프로젝트와 모든 Set의 현재 Git 상태를 반환한다.

#### 응답 바디 `200 OK`

```typescript
interface GitStatusResponse {
  success: true
  data: {
    projectId: string
    mainBranch: {
      name: string
      latestCommit: {
        hash: string
        message: string
        author: string
        timestamp: Timestamp
      }
      totalCommits: number
    }
    sets: SetGitStatus[]
    openPRs: PRSummary[]
  }
}

interface SetGitStatus {
  setId: string
  setName: string
  branch: string
  status: SetStatus
  ahead: number              // main 대비 앞선 커밋 수
  behind: number             // main 대비 뒤처진 커밋 수
  hasUncommittedChanges: boolean
  latestCommit?: {
    hash: string
    message: string
    timestamp: Timestamp
  }
}

interface PRSummary {
  id: string
  githubPrNumber?: number
  githubPrUrl?: string
  title: string
  sourceBranch: string
  targetBranch: string
  setId: string
  setName: string
  status: PRStatus
  additions: number
  deletions: number
  changedFiles: number
  createdAt: Timestamp
}
```

#### curl 예시

```bash
curl "https://council.yourdomain.com/api/projects/proj_abc123/git/status" \
  -H "Authorization: Bearer $TOKEN"
```

---

### 5.2 브랜치 목록 조회

**`GET /api/projects/:id/git/branches`**

#### 쿼리 파라미터

```typescript
interface GetBranchesQuery {
  includeRemote?: boolean    // 원격 브랜치 포함 여부 (기본값: false)
}
```

#### 응답 바디 `200 OK`

```typescript
interface GetBranchesResponse {
  success: true
  data: {
    current: string
    branches: BranchInfo[]
  }
}

interface BranchInfo {
  name: string
  isDefault: boolean
  isSetBranch: boolean       // Agent Set 브랜치 여부
  setId?: string             // Set 브랜치인 경우 연결된 Set ID
  lastCommit: {
    hash: string
    message: string
    timestamp: Timestamp
  }
  ahead: number              // main 대비
  behind: number
}
```

#### curl 예시

```bash
curl "https://council.yourdomain.com/api/projects/proj_abc123/git/branches" \
  -H "Authorization: Bearer $TOKEN"
```

---

### 5.3 PR 생성

**`POST /api/projects/:id/git/pr`**

Set 브랜치에서 main(또는 지정 브랜치)으로 Pull Request를 생성한다. GitHub API 연동이 설정된 경우 실제 GitHub PR이 생성되고, 그렇지 않은 경우 내부 PR 추적 레코드만 생성된다.

#### 요청 바디

```typescript
interface CreatePRBody {
  setId: string              // PR을 생성할 Set
  title: string              // PR 제목
  body?: string              // PR 설명
  targetBranch?: string      // 대상 브랜치 (기본값: defaultBranch = "main")
  relatedTaskIds?: string[]  // 연결할 태스크 ID 목록
  draft?: boolean            // Draft PR 여부 (기본값: false)
}
```

#### 응답 바디 `201 Created`

```typescript
interface CreatePRResponse {
  success: true
  data: {
    id: string               // 내부 PR ID
    projectId: string
    title: string
    body: string
    sourceBranch: string
    targetBranch: string
    setId: string
    setName: string
    status: 'open'
    githubPrNumber?: number
    githubPrUrl?: string
    additions: number
    deletions: number
    changedFiles: number
    relatedTaskIds: string[]
    draft: boolean
    createdAt: Timestamp
  }
}
```

#### 에러 케이스

| 코드 | 상태 | 조건 |
|---|---|---|
| `SET_NOT_FOUND` | 404 | 해당 Set 없음 |
| `GIT_PR_CREATION_FAILED` | 500 | GitHub API 호출 실패 |
| `GIT_BRANCH_NOT_FOUND` | 404 | Set 브랜치 없음 |
| `VALIDATION_ERROR` | 422 | title이 비어 있음 |

#### curl 예시

```bash
curl -X POST "https://council.yourdomain.com/api/projects/proj_abc123/git/pr" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "setId": "set_xyz789",
    "title": "feat: 백엔드 채팅 API 구현",
    "body": "## 변경사항\n- WebSocket STOMP 핸들러 추가\n- 채팅 REST API 5개 엔드포인트",
    "relatedTaskIds": ["task_001", "task_002"]
  }'
```

---

### 5.4 PR 머지

**`POST /api/projects/:id/git/merge`**

리뷰가 완료된 PR을 main 브랜치에 머지한다. 머지 후 나머지 Set의 worktree에 rebase/merge를 자동으로 수행하고, Council Room에 시스템 메시지를 전송한다.

#### 요청 바디

```typescript
interface MergePRBody {
  prId: string               // 머지할 내부 PR ID
  strategy?: 'merge' | 'squash' | 'rebase'  // 기본값: 'squash'
  commitMessage?: string     // squash 시 커밋 메시지 (기본값: PR 제목 사용)
  deleteSourceBranch?: boolean  // 머지 후 소스 브랜치 삭제 여부 (기본값: false)
}
```

#### 응답 바디 `200 OK`

```typescript
interface MergePRResponse {
  success: true
  data: {
    prId: string
    mergedAt: Timestamp
    mergeCommitHash: string
    rebaseResults: RebaseResult[]
    deletedBranch?: string
  }
}

interface RebaseResult {
  setId: string
  setName: string
  branch: string
  result: 'success' | 'conflict' | 'skipped'
  conflictFiles?: string[]   // 충돌 발생 파일 목록
}
```

#### 에러 케이스

| 코드 | 상태 | 조건 |
|---|---|---|
| `GIT_MERGE_CONFLICT` | 409 | 머지 중 충돌 발생 |
| `VALIDATION_ERROR` | 422 | PR이 `open` 또는 `approved` 상태가 아님 |

#### curl 예시

```bash
curl -X POST "https://council.yourdomain.com/api/projects/proj_abc123/git/merge" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "prId": "pr_001",
    "strategy": "squash",
    "commitMessage": "feat: 백엔드 채팅 API 구현 (#3)",
    "deleteSourceBranch": true
  }'
```

---

### 5.5 PR 상세 조회

**`GET /api/projects/:id/git/pr/:prId`**

PR의 상세 정보를 반환한다.

#### 경로 파라미터

| 파라미터 | 타입 | 설명 |
|---|---|---|
| `id` | string | 프로젝트 ID |
| `prId` | string | PR ID |

#### 응답 바디 `200 OK`

```typescript
interface GetPRResponse {
  success: true
  data: {
    id: string
    projectId: string
    title: string
    body: string
    sourceBranch: string
    targetBranch: string
    setId: string
    setName: string
    status: PRStatus
    githubPrNumber?: number
    githubPrUrl?: string
    additions: number
    deletions: number
    changedFiles: number
    relatedTaskIds: string[]
    draft: boolean
    createdAt: Timestamp
    updatedAt: Timestamp
  }
}
```

#### 에러 케이스

| 코드 | 상태 | 조건 |
|---|---|---|
| `PROJECT_NOT_FOUND` | 404 | 프로젝트 없음 |
| `GIT_BRANCH_NOT_FOUND` | 404 | 해당 PR 없음 |

#### curl 예시

```bash
curl "https://council.yourdomain.com/api/projects/proj_abc123/git/pr/pr_001" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 5.6 Room API

### 5.6.1 Room 목록 조회

**`GET /api/projects/:id/rooms`**

프로젝트의 Room 목록을 반환한다.

#### 응답 바디 `200 OK`

```typescript
interface GetRoomsResponse {
  success: true
  data: RoomSummary[]
}

interface RoomSummary {
  id: string
  projectId: string
  name: string
  type: 'council' | 'set'    // council: 전체 협의체, set: Set 전용
  setId?: string             // type === 'set'인 경우
  messageCount: number
  lastActivity: Timestamp
  createdAt: Timestamp
}
```

#### curl 예시

```bash
curl "https://council.yourdomain.com/api/projects/proj_abc123/rooms" \
  -H "Authorization: Bearer $TOKEN"
```

---

### 5.6.2 Room 상세 조회

**`GET /api/projects/:id/rooms/:roomId`**

#### 경로 파라미터

| 파라미터 | 타입 | 설명 |
|---|---|---|
| `id` | string | 프로젝트 ID |
| `roomId` | string | Room ID |

#### 응답 바디 `200 OK`

```typescript
interface GetRoomResponse {
  success: true
  data: RoomDetail
}

interface RoomDetail {
  id: string
  projectId: string
  name: string
  type: 'council' | 'set'
  setId?: string
  participants: {
    setId: string
    setName: string
    setColor: string
  }[]
  messageCount: number
  lastActivity: Timestamp
  createdAt: Timestamp
}
```

#### 에러 케이스

| 코드 | 상태 | 조건 |
|---|---|---|
| `PROJECT_NOT_FOUND` | 404 | 프로젝트 없음 |
| `FORBIDDEN` | 403 | 접근 권한 없음 |

#### curl 예시

```bash
curl "https://council.yourdomain.com/api/projects/proj_abc123/rooms/room_xyz" \
  -H "Authorization: Bearer $TOKEN"
```

---

### 5.6.3 PM 메시지 전송

**`POST /api/projects/:id/rooms/:roomId/messages`**

PM이 Council Room에 메시지를 전송한다. 메시지는 Firestore에 저장되고 WebSocket으로 브로드캐스트된다.

#### 요청 바디

```typescript
interface SendPMMessageBody {
  content: string            // 메시지 본문 (최대 10,000자)
  type?: 'text' | 'command' // 기본값: 'text'
}
```

#### 응답 바디 `201 Created`

```typescript
interface SendPMMessageResponse {
  success: true
  data: {
    id: string
    roomId: string
    projectId: string
    senderId: string           // PM userId
    senderType: 'pm'
    content: string
    type: 'text' | 'command'
    createdAt: Timestamp
  }
}
```

#### 에러 케이스

| 코드 | 상태 | 조건 |
|---|---|---|
| `PROJECT_NOT_FOUND` | 404 | 프로젝트 없음 |
| `FORBIDDEN` | 403 | 소유자가 아님 |
| `VALIDATION_ERROR` | 422 | content가 비어 있거나 10,000자 초과 |

#### curl 예시

```bash
curl -X POST "https://council.yourdomain.com/api/projects/proj_abc123/rooms/room_xyz/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "채팅 API 구현을 우선순위 1번으로 처리해주세요."}'
```

---

## 6. 세션 API

### 6.1 세션 상태 조회

**`GET /api/projects/:id/sessions`**

현재 프로젝트의 모든 Claude Code 세션 상태를 반환한다.

#### 응답 바디 `200 OK`

```typescript
interface GetSessionsResponse {
  success: true
  data: {
    projectId: string
    projectStatus: ProjectStatus
    sessions: SessionStatus[]
    lastActivity: Timestamp
    tokenUsage: {
      totalTokens: number
      sessionTokens: number          // 현재 세션 누적
      estimatedCost: number          // USD 기준 추정 비용
    }
  }
}

interface SessionStatus {
  setId: string
  setName: string
  sessionId: string
  isAlive: boolean
  status: 'active' | 'idle' | 'starting' | 'stopped'
  currentTask?: string               // 현재 처리 중인 작업 요약
  progress?: number                  // 0~100 (추정)
  tokenCount: number                 // 이 세션 누적 토큰
  startedAt: Timestamp
  lastHeartbeat: Timestamp
}
```

#### curl 예시

```bash
curl "https://council.yourdomain.com/api/projects/proj_abc123/sessions" \
  -H "Authorization: Bearer $TOKEN"
```

---

### 6.2 스냅샷 생성

**`POST /api/projects/:id/sessions/snapshot`**

현재 프로젝트 상태의 스냅샷을 수동으로 생성한다. 세션 복원의 기준점으로 사용된다.

#### 요청 바디

```typescript
interface CreateSnapshotBody {
  label?: string                     // 스냅샷 레이블 (예: "Phase 1 완료")
  includeDecisions?: string[]        // 수동으로 추가할 주요 결정사항
}
```

#### 응답 바디 `201 Created`

```typescript
interface CreateSnapshotResponse {
  success: true
  data: {
    id: string
    projectId: string
    label?: string
    trigger: 'manual'
    summary: string                  // 자동 생성된 프로젝트 상태 요약
    completedTasks: string[]
    inProgressTasks: {
      task: string
      set: string
      progress: string
    }[]
    decisions: string[]
    gitState: {
      mainCommits: number
      openPRs: string[]
      branches: Record<string, string>  // 브랜치명: 상태("ahead 3" 등)
    }
    createdAt: Timestamp
  }
}
```

#### 에러 케이스

| 코드 | 상태 | 조건 |
|---|---|---|
| `PROJECT_NOT_FOUND` | 404 | 프로젝트 없음 |
| `SESSION_INACTIVE` | 409 | 활성 세션이 없어 스냅샷 생성 불가 |

#### curl 예시

```bash
curl -X POST "https://council.yourdomain.com/api/projects/proj_abc123/sessions/snapshot" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "label": "Phase 1 완료 — DB 스키마 및 API 스펙 확정",
    "includeDecisions": [
      "SimpleBroker 사용 (Redis는 2차)",
      "cursor 기반 페이지네이션 채택"
    ]
  }'
```

---

### 6.3 스냅샷 목록 조회

**`GET /api/projects/:id/sessions/snapshots`**

#### 쿼리 파라미터

```typescript
interface GetSnapshotsQuery {
  page?: number
  limit?: number              // 기본값: 20
}
```

#### 응답 바디 `200 OK`

```typescript
interface GetSnapshotsResponse {
  success: true
  data: SnapshotSummary[]
  pagination: {
    total: number
    page: number
    limit: number
    hasNext: boolean
  }
}

interface SnapshotSummary {
  id: string
  label?: string
  trigger: 'pr_merged' | 'task_done' | 'manual' | 'scheduled' | 'session_end' | 'pm_away'
  summary: string
  createdAt: Timestamp
}
```

#### curl 예시

```bash
curl "https://council.yourdomain.com/api/projects/proj_abc123/sessions/snapshots" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 7. 사용자 API

### 7.1 내 프로필 조회

**`GET /api/users/me`**

현재 인증된 사용자의 프로필을 반환한다.

#### 응답 바디 `200 OK`

```typescript
interface GetMeResponse {
  success: true
  data: {
    id: string
    displayName: string
    email: string
    photoURL?: string
    authMethod: 'api_key' | 'max_plan'
    hasApiKey: boolean        // API 키 등록 여부 (키 자체는 반환하지 않음)
    usage: {
      currentMonth: {
        totalTokens: number
        totalSessions: number
        estimatedCost: number
      }
    }
    createdAt: Timestamp
  }
}
```

#### curl 예시

```bash
curl "https://council.yourdomain.com/api/users/me" \
  -H "Authorization: Bearer $TOKEN"
```

---

### 7.2 API 키 등록/갱신

**`PUT /api/users/me/api-key`**

Anthropic API 키 또는 Max Plan 인증 정보를 등록하거나 갱신한다. 키는 AES-256으로 암호화하여 Firestore에 저장된다.

#### 요청 바디

```typescript
type UpdateApiKeyBody =
  | UpdateAnthropicKeyBody
  | UpdateMaxPlanBody

interface UpdateAnthropicKeyBody {
  authMethod: 'api_key'
  apiKey: string             // "sk-ant-..." 형식
}

interface UpdateMaxPlanBody {
  authMethod: 'max_plan'
  authToken: string          // Claude Max Plan 인증 토큰
}
```

#### 응답 바디 `200 OK`

```typescript
interface UpdateApiKeyResponse {
  success: true
  data: {
    authMethod: 'api_key' | 'max_plan'
    hasApiKey: true
    updatedAt: Timestamp
  }
}
```

#### 에러 케이스

| 코드 | 상태 | 조건 |
|---|---|---|
| `VALIDATION_ERROR` | 422 | API 키 형식이 유효하지 않음 (`sk-ant-` 접두사 없음 등) |
| `INVALID_FIELD_VALUE` | 422 | 인증 토큰 검증 실패 |

#### curl 예시

```bash
# Anthropic API 키 등록
curl -X PUT "https://council.yourdomain.com/api/users/me/api-key" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "authMethod": "api_key",
    "apiKey": "sk-ant-api03-xxxxxxxxxxxxxxxxxxxx"
  }'

# Max Plan 인증
curl -X PUT "https://council.yourdomain.com/api/users/me/api-key" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "authMethod": "max_plan",
    "authToken": "claude-max-token-xxxxxxxxxxxx"
  }'
```

---

### 7.3 API 키 삭제

**`DELETE /api/users/me/api-key`**

등록된 API 키를 삭제한다. 이후 Council 세션을 시작하려면 키를 다시 등록해야 한다.

#### 응답 바디 `200 OK`

```typescript
interface DeleteApiKeyResponse {
  success: true
  data: {
    hasApiKey: false
    deletedAt: Timestamp
  }
}
```

#### curl 예시

```bash
curl -X DELETE "https://council.yourdomain.com/api/users/me/api-key" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 부록

### A. 엔드포인트 요약표

| 메서드 | 경로 | 설명 |
|---|---|---|
| `POST` | `/api/projects` | 프로젝트 생성 |
| `GET` | `/api/projects` | 프로젝트 목록 |
| `GET` | `/api/projects/:id` | 프로젝트 상세 |
| `PATCH` | `/api/projects/:id` | 프로젝트 수정 |
| `DELETE` | `/api/projects/:id` | 프로젝트 삭제/아카이브 |
| `POST` | `/api/projects/:id/start` | Council 시작 |
| `POST` | `/api/projects/:id/pause` | Council 일시정지 |
| `POST` | `/api/projects/:id/resume` | Council 재개 |
| `POST` | `/api/projects/:id/sets` | Set 생성 |
| `GET` | `/api/projects/:id/sets` | Set 목록 |
| `PATCH` | `/api/projects/:id/sets/:setId` | Set 수정 |
| `DELETE` | `/api/projects/:id/sets/:setId` | Set 삭제 |
| `POST` | `/api/projects/:id/tasks` | 태스크 생성 |
| `GET` | `/api/projects/:id/tasks` | 태스크 목록 |
| `GET` | `/api/projects/:id/tasks/:taskId` | 태스크 상세 |
| `PATCH` | `/api/projects/:id/tasks/:taskId` | 태스크 수정 |
| `PATCH` | `/api/projects/:id/tasks/:taskId/status` | 태스크 상태 변경 |
| `PATCH` | `/api/projects/:id/tasks/:taskId/assign` | 태스크 Set 할당 |
| `DELETE` | `/api/projects/:id/tasks/:taskId` | 태스크 삭제 |
| `GET` | `/api/projects/:id/git/status` | Git 상태 조회 |
| `GET` | `/api/projects/:id/git/branches` | 브랜치 목록 |
| `POST` | `/api/projects/:id/git/pr` | PR 생성 |
| `GET` | `/api/projects/:id/git/pr/:prId` | PR 상세 조회 |
| `POST` | `/api/projects/:id/git/merge` | PR 머지 |
| `GET` | `/api/projects/:id/rooms` | Room 목록 |
| `GET` | `/api/projects/:id/rooms/:roomId` | Room 상세 |
| `POST` | `/api/projects/:id/rooms/:roomId/messages` | PM 메시지 전송 |
| `GET` | `/api/projects/:id/sessions` | 세션 상태 조회 |
| `POST` | `/api/projects/:id/sessions/snapshot` | 스냅샷 생성 |
| `GET` | `/api/projects/:id/sessions/snapshots` | 스냅샷 목록 |
| `GET` | `/api/users/me` | 내 프로필 조회 |
| `PUT` | `/api/users/me/api-key` | API 키 등록/갱신 |
| `DELETE` | `/api/users/me/api-key` | API 키 삭제 |

### B. ID 명명 규칙

```
프로젝트: proj_{nanoid}     예: proj_abc123
Set:      set_{nanoid}      예: set_xyz789
태스크:   task_{nanoid}     예: task_001abc
PR:       pr_{nanoid}       예: pr_xyz001
스냅샷:   snap_{nanoid}     예: snap_ts001
세션:     sess_{nanoid}     예: sess_run001
```

### C. WebSocket 이벤트 (참조)

REST API 외에 Council Server는 WebSocket을 통해 다음 휘발성 이벤트를 클라이언트에 푸시한다. 자세한 명세는 `02_WebSocket_이벤트.md`에서 다룬다.

```typescript
type WSEventType =
  | 'typing:start'           // 리더가 응답 생성 시작
  | 'typing:stop'            // 리더 응답 생성 완료/중단
  | 'set:progress'           // Set 작업 진행률 업데이트
  | 'session:heartbeat'      // 세션 생존 확인
  | 'session:status'         // 세션 상태 전환
  | 'set:status'             // Set 작업 상태 전환
  | 'claude:streaming'       // Claude 응답 토큰 스트리밍
  | 'git:push'               // Set 브랜치 푸시 감지
  | 'git:conflict'           // worktree rebase 충돌 발생
```

Firestore `onSnapshot` 으로 처리되는 영속 데이터(메시지, 태스크, 상태)는 이 문서에서 다루지 않는다.

---

## 관련 문서

- [02_WebSocket_이벤트.md](./02_WebSocket_이벤트.md) — 실시간 WS 이벤트 명세
- [03_Claude_Adapter_인터페이스.md](./03_Claude_Adapter_인터페이스.md) — Claude Code 어댑터 인터페이스
- [../02_데이터설계/01_Firestore_스키마.md](../02_데이터설계/01_Firestore_스키마.md) — DB 구조
- [../00_설정_참조표.md](../00_설정_참조표.md) — 포트(3001), API 베이스 경로, 전역 설정값 단일 출처
