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

export interface WalletBalance {
  name: string
  address: string
  /** null means the chain read failed, which is not the same as an empty wallet. */
  sui: number | null
  dusdc: number | null
  /** Whether this wallet is meant to hold chips at all, so "n/a" never masks a failed read. */
  chips: boolean
}

export interface BalanceSnapshot {
  asOf: string
  userChips: number | null
  userCount: number
  partial?: string
  wallets: WalletBalance[]
  gasBurnedToday: number | null
}

export interface OverviewReport {
  users: {
    total: number
    newToday: number
    new7d: number
    dau: number
    wau: number
    onboardedPct: number | null
    returningPct: number | null
  }
  plays: {
    today: number
    plays: number
    settled: number
    byGame: Array<{ game: string; plays: number; volume: number }>
    avgStake: number | null
    avgMultiplier: number | null
    winRatePct: number | null
    volume: number
    playerNetPnl: number
    netHousePnl: number
    rake: number
  }
  money: {
    balances: BalanceSnapshot | null
    depositsByChain: Array<{ chain: string; count: number; done: number }>
    withdrawals: { count: number; amount: number }
    faucetOut: number
    grantOut: number
  }
  chain: {
    liveMarkets: number
    wallets: WalletBalance[]
    gasBurnedToday: number | null
    costPerPlaySui: number | null
    network: string
  }
  sparklines: { plays: Array<{ t: number; n: number }>; errors: Array<{ t: number; n: number }> }
  generatedAt: string
}

export interface LiveRow {
  id: string
  username: string | null
  displayName: string
  avatarUrl: string | null
  address: string
  /** Holding an open stream connection right now. False means "was here, tab is closed". */
  live: boolean
  sessions: number
  since: number | null
  lastSeenAt: number
  /** Last thing they actually did, at any age. null = nothing on record, not the same as idle now. */
  lastActiveAt: number | null
  doing: string
  platform: string | null
  plays: number
  /** DUSDC committed in the window. */
  staked: number
  pnl: number
}

export interface LiveReport {
  online: { users: number; sessions: number }
  windowMin: number
  /** Width of one bar in playsSeries, so the axis is told what it shows instead of guessing. */
  bucketMs: number
  unit: 'minute' | 'hour'
  rows: LiveRow[]
  truncated: number
  playsSeries: Array<{ t: number; n: number }>
  window: { players: number; plays: number; staked: number }
  generatedAt: string
}

export interface LatencyPoint {
  t: number
  n: number
  p50: number | null
  p95: number | null
}

export interface PerfReport {
  windowHours: number
  mint: { series: LatencyPoint[]; p50: number | null; p95: number | null; n: number }
  settle: { series: LatencyPoint[]; p50: number | null; p95: number | null; n: number }
  routes: Array<{ route: string; n: number; p50: number | null; p95: number | null; max: number | null }>
  workers: Array<{
    name: string
    lastRunAt: number | null
    lastSuccessAt: number | null
    lastDurationMs: number | null
    intervalMs: number | null
    stale: boolean
    lastError: string | null
  }>
  generatedAt: string
}

export interface RetentionPreview {
  key: string
  current: number
  next: number
  widening: boolean
  deletes: number
  oldest: string | null
  newest: string | null
  confirm: string | null
  noun: string
}

export interface SettingRow {
  key: string
  type: string
  def: boolean | number
  min?: number
  max?: number
  destructive: boolean
  value: boolean | number
  label?: string
}

export type OpsLevel = 'ok' | 'warn' | 'critical'

export interface DetectorStatus {
  key: string
  title: string
  level: OpsLevel
  value: number | null
  display: string
  warn: number
  critical: number
  runbook: string
  detail?: string
  checkedAt: string
}

export interface OpsSnapshot {
  checkedAt: string
  worst: OpsLevel
  detectors: DetectorStatus[]
}
