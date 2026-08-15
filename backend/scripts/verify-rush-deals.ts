// RUSH's dealer, measured against the live chain. Read-only: every band here is a quote_mint devInspect, so
// this spends no chips and mints nothing (L-010). What it answers is the one thing the design rests on:
// does the stream actually thin and fatten with the appetite knob, and is the lowest rung a constant deal?
//
//   cd backend && bun scripts/verify-rush-deals.ts [beatsPerRung]
import '../dotenv.ts';

import { RUSH_APPETITES, dealRushOffer } from '../src/services/games.ts';
import { rakeOf } from '../src/lib/sui/house.ts';
import { toDusdcRaw } from '../src/lib/sui/config.ts';
import { syncMarketsOnce } from '../src/workers/market-sync.ts';

const BEATS = Number(process.argv[2] || 8);
const netRaw = rakeOf(toDusdcRaw(1.5)).net;

await syncMarketsOnce();

let dealtTotal = 0;
for (const appetite of RUSH_APPETITES) {
  const mults: number[] = [];
  for (let i = 0; i < BEATS; i++) {
    const o = await dealRushOffer(appetite, netRaw);
    if (o) mults.push(o.multiplier);
  }
  dealtTotal += mults.length;
  const lo = mults.length ? Math.min(...mults) : 0;
  const hi = mults.length ? Math.max(...mults) : 0;
  const under = mults.filter((m) => m < appetite).length;
  console.log(
    `>=${String(appetite).padStart(4)}x   dealt ${String(mults.length).padStart(2)}/${BEATS}` +
      `   ${mults.length ? `${lo.toFixed(2)}x to ${hi.toFixed(2)}x` : 'nothing on the table'}` +
      (under ? `   UNDER APPETITE x${under}` : ''),
  );
  // An offer under the appetite is a broken promise, not a thin stream: the knob is a floor.
  if (under) throw new Error(`dealer offered ${under} band(s) under the ${appetite}x appetite`);
}

console.log(`\n${dealtTotal}/${RUSH_APPETITES.length * BEATS} beats dealt, no band under its appetite`);
process.exit(0);
