// BREAKOUT's real-play proof (04-GAMES-LAB.md §7): TWO two-leg plays at the $3.00 floor, one cashed out and
// one ridden to a real settlement. Prints play ids and tx digests for the wave doc's proof table.
//
// The claim this script exists to make is ATOMICITY: both legs land in ONE transaction or neither does. It
// asserts that from the stored row (two order ids, one mint digest, one redeem digest), so a half-open play
// throws here rather than being discovered by a player holding a naked directional bet.
//
//   cd backend && bun scripts/proof-breakout.ts [username]
//
// NEVER loop this (L-010). Two plays is the whole proof.
import '../dotenv.ts';

import { prismaQuery } from '../src/lib/prisma.ts';
import { createPlay, cashoutPlay } from '../src/services/plays.ts';
import { syncMarketsOnce } from '../src/workers/market-sync.ts';
import { explorerTxUrl } from '../src/lib/sui/client.ts';
import { decodeOrderId } from '../src/lib/sui/predict-real.ts';
import { BREAKOUT_LEGS } from '../src/services/games-real.ts';
import type { Play } from '../prisma/generated/client.js';

const USERNAME = process.argv[2] || 'devqa';
const LEG_STAKE = 1.5;
const STAKE = LEG_STAKE * Number(BREAKOUT_LEGS); // the play's TOTAL, which is what the wire carries
const BREAK_IDX = 1;
const TERMINAL = new Set(['won', 'lost', 'cashed_out', 'error']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const user = await prismaQuery.user.findFirst({ where: { username: USERNAME } });
if (!user) throw new Error(`no user ${USERNAME}`);
console.log(`user ${user.username} (${user.id})  ·  stake $${STAKE.toFixed(2)} = $${LEG_STAKE.toFixed(2)} x ${Number(BREAKOUT_LEGS)}\n`);

async function waitOpen(id: string, ms = 60_000): Promise<Play> {
  const until = Date.now() + ms;
  for (;;) {
    const p = await prismaQuery.play.findUniqueOrThrow({ where: { id } });
    if (p.status !== 'pending') return p;
    if (Date.now() > until) throw new Error(`play ${id} never left pending`);
    await sleep(500);
  }
}

async function waitTerminal(id: string, ms = 180_000): Promise<Play> {
  const until = Date.now() + ms;
  for (;;) {
    const p = await prismaQuery.play.findUniqueOrThrow({ where: { id } });
    if (TERMINAL.has(p.status)) return p;
    if (Date.now() > until) throw new Error(`play ${id} never settled`);
    await sleep(2000);
  }
}

const usd = (v: bigint | null) => (v == null ? 'n/a' : `$${(Number(v) / 1e6).toFixed(2)}`);

const report = (label: string, p: Play) => {
  console.log(label);
  console.log(`  play      ${p.id}`);
  console.log(`  status    ${p.status}   mult ${p.multiplier ?? 'n/a'}x   entry ${p.entrySpot}`);
  console.log(`  zones     pays below ${p.lower} or above ${p.upper}   expiry ${p.expiry}`);
  console.log(`  cost      ${usd(p.entryCost)}   payout ${usd(p.payout)}   pnl ${usd(p.pnl)}`);
  if (p.settlePrice) console.log(`  settled   ${p.settlePrice}`);
  if (p.txMint) console.log(`  txMint    ${p.txMint}  ${explorerTxUrl(p.txMint)}`);
  if (p.txRedeem) console.log(`  txRedeem  ${p.txRedeem}  ${explorerTxUrl(p.txRedeem)}`);
  console.log('');
};

/** The whole reason this game needed a spike: both legs mint, in the SAME transaction, or the play is dead. */
function assertAtomic(p: Play): void {
  const ids = p.marketKey.split(',').filter(Boolean);
  if (ids.length !== Number(BREAKOUT_LEGS)) throw new Error(`expected ${Number(BREAKOUT_LEGS)} legs, stored ${ids.length}: "${p.marketKey}"`);
  if (!p.txMint) throw new Error('no mint digest on an open play');
  const legs = ids.map((id) => decodeOrderId(BigInt(id)));
  // The down leg is lower-open (lowerTick 0), the up leg upper-open (higherTick pos_inf), so the two together
  // leave exactly the dead zone between them uncovered. Anything else is not the bet that was sold.
  const up = legs.find((l) => l.higherTick === 1_073_741_823n);
  const down = legs.find((l) => l.lowerTick === 0n);
  if (!up || !down) throw new Error(`legs are not one up + one down: ${JSON.stringify(legs.map((l) => [String(l.lowerTick), String(l.higherTick)]))}`);
  if (!(down.higherTick < up.lowerTick)) throw new Error(`zones overlap: down closes at ${down.higherTick}, up opens at ${up.lowerTick}`);
  console.log(`  atomic OK: ${ids.length} legs in ONE tx ${p.txMint.slice(0, 10)}…, dead zone between ticks ${down.higherTick} and ${up.lowerTick}\n`);
}

await syncMarketsOnce();

// === 1. mint two legs, then cash both out at the live bid ===
console.log('--- play A: two legs, cashed out ---');
const a = await createPlay(user, { game: 'breakout', stake: STAKE, asset: 'BTC', break: BREAK_IDX, lean: 0 });
const aOpen = await waitOpen(a.play.id);
if (aOpen.status !== 'open') throw new Error(`play A did not open: ${aOpen.status}`);
report('opened', aOpen);
assertAtomic(aOpen);

await sleep(3000);
const aCash = await cashoutPlay(user, aOpen.id);
const aFinal = await prismaQuery.play.findUniqueOrThrow({ where: { id: aCash.play.id } });
report('cashed out (both legs closed in one tx)', aFinal);

// === 2. mint two legs and ride the buzzer ===
console.log('--- play B: two legs, settled ---');
const b = await createPlay(user, { game: 'breakout', stake: STAKE, asset: 'BTC', break: BREAK_IDX, lean: 0 });
const bOpen = await waitOpen(b.play.id);
if (bOpen.status !== 'open') throw new Error(`play B did not open: ${bOpen.status}`);
report('opened', bOpen);
assertAtomic(bOpen);

console.log('waiting for the buzzer + the settle worker...\n');
const bFinal = await waitTerminal(bOpen.id);
report('settled', bFinal);

const spent = Number(aFinal.entryCost ?? 0n) + Number(bFinal.entryCost ?? 0n);
const back = Number(aFinal.payout ?? 0n) + Number(bFinal.payout ?? 0n);
console.log(`spent $${(spent / 1e6).toFixed(2)}  ·  recovered $${(back / 1e6).toFixed(2)}  ·  net $${((back - spent) / 1e6).toFixed(2)}`);
console.log('\nBREAKOUT proof complete: 2 plays, 4 legs, 2 mint txs, 2 redeem txs.');
process.exit(0);
