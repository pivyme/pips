// One-shot funding of the ops wallets to generous TARGET balances so you never refill by hand.
// Idempotent (ensure-at-least: a re-run only sends the shortfall). Operator-signed, retries past the
// gas-coin race with a live deployed operator. The operator also auto-tops-up these on boot + every
// 2 min once the new code is deployed, this just front-loads a big buffer so you never think about it.
//
//   bun scripts/fund-ops.ts
//
// CAUTION: signs as the operator. If the DEPLOYED operator is also running, the two share the operator
// gas coin and briefly contend (the retries resolve it). For zero contention, run with the deployed
// operator stopped. Tune the targets below.

import { Transaction } from '@mysten/sui/transactions';
import { fundSui, getSuiBalanceRaw } from '../src/lib/sui/gas.ts';
import { mintDusdc, getDusdcBalanceRaw } from '../src/lib/sui/dusdc.ts';
import { executeAsOperator } from '../src/lib/sui/execute.ts';
import { settlementAddress, SETTLEMENT_ENABLED, treasuryAddress, TREASURY_ENABLED } from '../src/lib/sui/signer.ts';
import { sponsorAddress, SPONSOR_ENABLED } from '../src/lib/sui/sponsor.ts';

// Generous targets, localnet SUI/DUSDC are free. Sized so you never refill for any demo/testing.
const TARGET = {
  sponsorSui: 25_000, // gas for every sponsored play (~12M plays)
  settlementSui: 25_000, // gas for the redeem sweeps (~2.5M redeems)
  treasurySui: 15_000, // gas for chip payouts (~3M transfers)
  treasuryDusdc: 100_000_000, // chip reserve (~1M faucet taps at 100)
};

const MIST = 1_000_000_000n;
const SUI_TYPE = '0x2::sui::SUI';

const suiOf = async (a: string): Promise<number> => Number(await getSuiBalanceRaw(a)) / 1e9;
const dusdcOf = async (a: string): Promise<number> => Number(await getDusdcBalanceRaw(a)) / 1e6;

// Re-attempt past the deployed operator's gas-coin contention (each call already does 5 inner retries).
async function retry(label: string, fn: () => Promise<unknown>, n = 8): Promise<void> {
  for (let i = 1; i <= n; i++) {
    try {
      await fn();
      console.log(`  ${label}: done`);
      return;
    } catch (e) {
      console.warn(`  ${label}: attempt ${i}/${n} lost the race (${String(e instanceof Error ? e.message : e).slice(0, 56)}…)`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  console.error(`  ${label}: GAVE UP, re-run, or stop the deployed operator and retry`);
}

// The sponsor pays gas from its ADDRESS BALANCE, so top it up with send_funds, not a plain transfer.
async function topUpSponsor(sui: number): Promise<void> {
  const tx = new Transaction();
  const coin = tx.splitCoins(tx.gas, [tx.pure.u64(BigInt(Math.round(sui)) * MIST)]);
  tx.moveCall({ target: '0x2::coin::send_funds', typeArguments: [SUI_TYPE], arguments: [coin, tx.pure.address(sponsorAddress)] });
  await executeAsOperator(tx, 'fundSponsor(target)');
}

console.log('Funding ops wallets to generous targets (idempotent)...\n');

if (SPONSOR_ENABLED) {
  const need = TARGET.sponsorSui - (await suiOf(sponsorAddress));
  if (need > 1) await retry(`sponsor +${Math.round(need)} SUI`, () => topUpSponsor(need));
  else console.log('  sponsor: already at target');
}
if (SETTLEMENT_ENABLED) {
  const need = TARGET.settlementSui - (await suiOf(settlementAddress));
  if (need > 1) await retry(`settlement +${Math.round(need)} SUI`, () => fundSui(settlementAddress, need));
  else console.log('  settlement: already at target');
}
if (TREASURY_ENABLED) {
  const needSui = TARGET.treasurySui - (await suiOf(treasuryAddress));
  if (needSui > 1) await retry(`treasury +${Math.round(needSui)} SUI`, () => fundSui(treasuryAddress, needSui));
  else console.log('  treasury SUI: already at target');
  const needD = TARGET.treasuryDusdc - (await dusdcOf(treasuryAddress));
  if (needD > 1) await retry(`treasury +${Math.round(needD)} DUSDC`, () => mintDusdc(treasuryAddress, needD));
  else console.log('  treasury DUSDC: already at target');
}

console.log('\nFinal balances:');
if (SPONSOR_ENABLED) console.log(`  sponsor     SUI=${(await suiOf(sponsorAddress)).toFixed(0)}`);
if (SETTLEMENT_ENABLED) console.log(`  settlement  SUI=${(await suiOf(settlementAddress)).toFixed(0)}`);
if (TREASURY_ENABLED) console.log(`  treasury    SUI=${(await suiOf(treasuryAddress)).toFixed(0)}  DUSDC=${(await dusdcOf(treasuryAddress)).toFixed(0)}`);
process.exit(0);
