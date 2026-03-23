import { signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth'
import { auth } from '../firebase/config'

const googleProvider = new GoogleAuthProvider()

export function useAuth() {
  const loginWithGoogle = async () => {
    await signInWithPopup(auth, googleProvider)
  }

  const logout = async () => {
    await signOut(auth)
  }

  return { loginWithGoogle, logout }
}
