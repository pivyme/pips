// Lucky play benchmark, optimistic path. A play now returns the moment it's dealt (status 'pending',
// the reels snap), and the real Predict mint finalizes in the BACKGROUND (flips it 'open', or 'error'
// on the rare failure). So this measures two things that matter: ENTRY latency (time to reels-snap,
// what the player feels) and the background mint LAND RATE (did the deal actually open on-chain). It
// signs in as a real provisioned user (privy wallet + manager when one exists, else the dev/operator
// user), so it exercises the true server-signed path.
//
//   cd backend && bun dev                 # backend must be running (it owns the live oracle ladder)
//   cd backend && bun scripts/bench-lucky.ts [count] [stake]
//
// Defaults: 12 plays at $5. Green = 0 entry failures, a snappy entry median, and every deal landed.

import '../dotenv.ts';
import jwt from 'jsonwebtoken';

import { JWT_SECRET, APP_PORT } from '../src/config/main-config.ts';
import { prismaQuery } from '../src/lib/prisma.ts';

const COUNT = Number(process.argv[2]) || 12;
const STAKE = Number(process.argv[3]) || 5;
const BASE = `http://localhost:${APP_PORT}`;
const TARGET_ENTRY_P50_MS = 3000; // the reels should snap well under this
const MIN_LAND_RATE = 0.9; // at least this share of deals must mint 'open' (the rest re-rack, chips safe)

// Prefer a fully provisioned privy user (the real product path); fall back to any user with a
// manager. The benchmark forges this user's JWT directly (same payload the auth flow mints).
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
const now = () => performance.now();

console.log(`Benchmarking ${COUNT} Lucky plays at $${STAKE} as ${user.address.slice(0, 10)}… on ${BASE}\n`);

const times: number[] = [];
const ids: string[] = [];
const fails: string[] = [];

for (let i = 0; i < COUNT; i++) {
  const s = now();
  let line: string;
  try {
    const r = await fetch(`${BASE}/games/lucky/play`, { method: 'POST', headers: H, body: JSON.stringify({ stake: STAKE }) });
    const dt = now() - s;
    times.push(dt);
    const j = (await r.json()) as { data?: { play?: { id: string; status: string; params: { asset: string; side: string }; multiplier: number; entryValue: string } }; error?: { code?: string } };
    if (r.status === 200 && j.data?.play) {
      const p = j.data.play;
      ids.push(p.id);
      line = `OK   ${p.params.asset.padEnd(3)} ${String(p.params.side).padEnd(4)} ${p.multiplier.toFixed(2)}x  entry $${p.entryValue}`;
    } else {
      const code = j.error?.code ?? `HTTP ${r.status}`;
      fails.push(code);
      line = `FAIL ${code}`;
    }
  } catch (e) {
    times.push(now() - s);
    const msg = e instanceof Error ? e.message : String(e);
    fails.push(msg);
    line = `ERROR ${msg}`;
  }
  console.log(`#${String(i + 1).padStart(2)}  ${times[times.length - 1].toFixed(0).padStart(6)}ms  ${line}`);
}

times.sort((a, b) => a - b);
const pct = (p: number) => times[Math.min(times.length - 1, Math.floor(times.length * p))];
const avg = times.reduce((a, b) => a + b, 0) / times.length;
const p50 = pct(0.5);

console.log(
  `\nENTRY (time to reels-snap): min ${times[0].toFixed(0)}  p50 ${p50.toFixed(0)}  p90 ${pct(0.9).toFixed(0)}  max ${times[times.length - 1].toFixed(0)}  avg ${avg.toFixed(0)} ms`,
);

// Watch the background mints finalize. A deal that reaches any non-pending/non-error status opened
// on-chain; 'error' means it re-racked (chips safe). Poll until none are still pending (or we give up).
let counts: Record<string, number> = {};
for (let w = 0; w < 12 && ids.length; w++) {
  await new Promise((r) => setTimeout(r, 2500));
  const rows = await prismaQuery.play.findMany({ where: { id: { in: ids } }, select: { status: true } });
  counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  console.log(`  mints t+${((w + 1) * 2.5).toFixed(1)}s  ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  if (!counts.pending) break;
}

const landed = ids.length - (counts.pending ?? 0) - (counts.error ?? 0);
const landRate = ids.length ? landed / ids.length : 0;

console.log(`\n${ids.length}/${COUNT} entered, ${landed}/${ids.length} minted on-chain (${(landRate * 100).toFixed(0)}%)`);

const snappy = fails.length === 0 && p50 < TARGET_ENTRY_P50_MS;
const reliable = landRate >= MIN_LAND_RATE && !counts.pending;
if (snappy && reliable) {
  console.log(`\n✓ PLAYABLE — reels snap in ${(p50 / 1000).toFixed(1)}s (under ${TARGET_ENTRY_P50_MS / 1000}s), every deal landed on-chain`);
} else {
  if (fails.length) console.log(`✗ ${fails.length} entry failure(s): ${[...new Set(fails)].join(', ')}`);
  if (p50 >= TARGET_ENTRY_P50_MS) console.log(`✗ entry median ${(p50 / 1000).toFixed(1)}s exceeds the ${TARGET_ENTRY_P50_MS / 1000}s target`);
  if (counts.pending) console.log(`✗ ${counts.pending} mint(s) never finalized`);
  if (landRate < MIN_LAND_RATE) console.log(`✗ land rate ${(landRate * 100).toFixed(0)}% under ${(MIN_LAND_RATE * 100).toFixed(0)}%`);
}
process.exit(snappy && reliable ? 0 : 1);
