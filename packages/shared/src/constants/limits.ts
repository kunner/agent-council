export const FIRESTORE_LIMITS = {
  DAILY_READS: 50_000,
  DAILY_WRITES: 20_000,
  STORAGE_GB: 1,
} as const

export const SESSION_TIMEOUTS = {
  PM_AWAY_KEEP_ALIVE_MS: 30 * 60 * 1000,       // 30 minutes
  PM_AWAY_WIND_DOWN_MS: 2 * 60 * 60 * 1000,     // 2 hours
  CLAUDE_RESPONSE_TIMEOUT_MS: 120 * 1000,        // 2 minutes
  HEARTBEAT_INTERVAL_MS: 30 * 1000,              // 30 seconds
  SNAPSHOT_AUTO_INTERVAL_MS: 30 * 60 * 1000,     // 30 minutes
} as const

export const MAX_CONCURRENT_SESSIONS = 8
