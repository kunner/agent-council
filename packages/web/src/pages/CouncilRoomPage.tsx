import { useState, useRef, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useMessages } from '../hooks/useMessages'
import { useSets } from '../hooks/useSets'
import { useApi } from '../hooks/useApi'
import { MessageItem } from '../components/chat/MessageItem'
import { SetStatusCard } from '../components/sets/SetStatusCard'

export function CouncilRoomPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const { messages, loading } = useMessages(projectId)
  const { sets } = useSets(projectId)
  const { fetchApi } = useApi()
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
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

  return (
    <div className="flex h-screen">
      {/* Left Panel - Sets */}
      <div className="hidden w-64 flex-shrink-0 border-r border-gray-800 p-4 lg:block">
        <Link to="/" className="text-lg font-bold hover:text-blue-400 transition">
          ← Agent Council
        </Link>
        <div className="mt-6">
          <h3 className="text-xs font-semibold uppercase text-gray-500">
            Sets ({sets.length})
          </h3>
          <div className="mt-2 space-y-2">
            {sets.map((set) => (
              <SetStatusCard key={set.id} set={set} />
            ))}
            {sets.length === 0 && (
              <p className="text-sm text-gray-500">Set을 추가해주세요</p>
            )}
          </div>
        </div>
      </div>

      {/* Center Panel - Chat */}
      <div className="flex flex-1 flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
          <h2 className="font-semibold">Council Room</h2>
          <span className="text-xs text-gray-500">{sets.length} sets</span>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <p className="text-center text-gray-400">로딩 중...</p>
          ) : messages.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-gray-500">메시지를 보내서 Council을 시작하세요</p>
            </div>
          ) : (
            <div className="space-y-3">
              {messages.map((msg) => (
                <MessageItem key={msg.id} message={msg} />
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input */}
        <div className="border-t border-gray-800 p-4">
          <div className="flex gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
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
      </div>

      {/* Right Panel - placeholder */}
      <div className="hidden w-72 flex-shrink-0 border-l border-gray-800 p-4 xl:block">
        <h3 className="text-xs font-semibold uppercase text-gray-500">Context</h3>
        <p className="mt-4 text-sm text-gray-600">
          Phase 2에서 태스크 보드, Git 상태가 표시됩니다.
        </p>
      </div>
    </div>
  )
}
