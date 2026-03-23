import type { Message } from '@agent-council/shared'

interface Props {
  messages: Message[]
  onClose: () => void
  onClear: () => Promise<void>
  onExportAll: () => Promise<Message[]>
}

function formatTime(timestamp: Message['timestamp']): string {
  if (!timestamp) return ''
  const date = 'seconds' in timestamp
    ? new Date(timestamp.seconds * 1000)
    : new Date(timestamp as unknown as number)
  return date.toLocaleString('ko-KR')
}

function generateHtml(messages: Message[]): string {
  const rows = messages.map((m) => {
    const time = formatTime(m.timestamp)
    const color = m.senderType === 'human' ? '#60A5FA'
      : m.senderType === 'system' ? '#9CA3AF'
      : (m.metadata?.setColor ?? '#D1D5DB')
    const content = m.content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>')
    return `<div style="margin:12px 0;padding:12px;border-radius:8px;background:#1f2937;border:1px solid #374151">
      <div style="font-size:13px;margin-bottom:6px">
        <span style="color:${color};font-weight:600">${m.senderName}</span>
        <span style="color:#6B7280;margin-left:8px;font-size:11px">${time}</span>
      </div>
      <div style="color:#E5E7EB;font-size:14px;line-height:1.6">${content}</div>
    </div>`
  }).join('\n')

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>Agent Council 대화 백업</title>
<style>body{background:#111827;color:#F9FAFB;font-family:system-ui,sans-serif;max-width:800px;margin:0 auto;padding:24px}
h1{font-size:20px;color:#60A5FA}
.meta{color:#9CA3AF;font-size:12px;margin-bottom:24px}</style>
</head>
<body>
<h1>Agent Council 대화 백업</h1>
<div class="meta">메시지 ${messages.length}개 · 백업일: ${new Date().toLocaleString('ko-KR')}</div>
${rows}
</body>
</html>`
}

function downloadHtml(messages: Message[]) {
  const html = generateHtml(messages)
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `council-backup-${new Date().toISOString().slice(0, 10)}.html`
  a.click()
  URL.revokeObjectURL(url)
}

export function ClearChatModal({ messages, onClose, onClear, onExportAll }: Props) {
  const handleDownloadAndClear = async () => {
    const allMessages = await onExportAll()
    downloadHtml(allMessages)
    await onClear()
    onClose()
  }

  const handleDownloadOnly = async () => {
    const allMessages = await onExportAll()
    downloadHtml(allMessages)
  }

  const handleClearOnly = async () => {
    await onClear()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl border border-gray-700 bg-gray-900 p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold">대화 이력 정리</h2>
        <p className="mt-2 text-sm text-gray-400">
          {messages.length}개의 메시지가 있습니다. 어떻게 하시겠습니까?
        </p>

        <div className="mt-5 space-y-2">
          <button
            onClick={handleDownloadAndClear}
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium hover:bg-blue-700 transition"
          >
            📥 HTML로 다운로드 후 삭제
          </button>
          <button
            onClick={handleDownloadOnly}
            className="w-full rounded-lg border border-gray-700 px-4 py-2.5 text-sm text-gray-300 hover:border-blue-500 hover:text-blue-400 transition"
          >
            📥 다운로드만 (삭제 안 함)
          </button>
          <button
            onClick={handleClearOnly}
            className="w-full rounded-lg border border-red-800 px-4 py-2.5 text-sm text-red-400 hover:bg-red-900/30 transition"
          >
            🗑 바로 삭제 (백업 없이)
          </button>
          <button
            onClick={onClose}
            className="w-full rounded-lg px-4 py-2.5 text-sm text-gray-500 hover:text-white transition"
          >
            취소
          </button>
        </div>
      </div>
    </div>
  )
}
