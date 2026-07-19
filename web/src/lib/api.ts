// Typed backend client. One place owns the envelope unwrap, Bearer header, and SSE helpers; everything
// returns plain DTOs or throws ApiError(code, message). DTO shapes mirror backend/src/types/api.ts.

import { env } from '@/env'
import { isDemo, demoApi, demoStreamPrices, demoStreamPlay, demoStreamLive, demoStreamMarkets } from './demo'
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

// Pre-mint Range price preview: the real multiple read off the live Predict ask for the grid-snapped band, not a blind estimate.
export interface RangeQuote {
  multiplier: number
  lower: string
  upper: string
  entrySpot: string
  duration: number
  widthPct: number
}

// RANGE payout-tier quote: the multiplier is time-independent (1x leverage, ~1/prob); the band width is
// what tracks the clock. sigmaMult + expiryMs + model let the client redraw the live width between fetches.
export interface RangeTierQuote {
  tier: number // ladder index, echoed back on play
  prob: number // target win probability, the honest odds
  multiplier: number // stable payout multiple (spread haircut applied)
  sigmaMult: number // half-width in sigmas: half = sigmaMult * sigma(secsLeft)
  halfPct: number // effective half-band % at quote time
  lower: string
  upper: string
  entrySpot: string
  duration: number
  expiryMs: number // absolute buzzer, drives the round clock + live band decay
}
export interface RangeQuoteModel {
  annualVol: number // sigma(t) = annualVol * sqrt(t / yearSeconds)
  minRoundMs: number // taps closer than this to the buzzer route to the next round
}

// MOONSHOT aim preview: the strike offset each reach mints at, so the aimed TARGET line lands where the strike
// lands. offsetFrac = |strike - entry| / entry; the client applies the dialed side's sign and the live spot.
export interface MoonshotAim {
  reach: number
  offsetFrac: number
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
  // Spot at entry (the price the strike was solved against); the chart's ENTRY line + live P/L anchor to this.
  entrySpot?: string
  settlePrice?: string // exact expiry settlement price; absent for cash-outs
  // Exact oracle settlement_price once the settlement tx lands, while redeem/finalization may still be in progress.
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
  bestMultiplier: number // biggest realized payout multiple on a win, 0 if none
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
// === Deposit (mirrors backend/src/types/api.ts) ===

// Everything the deposit drawer renders itself from. Server-owned so the CTA gate and the catalog can
// never drift from the backend or be unlocked from the browser.
export interface DepositOptionsDTO {
  chipSymbol: string // what tops up the balance today (DUSDC on testnet/fork, USDC on mainnet)
  chipNetwork: string // always 'sui': the address just receives it, nothing to bridge
  bridgeAsset: string // what a bridge lands on Sui (mainnet truth), drives the preview label
  executeEnabled: boolean // gates the Confirm CTA only, quoting always works
  executeLockedReason: string | null
  minUsd: number // warn below this
  hardMinUsd: number // the server rejects below this
  faucetAmount: string // drives the faucet copy: it is network-scoped, never hardcode it
  // Logos are LI.FI's own art, resolved live alongside the addresses. null when the lookup fails or the
  // asset is not in their catalog: decoration, so the client draws a monogram rather than blocking.
  currencies: Array<{ symbol: string; logo: string | null; networks: string[] }>
  networks: Array<{ key: string; label: string; logo: string | null }>
}

export type DepositQuoteInput = { currency: string; network: string; amount: string }

// POST /deposit/execute-quote (mainnet only): the signable LI.FI step, fetched fresh with the connected
// source address and the server-stamped toAddress. `step` is passed through opaque; the client seam casts
// it to the SDK's LiFiStep and signs it directly.
export interface DepositExecuteQuoteDTO {
  step: Record<string, unknown>
  depositId: string
  tool: string | null
  bridge: string | null
  fromChainId: number
  toChainId: number
}
export type DepositExecuteQuoteInput = { currency: string; network: string; amount: string; fromAddress: string }

// GET /deposit/status?id= (mainnet only): live bridge progress for a tracked deposit.
export interface DepositStatusDTO {
  status: string // PENDING | DONE | FAILED | REFUNDED | NOT_FOUND
  substatus: string | null
  substatusMessage: string | null
}

// A live mainnet route preview. Every field is straight from LI.FI's estimate, nothing computed here.
export interface DepositQuoteDTO {
  fromAmount: string
  fromSymbol: string
  fromNetwork: string
  fromNetworkLabel: string
  fromAmountUsd: string | null
  toAmount: string // the estimate we show
  toAmountMin: string | null // the guaranteed floor after slippage
  toAmountUsd: string | null
  toSymbol: string
  toAddress: string
  feeUsd: string
  durationSec: number | null // render verbatim, the real spread is 60s..1200s
  tool: string | null
  toolName: string | null
}

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
// Wallet-connect login (custodial play-wallet model): get a challenge, sign it with the connected wallet, send the signature back for a session.
export interface WalletVerifyInput {
  address: string
  signature: string
  referralCode?: string
}

// === Referrals === (link + revenue share: earn 25% of referees' trading fees, see .claude/REVENUE_SHARING.md)

export interface ReferralDTO {
  handle: string // referee's username, falling back to displayName if they never onboarded
  joinedAt: string
  plays: number
  earned: string // what this referee has earned you so far (DUSDC)
}
export interface ReferralClaimDTO {
  id: string
  amount: string // DUSDC
  status: 'pending' | 'paid' | 'failed'
  txDigest: string | null // the payout tx, set once paid
  createdAt: string
}
export interface ReferralInfoDTO {
  code: string // the anon-format token (/r/CODE)
  anon: boolean // link format: false = /@username, true = /r/CODE
  username: string | null // for building the /@username link; null if not onboarded
  count: number
  referrals: ReferralDTO[]
  sharePct: number // the share you earn, e.g. 25
  totalEarned: string // lifetime earned across all referees (DUSDC)
  totalClaimed: string // lifetime claimed (pending + paid) (DUSDC)
  claimable: string // spendable now = earned - claimed (DUSDC)
  minClaim: string // minimum before Claim unlocks (DUSDC)
  claims: ReferralClaimDTO[] // recent claim history, newest first
}
export interface ReferralResolveDTO {
  valid: boolean
  handle: string | null // null for an anon link or an unknown token
}

// === Leaderboards === (every row exposes username/displayName, never an address)

export type Minigame = 'line-rider' | 'flappy-piper'

export interface LeaderboardPnlEntry {
  rank: number
  username: string | null // identity is the @username only; the board shows "Anon" for a rare null
  avatarUrl: string | null
  netPnl: string // signed DUSDC
  gamesPlayed: number
  isYou: boolean
  twitterHandle: string | null // linked X handle (lowercased), or null; the badge sits next to this handle
}
export interface LeaderboardGameEntry {
  rank: number
  username: string | null
  displayName: string
  avatarUrl: string | null
  pnl: string // signed summed DUSDC for the game (gainers positive, rekt negative)
  plays: number
  isYou: boolean
  twitterHandle: string | null
}
export interface LeaderboardScoreEntry {
  rank: number
  username: string | null
  displayName: string
  avatarUrl: string | null
  score: number
  isYou: boolean
  twitterHandle: string | null
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
// The menu leaderboard payload: PnL-only (Gainers/REKT + your standing). Per-game and minigame boards
// live behind gameLeaderboard()/minigameLeaderboard() for the in-game overlays.
export interface FullLeaderboard {
  global: GlobalLeaderboard
}

// === Core ===

export class ApiError extends Error {
  code: string
  status: number
  // The backend's underlying cause (dev only, sent under IS_DEV); surfaced in the sign-in error sheet for reviewers.
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

// If the backend reports a session's account isn't ready, a live session 409s MANAGER_NOT_READY
// until re-login; the auth layer registers a handler here to react the moment the backend reports it.
let onManagerNotReady: (() => void) | null = null
export const setManagerNotReadyHandler = (fn: (() => void) | null): void => {
  onManagerNotReady = fn
}

interface Envelope<T> {
  success: boolean
  error: { code: string; message: string; details?: string } | null
  data: T
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    })
  } catch (e) {
    // An aborted request is the caller superseding itself (a re-quote as the player types), not a failure.
    // Keep it distinguishable so callers can drop it silently instead of flashing an error.
    if (e instanceof DOMException && e.name === 'AbortError') throw new ApiError('ABORTED', 'Request superseded', 0)
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
  // auth. readRef() threads a stashed referral token into every login path; the backend only attributes
  // it on account creation (auth.ts ensureUser/ensureWalletUser), so it's a no-op for a returning user.
  authDev: () => request<{ token: string; user: UserDTO }>('POST', '/auth/dev', { referralCode: readRef() ?? undefined }),
  authPrivyVerify: (input: PrivyVerifyInput) => request<{ token: string; user: UserDTO }>('POST', '/auth/privy/verify', input),
  authWalletNonce: (address: string) => request<{ message: string }>('POST', '/auth/wallet/nonce', { address }),
  authWalletVerify: (input: WalletVerifyInput) => request<{ token: string; user: UserDTO }>('POST', '/auth/wallet/verify', input),
  me: () => request<{ user: UserDTO }>('GET', '/auth/me'),
  // Re-provision a re-armed session in place (new PredictManager + chips), self-healing instead of forcing a full re-login.
  authHeal: () => request<{ user: UserDTO }>('POST', '/auth/heal'),
  setUsername: (username: string) => request<{ user: UserDTO }>('PATCH', '/auth/me', { username }),
  // Re-read linked Google/email/X state from Privy and persist it; call after every link/unlink so the DB never trusts a client-reported handle.
  linkRefresh: () => request<{ user: UserDTO }>('POST', '/auth/link/refresh'),
  // Avatar: upload a client-shrunk 500x500 webp data URL, or remove the custom one (revert to default).
  uploadAvatar: (dataUrl: string) => request<{ user: UserDTO }>('POST', '/avatar', { image: dataUrl }),
  removeAvatar: () => request<{ user: UserDTO }>('DELETE', '/avatar'),

  // markets + plays. `playsPaused` is the real-mode sponsor-floor pause (always false in fork/demo); blocks new plays while the gas sponsor tops up.
  markets: () => request<{ markets: MarketDTO[]; playsPaused?: boolean }>('GET', '/markets'),
  // Price the whole band ladder for an asset in one call; cached on select so every band shows its real multiple instantly, no estimate fallback.
  rangeQuotes: (asset: string, widthPcts: number[]) =>
    request<{ quotes: RangeQuote[] }>('GET', `/games/range/quotes?asset=${encodeURIComponent(asset)}&widths=${widthPcts.join(',')}`),
  // Price the server payout-tier ladder (the RANGE knob): stable multiples + the live-band decay model.
  rangeTierQuotes: (asset: string) =>
    request<{ quotes: RangeTierQuote[]; model: RangeQuoteModel | null }>('GET', `/games/range/quotes?asset=${encodeURIComponent(asset)}&tiers=1`),
  // The MOONSHOT aim ladder: the strike offset each reach mints at, so the previewed TARGET equals the drawn strike.
  moonshotAim: (asset: string) =>
    request<{ levels: MoonshotAim[] }>('GET', `/games/moonshot/aim?asset=${encodeURIComponent(asset)}`),
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

  // deposit. toAddress is never sent: the server stamps it from the authed user, and supplying one is refused.
  depositOptions: () => request<DepositOptionsDTO>('GET', '/deposit/options'),
  depositQuote: (input: DepositQuoteInput, signal?: AbortSignal) =>
    request<{ quote: DepositQuoteDTO }>('POST', '/deposit/quote', input, signal),
  // Execution (mainnet only). These 403 on any non-mainnet backend, the CTA that calls them is gated too.
  depositExecuteQuote: (input: DepositExecuteQuoteInput) =>
    request<DepositExecuteQuoteDTO>('POST', '/deposit/execute-quote', input),
  depositTrack: (depositId: string, txHash: string) =>
    request<DepositStatusDTO>('POST', '/deposit/track', { depositId, txHash }),
  depositStatus: (id: string) => request<DepositStatusDTO>('GET', `/deposit/status?id=${encodeURIComponent(id)}`),

  // referrals
  referral: () => request<ReferralInfoDTO>('GET', '/referral'),
  setReferralAnon: (anon: boolean) => request<ReferralInfoDTO>('PATCH', '/referral', { anon }),
  claimReferral: () => request<ReferralInfoDTO>('POST', '/referral/claim'),
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

// Demo mode swaps the whole client for an in-memory mock, resolved per call so a runtime toggle takes effect without rebuilding the api binding.
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
  // Market fields, pushed so a mid-flight re-route/restrike snaps the client overlay + countdown to the real minted values.
  entrySpot?: string
  strike?: string
  lower?: string
  upper?: string
  expiry?: number
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

// Live markets: tradeable assets + the sponsor-pause flag, pushed on change; replaces the per-client GET /markets poll.
export type MarketsTick = { markets: MarketDTO[]; playsPaused: boolean }
export const streamMarkets = (onTick: (t: MarketsTick) => void, onError?: () => void): (() => void) =>
  isDemo() ? demoStreamMarkets(onTick) : stream<MarketsTick>('/stream/markets', onTick, onError)

export const streamLive = (onTick: (t: LiveTick) => void, onError?: () => void): (() => void) =>
  isDemo() ? demoStreamLive(onTick) : stream<LiveTick>('/stream/live', onTick, onError)
