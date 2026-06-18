// Enoki zkLogin (Google sign-in) for enoki mode. Lazy-imported only when AUTH_MODE=enoki, so
// dev mode never pulls the zkLogin WASM. One EnokiFlow singleton owns the session; the auth
// context drives the Google redirect, the callback, and the personal-message / tx signing.

import { EnokiFlow } from '@mysten/enoki'
import { fromBase64 } from '@mysten/sui/utils'

import { env } from '@/env'

// Enoki only serves real networks; localnet has no zkLogin prover, so fall back to testnet
// for the (unused in localnet) enoki calls. localnet always runs in dev auth mode.
const NETWORK = env.VITE_SUI_NETWORK === 'localnet' ? 'testnet' : env.VITE_SUI_NETWORK

let flow: EnokiFlow | null = null
function getFlow(): EnokiFlow {
  if (!env.VITE_ENOKI_API_KEY) throw new Error('VITE_ENOKI_API_KEY is not set (required in enoki mode)')
  if (!flow) flow = new EnokiFlow({ apiKey: env.VITE_ENOKI_API_KEY })
  return flow
}

// Kick off Google sign-in: build the authorization URL and redirect the browser to it.
export async function enokiSignIn(redirectUrl: string): Promise<void> {
  if (!env.VITE_GOOGLE_CLIENT_ID) throw new Error('VITE_GOOGLE_CLIENT_ID is not set (required in enoki mode)')
  const url = await getFlow().createAuthorizationURL({
    provider: 'google',
    clientId: env.VITE_GOOGLE_CLIENT_ID,
    redirectUrl,
    network: NETWORK,
  })
  window.location.href = url
}

// Complete the OAuth round trip on the redirect target. Returns the zkLogin address or null.
export async function enokiHandleCallback(): Promise<string | null> {
  await getFlow().handleAuthCallback()
  const session = await getFlow().getSession()
  if (!session) return null
  return getFlow().$zkLoginState.get().address ?? null
}

// The current zkLogin address, if a session is live.
export async function enokiAddress(): Promise<string | null> {
  const session = await getFlow().getSession()
  if (!session) return null
  return getFlow().$zkLoginState.get().address ?? null
}

// Sign the auth-handshake personal message (the backend reconstructs and verifies the bytes).
export async function enokiSignPersonalMessage(message: string): Promise<string> {
  const keypair = await getFlow().getKeypair({ network: NETWORK })
  const { signature } = await keypair.signPersonalMessage(new TextEncoder().encode(message))
  return signature
}

// Sign a sponsored transaction's bytes for the /confirm step.
export async function enokiSignTransaction(txBytesBase64: string): Promise<string> {
  const keypair = await getFlow().getKeypair({ network: NETWORK })
  const { signature } = await keypair.signTransaction(fromBase64(txBytesBase64))
  return signature
}

export async function enokiLogout(): Promise<void> {
  if (flow) await flow.logout()
}
