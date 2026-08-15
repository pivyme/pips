// RUSH's real-play proof (04-GAMES-LAB.md §4): ONE dealt band TAKEN, ONE cash out, ONE take that rides the
// buzzer to a real settlement. Prints play ids and tx digests for the wave doc's proof table.
//
// It also proves the security seam, which is the point of this game: the take mints the OFFER's own ticks,
// an offer is single use, and an id nobody dealt is refused. Those three cost nothing and run first.
//
//   cd backend && bun scripts/proof-rush.ts [username]
//
// NEVER loop this (L-010). Two takes is the whole proof.
import '../dotenv.ts';

import { prismaQuery } from '../src/lib/prisma.ts';
import { createPlay, cashoutPlay } from '../src/services/plays.ts';
import { dealRushOffer } from '../src/services/games.ts';
import { putOffer, type RushOffer } from '../src/services/rush-offers.ts';
import { rakeOf } from '../src/lib/sui/house.ts';
import { toDusdcRaw } from '../src/lib/sui/config.ts';
import { syncMarketsOnce } from '../src/workers/market-sync.ts';
import { explorerTxUrl } from '../src/lib/sui/client.ts';
import type { Play } from '../prisma/generated/client.js';

const USERNAME = process.argv[2] || 'devqa';
const STAKE = 1.5;
const APPETITE = 1.5; // the lowest rung: the machine deals constantly, which is what a proof wants
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

const report = (label: string, p: Play) => {
  const usd = (v: bigint | null) => (v == null ? 'n/a' : `$${(Number(v) / 1e6).toFixed(2)}`);
  console.log(`${label}`);
  console.log(`  play      ${p.id}`);
  console.log(`  status    ${p.status}   mult ${p.multiplier ?? 'n/a'}x   entry ${p.entrySpot}`);
  console.log(`  band      (${p.lower}, ${p.upper}]   expiry ${p.expiry}`);
  console.log(`  cost      ${usd(p.entryCost)}   payout ${usd(p.payout)}   pnl ${usd(p.pnl)}`);
  if (p.settlePrice) console.log(`  settled   ${p.settlePrice}`);
  if (p.txMint) console.log(`  txMint    ${p.txMint}  ${explorerTxUrl(p.txMint)}`);
  if (p.txRedeem) console.log(`  txRedeem  ${p.txRedeem}  ${explorerTxUrl(p.txRedeem)}`);
  console.log('');
};

const stakeRaw = toDusdcRaw(STAKE);

async function deal(): Promise<RushOffer> {
  for (let i = 0; i < 6; i++) {
    const solved = await dealRushOffer(APPETITE, rakeOf(stakeRaw).net);
    if (solved) {
      const offer = putOffer({ ...solved, userId: user!.id, stakeRaw });
      console.log(`dealt ${offer.multiplier.toFixed(3)}x  (${offer.lower}, ${offer.upper}]  p=${(offer.entryProbability * 100).toFixed(1)}%  offer ${offer.id}`);
      return offer;
    }
    console.log('the machine passed, asking again');
    await sleep(1500);
  }
  throw new Error('the machine never dealt a band');
}

/** What was dealt is what mints: the bounds on the play row are the offer's own, to the cent. */
function assertMintedTheOffer(offer: RushOffer, p: Play): void {
  const near = (a: string, b: string) => Math.abs(parseFloat(a) - parseFloat(b)) < 0.01;
  if (!p.lower || !p.upper || !near(p.lower, offer.lower) || !near(p.upper, offer.upper)) {
    throw new Error(`take did not mint the dealt band: (${p.lower}, ${p.upper}] vs (${offer.lower}, ${offer.upper}]`);
  }
  if (Number(p.expiry) !== offer.expiryMs) throw new Error(`take landed on a different buzzer: ${p.expiry} vs ${offer.expiryMs}`);
  console.log(`  minted the dealt band: (${p.lower}, ${p.upper}], quoted ${offer.multiplier.toFixed(3)}x, minted ${p.multiplier}x\n`);
}

await syncMarketsOnce();

// === 0. the security seam, free of charge ===
console.log('--- a take can only ever mint what was dealt ---');
await createPlay(user, { game: 'rush', stake: STAKE, asset: 'BTC', offerId: 'not-an-offer' })
  .then(() => {
    throw new Error('an unknown offer id was ACCEPTED');
  })
  .catch((e: Error) => {
    if (e.message === 'an unknown offer id was ACCEPTED') throw e;
    console.log(`  unknown offer id rejected: ${e.message}`);
  });

// === 1. take a dealt band ===
console.log('\n--- take 1: cash out ---');
const offerA = await deal();
const a = await createPlay(user, { game: 'rush', stake: STAKE, asset: 'BTC', offerId: offerA.id });
const aOpen = await waitOpen(a.play.id);
report('taken', aOpen);
if (aOpen.status !== 'open') throw new Error(`take 1 did not open: ${aOpen.status}`);
assertMintedTheOffer(offerA, aOpen);

// The same offer, taken twice, is one premium buying two positions. It must die here.
await createPlay(user, { game: 'rush', stake: STAKE, asset: 'BTC', offerId: offerA.id })
  .then(() => {
    throw new Error('an offer was taken TWICE');
  })
  .catch((e: Error) => {
    if (e.message === 'an offer was taken TWICE') throw e;
    console.log(`  second take of the same offer rejected: ${e.message}\n`);
  });

await cashoutPlay(user, a.play.id);
report('cashed out', await prismaQuery.play.findUniqueOrThrow({ where: { id: a.play.id } }));

// === 2. take a band and ride it to the buzzer ===
console.log('--- take 2: ride it out ---');
await sleep(6000); // clear the per-user play cooldown
const offerB = await deal();
const b = await createPlay(user, { game: 'rush', stake: STAKE, asset: 'BTC', offerId: offerB.id });
const bOpen = await waitOpen(b.play.id);
report('taken', bOpen);
if (bOpen.status !== 'open') throw new Error(`take 2 did not open: ${bOpen.status}`);
assertMintedTheOffer(offerB, bOpen);
report('settled', await waitTerminal(b.play.id));

process.exit(0);
