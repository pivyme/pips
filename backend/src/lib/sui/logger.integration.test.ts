// This is deliberately opt-in. It sends exactly one real Predict mint, checks that Played and
// OrderMinted share its digest, then cashes that position out. It needs a funded testnet user and DB.

import { afterAll, describe, expect, it } from 'bun:test';

import { PIPS_LOGGER_PACKAGE_ID } from '../../config/main-config.ts';
import { prismaQuery } from '../prisma.ts';
import { suiClient } from './client.ts';
import { cashoutPlay, createPlay } from '../../services/plays.ts';
import { operatorAddress } from './signer.ts';
import { aggregateProof, reconcileProofWithDb, scanPipsVolume } from '../../../scripts/pips-volume-proof.ts';

const enabled = process.env.PIPS_E2E === '1';
const suite = enabled ? describe : describe.skip;

suite('PIPS logger live integration', () => {
  afterAll(async () => {
    await prismaQuery.$disconnect();
  });

  it('co-locates Played and OrderMinted in one real mint, then cashes the position out', async () => {
    if (!PIPS_LOGGER_PACKAGE_ID) throw new Error('PIPS_LOGGER_PACKAGE_ID must be configured for PIPS_E2E');
    const user = await prismaQuery.user.findUnique({ where: { address: operatorAddress } });
    if (!user) throw new Error('PIPS_E2E needs the testing wallet to have completed backend onboarding first');

    const { play } = await createPlay(user, { game: 'lucky', stake: 1.5 });
    let minted = await prismaQuery.play.findUniqueOrThrow({ where: { id: play.id } });
    for (let attempt = 0; !minted.txMint && attempt < 40; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      minted = await prismaQuery.play.findUniqueOrThrow({ where: { id: play.id } });
    }
    expect(minted.status).toBe('open');
    expect(minted.txMint).toBeTruthy();

    const tx = await suiClient.waitForTransaction({ digest: minted.txMint!, timeout: 20_000, include: { events: true } });
    const events = tx.$kind === 'Transaction' ? tx.Transaction.events ?? [] : [];
    const played = events.find((event) => event.eventType === `${PIPS_LOGGER_PACKAGE_ID}::activity::Played`);
    const orderMinted = events.find((event) => event.eventType.endsWith('::order_events::OrderMinted'));
    expect(played?.json).toMatchObject({
      version: '1',
      player: user.address,
      game: minted.game,
      play_id: minted.id,
      market: minted.oracleId,
      referrer_id: '',
    });
    expect(orderMinted).toBeDefined();

    // Historical GraphQL indexing can lag the fullnode by a few checkpoints. Once it catches up,
    // prove that the public tag finds this mint and that Predict's values reconcile to our ledger.
    let proof = await scanPipsVolume(PIPS_LOGGER_PACKAGE_ID);
    for (let attempt = 0; !proof.plays.some((play) => play.playId === minted.id) && attempt < 40; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      proof = await scanPipsVolume(PIPS_LOGGER_PACKAGE_ID);
    }
    const proofPlay = proof.plays.find((play) => play.playId === minted.id);
    expect(proofPlay).toBeDefined();
    await reconcileProofWithDb(aggregateProof(PIPS_LOGGER_PACKAGE_ID, [proofPlay!]));

    await cashoutPlay(user, minted.id);
  }, 120_000);
});
