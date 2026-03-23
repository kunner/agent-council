import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { useProject } from '../hooks/useProject'
import type { ProjectStatus } from '@agent-council/shared'

export function ProjectSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const { project } = useProject(projectId)
  const { fetchApi } = useApi()
  const navigate = useNavigate()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<ProjectStatus>('planning')
  const [repoUrl, setRepoUrl] = useState('')
  const [gitToken, setGitToken] = useState('')
  const [gitStatus, setGitStatus] = useState<{ branches: Array<{ name: string }>; mainCommits: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  const loadGitStatus = async () => {
    try {
      const data = await fetchApi(`/api/projects/${projectId}/git/status`)
      setGitStatus(data)
    } catch {
      setGitStatus(null)
    }
  }

  useEffect(() => {
    if (project) {
      setName(project.name)
      setDescription(project.description)
      setStatus(project.status)
    }
  }, [project])

  useEffect(() => {
    if (projectId) loadGitStatus()
  }, [projectId])

  const handleSave = async () => {
    setSaving(true)
    setMessage('')
    try {
      await fetchApi(`/api/projects/${projectId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name, description, status }),
      })
      setMessage('저장되었습니다.')
      setTimeout(() => setMessage(''), 2000)
    } catch (err) {
      setMessage('저장 실패: ' + (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm(`"${project?.name}" 프로젝트를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.`)) return
    try {
      await fetchApi(`/api/projects/${projectId}`, { method: 'DELETE' })
      navigate('/')
    } catch (err) {
      console.error(err)
    }
  }

  const handleInitGit = async () => {
    try {
      await fetchApi(`/api/projects/${projectId}/git/init`, { method: 'POST' })
      setMessage('빈 Git 저장소가 초기화되었습니다.')
      await loadGitStatus()
      setTimeout(() => setMessage(''), 3000)
    } catch (err) {
      setMessage('Git 초기화 실패: ' + (err as Error).message)
    }
  }

  const handleCloneGit = async () => {
    if (!repoUrl.trim()) return
    setMessage('Git 저장소 연결 중...')
    try {
      await fetchApi(`/api/projects/${projectId}/git/clone`, {
        method: 'POST',
        body: JSON.stringify({ repoUrl: repoUrl.trim(), token: gitToken.trim() || undefined }),
      })
      setMessage('Git 저장소가 연결되었습니다.')
      setRepoUrl('')
      setGitToken('')
      await loadGitStatus()
      setTimeout(() => setMessage(''), 3000)
    } catch (err) {
      setMessage('Git 연결 실패: ' + (err as Error).message)
    }
  }

  if (!project) {
    return <div className="flex h-screen items-center justify-center text-gray-400">로딩 중...</div>
  }

  return (
    <div className="mx-auto max-w-lg p-6">
      <div className="flex items-center gap-3">
        <Link to={`/p/${projectId}`} className="text-gray-500 hover:text-blue-400">←</Link>
        <h1 className="text-2xl font-bold">프로젝트 설정</h1>
      </div>

      {message && (
        <div className={`mt-4 rounded-lg px-4 py-2 text-sm ${message.includes('실패') ? 'bg-red-900/30 text-red-400' : 'bg-green-900/30 text-green-400'}`}>
          {message}
        </div>
      )}

      <div className="mt-6 space-y-4">
        <div>
          <label className="block text-sm text-gray-400">프로젝트 이름</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-4 py-2 focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-sm text-gray-400">설명</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-4 py-2 focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-sm text-gray-400">상태</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as ProjectStatus)}
            className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-4 py-2 focus:border-blue-500 focus:outline-none"
          >
            <option value="planning">계획 중</option>
            <option value="in_progress">진행 중</option>
            <option value="review">리뷰</option>
            <option value="completed">완료</option>
            <option value="paused">일시정지</option>
            <option value="archived">보관</option>
          </select>
        </div>

        <div className="flex gap-3 pt-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-blue-600 px-6 py-2 font-medium hover:bg-blue-700 disabled:opacity-50 transition"
          >
            {saving ? '저장 중...' : '저장'}
          </button>
          <button
            onClick={() => navigate(`/p/${projectId}`)}
            className="rounded-lg border border-gray-700 px-6 py-2 text-gray-400 hover:text-white transition"
          >
            돌아가기
          </button>
        </div>
      </div>

      {/* Git 섹션 */}
      <div className="mt-8 border-t border-gray-800 pt-6">
        <h2 className="text-lg font-semibold">Git 저장소</h2>
        <p className="mt-1 text-sm text-gray-400">프로젝트의 Git 저장소를 관리합니다.</p>

        {/* 현재 Git 상태 */}
        {gitStatus && gitStatus.mainCommits > 0 ? (
          <div className="mt-4 rounded-lg border border-green-900/50 bg-green-900/10 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-green-400">
              <span>✓</span> Git 저장소 연결됨
            </div>
            <div className="mt-2 space-y-1 text-xs text-gray-400">
              <div className="flex justify-between">
                <span>커밋 수</span>
                <span>{gitStatus.mainCommits}개</span>
              </div>
              <div className="flex justify-between">
                <span>브랜치</span>
                <span>{gitStatus.branches.length}개</span>
              </div>
              {gitStatus.branches.map((b) => (
                <div key={b.name} className="flex items-center gap-1 pl-2">
                  <span className="text-green-500">●</span>
                  <span>{b.name}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="mt-4 rounded-lg border border-yellow-900/50 bg-yellow-900/10 p-4">
            <div className="flex items-center gap-2 text-sm text-yellow-400">
              <span>⚠</span> Git 저장소가 연결되지 않았습니다
            </div>
          </div>
        )}

        <div className="mt-4 space-y-4">
          {/* 기존 repo 연결 */}
          <div>
            <label className="block text-sm text-gray-400">기존 저장소 연결</label>
            <input
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/user/repo.git"
              className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400">
              GitHub 토큰 <span className="text-gray-600">(프라이빗 저장소용, 선택)</span>
            </label>
            <input
              value={gitToken}
              onChange={(e) => setGitToken(e.target.value)}
              type="password"
              placeholder="ghp_xxxxxxxxxxxx"
              className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
            <p className="mt-1 text-xs text-gray-600">GitHub → Settings → Developer settings → Personal access tokens</p>
          </div>
          <button
            onClick={handleCloneGit}
            disabled={!repoUrl.trim()}
            className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition"
          >
            저장소 연결 (Clone)
          </button>

          {/* 또는 빈 repo 생성 */}
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-gray-800" />
            <span className="text-xs text-gray-600">또는</span>
            <div className="h-px flex-1 bg-gray-800" />
          </div>

          <button
            onClick={handleInitGit}
            className="w-full rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:border-blue-500 hover:text-blue-400 transition"
          >
            빈 Git 저장소 새로 만들기
          </button>
        </div>
      </div>

      {/* 위험 구역 */}
      <div className="mt-8 border-t border-red-900/30 pt-6">
        <h2 className="text-lg font-semibold text-red-400">위험 구역</h2>
        <p className="mt-1 text-sm text-gray-500">이 작업은 되돌릴 수 없습니다.</p>
        <button
          onClick={handleDelete}
          className="mt-4 rounded-lg border border-red-800 px-4 py-2 text-sm text-red-400 hover:bg-red-900/30 transition"
        >
          프로젝트 삭제
        </button>
      </div>
    </div>
  )
}
