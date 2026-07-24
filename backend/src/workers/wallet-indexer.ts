// The wallet activity indexer: scans users' Sui addresses and records incoming/outgoing transfers to the
// WalletTx ledger the feed reads from. Presence-gated (§12c): the main tick scans ONLY currently-online users,
// so an idle app costs ~0 external calls. A separate low-cadence reconcile pass re-verifies recently-active
// users to self-heal any GraphQL-dropped row (idempotent, so over-scanning is always safe).
//
// Real networks only (testnet/mainnet), where the public Mysten GraphQL schema serves tx-history; localnet/
// devnet have no compatible endpoint and skip.

import cron from 'node-cron';

import {
  WALLET_INDEX_CRON,
  WALLET_INDEX_BATCH,
  WALLET_RECONCILE_CRON,
  WALLET_RECONCILE_BATCH,
  WALLET_RECONCILE_ACTIVE_HOURS,
  WALLET_RECONCILE_LOOKBACK_CP,
} from '../config/main-config.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { onlineUserIds } from '../routes/streamRoutes.ts';
import { syncUserWallet, WALLET_REAL_NETWORK, type SyncUser } from '../lib/sui/wallet-ledger.ts';
import { cronIntervalMs, recordRun, registerWorker } from '../lib/worker-registry.ts';

const USER_SELECT = { id: true, address: true, walletSyncCheckpoint: true } as const;

let indexRunning = false;

// Batch = currently-online users, oldest-synced first, capped at BATCH. Nobody online -> a no-op tick.
async function selectOnlineBatch(): Promise<SyncUser[]> {
  const online = onlineUserIds();
  if (online.length === 0) return [];
  return prismaQuery.user.findMany({
    where: { id: { in: online } },
    select: USER_SELECT,
    orderBy: [{ walletSyncedAt: { sort: 'asc', nulls: 'first' } }],
    take: WALLET_INDEX_BATCH,
  });
}

const indexTick = async (): Promise<void> => {
  if (indexRunning) return;
  indexRunning = true;
  const startedAt = Date.now();
  let runErr: unknown = null;
  try {
    const batch = await selectOnlineBatch();
    for (const u of batch) {
      // Per-user try/catch so one bad address never sinks the tick; syncUserWallet advances nothing on failure.
      try {
        await syncUserWallet(u);
      } catch (e) {
        console.warn(`[WalletIndexer] user ${u.id} scan failed:`, e instanceof Error ? e.message : e);
      }
    }
  } catch (error) {
    runErr = error;
    console.error('[WalletIndexer] tick error:', error instanceof Error ? error.message : error);
  } finally {
    indexRunning = false;
    recordRun('wallet-indexer', !runErr, Date.now() - startedAt, runErr);
  }
};

let reconcileRunning = false;

// Reconcile: re-scan recently-active users from a rewound checkpoint (ignoring their high-water mark) to
// backfill anything a GraphQL hiccup dropped. Idempotent, so it only re-confirms existing rows (§12b).
const reconcileTick = async (): Promise<void> => {
  if (reconcileRunning) return;
  reconcileRunning = true;
  const startedAt = Date.now();
  let runErr: unknown = null;
  try {
    const since = new Date(Date.now() - WALLET_RECONCILE_ACTIVE_HOURS * 3_600_000);
    const users = await prismaQuery.user.findMany({
      where: { walletSyncedAt: { gte: since } },
      select: USER_SELECT,
      orderBy: [{ walletSyncedAt: 'asc' }],
      take: WALLET_RECONCILE_BATCH,
    });
    const lookback = BigInt(WALLET_RECONCILE_LOOKBACK_CP);
    for (const u of users) {
      const from = u.walletSyncCheckpoint != null && u.walletSyncCheckpoint > lookback ? u.walletSyncCheckpoint - lookback : 0n;
      try {
        await syncUserWallet(u, { fromCheckpoint: from });
      } catch (e) {
        console.warn(`[WalletIndexer] reconcile ${u.id} failed:`, e instanceof Error ? e.message : e);
      }
    }
  } catch (error) {
    runErr = error;
    console.error('[WalletIndexer] reconcile tick error:', error instanceof Error ? error.message : error);
  } finally {
    reconcileRunning = false;
    recordRun('wallet-reconcile', !runErr, Date.now() - startedAt, runErr);
  }
};

export const startWalletIndexer = (): void => {
  if (!WALLET_REAL_NETWORK) {
    console.log('[WalletIndexer] skipped (non-real network: no compatible GraphQL tx-history)');
    return;
  }
  console.log(`[WalletIndexer] scheduled ${WALLET_INDEX_CRON} (presence-gated), reconcile ${WALLET_RECONCILE_CRON}`);
  const indexTask = cron.schedule(WALLET_INDEX_CRON, indexTick);
  registerWorker('wallet-indexer', indexTask, cronIntervalMs(WALLET_INDEX_CRON));
  const reconcileTask = cron.schedule(WALLET_RECONCILE_CRON, reconcileTick);
  registerWorker('wallet-reconcile', reconcileTask, cronIntervalMs(WALLET_RECONCILE_CRON));
};
