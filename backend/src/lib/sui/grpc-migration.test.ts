import { describe, expect, it } from 'bun:test';

import { SuiGrpcClient } from '@mysten/sui/grpc';

import { matchRedeemInTxPage, type RedeemKey } from './predict.ts';
import { selectLiveOraclesFromPage } from '../../workers/market-sync.ts';

// Locks the GraphQL response parsing for the two historical paths migrated off JSON-RPC (market-sync
// event scan, predict redeem reconcile). Fixtures mirror the live schema: events/tx come back oldest-first within a page, payloads under contents.json / contents.type.repr.

describe('market-sync OracleActivated page parse', () => {
  const now = 1_000_000_000_000;
  const cutoff = now - 3_600_000; // activations older than this are long expired

  it('keeps only live oracles and flags when the page reaches old activations', () => {
    const nodes = [
      // oldest-first: this one predates the cutoff -> reachedOld, skipped
      { contents: { json: { oracle_id: '0xold', expiry: String(now + 3_600_000), timestamp: String(cutoff - 1) } } },
      // already expired -> not live, skipped
      { contents: { json: { oracle_id: '0xexpired', expiry: String(now - 1), timestamp: String(now) } } },
      // still ahead of now + safety -> kept
      { contents: { json: { oracle_id: '0xlive', expiry: String(now + 3_600_000), timestamp: String(now) } } },
      // malformed nodes are tolerated, never throw
      { contents: { json: null } },
      { contents: null },
    ];

    const { ids, reachedOld } = selectLiveOraclesFromPage(nodes, now, cutoff);
    expect(ids).toEqual(['0xlive']);
    expect(reachedOld).toBe(true);
  });

  it('returns no ids and reachedOld=false for an empty page', () => {
    expect(selectLiveOraclesFromPage([], now, cutoff)).toEqual({ ids: [], reachedOld: false });
  });
});

describe('predict redeem tx-page match', () => {
  const binaryKey: RedeemKey = {
    kind: 'binary',
    params: { oracleId: '0xoracle', expiryMs: 0, strike1e9: 3_000_000_000_000n, side: 'up', quantity: 50_000_000n },
  };

  const redeemNode = (digest: string, json: Record<string, unknown>, repr = '0xabc::predict::PositionRedeemed') => ({
    digest,
    effects: { events: { nodes: [{ contents: { json, type: { repr } } }] } },
  });

  it('parses the matching binary redeem into an OnChainRedeem, newest match wins', () => {
    const nodes = [
      // oldest-first: an older matching redeem should be beaten by the newer one below
      redeemNode('OLD', { oracle_id: '0xoracle', quantity: '50000000', is_up: true, strike: '3000000000000', payout: '1', is_settled: false }),
      // a non-redeem event on an unrelated tx is skipped
      { digest: 'NOISE', effects: { events: { nodes: [{ contents: { json: {}, type: { repr: '0xabc::predict::PositionMinted' } } }] } } },
      // newest matching redeem, this one must win
      redeemNode('NEW', { oracle_id: '0xoracle', quantity: '50000000', is_up: true, strike: '3000000000000', payout: '42000000', is_settled: true }),
    ];

    expect(matchRedeemInTxPage(nodes, binaryKey)).toEqual({
      payout: 42_000_000n,
      quantity: 50_000_000n,
      settled: true,
      digest: 'NEW',
    });
  });

  it('rejects a redeem with the wrong quantity or side', () => {
    const wrongQty = [redeemNode('X', { oracle_id: '0xoracle', quantity: '99', is_up: true, strike: '3000000000000', payout: '1', is_settled: true })];
    const wrongSide = [redeemNode('Y', { oracle_id: '0xoracle', quantity: '50000000', is_up: false, strike: '3000000000000', payout: '1', is_settled: true })];
    expect(matchRedeemInTxPage(wrongQty, binaryKey)).toBeNull();
    expect(matchRedeemInTxPage(wrongSide, binaryKey)).toBeNull();
  });

  it('matches a range redeem by its band, not a binary suffix', () => {
    const rangeKey: RedeemKey = {
      kind: 'range',
      params: { oracleId: '0xoracle', expiryMs: 0, lower1e9: 1_000n, higher1e9: 2_000n, quantity: 10n },
    };
    const nodes = [
      redeemNode(
        'RANGE',
        { oracle_id: '0xoracle', quantity: '10', lower_strike: '1000', higher_strike: '2000', payout: '10', is_settled: true },
        '0xabc::predict::RangeRedeemed',
      ),
    ];
    expect(matchRedeemInTxPage(nodes, rangeKey)).toEqual({ payout: 10n, quantity: 10n, settled: true, digest: 'RANGE' });
    // the same node must NOT satisfy a binary key (wrong suffix + fields)
    expect(matchRedeemInTxPage(nodes, binaryKey)).toBeNull();
  });

  it('returns null for an empty page', () => {
    expect(matchRedeemInTxPage([], binaryKey)).toBeNull();
  });
});

// Guarded live smoke: proves the gRPC client's real response shapes (getReferenceGasPrice / getBalance)
// still match what the wrappers read. Off by default so `bun test` stays offline; run with PIPS_LIVE_SUI_TEST=1 to hit devnet.
const LIVE = process.env.PIPS_LIVE_SUI_TEST === '1';
describe.if(LIVE)('live gRPC client shape (devnet)', () => {
  const client = new SuiGrpcClient({ network: 'devnet', baseUrl: 'https://fullnode.devnet.sui.io:443' });

  it('getReferenceGasPrice exposes referenceGasPrice', async () => {
    const price = BigInt((await client.getReferenceGasPrice()).referenceGasPrice);
    expect(price).toBeGreaterThan(0n);
  });

  it('getBalance nests balance under balance.balance', async () => {
    const bal = await client.getBalance({
      owner: '0x0000000000000000000000000000000000000000000000000000000000000000',
      coinType: '0x2::sui::SUI',
    });
    expect(typeof bal.balance.balance).toBe('string');
    expect(BigInt(bal.balance.balance)).toBeGreaterThanOrEqual(0n);
  });
});
