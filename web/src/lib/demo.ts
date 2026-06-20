// Demo mode. A self-contained mock of the whole backend + chain so the UI is fully playable
// with no server, no funds, and no Sui. Every screen runs on simulated prices and in-memory
// state (persisted to localStorage so your record survives a reload). The api client and the
// two SSE helpers route here when isDemo() is true, so the games never know the difference.
//
// This is the ONLY place sim lives. The real product is always real Predict; demo is a play
// pen, clearly badged as such, for poking at the interface.

import { env } from '@/env'
import { ApiError } from './api'
import type {
  AchievementDTO,
  CashoutResult,
  Game,
  MarketDTO,
  PlayDTO,
  PlayResult,
  PlayStatus,
  PlayTick,
  PriceTick,
  Side,
  UserDTO,
  UserStatsDTO,
} from './api'

// === Flag ===

const OVERRIDE_KEY = 'pips_demo' // '1' force on, '0' force off, unset = env default
const STATE_KEY = 'pips_demo_state'
const STATE_VERSION = 3 // bumped: live oracle prices + refreshed seed account

export function isDemo(): boolean {
  if (typeof window !== 'undefined') {
    try {
      const o = window.localStorage.getItem(OVERRIDE_KEY)
      if (o === '1') return true
      if (o === '0') return false
    } catch {
      // storage blocked: fall through to env default
    }
  }
  return env.VITE_DEMO_MODE === 'true'
}

export function setDemoOverride(on: boolean | null): void {
  if (typeof window === 'undefined') return
  try {
    if (on === null) window.localStorage.removeItem(OVERRIDE_KEY)
    else window.localStorage.setItem(OVERRIDE_KEY, on ? '1' : '0')
  } catch {
    // ignore
  }
}

// === Constants ===

const DEMO_ADDRESS = '0x' + 'de70'.repeat(16) // looks like a real Sui address, reads "de70" (demo)
const DEMO_HANDLE = '@pips'
// Fallback seed levels (real mid-2026 oracle levels). Used until the live Pyth feed connects and any
// time the network is blocked, so demo mode still runs fully offline, just on a frozen-but-correct base.
const SEED_PRICES: Record<string, number> = { BTC: 63_575, ETH: 1_725, SOL: 71.45, SUI: 0.71, DEEP: 0.0166 }
const ASSETS = Object.keys(SEED_PRICES)
// Pyth Hermes price-feed ids (the real oracle). The live SSE stream sets each asset's anchor to the
// true market price; the synthetic walk rides on top so a 30s round still has motion to settle against.
const PYTH_IDS: Record<string, string> = {
  BTC: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  ETH: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  SOL: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  SUI: '23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744',
  DEEP: '29bdd5248234e33bd93d3b81100b5fa32eaa5997843847e2c2cb16d7c6d9f7ff',
}
const HERMES_STREAM = 'https://hermes.pyth.network/v2/updates/price/stream'
const DURATIONS = [10, 30, 60]
const RANGE_ROUND_SEC = 30 // Range is one real settled round; the client no longer picks a duration

// === Lucky: the slot-weighted multiplier reel (LUCKY.md §4-5) ===
// The reel deals one tier per spin, weighted for fun (NOT by win odds). Each tier then settles at its
// own honest odds = 1/mult, so a 2x is a real coinflip and a 25x is a rare-but-real jackpot. The strike
// (the TARGET line) always sits in the BET DIRECTION (z >= 0): up targets above entry, down below, so
// "down" always needs the price to fall. The ladder starts at 2x (a small move past entry, floored so
// it never lands on the entry line); a sub-2x tier would force the target onto the wrong side of entry.
// z is the standard-normal quantile invNorm(1 - 1/mult).
const LUCKY_ASSETS = ['BTC', 'SUI', 'ETH']
const LUCKY_ROUND_SEC = 30 // fixed fast round
const ROUND_VOL = 0.022 // fractional std of price over a 30s round; sets how far the TARGET sits per tier
const LUCKY_TIERS = [
  { mult: 2, weight: 0.5, z: 0 },
  { mult: 3, weight: 0.3, z: 0.4307 },
  { mult: 5, weight: 0.13, z: 0.8416 },
  { mult: 10, weight: 0.05, z: 1.2816 },
  { mult: 25, weight: 0.02, z: 1.7507 },
] as const
const TICK_MS = 300 // denser ticks read as continuous motion
const VOL = 0.0004 // per-tick impulse on velocity (not price), small so trends stay smooth
const MOMENTUM = 0.92 // velocity persistence: turns white-noise jitter into smooth trending paths
const REVERT = 0.018 // pull price back toward its seed so a long session stays believable
const MAX_VEL = 0.003 // clamp a run so the line never bolts off-screen
const SPIKE_PROB = 0.08 // chance per tick of a sharp wick: the "hammer" reversal
const SPIKE_MAG = 0.005 // wick size as a fraction of price
const TRANSIENT_DECAY = 0.3 // how fast a wick snaps back, sharp and gone within a couple ticks
// Demo-only latency beats, so a play feels like it really hits the chain (but ~1s, not the real 3s+).
const OPEN_PENDING_MS = 850 // the OPENING beat: hold 'pending' ~1s after the deal before it goes live
const SETTLE_HOLD_MS = 900 // the SETTLING beat: hold at the buzzer ~1s before the result lands

const CATALOG = [
  { slug: 'first_play', name: 'First Play', description: 'Make your first play.', illo: 'bolt', metric: 'games_played', threshold: 1 },
  { slug: 'first_win', name: "Beginner's Luck", description: 'Win your first play.', illo: 'trophy', metric: 'wins', threshold: 1 },
  { slug: 'win_streak_5', name: 'On Fire', description: 'Win 5 plays in a row.', illo: 'flame', metric: 'win_streak', threshold: 5 },
  { slug: 'big_multiplier', name: 'Moonshot', description: 'Cash out a 25x or higher.', illo: 'up', metric: 'big_multiplier', threshold: 25 },
  { slug: 'volume_1000', name: 'High Roller', description: 'Trade $1,000 in total volume.', illo: 'gem', metric: 'volume', threshold: 1000 },
  { slug: 'all_games', name: 'Sampler', description: 'Play both games.', illo: 'dice', metric: 'distinct_games', threshold: 2 },
  { slug: 'cashout_10', name: 'Quick Hands', description: 'Cash out 10 winning plays.', illo: 'coin', metric: 'cashouts', threshold: 10 },
  { slug: 'comeback', name: 'Comeback', description: 'Win a play right after a loss.', illo: 'medal', metric: 'comeback', threshold: 1 },
] as const

// === Price engine ===
// Each asset's price = a live anchor (the real market level) times a synthetic walk on top. The live
// oracle (Pyth Hermes, below) streams the true price into the anchor, so the chart reads accurate; the
// walk adds a smooth momentum trend plus the occasional sharp wick (the "hammer") so a 30s round has
// enough motion to settle against (real 30s vol is too small to play). The walk mean-reverts to the
// anchor, so the line always hugs the real level. Lazily started in the browser; every game reads the
// same emitted price, so chart and settlement agree. No live feed (blocked/offline) = the seed anchors
// + the walk carry demo fully, just on a correct-but-frozen base.

const prices = new Map<string, number>() // emitted price = anchor * (1 + drift + transient)
const anchors = new Map<string, number>() // the real level: live Pyth feed, or the seed fallback
const drifts = new Map<string, number>() // synthetic fractional offset from the anchor (reverts to 0)
const vels = new Map<string, number>() // per-asset fractional velocity, carries momentum between ticks
const transients = new Map<string, number>() // sharp wick offset, decays fast
const priceSubs = new Map<string, Set<(p: number) => void>>()
let priceTimer: ReturnType<typeof setInterval> | null = null
const DRIFT_CLAMP = 0.08 // keep the synthetic walk from wandering too far off the real anchor

function ensurePrice(asset: string): void {
  if (!anchors.has(asset)) {
    const s = SEED_PRICES[asset] ?? 1
    anchors.set(asset, s)
    drifts.set(asset, 0)
    prices.set(asset, s)
  }
}

// Live oracle: stream real prices from Pyth Hermes (SSE) into each asset's anchor. One persistent
// connection (no polling, so no rate limit); EventSource auto-reconnects, and if it never connects the
// seed anchors keep everything running. Only ever opened from the demo price paths, so it never runs
// outside demo mode.
const ID_TO_ASSET = new Map<string, string>()
for (const [a, id] of Object.entries(PYTH_IDS)) ID_TO_ASSET.set(id.toLowerCase().replace(/^0x/, ''), a)
let pythSrc: EventSource | null = null

function connectPyth(): void {
  if (pythSrc || typeof window === 'undefined' || typeof EventSource === 'undefined') return
  try {
    const qs = ASSETS.map((a) => PYTH_IDS[a])
      .filter(Boolean)
      .map((id) => `ids[]=${id}`)
      .join('&')
    const src = new EventSource(`${HERMES_STREAM}?${qs}&parsed=true`)
    src.onmessage = (e) => {
      try {
        const parsed = (JSON.parse(e.data) as { parsed?: Array<{ id: string; price?: { price: string; expo: number } }> }).parsed
        if (!Array.isArray(parsed)) return
        for (const u of parsed) {
          const asset = ID_TO_ASSET.get(String(u.id).toLowerCase().replace(/^0x/, ''))
          if (!asset || !u.price) continue
          const real = Number(u.price.price) * 10 ** Number(u.price.expo)
          if (Number.isFinite(real) && real > 0) anchors.set(asset, real)
        }
      } catch {
        // ignore a malformed frame; the next one updates the anchor
      }
    }
    src.onerror = () => {
      // transient drop: EventSource retries on its own; the walk keeps the chart alive meanwhile
    }
    pythSrc = src
  } catch {
    // no live feed available: the seed anchors + the synthetic walk carry demo mode offline
  }
}

function startEngine(): void {
  if (priceTimer || typeof window === 'undefined') return
  for (const a of ASSETS) ensurePrice(a)
  connectPyth()
  priceTimer = setInterval(() => {
    for (const a of ASSETS) {
      const anchor = anchors.get(a) as number
      // Velocity carries momentum, so consecutive ticks move together: smooth trends, not jitter.
      let vel = (vels.get(a) ?? 0) * MOMENTUM + (Math.random() - 0.5) * 2 * VOL
      if (vel > MAX_VEL) vel = MAX_VEL
      else if (vel < -MAX_VEL) vel = -MAX_VEL
      vels.set(a, vel)
      // Drift is a fractional offset from the live anchor: it accrues velocity and slowly reverts to 0,
      // so the line wanders for a playable round but always settles back toward the real oracle level.
      let drift = (drifts.get(a) ?? 0) + vel
      drift -= drift * REVERT
      if (drift > DRIFT_CLAMP) drift = DRIFT_CLAMP
      else if (drift < -DRIFT_CLAMP) drift = -DRIFT_CLAMP
      drifts.set(a, drift)
      // Sharp wick on top: an occasional hammer that reverts within a few ticks.
      let tr = (transients.get(a) ?? 0) * TRANSIENT_DECAY
      if (Math.random() < SPIKE_PROB) tr += (Math.random() < 0.5 ? -1 : 1) * SPIKE_MAG
      transients.set(a, tr)
      const next = anchor * (1 + drift + tr)
      prices.set(a, next > 0 ? next : anchor)
      const subs = priceSubs.get(a)
      if (subs) for (const cb of subs) cb(prices.get(a) as number)
    }
  }, TICK_MS)
}

function currentPrice(asset: string): number {
  ensurePrice(asset)
  startEngine()
  return prices.get(asset) as number
}

function subscribePrice(asset: string, cb: (p: number) => void): () => void {
  ensurePrice(asset)
  startEngine()
  let set = priceSubs.get(asset)
  if (!set) {
    set = new Set()
    priceSubs.set(asset, set)
  }
  set.add(cb)
  cb(prices.get(asset) as number)
  return () => set?.delete(cb)
}

// === Persistent state ===

interface Counters {
  gamesPlayed: number
  wins: number
  losses: number
  currentStreak: number
  maxStreak: number
  totalVolume: number
  netPnl: number
  cashouts: number
  maxMultiplierCashed: number
  distinctGames: Game[]
  comebackDone: boolean
  lastWasLoss: boolean
  firstPlayAt: string
  favoriteGame: Game
}

interface DemoState {
  v: number
  balance: number
  username: string | null // null = first run, show onboarding (mirrors the live user.username signal)
  settings: { sound: boolean; haptics: boolean; reducedMotion: boolean }
  counters: Counters
  unlocked: Record<string, string> // slug -> unlockedAt ISO
  history: PlayDTO[] // settled plays only, newest first
}

// Assigned by the init block at the very bottom, once every const/function below is in scope.
let state!: DemoState
const byId = new Map<string, PlayDTO>() // every play, open or settled
const openList: PlayDTO[] = [] // open plays this session (not persisted)
const openIds = new Set<string>()

// Marking context for open plays. Holds what we need to value a position against live price.
interface MarkCtx {
  game: Game
  asset: string
  stake: number
  entry: number
  side?: Side
  lower?: number
  upper?: number
  lockedMult: number // the payout multiplier: lucky's dealt tier, or range's locked estimate
  target?: number // lucky: the strike the price must cross (the TARGET line)
  roundVol?: number // lucky: fractional round volatility, for the live mark-to-market value
  openedMs: number
  expiryMs: number
  confirmAtMs?: number // demo: when the 'pending' mint flips to 'open' (the OPENING beat ends)
  settleAtMs?: number // demo: when the post-buzzer SETTLING beat ends and the result lands
  settlePrice?: number // demo: price snapshotted at the buzzer, so the held settle uses the real close
}
const ctx = new Map<string, MarkCtx>()

function freshState(): DemoState {
  const now = nowMs()
  const counters: Counters = {
    gamesPlayed: 47,
    wins: 29,
    losses: 18,
    currentStreak: 3,
    maxStreak: 6,
    totalVolume: 2840,
    netPnl: 612,
    cashouts: 8,
    maxMultiplierCashed: 12,
    distinctGames: ['lucky', 'range'],
    comebackDone: true,
    lastWasLoss: false,
    firstPlayAt: new Date(now - 34 * 86_400_000).toISOString(),
    favoriteGame: 'lucky',
  }
  const past = (mins: number): string => new Date(now - mins * 60_000).toISOString()
  const history = SEED_PLAYS.map((s, i) => buildSeedPlay(s, i, past))
  // Pre-unlock whatever the seeded record already earns, so the grid lights up like a real account.
  const unlocked: Record<string, string> = {}
  for (const c of CATALOG) if (meets(c.metric, c.threshold, counters)) unlocked[c.slug] = past(60 * 24)
  return { v: STATE_VERSION, balance: 2847.5, username: 'pips', settings: { sound: true, haptics: true, reducedMotion: false }, counters, unlocked, history }
}

function load(): DemoState {
  if (typeof window === 'undefined') return freshState()
  try {
    const raw = window.localStorage.getItem(STATE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as DemoState
      if (parsed.v === STATE_VERSION) return parsed
    }
  } catch {
    // corrupt or absent: start fresh
  }
  const fresh = freshState()
  save(fresh)
  return fresh
}

function save(s: DemoState = state): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STATE_KEY, JSON.stringify(s))
  } catch {
    // ignore
  }
}

export function resetDemo(): void {
  state = freshState()
  byId.clear()
  openList.length = 0
  openIds.clear()
  ctx.clear()
  for (const p of state.history) byId.set(p.id, p)
  save()
}

// === Helpers ===

let idSeq = 0
function nowMs(): number {
  // Date.now via a function so the linter stays happy and tests can stub if needed.
  return Date.now()
}
function newId(): string {
  idSeq += 1
  return `demo-${nowMs().toString(36)}-${idSeq}`
}
const str = (n: number): string => n.toFixed(2)
// Price string with enough precision for sub-dollar tokens (DEEP, SUI); the UI trims trailing zeros.
const pxStr = (n: number): string => (n >= 1 ? n.toFixed(2) : n.toFixed(6))
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function pickTier(): (typeof LUCKY_TIERS)[number] {
  // Slot-weighted: which bet you are dealt is weighted for fun (usually a winnable tier), but you then
  // win it at its own honest odds. Weights sum to 1, so a single uniform draw picks the tier.
  let r = Math.random()
  for (const t of LUCKY_TIERS) if ((r -= t.weight) <= 0) return t
  return LUCKY_TIERS[0]
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

// Standard normal CDF (Zelen & Severo approximation). Marks an open lucky ticket to its live fair
// value, bet × mult × P(finish on your side of TARGET given the live price and the time left). At open
// that is exactly the bet; a favorable move lifts it toward bet × mult, so an early cash-out pays a
// believable partial before the price has fully reached the target.
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  const upper = 0.39894228 * Math.exp((-x * x) / 2) * poly
  return x >= 0 ? 1 - upper : upper
}

// Same shape as the Range screen's client estimate, so the locked multiple feels consistent.
function estimateMultiplier(halfPct: number, durationSec: number): number {
  const sigma = 0.6 * Math.sqrt(durationSec / 30)
  const prob = 1 - Math.exp(-halfPct / sigma)
  return Math.max(1.05, Math.min(0.97 / Math.max(prob, 0.03), 99))
}

function meets(metric: string, threshold: number, c: Counters): boolean {
  switch (metric) {
    case 'games_played':
      return c.gamesPlayed >= threshold
    case 'wins':
      return c.wins >= threshold
    case 'win_streak':
      return c.maxStreak >= threshold
    case 'big_multiplier':
      return c.maxMultiplierCashed >= threshold
    case 'volume':
      return c.totalVolume >= threshold
    case 'distinct_games':
      return c.distinctGames.length >= threshold
    case 'cashouts':
      return c.cashouts >= threshold
    case 'comeback':
      return c.comebackDone
    default:
      return false
  }
}

function metricValue(metric: string, c: Counters): number {
  switch (metric) {
    case 'games_played':
      return c.gamesPlayed
    case 'wins':
      return c.wins
    case 'win_streak':
      return c.maxStreak
    case 'big_multiplier':
      return Math.round(c.maxMultiplierCashed)
    case 'volume':
      return Math.round(c.totalVolume)
    case 'distinct_games':
      return c.distinctGames.length
    case 'cashouts':
      return c.cashouts
    case 'comeback':
      return c.comebackDone ? 1 : 0
    default:
      return 0
  }
}

// Record any freshly-earned achievements; return the slugs that flipped this call (for toasts).
function evaluateUnlocks(): string[] {
  const fresh: string[] = []
  for (const c of CATALOG) {
    if (!state.unlocked[c.slug] && meets(c.metric, c.threshold, state.counters)) {
      state.unlocked[c.slug] = new Date(nowMs()).toISOString()
      fresh.push(c.slug)
    }
  }
  return fresh
}

// Value an open position against a live price. Returns display-unit value + win flag.
function mark(c: MarkCtx, price: number): { markValue: number; pnl: number; multiplier: number; win: boolean } {
  if (c.game === 'lucky') {
    const dir = c.side === 'up' ? 1 : -1
    const target = c.target ?? c.entry
    // Favorable gap past the TARGET as a fraction of entry (positive = in the money).
    const gap = (dir * (price - target)) / c.entry
    const remaining = clamp01((c.expiryMs - nowMs()) / Math.max(1, c.expiryMs - c.openedMs))
    const sigma = (c.roundVol ?? ROUND_VOL) * Math.sqrt(Math.max(remaining, 0.0008))
    const pLive = clamp01(normCdf(gap / sigma))
    const markValue = c.stake * c.lockedMult * pLive
    return { markValue, pnl: markValue - c.stake, multiplier: c.lockedMult, win: gap >= 0 }
  }
  const inside = price >= (c.lower ?? 0) && price <= (c.upper ?? Infinity)
  const progress = Math.max(0, Math.min(1, (nowMs() - c.openedMs) / Math.max(1, c.expiryMs - c.openedMs)))
  const markValue = inside
    ? c.stake * (1 + (c.lockedMult - 1) * 0.85 * progress)
    : c.stake * Math.max(0.05, 1 - 0.9 * progress)
  return { markValue, pnl: markValue - c.stake, multiplier: c.lockedMult, win: inside }
}

// Close a play (cash out at the live mark, or settle at expiry). Idempotent per id. Updates the
// record + balance + achievements and moves the play into settled history.
function closePlay(id: string, mode: 'cashout' | 'settle'): { play: PlayDTO; unlocked: string[] } {
  const p = byId.get(id)
  const c = ctx.get(id)
  if (!p || !c || !openIds.has(id)) return { play: p as PlayDTO, unlocked: [] }
  openIds.delete(id)
  ctx.delete(id)
  const oi = openList.findIndex((x) => x.id === id)
  if (oi >= 0) openList.splice(oi, 1)

  const settlePx = mode === 'settle' && c.settlePrice != null ? c.settlePrice : currentPrice(c.asset)
  const m = mark(c, settlePx)
  let status: PlayStatus
  let payout: number
  if (mode === 'cashout') {
    status = 'cashed_out'
    payout = Math.max(0, m.markValue)
  } else if (m.win) {
    // A settle win is spread-free: the full bet × multiplier. Cash-out takes the live mark instead.
    status = 'won'
    payout = c.stake * c.lockedMult
  } else {
    status = 'lost'
    payout = 0
  }
  const pnl = payout - c.stake

  p.status = status
  p.markValue = str(payout)
  p.pnl = str(pnl)
  p.payout = str(payout)
  p.multiplier = m.multiplier
  p.settledAt = new Date(nowMs()).toISOString()
  p.settlePrice = pxStr(settlePx)

  // Record + balance.
  const k = state.counters
  state.balance += payout
  k.netPnl += pnl
  const isWin = status === 'won' || (status === 'cashed_out' && pnl >= 0)
  if (isWin) {
    k.wins += 1
    k.currentStreak += 1
    k.maxStreak = Math.max(k.maxStreak, k.currentStreak)
    if (status === 'cashed_out') k.cashouts += 1
    if (m.multiplier >= 25) k.maxMultiplierCashed = Math.max(k.maxMultiplierCashed, m.multiplier)
    if (k.lastWasLoss) k.comebackDone = true
    k.lastWasLoss = false
  } else {
    k.losses += 1
    k.currentStreak = 0
    k.lastWasLoss = true
  }

  state.history.unshift(p)
  if (state.history.length > 40) state.history.length = 40
  const unlocked = evaluateUnlocks()
  save()
  return { play: p, unlocked }
}

// === Play creation ===

function ensureBalance(stake: number): void {
  if (stake <= 0) throw new ApiError('PLAY_FAILED', 'That play did not go through. Your bet is safe.', 400)
  if (stake > state.balance) throw new ApiError('INSUFFICIENT_DUSDC', 'Not enough chips for that bet.', 400)
}

function registerOpen(p: PlayDTO, c: MarkCtx): void {
  state.counters.gamesPlayed += 1
  state.counters.totalVolume += c.stake
  if (!state.counters.distinctGames.includes(c.game)) state.counters.distinctGames.push(c.game)
  state.balance -= c.stake
  byId.set(p.id, p)
  openList.unshift(p)
  openIds.add(p.id)
  ctx.set(p.id, c)
  save()
}

function createLucky(body: Record<string, unknown>): PlayDTO {
  const stake = Number(body.stake ?? 25)
  ensureBalance(stake)
  // "I feel lucky": the reel deals the asset, direction, and tier. None of it is the player's pick.
  const asset = LUCKY_ASSETS[Math.floor(Math.random() * LUCKY_ASSETS.length)]
  const side: Side = Math.random() < 0.5 ? 'up' : 'down'
  const tier = pickTier()
  const duration = LUCKY_ROUND_SEC
  const entry = currentPrice(asset)
  const roundVol = ROUND_VOL * Math.sqrt(duration / LUCKY_ROUND_SEC)
  const dir = side === 'up' ? 1 : -1
  // The strike (TARGET) sits in the bet direction at the distance the tier's odds imply, floored at a
  // small minimum so even the 2x is a real, visible directional move (never a strike on the entry
  // line), mirroring the backend's LUCKY_MIN_TARGET_FRAC. So "down" always needs the price to fall.
  const MIN_TARGET_FRAC = 0.0015
  const target = entry * (1 + dir * Math.max(roundVol * tier.z, MIN_TARGET_FRAC))
  const openedMs = nowMs()
  const expiryMs = openedMs + duration * 1000
  const id = newId()
  const p: PlayDTO = {
    id,
    game: 'lucky',
    status: 'pending', // mint "lands" ~1s later (the OPENING beat); the demo stream flips it to 'open'
    stake: str(stake),
    params: { asset, side, multiplier: tier.mult, duration },
    market: { asset, oracleId: `demo-oracle-${asset}`, expiry: expiryMs, strike: String(target) },
    entryValue: str(stake),
    markValue: str(stake),
    pnl: '0.00',
    multiplier: tier.mult,
    entrySpot: String(entry),
    openedAt: new Date(openedMs).toISOString(),
  }
  registerOpen(p, { game: 'lucky', asset, stake, entry, side, lockedMult: tier.mult, target, roundVol, openedMs, expiryMs })
  return p
}

function createRange(body: Record<string, unknown>): PlayDTO {
  const stake = Number(body.stake ?? 10)
  ensureBalance(stake)
  const asset = String(body.asset ?? ASSETS[0])
  const duration = RANGE_ROUND_SEC // one real settled round; matches the backend's oracle-expiry round
  const widthPct = Number(body.widthPct ?? 2) // full band width %
  const halfPct = widthPct / 2
  const entry = currentPrice(asset)
  const lower = entry * (1 - halfPct / 100)
  const upper = entry * (1 + halfPct / 100)
  const lockedMult = estimateMultiplier(halfPct, duration)
  const openedMs = nowMs()
  const expiryMs = openedMs + duration * 1000
  const id = newId()
  const p: PlayDTO = {
    id,
    game: 'range',
    status: 'pending', // mint "lands" ~1s later (the OPENING beat); the demo stream flips it to 'open'
    stake: str(stake),
    params: { asset, lower: str(lower), upper: str(upper), widthPct, duration },
    market: { asset, oracleId: `demo-oracle-${asset}`, expiry: expiryMs, lower: String(lower), upper: String(upper) },
    entryValue: str(stake),
    markValue: str(stake),
    pnl: '0.00',
    multiplier: lockedMult,
    entrySpot: String(entry),
    openedAt: new Date(openedMs).toISOString(),
  }
  registerOpen(p, { game: 'range', asset, stake, entry, lower, upper, lockedMult, openedMs, expiryMs })
  return p
}

// === The mock api surface (mirrors lib/api.ts `api`) ===

function userDTO(): UserDTO {
  return {
    id: 'demo',
    address: DEMO_ADDRESS,
    displayName: DEMO_HANDLE,
    username: state.username,
    provider: 'dev',
    balance: str(state.balance),
    managerReady: true,
    settings: state.settings,
  }
}

export function demoUser(): UserDTO {
  return userDTO()
}

function statsDTO(): UserStatsDTO {
  const k = state.counters
  return {
    gamesPlayed: k.gamesPlayed,
    wins: k.wins,
    losses: k.losses,
    winRate: k.gamesPlayed > 0 ? k.wins / k.gamesPlayed : 0,
    currentStreak: k.currentStreak,
    maxStreak: k.maxStreak,
    totalVolume: str(k.totalVolume),
    netPnl: str(k.netPnl),
    firstPlayAt: k.firstPlayAt,
    favoriteGame: k.favoriteGame,
  }
}

function achievementsDTO(): AchievementDTO[] {
  return CATALOG.map((c) => {
    const unlocked = Boolean(state.unlocked[c.slug]) || meets(c.metric, c.threshold, state.counters)
    return {
      slug: c.slug,
      name: c.name,
      description: c.description,
      illo: c.illo,
      unlocked,
      unlockedAt: state.unlocked[c.slug],
      progress: unlocked ? undefined : { current: metricValue(c.metric, state.counters), target: c.threshold },
    }
  })
}

export const demoApi = {
  authDev: async () => {
    await delay(120)
    return { token: 'demo-token', user: userDTO() }
  },
  authPrivyVerify: async (_input: unknown) => {
    await delay(120)
    return { token: 'demo-token', user: userDTO() }
  },
  // Wallet-connect is hidden in demo (the door gates it on !demo), so these are just stubs that keep
  // the demo client complete.
  authWalletNonce: async (_address: string) => {
    await delay(60)
    return { message: 'Sign in to Pips (demo)' }
  },
  authWalletVerify: async (_input: unknown) => {
    await delay(120)
    return { token: 'demo-token', user: userDTO() }
  },
  me: async () => ({ user: userDTO() }),

  setUsername: async (username: string) => {
    const name = typeof username === 'string' ? username.trim() : ''
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(name)) {
      throw new ApiError('USERNAME_INVALID', 'Use 3 to 20 letters, numbers, or underscores', 400)
    }
    state.username = name
    save()
    return { user: userDTO() }
  },

  markets: async (): Promise<{ markets: MarketDTO[] }> => {
    await delay(120)
    return { markets: ASSETS.map((a) => ({ asset: a, spot: String(currentPrice(a)), durations: DURATIONS, live: true })) }
  },

  play: async (game: Game, body: Record<string, unknown>): Promise<PlayResult> => {
    await delay(140)
    const play = game === 'lucky' ? createLucky(body) : createRange(body)
    return { play }
  },

  cashout: async (playId: string): Promise<CashoutResult> => {
    await delay(120)
    const { play, unlocked } = closePlay(playId, 'cashout')
    if (!play) throw new ApiError('CASHOUT_FAILED', 'Cash out did not go through. Try again.', 404)
    return { play, unlocked }
  },

  withdraw: async (input: { recipient: string; amount: string }): Promise<{ user: UserDTO; digest: string }> => {
    await delay(160)
    const amount = parseFloat(String(input.amount).replace(/,/g, ''))
    if (!Number.isFinite(amount) || amount <= 0) throw new ApiError('INVALID_AMOUNT', 'Enter an amount to withdraw', 400)
    if (amount > state.balance + 0.005) throw new ApiError('INSUFFICIENT_DUSDC', 'Not enough balance to withdraw that much', 400)
    state.balance = Math.max(0, state.balance - amount)
    save()
    return { user: userDTO(), digest: `demo-wd-${newId()}` }
  },

  plays: async (q: { status?: string; limit?: number } = {}) => {
    await delay(120)
    const all = [...openList, ...state.history]
    const filtered = q.status ? all.filter((p) => p.status === q.status) : all
    return { plays: filtered.slice(0, q.limit ?? 50) }
  },

  getPlay: async (playId: string) => {
    const play = byId.get(playId)
    if (!play) throw new ApiError('PLAY_FAILED', 'That play did not go through. Your bet is safe.', 404)
    return { play }
  },

  stats: async () => {
    await delay(120)
    return { stats: statsDTO() }
  },

  achievements: async () => {
    await delay(120)
    return { achievements: achievementsDTO() }
  },

  settings: async () => ({ settings: state.settings }),

  patchSettings: async (body: Partial<UserDTO['settings']>) => {
    state.settings = { ...state.settings, ...body }
    save()
    return { settings: state.settings }
  },
}

// === SSE replacements ===

export function demoStreamPrices(asset: string, onTick: (t: PriceTick) => void): () => void {
  return subscribePrice(asset, (p) => onTick({ price: String(p), ts: nowMs() }))
}

export function demoStreamPlay(playId: string, onTick: (t: PlayTick) => void, onError?: () => void): () => void {
  const c = ctx.get(playId)
  if (!c) {
    const p = byId.get(playId)
    if (p) onTick({ markValue: p.markValue, pnl: p.pnl, multiplier: p.multiplier, status: p.status, ts: nowMs() })
    else onError?.()
    return () => {}
  }
  let stopped = false
  const emit = (): boolean => {
    const p = byId.get(playId) as PlayDTO
    if (!openIds.has(playId)) {
      onTick({ markValue: p.markValue, pnl: p.pnl, multiplier: p.multiplier, status: p.status, ts: nowMs() })
      return true
    }
    const t = nowMs()
    // OPENING beat: the mint is "landing". Hold 'pending' ~1s after the stream opens, then go live, so
    // the screen shows a believable OPENING loader (real chain takes a few seconds; demo fakes ~1s).
    if (c.confirmAtMs == null) c.confirmAtMs = t + OPEN_PENDING_MS
    if (t < c.confirmAtMs) {
      onTick({ markValue: str(c.stake), pnl: '0.00', multiplier: c.lockedMult, status: 'pending', ts: t })
      return false
    }
    if (p.status === 'pending') p.status = 'open'
    // SETTLING beat: at the buzzer, snapshot the close price and hold ~1s before the result lands, like
    // the on-chain settle. Win/loss is decided by that snapshot, not where the price drifts in the hold.
    if (t >= c.expiryMs) {
      if (c.settleAtMs == null) {
        c.settleAtMs = t + SETTLE_HOLD_MS
        c.settlePrice = currentPrice(c.asset)
      }
      if (t < c.settleAtMs) {
        const m = mark(c, c.settlePrice as number)
        onTick({ markValue: str(m.markValue), pnl: str(m.pnl), multiplier: m.multiplier, status: 'open', ts: t })
        return false
      }
      const { play } = closePlay(playId, 'settle')
      onTick({ markValue: play.markValue, pnl: play.pnl, multiplier: play.multiplier, status: play.status, ts: t })
      return true
    }
    const m = mark(c, currentPrice(c.asset))
    onTick({ markValue: str(m.markValue), pnl: str(m.pnl), multiplier: m.multiplier, status: 'open', ts: t })
    return false
  }
  const iv = setInterval(() => {
    if (stopped) return
    if (emit()) {
      clearInterval(iv)
      stopped = true
    }
  }, TICK_MS)
  emit()
  return () => {
    stopped = true
    clearInterval(iv)
  }
}

// === Seed history (display only) ===

interface SeedSpec {
  game: Game
  asset: string
  status: PlayStatus
  stake: number
  mult: number
  pnl: number
  minsAgo: number
}

// A played-in record: newest first, a believable hot-but-not-perfect run. The three most recent are
// wins, so currentStreak (3) reads true; the loss at 44m ago is what that streak resets from. Prices
// track the seed levels above, so entry/exit/target read like the real market.
const SEED_PLAYS: SeedSpec[] = [
  { game: 'lucky', asset: 'BTC', status: 'won', stake: 25, mult: 3, pnl: 50, minsAgo: 4 },
  { game: 'lucky', asset: 'SUI', status: 'cashed_out', stake: 10, mult: 5, pnl: 22, minsAgo: 13 },
  { game: 'range', asset: 'ETH', status: 'won', stake: 25, mult: 2.4, pnl: 35, minsAgo: 26 },
  { game: 'lucky', asset: 'SOL', status: 'lost', stake: 50, mult: 0, pnl: -50, minsAgo: 44 },
  { game: 'lucky', asset: 'BTC', status: 'won', stake: 10, mult: 10, pnl: 90, minsAgo: 71 },
  { game: 'range', asset: 'SUI', status: 'cashed_out', stake: 25, mult: 3.1, pnl: 28, minsAgo: 98 },
  { game: 'lucky', asset: 'ETH', status: 'won', stake: 5, mult: 2, pnl: 5, minsAgo: 150 },
  { game: 'range', asset: 'SOL', status: 'lost', stake: 25, mult: 0, pnl: -25, minsAgo: 240 },
  { game: 'lucky', asset: 'SUI', status: 'won', stake: 50, mult: 3, pnl: 100, minsAgo: 360 },
  { game: 'lucky', asset: 'DEEP', status: 'cashed_out', stake: 10, mult: 5, pnl: 18, minsAgo: 520 },
  { game: 'range', asset: 'BTC', status: 'won', stake: 25, mult: 4.2, pnl: 80, minsAgo: 760 },
  { game: 'lucky', asset: 'ETH', status: 'won', stake: 100, mult: 2, pnl: 100, minsAgo: 1700 },
]

// A believable Sui base58 tx digest for the seed history detail (display only; demo has no chain).
function demoDigest(): string {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let s = ''
  for (let i = 0; i < 44; i++) s += A[Math.floor(Math.random() * A.length)]
  return s
}

function buildSeedPlay(s: SeedSpec, i: number, past: (mins: number) => string): PlayDTO {
  const entry = SEED_PRICES[s.asset] ?? 1
  const won = s.status !== 'lost'
  const payout = won ? s.stake + s.pnl : 0
  const openedAt = past(s.minsAgo + 1)
  const settledAt = past(s.minsAgo)
  const market: PlayDTO['market'] = { asset: s.asset, oracleId: `demo-oracle-${s.asset}`, expiry: nowMs() - s.minsAgo * 60_000 }
  let params: PlayDTO['params']
  let settlePrice: number
  if (s.game === 'lucky') {
    const side: Side = i % 2 === 0 ? 'up' : 'down'
    const dir = side === 'up' ? 1 : -1
    // Target sits in the bet direction; the close lands past it on a win, short of it on a loss.
    const reach = 0.004 * Math.max(1, s.mult / 3)
    settlePrice = won ? entry * (1 + dir * reach * 1.4) : entry * (1 - dir * reach * 0.5)
    market.strike = pxStr(entry * (1 + dir * reach))
    params = { asset: s.asset, side, multiplier: s.mult || 1, duration: 30 }
  } else {
    const half = 0.002 + 0.001 * (i % 3)
    const lower = entry * (1 - half)
    const upper = entry * (1 + half)
    settlePrice = won ? entry * (1 + half * 0.4 * (i % 2 ? 1 : -1)) : entry * (1 + half * 1.7)
    market.lower = pxStr(lower)
    market.upper = pxStr(upper)
    params = { asset: s.asset, lower: pxStr(lower), upper: pxStr(upper), widthPct: Number((half * 200).toFixed(1)), duration: 30 }
  }
  return {
    id: `demo-seed-${i}`,
    game: s.game,
    status: s.status,
    stake: str(s.stake),
    params,
    market,
    entryValue: str(s.stake),
    markValue: str(payout),
    pnl: str(s.pnl),
    multiplier: s.mult || 1,
    payout: str(payout),
    entrySpot: pxStr(entry),
    settlePrice: pxStr(settlePrice),
    openedAt,
    settledAt,
    txMint: demoDigest(),
    txRedeem: won ? demoDigest() : undefined,
  }
}

// === Init ===
// Runs last so load() -> freshState() can safely reference everything declared above.
state = load()
for (const p of state.history) byId.set(p.id, p)
