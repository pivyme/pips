// One-shot manual funding of the ops wallets from the operator: settlement (SUI), treasury (SUI +
// DUSDC reserve), and a sponsor top-up if low. Idempotent, re-running only tops up what is below the
// floor. Normally you do NOT need this: the operator funds these on boot (ensureOpsFunded in index.ts)
// and every 2 min after. Use it to fund without a redeploy, e.g. to exercise the treasury path locally.
//
//   bun scripts/fund-ops.ts
//
// CAUTION: this signs as the operator. If the DEPLOYED operator is also running, the two share the
// operator gas coin and will briefly contend (the executor's retry machinery resolves it, a few
// seconds of "stale object cache" retries on both sides). For zero contention, run it while the
// deployed operator is stopped.

import { ensureOpsFunded, getSuiBalanceRaw } from '../src/lib/sui/gas.ts';
import { getDusdcBalanceRaw } from '../src/lib/sui/dusdc.ts';
import { operatorAddress, settlementAddress, SETTLEMENT_ENABLED, treasuryAddress, TREASURY_ENABLED } from '../src/lib/sui/signer.ts';
import { sponsorAddress, SPONSOR_ENABLED } from '../src/lib/sui/sponsor.ts';

const sui = async (a: string): Promise<string> => (Number(await getSuiBalanceRaw(a)) / 1e9).toFixed(2);
const dusdc = async (a: string): Promise<string> => (Number(await getDusdcBalanceRaw(a)) / 1e6).toFixed(2);

async function show(tag: string): Promise<void> {
  console.log(`\n[${tag}]`);
  console.log(`  operator    ${operatorAddress}  SUI=${await sui(operatorAddress)}  DUSDC=${await dusdc(operatorAddress)}`);
  if (SPONSOR_ENABLED) console.log(`  sponsor     ${sponsorAddress}  SUI=${await sui(sponsorAddress)}`);
  if (SETTLEMENT_ENABLED) console.log(`  settlement  ${settlementAddress}  SUI=${await sui(settlementAddress)}`);
  if (TREASURY_ENABLED) console.log(`  treasury    ${treasuryAddress}  SUI=${await sui(treasuryAddress)}  DUSDC=${await dusdc(treasuryAddress)}`);
}

await show('before');
console.log('\nfunding ops wallets from operator...');
await ensureOpsFunded();
await show('after');
console.log('\ndone.');
process.exit(0);
