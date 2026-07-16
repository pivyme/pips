// Typed backend client. One place owns the envelope unwrap, the Bearer header, and the SSE
// helpers. Everything returns plain DTOs or throws ApiError(code, message); the UI maps the
// code to a friendly toast. DTO shapes mirror backend/src/types/api.ts.

import { env } from '@/env'
import { isDemo, demoApi, demoStreamPrices, demoStreamPlay, demoStreamLive } from './demo'
import { readRef } from './referral'

const BASE = env.VITE_API_URL

// === DTOs (mirror the backend) ===

export type Game = 'lucky' | 'range' | 'moonshot'
export type PlayStatus = 'pending' | 'open' | 'won' | 'lost' | 'cashed_out' | 'error'
export type Side = 'up' | 'down'

export interface UserDTO {
  id: string
  address: string
  displayName: string
  username: string | null
  email: string | null // login email (Privy Google/email sign-in); null for dev/wallet
  twitter: { username: string; name: string | null } | null // linked X account, server-verified via Privy
  provider: 'privy' | 'dev' | 'wallet'
  // wallet-connect: the connected external wallet (login + default withdraw target).
  walletAuthAddress?: string
  avatarUrl: string | null // custom uploaded avatar, or null (the client renders the PIPS identicon)
  customAvatar: boolean // a custom upload is set (drives the remove-X in the profile editor)
  balance: string
  managerReady: boolean
  settings: { sound: boolean; haptics: boolean; reducedMotion: boolean; confirmTrades: boolean; theme: string }
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

// Pre-mint Range price preview: the real multiple read off the live Predict ask for the grid-snapped
// band, so the knob shows what it will actually mint, not a blind estimate.
export interface RangeQuote {
  multiplier: number
  lower: string
  upper: string
  entrySpot: string
  duration: number
  widthPct: number
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
  maxPayout: string
  payout?: string
  // Spot at entry (the price the strike was solved against). The chart's ENTRY line + the live P/L
  // anchor to this so entry, target, and settlement always agree.
  entrySpot?: string
  settlePrice?: string // exact expiry settlement price; absent for cash-outs
  // Exact oracle settlement_price after the settlement transaction lands, while redeem/finalization
  // may still be in progress.
  lockPrice?: string
  openedAt?: string
  settledAt?: string
  txMint?: string
  txRedeem?: string
  txSettle?: string
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
// POST /wallet/request-dusdc -> the refreshed user, the amount handed out, and the tx digest.
export type FaucetResult = { user: UserDTO; amount: string; digest: string }
export interface PrivyVerifyInput {
  token: string
  email?: string
  referralCode?: string
}
// Wallet-connect login (custodial play-wallet model): get a challenge, sign it with the connected
// wallet, send the signature back for a session.
export interface WalletVerifyInput {
  address: string
  signature: string
  referralCode?: string
}

// === Referrals === (track-only, see .claude/REFERRALS.md: no payout, no public profile page)

export interface ReferralDTO {
  handle: string // referee's username, falling back to displayName if they never onboarded
  joinedAt: string
  plays: number
}
export interface ReferralInfoDTO {
  code: string // the anon-format token (/r/CODE)
  anon: boolean // link format: false = /@username, true = /r/CODE
  username: string | null // for building the /@username link; null if not onboarded
  count: number
  referrals: ReferralDTO[]
}
export interface ReferralResolveDTO {
  valid: boolean
  handle: string | null // null for an anon link or an unknown token
}

// === Leaderboards === (every row exposes username/displayName, never an address)

export type Minigame = 'line-rider' | 'flappy-piper'

export interface LeaderboardPnlEntry {
  rank: number
  username: string | null
  displayName: string
  avatarUrl: string | null
  netPnl: string // signed DUSDC
  gamesPlayed: number
  isYou: boolean
  twitterVerified: boolean
}
export interface LeaderboardGameEntry {
  rank: number
  username: string | null
  displayName: string
  avatarUrl: string | null
  pnl: string // signed summed DUSDC for the game (gainers positive, rekt negative)
  plays: number
  isYou: boolean
  twitterVerified: boolean
}
export interface LeaderboardScoreEntry {
  rank: number
  username: string | null
  displayName: string
  avatarUrl: string | null
  score: number
  isYou: boolean
  twitterVerified: boolean
}
export interface GlobalLeaderboard {
  gainers: LeaderboardPnlEntry[]
  rekt: LeaderboardPnlEntry[]
  you: { gainerRank: number | null; rektRank: number | null; netPnl: string; gamesPlayed: number }
}
export interface GameLeaderboard {
  entries: LeaderboardGameEntry[] // top gainers, most profit first
  rekt: LeaderboardGameEntry[] // top REKT, deepest in the red first
}
export interface MinigameLeaderboard {
  entries: LeaderboardScoreEntry[]
  best: number
}
export interface MinigameSubmit {
  entries: LeaderboardScoreEntry[]
  rank: number
  best: number
  isBest: boolean
  prevBest: number
}
// One combined payload for the menu leaderboard, so tab switches are instant (no refetch).
export interface FullLeaderboard {
  global: GlobalLeaderboard
  games: Record<Game, LeaderboardGameEntry[]>
  minigames: Record<Minigame, MinigameLeaderboard>
}

// === Core ===

export class ApiError extends Error {
  code: string
  status: number
  // The backend's underlying cause (dev only: server sends it under IS_DEV). Surfaced in the
  // sign-in error sheet so a reviewer sees the real reason, not just "something went wrong".
  details?: string
  constructor(code: string, message: string, status: number, details?: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.details = details
  }
}

let authToken: string | null = null
export const setAuthToken = (token: string | null): void => {
  authToken = token
}
export const getAuthToken = (): string | null => authToken

// After a devnet refresh the backend re-arms users (their PredictManager is nulled), so a live
// session 409s MANAGER_NOT_READY on every play until it re-logs-in. The auth layer registers a
// handler here to bounce a stale session to the door the moment the backend reports it.
let onManagerNotReady: (() => void) | null = null
export const setManagerNotReadyHandler = (fn: (() => void) | null): void => {
  onManagerNotReady = fn
}

interface Envelope<T> {
  success: boolean
  error: { code: string; message: string; details?: string } | null
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
    if (json.error?.code === 'MANAGER_NOT_READY') onManagerNotReady?.()
    throw new ApiError(
      json.error?.code ?? 'UNKNOWN',
      json.error?.message ?? 'Something went wrong',
      res.status,
      json.error?.details,
    )
  }
  return json.data
}

// === Endpoints ===

const realApi = {
  // auth. readRef() threads a stashed referral token into every login path; the backend only ever
  // attributes it on account creation (see auth.ts ensureUser/ensureWalletUser), so this is a no-op
  // for a returning user.
  authDev: () => request<{ token: string; user: UserDTO }>('POST', '/auth/dev', { referralCode: readRef() ?? undefined }),
  authPrivyVerify: (input: PrivyVerifyInput) => request<{ token: string; user: UserDTO }>('POST', '/auth/privy/verify', input),
  authWalletNonce: (address: string) => request<{ message: string }>('POST', '/auth/wallet/nonce', { address }),
  authWalletVerify: (input: WalletVerifyInput) => request<{ token: string; user: UserDTO }>('POST', '/auth/wallet/verify', input),
  me: () => request<{ user: UserDTO }>('GET', '/auth/me'),
  // Re-provision a re-armed session in place (new PredictManager + re-funded chips). Called to self-heal
  // a stale session after a devnet refresh instead of forcing a full re-login.
  authHeal: () => request<{ user: UserDTO }>('POST', '/auth/heal'),
  setUsername: (username: string) => request<{ user: UserDTO }>('PATCH', '/auth/me', { username }),
  // Re-read linked Google/email/X state from Privy and persist it. Call after every successful
  // link/unlink so the DB (and the leaderboard badge) never trusts a client-reported handle.
  linkRefresh: () => request<{ user: UserDTO }>('POST', '/auth/link/refresh'),
  // Avatar: upload a client-shrunk 500x500 webp data URL, or remove the custom one (revert to default).
  uploadAvatar: (dataUrl: string) => request<{ user: UserDTO }>('POST', '/avatar', { image: dataUrl }),
  removeAvatar: () => request<{ user: UserDTO }>('DELETE', '/avatar'),

  // markets + plays. `playsPaused` is the real-mode sponsor-floor pause (always false in fork/demo):
  // when true, new plays are blocked while the gas sponsor tops up, and the games show a paused state.
  markets: () => request<{ markets: MarketDTO[]; playsPaused?: boolean }>('GET', '/markets'),
  // Price the whole band ladder for an asset in one call (full-band widths %). Cached on select so
  // every band size shows its real multiple instantly, no estimate fallback.
  rangeQuotes: (asset: string, widthPcts: number[]) =>
    request<{ quotes: RangeQuote[] }>('GET', `/games/range/quotes?asset=${encodeURIComponent(asset)}&widths=${widthPcts.join(',')}`),
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
  requestDusdc: () => request<FaucetResult>('POST', '/wallet/request-dusdc', {}),

  // referrals
  referral: () => request<ReferralInfoDTO>('GET', '/referral'),
  setReferralAnon: (anon: boolean) => request<ReferralInfoDTO>('PATCH', '/referral', { anon }),
  resolveReferral: (token: string) => request<ReferralResolveDTO>('GET', `/referral/resolve?ref=${encodeURIComponent(token)}`),

  // menu
  stats: () => request<{ stats: UserStatsDTO }>('GET', '/stats'),
  achievements: () => request<{ achievements: AchievementDTO[] }>('GET', '/achievements'),
  settings: () => request<{ settings: UserDTO['settings'] }>('GET', '/settings'),
  patchSettings: (body: Partial<UserDTO['settings']>) => request<{ settings: UserDTO['settings'] }>('PATCH', '/settings', body),

  // leaderboards
  leaderboard: () => request<{ leaderboard: FullLeaderboard }>('GET', '/leaderboard'),
  gameLeaderboard: (game: Game) => request<{ leaderboard: GameLeaderboard }>('GET', `/leaderboard/game/${game}`),
  minigameLeaderboard: (game: Minigame) => request<{ leaderboard: MinigameLeaderboard }>('GET', `/leaderboard/minigame/${game}`),
  // Open a run before playing; the returned token is passed to submitMinigameScore.
  startMinigameRun: (game: Minigame) => request<{ runToken: string }>('POST', `/leaderboard/minigame/${game}/start`),
  submitMinigameScore: (game: Minigame, score: number, runToken?: string | null) =>
    request<{ result: MinigameSubmit }>('POST', `/leaderboard/minigame/${game}`, { score, runToken }),
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
export type PlayTick = {
  markValue: string
  pnl: string
  multiplier: number
  entryValue?: string
  maxPayout?: string
  status: PlayStatus
  lockPrice?: string
  ts: number
}
// Live presence: how many players have PIPS open right now. Pushed on every join/leave.
export type LiveTick = { online: number }

export const streamPrices = (asset: string, onTick: (t: PriceTick) => void, onError?: () => void): (() => void) =>
  isDemo()
    ? demoStreamPrices(asset, onTick)
    : stream<PriceTick>(`/stream/prices?asset=${encodeURIComponent(asset)}`, onTick, onError)

export const streamPlay = (playId: string, onTick: (t: PlayTick) => void, onError?: () => void): (() => void) =>
  isDemo()
    ? demoStreamPlay(playId, onTick, onError)
    : stream<PlayTick>(`/stream/plays/${playId}`, onTick, onError)

export const streamLive = (onTick: (t: LiveTick) => void, onError?: () => void): (() => void) =>
  isDemo() ? demoStreamLive(onTick) : stream<LiveTick>('/stream/live', onTick, onError)
