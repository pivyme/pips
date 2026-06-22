// The game price layer. Two prices, one source of motion:
//
//  - engineSpot: the real Pyth anchor times a smooth, bounded, mean-reverting volatility walk, so a
//    30-60s round actually MOVES (real markets barely twitch over half a minute, a tight band would
//    always win and the chart would sit flat). OPERATOR ONLY. This is the value the price-pusher writes
//    on-chain and oracle-roll stands oracles up at, so it BECOMES the oracle price. The offset is pulled
//    back toward the live anchor and hard-clamped every tick, so it tracks real BTC with enough life.
//
//  - gameSpot: the DISPLAY price (the chart stream, the /markets spot, the cash-out exit). It is the
//    on-chain oracle spot, eased. This is the single price the player ever sees, in BOTH modes. The
//    operator used to chart engineSpot raw while only ~1-2s snapshots of it hit the oracle, so the live
//    line drifted off the entry (the pushed spot) and the strike (solved against it), and settlement read
//    a price the chart never showed (the misleading entry/target bug). Charting the PUSHED spot instead
//    makes the line exactly what prices and settles the round: entry and target sit on its real path.
//
// One in-process engine. The operator runs the walk AND serves the stream; charting the pushed spot
// (not the raw walk) is what keeps the line and the chain identical. Scaling horizontally? Run the
// operator (and this engine) on exactly ONE instance, the OPERATOR_ENABLED single-leader rule.

import { GAME_VOL } from '../config/main-config.ts';
import { getSpot } from './price-cache.ts';
import { assetSpot } from './sui/markets.ts';

// Tuned so the realized move over a ~45s round is ~0.6% (calibrated): a ±0.1% band is a real long
// shot, ±0.5% is roughly a coin flip, and wide bands are the safe, low-payout end. Motion stays
// smooth (per-tick ~0.04%) with the occasional sharp wick for a lively pop. Magnitudes scale with
// GAME_VOL; the shape params (momentum, revert, decay) do not.
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

// The display feed (gameSpot uses this in BOTH modes now): the on-chain oracle spot, eased so the
// ~1-2s push/sync steps glide instead of stepping. assetSpot is the operator's freshly pushed price
// (the pusher writes it each tick) or, on a follower, the price market-sync mirrors off chain. Serving
// THIS as the chart means the line, the entry (the pushed spot), the strike (solved against it), and
// the settlement all read one price, with no second walk to drift from (the bug that floated the
// entry/target off the live line). Falls back to raw Pyth only on a cold boot before any oracle spot.
const followShown = new Map<string, { price: number; at: number }>();
const FOLLOW_TAU_MS = 650; // smoothing time constant for the ~2s chain-spot steps. Kept short so the
// served line tracks the oracle closely (it is what "am I winning" and the win-zone shading read);
// a long tau lags the oracle on a fast move and can show the line above target when it settled below.

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

// The synthetic walk: the real Pyth anchor times the bounded vol offset. OPERATOR ONLY, and the value
// the price-pusher writes on-chain + oracle-roll stands oracles up at, so it BECOMES the oracle price
// (it is never charted raw, gameSpot charts the pushed-and-eased version). Returns null only on a cold
// start where Pyth has never answered. With GAME_VOL <= 0 it is pure Pyth pass-through (kill switch).
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

// The display price every game screen shows: the on-chain oracle spot, eased (followerSpot). The same
// in both modes now, so the chart line IS the price the round prices and settles against, and the
// entry/target lines drawn on it can never sit where the line never went. With GAME_VOL <= 0 it is pure
// Pyth pass-through (kill switch). Null only on a cold boot before any oracle has a spot.
export async function gameSpot(asset: string): Promise<{ price: number; ts: number } | null> {
  if (GAME_VOL <= 0) return getSpot(asset);
  return followerSpot(asset);
}
