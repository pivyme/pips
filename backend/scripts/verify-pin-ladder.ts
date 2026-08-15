// Proves PIN's ladder is mintable before any multiple is offered on screen. Every (window, pin) corner the
// knob can reach is SIMULATED against the live market, so a rung that would abort on admission is caught here
// rather than by a player losing a tap. Nothing lands and nothing is spent: simulateMint is a dry run.
//
// This is the check 04-GAMES-LAB.md §6 demands for PIN: "verify the tightest rung actually admits before
// promising its multiple". A tight window planted far from spot is the failure case, because its entry
// probability collapses well under the chain's 1% min_entry_probability floor.
//
//   cd backend && bun scripts/verify-pin-ladder.ts [stepsPerSide]
//
// Throws (non-zero exit) if any rung fails, so it is usable as a gate.
import '../dotenv.ts';

import { probePinLadder, quotePinModelReal } from '../src/services/games-real.ts';
import { LEVERAGE_ONE, resolveWrapper, simulateMint } from '../src/lib/sui/predict-real.ts';
import { treasuryAddress } from '../src/lib/sui/signer.ts';
import { syncMarketsOnce } from '../src/workers/market-sync.ts';

const STEPS = Number(process.argv[2]) || 3;
const AMOUNT_RAW = 1_320_000n; // the $1.50 MIN_STAKE less the 12% fee headroom, i.e. what a real play draws
const DEPOSIT_RAW = 2_000_000n; // the mint pulls fees on top of the amount budget
// simulateMint swallows every failure as null, so a rate-limited probe is indistinguishable from an admission
// abort. The public fullnode allows ~100 req/30s per IP and each probe is several reads (L-032), so probes run
// one at a time: a parallel sweep reports phantom aborts and the ladder reads broken when it is not.
const PROBE_GAP_MS = 250;

if (!treasuryAddress) {
  console.error('no treasury key configured; simulation needs a sender');
  process.exit(1);
}

await syncMarketsOnce();
// Warms the implied-vol fit. Without it the ladder is sized off the REAL_BTC_ANNUAL_VOL seed (0.55) rather
// than the chain's own surface (~0.2), so every band comes out multiples too wide and the probe proves nothing.
await quotePinModelReal();

const first = await probePinLadder(STEPS);
const wrapper = await resolveWrapper(treasuryAddress);

console.log(`market ${first.marketId}`);
console.log(`spot   $${(Number(first.spot1e9) / 1e9).toFixed(2)}  ·  ${first.seconds.toFixed(0)}s to expiry  ·  sigma ${(first.sigma * 100).toFixed(4)}% ($${((first.sigma * Number(first.spot1e9)) / 1e9).toFixed(2)})`);
console.log(`probing ${first.bands.length} rungs at $1.50, 1x leverage\n`);

// Each rung re-solves against a fresh spot and the market's remaining life immediately before it is probed,
// which is what the resolve path does. Sizing the whole sweep once lets the clock and BTC move underneath it.
const results: Array<{ b: (typeof first.bands)[number]; r: Awaited<ReturnType<typeof simulateMint>> }> = [];
for (let i = 0; i < first.bands.length; i++) {
  await syncMarketsOnce();
  const ladder = await probePinLadder(STEPS);
  const b = ladder.bands[i];
  results.push({
    b,
    r: await simulateMint({
      marketId: ladder.marketId,
      lowerTick: b.lowerTick,
      higherTick: b.higherTick,
      amountRaw: AMOUNT_RAW,
      depositRaw: DEPOSIT_RAW,
      leverage1e9: LEVERAGE_ONE,
      sender: treasuryAddress,
      wrapperId: wrapper.wrapperId,
      wrapperExists: wrapper.exists,
    }),
  });
  await new Promise((r) => setTimeout(r, PROBE_GAP_MS));
}

let failed = 0;
for (const { b, r } of results) {
  const pin = (Number(b.pin1e9) / 1e9).toFixed(0);
  const off = `${b.offsetSigma >= 0 ? '+' : ''}${b.offsetSigma.toFixed(2)}s`;
  const label = `w${b.window} (p=${b.prob}) pin ${pin} ${off.padStart(7)} +/-$${b.halfUsd.toFixed(2).padStart(6)}`;
  if (!r) {
    failed++;
    console.log(`  ABORT  ${label}`);
    continue;
  }
  const p = Number(r.entryProbability1e9) / 1e9;
  const mult = Number(r.quantityRaw) / Number(r.costRaw);
  console.log(`  ok     ${label}  entry_p ${(p * 100).toFixed(2).padStart(5)}%  ${mult.toFixed(2)}x`);
}

console.log(`\n${results.length - failed}/${results.length} rungs admit`);
if (failed > 0) throw new Error(`${failed} PIN rung(s) would abort on admission; the ladder is not mintable`);
