// Ad-hoc lookup: resolve a user's PredictManager (real Predict's AccountWrapper) and its chip
// balance from their owner address. Mirrors the sum the frontend shows (services/auth.ts):
// wallet DUSDC (a Coin<DUSDC> the owner holds) + manager DUSDC (the wrapper's internal balance).
//   cd backend && bun scripts/temp.ts 0xowneraddress
import '../dotenv.ts';

import { readWrapper, readUserChipsRaw } from '../src/lib/sui/predict-real.ts';
import { getDusdcBalanceRaw } from '../src/lib/sui/dusdc.ts';
import { fromDusdcRaw } from '../src/lib/sui/config.ts';

async function getPredictManagerId(owner: string): Promise<string> {
  const { wrapperId } = await readWrapper(owner);
  return wrapperId;
}

const owner = process.argv[2];
if (!owner) {
  console.error('usage: bun scripts/temp.ts <owner-address>');
  process.exit(1);
}

const wrapperId = await getPredictManagerId(owner);
const [walletRaw, managerRaw] = await Promise.all([
  getDusdcBalanceRaw(owner),
  readUserChipsRaw(owner, wrapperId),
]);

console.log('wrapperId:', wrapperId);
console.log('wallet:   ', fromDusdcRaw(walletRaw), 'DUSDC');
console.log('manager:  ', fromDusdcRaw(managerRaw), 'DUSDC');
console.log('total:    ', fromDusdcRaw(walletRaw + managerRaw), 'DUSDC (this is what the frontend shows)');
