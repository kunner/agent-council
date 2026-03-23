import type { AgentSet } from '@agent-council/shared'

interface Props {
  sets: AgentSet[]
  query: string
  onSelect: (mention: string) => void
  position: { bottom: number; left: number }
}

export function MentionPopover({ sets, query, onSelect, position }: Props) {
  const allOption = { id: 'all', name: '전체', alias: 'all', color: '#6B7280' }

  const options = [
    allOption,
    ...sets.map((s) => ({ id: s.id, name: s.name, alias: (s as any).alias || '', color: s.color })),
  ]

  const filtered = options.filter((o) => {
    const q = query.toLowerCase()
    return (
      o.name.toLowerCase().includes(q) ||
      o.alias.toLowerCase().includes(q)
    )
  })

  if (filtered.length === 0) return null

  return (
    <div
      className="absolute z-50 w-56 rounded-lg border border-gray-700 bg-gray-900 py-1 shadow-xl"
      style={{ bottom: position.bottom, left: position.left }}
    >
      {filtered.map((o) => (
        <button
          key={o.id}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-800 transition"
          onClick={() => onSelect(o.alias || o.name)}
        >
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: o.color }}
          />
          <span className="font-medium">{o.name}</span>
          {o.alias && <span className="text-xs text-gray-500">@{o.alias}</span>}
        </button>
      ))}
    </div>
  )
}
