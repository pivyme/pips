// Gas sponsorship via Sui Address Balances: GAS_SPONSORSHIP_WALLET_PK pays gas for every privy play so
// users only ever hold DUSDC and never think about SUI.

// Sponsored tx names this wallet as gas OWNER with an EMPTY payment (needs enable_address_balance_gas_payments=true on the node), so gas draws from its address-balance accumulator, not an owned coin.
// With no owned gas coin in the tx, concurrent plays share zero owned objects and can never equivocate (the classic single-gas-coin freeze).

// Address-balance gas with no owned input needs a ValidDuring expiration for replay protection; the gRPC
// client's resolver doesn't add one at build(), so execute.ts sets it explicitly via applySponsorExpiration.

// The sponsor only ever signs as gas owner, so it can authorize gas but never move user funds. Keep it
// single-purpose (gas only); the operator (signer.ts) is a deliberately separate wallet.

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { fromBase64 } from '@mysten/sui/utils';
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';

import { GAS_SPONSORSHIP_WALLET_PK, PLAY_GAS_BUDGET, SPONSOR_TOPUP_SUI } from '../../config/main-config.ts';
import { suiClient } from './client.ts';

// Same parser as the operator key (signer.ts): a suiprivkey envelope, or base64 (32-byte secret or a 33-byte flagged keystore entry).
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

// Off when no key is set: executeForUser then leaves the user as their own gas payer (the per-user SUI funding fallback in gas.ts handles that).
export const SPONSOR_ENABLED: boolean = Boolean(GAS_SPONSORSHIP_WALLET_PK.trim());

const sponsorKeypair = SPONSOR_ENABLED ? loadKeypair(GAS_SPONSORSHIP_WALLET_PK) : null;
export const sponsorAddress: string = sponsorKeypair ? sponsorKeypair.getPublicKey().toSuiAddress() : '';

// Names the sponsor as gas owner with an empty payment, so gas comes from its address balance. Budget is left
// unpinned so the build-time dry-run sizes it to the real cost; gas price comes from the caller's (execute.ts) cached value.
export function applySponsorGas(tx: Transaction): void {
  if (!sponsorKeypair) throw new Error('applySponsorGas: sponsor wallet not configured');
  tx.setGasOwner(sponsorAddress);
  tx.setGasPayment([]);
}

// Co-signs the built bytes as gas owner, a plain local ed25519 sign with no network round trip. The user
// signs the same bytes separately via Privy rawSign; both signatures are submitted together.
export async function signAsSponsor(txBytes: Uint8Array): Promise<string> {
  if (!sponsorKeypair) throw new Error('signAsSponsor: sponsor wallet not configured');
  return (await sponsorKeypair.signTransaction(txBytes)).signature;
}

// The accumulator can't be read over RPC (getBalance reports owned coins, not address balance), so top-ups
// can't be balance-gated; self-heals via a once-per-process boot warm-up plus a reactive top-up on the exact "Invalid withdraw reservation" failure (execute.ts).

// Deposit is sponsor-signed (works on a follower with no operator) via coinWithBalance, not splitCoins(tx.gas)
// which threw InsufficientCoinBalance against the sponsor's fragmented faucet coins. Single-flighted so a burst of plays triggers one deposit.
const SUI_TYPE = '0x2::sui::SUI';
// Kept in the sponsor's owned coins so the top-up deposit tx can always pay its own gas.
const TOPUP_GAS_RESERVE = 100_000_000n; // 0.1 SUI
let warmedThisProcess = false;
let inflightTopup: Promise<void> | null = null;

// The sponsor's OWNED SUI coins (getBalance reports owned coins, not the address-balance accumulator).
async function ownedSuiRaw(): Promise<bigint> {
  const bal = await suiClient.getBalance({ owner: sponsorAddress, coinType: SUI_TYPE });
  return BigInt(bal.balance.balance);
}

export async function ensureSponsorAccumulator(force = false): Promise<void> {
  if (!sponsorKeypair) return;
  if (!force && warmedThisProcess) return;
  if (inflightTopup) return inflightTopup;
  inflightTopup = (async () => {
    // Moves SUI from owned coins into the address-balance accumulator, capped to what the sponsor can afford
    // (keeping a small reserve for this tx's own gas), so a low sponsor tops up partially instead of throwing. If it can't even fund one play's gas, log loudly and bail, the wallet needs SUI.
    const owned = await ownedSuiRaw();
    const affordable = owned > TOPUP_GAS_RESERVE ? owned - TOPUP_GAS_RESERVE : 0n;
    const want = BigInt(Math.round(SPONSOR_TOPUP_SUI * 1e9));
    const amount = want < affordable ? want : affordable;
    if (amount < PLAY_GAS_BUDGET) {
      console.warn(`[sponsor] accumulator empty and sponsor ${sponsorAddress} owned SUI (${owned}) too low to refill it; fund this wallet with testnet SUI`);
      return; // don't mark warmed: a later play retries once the wallet is funded
    }
    const tx = new Transaction();
    const coin = coinWithBalance({ type: SUI_TYPE, balance: amount })(tx);
    // send_funds credits the coin into the recipient's SUI address balance (the accumulator).
    tx.moveCall({ target: '0x2::coin::send_funds', typeArguments: [SUI_TYPE], arguments: [coin, tx.pure.address(sponsorAddress)] });
    tx.setSender(sponsorAddress);
    const res = await suiClient.signAndExecuteTransaction({ signer: sponsorKeypair!, transaction: tx, include: { effects: true } });
    const t = res.$kind === 'Transaction' ? res.Transaction : null;
    if (!t || t.effects?.status?.success !== true) {
      const status = t?.effects?.status ?? (res.$kind === 'FailedTransaction' ? res.FailedTransaction.status : res);
      throw new Error(`sponsor accumulator top-up failed: ${JSON.stringify(status)}`);
    }
    await suiClient.waitForTransaction({ digest: t.digest });
    warmedThisProcess = true;
    console.log(`[sponsor] topped up gas accumulator with ${Number(amount) / 1e9} SUI (${t.digest})`);
  })();
  try {
    await inflightTopup;
  } finally {
    inflightTopup = null;
  }
}

// The exact node rejection when the sponsor's accumulator can't cover gas; matched so the play path can top up and retry instead of surfacing a dead "account still getting ready".
export function isSponsorGasError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return m.includes('withdraw reservation') || (m.includes('available amount in account') && m.includes('less than requested'));
}
