// Native Sui wallet connect is PARKED (Privy-only build); stubs below keep the door + auth context compiling.
// Parked because `@mysten/wallet-standard` is only a transitive dep (bundler can't resolve it); to restore, uncomment the block below, add the dep, and flip VITE_WALLET_CONNECT_ENABLED.

export type SuiWallet = { name: string; icon?: string }

export function listSuiWallets(): SuiWallet[] {
  return []
}

export function onWalletsChange(_cb: () => void): () => void {
  return () => {}
}

export async function connectWallet(_wallet: SuiWallet): Promise<{ address: string }> {
  throw new Error('Native wallet connect is disabled (Privy-only build)')
}

export async function signLoginMessage(
  _wallet: SuiWallet,
  _account: { address: string },
  _message: string,
): Promise<string> {
  throw new Error('Native wallet connect is disabled (Privy-only build)')
}

// Pure, no external deps. Kept live so error handling elsewhere still reads naturally.
export function isUserRejection(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase()
  return /reject|denied|cancel|declin|user (closed|exited)/.test(m)
}

/* ---- Real implementation, parked. Uncomment to restore native Sui wallet connect. ----

The thin client half of the custodial login (see backend services/auth.ts). We use the Wallet
Standard directly (not @mysten/dapp-kit) because all we need is: list installed Sui wallets, connect
one, and have it sign ONE personal message (the login nonce). The connected wallet never signs a
transaction, the server-held custodial play wallet does all on-chain work, so this stays tiny and
avoids the dapp-kit lit/SSR/provider weight.

Everything here touches `window` only inside functions (getWallets dispatches a window event), so the
module is safe to import in the SSR tree; just never CALL these during render on the server.

import { getWallets, StandardConnect, SuiSignPersonalMessage } from '@mysten/wallet-standard'
import type { Wallet, WalletAccount } from '@mysten/wallet-standard'

export type SuiWallet = Wallet

type ConnectFeature = { connect: () => Promise<{ accounts: readonly WalletAccount[] }> }
type SignFeature = {
  signPersonalMessage: (input: { message: Uint8Array; account: WalletAccount }) => Promise<{ bytes: string; signature: string }>
}

// A wallet is usable for our flow only if it can connect, sign a personal message, and speaks Sui.
function isUsable(w: Wallet): boolean {
  return (
    StandardConnect in w.features &&
    SuiSignPersonalMessage in w.features &&
    w.chains.some((c) => c.startsWith('sui:'))
  )
}

export function listSuiWallets(): SuiWallet[] {
  return getWallets()
    .get()
    .filter(isUsable)
}

// Subscribe to wallets registering/unregistering (extensions inject asynchronously, often after first
// paint). Returns an unsubscribe.
export function onWalletsChange(cb: () => void): () => void {
  const api = getWallets()
  const offRegister = api.on('register', cb)
  const offUnregister = api.on('unregister', cb)
  return () => {
    offRegister()
    offUnregister()
  }
}

// Connect a wallet and return the account we'll authenticate as (first authorized account).
export async function connectWallet(wallet: SuiWallet): Promise<WalletAccount> {
  const feature = wallet.features[StandardConnect] as ConnectFeature | undefined
  if (!feature) throw new Error('Wallet does not support connect')
  const { accounts } = await feature.connect()
  const account = accounts[0] ?? wallet.accounts[0]
  if (!account) throw new Error('No account authorized')
  return account
}

// Sign the login challenge with the connected account. Returns the base64 serialized signature the
// backend verifies with verifyPersonalMessageSignature.
export async function signLoginMessage(wallet: SuiWallet, account: WalletAccount, message: string): Promise<string> {
  const feature = wallet.features[SuiSignPersonalMessage] as SignFeature | undefined
  if (!feature) throw new Error('Wallet cannot sign messages')
  const { signature } = await feature.signPersonalMessage({
    message: new TextEncoder().encode(message),
    account,
  })
  return signature
}

---- end parked implementation ---- */
