import type { Message } from '@agent-council/shared'
import ReactMarkdown from 'react-markdown'

interface Props {
  message: Message
}

export function MessageItem({ message }: Props) {
  const { senderType, senderName, content, metadata } = message

  if (senderType === 'system') {
    return (
      <div className="mx-auto max-w-xl rounded-lg bg-gray-900 px-4 py-2 text-center text-sm text-gray-400">
        <span className="mr-1">⚙️</span>
        {content}
      </div>
    )
  }

  const isHuman = senderType === 'human'
  const setColor = metadata?.setColor ?? '#6B7280'

  return (
    <div className={`flex ${isHuman ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[75%] rounded-lg px-4 py-3 ${
          isHuman
            ? 'bg-blue-900/40 border border-blue-800'
            : 'bg-gray-900 border border-gray-800'
        }`}
      >
        <div className="mb-1 flex items-center gap-2 text-sm font-medium">
          {!isHuman && (
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: setColor }}
            />
          )}
          <span style={{ color: isHuman ? '#60A5FA' : setColor }}>
            {senderName}
          </span>
        </div>
        <div className="prose prose-invert prose-sm max-w-none">
          <ReactMarkdown>{content}</ReactMarkdown>
        </div>
        {metadata?.artifacts && metadata.artifacts.length > 0 && (
          <div className="mt-2 text-xs text-gray-500">
            📎 {metadata.artifacts.join(', ')}
          </div>
        )}
      </div>
    </div>
  )
}
