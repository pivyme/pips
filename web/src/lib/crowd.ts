// The crowd sim: fake other-players riding the Range V2 chart, so a round never reads dead. Pure logic,
// zero React, zero chain. It consumes an abstract "live price" + a clock and emits rider lifecycle events.
// The whole visual layer (CrowdLayer) drives it from one rAF. Prod can later swap this dummy source for a
// real anonymized play feed with CrowdLayer untouched. This file is where ALL fake data + tuning lives.
//
// DEMO/PROTOTYPE ONLY: fabricated trades are fine for feel-testing but shipping fake social proof to real
// users is a trust issue. Keep it behind the abstract event source and decide the data source before prod.

export type RiderKind = 'surfer' | 'sitter'
// surfer rides the live leading edge with a live PnL floater (the hero, image #1); sitter holds its entry
// price height just behind the edge, ring green while the price sits in its band (image #2/#3).
export type RiderPhase = 'entering' | 'riding' | 'resolving' | 'leaving'

export interface Rider {
  id: number
  handle: string
  kind: RiderKind
  phase: RiderPhase
  phaseAt: number // ms (perf clock) the current phase started
  rideMs: number // total time spent in `riding`
  entryPrice: number // price at spawn; the sitter's held height + the surfer's PnL anchor
  halfFrac: number // sitter band half-width as a fraction of entry (0 for a surfer)
  stake: number // cosmetic chip size
  mult: number // cosmetic payout multiple
  inFavor: boolean // price currently on the winning side (drives the green ring + floater color)
  livePnl: number // cosmetic live PnL while riding
  pnl: number // final PnL, set at resolve
  won: boolean
}

export interface CrowdConfig {
  enabled: boolean
  targetRiders: number // steady-state concurrent riders
  maxRiders: number // hard cap (perf: the 3D console sits underneath)
  spawnMinMs: number
  spawnMaxMs: number
  rideMinMs: number
  rideMaxMs: number
  surferFrac: number // share of surfers vs sitters
  reduced: boolean // reduced motion: quieter, fewer riders (CrowdLayer also drops the bob/spin)
}

// The lively-but-tasteful default: ~3-5 riders, your own play still stays loudest.
export const DEFAULT_CROWD: CrowdConfig = {
  enabled: true,
  targetRiders: 4,
  maxRiders: 5,
  spawnMinMs: 1200,
  spawnMaxMs: 3000,
  rideMinMs: 6000,
  rideMaxMs: 20000,
  surferFrac: 0.3,
  reduced: false,
}

export interface CrowdHooks {
  onRoster?: (ids: number[]) => void // the rider SET changed (enter/leave); CrowdLayer re-renders only here
  onPlace?: (r: Rider) => void // a rider entered: coin-pop + crowdPlace() sting
  onResolve?: (r: Rider) => void // a rider resolved: on a win, the crowdWin() shimmer
}

// ~24 degen handles; each is deterministic to an identicon color via avatarColor(), so no new assets.
const HANDLES = [
  'kelvin', 'degenkat', 'moonboy', '0xrekt', 'sizechad', 'pip.sui', 'apuu', 'gigabrain',
  'ser.long', 'notfinancial', 'rugsurvivor', 'tendies', 'hodlqueen', 'fatfinger', 'liquidator',
  'sniperx', 'based.sui', 'floorsweep', 'copetrader', 'npc.exe', 'vibecheck', 'lambo.soon',
  'exitliq', 'deepbook',
]
const STAKES = [1, 2, 5, 10, 25]

const ENTER_MS = 350
const RESOLVE_MS = 600
const LEAVE_MS = 520
// A surfer's floater reaches its full magnitude at this move off entry; keeps the numbers believable
// (a short BTC round only drifts a few basis points) instead of unbounded.
const SURF_REACH_FRAC = 0.004

const rand = (a: number, b: number): number => a + Math.random() * (b - a)
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]

export class CrowdSim {
  riders: Rider[] = []
  private cfg: CrowdConfig
  private hooks: CrowdHooks
  private seq = 1
  private nextSpawnAt = 0
  private lastTick = 0

  constructor(cfg: CrowdConfig, hooks: CrowdHooks) {
    this.cfg = cfg
    this.hooks = hooks
  }

  setConfig(cfg: CrowdConfig): void {
    this.cfg = cfg
  }

  // Advance the crowd one frame. `now` is the rAF clock, `price` the live eased chart price.
  tick(now: number, price: number): void {
    if (!this.lastTick) this.lastTick = now
    const gap = now - this.lastTick
    this.lastTick = now
    // Tab was backgrounded (rAF paused): shift every timer by the gap so riders don't all age out and
    // fire a burst of resolves/sounds on return. Skip this frame's spawn.
    if (gap > 800) {
      for (const r of this.riders) r.phaseAt += gap
      this.nextSpawnAt += gap
      return
    }
    if (!this.cfg.enabled || !(price > 0)) return

    if (!this.nextSpawnAt) this.nextSpawnAt = now + rand(300, 1200)
    let rosterChanged = false
    if (this.riders.length < this.cfg.targetRiders && this.riders.length < this.cfg.maxRiders && now >= this.nextSpawnAt) {
      this.spawn(now, price)
      this.nextSpawnAt = now + rand(this.cfg.spawnMinMs, this.cfg.spawnMaxMs)
      rosterChanged = true
    }

    for (let i = this.riders.length - 1; i >= 0; i--) {
      const r = this.riders[i]
      this.updateLive(r, price, now)
      const age = now - r.phaseAt
      if (r.phase === 'entering') {
        if (age >= ENTER_MS) this.setPhase(r, 'riding', now)
      } else if (r.phase === 'riding') {
        if (age >= r.rideMs) {
          this.resolve(r, price)
          this.setPhase(r, 'resolving', now)
          this.hooks.onResolve?.(r)
        }
      } else if (r.phase === 'resolving') {
        if (age >= RESOLVE_MS) this.setPhase(r, 'leaving', now)
      } else if (age >= LEAVE_MS) {
        this.riders.splice(i, 1)
        rosterChanged = true
      }
    }

    if (rosterChanged) this.hooks.onRoster?.(this.riders.map((r) => r.id))
  }

  clear(): void {
    this.riders = []
    this.nextSpawnAt = 0
    this.lastTick = 0
  }

  private setPhase(r: Rider, phase: RiderPhase, now: number): void {
    r.phase = phase
    r.phaseAt = now
  }

  private spawn(now: number, price: number): void {
    const kind: RiderKind = Math.random() < this.cfg.surferFrac ? 'surfer' : 'sitter'
    const r: Rider = {
      id: this.seq++,
      handle: pick(HANDLES),
      kind,
      phase: 'entering',
      phaseAt: now,
      rideMs: rand(this.cfg.rideMinMs, this.cfg.rideMaxMs),
      entryPrice: price,
      halfFrac: kind === 'sitter' ? rand(0.0006, 0.0026) : 0,
      stake: pick(STAKES),
      mult: rand(1.3, 4.2),
      inFavor: true,
      livePnl: 0,
      pnl: 0,
      won: false,
    }
    this.riders.push(r)
    this.hooks.onPlace?.(r)
  }

  // Cosmetic live PnL + in-favor state off the REAL price, so the fake crowd reacts to the real chart.
  private updateLive(r: Rider, price: number, now: number): void {
    if (r.phase === 'resolving' || r.phase === 'leaving') return
    if (r.kind === 'surfer') {
      const chg = r.entryPrice > 0 ? (price - r.entryPrice) / r.entryPrice : 0
      r.inFavor = chg >= 0
      const reach = Math.min(1, Math.abs(chg) / SURF_REACH_FRAC)
      const mag = r.stake * (r.mult - 1) // a plausible win size for this chip
      r.livePnl = (chg >= 0 ? 1 : -1) * mag * reach
    } else {
      const lo = r.entryPrice * (1 - r.halfFrac)
      const hi = r.entryPrice * (1 + r.halfFrac)
      const inZone = price > lo && price <= hi
      r.inFavor = inZone
      const prog = Math.min(1, Math.max(0, now - r.phaseAt) / r.rideMs)
      r.livePnl = inZone ? r.stake * (r.mult - 1) * Math.min(1, prog + 0.2) : -r.stake * Math.min(1, prog * 1.2)
    }
  }

  private resolve(r: Rider, price: number): void {
    if (r.kind === 'surfer') {
      r.won = r.inFavor
      const chg = r.entryPrice > 0 ? Math.abs(price - r.entryPrice) / r.entryPrice : 0
      const reach = Math.min(1, chg / SURF_REACH_FRAC)
      const mag = r.stake * (r.mult - 1)
      r.pnl = r.won ? Math.max(mag * 0.25, mag * reach) : -r.stake
    } else {
      const lo = r.entryPrice * (1 - r.halfFrac)
      const hi = r.entryPrice * (1 + r.halfFrac)
      r.won = price > lo && price <= hi
      r.pnl = r.won ? r.stake * (r.mult - 1) : -r.stake
    }
  }
}
