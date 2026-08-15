// Proves SNIPE's wall travel is mintable end to end, the same check verify-pin-ladder.ts runs for PIN. Every
// wall the knob can plant, both sides, is quoted against the live market: a wall the chain will not admit is
// a knob position that eats a tap, and the player planted it on purpose so there is nothing to fall back on.
//
// Uses quote_mint rather than a full simulate: it is the same read the resolve path preflights with, and it
// returns the chain's own entry probability, which is the number that decides admission.
//
//   cd backend && bun scripts/verify-snipe-walls.ts [stepsPerSide]
//
// Throws (non-zero exit) if any wall fails, so it is usable as a gate.
import '../dotenv.ts';

import { probeSnipeWalls, quoteSnipeModelReal } from '../src/services/games-real.ts';
import { LEVERAGE_ONE, quoteMint } from '../src/lib/sui/predict-real.ts';
import { syncMarketsOnce } from '../src/workers/market-sync.ts';

const STEPS = Number(process.argv[2]) || 6;
const BUDGET_RAW = 1_320_000n; // the $1.50 MIN_STAKE less the 12% fee headroom, i.e. what a real play draws
// The public fullnode allows ~100 req/30s per IP (L-032) and quoteMint swallows failures as null, so a
// parallel sweep reports phantom rejections. One at a time.
const GAP_MS = 200;

await syncMarketsOnce();
await quoteSnipeModelReal(); // warms the implied-vol fit, or the travel is sized off the seed, not the surface

const probe = await probeSnipeWalls(STEPS);
console.log(`market ${probe.marketId}`);
console.log(`spot   $${(Number(probe.spot1e9) / 1e9).toFixed(2)}  ·  ${probe.seconds.toFixed(0)}s to expiry  ·  sigma $${((probe.sigma * Number(probe.spot1e9)) / 1e9).toFixed(2)}`);
console.log(`probing ${probe.walls.length} walls at $1.50, 1x leverage\n`);

let failed = 0;
for (const w of probe.walls) {
  const q = await quoteMint({
    marketId: probe.marketId,
    lowerTick: w.lowerTick,
    higherTick: w.higherTick,
    maxPremiumRaw: BUDGET_RAW,
    leverage1e9: LEVERAGE_ONE,
  });
  const gap = (Number(w.strike1e9 - probe.spot1e9) / 1e9).toFixed(0);
  const label = `${w.side.padEnd(4)} wall ${(Number(w.strike1e9) / 1e9).toFixed(0)}  gap ${gap.padStart(5)}  ${w.distSigma.toFixed(2)}s`;
  if (!q || q.allInCostRaw === 0n) {
    failed++;
    console.log(`  REFUSED  ${label}`);
    continue;
  }
  const p = Number(q.entryProbability1e9) / 1e9;
  console.log(`  ok       ${label}  entry_p ${(p * 100).toFixed(2).padStart(5)}%  ${(Number(q.quantityRaw) / Number(q.allInCostRaw)).toFixed(2)}x  cost $${(Number(q.allInCostRaw) / 1e6).toFixed(2)}`);
  await new Promise((r) => setTimeout(r, GAP_MS));
}

console.log(`\n${probe.walls.length - failed}/${probe.walls.length} walls admit`);
if (failed > 0) throw new Error(`${failed} SNIPE wall(s) would abort on admission; the travel is not mintable`);
