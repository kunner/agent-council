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

interface Props {
  set: AgentSet
}

export function SetStatusCard({ set }: Props) {
  return (
    <div className="rounded-lg border border-gray-800 p-3">
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-3 w-3 rounded-full"
          style={{ backgroundColor: set.color }}
        />
        <span className="text-sm font-medium">{set.name}</span>
      </div>
      <div className="mt-1 flex items-center gap-1 text-xs text-gray-500">
        <span>{STATUS_ICON[set.status] ?? '?'}</span>
        <span>{STATUS_LABEL[set.status] ?? set.status}</span>
      </div>
    </div>
  )
}
