// Full accounting audit against Sui transaction receipts.
//
// Read-only by default:
//   bun scripts/audit-accounting.ts
//
// Rebuild persisted entry cost, payout, PnL, multiplier, mark value, and UserStats from the exact
// PositionMinted/RangeMinted and PositionRedeemed/RangeRedeemed events:
//   bun scripts/audit-accounting.ts heal

import '../dotenv.ts';

import { prismaQuery } from '../src/lib/prisma.ts';
import { suiClient } from '../src/lib/sui/client.ts';
import { getDusdcBalanceRaw } from '../src/lib/sui/dusdc.ts';
import { formatDusdcRaw, multiplier } from '../src/lib/sui/math.ts';
import {
  getManagerBalanceRaw,
  mintEventAmounts,
  redeemEventAmounts,
  type TradeEvent,
} from '../src/lib/sui/predict.ts';
import { computeLedgerStats, recordSettlement } from '../src/services/stats.ts';

const TERMINAL = new Set(['won', 'lost', 'cashed_out']);
const heal = process.argv[2] === 'heal';

// Normalized receipt: gRPC has no multiGet, so we read each digest via getTransaction and reduce it
// to the success flag + the event view the audit needs. A missing/failed digest becomes {success:false}.
type Tx = { success: boolean; events: TradeEvent[] };

const eventView = (tx: Tx): TradeEvent[] => tx.events;

async function transactions(digests: string[]): Promise<Map<string, Tx>> {
  const out = new Map<string, Tx>();
  for (const digest of digests) {
    try {
      const res = await suiClient.getTransaction({ digest, include: { effects: true, events: true } });
      const t = res.$kind === 'Transaction' ? res.Transaction : null;
      out.set(digest, {
        success: t?.effects?.status?.success === true,
        events: (t?.events ?? []).map((e) => ({ type: e.eventType, parsedJson: e.json ?? null })),
      });
    } catch {
      out.set(digest, { success: false, events: [] });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const plays = await prismaQuery.play.findMany({
    where: { txMint: { not: null } },
    orderBy: { createdAt: 'asc' },
    include: {
      user: {
        select: {
          address: true,
          displayName: true,
          predictManagerId: true,
        },
      },
    },
  });
  const digests = [
    ...new Set(
      plays.flatMap((play) => [play.txMint, play.txRedeem, play.txSettle].filter((v): v is string => Boolean(v))),
    ),
  ];
  const byDigest = await transactions(digests);

  let badTransactions = 0;
  let missingReceipts = 0;
  let identityMismatches = 0;
  let drifted = 0;
  let entryCostDrift = 0n;
  let payoutDrift = 0n;
  let pnlDrift = 0n;
  const touchedUsers = new Set<string>();
  // On-chain truth accumulated per user for the balance reconciliation below: realized PnL summed from
  // settled plays, and entry cost still locked in open (paid, not yet redeemed) positions. Built from
  // the events, not the DB rows, so the reconciliation is chain-exact even before any heal.
  const chainPnlByUser = new Map<string, bigint>();
  const openLockedByUser = new Map<string, bigint>();

  for (const play of plays) {
    const mintTx = byDigest.get(play.txMint!);
    if (!mintTx || !mintTx.success) {
      badTransactions += 1;
      continue;
    }

    const kind = play.game === 'range' || play.game === 'tap' ? 'range' : 'binary';
    let mint;
    try {
      mint = mintEventAmounts(eventView(mintTx), kind);
    } catch {
      missingReceipts += 1;
      continue;
    }

    if (
      mint.oracleId !== play.oracleId ||
      mint.managerId !== play.user.predictManagerId
    ) {
      identityMismatches += 1;
      continue;
    }

    const exactCost = mint.cost;
    const exactMultiplier = multiplier(exactCost, mint.quantity);
    let exactPayout = play.payout;
    let exactPnl = play.pnl;

    if (TERMINAL.has(play.status)) {
      if (play.status === 'lost') {
        exactPayout = 0n;
      } else if (play.txRedeem) {
        const redeemTx = byDigest.get(play.txRedeem);
        if (!redeemTx || !redeemTx.success) {
          badTransactions += 1;
          continue;
        }
        try {
          const redeem = redeemEventAmounts(eventView(redeemTx), kind);
          if (
            redeem.oracleId !== play.oracleId ||
            redeem.managerId !== play.user.predictManagerId ||
            redeem.quantity !== mint.quantity
          ) {
            identityMismatches += 1;
            continue;
          }
          exactPayout = redeem.payout;
        } catch {
          missingReceipts += 1;
          continue;
        }
      } else {
        missingReceipts += 1;
        continue;
      }
      exactPnl = (exactPayout ?? 0n) - exactCost;
    }

    if (TERMINAL.has(play.status)) {
      chainPnlByUser.set(play.userId, (chainPnlByUser.get(play.userId) ?? 0n) + (exactPnl ?? 0n));
    } else if (play.status === 'open') {
      openLockedByUser.set(play.userId, (openLockedByUser.get(play.userId) ?? 0n) + exactCost);
    }

    const changed =
      play.entryCost !== exactCost ||
      play.multiplier !== exactMultiplier ||
      (TERMINAL.has(play.status) &&
        (play.payout !== exactPayout ||
          play.pnl !== exactPnl ||
          play.markValue !== exactPayout));
    if (!changed) continue;

    drifted += 1;
    entryCostDrift += play.entryCost - exactCost;
    if (TERMINAL.has(play.status)) {
      payoutDrift += (play.payout ?? 0n) - (exactPayout ?? 0n);
      pnlDrift += (play.pnl ?? 0n) - (exactPnl ?? 0n);
    }

    if (heal) {
      await prismaQuery.play.update({
        where: { id: play.id },
        data: {
          entryCost: exactCost,
          multiplier: exactMultiplier,
          ...(TERMINAL.has(play.status)
            ? {
                payout: exactPayout ?? 0n,
                pnl: exactPnl ?? -exactCost,
                markValue: exactPayout ?? 0n,
                ...(play.status === 'cashed_out' ? { settlePrice: null } : {}),
              }
            : {}),
        },
      });
      touchedUsers.add(play.userId);
    }
  }

  if (heal) {
    for (const userId of touchedUsers) await recordSettlement(userId);
  }

  console.log(`Accounting mode: ${heal ? 'HEAL' : 'AUDIT ONLY'}`);
  console.log(`Plays with mint tx: ${plays.length}`);
  console.log(`Transactions checked: ${digests.length}`);
  console.log(`Failed/missing transactions: ${badTransactions}`);
  console.log(`Missing Predict receipts: ${missingReceipts}`);
  console.log(`Receipt identity mismatches: ${identityMismatches}`);
  console.log(`Drifted play rows: ${drifted}${heal ? `, healed: ${drifted}` : ''}`);
  console.log(`Stored minus chain entry cost: ${formatDusdcRaw(entryCostDrift)}`);
  console.log(`Stored minus chain payout: ${formatDusdcRaw(payoutDrift)}`);
  console.log(`Stored minus chain PnL: ${formatDusdcRaw(pnlDrift)}`);

  const users = await prismaQuery.user.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, displayName: true, address: true, predictManagerId: true },
  });
  // Per-user reconciliation. The conservation law for a user's chips is:
  //   available (wallet + manager) = funded - withdrawn + realizedPnL - openLocked
  // entry cost + payout are sourced from the chain above, so `realizedPnL` and `openLocked` are the
  // on-chain truth. We can't independently see funded/withdrawn (no deposit/withdrawal ledger on chain
  // we read here), so we surface the implied net funding (= available - realizedPnL + openLocked); it
  // should land on a sane non-negative figure near STARTING_BALANCE + k*FAUCET minus any withdrawals
  // (it can legitimately go negative only when a user withdrew more than they were ever granted, i.e.
  // cashed winnings out). The hard check is `ledger vs chain`: the DB ledger PnL must equal the
  // event-sourced PnL; any nonzero gap is a row that still needs healing.
  console.log('\nPer-user reconciliation (live on-chain balance vs the event-sourced ledger):');
  let ledgerGaps = 0;
  for (const user of users) {
    try {
      const [wallet, manager] = await Promise.all([
        getDusdcBalanceRaw(user.address),
        user.predictManagerId ? getManagerBalanceRaw(user.predictManagerId) : Promise.resolve(0n),
      ]);
      const available = wallet + manager;
      const chainPnl = chainPnlByUser.get(user.id) ?? 0n;
      const openLocked = openLockedByUser.get(user.id) ?? 0n;
      const ledger = await computeLedgerStats(user.id);
      const dbGap = ledger.netPnl - chainPnl; // DB-recorded PnL minus on-chain truth
      const impliedFunding = available - chainPnl + openLocked; // = funded - withdrawn
      if (dbGap !== 0n) ledgerGaps += 1;
      console.log(
        `${user.displayName}: available=${formatDusdcRaw(available)} ` +
          `(wallet=${formatDusdcRaw(wallet)}, manager=${formatDusdcRaw(manager)})  ` +
          `chainPnL=${formatDusdcRaw(chainPnl)}  openLocked=${formatDusdcRaw(openLocked)}  ` +
          `netFunded=${formatDusdcRaw(impliedFunding)}` +
          (dbGap !== 0n ? `  <-- DB ledger off chain by ${formatDusdcRaw(dbGap)} (needs heal)` : ''),
      );
    } catch (error) {
      console.log(`${user.displayName}: BALANCE READ FAILED, ${error instanceof Error ? error.message : error}`);
    }
  }
  console.log(`\nUsers whose DB ledger PnL still differs from chain: ${ledgerGaps}`);

  await prismaQuery.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prismaQuery.$disconnect();
  process.exit(1);
});
