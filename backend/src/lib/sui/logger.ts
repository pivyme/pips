// Stateless PIPS attribution seam. The event is appended to the real mint PTB, making the PIPS tag
// and Predict's OrderMinted event atomic. Empty config is a strict no-op.

import type { Transaction } from '@mysten/sui/transactions';

import { PIPS_LOGGER_PACKAGE_ID } from '../../config/main-config.ts';

export const LOGGER_ENABLED = PIPS_LOGGER_PACKAGE_ID.length > 0;

export type PlayAttribution = {
  player: string;
  game: string;
  playId: string;
  market: string;
  // Deliberately opaque if this is ever enabled. v1 leaves it empty so referral attribution stays DB-side.
  referrerId?: string;
};

// Kept configuration-free for hermetic command-shape tests. Production callers use buildLogPlay below.
export function buildLogPlayForPackage(tx: Transaction, packageId: string, attribution: PlayAttribution): void {
  if (!packageId) return;
  tx.moveCall({
    target: `${packageId}::activity::record`,
    arguments: [
      tx.pure.address(attribution.player),
      tx.pure.string(attribution.game),
      tx.pure.string(attribution.playId),
      tx.pure.address(attribution.market),
      tx.pure.string(attribution.referrerId ?? ''),
    ],
  });
}

export function buildLogPlay(tx: Transaction, attribution: PlayAttribution): void {
  buildLogPlayForPackage(tx, PIPS_LOGGER_PACKAGE_ID, attribution);
}
