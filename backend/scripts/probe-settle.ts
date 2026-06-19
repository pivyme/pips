// Why are open plays stuck past expiry? For every still-open play, read its oracle on-chain and
// show whether the chain has settled it. Tells us if the bug is "oracle never settled" (the settle
// worker's nudge isn't landing / the oracle left the cache before being nudged) vs "oracle settled
// but the play wasn't redeemed". A fresh process can't see the server's in-memory markets cache, so
// this reads the chain directly, which is the source of truth for settlement.

import '../dotenv.ts';
import { prismaQuery } from '../src/lib/prisma.ts';
import { readOracle } from '../src/lib/sui/predict.ts';

const now = Date.now();
const open = await prismaQuery.play.findMany({
  where: { status: 'open' },
  orderBy: { createdAt: 'desc' },
  take: 20,
  select: { id: true, oracleId: true, expiry: true, side: true, strike: true, asset: true, createdAt: true },
});

console.log(`${open.length} open play(s). now=${new Date(now).toISOString()}\n`);

const seen = new Map<string, Awaited<ReturnType<typeof readOracle>>>();
for (const p of open) {
  const expiry = Number(p.expiry);
  const pastExpiry = now - expiry;
  let st = seen.get(p.oracleId);
  if (!seen.has(p.oracleId)) {
    try {
      st = await readOracle(p.oracleId);
    } catch (e) {
      st = null;
      console.log(`  readOracle(${p.oracleId.slice(-6)}) threw: ${e instanceof Error ? e.message : e}`);
    }
    seen.set(p.oracleId, st ?? null);
  }
  const oracle = st
    ? `oracle expiry=${new Date(st.expiryMs).toISOString().slice(11, 19)} active=${st.active} settled=${st.settled} settlePx=${st.settlementPrice1e9 ?? '—'} spotAge=${((now - st.timestampMs) / 1000).toFixed(0)}s`
    : 'ORACLE OBJECT GONE (null)';
  console.log(
    `${p.id.slice(-6)} ${p.asset} ${p.side ?? ''} expired ${(pastExpiry / 1000).toFixed(0)}s ago  | ${oracle}`,
  );
}

// Summary: of the oracles backing stuck plays, how many are settled on-chain?
const oracles = [...seen.entries()];
const settled = oracles.filter(([, s]) => s?.settled).length;
const gone = oracles.filter(([, s]) => s == null).length;
const unsettled = oracles.filter(([, s]) => s && !s.settled).length;
console.log(`\n${oracles.length} distinct oracle(s) behind open plays: ${settled} settled on-chain, ${unsettled} unsettled, ${gone} gone.`);
if (unsettled > 0) console.log('=> bug is UPSTREAM: oracles are not being driven to settlement (nudge not landing / left cache).');
if (settled > 0) console.log('=> some oracles ARE settled but plays still open => redeem/settleDuePlays not finishing them.');
process.exit(0);
