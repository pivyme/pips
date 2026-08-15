// PRESS's real-play proof (04-GAMES-LAB.md §4): ONE opening box, at least ONE press nested inside it, ONE
// fold that closes what is still riding, and ONE box that rides the buzzer to a real settlement. Prints play
// ids and tx digests for the wave doc's proof table.
//
// Drives the real service path in-process, so the nesting, admission and OrderMinted snap are the product's.
// Settlement is left to the settle worker on the running backend.
//
//   cd backend && bun scripts/proof-press.ts [username]
//
// NEVER loop this (L-010). One round of three boxes is the whole proof.
import '../dotenv.ts';

import { prismaQuery } from '../src/lib/prisma.ts';
import { createPlay, cashoutPlay } from '../src/services/plays.ts';
import { syncMarketsOnce } from '../src/workers/market-sync.ts';
import { explorerTxUrl } from '../src/lib/sui/client.ts';
import type { Play } from '../prisma/generated/client.js';

const USERNAME = process.argv[2] || 'devqa';
const STAKE = 1.5;
const OPEN_IDX = 1; // the WIDE rung, the opening a player would actually take
const TERMINAL = new Set(['won', 'lost', 'cashed_out', 'error']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const user = await prismaQuery.user.findFirst({ where: { username: USERNAME } });
if (!user) throw new Error(`no user ${USERNAME}`);
console.log(`user ${user.username} (${user.id})\n`);

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

const width = (p: Play) => (p.lower && p.upper ? parseFloat(p.upper) - parseFloat(p.lower) : NaN);

const report = (label: string, p: Play) => {
  const usd = (v: bigint | null) => (v == null ? 'n/a' : `$${(Number(v) / 1e6).toFixed(2)}`);
  console.log(`${label}`);
  console.log(`  play      ${p.id}`);
  console.log(`  status    ${p.status}   mult ${p.multiplier ?? 'n/a'}x   entry ${p.entrySpot}`);
  console.log(`  box       (${p.lower}, ${p.upper}]   width $${width(p).toFixed(2)}   expiry ${p.expiry}`);
  console.log(`  cost      ${usd(p.entryCost)}   payout ${usd(p.payout)}   pnl ${usd(p.pnl)}`);
  if (p.settlePrice) console.log(`  settled   ${p.settlePrice}`);
  if (p.txMint) console.log(`  txMint    ${p.txMint}  ${explorerTxUrl(p.txMint)}`);
  if (p.txRedeem) console.log(`  txRedeem  ${p.txRedeem}  ${explorerTxUrl(p.txRedeem)}`);
  console.log('');
};

/** The invariant the whole game rests on: every box strictly inside the one before it. */
function assertNested(outer: Play, innerBox: Play): void {
  const [ol, ou] = [parseFloat(outer.lower!), parseFloat(outer.upper!)];
  const [il, iu] = [parseFloat(innerBox.lower!), parseFloat(innerBox.upper!)];
  if (!(il >= ol && iu <= ou && iu - il < ou - ol)) {
    throw new Error(`press is NOT nested: (${il}, ${iu}] is not strictly inside (${ol}, ${ou}]`);
  }
  if (outer.expiry !== innerBox.expiry) throw new Error(`press landed on a different expiry: ${outer.expiry} vs ${innerBox.expiry}`);
  console.log(`  nested OK: (${il}, ${iu}] inside (${ol}, ${ou}], same expiry, $${(iu - il).toFixed(2)} vs $${(ou - ol).toFixed(2)} wide\n`);
}

await syncMarketsOnce();

// === 1. the opening box ===
console.log('--- box 1: open wide ---');
const a = await createPlay(user, { game: 'press', stake: STAKE, asset: 'BTC', open: OPEN_IDX });
const aOpen = await waitOpen(a.play.id);
report('opened', aOpen);
if (aOpen.status !== 'open') throw new Error(`box 1 did not open: ${aOpen.status}`);

// === 2. press: a tighter box nested inside it, same expiry ===
console.log('--- box 2: press, tighter, nested ---');
await sleep(6000); // clear the per-user play cooldown
const b = await createPlay(user, { game: 'press', stake: STAKE, asset: 'BTC', open: OPEN_IDX });
const bOpen = await waitOpen(b.play.id);
report('pressed', bOpen);
if (bOpen.status !== 'open') throw new Error(`box 2 did not open: ${bOpen.status}`);
assertNested(aOpen, bOpen);

// === 3. fold box 2 at the live bid, leave box 1 riding to the buzzer ===
console.log('--- fold box 2, hold box 1 through settlement ---');
await cashoutPlay(user, b.play.id);
report('folded', await prismaQuery.play.findUniqueOrThrow({ where: { id: b.play.id } }));
report('settled', await waitTerminal(a.play.id));

process.exit(0);
