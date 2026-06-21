// PnL audit. Compares the denormalized UserStats counters against the Play ledger recomputed by the
// shipped computeLedgerStats (the source of truth the card/leaderboard now read), and reports the
// cash-out exit-price gap. Read-only by default; `heal` converges the cached rows via recordSettlement.
//   bun scripts/diag-pnl.ts        audit only (no writes)
//   bun scripts/diag-pnl.ts heal   audit, then recompute-and-set every drifted UserStats row
import '../dotenv.ts';
import { prismaQuery } from '../src/lib/prisma.ts';
import { computeLedgerStats, recordSettlement } from '../src/services/stats.ts';

const usd = (raw: bigint): string => (Number(raw) / 1e6).toFixed(2);
const padL = (s: string, n: number): string => s.padStart(n);

async function main() {
  const heal = process.argv[2] === 'heal';
  const stats = await prismaQuery.userStats.findMany();
  const userIds = new Set<string>(stats.map((s) => s.userId));
  for (const g of await prismaQuery.play.groupBy({ by: ['userId'] })) userIds.add(g.userId);

  const drifted: string[] = [];
  console.log('\n========== PnL AUDIT: stored UserStats vs Play ledger (computeLedgerStats) ==========\n');
  console.log('userId'.padEnd(11), padL('stored$', 12), padL('ledger$', 12), padL('Δ$', 11), padL('games s/l', 12), padL('W s/l', 10));
  console.log('-'.repeat(74));
  let sumStored = 0n;
  let sumLedger = 0n;
  for (const uid of userIds) {
    const s = stats.find((x) => x.userId === uid);
    const l = await computeLedgerStats(uid);
    sumStored += s?.netPnl ?? 0n;
    sumLedger += l.netPnl;
    const d = (s?.netPnl ?? 0n) - l.netPnl;
    const drift = d !== 0n || (s?.gamesPlayed ?? 0) !== l.gamesPlayed || (s?.wins ?? 0) !== l.wins;
    if (drift) {
      drifted.push(uid);
      console.log(
        uid.slice(0, 10).padEnd(11),
        padL(usd(s?.netPnl ?? 0n), 12),
        padL(usd(l.netPnl), 12),
        padL((d >= 0n ? '+' : '') + usd(d), 11),
        padL(`${s?.gamesPlayed ?? 0}/${l.gamesPlayed}`, 12),
        padL(`${s?.wins ?? 0}/${l.wins}`, 10),
      );
    }
  }
  console.log('-'.repeat(74));
  console.log(`users=${userIds.size}  drifted=${drifted.length}   Σ netPnl stored=$${usd(sumStored)} ledger=$${usd(sumLedger)} drift=$${usd(sumStored - sumLedger)}`);

  const cashed = await prismaQuery.play.count({ where: { status: 'cashed_out' } });
  const cashedNoExit = await prismaQuery.play.count({ where: { status: 'cashed_out', settlePrice: null } });
  console.log(`\nEXIT PRICE: cashed_out=${cashed}  missing settlePrice=${cashedNoExit} (${cashed ? Math.round((100 * cashedNoExit) / cashed) : 0}%) -- new cash-outs record it going forward`);

  if (heal) {
    for (const uid of drifted) await recordSettlement(uid);
    console.log(`\nHEALED ${drifted.length} UserStats row(s) to match the ledger.`);
  } else if (drifted.length) {
    console.log('\nThe card/leaderboard already read the ledger, so the UI is correct now. Run with `heal` to also fix the cached rows.');
  }

  await prismaQuery.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
