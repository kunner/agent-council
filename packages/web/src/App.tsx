import { Routes, Route, Navigate } from 'react-router-dom'
import { LoginPage } from './pages/LoginPage'
import { DashboardPage } from './pages/DashboardPage'
import { NewProjectPage } from './pages/NewProjectPage'
import { CouncilRoomPage } from './pages/CouncilRoomPage'
import { useAuthStore } from './stores/authStore'

export function App() {
  const user = useAuthStore((s) => s.user)
  const loading = useAuthStore((s) => s.loading)

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-lg text-gray-400">Loading...</div>
      </div>
    )
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }

  return (
    <Routes>
      <Route path="/" element={<DashboardPage />} />
      <Route path="/new" element={<NewProjectPage />} />
      <Route path="/p/:projectId" element={<CouncilRoomPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
