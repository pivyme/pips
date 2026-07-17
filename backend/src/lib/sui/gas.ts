// SUI balance read + the sponsor-accumulator poke. Real Predict wallets are hand-funded (no operator
// auto-topup, no DUSDC mint); onboarding/plays draw gas from the sponsor's address-balance accumulator.

import { suiClient } from './client.ts';
import { SPONSOR_ENABLED, ensureSponsorAccumulator } from './sponsor.ts';

const SUI_TYPE = '0x2::sui::SUI';

// Read an address's SUI balance in MIST.
export async function getSuiBalanceRaw(owner: string): Promise<bigint> {
  const bal = await suiClient.getBalance({ owner, coinType: SUI_TYPE });
  return BigInt(bal.balance.balance);
}

// Keeps the sponsor's address-balance accumulator funded (where empty-payment sponsored gas is drawn from)
// by delegating to sponsor.ts's ensureSponsorAccumulator (sponsor-signed, fragmentation-robust, self-healing).
export async function ensureSponsorFunded(): Promise<void> {
  if (!SPONSOR_ENABLED) return;
  await ensureSponsorAccumulator();
}
