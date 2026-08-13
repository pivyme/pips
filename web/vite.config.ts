import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

// Origin of a configured URL, or '' when it is unset/malformed (a bad value must not silently widen the policy).
const originOf = (url: string | undefined): string => {
  try {
    return new URL(url as string).origin
  } catch {
    return ''
  }
}

// Same, for a comma-separated list: every endpoint the client may reach has to be in connect-src.
const originsOf = (urls: string | undefined): string =>
  (urls ?? '')
    .split(',')
    .map((u) => originOf(u.trim()))
    .filter(Boolean)
    .join(' ')

// Content Security Policy, built at build time because the API and fullnode origins come from env.
// The base is Privy's own recommendation (docs.privy.io/security/implementation-guide/content-security-policy),
// extended with what this app actually loads: our backend over fetch + the /ws price feed, the Sui fullnode,
// and Pyth's stream in demo mode. WalletConnect entries cover VITE_BRIDGE_EXECUTE being flipped on.
//
// script-src keeps 'unsafe-inline': TanStack Start emits the hydration payload as an inline script with no
// nonce hook, so the win here is frame-ancestors, connect-src and object-src, not full XSS containment.
function contentSecurityPolicy(): string {
  const api = originOf(process.env.VITE_API_URL)
  const apiWs = api.replace(/^http/, 'ws')
  const fullnode = originsOf(process.env.VITE_SUI_FULLNODE_URL) || 'https://fullnode.testnet.sui.io https://fullnode.mainnet.sui.io'

  const privyFrames = 'https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org'
  const connect = [
    "'self'",
    api,
    apiWs,
    fullnode,
    'https://auth.privy.io',
    'https://*.rpc.privy.systems',
    'https://explorer-api.walletconnect.com',
    'wss://relay.walletconnect.com',
    'wss://relay.walletconnect.org',
    'wss://www.walletlink.org',
    'https://hermes.pyth.network',
  ].filter(Boolean)

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    // Token logos come from whatever URL the coin's metadata points at, so images stay open to https.
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    `child-src ${privyFrames}`,
    `frame-src ${privyFrames} https://challenges.cloudflare.com`,
    `connect-src ${connect.join(' ')}`,
  ].join('; ')
}

// report = send violations to the console only (the safe first deploy, and what Privy recommends);
// enforce = actually block; off = ship no policy. Everything but the CSP itself always applies.
const CSP_MODE = process.env.CSP_MODE || 'report'
const cspHeader = CSP_MODE === 'enforce' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only'

const securityHeaders: Record<string, string> = {
  ...(CSP_MODE === 'off' ? {} : { [cspHeader]: contentSecurityPolicy() }),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
}

const config = defineConfig(({ command }) => ({
  // The release stamps itself: Vercel injects the sha at build time, `dev` locally. Never hand-maintained,
  // because a stale release string blames the wrong deploy for a regression.
  define: {
    __RELEASE__: JSON.stringify((process.env.VERCEL_GIT_COMMIT_SHA || 'dev').slice(0, 7)),
  },
  // Build only: a strict policy in dev would block Vite's HMR client and eval'd module graph for no gain.
  ...(command === 'build' ? { nitro: { routeRules: { '/**': { headers: securityHeaders } } } } : {}),
  plugins: [
    nitro(),
    // this is the plugin that enables path aliases
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
}))

export default config
