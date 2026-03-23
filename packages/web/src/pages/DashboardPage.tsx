import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { useAuth } from '../hooks/useAuth'
import type { Project } from '@agent-council/shared'

export function DashboardPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const { fetchApi } = useApi()
  const { logout } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    fetchApi('/api/projects')
      .then((data) => setProjects(data.projects))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Agent Council</h1>
        <div className="flex gap-3">
          <button
            onClick={() => navigate('/new')}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700 transition"
          >
            + 새 프로젝트
          </button>
          <button
            onClick={logout}
            className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-400 hover:text-white transition"
          >
            로그아웃
          </button>
        </div>
      </div>

      <div className="mt-8">
        {loading ? (
          <p className="text-gray-400">로딩 중...</p>
        ) : projects.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-700 p-12 text-center">
            <p className="text-gray-400">아직 프로젝트가 없습니다</p>
            <Link
              to="/new"
              className="mt-3 inline-block text-blue-400 hover:text-blue-300"
            >
              첫 프로젝트 만들기 →
            </Link>
          </div>
        ) : (
          <div className="grid gap-4">
            {projects.map((p) => (
              <div
                key={p.id}
                className="group relative rounded-lg border border-gray-800 p-4 hover:border-gray-600 transition"
              >
                <Link to={`/p/${p.id}`} className="block">
                  <div className="flex items-center justify-between">
                    <h2 className="font-semibold">{p.name}</h2>
                    <span className="text-xs text-gray-500">{p.status}</span>
                  </div>
                  <p className="mt-1 text-sm text-gray-400">{p.description}</p>
                </Link>
                <button
                  onClick={async (e) => {
                    e.stopPropagation()
                    if (!confirm(`"${p.name}" 프로젝트를 삭제하시겠습니까?`)) return
                    try {
                      await fetchApi(`/api/projects/${p.id}`, { method: 'DELETE' })
                      setProjects((prev) => prev.filter((x) => x.id !== p.id))
                    } catch (err) {
                      console.error(err)
                    }
                  }}
                  className="absolute right-3 top-3 hidden rounded p-1 text-gray-600 hover:bg-red-900/30 hover:text-red-400 group-hover:block"
                  title="프로젝트 삭제"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
