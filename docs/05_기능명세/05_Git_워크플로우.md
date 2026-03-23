---
status: DRAFT
priority: 3
last_updated: 2026-03-23
---

# 05. Git 워크플로우 기능 명세

## 목차

1. [개요](#1-개요)
2. [Git Worktree 관리](#2-git-worktree-관리)
3. [브랜치 전략](#3-브랜치-전략)
4. [PR 생명주기](#4-pr-생명주기)
5. [머지 후 처리](#5-머지-후-처리)
6. [Git 이벤트 감지 및 알림](#6-git-이벤트-감지-및-알림)
7. [GitHub API 연동](#7-github-api-연동)
8. [에러 케이스](#8-에러-케이스)

---

## 1. 개요

Agent Council의 Git 워크플로우는 **여러 Set이 같은 코드베이스를 동시에, 충돌 없이 작업**할 수 있도록 설계된다. 핵심 메커니즘은 Git worktree로, 하나의 로컬 리포지토리에서 Set마다 독립된 브랜치를 체크아웃하여 병렬 개발을 가능하게 한다.

```
하나의 Git 리포지토리
        │
        ├── /opt/agent-council/workspace/{projectId}/.git-repo  ← bare 리포지토리
        ├── /opt/agent-council/workspace/{projectId}/main       ← main 브랜치 (참조용)
        ├── /opt/agent-council/workspace/{projectId}/set-a      ← Set A 전용 worktree
        ├── /opt/agent-council/workspace/{projectId}/set-b      ← Set B 전용 worktree
        └── /opt/agent-council/workspace/{projectId}/set-c      ← Set C 전용 worktree
```

각 Set의 Claude Code 세션은 자신의 worktree 경로에서만 작업하며, 다른 Set의 작업 디렉토리를 직접 접근하지 않는다. 통합은 반드시 PR → Council 합의 → 머지 순서로 이루어진다.

---

## 2. Git Worktree 관리

### 2.1 Worktree란

`git worktree`는 하나의 Git 리포지토리에 여러 개의 작업 디렉토리를 연결하는 기능이다. 일반적인 브랜치 전환(`git checkout`)과 달리, worktree는 여러 브랜치를 **동시에** 각각 다른 디렉토리에서 체크아웃할 수 있다.

```
# 일반 브랜치: 한 번에 하나만 체크아웃 가능
git checkout set-a/architecture   ← set-b는 사용 불가

# worktree: 여러 브랜치를 동시에 체크아웃
/workspace/proj-001/main          ← main 브랜치
/workspace/proj-001/set-a         ← set-a/architecture 브랜치
/workspace/proj-001/set-b         ← set-b/backend 브랜치
```

### 2.2 디렉토리 구조

```
/opt/agent-council/workspace/
└── {projectId}/                       ← 프로젝트 루트
    ├── .git-repo/                     ← Git bare 리포지토리 (실제 .git 데이터)
    ├── main/                          ← main 브랜치 worktree (읽기 전용 참조)
    ├── set-a/                         ← Set A worktree
    ├── set-b/                         ← Set B worktree
    └── set-c/                         ← Set C worktree
```

**bare 리포지토리를 중심으로 worktree를 생성하는 이유:**

- bare 리포지토리는 작업 파일 없이 `.git` 데이터만 저장
- 모든 worktree가 동일한 오브젝트 저장소를 공유 (디스크 효율)
- worktree 간 브랜치 충돌이 발생하지 않음

### 2.3 Worktree 생성

**시점:** Set이 생성되고 첫 번째 작업 태스크가 할당될 때

```bash
# 1. 프로젝트 초기화 시: bare 리포지토리 생성
git clone --bare {repoUrl} /opt/agent-council/workspace/{projectId}/.git-repo

# 또는 신규 프로젝트의 경우:
git init --bare /opt/agent-council/workspace/{projectId}/.git-repo

# 2. main worktree 생성 (참조용)
git -C /opt/agent-council/workspace/{projectId}/.git-repo worktree add \
    /opt/agent-council/workspace/{projectId}/main main

# 3. Set A 브랜치 + worktree 생성
git -C /opt/agent-council/workspace/{projectId}/.git-repo worktree add \
    -b set-a/architecture \
    /opt/agent-council/workspace/{projectId}/set-a \
    main

# 4. Set B 브랜치 + worktree 생성
git -C /opt/agent-council/workspace/{projectId}/.git-repo worktree add \
    -b set-b/backend \
    /opt/agent-council/workspace/{projectId}/set-b \
    main

# 5. 생성 확인
git -C /opt/agent-council/workspace/{projectId}/.git-repo worktree list
# /opt/agent-council/workspace/proj-001/.git-repo  abc1234 (bare)
# /opt/agent-council/workspace/proj-001/main       abc1234 [main]
# /opt/agent-council/workspace/proj-001/set-a      abc1234 [set-a/architecture]
# /opt/agent-council/workspace/proj-001/set-b      abc1234 [set-b/backend]
```

**TypeScript 구현 예시 (서버 측):**

```typescript
// packages/server/src/git/worktree.ts

import { execAsync } from '../utils/exec'
import path from 'path'

const WORKSPACE_BASE = process.env.WORKSPACE_BASE ?? '/opt/agent-council/workspace'

export async function createProjectRepo(projectId: string, repoUrl?: string): Promise<void> {
  const repoPath = path.join(WORKSPACE_BASE, projectId, '.git-repo')

  if (repoUrl) {
    await execAsync(`git clone --bare ${repoUrl} ${repoPath}`)
  } else {
    await execAsync(`git init --bare ${repoPath}`)
    // 신규 프로젝트: 초기 커밋 생성 (main 브랜치 확보)
    const tmpPath = path.join(WORKSPACE_BASE, projectId, '_init_tmp')
    await execAsync(`git clone ${repoPath} ${tmpPath}`)
    await execAsync(`git -C ${tmpPath} commit --allow-empty -m "chore: initial commit"`)
    await execAsync(`git -C ${tmpPath} push origin main`)
    await execAsync(`rm -rf ${tmpPath}`)
  }

  // main worktree
  const mainPath = path.join(WORKSPACE_BASE, projectId, 'main')
  await execAsync(`git -C ${repoPath} worktree add ${mainPath} main`)
}

export async function createSetWorktree(
  projectId: string,
  setId: string,
  branchName: string
): Promise<string> {
  const repoPath = path.join(WORKSPACE_BASE, projectId, '.git-repo')
  const worktreePath = path.join(WORKSPACE_BASE, projectId, setId)

  await execAsync(
    `git -C ${repoPath} worktree add -b ${branchName} ${worktreePath} main`
  )

  return worktreePath
}
```

### 2.4 Worktree 삭제

**시점:**

| 상황 | 삭제 대상 |
|---|---|
| Set 삭제 | 해당 Set의 worktree |
| PR 머지 완료 후 Set 작업 종료 | 해당 Set의 worktree (선택적) |
| 프로젝트 완료/아카이브 | 전체 worktree (`.git-repo` 포함) |
| Set 작업 브랜치 변경 | 기존 worktree 삭제 후 새 브랜치로 재생성 |

```bash
# Set worktree 제거 (브랜치는 유지)
git -C /opt/agent-council/workspace/{projectId}/.git-repo worktree remove /opt/agent-council/workspace/{projectId}/set-a

# Set worktree 제거 + 브랜치도 삭제
git -C /opt/agent-council/workspace/{projectId}/.git-repo worktree remove /opt/agent-council/workspace/{projectId}/set-a
git -C /opt/agent-council/workspace/{projectId}/.git-repo branch -d set-a/architecture

# 프로젝트 전체 정리
git -C /opt/agent-council/workspace/{projectId}/.git-repo worktree prune
rm -rf /opt/agent-council/workspace/{projectId}
```

**주의:** 아직 머지되지 않은 커밋이 있는 worktree를 삭제하려면 `--force` 플래그가 필요하다. 이 경우 Council Room에 경고 메시지를 먼저 게시하고 PM 확인 후 진행한다.

### 2.5 Worktree vs Branch 관계

```
Git 오브젝트 레이어:
  브랜치(branch) = 특정 커밋을 가리키는 포인터 (논리적 개념)

파일시스템 레이어:
  worktree = 특정 브랜치를 체크아웃한 실제 디렉토리 (물리적 개념)

관계:
  - 1개의 브랜치는 최대 1개의 worktree에만 체크아웃 가능
  - worktree가 없는 브랜치는 존재 가능 (원격 추적 브랜치 등)
  - worktree를 삭제해도 브랜치는 유지됨 (명시적으로 삭제하지 않는 한)

Set과의 매핑:
  Set A (아키텍처팀) ←→ 브랜치: set-a/architecture ←→ worktree: /workspace/proj-001/set-a
  Set B (백엔드팀)   ←→ 브랜치: set-b/backend      ←→ worktree: /workspace/proj-001/set-b
```

---

## 3. 브랜치 전략

### 3.1 브랜치 명명 규칙

```
{set-id}/{topic}

예시:
  set-a/architecture    ← 아키텍처 Set의 기본 작업 브랜치
  set-b/backend         ← 백엔드 Set의 기본 작업 브랜치
  set-c/frontend        ← 프론트엔드 Set의 기본 작업 브랜치
  set-d/qa              ← QA Set의 기본 작업 브랜치
```

**하위 태스크 브랜치 (선택적):**

Set 내부에서 팀원이 더 세분화된 브랜치를 사용할 경우:

```
{set-id}/{topic}/{subtopic}

예시:
  set-b/backend/auth-api
  set-b/backend/websocket
  set-c/frontend/login-page
```

이 경우 Set 리더 브랜치(`set-b/backend`)에 먼저 머지한 후, Council PR을 통해 `main`에 머지한다.

### 3.2 main 브랜치 보호

`main` 브랜치는 **직접 커밋이 금지**된다. 모든 변경은 PR을 통해서만 반영된다.

```bash
# 서버 측에서 main 직접 푸시 방지 (Git hooks)
# /workspace/{projectId}/.git-repo/hooks/pre-receive

#!/bin/sh
while read oldrev newrev refname; do
  if [ "$refname" = "refs/heads/main" ]; then
    echo "ERROR: main 브랜치에 직접 푸시할 수 없습니다."
    echo "       PR을 통해 머지하세요."
    exit 1
  fi
done
```

GitHub 리포지토리가 연동된 경우, Branch Protection Rules도 설정한다:

```json
{
  "required_pull_request_reviews": {
    "required_approving_review_count": 1
  },
  "restrictions": null,
  "enforce_admins": false,
  "required_status_checks": null
}
```

### 3.3 머지 순서 합의

여러 Set의 PR이 동시에 완료될 경우, Council Room에서 리더들이 머지 순서를 합의한다. 일반적인 권장 순서:

```
1. 아키텍처/인터페이스 Set (API 스펙, 스키마 등 다른 팀이 의존)
2. 백엔드 Set (프론트엔드가 의존)
3. 프론트엔드 Set
4. QA Set (테스트 코드, 마지막에 머지)
```

의존성이 없는 경우 임의의 순서로 머지 가능하나, rebase 충돌 최소화를 위해 **한 번에 하나씩 순차 머지**를 원칙으로 한다.

```
Council Room 예시:
  🎯 아키텍트: DB 스키마 PR (#1)과 API 스펙 PR (#2)가 준비됐습니다.
              백엔드팀 API 구현보다 먼저 머지되어야 합니다.
  🟢 백엔드: 동의합니다. #1 → #2 → #3(백엔드) 순서를 제안합니다.
  👤 PM: 좋아요. #1부터 머지해주세요.
  ⚙️ 시스템: PR #1 "DB 스키마" main에 머지 완료.
             Set B, C, D worktree 자동 rebase 중...
```

---

## 4. PR 생명주기

### 4.1 PR 생성 플로우

```
┌─────────────────────────────────────────────────────────────────┐
│  Set 작업 완료 → 자동 PR 생성 플로우                              │
└─────────────────────────────────────────────────────────────────┘

  Set 리더       Council Server      GitHub API       Firestore
     │                 │                  │               │
     │ "작업 완료,      │                  │               │
     │  PR 올립니다"    │                  │               │
     │────────────────>│                  │               │
     │                 │ POST /pulls      │               │
     │                 │─────────────────>│               │
     │                 │                  │               │
     │                 │ PR 생성 성공      │               │
     │                 │<─────────────────│               │
     │                 │                  │               │
     │                 │ pullRequests/{id} write          │
     │                 │─────────────────────────────────>│
     │                 │                  │               │
     │                 │ rooms/.../messages write (시스템) │
     │                 │─────────────────────────────────>│
     │                 │                  │               │
     ▼                 ▼                  ▼               ▼
```

**PR 자동 생성 조건:**

Set 리더의 메시지에서 다음 패턴을 감지하면 자동 PR 생성을 트리거한다:
- "PR 올립니다", "PR 생성해주세요", "작업 완료 PR"
- 또는 리더가 `/pr create` 명시적 커맨드 사용

```typescript
// packages/server/src/git/pr.ts

import { Octokit } from '@octokit/rest'
import { db } from '../firebase/admin'
import { postSystemMessage } from '../council/messages'

interface CreatePROptions {
  projectId: string
  setId: string
  sourceBranch: string
  title: string
  body?: string
  relatedTaskIds?: string[]
}

export async function createPullRequest(opts: CreatePROptions): Promise<string> {
  const { projectId, setId, sourceBranch, title, body, relatedTaskIds } = opts

  // 프로젝트 Git 설정 로드
  const gitConfigDoc = await db
    .collection('projects').doc(projectId)
    .collection('git').doc('config')
    .get()
  const gitConfig = gitConfigDoc.data()!

  if (!gitConfig.isRemote || !gitConfig.githubToken) {
    throw new Error('GitHub 연동이 설정되지 않았습니다.')
  }

  // 최근 커밋 요약 수집 (PR body 자동 생성용)
  const commits = await getRecentCommits(projectId, setId, sourceBranch)
  const autoBody = body ?? generatePRBody(commits, relatedTaskIds)

  // GitHub API로 PR 생성
  const [owner, repo] = extractOwnerRepo(gitConfig.repoUrl)
  const octokit = new Octokit({ auth: decrypt(gitConfig.githubToken) })

  const { data: pr } = await octokit.pulls.create({
    owner,
    repo,
    title,
    body: autoBody,
    head: sourceBranch,
    base: gitConfig.defaultBranch,
  })

  // Firestore pullRequests 컬렉션에 저장
  const prRef = db.collection('projects').doc(projectId).collection('pullRequests').doc()
  await prRef.set({
    title,
    githubPrNumber: pr.number,
    githubPrUrl: pr.html_url,
    sourceBranch,
    targetBranch: gitConfig.defaultBranch,
    setId,
    status: 'open',
    reviewNotes: [],
    relatedTaskIds: relatedTaskIds ?? [],
    createdAt: new Date(),
    mergedAt: null,
  })

  // Council Room에 시스템 메시지 게시
  await postSystemMessage(projectId, {
    content: `PR #${pr.number} "${title}" 이 생성되었습니다.\n` +
             `${sourceBranch} → ${gitConfig.defaultBranch} | ` +
             `+${pr.additions} -${pr.deletions} | 파일 ${pr.changed_files}개\n` +
             `🔗 ${pr.html_url}`,
    metadata: { pullRequestUrl: pr.html_url },
  })

  return prRef.id
}
```

### 4.2 Council Room에서의 리뷰 트리거

PR이 생성된 후 다른 Set 리더(특히 QA Set)가 리뷰를 수행한다.

```
┌─────────────────────────────────────────────────────────────────┐
│  PR 리뷰 플로우                                                    │
└─────────────────────────────────────────────────────────────────┘

Council Room 대화 흐름:

  ⚙️ 시스템: PR #3 "백엔드 채팅 API" 생성됨. set-b/backend → main
             +423 -12 | 파일 8개 | 🔗 https://github.com/.../pull/3

  🟡 QA팀: PR #3 코드 리뷰 시작합니다.
           [Council Server가 QA Set에 리뷰 작업 지시]

  ⚙️ 시스템: Set D (QA)가 PR #3 코드 리뷰를 시작했습니다.

  --- (QA Set 내부 작업, 수 분 소요) ---

  🟡 QA팀: PR #3 리뷰 완료.
           - ChatController.java: 입력 검증 누락 (line 45)
           - ChatService.java: 트랜잭션 범위 적절
           - 전반적으로 아키텍처 스펙에 부합합니다.
           수정 요청: 입력 검증 추가 후 승인 가능합니다.

  🎯 아키텍트: API 스펙과 일치 확인. 입력 검증만 수정되면 승인합니다.

  🟢 백엔드: 확인했습니다. 즉시 수정하겠습니다.
           [수정 완료 후 커밋 푸시]

  🟢 백엔드: 입력 검증 추가 완료. 커밋: fix/input-validation

  🎯 아키텍트: 승인합니다.
  🟡 QA팀: 승인합니다.

  👤 PM: 머지해주세요.
```

**리뷰 상태 동기화:**

Council Room의 승인 발언이 감지되면 Firestore `pullRequests` 문서의 `status`가 갱신된다.

```typescript
// 승인 패턴 감지
const APPROVAL_PATTERNS = ['승인합니다', '머지 가능', 'LGTM', 'approve']
const REJECTION_PATTERNS = ['수정 요청', '반려', 'request changes']

async function updatePRStatusFromMessage(
  projectId: string,
  senderId: string,
  content: string
): Promise<void> {
  const openPRs = await getOpenPRsForProject(projectId)

  for (const pr of openPRs) {
    if (APPROVAL_PATTERNS.some(p => content.includes(p))) {
      await addReviewNote(projectId, pr.id, { reviewer: senderId, type: 'approved', content })
    } else if (REJECTION_PATTERNS.some(p => content.includes(p))) {
      await addReviewNote(projectId, pr.id, { reviewer: senderId, type: 'changes_requested', content })
    }
  }
}
```

### 4.3 승인 → 머지 플로우

```
┌─────────────────────────────────────────────────────────────────┐
│  머지 실행 플로우                                                   │
└─────────────────────────────────────────────────────────────────┘

  PM/리더      Council Server      GitHub API       Firestore
     │                │                │               │
     │ "머지해주세요"   │                │               │
     │───────────────>│                │               │
     │                │ PUT /pulls/    │               │
     │                │ {num}/merge    │               │
     │                │───────────────>│               │
     │                │                │               │
     │                │ 머지 성공       │               │
     │                │<───────────────│               │
     │                │                │               │
     │                │ pullRequests status: 'merged'  │
     │                │──────────────────────────────>│
     │                │                │               │
     │                │ task status: 'done'            │
     │                │──────────────────────────────>│
     │                │                │               │
     │                │ [다른 Set worktree rebase 시작] │
     │                │                │               │
     ▼                ▼                ▼               ▼
```

```typescript
// packages/server/src/git/merge.ts

export async function mergePullRequest(
  projectId: string,
  prFirestoreId: string
): Promise<void> {
  const prDoc = await db
    .collection('projects').doc(projectId)
    .collection('pullRequests').doc(prFirestoreId)
    .get()
  const pr = prDoc.data()!

  const gitConfig = await getGitConfig(projectId)
  const [owner, repo] = extractOwnerRepo(gitConfig.repoUrl)
  const octokit = new Octokit({ auth: decrypt(gitConfig.githubToken) })

  // GitHub에서 머지 실행
  await octokit.pulls.merge({
    owner,
    repo,
    pull_number: pr.githubPrNumber,
    merge_method: 'merge',
  })

  // Firestore 상태 갱신
  await prDoc.ref.update({
    status: 'merged',
    mergedAt: new Date(),
  })

  // 관련 태스크를 done으로 업데이트
  for (const taskId of pr.relatedTaskIds) {
    await db
      .collection('projects').doc(projectId)
      .collection('tasks').doc(taskId)
      .update({ status: 'done', updatedAt: new Date() })
  }

  // 머지된 Set의 worktree에서 main fetch
  const mainPath = getWorktreePath(projectId, 'main')
  await execAsync(`git -C ${mainPath} pull origin main`)

  // 다른 Set worktree 자동 rebase (비동기)
  rebaseOtherWorktrees(projectId, pr.setId).catch(err => {
    postSystemMessage(projectId, {
      content: `⚠️ 일부 Set worktree의 자동 rebase 중 오류가 발생했습니다: ${err.message}`,
    })
  })
}
```

### 4.4 Firestore pullRequests 컬렉션 동기화

PR 상태 변화의 전체 생명주기가 Firestore에 기록된다.

> **PR 상태 필드 구분**: PR 문서는 두 개의 독립적인 상태 필드를 가진다.
> - `status`: Git/PR 수명주기 상태 — `open` | `reviewing` | `approved` | `merged` | `closed`
> - `reviewStatus`: 코드 리뷰 진행 상태 — `requested` | `in_review` | `changes_requested` | `approved`
>
> 두 필드는 독립적으로 관리되며 06_코드_리뷰.md의 동기화 매트릭스를 따른다.

```
projects/{projectId}/pullRequests/{prId}

생성 시:
  status: 'open'
  githubPrNumber: 3
  githubPrUrl: "https://github.com/.../pull/3"
  sourceBranch: "set-b/backend"
  targetBranch: "main"
  setId: "set-b"
  reviewNotes: []

리뷰 진행 중:
  status: 'reviewing'
  reviewNotes: [
    { reviewer: "set-d", type: "changes_requested", content: "입력 검증 추가 필요" },
  ]

승인 후:
  status: 'approved'
  reviewNotes: [
    { reviewer: "set-d", type: "approved", content: "승인합니다." },
    { reviewer: "set-a", type: "approved", content: "아키텍처 스펙 부합. 승인." },
  ]

머지 완료:
  status: 'merged'
  mergedAt: Timestamp
```

---

## 5. 머지 후 처리

### 5.1 다른 Set Worktree 자동 Rebase

PR이 `main`에 머지되면 다른 Set들의 worktree가 최신 `main` 위로 rebase되어야 한다. 이 작업은 자동으로 수행된다.

```
머지 전:
  main:    A ─ B ─ C
  set-b:   A ─ B ─ X ─ Y (PR로 머지됨)
  set-c:   A ─ B ─ P ─ Q (아직 진행 중)

머지 후 (set-b가 main에 머지됨):
  main:    A ─ B ─ C ─ X ─ Y  (머지 커밋)
  set-c:   자동 rebase 수행 →  A ─ B ─ C ─ X ─ Y ─ P' ─ Q'
```

```bash
# Set C worktree에서 자동 rebase
cd /opt/agent-council/workspace/{projectId}/set-c
git fetch origin main
git rebase origin/main
```

```typescript
// packages/server/src/git/rebase.ts

export async function rebaseOtherWorktrees(
  projectId: string,
  mergedSetId: string
): Promise<void> {
  const sets = await getActiveSets(projectId)
  const otherSets = sets.filter(s => s.id !== mergedSetId)

  await postSystemMessage(projectId, {
    content: `PR 머지 완료. Set ${otherSets.map(s => s.name).join(', ')}의 worktree를 자동 rebase합니다...`,
  })

  for (const set of otherSets) {
    try {
      const worktreePath = getWorktreePath(projectId, set.id)

      await execAsync(`git -C ${worktreePath} fetch origin main`)
      await execAsync(`git -C ${worktreePath} rebase origin/main`)

      await postSystemMessage(projectId, {
        content: `✅ ${set.name}: rebase 성공`,
      })
    } catch (err: any) {
      await handleRebaseConflict(projectId, set, err)
    }
  }
}
```

### 5.2 충돌 감지

rebase 중 충돌이 발생하면 즉시 abort하고 Council Room에 알린다.

```typescript
async function handleRebaseConflict(
  projectId: string,
  set: AgentSet,
  err: Error
): Promise<void> {
  const worktreePath = getWorktreePath(projectId, set.id)

  // 충돌 파일 목록 추출
  const conflictOutput = await execAsync(
    `git -C ${worktreePath} diff --name-only --diff-filter=U`
  ).catch(() => ({ stdout: '알 수 없음' }))

  const conflictFiles = conflictOutput.stdout.trim().split('\n').filter(Boolean)

  // rebase 중단
  await execAsync(`git -C ${worktreePath} rebase --abort`).catch(() => {})

  // Set 상태를 blocked로 업데이트
  await db
    .collection('projects').doc(projectId)
    .collection('sets').doc(set.id)
    .update({ status: 'blocked' })

  // Council Room에 충돌 알림
  await postSystemMessage(projectId, {
    content:
      `⚠️ ${set.name}: rebase 충돌 발생\n` +
      `충돌 파일:\n${conflictFiles.map(f => `  - ${f}`).join('\n')}\n` +
      `${set.name} 리더에게 해결을 요청합니다.`,
    metadata: { conflictSetId: set.id, conflictFiles },
  })

  // Set 리더에게 직접 알림 (Set 내부 메시지로 전달)
  await notifySetLeader(projectId, set.id, {
    type: 'rebase_conflict',
    conflictFiles,
    instructions: `main 브랜치의 최신 변경사항과 충돌이 발생했습니다. ` +
                  `충돌 파일을 확인하고 해결 후 Council Room에 보고해주세요.`,
  })
}
```

### 5.3 충돌 해결 프로세스

```
충돌 발생 후 Council Room 흐름:

  ⚙️ 시스템: ⚠️ Set C (프론트엔드): rebase 충돌 발생
             충돌 파일:
               - src/App.tsx
               - src/api/chat.ts
             Set C 리더에게 해결을 요청합니다.

  🔵 프론트: 충돌 파일 확인했습니다.
            src/App.tsx는 백엔드팀의 라우팅 변경과 충돌입니다.
            🟢 백엔드팀, API 엔드포인트 변경 내용 확인 부탁드립니다.

  🟢 백엔드: /api/v1/chat → /api/v2/chat 로 변경됐습니다.
            제가 직접 확인해드릴게요. 변경 이유는 버전 관리 정책 때문입니다.

  🔵 프론트: 이해했습니다. /api/v2/chat 기준으로 수정하겠습니다.
            [Set C 내부에서 충돌 수동 해결 후 rebase 재개]

  🔵 프론트: 충돌 해결 완료. rebase 성공했습니다.

  ⚙️ 시스템: ✅ Set C: rebase 완료 (수동 해결)
```

**충돌 해결 시 Set 리더 작업 순서:**

```bash
# 1. 충돌 파일 직접 편집
#    worktree 내에서 충돌 마커(<<<<, ====, >>>>) 수동 해결

# 2. 해결된 파일 스테이징
git -C /opt/agent-council/workspace/{projectId}/set-c add src/App.tsx src/api/chat.ts

# 3. rebase 계속
git -C /opt/agent-council/workspace/{projectId}/set-c rebase --continue

# 4. 성공 시 원격 브랜치에 force push
git -C /opt/agent-council/workspace/{projectId}/set-c push --force-with-lease origin set-c/frontend
```

---

## 6. Git 이벤트 감지 및 알림

### 6.1 이벤트 감지 방식

Council Server는 두 가지 방식으로 Git 이벤트를 감지한다.

#### 방식 A: 로컬 File Watcher (로컬 worktree 변경 감지)

```typescript
// packages/server/src/git/watcher.ts
import chokidar from 'chokidar'
import path from 'path'

export function watchProjectWorktrees(projectId: string): void {
  const repoPath = path.join(WORKSPACE_BASE, projectId, '.git-repo')

  // bare 리포지토리의 refs/heads 감시 (브랜치 ref가 갱신될 때 = 커밋 발생)
  const refsWatcher = chokidar.watch(
    path.join(repoPath, 'refs', 'heads'),
    { persistent: true, ignoreInitial: true }
  )

  refsWatcher.on('change', async (filePath) => {
    const branchName = path.relative(
      path.join(repoPath, 'refs', 'heads'),
      filePath
    ).replace(/\//g, '/')

    await handleBranchUpdate(projectId, branchName)
  })
}

async function handleBranchUpdate(projectId: string, branchName: string): Promise<void> {
  if (branchName === 'main') return  // main 갱신은 머지 플로우에서 처리

  const setId = extractSetIdFromBranch(branchName)  // "set-b/backend" → "set-b"
  if (!setId) return

  // 새 커밋 목록 조회
  const worktreePath = getWorktreePath(projectId, setId)
  const newCommits = await getNewCommitsSinceLastNotified(projectId, setId, worktreePath)

  if (newCommits.length === 0) return

  await postSystemMessage(projectId, {
    content:
      `Set ${setId}가 ${branchName} 브랜치에 ${newCommits.length}개 커밋을 추가했습니다.\n` +
      newCommits.map(c => `  - ${c.message}`).join('\n'),
    metadata: {
      commitHash: newCommits[newCommits.length - 1].hash,
    },
  })

  // 마지막 알림 커밋 해시 갱신
  await updateLastNotifiedCommit(projectId, setId, newCommits[newCommits.length - 1].hash)
}
```

#### 방식 B: GitHub Webhook (원격 리포지토리 이벤트)

GitHub 리포지토리가 연동된 경우, Webhook을 등록하여 원격 이벤트를 실시간으로 수신한다.

```typescript
// packages/server/src/git/webhook.ts
import express from 'express'

export function registerWebhookHandlers(app: express.Application): void {
  app.post('/webhook/github/:projectId', express.json(), async (req, res) => {
    const { projectId } = req.params
    const event = req.headers['x-github-event'] as string
    const payload = req.body

    res.sendStatus(200)  // GitHub에 즉시 응답

    switch (event) {
      case 'push':
        await handlePushEvent(projectId, payload)
        break
      case 'pull_request':
        await handlePREvent(projectId, payload)
        break
      case 'pull_request_review':
        await handlePRReviewEvent(projectId, payload)
        break
    }
  })
}

async function handlePushEvent(projectId: string, payload: any): Promise<void> {
  const branch = payload.ref.replace('refs/heads/', '')
  const commits: Array<{ message: string }> = payload.commits

  if (branch === 'main') return

  await postSystemMessage(projectId, {
    content:
      `${branch} 브랜치에 ${commits.length}개 커밋이 푸시됐습니다.\n` +
      commits.map(c => `  - ${c.message}`).join('\n'),
  })
}

async function handlePREvent(projectId: string, payload: any): Promise<void> {
  const action = payload.action  // opened, closed, merged, ...
  const pr = payload.pull_request

  if (action === 'opened') {
    await postSystemMessage(projectId, {
      content:
        `PR #${pr.number} "${pr.title}" 이 열렸습니다.\n` +
        `${pr.head.ref} → ${pr.base.ref} | +${pr.additions} -${pr.deletions}\n` +
        `🔗 ${pr.html_url}`,
    })
  } else if (action === 'closed' && pr.merged) {
    await postSystemMessage(projectId, {
      content: `PR #${pr.number} "${pr.title}" 이 머지됐습니다.`,
    })
  }
}
```

### 6.2 PR 상태 변경 감지

GitHub Webhook 미사용 시 폴링 방식으로 PR 상태를 주기적으로 확인한다.

```typescript
// packages/server/src/git/pr-poller.ts

export class PRStatusPoller {
  private intervalMs = 30_000  // 30초 간격

  start(projectId: string): NodeJS.Timeout {
    return setInterval(async () => {
      await this.checkPRStatuses(projectId)
    }, this.intervalMs)
  }

  private async checkPRStatuses(projectId: string): Promise<void> {
    const openPRs = await getOpenPRsFromFirestore(projectId)

    for (const pr of openPRs) {
      if (!pr.githubPrNumber) continue

      const gitConfig = await getGitConfig(projectId)
      const [owner, repo] = extractOwnerRepo(gitConfig.repoUrl)
      const octokit = new Octokit({ auth: decrypt(gitConfig.githubToken) })

      const { data: ghPR } = await octokit.pulls.get({
        owner,
        repo,
        pull_number: pr.githubPrNumber,
      })

      const newStatus = mapGHStatusToInternal(ghPR.state, ghPR.merged)
      if (newStatus !== pr.status) {
        await updatePRStatus(projectId, pr.id, newStatus)
        await postStatusChangeMessage(projectId, pr, newStatus)
      }
    }
  }
}
```

### 6.3 Council Room 자동 시스템 메시지 규격

Git 이벤트에서 생성되는 시스템 메시지의 형식:

```typescript
// Firestore: rooms/{roomId}/messages/{msgId}
{
  senderId: 'system',
  senderName: '시스템',
  senderType: 'system',
  content: string,          // 아래 템플릿 참조
  metadata: {
    eventType: 'commit' | 'pr_created' | 'pr_merged' | 'rebase_conflict' | 'rebase_success',
    commitHash?: string,
    pullRequestUrl?: string,
    conflictFiles?: string[],
    conflictSetId?: string,
  },
  timestamp: Timestamp,
}
```

**메시지 템플릿:**

| 이벤트 | 메시지 형식 |
|---|---|
| 커밋 푸시 | `Set {name}가 {branch}에 {N}개 커밋을 푸시했습니다.\n  - {commit msg 1}\n  - {commit msg 2}` |
| PR 생성 | `PR #{num} "{title}" 이 생성됐습니다.\n{src} → {dst} \| +{add} -{del} \| 파일 {N}개\n🔗 {url}` |
| PR 머지 | `PR #{num} "{title}" 이 main에 머지됐습니다.\nSet {a}, {b} worktree 자동 rebase 중...` |
| rebase 성공 | `✅ {Set name}: rebase 성공` |
| rebase 충돌 | `⚠️ {Set name}: rebase 충돌 발생\n충돌 파일:\n  - {file1}\n  - {file2}` |

---

## 7. GitHub API 연동

### 7.1 인증 (PAT 토큰)

GitHub Personal Access Token(PAT)을 사용하며, 프로젝트 Git 설정에 암호화하여 저장한다.

**필요 스코프:**

```
repo          ← PR 생성, 머지, 코드 읽기
read:org      ← 조직 리포지토리 접근 (필요 시)
```

**저장 및 사용:**

```typescript
// 저장 (프로젝트 설정 시)
await db.collection('projects').doc(projectId)
  .collection('git').doc('config')
  .update({
    githubToken: encrypt(patToken),   // AES-256 암호화
    isRemote: true,
    repoUrl: 'https://github.com/org/repo',
  })

// 사용 (API 호출 시)
const gitConfig = (await gitConfigDoc.get()).data()!
const octokit = new Octokit({
  auth: decrypt(gitConfig.githubToken),   // 메모리에서만 복호화
})
```

### 7.2 주요 API 엔드포인트

```typescript
// PR 생성
const { data: pr } = await octokit.pulls.create({
  owner, repo,
  title: 'feat: 채팅 API 구현',
  body: '## 변경 사항\n- ChatController 구현\n- WebSocket STOMP 핸들러',
  head: 'set-b/backend',
  base: 'main',
})

// PR 목록 조회
const { data: prs } = await octokit.pulls.list({
  owner, repo,
  state: 'open',
  base: 'main',
})

// PR 머지
await octokit.pulls.merge({
  owner, repo,
  pull_number: 3,
  merge_method: 'merge',   // 'merge' | 'squash' | 'rebase'
  commit_title: 'feat: 채팅 API (#3)',
})

// PR에 코멘트 추가
await octokit.issues.createComment({
  owner, repo,
  issue_number: 3,
  body: 'QA 리뷰: 입력 검증 추가 필요 (line 45)',
})

// 브랜치 보호 설정
await octokit.repos.updateBranchProtection({
  owner, repo,
  branch: 'main',
  required_pull_request_reviews: { required_approving_review_count: 1 },
  restrictions: null,
  enforce_admins: false,
  required_status_checks: null,
  required_linear_history: false,
  allow_force_pushes: false,
  allow_deletions: false,
})
```

### 7.3 로컬 전용 모드 (GitHub 미연동)

`isRemote: false`인 경우 GitHub API 없이 로컬 Git 명령어만 사용한다. PR 개념 대신 "머지 요청"을 Council 대화 레벨에서만 관리하며, Firestore `pullRequests` 컬렉션에 `githubPrNumber: null`로 저장한다.

```typescript
// 로컬 머지 (PR 없이)
export async function mergeLocalBranch(
  projectId: string,
  sourceBranch: string
): Promise<void> {
  const mainPath = getWorktreePath(projectId, 'main')
  await execAsync(`git -C ${mainPath} merge ${sourceBranch} --no-ff -m "Merge ${sourceBranch}"`)
}
```

---

## 8. 에러 케이스

### 8.1 Rebase 실패 (충돌)

| 상태 | 처리 |
|---|---|
| 자동 rebase 중 충돌 감지 | `git rebase --abort` → Set 상태 `blocked` → Council 알림 |
| Set 리더가 수동 해결 | `git add` + `git rebase --continue` → Set 상태 복원 |
| 해결 불가능한 충돌 | Council Room에서 리더 간 합의 후 특정 변경을 버리거나 재작업 |

```typescript
// 수동 해결 완료 보고 처리
async function handleConflictResolved(projectId: string, setId: string): Promise<void> {
  await db
    .collection('projects').doc(projectId)
    .collection('sets').doc(setId)
    .update({ status: 'working' })

  await postSystemMessage(projectId, {
    content: `✅ Set ${setId}: 충돌 해결 완료. rebase 성공.`,
  })
}
```

### 8.2 대규모 충돌 (합의 필요)

충돌 파일이 10개를 초과하거나, 동일 파일에서 두 Set이 모두 대규모 변경을 가한 경우:

```
⚙️ 시스템: ⚠️ 대규모 충돌 감지 (14개 파일)
           이 충돌은 자동 해결이 어렵습니다.
           관련 Set 리더들의 합의가 필요합니다.
           [Set B 리더 + Set C 리더 간 직접 조율을 권장합니다]

🟢 백엔드: 제 쪽 변경사항을 먼저 설명드리겠습니다...
🔵 프론트: 저희 쪽은 이 부분을 이렇게 수정했는데...

---합의 후---

🟢 백엔드: 제 PR을 일부 롤백하고 Set C 기준으로 맞추겠습니다.
👤 PM: 좋아요. Set B PR을 닫고 수정 후 재제출해주세요.
```

대규모 충돌 임계값 설정:

```typescript
const LARGE_CONFLICT_THRESHOLD = {
  files: 10,          // 충돌 파일 10개 초과
  lines: 200,         // 충돌 라인 200줄 초과
}
```

### 8.3 GitHub API 권한 문제

```typescript
async function safeGithubCall<T>(
  fn: () => Promise<T>,
  projectId: string,
  operation: string
): Promise<T | null> {
  try {
    return await fn()
  } catch (err: any) {
    if (err.status === 401) {
      await postSystemMessage(projectId, {
        content: `⚠️ GitHub 인증 실패: PAT 토큰이 만료되었거나 권한이 없습니다.\n` +
                 `프로젝트 설정에서 GitHub 토큰을 갱신해주세요.`,
      })
    } else if (err.status === 403) {
      await postSystemMessage(projectId, {
        content: `⚠️ GitHub 권한 부족: ${operation} 작업에 필요한 권한이 없습니다.\n` +
                 `PAT 토큰의 스코프를 확인해주세요. (필요: repo)`,
      })
    } else if (err.status === 422) {
      await postSystemMessage(projectId, {
        content: `⚠️ GitHub API 오류: ${err.message}\n` +
                 `브랜치가 최신 상태인지, PR이 이미 머지/닫힌 상태가 아닌지 확인하세요.`,
      })
    } else {
      await postSystemMessage(projectId, {
        content: `⚠️ GitHub API 오류 (${operation}): ${err.message}`,
      })
    }
    return null
  }
}
```

### 8.4 Worktree 생성 실패

```typescript
export async function createSetWorktreeWithRetry(
  projectId: string,
  setId: string,
  branchName: string,
  maxRetries = 3
): Promise<string> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await createSetWorktree(projectId, setId, branchName)
    } catch (err: any) {
      // 이미 체크아웃된 브랜치
      if (err.message.includes('already checked out')) {
        // 기존 worktree 제거 후 재생성
        await removeStaleWorktree(projectId, setId)
        continue
      }
      // 디렉토리 이미 존재
      if (err.message.includes('already exists')) {
        await execAsync(`rm -rf ${getWorktreePath(projectId, setId)}`)
        continue
      }
      if (attempt === maxRetries) throw err
    }
  }
  throw new Error(`Worktree 생성 실패: ${maxRetries}회 시도 후 포기`)
}
```

### 8.5 에러 케이스 요약

| 에러 상황 | 자동 처리 | PM/리더 개입 필요 |
|---|---|---|
| rebase 소규모 충돌 (1~9개 파일) | abort + Council 알림 | Set 리더 수동 해결 |
| rebase 대규모 충돌 (10개+ 파일) | abort + 대규모 충돌 경고 | 관련 Set 리더 간 합의 |
| GitHub PAT 만료 | 에러 메시지 게시 | PM이 토큰 갱신 |
| GitHub 403 권한 부족 | 에러 메시지 게시 | PM이 PAT 스코프 수정 |
| worktree 생성 실패 | 3회 자동 재시도 | 재시도 실패 시 PM 알림 |
| PR 머지 불가 (리뷰 미충족) | 에러 메시지 게시 | 리더들이 리뷰 완료 후 재시도 |
| 로컬 repo 손상 | Council 알림 | PM이 repo 재클론 지시 |

---

## 관련 문서

- `PLAN.md` § 3.1 Git 워크플로우
- `PLAN.md` § 3.2 코드 리뷰 & 머지 프로세스
- `PLAN.md` § 7.4 Git 이벤트 → Council 알림
- `02_데이터설계/` — Firestore `pullRequests`, `sets` 컬렉션 스키마
- `03_API설계/` — Council Server Git 관련 REST/WebSocket API
- `06_구현가이드/` — 서버 Git 모듈 구현 순서
- `../00_설정_참조표.md` — 워크스페이스 경로, Git worktree 구조, 전역 설정값 단일 출처
