import { create } from 'zustand'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { auth } from '../firebase/config'

interface AuthState {
  user: User | null
  loading: boolean
  idToken: string | null
}

export const useAuthStore = create<AuthState>((set) => {
  // Listen to auth state changes
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      const token = await user.getIdToken()
      set({ user, loading: false, idToken: token })
    } else {
      set({ user: null, loading: false, idToken: null })
    }
  })

  return {
    user: null,
    loading: true,
    idToken: null,
  }
})
