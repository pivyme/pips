// The game price feed. Real Pyth spot is the honest anchor; on top of it we run a smooth, bounded,
// mean-reverting volatility walk per asset so a 30-60s round actually MOVES. Real markets are too
// quiet over half a minute for a game: BTC barely twitches, so a tight range band would always win
// and the chart would sit flat. This is the one synthetic layer that makes a play feel like a play,
// and it is the SINGLE source for every game price, the chart stream, the oracle push, the settle
// nudge, and the /markets spot all read it, so what the player watches is exactly what settles.
//
// It never drifts from reality: every tick the offset is pulled back toward the live Pyth anchor and
// hard-clamped to a few percent, so the price tracks real BTC, just with enough life to be fun.
//
// One in-process engine. The operator backend both runs the workers AND serves the price stream, so
// a single shared walk keeps the chart and the chain identical by construction. If the API is ever
// scaled horizontally, run the operator (and thus this engine) on exactly ONE instance, the same
// single-leader rule the workers already follow (OPERATOR_ENABLED).

import { GAME_VOL, OPERATOR_ENABLED } from '../config/main-config.ts';
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

// Follower mode (this backend is NOT the operator): the operator owns the synthetic walk and pushes
// it on-chain, and market-sync mirrors that pushed price into the live market set. We serve THAT here,
// so the chart, the Lucky solve, and the on-chain settlement all read one price and there is no second
// walk to diverge from (the bug that floated the entry/target a few percent off the live line). Ease
// toward each market-sync step so the line glides instead of stepping. Falls back to raw Pyth only on
// a cold boot before any oracle is synced.
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

// The live game price for an asset: the real Pyth anchor times the synthetic offset. Returns null
// only on a cold start where Pyth has never answered for this asset, so callers fall back to raw.
// With GAME_VOL <= 0 it is a pure pass-through of real Pyth (the kill switch). In follower mode the
// operator's on-chain price is the single source (followerSpot), so we never run our own walk.
export async function gameSpot(asset: string): Promise<{ price: number; ts: number } | null> {
  if (GAME_VOL <= 0) return getSpot(asset);
  if (!OPERATOR_ENABLED) return followerSpot(asset);
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
