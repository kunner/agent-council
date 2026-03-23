import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import type { ProjectType } from '@agent-council/shared'

export function NewProjectPage() {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState<ProjectType>('new')
  const [submitting, setSubmitting] = useState(false)
  const { fetchApi } = useApi()
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    try {
      const data = await fetchApi('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name, description, type }),
      })
      navigate(`/p/${data.project.id}`)
    } catch (err) {
      console.error(err)
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto max-w-lg p-6">
      <h1 className="text-2xl font-bold">새 프로젝트</h1>
      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div>
          <label className="block text-sm text-gray-400">프로젝트 이름</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="사내 메신저 시스템"
            required
            className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-4 py-2 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400">설명</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="React + Spring Boot 기반 실시간 채팅 시스템"
            required
            rows={3}
            className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-4 py-2 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400">프로젝트 유형</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as ProjectType)}
            className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-4 py-2 focus:border-blue-500 focus:outline-none"
          >
            <option value="new">신규 프로젝트</option>
            <option value="existing">기존 프로젝트</option>
            <option value="analysis">분석 프로젝트</option>
          </select>
        </div>
        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-blue-600 px-6 py-2 font-medium hover:bg-blue-700 disabled:opacity-50 transition"
          >
            {submitting ? '생성 중...' : '프로젝트 생성'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="rounded-lg border border-gray-700 px-6 py-2 text-gray-400 hover:text-white transition"
          >
            취소
          </button>
        </div>
      </form>
    </div>
  )
}
