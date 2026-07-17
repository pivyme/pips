// Read-only funding check for real-mode (testnet) plays. Prints the hand-funded wallet addresses and
// their live SUI (gas) + DUSDC (chips) balances so funding is never a guess. No writes.
//   cd backend && bun scripts/diag-funding.ts
import '../dotenv.ts';

import { TREASURY_MIN_DUSDC, SPONSOR_FLOOR_SUI } from '../src/config/main-config.ts';
import { DUSDC_TYPE } from '../src/lib/sui/config.ts';
import { treasuryAddress, settlementAddress, operatorAddress } from '../src/lib/sui/signer.ts';
import { sponsorAddress, SPONSOR_ENABLED } from '../src/lib/sui/sponsor.ts';
import { getSuiBalanceRaw } from '../src/lib/sui/gas.ts';
import { getDusdcBalanceRaw } from '../src/lib/sui/dusdc.ts';

const SUI = (mist: bigint) => (Number(mist) / 1e9).toFixed(4);
const USDC = (raw: bigint) => (Number(raw) / 1e6).toFixed(6);

console.log('mode: REAL (testnet Mysten Predict)');
console.log(`DUSDC type: ${DUSDC_TYPE}`);
console.log(`floors: treasury >= ${TREASURY_MIN_DUSDC} DUSDC, sponsor >= ${SPONSOR_FLOOR_SUI} SUI\n`);

async function line(label: string, addr: string) {
  if (!addr) { console.log(`${label}: (unset)`); return; }
  const [sui, dusdc] = await Promise.all([
    getSuiBalanceRaw(addr).catch(() => -1n),
    getDusdcBalanceRaw(addr).catch(() => -1n),
  ]);
  console.log(`${label}: ${addr}`);
  console.log(`   SUI:   ${sui < 0n ? 'read-failed' : SUI(sui)}`);
  console.log(`   DUSDC: ${dusdc < 0n ? 'read-failed' : USDC(dusdc)}`);
}

await line('treasury (DUSDC chips)', treasuryAddress);
await line(`sponsor  (SUI gas${SPONSOR_ENABLED ? '' : ', DISABLED'})`, sponsorAddress);
await line('settlement (SUI gas)', settlementAddress);
await line('operator/testing', operatorAddress);
process.exit(0);
