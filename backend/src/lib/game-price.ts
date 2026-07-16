// Two prices, one source of motion: engineSpot (operator-only synthetic walk that becomes the oracle
// price) and gameSpot (the eased on-chain spot every player/chart/settlement reads). Scale to one instance only, the operator runs the walk (OPERATOR_ENABLED single-leader rule).

import { GAME_VOL } from '../config/main-config.ts';
import { getSpot } from './price-cache.ts';
import { assetSpot } from './sui/markets.ts';

// Tuned so a ~45s round realizes ~0.6% move (calibrated): ±0.1% bands are a real long shot, ±0.5% is
// roughly a coin flip. Motion stays smooth per-tick with occasional wicks for a lively pop. Magnitudes scale with GAME_VOL, the shape params (momentum/revert/decay) do not.
const TICK_MS = 250;
const MOMENTUM = 0.88; // velocity persistence: turns per-tick noise into smooth trends, not jitter
const VOL = 0.000208 * GAME_VOL; // per-tick velocity impulse (uniform amplitude)
const MAX_VEL = 0.0025 * GAME_VOL; // clamp a run so the line never bolts
const REVERT = 0.02; // pull the offset back toward the real anchor each tick (stays honest)
const MAX_OFF = 0.03 * GAME_VOL; // hard clamp on how far we ever stray from Pyth
const SPIKE_PROB = 0.03; // chance per tick of a sharp wick (the lively pop)
const SPIKE_MAG = 0.0016 * GAME_VOL; // wick size as a fraction of price
const TRANSIENT_DECAY = 0.4; // a wick snaps back within a couple ticks
const ANCHOR_TTL_MS = 900; // re-pull the real Pyth anchor at most this often (getSpot caches ~900ms)

type Cell = { anchor: number; anchorAt: number; off: number; vel: number; tr: number };
const cells = new Map<string, Cell>();
let timer: ReturnType<typeof setInterval> | null = null;

// Advance one asset's synthetic offset: a momentum walk pulled back toward 0 (the anchor), plus a
// fast-decaying wick. Pure state mutation, no I/O, so the timer can sweep every cell cheaply.
function step(c: Cell): void {
  c.vel = c.vel * MOMENTUM + (Math.random() * 2 - 1) * VOL;
  if (c.vel > MAX_VEL) c.vel = MAX_VEL;
  else if (c.vel < -MAX_VEL) c.vel = -MAX_VEL;
  c.off += c.vel;
  c.off -= c.off * REVERT;
  if (c.off > MAX_OFF) c.off = MAX_OFF;
  else if (c.off < -MAX_OFF) c.off = -MAX_OFF;
  c.tr *= TRANSIENT_DECAY;
  if (Math.random() < SPIKE_PROB) c.tr += (Math.random() < 0.5 ? -1 : 1) * SPIKE_MAG;
}

function ensureEngine(): void {
  if (timer) return;
  timer = setInterval(() => {
    for (const c of cells.values()) step(c);
  }, TICK_MS);
  // Don't keep the process alive on this timer alone.
  (timer as { unref?: () => void }).unref?.();
}

// Fire-and-forget anchor refresh, throttled. getSpot itself caches Pyth, so this is cheap and never
// blocks a read.
function refreshAnchor(asset: string, c: Cell): void {
  if (Date.now() - c.anchorAt < ANCHOR_TTL_MS) return;
  c.anchorAt = Date.now(); // claim the slot up front so concurrent reads don't all fetch
  void getSpot(asset).then((s) => {
    if (s) c.anchor = s.price;
  });
}

// The display feed (gameSpot, both modes): the on-chain oracle spot, eased so the ~1-2s push/sync steps
// glide. assetSpot is the operator's freshly pushed price (or, on a follower, what market-sync mirrors), so chart/entry/strike/settlement all read one price, no second walk to drift from. Falls back to raw Pyth on a cold boot.
const followShown = new Map<string, { price: number; at: number }>();
const FOLLOW_TAU_MS = 650; // smoothing constant for the ~2s chain-spot steps, kept short so the line
// tracks the oracle closely; a long tau can show the line above target when it settled below (win-zone shading reads this).

async function followerSpot(asset: string): Promise<{ price: number; ts: number } | null> {
  let target = assetSpot(asset);
  if (target == null || target <= 0) {
    const s = await getSpot(asset);
    target = s ? s.price : null;
  }
  if (target == null || target <= 0) return null;
  const now = Date.now();
  const cur = followShown.get(asset);
  if (!cur) {
    followShown.set(asset, { price: target, at: now });
    return { price: target, ts: now };
  }
  const k = 1 - Math.exp(-(now - cur.at) / FOLLOW_TAU_MS);
  cur.price += (target - cur.price) * k;
  cur.at = now;
  return { price: cur.price > 0 ? cur.price : target, ts: now };
}

// The synthetic walk: real Pyth anchor times a bounded vol offset. OPERATOR ONLY; the price-pusher writes
// this on-chain so it BECOMES the oracle price (never charted raw, gameSpot charts the pushed-and-eased version). Null only on a cold start; GAME_VOL <= 0 is a pure Pyth pass-through kill switch.
export async function engineSpot(asset: string): Promise<{ price: number; ts: number } | null> {
  if (GAME_VOL <= 0) return getSpot(asset);
  let c = cells.get(asset);
  if (!c) {
    const s = await getSpot(asset);
    if (!s) return null;
    c = { anchor: s.price, anchorAt: Date.now(), off: 0, vel: 0, tr: 0 };
    cells.set(asset, c);
    ensureEngine();
  } else {
    refreshAnchor(asset, c);
  }
  const price = c.anchor * (1 + c.off + c.tr);
  return { price: price > 0 ? price : c.anchor, ts: Date.now() };
}

// The display price every game screen shows: the eased on-chain oracle spot (followerSpot), same in both
// modes, so the chart line IS the price the round prices/settles against (entry/target can never sit where the line never went). GAME_VOL <= 0 is a Pyth pass-through kill switch; null only on a cold boot.
export async function gameSpot(asset: string): Promise<{ price: number; ts: number } | null> {
  if (GAME_VOL <= 0) return getSpot(asset);
  return followerSpot(asset);
}
