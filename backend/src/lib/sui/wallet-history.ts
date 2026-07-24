// The wallet-tx GraphQL scan. Fullnode gRPC v2 can't serve tx-history (L-002), so incoming/outgoing transfers
// at an address come from the public Mysten GraphQL schema. Ascending-incremental via afterCheckpoint (L-004),
// so a quiet address costs one cheap query. Pure of DB writes: it just reads chain effects and emits raw rows;
// the indexer / on-demand sync owns the Play-digest skip-set + the idempotent upsert.

import { normalizeSuiAddress } from '@mysten/sui/utils';

import { graphqlClient } from './client.ts';
import { normType } from './tokens.ts';

// One net balance change at the address in a successful tx. Amount is signed (+ in, - out). coinType is canonical.
export interface RawWalletTx {
  digest: string;
  coinType: string;
  amount: bigint; // signed magnitude, base units
  timestampMs: bigint;
  sender: string | null; // tx initiator; the counterparty on an incoming receive
  checkpoint: bigint;
}

// The verified testnet/mainnet schema (root `transactions`, `affectedAddress`, `afterCheckpoint`). Plain string
// so the client passes it through untouched; the /graphql suffix is already on SUI_GRAPHQL_URL.
const TX_BY_ADDRESS_QUERY = `query($addr: SuiAddress!, $after: String, $cp: UInt53) {
  transactions(first: 50, after: $after, filter: { affectedAddress: $addr, afterCheckpoint: $cp }) {
    pageInfo { hasNextPage endCursor }
    nodes {
      digest
      sender { address }
      effects {
        timestamp
        checkpoint { sequenceNumber }
        status
        balanceChanges {
          nodes { amount coinType { repr } owner { address } }
        }
      }
    }
  }
}`;

interface TxNode {
  digest: string;
  sender: { address: string | null } | null;
  effects: {
    timestamp: string | null;
    checkpoint: { sequenceNumber: string | number } | null;
    status: string | null;
    balanceChanges: { nodes: Array<{ amount: string | null; coinType: { repr: string } | null; owner: { address: string | null } | null }> } | null;
  } | null;
}
interface TxPage {
  transactions: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: TxNode[] } | null;
}

export interface ScanResult {
  rows: RawWalletTx[];
  maxCheckpoint: bigint; // highest checkpoint seen (0 if none); the indexer's next high-water mark
  pages: number; // pages successfully fetched
  ok: boolean; // at least one page reached the chain (the caller advances the checkpoint only when true)
  truncated: boolean; // stopped on the page budget with more to read (reconcile pass backfills any boundary gap)
}

// Scan an address's txs forward from `afterCheckpoint`, page-budget bounded. Emits one row per non-zero net
// balance change owned by the address in a SUCCESS tx. Never throws mid-page: a bad page ends the scan with
// whatever it has, so the caller advances nothing (ok=false on a total failure) and retries next tick.
export async function scanAddressTxs(address: string, afterCheckpoint: bigint, maxPages = 5): Promise<ScanResult> {
  const addr = normalizeSuiAddress(address);
  const rows: RawWalletTx[] = [];
  let maxCheckpoint = afterCheckpoint > 0n ? afterCheckpoint : 0n;
  let after: string | null = null;
  let pages = 0;
  let ok = false;
  let truncated = false;

  for (let i = 0; i < maxPages; i++) {
    let conn: TxPage['transactions'];
    try {
      const res: { data?: unknown } = await graphqlClient.query({
        query: TX_BY_ADDRESS_QUERY,
        variables: { addr, after, cp: Number(afterCheckpoint) },
      });
      conn = (res.data as TxPage | undefined)?.transactions ?? null;
      ok = true; // the query reached the chain (even an empty result means the range is genuinely empty)
      pages++;
    } catch (e) {
      // Transient GraphQL failure: stop here. The caller advances nothing, so the next tick retries the same range.
      console.warn('[wallet-history] scan page failed:', e instanceof Error ? e.message : e);
      break;
    }
    if (!conn) break;

    for (const t of conn.nodes) {
      const eff = t.effects;
      if (!eff || eff.status !== 'SUCCESS') continue;
      const cp = eff.checkpoint?.sequenceNumber != null ? BigInt(eff.checkpoint.sequenceNumber) : null;
      if (cp != null && cp > maxCheckpoint) maxCheckpoint = cp;
      const ts = eff.timestamp ? BigInt(Date.parse(eff.timestamp)) : 0n;
      const sender = t.sender?.address ? normalizeSuiAddress(t.sender.address) : null;

      for (const bc of eff.balanceChanges?.nodes ?? []) {
        if (!bc.owner?.address || normalizeSuiAddress(bc.owner.address) !== addr) continue;
        const repr = bc.coinType?.repr;
        const canon = repr ? normType(repr) : null;
        if (!canon || bc.amount == null) continue;
        let amount: bigint;
        try {
          amount = BigInt(bc.amount);
        } catch {
          continue;
        }
        if (amount === 0n) continue; // zero net (e.g. a self-transfer) is no real movement (I4)
        rows.push({ digest: t.digest, coinType: canon, amount, timestampMs: ts, sender, checkpoint: cp ?? maxCheckpoint });
      }
    }

    if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break;
    after = conn.pageInfo.endCursor;
    if (i + 1 >= maxPages) {
      truncated = true; // more pages exist but the budget is spent; the reconcile pass backfills any gap
      break;
    }
  }

  return { rows, maxCheckpoint, pages, ok, truncated };
}
