// Crowd sim: emits spaced, ephemeral "someone just placed a range" events so the Range V2 chart feels
// alive without a persistent pile of avatars. Pure logic, no React, no chain. CrowdLayer turns each event
// into a brief band flash + a fast coin pop, then it's gone. Deliberately restrained: one pulse at a time,
// never a stack. Prototype/demo dummy data behind an abstract event source, swap to a real anonymized feed
// later with the visual layer untouched. See .claude/RANGE-V2-CROWD.md.
//
// DEMO/PROTOTYPE ONLY: fabricated trades are fine for feel-testing but shipping fake social proof to real
// users is a trust issue. Keep it behind this event source and decide the data source before prod.

export interface CrowdPlace {
  id: number
  handle: string
  entryPrice: number // where their band centers (near the live price)
  halfFrac: number // band half-width as a fraction of entry
}

export interface CrowdConfig {
  enabled: boolean
  minGapMs: number // min time between crowd places
  maxGapMs: number
  reduced: boolean // reduced motion: calmer cadence
}

// Lively but tasteful: a place every ~1.7-3.8s, so the chart breathes without ever getting busy.
export const DEFAULT_CROWD: CrowdConfig = { enabled: true, minGapMs: 1700, maxGapMs: 3800, reduced: false }

export interface CrowdHooks {
  onPlace: (e: CrowdPlace) => void
}

// ~24 degen handles; each is deterministic to an identicon color via avatarColor(), so no new assets.
const HANDLES = [
  'kelvin', 'degenkat', 'moonboy', '0xrekt', 'sizechad', 'pip.sui', 'apuu', 'gigabrain',
  'ser.long', 'notfinancial', 'rugsurvivor', 'tendies', 'hodlqueen', 'fatfinger', 'liquidator',
  'sniperx', 'based.sui', 'floorsweep', 'copetrader', 'npc.exe', 'vibecheck', 'lambo.soon',
  'exitliq', 'deepbook',
]

const rand = (a: number, b: number): number => a + Math.random() * (b - a)
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]

export class CrowdSim {
  private cfg: CrowdConfig
  private hooks: CrowdHooks
  private seq = 1
  private nextAt = 0
  private lastTick = 0

  constructor(cfg: CrowdConfig, hooks: CrowdHooks) {
    this.cfg = cfg
    this.hooks = hooks
  }

  setConfig(cfg: CrowdConfig): void {
    this.cfg = cfg
  }

  // Advance one frame. `now` is the rAF clock, `price` the live eased chart price.
  tick(now: number, price: number): void {
    if (!this.lastTick) this.lastTick = now
    const gap = now - this.lastTick
    this.lastTick = now
    // Tab was backgrounded (rAF paused): push the next place out by the gap, don't fire a burst on return.
    if (gap > 800) {
      this.nextAt += gap
      return
    }
    if (!this.cfg.enabled || !(price > 0)) return
    if (!this.nextAt) this.nextAt = now + rand(500, 1600)
    if (now < this.nextAt) return

    // Band centers a hair off the live price so it reads as their own level, not glued to the line.
    const e: CrowdPlace = {
      id: this.seq++,
      handle: pick(HANDLES),
      entryPrice: price * (1 + (Math.random() - 0.5) * 0.001),
      halfFrac: rand(0.0006, 0.0026),
    }
    this.hooks.onPlace(e)
    const slow = this.cfg.reduced ? 1.8 : 1
    this.nextAt = now + rand(this.cfg.minGapMs, this.cfg.maxGapMs) * slow
  }

  reset(): void {
    this.nextAt = 0
    this.lastTick = 0
  }
}
