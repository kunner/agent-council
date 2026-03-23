---
status: DRAFT
priority: 3
last_updated: 2026-03-23
---

# Firestore Security Rules 상세 설계

## 목차

1. [개요](#1-개요)
2. [전체 Security Rules 코드 (완성본)](#2-전체-security-rules-코드-완성본)
3. [Helper 함수](#3-helper-함수)
4. [규칙별 상세 설명](#4-규칙별-상세-설명)
5. [접근 제어 매트릭스](#5-접근-제어-매트릭스)
6. [Server-side vs Client-side 접근 차이](#6-server-side-vs-client-side-접근-차이)
7. [테스트 케이스 (Firebase Rules Emulator)](#7-테스트-케이스-firebase-rules-emulator)
8. [보안 고려사항](#8-보안-고려사항)

---

## 1. 개요

Agent Council의 Firestore Security Rules는 두 가지 핵심 원칙으로 설계되었다.

**원칙 1 — 소유권 기반 격리**
모든 프로젝트(`projects/{projectId}`)는 `ownerId` 필드로 소유자를 식별한다.
프로젝트와 그 하위 데이터(rooms, sets, tasks 등)는 오직 소유자만 쓰기(create/update/delete)할 수 있다.
다른 사용자가 타인의 프로젝트 데이터를 읽거나 수정하는 것을 원천 차단한다.

**원칙 2 — 인증 필수**
로그인하지 않은 익명 사용자는 어떤 컬렉션도 읽을 수 없다.
Firebase Auth를 통해 인증된 사용자만 데이터에 접근할 수 있다.

**Admin SDK 우선 쓰기**
AI 리더 메시지, Set 상태 업데이트, 태스크 자동 변경 등 서버 주도 쓰기는
Council Server에서 Firebase Admin SDK로 수행하므로 Security Rules를 우회한다.
클라이언트(브라우저)는 **PM 메시지를 Firestore에 직접 쓰며**, 프로젝트 생성·태스크 수동 생성/수정도 클라이언트가 담당한다. 그 외 쓰기는 Admin SDK 전용이다.

---

## 2. 전체 Security Rules 코드 (완성본)

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // ────────────────────────────────────────────────────────────
    // Helper 함수
    // ────────────────────────────────────────────────────────────

    // 현재 요청이 인증된 사용자인지 확인
    function isAuthenticated() {
      return request.auth != null;
    }

    // 현재 인증된 사용자 UID가 대상 UID와 일치하는지 확인
    function isOwner(uid) {
      return isAuthenticated() && request.auth.uid == uid;
    }

    // 현재 사용자가 해당 프로젝트의 소유자인지 확인 (Firestore get() 사용)
    function isProjectOwner(projectId) {
      return isAuthenticated()
        && get(/databases/$(database)/documents/projects/$(projectId)).data.ownerId
           == request.auth.uid;
    }

    // 새 문서 생성 시, 제출된 데이터의 ownerId가 현재 사용자 UID와 일치하는지 확인
    function isCreatingAsOwner() {
      return isAuthenticated()
        && request.resource.data.ownerId == request.auth.uid;
    }

    // ────────────────────────────────────────────────────────────
    // users/{userId}
    // 사용자 프로필 및 API 키 정보
    // ────────────────────────────────────────────────────────────
    match /users/{userId} {
      // 자신의 프로필만 읽기/쓰기 가능
      allow read, write: if isOwner(userId);
    }

    // ────────────────────────────────────────────────────────────
    // projects/{projectId}
    // 프로젝트 최상위 문서
    // ────────────────────────────────────────────────────────────
    match /projects/{projectId} {
      // 읽기: 해당 프로젝트의 소유자만 허용
      allow read: if isAuthenticated()
        && resource.data.ownerId == request.auth.uid;

      // 생성: ownerId가 현재 사용자 UID와 일치해야 함
      allow create: if isCreatingAsOwner();

      // 수정/삭제: 소유자만 허용
      allow update, delete: if isAuthenticated()
        && resource.data.ownerId == request.auth.uid;

      // ── git/{docId}: Git 연동 설정 ──────────────────────────
      match /git/{docId} {
        allow read, write: if isProjectOwner(projectId);
      }

      // ── rooms/{roomId}: Council Room ────────────────────────
      match /rooms/{roomId} {
        // Room 자체(생성/수정/삭제/읽기)는 프로젝트 소유자만
        allow read, write: if isProjectOwner(projectId);

        // messages/{messageId}: 메시지
        match /messages/{messageId} {
          // 읽기: 프로젝트 소유자만 (타인의 채팅 내용 차단)
          allow read: if isProjectOwner(projectId);

          // 생성: 프로젝트 소유자만, 수정/삭제 불가
          // (메시지는 불변성을 유지해야 대화 히스토리 신뢰성 보장)
          allow create: if isProjectOwner(projectId);
          allow update, delete: if false;
        }
      }

      // ── sets/{setId}: Agent Set ──────────────────────────────
      match /sets/{setId} {
        // Set 읽기: 프로젝트 소유자만
        allow read: if isProjectOwner(projectId);

        // Set 쓰기: 프로젝트 소유자만
        // (Set 생성/수정/삭제는 소유자 또는 Admin SDK만)
        allow write: if isProjectOwner(projectId);

        // logs/{logId}: Set 내부 작업 로그
        match /logs/{logId} {
          // 로그 읽기: 프로젝트 소유자만
          allow read: if isProjectOwner(projectId);

          // 로그 생성: 프로젝트 소유자만, 수정/삭제 불가
          // (로그는 감사 추적을 위해 불변)
          allow create: if isProjectOwner(projectId);
          allow update, delete: if false;
        }
      }

      // ── tasks/{taskId}: 태스크 보드 ──────────────────────────
      match /tasks/{taskId} {
        // 읽기: 프로젝트 소유자만
        allow read: if isProjectOwner(projectId);

        // 쓰기: 프로젝트 소유자만
        // (태스크 생성, 상태 변경, 담당 Set 변경 모두 소유자 권한)
        allow write: if isProjectOwner(projectId);
      }

      // ── pullRequests/{prId}: PR 추적 ─────────────────────────
      match /pullRequests/{prId} {
        // 읽기: 프로젝트 소유자만
        allow read: if isProjectOwner(projectId);

        // 쓰기: 프로젝트 소유자만
        allow write: if isProjectOwner(projectId);
      }

      // ── snapshots/{snapshotId}: 프로젝트 상태 스냅샷 ─────────
      match /snapshots/{snapshotId} {
        // 읽기: 프로젝트 소유자만
        allow read: if isProjectOwner(projectId);

        // 생성: 프로젝트 소유자만, 수정/삭제 불가
        // (스냅샷은 시점 기록이므로 변경 금지)
        allow create: if isProjectOwner(projectId);
        allow update, delete: if false;
      }
    }

    // ────────────────────────────────────────────────────────────
    // usage/{userId}: 토큰 사용량 추적
    // ────────────────────────────────────────────────────────────
    match /usage/{userId} {
      // 자신의 사용량 데이터만 읽기 허용
      allow read: if isOwner(userId);

      // 쓰기는 Admin SDK(서버)에서만 수행 — 클라이언트 쓰기 차단
      allow write: if false;

      match /monthly/{yearMonth} {
        allow read: if isOwner(userId);
        allow write: if false;
      }
    }
  }
}
```

---

## 3. Helper 함수

Security Rules 내에 4개의 Helper 함수를 정의하여 규칙 중복을 제거하고 의도를 명확히 한다.

### 3.1 `isAuthenticated()`

```javascript
function isAuthenticated() {
  return request.auth != null;
}
```

**목적**: Firebase Auth로 로그인된 사용자인지 확인하는 기본 게이트.
`request.auth`는 Firebase Auth 토큰에서 추출된 인증 컨텍스트다.
로그인하지 않은 경우 `null`이므로, 모든 규칙의 선행 조건으로 사용한다.

**사용 위치**: `isOwner()`, `isProjectOwner()`, `isCreatingAsOwner()` 내부에서 호출됨.

---

### 3.2 `isOwner(uid)`

```javascript
function isOwner(uid) {
  return isAuthenticated() && request.auth.uid == uid;
}
```

**목적**: 현재 요청자의 UID가 특정 UID와 일치하는지 확인.
`users/{userId}` 컬렉션처럼 문서 경로의 와일드카드 변수가 곧 소유자 UID인 경우에 사용한다.

**사용 위치**: `users/{userId}`, `usage/{userId}` 규칙.

**예시**:
- `users/alice123` 문서에 접근 시 → `isOwner("alice123")` → `request.auth.uid == "alice123"` 인지 확인

---

### 3.3 `isProjectOwner(projectId)`

```javascript
function isProjectOwner(projectId) {
  return isAuthenticated()
    && get(/databases/$(database)/documents/projects/$(projectId)).data.ownerId
       == request.auth.uid;
}
```

**목적**: 현재 요청자가 해당 프로젝트의 소유자인지 확인.
Firestore `get()` 함수를 사용해 상위 문서의 `ownerId` 필드를 동적으로 조회한다.

**사용 위치**: `projects/{projectId}` 하위 모든 서브컬렉션 규칙.

**비용 주의**: `get()`은 추가 Firestore 읽기 비용을 발생시킨다.
각 서브컬렉션 접근 시 1회의 추가 읽기가 발생하므로,
Spark 플랜의 일 50K 읽기 한도를 감안하여 서버 측 Admin SDK 사용을 기본으로 한다.

**보안 이점**: 클라이언트가 `projectId`를 임의로 조작해도 서버에서
해당 프로젝트의 실제 `ownerId`를 검증하므로 권한 우회가 불가능하다.

---

### 3.4 `isCreatingAsOwner()`

```javascript
function isCreatingAsOwner() {
  return isAuthenticated()
    && request.resource.data.ownerId == request.auth.uid;
}
```

**목적**: 새 문서를 생성할 때, 생성자가 `ownerId`를 자신의 UID로만 설정할 수 있도록 강제.
`request.resource.data`는 생성/수정 요청에서 제출된 신규 데이터다.
클라이언트가 `ownerId: "다른사용자UID"` 로 프로젝트를 생성하는 것을 차단한다.

**사용 위치**: `projects/{projectId}` 의 `create` 규칙.

---

## 4. 규칙별 상세 설명

### 4.1 `users/{userId}` — 사용자 프로필

```javascript
match /users/{userId} {
  allow read, write: if isOwner(userId);
}
```

**설계 이유**:
사용자 문서에는 `displayName`, `email`, `photoURL` 외에
`apiKeyEncrypted` (AES-256 암호화된 Anthropic API 키)가 저장된다.
API 키는 매우 민감한 정보이므로, 본인 외에는 절대 읽거나 수정할 수 없어야 한다.

경로의 `{userId}` 와일드카드가 곧 소유자 UID이므로
`isOwner(userId)`로 간결하게 본인 여부를 검증한다.

**제한 사항**:
- 다른 사용자의 프로필(이름, 아바타)조차 읽을 수 없다. 현재 Agent Council은 단일 사용자 시나리오이므로 이 제약이 적합하다. 향후 협업 기능 추가 시 `read` 규칙을 완화할 수 있다.

---

### 4.2 `projects/{projectId}` — 프로젝트 최상위

```javascript
match /projects/{projectId} {
  allow read: if isAuthenticated()
    && resource.data.ownerId == request.auth.uid;
  allow create: if isCreatingAsOwner();
  allow update, delete: if isAuthenticated()
    && resource.data.ownerId == request.auth.uid;
```

**설계 이유**:
프로젝트 읽기와 수정은 `resource.data.ownerId`(기존 문서의 소유자)를 직접 비교한다.
서브컬렉션과 달리 최상위 문서는 `get()`을 사용하지 않고 `resource.data`로 직접 접근 가능하므로
추가 읽기 비용이 발생하지 않는다.

`create` 시에는 `resource.data`가 아직 존재하지 않으므로
`request.resource.data`(제출 데이터)에서 `ownerId`를 검증하는 `isCreatingAsOwner()`를 사용한다.

**프로젝트 목록 조회 문제**:
Security Rules는 컬렉션 전체에 대한 필터 역할을 하지 않는다.
클라이언트에서 "내 프로젝트만 가져오기" 쿼리를 실행할 때는 반드시
`where('ownerId', '==', currentUser.uid)` 조건을 포함해야 하며,
해당 쿼리의 결과가 Rules와 일치해야 한다.

---

### 4.3 `projects/{projectId}/git/{docId}` — Git 연동 설정

```javascript
match /git/{docId} {
  allow read, write: if isProjectOwner(projectId);
}
```

**설계 이유**:
Git 설정 문서에는 `githubTokenEncrypted` (AES-256으로 암호화된 GitHub PAT)이 저장된다.
GitHub 토큰이 유출되면 해당 저장소에 대한 무제한 쓰기 권한을 탈취당할 수 있으므로
프로젝트 소유자만 접근 가능하도록 엄격히 제한한다.

---

### 4.4 `rooms/{roomId}/messages/{messageId}` — 채팅 메시지

```javascript
match /messages/{messageId} {
  allow read: if isProjectOwner(projectId);
  allow create: if isProjectOwner(projectId);
  allow update, delete: if false;
}
```

**설계 이유**:
메시지의 **불변성**이 핵심이다. Council 대화 기록은 의사결정의 감사 추적이므로
한번 기록된 메시지를 수정하거나 삭제할 수 없어야 한다.

`update, delete: if false`는 Admin SDK를 통한 서버 측 접근도 차단하는 것처럼 보이지만,
**Admin SDK는 Security Rules를 완전히 우회**하므로 실제로는 서버에서 삭제 가능하다.
이 규칙은 클라이언트(브라우저)의 직접 수정/삭제를 차단하는 용도다.

실제 메시지 생성은 주로 Admin SDK(Council Server)가 담당하지만,
클라이언트에서 직접 생성하는 경우(PM의 메시지)도 허용하기 위해 `create`를 열어두었다.

---

### 4.5 `sets/{setId}` 및 `sets/{setId}/logs/{logId}` — Agent Set

```javascript
match /sets/{setId} {
  allow read: if isProjectOwner(projectId);
  allow write: if isProjectOwner(projectId);

  match /logs/{logId} {
    allow read: if isProjectOwner(projectId);
    allow create: if isProjectOwner(projectId);
    allow update, delete: if false;
  }
}
```

**설계 이유**:
Set 상태(`idle`, `working`, `done` 등)와 내부 로그는 프로젝트 소유자에게만 표시된다.
로그는 메시지와 마찬가지로 감사 추적 목적으로 불변성을 유지한다.

실제 Set 생성 및 상태 업데이트는 Admin SDK를 통한 서버 측 작업이
주를 이루므로, 클라이언트 쓰기 권한은 최소화한다.

---

### 4.6 `tasks/{taskId}` — 태스크 보드

```javascript
match /tasks/{taskId} {
  allow read: if isProjectOwner(projectId);
  allow write: if isProjectOwner(projectId);
}
```

**설계 이유**:
태스크는 PM이 직접 생성하거나 Council 대화에서 추출하여 생성하므로
클라이언트 쓰기도 허용한다. 단, 프로젝트 소유자로 제한하여
타인이 태스크를 조작하거나 완료 처리하는 것을 차단한다.

태스크 상태 전환(`backlog` → `in_progress` → `done`)은 보안 측면에서
소유자 본인만 수행할 수 있다는 점이 중요하다.

---

### 4.7 `pullRequests/{prId}` — PR 추적

```javascript
match /pullRequests/{prId} {
  allow read: if isProjectOwner(projectId);
  allow write: if isProjectOwner(projectId);
}
```

**설계 이유**:
PR 추적 문서에는 `githubPrUrl`, `reviewNotes`, 승인 상태 등이 포함된다.
PR 머지 등의 중요 작업은 Admin SDK를 통해 서버에서 수행하지만,
클라이언트에서 리뷰 노트를 추가하는 시나리오도 지원하기 위해
소유자 쓰기 권한을 유지한다.

---

### 4.8 `snapshots/{snapshotId}` — 프로젝트 상태 스냅샷

```javascript
match /snapshots/{snapshotId} {
  allow read: if isProjectOwner(projectId);
  allow create: if isProjectOwner(projectId);
  allow update, delete: if false;
}
```

**설계 이유**:
스냅샷은 특정 시점의 프로젝트 상태를 기록한 불변 문서다.
세션 복원 시 이 스냅샷을 읽어 Claude Code 세션에 컨텍스트를 주입하므로,
스냅샷이 변조되면 AI 리더가 잘못된 컨텍스트로 작업할 위험이 있다.
`update, delete: if false`로 클라이언트의 사후 수정을 원천 차단한다.

---

### 4.9 `usage/{userId}` — 토큰 사용량

```javascript
match /usage/{userId} {
  allow read: if isOwner(userId);
  allow write: if false;

  match /monthly/{yearMonth} {
    allow read: if isOwner(userId);
    allow write: if false;
  }
}
```

**설계 이유**:
토큰 사용량은 과금 및 비용 추적에 직결되므로 클라이언트가 임의로 수정할 수 없어야 한다.
`write: if false`로 클라이언트 쓰기를 완전히 차단하고,
Admin SDK를 통한 서버 측 업데이트만 허용한다.
자신의 사용량은 설정 화면에서 확인할 수 있도록 `read`는 본인에게 허용한다.

---

## 5. 접근 제어 매트릭스

아래 표는 각 사용자 유형별로 각 컬렉션에 대한 읽기(R)/쓰기(W)/생성(C)/삭제(D) 권한을 정리한다.

> 범례: O = 허용, X = 차단, (S) = Admin SDK만 허용

### 5.1 미인증 사용자 (Anonymous)

| 컬렉션 | 읽기 | 생성 | 수정 | 삭제 |
|---|:---:|:---:|:---:|:---:|
| `users/{userId}` | X | X | X | X |
| `projects/{projectId}` | X | X | X | X |
| `projects/.../git` | X | X | X | X |
| `projects/.../rooms` | X | X | X | X |
| `projects/.../messages` | X | X | X | X |
| `projects/.../sets` | X | X | X | X |
| `projects/.../sets/.../logs` | X | X | X | X |
| `projects/.../tasks` | X | X | X | X |
| `projects/.../pullRequests` | X | X | X | X |
| `projects/.../snapshots` | X | X | X | X |
| `usage/{userId}` | X | X | X | X |

**결론**: 미인증 사용자는 모든 데이터에 접근 불가.

---

### 5.2 인증된 사용자 — 본인 프로젝트 소유자

| 컬렉션 | 읽기 | 생성 | 수정 | 삭제 |
|---|:---:|:---:|:---:|:---:|
| `users/{자신의 userId}` | O | O | O | O |
| `projects/{자신의 projectId}` | O | O | O | O |
| `projects/{자신의}/git` | O | O | O | O |
| `projects/{자신의}/rooms` | O | O | O | O |
| `projects/{자신의}/messages` | O | O | X (불변) | X (불변) |
| `projects/{자신의}/sets` | O | O | O | O |
| `projects/{자신의}/sets/logs` | O | O | X (불변) | X (불변) |
| `projects/{자신의}/tasks` | O | O | O | O |
| `projects/{자신의}/pullRequests` | O | O | O | O |
| `projects/{자신의}/snapshots` | O | O | X (불변) | X (불변) |
| `usage/{자신의 userId}` | O | X (S) | X (S) | X (S) |

---

### 5.3 인증된 사용자 — 타인의 프로젝트

| 컬렉션 | 읽기 | 생성 | 수정 | 삭제 |
|---|:---:|:---:|:---:|:---:|
| `users/{타인의 userId}` | X | X | X | X |
| `projects/{타인의 projectId}` | X | X | X | X |
| `projects/{타인의}/git` | X | X | X | X |
| `projects/{타인의}/rooms` | X | X | X | X |
| `projects/{타인의}/messages` | X | X | X | X |
| `projects/{타인의}/sets` | X | X | X | X |
| `projects/{타인의}/sets/logs` | X | X | X | X |
| `projects/{타인의}/tasks` | X | X | X | X |
| `projects/{타인의}/pullRequests` | X | X | X | X |
| `projects/{타인의}/snapshots` | X | X | X | X |

**결론**: 인증된 사용자라도 타인의 데이터에는 일절 접근 불가.

---

### 5.4 Council Server (Admin SDK)

Admin SDK는 Security Rules를 완전히 우회한다.
서버는 모든 컬렉션에 대해 모든 작업을 수행할 수 있다.

| 작업 유형 | 담당 주체 |
|---|---|
| 메시지 생성 (AI 리더 응답, 시스템 알림) | Council Server (Admin SDK) |
| Set 상태 업데이트 (`idle` → `working`) | Council Server (Admin SDK) |
| 로그 생성 (Set 내부 작업 로그) | Council Server (Admin SDK) |
| 스냅샷 생성 (30분 주기, 이벤트 기반) | Council Server (Admin SDK) |
| 토큰 사용량 업데이트 | Council Server (Admin SDK) |
| PR 생성/상태 업데이트 | Council Server (Admin SDK) |
| 태스크 상태 변경 (Set 완료 보고 시) | Council Server (Admin SDK) |
| 프로젝트 생성 | 클라이언트 (Rules 적용) |
| PM 메시지 전송 | 클라이언트 (Rules 적용) |
| 태스크 수동 생성/수정 | 클라이언트 (Rules 적용) |

---

## 6. Server-side vs Client-side 접근 차이

### 6.1 Firebase Admin SDK (서버 측)

Council Server(`packages/server`)에서 사용하는 Admin SDK는 Security Rules를 완전히 우회한다.
이는 의도적인 설계로, 서버 프로세스가 신뢰할 수 있는 실행 환경(Oracle Ampere)에서 동작하기 때문이다.

```typescript
// packages/server/src/firebase/admin.ts
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

// 서비스 계정 키 또는 환경변수로 초기화
const app = initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
})

export const adminDb = getFirestore(app)

// Admin SDK 사용 예 — Security Rules 우회
// AI 리더 메시지 저장
async function saveLeaderMessage(
  projectId: string,
  roomId: string,
  content: string,
  setId: string,
) {
  await adminDb
    .collection('projects')
    .doc(projectId)
    .collection('rooms')
    .doc(roomId)
    .collection('messages')
    .add({
      senderId: setId,
      senderName: '백엔드팀 리더',
      senderType: 'leader',
      content,
      timestamp: new Date(),
    })
}

// Admin SDK로 토큰 사용량 업데이트 (클라이언트 write: false 우회)
async function updateTokenUsage(userId: string, projectId: string, tokens: number) {
  const yearMonth = new Date().toISOString().slice(0, 7) // "2026-03"
  await adminDb
    .collection('usage')
    .doc(userId)
    .collection('monthly')
    .doc(yearMonth)
    .set(
      {
        totalTokens: tokens,
        byProject: { [projectId]: tokens },
      },
      { merge: true },
    )
}
```

**Admin SDK가 담당하는 주요 쓰기 작업:**
- AI 리더 메시지, 시스템 알림 메시지 저장
- Set 상태 업데이트 (`idle` ↔ `working` ↔ `done`)
- Set 내부 로그 생성
- 프로젝트 상태 스냅샷 자동 생성
- 토큰 사용량 집계 및 업데이트
- PR 생성/상태 변경
- 태스크 자동 상태 전환

---

### 6.2 Firebase Client SDK (브라우저 측)

클라이언트(React SPA)는 Security Rules가 적용된 환경에서 동작한다.
주로 읽기 및 실시간 리스너에 집중하고, 쓰기는 최소화한다.

```typescript
// packages/web/src/firebase/client.ts
import { initializeApp } from 'firebase/app'
import {
  getFirestore,
  collection,
  query,
  orderBy,
  onSnapshot,
  addDoc,
  serverTimestamp,
} from 'firebase/firestore'
import { getAuth } from 'firebase/auth'

const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
})

export const clientDb = getFirestore(app)
export const auth = getAuth(app)

// 실시간 메시지 구독 (Rules: isProjectOwner(projectId) 검증)
export function subscribeToMessages(
  projectId: string,
  roomId: string,
  onMessage: (msg: Message) => void,
) {
  const messagesRef = collection(
    clientDb,
    `projects/${projectId}/rooms/${roomId}/messages`,
  )
  const q = query(messagesRef, orderBy('timestamp'))

  return onSnapshot(q, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === 'added') {
        onMessage({ id: change.doc.id, ...change.doc.data() } as Message)
      }
    })
  })
}

// PM 메시지 전송 (Rules: create 허용 — isProjectOwner 검증 통과)
export async function sendHumanMessage(
  projectId: string,
  roomId: string,
  content: string,
  userId: string,
  displayName: string,
) {
  const messagesRef = collection(
    clientDb,
    `projects/${projectId}/rooms/${roomId}/messages`,
  )
  await addDoc(messagesRef, {
    senderId: userId,
    senderName: displayName,
    senderType: 'human',
    content,
    timestamp: serverTimestamp(),
  })
}

// 태스크 생성 (Rules: write 허용 — isProjectOwner 검증 통과)
export async function createTask(projectId: string, task: Omit<Task, 'id'>) {
  const tasksRef = collection(clientDb, `projects/${projectId}/tasks`)
  return addDoc(tasksRef, {
    ...task,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
}
```

**클라이언트가 담당하는 쓰기 작업:**
- PM 메시지 전송
- 프로젝트 생성
- 태스크 수동 생성/수정
- 사용자 프로필 업데이트

---

### 6.3 접근 방식 결정 기준

| 판단 기준 | Admin SDK 사용 | Client SDK 사용 |
|---|---|---|
| 쓰기 주체 | Council Server 프로세스 (AI, 시스템) | PM (사람) 직접 조작 |
| 보안 민감도 | 높음 (토큰, 상태, 로그) | 낮음 (메시지 전송, 태스크 수정) |
| 불변성 필요 여부 | 필요 (로그, 스냅샷) | 불필요 (태스크 상태) |
| 실시간 구독 | 불필요 (서버 주도) | 필요 (UI 자동 업데이트) |

---

## 7. 테스트 케이스 (Firebase Rules Emulator)

Firebase Rules Emulator를 사용한 단위 테스트. `@firebase/rules-unit-testing` 라이브러리를 사용한다.

### 7.1 테스트 환경 설정

```typescript
// tests/firestore.rules.test.ts
import {
  initializeTestEnvironment,
  RulesTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing'
import { readFileSync } from 'fs'
import {
  doc,
  getDoc,
  setDoc,
  addDoc,
  collection,
  deleteDoc,
  updateDoc,
} from 'firebase/firestore'

let testEnv: RulesTestEnvironment

const RULES_PATH = '../../firebase/firestore.rules'

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'agent-council-test',
    firestore: {
      rules: readFileSync(RULES_PATH, 'utf8'),
      host: 'localhost',
      port: 8080,
    },
  })
})

afterAll(async () => {
  await testEnv.cleanup()
})

afterEach(async () => {
  await testEnv.clearFirestore()
})

// 헬퍼: 인증된 사용자 컨텍스트
function authedUser(uid: string) {
  return testEnv.authenticatedContext(uid)
}

// 헬퍼: 미인증 사용자 컨텍스트
function unauthUser() {
  return testEnv.unauthenticatedContext()
}

// 헬퍼: 테스트용 프로젝트 문서 사전 생성 (Admin SDK로)
async function seedProject(projectId: string, ownerId: string) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), `projects/${projectId}`), {
      name: '테스트 프로젝트',
      ownerId,
      status: 'planning',
      createdAt: new Date(),
    })
  })
}
```

---

### 7.2 테스트 케이스 1 — 인증된 사용자 접근 허용

```typescript
describe('인증된 사용자 — 본인 프로젝트 접근 허용', () => {
  const ALICE_UID = 'alice-001'
  const PROJECT_ID = 'project-alpha'

  beforeEach(async () => {
    await seedProject(PROJECT_ID, ALICE_UID)
  })

  test('자신의 프로젝트 문서를 읽을 수 있다', async () => {
    const alice = authedUser(ALICE_UID)
    await assertSucceeds(
      getDoc(doc(alice.firestore(), `projects/${PROJECT_ID}`))
    )
  })

  test('자신의 프로젝트에 Council Room을 생성할 수 있다', async () => {
    const alice = authedUser(ALICE_UID)
    await assertSucceeds(
      setDoc(
        doc(alice.firestore(), `projects/${PROJECT_ID}/rooms/room-001`),
        { name: '메인 회의실', status: 'active', createdAt: new Date() }
      )
    )
  })

  test('자신의 Council Room에 메시지를 생성할 수 있다', async () => {
    const alice = authedUser(ALICE_UID)
    await assertSucceeds(
      addDoc(
        collection(alice.firestore(), `projects/${PROJECT_ID}/rooms/room-001/messages`),
        {
          senderId: ALICE_UID,
          senderName: 'Alice',
          senderType: 'human',
          content: '안녕하세요',
          timestamp: new Date(),
        }
      )
    )
  })

  test('자신의 태스크를 생성하고 수정할 수 있다', async () => {
    const alice = authedUser(ALICE_UID)
    const taskRef = doc(alice.firestore(), `projects/${PROJECT_ID}/tasks/task-001`)

    await assertSucceeds(
      setDoc(taskRef, {
        title: 'DB 스키마 설계',
        status: 'backlog',
        priority: 'high',
        createdAt: new Date(),
      })
    )

    await assertSucceeds(
      updateDoc(taskRef, { status: 'in_progress' })
    )
  })

  test('자신의 사용량 데이터를 읽을 수 있다', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), `usage/${ALICE_UID}/monthly/2026-03`),
        { totalTokens: 5000 }
      )
    })

    const alice = authedUser(ALICE_UID)
    await assertSucceeds(
      getDoc(doc(alice.firestore(), `usage/${ALICE_UID}/monthly/2026-03`))
    )
  })
})
```

---

### 7.3 테스트 케이스 2 — 미인증 사용자 차단

```typescript
describe('미인증 사용자 — 모든 접근 차단', () => {
  const OWNER_UID = 'alice-001'
  const PROJECT_ID = 'project-alpha'

  beforeEach(async () => {
    await seedProject(PROJECT_ID, OWNER_UID)
  })

  test('미인증 사용자는 프로젝트를 읽을 수 없다', async () => {
    const anon = unauthUser()
    await assertFails(
      getDoc(doc(anon.firestore(), `projects/${PROJECT_ID}`))
    )
  })

  test('미인증 사용자는 프로젝트를 생성할 수 없다', async () => {
    const anon = unauthUser()
    await assertFails(
      setDoc(doc(anon.firestore(), 'projects/new-project'), {
        name: '해킹 프로젝트',
        ownerId: 'hacker',
        status: 'planning',
      })
    )
  })

  test('미인증 사용자는 메시지를 읽을 수 없다', async () => {
    const anon = unauthUser()
    await assertFails(
      getDoc(
        doc(anon.firestore(), `projects/${PROJECT_ID}/rooms/room-001/messages/msg-001`)
      )
    )
  })

  test('미인증 사용자는 사용자 프로필을 읽을 수 없다', async () => {
    const anon = unauthUser()
    await assertFails(
      getDoc(doc(anon.firestore(), `users/${OWNER_UID}`))
    )
  })
})
```

---

### 7.4 테스트 케이스 3 — 다른 사용자 프로젝트 접근 차단

```typescript
describe('인증된 사용자 — 타인의 프로젝트 접근 차단', () => {
  const ALICE_UID = 'alice-001'
  const BOB_UID = 'bob-002'
  const ALICE_PROJECT = 'project-alice'

  beforeEach(async () => {
    await seedProject(ALICE_PROJECT, ALICE_UID)
  })

  test('Bob은 Alice의 프로젝트를 읽을 수 없다', async () => {
    const bob = authedUser(BOB_UID)
    await assertFails(
      getDoc(doc(bob.firestore(), `projects/${ALICE_PROJECT}`))
    )
  })

  test('Bob은 Alice의 프로젝트를 수정할 수 없다', async () => {
    const bob = authedUser(BOB_UID)
    await assertFails(
      updateDoc(doc(bob.firestore(), `projects/${ALICE_PROJECT}`), {
        name: '탈취된 프로젝트',
      })
    )
  })

  test('Bob은 Alice의 메시지를 읽을 수 없다', async () => {
    const bob = authedUser(BOB_UID)
    await assertFails(
      getDoc(
        doc(
          bob.firestore(),
          `projects/${ALICE_PROJECT}/rooms/room-001/messages/msg-001`
        )
      )
    )
  })

  test('Bob은 Alice의 태스크를 생성할 수 없다', async () => {
    const bob = authedUser(BOB_UID)
    await assertFails(
      addDoc(collection(bob.firestore(), `projects/${ALICE_PROJECT}/tasks`), {
        title: '악의적 태스크',
        status: 'backlog',
      })
    )
  })

  test('Bob은 Alice의 Git 설정을 읽을 수 없다', async () => {
    const bob = authedUser(BOB_UID)
    await assertFails(
      getDoc(doc(bob.firestore(), `projects/${ALICE_PROJECT}/git/config`))
    )
  })

  test('Bob은 Alice의 사용자 프로필을 읽을 수 없다', async () => {
    const bob = authedUser(BOB_UID)
    await assertFails(
      getDoc(doc(bob.firestore(), `users/${ALICE_UID}`))
    )
  })

  test('ownerId를 자신의 UID로 위조하여 프로젝트 생성 시도 시 차단된다', async () => {
    // Bob이 Alice의 projectId 경로에 자신이 소유자인 문서를 생성 시도
    const bob = authedUser(BOB_UID)
    await assertFails(
      setDoc(doc(bob.firestore(), `projects/${ALICE_PROJECT}`), {
        name: '탈취 시도',
        ownerId: BOB_UID, // Bob 자신을 소유자로 위조
        status: 'planning',
      })
    )
  })
})
```

---

### 7.5 테스트 케이스 4 — 메시지 생성 허용, 수정/삭제 차단

```typescript
describe('메시지 불변성 보장', () => {
  const ALICE_UID = 'alice-001'
  const PROJECT_ID = 'project-alpha'
  const ROOM_ID = 'room-main'
  const MSG_ID = 'msg-001'

  beforeEach(async () => {
    await seedProject(PROJECT_ID, ALICE_UID)
    // 메시지 사전 생성 (Admin SDK로)
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), `projects/${PROJECT_ID}/rooms/${ROOM_ID}/messages/${MSG_ID}`),
        {
          senderId: ALICE_UID,
          senderType: 'human',
          content: '원본 메시지',
          timestamp: new Date(),
        }
      )
    })
  })

  test('소유자는 메시지를 생성할 수 있다', async () => {
    const alice = authedUser(ALICE_UID)
    await assertSucceeds(
      addDoc(
        collection(alice.firestore(), `projects/${PROJECT_ID}/rooms/${ROOM_ID}/messages`),
        {
          senderId: ALICE_UID,
          senderType: 'human',
          content: '새 메시지',
          timestamp: new Date(),
        }
      )
    )
  })

  test('소유자도 기존 메시지를 수정할 수 없다 (불변성)', async () => {
    const alice = authedUser(ALICE_UID)
    await assertFails(
      updateDoc(
        doc(alice.firestore(), `projects/${PROJECT_ID}/rooms/${ROOM_ID}/messages/${MSG_ID}`),
        { content: '수정된 내용' }
      )
    )
  })

  test('소유자도 메시지를 삭제할 수 없다 (불변성)', async () => {
    const alice = authedUser(ALICE_UID)
    await assertFails(
      deleteDoc(
        doc(alice.firestore(), `projects/${PROJECT_ID}/rooms/${ROOM_ID}/messages/${MSG_ID}`)
      )
    )
  })

  test('소유자도 스냅샷을 수정할 수 없다 (불변성)', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), `projects/${PROJECT_ID}/snapshots/snap-001`),
        { summary: '원본 스냅샷', createdAt: new Date() }
      )
    })

    const alice = authedUser(ALICE_UID)
    await assertFails(
      updateDoc(
        doc(alice.firestore(), `projects/${PROJECT_ID}/snapshots/snap-001`),
        { summary: '조작된 스냅샷' }
      )
    )
  })

  test('소유자도 사용량 데이터를 직접 수정할 수 없다', async () => {
    const alice = authedUser(ALICE_UID)
    await assertFails(
      setDoc(
        doc(alice.firestore(), `usage/${ALICE_UID}/monthly/2026-03`),
        { totalTokens: 0 } // 사용량을 0으로 초기화 시도
      )
    )
  })
})
```

---

### 7.6 테스트 실행 방법

```bash
# 1. Firebase Emulator 시작
firebase emulators:start --only firestore

# 2. 별도 터미널에서 테스트 실행
cd packages/server
pnpm test:rules

# 또는 package.json에 스크립트 추가
# "test:rules": "jest tests/firestore.rules.test.ts --testTimeout=30000"
```

`firebase.json` 설정:

```json
{
  "firestore": {
    "rules": "firebase/firestore.rules",
    "indexes": "firebase/firestore.indexes.json"
  },
  "emulators": {
    "firestore": {
      "port": 8080
    },
    "ui": {
      "enabled": true,
      "port": 4000
    }
  }
}
```

---

## 8. 보안 고려사항

### 8.1 API 키 필드 보호

`users/{userId}` 문서의 `apiKeyEncrypted` 필드는 가장 민감한 데이터다.

**저장 방식**:
```
평문 Anthropic API 키
  → AES-256-GCM 암호화 (Council Server에서 수행)
  → Base64 인코딩
  → Firestore users/{userId}.apiKeyEncrypted 에 저장
```

**암호화 키 관리**:
- 암호화 키는 Oracle Ampere 서버의 환경변수(`ENCRYPTION_KEY`)에만 존재
- Firestore에는 절대 저장하지 않음
- 클라이언트(브라우저)에는 노출되지 않음

**추가 보호 계층**:
```javascript
// Security Rules에서 특정 필드 읽기를 차단하는 것은 현재 Firestore Rules에서
// 필드 레벨 제어가 제한적이므로, 문서 레벨에서 소유자만 읽기를 허용.
// 향후 민감 필드는 별도 서브컬렉션으로 분리를 검토한다.
//
// 예: users/{userId}/secrets/apiKey 로 분리하면
// users/{userId} 읽기 권한과 독립적으로 제어 가능
match /users/{userId}/secrets/{secretId} {
  allow read, write: if false; // Admin SDK 전용
}
```

**클라이언트 접근 패턴**:
```
클라이언트: API 키 등록 요청 → Council Server API 엔드포인트
                               ↓ 암호화 후 Admin SDK로 저장
Council Server: 세션 시작 시 → Admin SDK로 읽기 → 복호화 → 메모리에서만 사용
                                                           → 로그/응답에 노출 금지
```

---

### 8.2 Rate Limiting

Firestore Security Rules는 자체적인 Rate Limiting 기능을 제공하지 않는다.
아래 전략으로 클라이언트 측 남용을 방지한다.

**전략 1 — 쓰기 작업의 서버 중앙화**
핵심 쓰기(메시지, 상태 업데이트)를 Admin SDK 전용으로 전환하면
클라이언트가 직접 대량 쓰기를 할 수 없다.

**전략 2 — Cloud Functions 미들웨어 (Phase 2 이후)**
```
클라이언트 → Cloud Function → Rate Check → Firestore 쓰기
                              ↓ 초과 시
                              429 Too Many Requests 반환
```

**전략 3 — Firestore Rules에서 타임스탬프 기반 제한 (부분적)**
```javascript
// 예: 메시지 생성 시 최소 1초 간격 강제 (단순 예시, 실제로는 서버 측 처리 권장)
match /messages/{messageId} {
  allow create: if isProjectOwner(projectId)
    && request.resource.data.timestamp > request.time - duration.value(1, 's');
}
```

**전략 4 — Firebase App Check**
Firebase App Check를 활성화하면 정상적인 앱 인스턴스(브라우저)에서만
Firestore에 접근 가능하도록 강제할 수 있다. 스크립트를 통한 직접 API 남용을 차단한다.

```typescript
// packages/web/src/firebase/client.ts에 추가
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check'

initializeAppCheck(app, {
  provider: new ReCaptchaV3Provider(import.meta.env.VITE_RECAPTCHA_SITE_KEY),
  isTokenAutoRefreshEnabled: true,
})
```

---

### 8.3 기타 보안 고려사항

**Firestore 보안 규칙 배포 자동화**

규칙 변경 시 실수로 잘못된 규칙이 배포되지 않도록
CI/CD 파이프라인에서 반드시 에뮬레이터 테스트를 통과한 후에만 배포한다.

```yaml
# .github/workflows/deploy-rules.yml
- name: Run Firestore Rules Tests
  run: |
    cd packages/server
    firebase emulators:exec --only firestore "pnpm test:rules"

- name: Deploy Firestore Rules
  run: firebase deploy --only firestore:rules
```

**복합 인덱스와 Rules 일관성**

`where('ownerId', '==', uid)` 쿼리가 Rules와 일치하지 않으면
클라이언트에서 `permission-denied` 오류가 발생한다.
Rules는 쿼리의 필터 조건이 항상 만족될 수 있도록 설계되어야 한다.

```json
// firebase/firestore.indexes.json
{
  "indexes": [
    {
      "collectionGroup": "projects",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "ownerId", "order": "ASCENDING" },
        { "fieldPath": "updatedAt", "order": "DESCENDING" }
      ]
    }
  ]
}
```

**최소 권한 원칙 유지**

현재 Rules의 클라이언트 쓰기 허용 범위:
- `projects` 생성/수정/삭제 (본인 소유만)
- `rooms` 생성/수정/삭제 (프로젝트 소유자만)
- `messages` 생성만 (수정/삭제 불가)
- `tasks` 생성/수정/삭제 (프로젝트 소유자만)
- `pullRequests` 생성/수정/삭제 (프로젝트 소유자만)

추후 기능 추가 시 권한을 확장할 때는 최소 권한 원칙을 기준으로 검토한다.
특히 다중 사용자 협업 기능이 추가될 경우 `isProjectOwner` 외에
`isProjectMember` 등의 Helper 함수를 추가하고 테스트를 먼저 작성한 후 규칙을 변경한다.

---

## 관련 문서

- [01_Firestore_스키마.md](./01_Firestore_스키마.md) — 컬렉션/문서 구조, 인덱스
- [../00_설정_참조표.md](../00_설정_참조표.md) — Firebase 프로젝트 설정, Firestore 리전, 전역 설정값 단일 출처
