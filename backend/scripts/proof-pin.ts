// PIN's real-play proof (04-GAMES-LAB.md §4): ONE mint at $1.50 that is cashed out, and ONE that rides the
// buzzer to a real settlement. Prints play ids and tx digests for the wave doc's proof table.
//
// Drives the real service path in-process (createPlay -> background mint -> cashoutPlay), so the strikes,
// admission and OrderMinted snap are the product's, not a copy. Settlement is left to the settle worker on
// the running backend, which is what settles a real player's round.
//
//   cd backend && bun scripts/proof-pin.ts [username]
//
// NEVER loop this (L-010). Testnet DUSDC is hand-funded and finite; two plays is the whole proof.
import '../dotenv.ts';

import { prismaQuery } from '../src/lib/prisma.ts';
import { createPlay, cashoutPlay } from '../src/services/plays.ts';
import { syncMarketsOnce } from '../src/workers/market-sync.ts';
import { quotePinModelReal } from '../src/services/games-real.ts';
import { explorerTxUrl } from '../src/lib/sui/client.ts';
import type { Play } from '../prisma/generated/client.js';

const USERNAME = process.argv[2] || 'devqa';
const STAKE = 1.5;
const WINDOW = 1; // the second rung, a real band rather than the widest
const TERMINAL = new Set(['won', 'lost', 'cashed_out', 'error']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const user = await prismaQuery.user.findFirst({ where: { username: USERNAME } });
if (!user) throw new Error(`no user ${USERNAME}`);
console.log(`user ${user.username} (${user.id})\n`);

await syncMarketsOnce();
const model = await quotePinModelReal();
if (!model) throw new Error('no PIN model: no live market');
const spot = parseFloat(model.entrySpot);
const win = model.windows[WINDOW];
// A pin planted just off spot, inside the window's solved travel, so it is a named price and not just "now".
const pin = Math.round(spot * (1 + 0.4 * win.travelSigma * model.annualVol * Math.sqrt(model.duration / (365.25 * 24 * 3600))));
console.log(`spot ${spot.toFixed(2)}  ·  ${model.duration}s round  ·  window w${WINDOW} (p=${win.prob}, +/-${win.halfPct.toFixed(4)}%)`);
console.log(`pin  ${pin}\n`);

/** Waits for the background mint to flip the row off 'pending'. */
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
  console.log(`  band      ${p.lower} .. ${p.upper}   pin ${p.strike}`);
  console.log(`  cost      ${usd(p.entryCost)}   payout ${usd(p.payout)}   pnl ${usd(p.pnl)}`);
  if (p.settlePrice) console.log(`  settled   ${p.settlePrice}`);
  if (p.txMint) console.log(`  txMint    ${p.txMint}  ${explorerTxUrl(p.txMint)}`);
  if (p.txRedeem) console.log(`  txRedeem  ${p.txRedeem}  ${explorerTxUrl(p.txRedeem)}`);
  console.log('');
};

// === 1. mint + cash out ===
console.log('--- play A: mint, then cash out on the live bid ---');
const a = await createPlay(user, { game: 'pin', stake: STAKE, asset: 'BTC', pin, window: WINDOW });
const aOpen = await waitOpen(a.play.id);
report('minted', aOpen);
if (aOpen.status !== 'open') throw new Error(`play A did not open: ${aOpen.status}`);
await cashoutPlay(user, a.play.id);
report('cashed out', await prismaQuery.play.findUniqueOrThrow({ where: { id: a.play.id } }));

// === 2. mint + ride to the buzzer ===
console.log('--- play B: mint, then hold through settlement ---');
await sleep(6000); // clear the per-user play cooldown
await syncMarketsOnce();
const b = await createPlay(user, { game: 'pin', stake: STAKE, asset: 'BTC', pin, window: WINDOW });
const bOpen = await waitOpen(b.play.id);
report('minted', bOpen);
if (bOpen.status !== 'open') throw new Error(`play B did not open: ${bOpen.status}`);
report('settled', await waitTerminal(b.play.id));

process.exit(0);
