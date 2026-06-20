// Typed backend client. One place owns the envelope unwrap, the Bearer header, and the SSE
// helpers. Everything returns plain DTOs or throws ApiError(code, message); the UI maps the
// code to a friendly toast. DTO shapes mirror backend/src/types/api.ts.

import { env } from '@/env'
import { isDemo, demoApi, demoStreamPrices, demoStreamPlay } from './demo'

const BASE = env.VITE_API_URL

// === DTOs (mirror the backend) ===

export type Game = 'lucky' | 'range'
export type PlayStatus = 'pending' | 'open' | 'won' | 'lost' | 'cashed_out' | 'error'
export type Side = 'up' | 'down'

export interface UserDTO {
  id: string
  address: string
  displayName: string
  username: string | null
  provider: 'privy' | 'dev'
  balance: string
  managerReady: boolean
  settings: { sound: boolean; haptics: boolean; reducedMotion: boolean }
}

export interface MarketDTO {
  asset: string
  spot: string
  durations: number[]
  live: boolean
}

export interface LuckyParams {
  asset: string
  side: Side
  multiplier: number
  duration: number
}
export interface RangeParams {
  asset: string
  lower: string
  upper: string
  widthPct: number
  duration: number
}

export interface PlayDTO {
  id: string
  game: Game
  status: PlayStatus
  stake: string
  params: LuckyParams | RangeParams
  market: { asset: string; oracleId: string; expiry: number; strike?: string; lower?: string; upper?: string }
  entryValue: string
  markValue: string
  pnl: string
  multiplier: number
  payout?: string
  // Spot at entry (the price the strike was solved against). The chart's ENTRY line + the live P/L
  // anchor to this so entry, target, and settlement always agree.
  entrySpot?: string
  settlePrice?: string
  openedAt?: string
  settledAt?: string
  txMint?: string
  txRedeem?: string
}

export interface UserStatsDTO {
  gamesPlayed: number
  wins: number
  losses: number
  winRate: number
  currentStreak: number
  maxStreak: number
  totalVolume: string
  netPnl: string
  firstPlayAt?: string
  favoriteGame?: Game
}

export interface AchievementDTO {
  slug: string
  name: string
  description: string
  illo: string
  unlocked: boolean
  unlockedAt?: string
  progress?: { current: number; target: number }
}

// Both auth modes finalize server-side, so play + cashout always come back resolved.
export type PlayResult = { play: PlayDTO }
export type CashoutResult = { play: PlayDTO; unlocked: string[] }
// POST /wallet/withdraw -> the refreshed user (new balance) + the on-chain tx digest.
export type WithdrawResult = { user: UserDTO; digest: string }
export interface WithdrawInput {
  recipient: string
  amount: string
}
export interface PrivyVerifyInput {
  token: string
  email?: string
}

// === Core ===

export class ApiError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

let authToken: string | null = null
export const setAuthToken = (token: string | null): void => {
  authToken = token
}
export const getAuthToken = (): string | null => authToken

interface Envelope<T> {
  success: boolean
  error: { code: string; message: string } | null
  data: T
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError('NETWORK_ERROR', 'Cannot reach the server', 0)
  }

  let json: Envelope<T>
  try {
    json = (await res.json()) as Envelope<T>
  } catch {
    throw new ApiError('BAD_RESPONSE', 'The server returned an unexpected response', res.status)
  }

  if (!res.ok || !json.success) {
    throw new ApiError(json.error?.code ?? 'UNKNOWN', json.error?.message ?? 'Something went wrong', res.status)
  }
  return json.data
}

// === Endpoints ===

const realApi = {
  // auth
  authDev: () => request<{ token: string; user: UserDTO }>('POST', '/auth/dev', {}),
  authPrivyVerify: (input: PrivyVerifyInput) => request<{ token: string; user: UserDTO }>('POST', '/auth/privy/verify', input),
  me: () => request<{ user: UserDTO }>('GET', '/auth/me'),
  setUsername: (username: string) => request<{ user: UserDTO }>('PATCH', '/auth/me', { username }),

  // markets + plays
  markets: () => request<{ markets: MarketDTO[] }>('GET', '/markets'),
  play: (game: Game, body: Record<string, unknown>) => request<PlayResult>('POST', `/games/${game}/play`, body),
  cashout: (playId: string) => request<CashoutResult>('POST', `/plays/${playId}/cashout`, {}),
  plays: (q: { status?: string; limit?: number } = {}) => {
    const params = new URLSearchParams()
    if (q.status) params.set('status', q.status)
    if (q.limit) params.set('limit', String(q.limit))
    const qs = params.toString()
    return request<{ plays: PlayDTO[] }>('GET', `/plays${qs ? `?${qs}` : ''}`)
  },
  getPlay: (playId: string) => request<{ play: PlayDTO }>('GET', `/plays/${playId}`),

  // wallet
  withdraw: (input: WithdrawInput) => request<WithdrawResult>('POST', '/wallet/withdraw', input),

  // menu
  stats: () => request<{ stats: UserStatsDTO }>('GET', '/stats'),
  achievements: () => request<{ achievements: AchievementDTO[] }>('GET', '/achievements'),
  settings: () => request<{ settings: UserDTO['settings'] }>('GET', '/settings'),
  patchSettings: (body: Partial<UserDTO['settings']>) => request<{ settings: UserDTO['settings'] }>('PATCH', '/settings', body),
}

// Demo mode swaps the whole client for an in-memory mock (no server, no chain). Resolved per
// call so a runtime toggle takes effect without rebuilding the api binding everyone imported.
export const api: typeof realApi = new Proxy(realApi, {
  get(target, prop, receiver) {
    if (isDemo()) {
      const mock = (demoApi as Record<string | symbol, unknown>)[prop]
      if (typeof mock === 'function') return mock.bind(demoApi)
    }
    return Reflect.get(target, prop, receiver)
  },
})

// === SSE ===

// EventSource cannot set headers, so the token rides the query string. Returns an unsubscribe.
function stream<T>(path: string, onData: (data: T) => void, onError?: () => void): () => void {
  if (!authToken) {
    onError?.()
    return () => {}
  }
  const sep = path.includes('?') ? '&' : '?'
  const es = new EventSource(`${BASE}${path}${sep}t=${encodeURIComponent(authToken)}`)
  es.onmessage = (e) => {
    try {
      onData(JSON.parse(e.data) as T)
    } catch {
      // ignore a malformed frame, the next one will arrive
    }
  }
  es.onerror = () => onError?.()
  return () => es.close()
}

export type PriceTick = { price: string; ts: number }
export type PlayTick = { markValue: string; pnl: string; multiplier: number; status: PlayStatus; ts: number }

export const streamPrices = (asset: string, onTick: (t: PriceTick) => void, onError?: () => void): (() => void) =>
  isDemo()
    ? demoStreamPrices(asset, onTick)
    : stream<PriceTick>(`/stream/prices?asset=${encodeURIComponent(asset)}`, onTick, onError)

export const streamPlay = (playId: string, onTick: (t: PlayTick) => void, onError?: () => void): (() => void) =>
  isDemo()
    ? demoStreamPlay(playId, onTick, onError)
    : stream<PlayTick>(`/stream/plays/${playId}`, onTick, onError)
