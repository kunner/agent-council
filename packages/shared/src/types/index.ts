// ─── Timestamp (firebase-compatible neutral type) ──────────
export interface Timestamp {
  seconds: number
  nanoseconds: number
}

// ─── User ──────────────────────────────────────────────────
export interface User {
  uid: string
  displayName: string
  email: string
  photoURL: string
  apiKeyEncrypted?: string
  authMethod: 'api_key' | 'max_plan'
  createdAt: Timestamp
}

// ─── Project ───────────────────────────────────────────────
export type ProjectType = 'new' | 'existing' | 'analysis'
export type ProjectStatus =
  | 'planning'
  | 'in_progress'
  | 'review'
  | 'completed'
  | 'paused'
  | 'archived'

export interface Project {
  id: string
  name: string
  description: string
  ownerId: string
  type: ProjectType
  status: ProjectStatus
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface GitConfig {
  repoUrl?: string
  localPath: string
  defaultBranch: string
  isRemote: boolean
  githubToken?: string
}

// ─── Room ──────────────────────────────────────────────────
export type RoomStatus = 'active' | 'paused' | 'completed'
export type RoomPurpose = 'main' | 'design' | 'bug_triage' | 'code_review' | 'integration' | 'custom'
export type SenderType = 'human' | 'leader' | 'system'

export interface Room {
  id: string
  name: string
  purpose: RoomPurpose
  status: RoomStatus
  createdAt: Timestamp
}

export interface MessageMetadata {
  artifacts?: string[]
  taskRefs?: string[]
  commitHash?: string
  pullRequestUrl?: string
  tokenUsage?: number
  setColor?: string
}

export interface Message {
  id: string
  roomId: string
  senderId: string
  senderName: string
  senderType: SenderType
  content: string
  replyTo?: string
  metadata?: MessageMetadata
  timestamp: Timestamp
}

// ─── Agent Set ─────────────────────────────────────────────
export type SetStatus = 'idle' | 'working' | 'waiting' | 'done' | 'error'
export type ClaudeModel = 'opus' | 'sonnet' | 'haiku'

export interface AgentSet {
  id: string
  projectId: string
  name: string
  alias?: string
  role: string
  model: ClaudeModel
  status: SetStatus
  color: string
  branch: string
  worktreePath: string
  sessionId?: string
  isActive?: boolean
  isLeader?: boolean
  teammates: number
  createdAt: Timestamp
}

export interface SetLog {
  id: string
  content: string
  type: 'info' | 'code' | 'error' | 'progress'
  timestamp: Timestamp
}

// ─── Task ──────────────────────────────────────────────────
export type TaskStatus = 'backlog' | 'in_progress' | 'review' | 'done' | 'blocked'
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low'

export interface Task {
  id: string
  projectId: string
  title: string
  description: string
  status: TaskStatus
  assignedSetId?: string
  priority: TaskPriority
  dependencies: string[]
  branch?: string
  pullRequestUrl?: string
  createdFromMessageId?: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

// ─── Pull Request ──────────────────────────────────────────
export type PRStatus = 'open' | 'reviewing' | 'approved' | 'merged' | 'closed'

export interface PullRequest {
  id: string
  title: string
  githubPrNumber?: number
  githubPrUrl?: string
  sourceBranch: string
  targetBranch: string
  setId: string
  status: PRStatus
  reviewNotes: string[]
  relatedTaskIds: string[]
  createdAt: Timestamp
  mergedAt?: Timestamp
}

// ─── Session ───────────────────────────────────────────────
export type SessionStatus = 'starting' | 'active' | 'idle' | 'sleeping' | 'stopping' | 'stopped' | 'error'
export type SnapshotTrigger = 'pr_merged' | 'task_done' | 'manual' | 'scheduled' | 'session_end' | 'pm_away'

export interface ProjectSnapshot {
  id: string
  createdAt: Timestamp
  trigger: SnapshotTrigger
  summary: string
  completedTasks: string[]
  inProgressTasks: Array<{ task: string; set: string; progress: string }>
  decisions: string[]
  gitState: {
    mainCommits: number
    openPRs: string[]
    branches: Record<string, string>
  }
  recentMessageCount: number
}

// ─── DTOs ──────────────────────────────────────────────────
export interface CreateProjectDto {
  name: string
  description: string
  type: ProjectType
  repoUrl?: string
}

export interface CreateSetDto {
  name: string
  alias?: string
  role: string
  model?: ClaudeModel
  teammates?: number
}

export interface SendMessageDto {
  content: string
  replyTo?: string
}
