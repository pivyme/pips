// DTOs shared with backend/src/services/insights.ts, plus the SPECIAL_ROLES twin. The backend is the
// source of truth; `bun run check:admin` fails the gate if these drift (Addendum A2).

// Twin of backend/src/config/roles.ts SPECIAL_ROLES. Keep the literal array on one line, the drift check
// parses it.
export const SPECIAL_ROLES = ['ADMIN', 'KOL', 'BETA_TESTER'] as const
export type SpecialRole = (typeof SPECIAL_ROLES)[number]

export type ErrorStatus = 'open' | 'ack' | 'resolved' | 'ignored'
export type ErrorLevel = 'fatal' | 'error' | 'warn'
export type ErrorKind = 'http' | 'worker' | 'chain' | 'client' | 'job'

export interface ErrorGroupRow {
  fingerprint: string
  title: string
  culprit: string | null
  kind: string
  level: string
  count: number
  usersAffected: number
  firstSeen: string
  lastSeen: string
  status: string
  firstRelease: string | null
  lastRelease: string | null
  notes: string | null
  trend: 'up' | 'down' | 'flat'
  last24h: number
}

export interface ErrorSample {
  id: string
  message: string
  stack: string | null
  context: unknown
  userId: string | null
  sessionId: string | null
  requestId: string | null
  method: string | null
  path: string | null
  playId: string | null
  release: string | null
  network: string | null
  createdAt: string
}

export interface ErrorDetail {
  group: ErrorGroupRow
  samples: ErrorSample[]
  occurrences: Array<{ t: number; n: number }>
  users: Array<{ id: string; username: string | null }>
  plays: Array<{ id: string; game: string; status: string; stake: string; createdAt: string }>
}

export interface AdminPing {
  ok: boolean
  user: { id?: string; username: string | null }
  network: string
  analyticsEnabled: boolean
}

export interface FunnelStepRow {
  key: string
  label: string
  subjects: number
  dropPct: number
  skipped: boolean
}

export interface UsageReport {
  windowDays: number
  events: Array<{ name: string; count: number }>
  funnel: FunnelStepRow[]
  games: Array<{ game: string; opens: number; plays: number; conversionPct: number }>
  menu: Array<{ section: string; count: number }>
  cohorts: Array<{ date: string; signups: number; d1: number; d7: number; d1Pct: number; d7Pct: number }>
  totalEvents: number
}
