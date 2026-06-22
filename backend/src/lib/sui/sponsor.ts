// Gas sponsorship via Sui Address Balances. One dedicated wallet (GAS_SPONSORSHIP_WALLET_PK) pays
// the gas for every privy user play, so users only ever hold DUSDC and never think about SUI.
//
// Why this stays stable under load: the sponsored tx names this wallet as the gas OWNER with an
// EMPTY gas payment, so gas is drawn from the wallet's SUI address balance (an accumulator), not an
// owned gas coin. With no owned gas coin in the tx, concurrent plays from different users share zero
// owned objects and can never equivocate (the classic single-gas-coin failure that freezes a coin
// until epoch end). Our localnet has enable_address_balance_gas_payments=true, and the SDK resolves
// the required single-epoch expiration automatically at build() when the payment is empty.
//
// The sponsor only ever signs as the gas owner, so it can authorize gas but never move a user's
// funds. Keep this address single-purpose (gas only) per Sui guidance, so nothing else contends for
// it; the operator (signer.ts) is a deliberately separate wallet.

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { fromBase64 } from '@mysten/sui/utils';
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';

import { GAS_SPONSORSHIP_WALLET_PK, SPONSOR_TOPUP_SUI } from '../../config/main-config.ts';
import { suiClient } from './client.ts';

// Same parser as the operator key (signer.ts): a suiprivkey envelope, or base64 (32-byte secret or
// a 33-byte flagged keystore entry).
function loadKeypair(pk: string): Ed25519Keypair {
  const k = pk.trim();
  if (k.startsWith('suiprivkey')) {
    const { secretKey } = decodeSuiPrivateKey(k);
    return Ed25519Keypair.fromSecretKey(secretKey);
  }
  const raw = fromBase64(k);
  const secret = raw.length === 33 ? raw.slice(1) : raw;
  return Ed25519Keypair.fromSecretKey(secret);
}

// Off when no key is set: executeForUser then leaves the user as their own gas payer (the per-user
// SUI funding fallback in gas.ts handles that).
export const SPONSOR_ENABLED: boolean = Boolean(GAS_SPONSORSHIP_WALLET_PK.trim());

const sponsorKeypair = SPONSOR_ENABLED ? loadKeypair(GAS_SPONSORSHIP_WALLET_PK) : null;
export const sponsorAddress: string = sponsorKeypair ? sponsorKeypair.getPublicKey().toSuiAddress() : '';

// Name the sponsor as gas owner with an empty payment, so gas comes from its address balance. We do
// NOT pin the budget: the build-time dry-run sizes it to the real cost (the sponsor's balance dwarfs
// any play, and the storage rebate credits back to that balance), which also adapts to heavier txs
// like a future withdrawal. The gas price is set by the caller (execute.ts) from its cached value.
export function applySponsorGas(tx: Transaction): void {
  if (!sponsorKeypair) throw new Error('applySponsorGas: sponsor wallet not configured');
  tx.setGasOwner(sponsorAddress);
  tx.setGasPayment([]);
}

// Co-sign the built bytes as the gas owner. A plain local ed25519 sign, no network round trip. The
// user signs the same bytes separately (via Privy rawSign); both signatures are submitted together.
export async function signAsSponsor(txBytes: Uint8Array): Promise<string> {
  if (!sponsorKeypair) throw new Error('signAsSponsor: sponsor wallet not configured');
  return (await sponsorKeypair.signTransaction(txBytes)).signature;
}

// The accumulator that empty-payment sponsored gas is drawn from can't be read over RPC (getBalance
// reports owned COINS, not the address balance), so we can't gate a top-up on a balance check. Two
// things keep it funded instead, and together make an empty accumulator self-heal:
//   1) a once-per-process top-up on boot (warm-up), so a fresh chain / post-wipe restart is covered;
//   2) a forced top-up reacted to the exact "Invalid withdraw reservation" failure (execute.ts), so a
//      mid-session drain refills and the play retries.
// The deposit is sponsor-signed (works on a follower with no operator) and uses coinWithBalance so it
// is robust against the sponsor's SUI being fragmented into many small faucet coins (the old
// splitCoins(tx.gas) form failed with InsufficientCoinBalance on that fragmentation). Single-flighted
// so a burst of plays triggers one deposit. The sponsor keeps SUI in coins via the devnet faucet.
const SUI_TYPE = '0x2::sui::SUI';
let warmedThisProcess = false;
let inflightTopup: Promise<void> | null = null;

export async function ensureSponsorAccumulator(force = false): Promise<void> {
  if (!sponsorKeypair) return;
  if (!force && warmedThisProcess) return;
  if (inflightTopup) return inflightTopup;
  inflightTopup = (async () => {
    const tx = new Transaction();
    const coin = coinWithBalance({ type: SUI_TYPE, balance: BigInt(Math.round(SPONSOR_TOPUP_SUI * 1e9)) })(tx);
    // send_funds credits the coin into the recipient's SUI address balance (the accumulator).
    tx.moveCall({ target: '0x2::coin::send_funds', typeArguments: [SUI_TYPE], arguments: [coin, tx.pure.address(sponsorAddress)] });
    tx.setSender(sponsorAddress);
    const res = await suiClient.signAndExecuteTransaction({ signer: sponsorKeypair!, transaction: tx, options: { showEffects: true } });
    if (res.effects?.status?.status !== 'success') {
      throw new Error(`sponsor accumulator top-up failed: ${JSON.stringify(res.effects?.status)}`);
    }
    await suiClient.waitForTransaction({ digest: res.digest });
    warmedThisProcess = true;
    console.log(`[sponsor] topped up gas accumulator with ${SPONSOR_TOPUP_SUI} SUI (${res.digest})`);
  })();
  try {
    await inflightTopup;
  } finally {
    inflightTopup = null;
  }
}

// The exact node rejection when the sponsor's accumulator can't cover a sponsored tx's gas. Matched so
// the play path can top up and retry instead of surfacing a dead "account still getting ready".
export function isSponsorGasError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return m.includes('withdraw reservation') || (m.includes('available amount in account') && m.includes('less than requested'));
}
