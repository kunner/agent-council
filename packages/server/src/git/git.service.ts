import { execSync } from 'child_process'
import path from 'path'
import fs from 'fs'

const WORKSPACE_BASE = process.env.WORKSPACE_BASE_PATH ?? '/tmp/agent-council-workspace'

export function ensureWorkspaceDir(): void {
  if (!fs.existsSync(WORKSPACE_BASE)) {
    fs.mkdirSync(WORKSPACE_BASE, { recursive: true })
  }
}

/**
 * Initialize a new git repo for a project
 */
export function initProjectRepo(projectId: string): string {
  ensureWorkspaceDir()
  const repoPath = path.join(WORKSPACE_BASE, projectId, 'main')

  if (!fs.existsSync(repoPath)) {
    fs.mkdirSync(repoPath, { recursive: true })
    execSync('git init', { cwd: repoPath })
    execSync('git checkout -b main', { cwd: repoPath })
    // Create initial commit so worktrees can branch from it
    fs.writeFileSync(path.join(repoPath, 'README.md'), `# Project ${projectId}\n`)
    execSync('git add .', { cwd: repoPath })
    execSync('git commit -m "init: project initialized by Agent Council"', { cwd: repoPath })
  }

  return repoPath
}

/**
 * Clone an existing repo for a project
 */
export function cloneProjectRepo(projectId: string, repoUrl: string, token?: string): string {
  ensureWorkspaceDir()
  const repoPath = path.join(WORKSPACE_BASE, projectId, 'main')

  if (fs.existsSync(repoPath)) {
    // Already exists — remove and re-clone
    fs.rmSync(repoPath, { recursive: true, force: true })
  }

  // If token provided, inject into URL for private repos
  let authUrl = repoUrl
  if (token && repoUrl.startsWith('https://')) {
    authUrl = repoUrl.replace('https://', `https://${token}@`)
  }

  execSync(`git clone "${authUrl}" "${repoPath}"`, { timeout: 60_000 })
  return repoPath
}

/**
 * Create a git worktree for a Set
 */
export function createWorktree(projectId: string, setId: string, branchName: string): string {
  const mainRepoPath = path.join(WORKSPACE_BASE, projectId, 'main')
  const worktreePath = path.join(WORKSPACE_BASE, projectId, setId)

  if (!fs.existsSync(mainRepoPath)) {
    throw new Error(`Main repo not found for project ${projectId}`)
  }

  if (!fs.existsSync(worktreePath)) {
    execSync(`git worktree add -b "${branchName}" "${worktreePath}"`, { cwd: mainRepoPath })
  }

  return worktreePath
}

/**
 * Remove a git worktree
 */
export function removeWorktree(projectId: string, setId: string): void {
  const mainRepoPath = path.join(WORKSPACE_BASE, projectId, 'main')
  const worktreePath = path.join(WORKSPACE_BASE, projectId, setId)

  if (fs.existsSync(worktreePath)) {
    try {
      execSync(`git worktree remove --force "${worktreePath}"`, { cwd: mainRepoPath })
    } catch {
      // If worktree remove fails, just clean up the directory
      fs.rmSync(worktreePath, { recursive: true, force: true })
      try { execSync('git worktree prune', { cwd: mainRepoPath }) } catch { /* ignore */ }
    }
  }
}

/**
 * Get git status for a project
 */
export function getGitStatus(projectId: string): {
  branches: Array<{ name: string; ahead: number }>
  mainCommits: number
} {
  const mainRepoPath = path.join(WORKSPACE_BASE, projectId, 'main')

  if (!fs.existsSync(mainRepoPath)) {
    return { branches: [], mainCommits: 0 }
  }

  try {
    const logOutput = execSync('git log --oneline', { cwd: mainRepoPath }).toString().trim()
    const mainCommits = logOutput ? logOutput.split('\n').length : 0

    const branchOutput = execSync('git branch --all', { cwd: mainRepoPath }).toString().trim()
    const branches = branchOutput
      .split('\n')
      .map((b) => b.trim().replace('* ', ''))
      .filter((b) => b && !b.startsWith('remotes/'))
      .map((name) => ({ name, ahead: 0 }))

    return { branches, mainCommits }
  } catch {
    return { branches: [], mainCommits: 0 }
  }
}
