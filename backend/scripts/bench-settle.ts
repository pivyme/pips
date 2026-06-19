// Full-lifecycle Lucky benchmark. Where bench-lucky.ts stops at reels-snap + mint-land, this one
// times the WHOLE round the player actually sits through: spin -> mint lands (open) -> buzzer
// (on-chain expiry) -> settled (won/lost). The metric that matters for the "stuck on SETTLING"
// complaint is SETTLE LAG = settledAt - expiry: how long after the buzzer the result takes to land.
// Everything is read from the DB's authoritative server timestamps, so there is no polling jitter in
// the numbers (only in when we notice completion).
//
//   cd backend && bun dev                       # backend must be running (owns the oracle ladder)
//   cd backend && bun scripts/bench-settle.ts [count] [stake] [staggerMs]
//
// Defaults: 6 plays at $5, 1s apart (a realistic burst that also stresses the per-tick redeem cap).

import '../dotenv.ts';
import jwt from 'jsonwebtoken';

import { JWT_SECRET, APP_PORT, LUCKY_ROUND_MS } from '../src/config/main-config.ts';
import { prismaQuery } from '../src/lib/prisma.ts';

const COUNT = Number(process.argv[2]) || 6;
const STAKE = Number(process.argv[3]) || 5;
const STAGGER_MS = process.argv[4] != null ? Number(process.argv[4]) : 1000;
const BASE = `http://localhost:${APP_PORT}`;
const POLL_MS = 1000;
const MAX_WAIT_MS = LUCKY_ROUND_MS + 90_000; // round + a generous settle budget before we give up

const user =
  (await prismaQuery.user.findFirst({
    where: { privyWalletId: { not: null }, suiPublicKey: { not: null }, predictManagerId: { not: null } },
    orderBy: { createdAt: 'desc' },
  })) ?? (await prismaQuery.user.findFirst({ where: { predictManagerId: { not: null } }, orderBy: { createdAt: 'asc' } }));

if (!user) {
  console.error('No user with a Predict manager found. Sign in once (or seed the dev user) first.');
  process.exit(1);
}

const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '1h' });
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ms = (n: number) => `${(n / 1000).toFixed(1)}s`;

console.log(`Settle bench: ${COUNT} Lucky plays @ $${STAKE}, ${STAGGER_MS}ms apart, on ${BASE}`);
console.log(`Round target ${ms(LUCKY_ROUND_MS)}. Watching each spin -> open -> buzzer -> settled.\n`);

// Place the plays (the entry call returns the moment the deal is priced, status 'pending').
const ids: string[] = [];
const entryMs: number[] = [];
for (let i = 0; i < COUNT; i++) {
  const s = performance.now();
  try {
    const r = await fetch(`${BASE}/games/lucky/play`, { method: 'POST', headers: H, body: JSON.stringify({ stake: STAKE }) });
    const dt = performance.now() - s;
    const j = (await r.json()) as { data?: { play?: { id: string; status: string } }; error?: { code?: string } };
    if (r.status === 200 && j.data?.play) {
      ids.push(j.data.play.id);
      entryMs.push(dt);
      console.log(`  placed #${i + 1} ${j.data.play.id.slice(-6)} entry ${dt.toFixed(0)}ms`);
    } else {
      console.log(`  FAIL #${i + 1} ${j.error?.code ?? r.status}`);
    }
  } catch (e) {
    console.log(`  ERROR #${i + 1} ${e instanceof Error ? e.message : e}`);
  }
  if (i < COUNT - 1 && STAGGER_MS > 0) await sleep(STAGGER_MS);
}

if (ids.length === 0) {
  console.error('\nNo plays entered; aborting.');
  process.exit(1);
}

// Poll the DB until every play is terminal (or we hit the wait ceiling). The DB timestamps
// (createdAt/openedAt/settledAt) are authoritative; we only poll to know when to stop.
const TERMINAL = new Set(['won', 'lost', 'cashed_out', 'error']);
const startedPoll = Date.now();
type Row = { id: string; status: string; expiry: bigint; createdAt: Date; openedAt: Date | null; settledAt: Date | null };
let rows: Row[] = [];
while (Date.now() - startedPoll < MAX_WAIT_MS) {
  await sleep(POLL_MS);
  rows = (await prismaQuery.play.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true, expiry: true, createdAt: true, openedAt: true, settledAt: true },
  })) as Row[];
  const open = rows.filter((r) => !TERMINAL.has(r.status)).length;
  const elapsed = (Date.now() - startedPoll) / 1000;
  process.stdout.write(`\r  t+${elapsed.toFixed(0).padStart(3)}s  ${rows.filter((r) => TERMINAL.has(r.status)).length}/${ids.length} settled, ${open} still running   `);
  if (open === 0) break;
}
console.log('\n');

// Per-play lifecycle. All deltas in ms off the authoritative server timestamps.
const settleLags: number[] = [];
const totals: number[] = [];
const mintLands: number[] = [];
console.log('play     status   mint-land   round-len   SETTLE-LAG   total');
for (const r of rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
  const created = r.createdAt.getTime();
  const expiry = Number(r.expiry);
  const opened = r.openedAt?.getTime();
  const settled = r.settledAt?.getTime();
  const mintLand = opened != null ? opened - created : null;
  const roundLen = expiry - created;
  const settleLag = settled != null ? settled - expiry : null;
  const total = settled != null ? settled - created : null;
  if (mintLand != null) mintLands.push(mintLand);
  if (settleLag != null) settleLags.push(settleLag);
  if (total != null) totals.push(total);
  const cell = (v: number | null) => (v == null ? '    —    ' : ms(v).padStart(9));
  console.log(
    `${r.id.slice(-6)}   ${r.status.padEnd(7)} ${cell(mintLand)}   ${cell(roundLen)}   ${cell(settleLag)}   ${cell(total)}`,
  );
}

const stat = (xs: number[]) => {
  if (xs.length === 0) return 'n/a';
  const s = [...xs].sort((a, b) => a - b);
  const p = (q: number) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  return `min ${ms(s[0])}  p50 ${ms(p(0.5))}  p90 ${ms(p(0.9))}  max ${ms(s[s.length - 1])}`;
};

const eSorted = [...entryMs].sort((a, b) => a - b);
console.log(`\nENTRY  (reels-snap)        ${eSorted.length ? stat(entryMs) : 'n/a'}`);
console.log(`MINT-LAND (pending->open)  ${stat(mintLands)}`);
console.log(`SETTLE-LAG (buzzer->result) ${stat(settleLags)}    <-- the "stuck on SETTLING" window`);
console.log(`TOTAL  (spin->result)      ${stat(totals)}`);

const settledCount = rows.filter((r) => TERMINAL.has(r.status)).length;
console.log(`\n${settledCount}/${ids.length} resolved. Stuck (still open past the ceiling): ${ids.length - settledCount}.`);
process.exit(0);
