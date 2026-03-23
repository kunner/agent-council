import { useAuth } from '../hooks/useAuth'

export function LoginPage() {
  const { loginWithGoogle } = useAuth()

  return (
    <div className="flex h-screen items-center justify-center">
      <div className="w-full max-w-sm space-y-6 text-center">
        <div>
          <h1 className="text-3xl font-bold">Agent Council</h1>
          <p className="mt-2 text-gray-400">
            AI 에이전트 팀이 협업하는 개발 플랫폼
          </p>
        </div>
        <button
          onClick={loginWithGoogle}
          className="w-full rounded-lg bg-white px-6 py-3 text-gray-900 font-medium hover:bg-gray-100 transition"
        >
          Google로 로그인
        </button>
      </div>
    </div>
  )
}
