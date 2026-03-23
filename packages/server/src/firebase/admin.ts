import admin from 'firebase-admin'

let initialized = false

export function initFirebase(): void {
  if (initialized) return

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (!serviceAccountJson) {
    console.warn('[Firebase] No service account JSON found. Using default credentials.')
    admin.initializeApp()
  } else {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(serviceAccountJson)),
    })
  }
  initialized = true
}

export function getFirestore(): admin.firestore.Firestore {
  return admin.firestore()
}

export function getAuth(): admin.auth.Auth {
  return admin.auth()
}
