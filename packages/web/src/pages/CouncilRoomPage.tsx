import { useState, useRef, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useMessages } from '../hooks/useMessages'
import { useSets } from '../hooks/useSets'
import { useApi } from '../hooks/useApi'
import { MessageItem } from '../components/chat/MessageItem'
import { MentionPopover } from '../components/chat/MentionPopover'
import { SetStatusCard } from '../components/sets/SetStatusCard'
import { SetCreateModal } from '../components/sets/SetCreateModal'
import { useMention } from '../hooks/useMention'
import { RightPanel } from '../components/panels/RightPanel'
import { useProject } from '../hooks/useProject'

export function CouncilRoomPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const { messages, loading, hasMore, loadingMore, loadMore } = useMessages(projectId)
  const { sets } = useSets(projectId)
  const { project } = useProject(projectId)
  const { fetchApi } = useApi()
  const { mention, handleInputChange, completeMention, closeMention } = useMention()
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [showSetModal, setShowSetModal] = useState(false)
  const [showLeftPanel, setShowLeftPanel] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = async () => {
    if (!input.trim() || sending) return
    const content = input.trim()
    setInput('')
    setSending(true)

    try {
      await fetchApi(`/api/projects/${projectId}/rooms/main/messages`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      })
    } catch (err) {
      console.error('Send failed:', err)
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleCreateSet = async (data: { name: string; role: string; alias: string }) => {
    await fetchApi(`/api/projects/${projectId}/sets`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  const handleDeleteSet = async (setId: string) => {
    if (!confirm('이 팀을 삭제하시겠습니까?')) return
    await fetchApi(`/api/projects/${projectId}/sets/${setId}`, {
      method: 'DELETE',
    })
  }

  return (
    <div className="flex h-screen">
      {showSetModal && (
        <SetCreateModal
          onClose={() => setShowSetModal(false)}
          onSubmit={handleCreateSet}
        />
      )}

      {/* Left Panel - Sets */}
      <div className={`${showLeftPanel ? 'fixed inset-0 z-40 block' : 'hidden'} lg:relative lg:block lg:w-64`}>
        {/* Overlay for mobile */}
        <div
          className={`${showLeftPanel ? 'block' : 'hidden'} fixed inset-0 bg-black/50 lg:hidden`}
          onClick={() => setShowLeftPanel(false)}
        />
        <div className="relative z-50 h-full w-64 flex-shrink-0 border-r border-gray-800 bg-gray-950 p-4">
          <Link to="/" className="text-lg font-bold hover:text-blue-400 transition">
            ← Agent Council
          </Link>
          <div className="mt-6">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase text-gray-500">
                에이전트 팀 ({sets.length})
              </h3>
              <button
                onClick={() => setShowSetModal(true)}
                className="rounded bg-blue-600 px-2 py-0.5 text-xs font-medium hover:bg-blue-700 transition"
              >
                + 추가
              </button>
            </div>
            <div className="mt-2 space-y-2">
              {sets.map((set) => (
                <SetStatusCard key={set.id} set={set} onDelete={() => handleDeleteSet(set.id)} />
              ))}
              {sets.length === 0 && (
                <p className="text-sm text-gray-500">팀을 추가해주세요</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Center Panel - Chat */}
      <div className="flex flex-1 flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowLeftPanel(!showLeftPanel)}
              className="rounded p-1 hover:bg-gray-800 lg:hidden"
            >
              ☰
            </button>
            <Link to="/" className="text-sm text-gray-500 hover:text-blue-400 lg:hidden">←</Link>
            <h2 className="font-semibold">Council Room</h2>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500">{sets.length}개 팀</span>
            <Link to={`/p/${projectId}/settings`} className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-white transition" title="프로젝트 설정">
              ⚙
            </Link>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 pb-14 lg:pb-4">
          {loading ? (
            <p className="text-center text-gray-400">로딩 중...</p>
          ) : messages.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-gray-500">메시지를 보내서 Council을 시작하세요</p>
            </div>
          ) : (
            <div className="space-y-3">
              {hasMore && (
                <div className="text-center">
                  <button
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:border-gray-500 hover:text-white disabled:opacity-50 transition"
                  >
                    {loadingMore ? '불러오는 중...' : '↑ 이전 메시지 불러오기'}
                  </button>
                </div>
              )}
              {messages.map((msg) => (
                <MessageItem key={msg.id} message={msg} />
              ))}
              {/* Typing/Working Indicator */}
              {sets.filter((s) => s.status === 'working').length > 0 && (
                <div className="flex items-center gap-2 px-2 py-1">
                  <div className="flex gap-1">
                    <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:0ms]" />
                    <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:150ms]" />
                    <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:300ms]" />
                  </div>
                  <span className="text-xs text-gray-500">
                    {sets
                      .filter((s) => s.status === 'working')
                      .map((s) => s.name)
                      .join(', ')}
                    {sets.filter((s) => s.status === 'working').length === 1
                      ? '이 응답 중...'
                      : '이 응답 중...'}
                  </span>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input */}
        <div className="relative border-t border-gray-800 p-4">
          {mention.active && (
            <MentionPopover
              sets={sets}
              query={mention.query}
              onSelect={(selected) => {
                setInput(completeMention(input, selected))
                closeMention()
              }}
              position={{ bottom: 60, left: 16 }}
            />
          )}
          <div className="flex gap-2">
            <textarea
              value={input}
              onChange={(e) => {
                setInput(e.target.value)
                handleInputChange(e.target.value, e.target.selectionStart ?? 0)
              }}
              onKeyDown={handleKeyDown}
              placeholder="메시지를 입력하세요... (Enter로 전송)"
              rows={1}
              className="flex-1 resize-none rounded-lg border border-gray-700 bg-gray-900 px-4 py-2 focus:border-blue-500 focus:outline-none"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || sending}
              className="rounded-lg bg-blue-600 px-6 py-2 font-medium hover:bg-blue-700 disabled:opacity-50 transition"
            >
              {sending ? '...' : '전송'}
            </button>
          </div>
        </div>

        {/* Bottom Status Bar - Desktop */}
        <div className="hidden border-t border-gray-800 px-4 py-1.5 text-xs text-gray-500 lg:flex lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            {sets.filter((s) => s.status === 'working').map((s) => (
              <span key={s.id} className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full" style={{ backgroundColor: s.color }} />
                {s.name} 작업 중
              </span>
            ))}
            {sets.every((s) => s.status !== 'working') && <span>대기 중</span>}
          </div>
          <div className="flex items-center gap-3">
            <span>{messages.length}개 메시지</span>
            <span>{sets.length}개 팀</span>
          </div>
        </div>
      </div>

      {/* Mobile Bottom Tab Bar */}
      <div className="fixed bottom-0 left-0 right-0 flex border-t border-gray-800 bg-gray-950 lg:hidden">
        <button className="flex flex-1 flex-col items-center py-2 text-xs text-blue-400">
          <span>💬</span>
          <span>채팅</span>
        </button>
        <button
          onClick={() => setShowSetModal(true)}
          className="flex flex-1 flex-col items-center py-2 text-xs text-gray-400 hover:text-white"
        >
          <span>👥</span>
          <span>팀</span>
        </button>
        <button className="flex flex-1 flex-col items-center py-2 text-xs text-gray-400">
          <span>📋</span>
          <span>보드</span>
        </button>
        <button className="flex flex-1 flex-col items-center py-2 text-xs text-gray-400">
          <span>🔀</span>
          <span>Git</span>
        </button>
      </div>

      {/* Right Panel */}
      <RightPanel
        project={project}
        sets={sets}
        messages={messages}
        projectId={projectId ?? ''}
      />
    </div>
  )
}
