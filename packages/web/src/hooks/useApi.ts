import { useAuthStore } from '../stores/authStore'

const API_BASE = import.meta.env.VITE_SERVER_URL ?? ''

export function useApi() {
  const idToken = useAuthStore((s) => s.idToken)

  const fetchApi = async (path: string, options?: RequestInit) => {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
        ...options?.headers,
      },
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(err.error ?? 'API Error')
    }

    return res.json()
  }

  return { fetchApi }
}
