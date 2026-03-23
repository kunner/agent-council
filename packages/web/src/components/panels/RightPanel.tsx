import type { Project, AgentSet, Message } from '@agent-council/shared'
import { useState } from 'react'
import { useApi } from '../../hooks/useApi'

interface Props {
  project: Project | null
  sets: AgentSet[]
  messages: Message[]
  projectId: string
}

type Tab = 'info' | 'git'

export function RightPanel({ project, sets, messages, projectId }: Props) {
  const [tab, setTab] = useState<Tab>('info')
  const { fetchApi } = useApi()
  const [gitStatus, setGitStatus] = useState<{ branches: Array<{ name: string }>; mainCommits: number } | null>(null)

  const loadGitStatus = async () => {
    try {
      const data = await fetchApi(`/api/projects/${projectId}/git/status`)
      setGitStatus(data)
    } catch {
      setGitStatus(null)
    }
  }

  return (
    <div className="hidden w-72 flex-shrink-0 border-l border-gray-800 xl:block">
      {/* Tabs */}
      <div className="flex border-b border-gray-800">
        <button
          onClick={() => setTab('info')}
          className={`flex-1 py-2 text-xs font-medium transition ${
            tab === 'info' ? 'border-b-2 border-blue-500 text-blue-400' : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          프로젝트
        </button>
        <button
          onClick={() => { setTab('git'); loadGitStatus() }}
          className={`flex-1 py-2 text-xs font-medium transition ${
            tab === 'git' ? 'border-b-2 border-blue-500 text-blue-400' : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          Git
        </button>
      </div>

      <div className="p-4">
        {tab === 'info' && (
          <div className="space-y-4">
            {project && (
              <>
                <div>
                  <h4 className="text-xs font-semibold uppercase text-gray-500">프로젝트</h4>
                  <p className="mt-1 text-sm font-medium">{project.name}</p>
                  <p className="mt-0.5 text-xs text-gray-400">{project.description}</p>
                </div>
                <div>
                  <h4 className="text-xs font-semibold uppercase text-gray-500">상태</h4>
                  <span className="mt-1 inline-block rounded-full bg-blue-900/30 px-2 py-0.5 text-xs text-blue-400">
                    {project.status}
                  </span>
                </div>
                <div>
                  <h4 className="text-xs font-semibold uppercase text-gray-500">유형</h4>
                  <span className="mt-1 text-xs text-gray-400">
                    {project.type === 'new' ? '신규 프로젝트' : project.type === 'existing' ? '기존 프로젝트' : '분석'}
                  </span>
                </div>
              </>
            )}
            <div>
              <h4 className="text-xs font-semibold uppercase text-gray-500">통계</h4>
              <div className="mt-1 space-y-1 text-xs text-gray-400">
                <div className="flex justify-between">
                  <span>메시지</span>
                  <span>{messages.length}개</span>
                </div>
                <div className="flex justify-between">
                  <span>에이전트 팀</span>
                  <span>{sets.length}개</span>
                </div>
                <div className="flex justify-between">
                  <span>작업 중</span>
                  <span>{sets.filter((s) => s.status === 'working').length}개</span>
                </div>
              </div>
            </div>
            <div>
              <h4 className="text-xs font-semibold uppercase text-gray-500">멘션 가이드</h4>
              <div className="mt-1 space-y-0.5 text-xs text-gray-500">
                <p>• 일반 메시지 → 팀장만 응답</p>
                <p>• @팀이름 → 해당 팀 응답</p>
                <p>• @all → 전체 팀 병렬 응답</p>
              </div>
            </div>
          </div>
        )}

        {tab === 'git' && (
          <div className="space-y-4">
            {gitStatus ? (
              <>
                <div>
                  <h4 className="text-xs font-semibold uppercase text-gray-500">main</h4>
                  <p className="mt-1 text-xs text-gray-400">{gitStatus.mainCommits}개 커밋</p>
                </div>
                <div>
                  <h4 className="text-xs font-semibold uppercase text-gray-500">브랜치</h4>
                  <div className="mt-1 space-y-1">
                    {gitStatus.branches.map((b) => (
                      <div key={b.name} className="flex items-center gap-2 text-xs">
                        <span className="text-green-400">●</span>
                        <span className="text-gray-300">{b.name}</span>
                      </div>
                    ))}
                    {gitStatus.branches.length === 0 && (
                      <p className="text-xs text-gray-500">브랜치 없음</p>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <p className="text-xs text-gray-500">Git 탭을 클릭하여 상태를 불러오세요</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
