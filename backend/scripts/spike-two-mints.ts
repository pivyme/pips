// The BREAKOUT gate (04-GAMES-LAB.md §7): can one PTB mint TWO legs, both or neither?
//
// If it can, every future multi-leg game is unlocked and BREAKOUT's "you are never left holding a naked
// directional bet" is enforced by the chain rather than by a compensating close. Read-only: this simulates,
// so it spends nothing and nothing lands (L-010).
//
//   cd backend && bun scripts/spike-two-mints.ts
import '../dotenv.ts';

import { Transaction, coinWithBalance } from '@mysten/sui/transactions';

import { suiClient } from '../src/lib/sui/client.ts';
import {
  LEVERAGE_ONE,
  POSITION_LOT_SIZE,
  buildAuth,
  buildDepositFunds,
  buildLoadPricer,
  buildMintExactAmount,
  quoteMint,
  resolveWrapper,
  ticksForBinary,
} from '../src/lib/sui/predict-real.ts';
import { DUSDC_TYPE } from '../src/lib/sui/config.ts';
import { REAL_ACCOUNT_PACKAGE, REAL_ACCOUNT_REGISTRY_ID } from '../src/lib/sui/config-real.ts';
import { treasuryAddress } from '../src/lib/sui/signer.ts';
import { liveByAsset } from '../src/lib/sui/markets.ts';
import { syncMarketsOnce } from '../src/workers/market-sync.ts';
import { probit } from '../src/services/games-real.ts';

if (!treasuryAddress) throw new Error('no treasury key: the simulate sender must hold the deposit DUSDC');

const AMOUNT_RAW = 1_320_000n; // the $1.50 stake's premium budget, per leg
const DEPOSIT_RAW = 4_000_000n; // both legs plus fee headroom
const TARGET_LEG_PROB = 0.2; // per leg, so the surviving leg's ~5x clears both premiums
const SECONDS_PER_YEAR = 365.25 * 24 * 3600;
const MIN_LIFE_MS = 30_000; // a nearly-dead market has ~no sigma, so every strike would read unmintable

await syncMarketsOnce();
const market = liveByAsset('BTC', Date.now(), MIN_LIFE_MS)[0];
if (!market) throw new Error(`no BTC market with ${MIN_LIFE_MS / 1000}s+ left right now`);

const seconds = Math.max(1, (market.expiryMs - Date.now()) / 1000);
const spot1e9 = BigInt(market.spot1e9!);
const tickSize = BigInt(market.tickSize);
const admissionTickSize = BigInt(market.admissionTickSizeRaw!);

// Break sized by target win probability, never a fixed percentage (L-013). The vol is measured off the
// chain's own quote below, so the seed only has to land in the admissible neighbourhood.
const legTicks = (breakFrac: number) => {
  const off = (spot1e9 * BigInt(Math.round(breakFrac * 1e9))) / 1_000_000_000n;
  return {
    off,
    up: ticksForBinary('up', spot1e9 + off, tickSize, admissionTickSize),
    down: ticksForBinary('down', spot1e9 - off, tickSize, admissionTickSize),
  };
};

// One read-only quote fits the vol the chain is actually pricing with, then the break is re-solved on it.
let sigmaAnnual = 0.2;
let breakFrac = probit(1 - TARGET_LEG_PROB) * sigmaAnnual * Math.sqrt(seconds / SECONDS_PER_YEAR);
for (let i = 0; i < 3; i++) {
  const { up } = legTicks(breakFrac);
  const q = await quoteMint({ marketId: market.oracleId, lowerTick: up.lowerTick, higherTick: up.higherTick, maxPremiumRaw: AMOUNT_RAW, leverage1e9: LEVERAGE_ONE });
  if (!q) break;
  const p = Number(q.entryProbability1e9) / 1e9;
  console.log(`  fit ${i}: break +-$${(Number(breakFrac) * Number(spot1e9)) / 1e9 / 1} -> chain p ${(p * 100).toFixed(1)}%`);
  if (Math.abs(p - TARGET_LEG_PROB) < 0.02) break;
  sigmaAnnual = breakFrac / (probit(1 - p) * Math.sqrt(seconds / SECONDS_PER_YEAR));
  breakFrac = probit(1 - TARGET_LEG_PROB) * sigmaAnnual * Math.sqrt(seconds / SECONDS_PER_YEAR);
}

const { off, up, down } = legTicks(breakFrac);
const w = await resolveWrapper(treasuryAddress);

console.log(`\nmarket ${market.oracleId}  spot ${Number(spot1e9) / 1e9}  ${seconds.toFixed(0)}s left  break +-$${(Number(off) / 1e9).toFixed(2)}`);
console.log(`up   ticks ${up.lowerTick}/${up.higherTick}`);
console.log(`down ticks ${down.lowerTick}/${down.higherTick}\n`);

const tx = new Transaction();
// Same wrapper handling as buildMintPlay: a first-ever wrapper is created and threaded by ref, then shared last.
const wrapper = w.exists
  ? tx.object(w.wrapperId)
  : tx.moveCall({ target: `${REAL_ACCOUNT_PACKAGE}::account_registry::new`, arguments: [tx.object(REAL_ACCOUNT_REGISTRY_ID)] });

// One deposit covering both legs, ONE pricer, two mints. mint_exact_amount takes `pricer: &Pricer`
// (expiry_market.move:479), so the same pricer serves both legs; each mint takes its own fresh Auth.
buildDepositFunds(tx, wrapper, buildAuth(tx), coinWithBalance({ type: DUSDC_TYPE, balance: DEPOSIT_RAW })(tx));
const pricer = buildLoadPricer(tx, market.oracleId);
for (const leg of [up, down]) {
  buildMintExactAmount(tx, {
    marketId: market.oracleId,
    wrapper,
    auth: buildAuth(tx),
    pricer,
    lowerTick: leg.lowerTick,
    higherTick: leg.higherTick,
    amountRaw: AMOUNT_RAW,
    minQuantityRaw: POSITION_LOT_SIZE,
    leverage1e9: LEVERAGE_ONE,
  });
}
if (!w.exists) tx.moveCall({ target: `${REAL_ACCOUNT_PACKAGE}::account::share`, arguments: [wrapper] });
tx.setSender(treasuryAddress);

const res = await suiClient.simulateTransaction({ transaction: tx, include: { events: true }, checksEnabled: false });
if (res.$kind !== 'Transaction') {
  console.log(JSON.stringify(res, (_k, v) => (typeof v === 'bigint' ? String(v) : v)).slice(0, 1200));
  throw new Error(`simulate returned ${res.$kind}`);
}
const t = res.Transaction as unknown as { status?: { success?: boolean; error?: unknown }; events?: Array<{ eventType?: string; json?: unknown }> };
const minted = (t.events ?? []).filter((e) => (e.eventType ?? '').endsWith('::order_events::OrderMinted'));

console.log(`status  ${t.status?.success ? 'SUCCESS' : 'FAILED'}`);
if (!t.status?.success) console.log(`error   ${JSON.stringify(t.status?.error)}`);
console.log(`OrderMinted events: ${minted.length}`);
for (const e of minted) {
  const j = e.json as Record<string, unknown>;
  const net = Number(j.net_premium) / 1e6;
  const fees = (Number(j.trading_fee) + Number(j.builder_fee) + Number(j.penalty_fee)) / 1e6;
  console.log(
    `  order ${String(j.order_id).slice(0, 12)}…  qty ${Number(j.quantity) / 1e6}  p ${(Number(j.entry_probability) / 1e7).toFixed(1)}%` +
    `  cost $${(net + fees).toFixed(2)}  mult ${((Number(j.quantity) / 1e6) / (net + fees)).toFixed(2)}x  ticks ${j.lower_tick}/${j.higher_tick}`,
  );
}
console.log(`\nSPIKE ${t.status?.success && minted.length === 2 ? 'PASSES: one PTB, two legs, both or neither' : 'FAILS'}`);
process.exit(0);
