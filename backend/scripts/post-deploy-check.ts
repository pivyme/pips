// Opt-in live package smoke. This sends one standalone logger event, separate from the one-play E2E
// suite, so a publish failure is isolated before the real Predict composition is exercised.

import '../dotenv.ts';

import { Transaction } from '@mysten/sui/transactions';

import { PIPS_LOGGER_PACKAGE_ID } from '../src/config/main-config.ts';
import { executeRealSettle } from '../src/lib/sui/execute.ts';
import { buildLogPlay } from '../src/lib/sui/logger.ts';
import { operatorAddress } from '../src/lib/sui/signer.ts';

if (!PIPS_LOGGER_PACKAGE_ID) throw new Error('PIPS_LOGGER_PACKAGE_ID is required for the post-deploy check');

const expected = {
  player: operatorAddress,
  game: 'logger_smoke',
  playId: `logger_smoke_${Date.now()}`,
  market: operatorAddress,
  referrerId: '',
};
const tx = new Transaction();
buildLogPlay(tx, expected);
// The generic serial executor can throw after a successful all-shared-input tx because there is no
// gas object in effects to cache. The direct path is already used for real settle redeems and returns
// the confirmed event result without that false-negative post-submit failure.
const result = await executeRealSettle(tx, 'pips logger post-deploy smoke');
const event = result.events.find((event) => event.type === `${PIPS_LOGGER_PACKAGE_ID}::activity::Played`);
if (!event?.parsedJson) throw new Error('post-deploy check did not receive a Played event');
for (const [key, value] of Object.entries({
  version: '1',
  player: expected.player,
  game: expected.game,
  play_id: expected.playId,
  market: expected.market,
  referrer_id: expected.referrerId,
})) {
  if (String(event.parsedJson[key]) !== value) throw new Error(`Played.${key} mismatch`);
}
console.log(`PIPS logger smoke passed: ${result.digest}`);
