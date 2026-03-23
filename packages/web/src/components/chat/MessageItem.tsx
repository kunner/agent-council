import type { Message } from '@agent-council/shared'
import ReactMarkdown from 'react-markdown'

function formatTime(timestamp: Message['timestamp']): string {
  if (!timestamp) return ''
  // Firestore Timestamp has seconds field
  const date = 'seconds' in timestamp
    ? new Date(timestamp.seconds * 1000)
    : new Date(timestamp as unknown as number)
  return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
}

interface Props {
  message: Message
}

export function MessageItem({ message }: Props) {
  const { senderType, senderName, content, metadata, timestamp } = message
  const time = formatTime(timestamp)

  if (senderType === 'system') {
    return (
      <div className="mx-auto max-w-xl rounded-lg bg-gray-900/50 border border-gray-800 px-4 py-2 text-center text-sm text-gray-400">
        <span className="mr-1">⚙️</span>
        {content}
        {time && <span className="ml-2 text-xs text-gray-600">{time}</span>}
      </div>
    )
  }

  const isHuman = senderType === 'human'
  const setColor = metadata?.setColor ?? '#6B7280'

  return (
    <div className={`flex ${isHuman ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-lg px-4 py-3 ${
          isHuman
            ? 'bg-blue-900/30 border border-blue-800/50'
            : 'bg-gray-900/50 border border-gray-800'
        }`}
      >
        <div className="mb-1.5 flex items-center gap-2 text-sm font-medium">
          {!isHuman && (
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: setColor }}
            />
          )}
          <span style={{ color: isHuman ? '#60A5FA' : setColor }}>
            {senderName}
          </span>
          {time && <span className="text-xs text-gray-600">{time}</span>}
        </div>
        <div className="prose prose-invert prose-sm max-w-none [&_pre]:bg-gray-800 [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:overflow-x-auto [&_pre]:text-sm [&_code]:text-emerald-400 [&_code]:text-sm [&_pre_code]:text-gray-300 [&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5 [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_blockquote]:border-gray-600 [&_a]:text-blue-400">
          <ReactMarkdown>{content}</ReactMarkdown>
        </div>
        {metadata?.artifacts && metadata.artifacts.length > 0 && (
          <div className="mt-2 flex items-center gap-1 text-xs text-gray-500">
            <span>📎</span>
            <span>{metadata.artifacts.join(', ')}</span>
          </div>
        )}
        {metadata?.commitHash && (
          <div className="mt-1 flex items-center gap-1 text-xs text-gray-500">
            <span>🔗</span>
            <span>commit: {metadata.commitHash.slice(0, 7)}</span>
          </div>
        )}
      </div>
    </div>
  )
}
