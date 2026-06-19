// Lucky play benchmark. Fires N real /games/lucky/play calls at the running backend and reports
// the latency distribution + success rate, so we can tell at a glance whether a play feels snappy
// and actually lands every time. It signs in as a real provisioned user (privy wallet + manager
// when one exists, else the dev/operator user), so it exercises the true server-signed mint path.
//
//   cd backend && bun dev                 # backend must be running (it owns the live oracle ladder)
//   cd backend && bun scripts/bench-lucky.ts [count] [stake]
//
// Defaults: 12 plays at $5. A green verdict = 0 failures and a median under the target.

import '../dotenv.ts';
import jwt from 'jsonwebtoken';

import { JWT_SECRET, APP_PORT } from '../src/config/main-config.ts';
import { prismaQuery } from '../src/lib/prisma.ts';

const COUNT = Number(process.argv[2]) || 12;
const STAKE = Number(process.argv[3]) || 5;
const BASE = `http://localhost:${APP_PORT}`;
const TARGET_P50_MS = 8000; // a play should typically land in under this

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
let ok = 0;
const fails: string[] = [];

for (let i = 0; i < COUNT; i++) {
  const s = now();
  let line: string;
  try {
    const r = await fetch(`${BASE}/games/lucky/play`, { method: 'POST', headers: H, body: JSON.stringify({ stake: STAKE }) });
    const dt = now() - s;
    times.push(dt);
    const j = (await r.json()) as { data?: { play?: { params: { asset: string; side: string }; multiplier: number; entryValue: string } }; error?: { code?: string } };
    if (r.status === 200 && j.data?.play) {
      ok++;
      const p = j.data.play;
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
  `\n${ok}/${COUNT} ok` +
    `\nmin ${times[0].toFixed(0)}  p50 ${p50.toFixed(0)}  p90 ${pct(0.9).toFixed(0)}  max ${times[times.length - 1].toFixed(0)}  avg ${avg.toFixed(0)} ms`,
);

const playable = fails.length === 0 && p50 < TARGET_P50_MS;
if (playable) {
  console.log(`\n✓ PLAYABLE — every play landed, median ${(p50 / 1000).toFixed(1)}s (under ${TARGET_P50_MS / 1000}s target)`);
} else {
  if (fails.length) console.log(`\n✗ ${fails.length} failure(s): ${[...new Set(fails)].join(', ')}`);
  if (p50 >= TARGET_P50_MS) console.log(`✗ median ${(p50 / 1000).toFixed(1)}s exceeds the ${TARGET_P50_MS / 1000}s target`);
}
process.exit(playable ? 0 : 1);
