// Proves BREAKOUT's BREAK ladder is mintable end to end, the same check verify-snipe-walls.ts runs for SNIPE.
// Both legs mint in ONE PTB, so a single inadmissible leg kills the whole play: a rung is only good if BOTH
// sides place. It drives the resolve path's own preflight, so what is verified is what mints.
//
// It also states the number the game lives or dies on: the survivor's payout over the WHOLE play's cost.
// Under 1.00x means a break pays less than it cost, which is the one way this game is broken on arrival.
//
//   cd backend && bun scripts/verify-breakout-ladder.ts
//
// Throws (non-zero exit) if any rung fails, so it is usable as a gate. Read-only: quote_mint needs no wrapper
// and no chips, so nothing is spent (L-010).
import '../dotenv.ts';

import { BREAKOUT_LEG_PROBS, BREAKOUT_LEGS, probeBreakoutRung } from '../src/services/games-real.ts';
import { syncMarketsOnce } from '../src/workers/market-sync.ts';

// The $1.50 MIN_STAKE per leg, i.e. exactly the net one leg of a real play is sized against.
const LEG_NET_RAW = 1_500_000n;
// The public fullnode allows ~100 req/30s per IP (L-032), and a preflight is several quotes, so pace the rungs.
const GAP_MS = 1200;
const LEAN_LABEL: Record<number, string> = { 0: 'even', 1: 'up  ', [-1]: 'down' };

await syncMarketsOnce();

const rungs = BREAKOUT_LEG_PROBS.flatMap((_, breakIdx) => [0, 1, -1].map((lean) => ({ breakIdx, lean })));
let failed = 0;
let header = false;

for (const { breakIdx, lean } of rungs) {
  const probe = await probeBreakoutRung(breakIdx, lean, LEG_NET_RAW);
  if (!header) {
    console.log(`market ${probe.marketId}`);
    console.log(`spot   $${(Number(probe.spot1e9) / 1e9).toFixed(2)}  ·  ${probe.seconds.toFixed(0)}s to expiry`);
    console.log(`probing ${rungs.length} rungs, ${Number(BREAKOUT_LEGS)} legs each, at $1.50 per leg, 1x leverage\n`);
    header = true;
  }

  const label = `break ${breakIdx}  lean ${LEAN_LABEL[lean]}  target ${probe.legs.map((l) => (l.target * 100).toFixed(0) + '%').join('/')}`;
  const placed = probe.legs.map((l) => l.placed);
  if (placed.some((p) => p === null)) {
    failed++;
    console.log(`  REFUSED  ${label}  (${probe.legs.filter((l) => !l.placed).map((l) => l.side).join('+')} leg)`);
    continue;
  }

  const legs = placed as NonNullable<(typeof placed)[number]>[];
  const walls = legs.map((l) => (Number(l.strike1e9) / 1e9).toFixed(0));
  const total = legs.reduce((sum, l) => sum + l.amountRaw, 0n);
  // Only one leg can pay, so the guaranteed multiple is the SMALLEST payout over the whole play's cost.
  const survivor = legs.reduce((least, l) => Math.min(least, Number(l.amountRaw) / l.entryProbability), Infinity);
  const mult = survivor / Number(total);
  const breaks = legs.reduce((sum, l) => sum + l.entryProbability, 0);
  if (mult <= 1) failed++;
  console.log(
    `  ${mult > 1 ? 'ok      ' : 'UNDER 1x'} ${label}  ` +
    `walls ${walls[1]}/${walls[0]}  chain p ${legs.map((l) => (l.entryProbability * 100).toFixed(1) + '%').join('/')}  ` +
    `breaks ${(breaks * 100).toFixed(0).padStart(2)}% of rounds  pays ${mult.toFixed(2)}x  cost $${(Number(total) / 1e6).toFixed(2)}`,
  );
  await new Promise((r) => setTimeout(r, GAP_MS));
}

console.log(`\n${rungs.length - failed}/${rungs.length} rungs mintable and above 1.00x`);
if (failed > 0) throw new Error(`${failed} BREAKOUT rung(s) would abort or pay under cost; the ladder is not shippable`);
