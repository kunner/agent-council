import { useState } from 'react'

interface Props {
  onClose: () => void
  onSubmit: (data: { name: string; role: string; alias: string }) => Promise<void>
}

const PRESETS = [
  { name: '아키텍처팀', alias: 'arch', emoji: '🎯', color: '#8B5CF6', role: '전체 시스템 설계, DB 스키마, API 스펙, 기술 의사결정을 담당합니다.' },
  { name: '백엔드팀',   alias: 'be',   emoji: '🟢', color: '#22C55E', role: '서버 API 구현, 데이터베이스 연동, 비즈니스 로직 개발을 담당합니다.' },
  { name: '프론트팀',   alias: 'fe',   emoji: '🔵', color: '#3B82F6', role: 'UI/UX 구현, React 컴포넌트 개발, 사용자 인터페이스를 담당합니다.' },
  { name: 'QA팀',       alias: 'qa',   emoji: '🟡', color: '#EAB308', role: '테스트 코드 작성, 코드 리뷰, 품질 검증, 버그 탐색을 담당합니다.' },
  { name: 'DevOps팀',   alias: 'devops', emoji: '🟠', color: '#F97316', role: '배포 파이프라인, 인프라 관리, CI/CD, 모니터링을 담당합니다.' },
  { name: '보안팀',     alias: 'sec',  emoji: '🔴', color: '#EF4444', role: '보안 취약점 분석, 인증/인가, 데이터 보호를 담당합니다.' },
]

export function SetCreateModal({ onClose, onSubmit }: Props) {
  const [name, setName] = useState('')
  const [alias, setAlias] = useState('')
  const [role, setRole] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handlePreset = (preset: typeof PRESETS[number]) => {
    setName(preset.name)
    setAlias(preset.alias)
    setRole(preset.role)
    setSelected(preset.name)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name || !role) return
    setSubmitting(true)
    try {
      await onSubmit({ name, role, alias })
      onClose()
    } catch (err) {
      console.error(err)
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl border border-gray-700 bg-gray-900 p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold">에이전트 팀 추가</h2>
        <p className="mt-1 text-sm text-gray-400">Council에 참여할 AI 리더 팀을 구성합니다</p>

        <div className="mt-4">
          <p className="mb-2 text-xs text-gray-500">빠른 선택</p>
          <div className="grid grid-cols-3 gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => handlePreset(p)}
                className={`flex items-center gap-2 rounded-lg border p-3 text-left text-sm transition ${
                  selected === p.name
                    ? 'border-blue-500 bg-blue-500/10'
                    : 'border-gray-700 hover:border-gray-500'
                }`}
              >
                <span className="text-lg">{p.emoji}</span>
                <div>
                  <div className="font-medium" style={{ color: p.color }}>{p.name}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-3">
          <div>
            <label className="block text-sm text-gray-400">팀 이름</label>
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); setSelected(null) }}
              placeholder="직접 입력하거나 위에서 선택"
              required
              className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400">별칭 (@멘션용)</label>
            <input
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="@arch, @be 등"
              className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400">역할 설명</label>
            <textarea
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="이 팀의 리더가 어떤 역할을 맡는지 설명해주세요"
              required
              rows={3}
              className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-400 hover:text-white transition"
            >
              취소
            </button>
            <button
              type="submit"
              disabled={submitting || !name || !role}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition"
            >
              {submitting ? '생성 중...' : '팀 생성'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
