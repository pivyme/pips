import { describe, expect, it } from 'bun:test';

import { aggregateProof, proofCsv, type ProofPlay } from './pips-volume-proof.ts';

describe('PIPS volume proof aggregation', () => {
  it('keeps raw Predict amounts exact while grouping public PIPS tags', () => {
    const plays: ProofPlay[] = [
      { digest: 'tx-1', player: '0xa', game: 'lucky', playId: 'play-1', market: '0xm', referrerId: '', premiumRaw: 1_250_000n, notionalRaw: 2_000_000n },
      { digest: 'tx-2', player: '0xa', game: 'range', playId: 'play-2', market: '0xm', referrerId: 'opaque', premiumRaw: 750_000n, notionalRaw: 1_500_000n },
    ];
    const proof = aggregateProof('0xlogger', plays);
    expect(proof.premiumRaw).toBe(2_000_000n);
    expect(proof.notionalRaw).toBe(3_500_000n);
    expect(proof.uniquePlayers).toBe(1);
    expect(proof.byGame.lucky).toMatchObject({ plays: 1, premiumRaw: 1_250_000n });
    expect(proof.byReferrer.opaque).toMatchObject({ plays: 1, notionalRaw: 1_500_000n });
    expect(proofCsv(proof)).toContain('"play-2"');
    expect(proofCsv(proof)).toContain('"0.75"');
  });
});
