import type { AgentSet } from '@agent-council/shared'

const STATUS_LABEL: Record<string, string> = {
  idle: '대기',
  working: '작업 중',
  waiting: '대기',
  done: '완료',
  error: '오류',
}

const STATUS_ICON: Record<string, string> = {
  idle: '⏸',
  working: '🔄',
  waiting: '⏳',
  done: '✅',
  error: '❌',
}

const MODEL_BADGE: Record<string, { label: string; color: string }> = {
  opus: { label: 'Opus', color: 'bg-purple-900/30 text-purple-400' },
  sonnet: { label: 'Sonnet', color: 'bg-blue-900/30 text-blue-400' },
  haiku: { label: 'Haiku', color: 'bg-green-900/30 text-green-400' },
}

interface Props {
  set: AgentSet
  onDelete?: () => void
}

export function SetStatusCard({ set, onDelete }: Props) {
  const isInactive = set.isActive === false
  const modelInfo = MODEL_BADGE[set.model] ?? MODEL_BADGE.sonnet

  return (
    <div className={`group relative rounded-lg border p-3 transition ${
      isInactive ? 'border-gray-800/50 opacity-50' : 'border-gray-800'
    }`}>
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-3 w-3 rounded-full ${isInactive ? 'opacity-30' : ''}`}
          style={{ backgroundColor: set.color }}
        />
        <span className="text-sm font-medium">{set.name}</span>
        {set.isLeader && <span className="text-xs text-yellow-500">★</span>}
        {set.alias && (
          <span className="text-xs text-gray-500">@{set.alias}</span>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span className="flex items-center gap-1 text-xs text-gray-500">
          <span>{STATUS_ICON[set.status] ?? '?'}</span>
          <span>{isInactive ? '비활성' : (STATUS_LABEL[set.status] ?? set.status)}</span>
        </span>
        {modelInfo && (
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${modelInfo.color}`}>
            {modelInfo.label}
          </span>
        )}
      </div>
      {onDelete && !set.isLeader && (
        <button
          onClick={onDelete}
          className="absolute right-2 top-2 hidden rounded p-0.5 text-gray-600 hover:bg-red-900/30 hover:text-red-400 group-hover:block"
          title="팀 삭제"
        >
          ✕
        </button>
      )}
    </div>
  )
}
