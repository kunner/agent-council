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
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (project) {
      setName(project.name)
      setDescription(project.description)
      setStatus(project.status)
    }
  }, [project])

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
      setMessage('Git 저장소가 초기화되었습니다.')
      setTimeout(() => setMessage(''), 2000)
    } catch (err) {
      setMessage('Git 초기화 실패: ' + (err as Error).message)
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
        <div className="mt-4 flex gap-3">
          <button
            onClick={handleInitGit}
            className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:border-blue-500 hover:text-blue-400 transition"
          >
            Git 저장소 초기화
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
