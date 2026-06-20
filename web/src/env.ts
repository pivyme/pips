import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

// Typed, validated client env. Import from here, never from import.meta.env directly.
export const env = createEnv({
  clientPrefix: 'VITE_',

  client: {
    VITE_API_URL: z.string().url(),
    // Demo mode: the whole app runs on an in-memory mock (no backend, no Sui, play money).
    // Lets anyone poke at the full UI with zero setup. A localStorage flag can override it.
    VITE_DEMO_MODE: z.enum(['true', 'false']).default('false'),
    // Mirrors the backend PIPS_AUTH_MODE so the UI shows the right door.
    VITE_AUTH_MODE: z.enum(['dev', 'privy']).default('dev'),
    // Debug switch: force every sign-in (and reload) through the full onboarding arc
    // (handle -> skin -> welcome), even when the account already has a username. Dev-only.
    VITE_ONBOARDING_DEBUG: z.enum(['true', 'false']).default('false'),
    // Mirrors the backend PIPS_WALLET_AUTH_ENABLED: show the "Connect Sui Wallet" door option
    // (custodial play-wallet login), alongside Privy social. Independent of VITE_AUTH_MODE.
    VITE_WALLET_CONNECT_ENABLED: z.enum(['true', 'false']).default('false'),
    VITE_SUI_NETWORK: z.enum(['testnet', 'mainnet', 'devnet', 'localnet']).default('testnet'),
    VITE_SUI_FULLNODE_URL: z.string().url().optional(),
    // Public Predict ids the client needs for reads. Written by the bootstrap into
    // web/.env (mirrors backend deployed.json). Optional so the app can boot pre-deploy.
    VITE_PREDICT_PACKAGE_ID: z.string().optional(),
    VITE_PREDICT_OBJECT_ID: z.string().optional(),
    VITE_DUSDC_TYPE: z.string().optional(),
    // privy mode only: the public Privy app id, and the session-signer key-quorum id the user
    // delegates to so the server can sign plays without a per-spin popup.
    VITE_PRIVY_APP_ID: z.string().optional(),
    VITE_PRIVY_SESSION_SIGNER_ID: z.string().optional(),
    VITE_APP_NAME: z.string().min(1).default('Pips'),
    VITE_APP_URL: z.string().url().optional(),
  },

  runtimeEnv: {
    VITE_API_URL: import.meta.env.VITE_API_URL,
    VITE_DEMO_MODE: import.meta.env.VITE_DEMO_MODE,
    VITE_AUTH_MODE: import.meta.env.VITE_AUTH_MODE,
    VITE_ONBOARDING_DEBUG: import.meta.env.VITE_ONBOARDING_DEBUG,
    VITE_WALLET_CONNECT_ENABLED: import.meta.env.VITE_WALLET_CONNECT_ENABLED,
    VITE_SUI_NETWORK: import.meta.env.VITE_SUI_NETWORK,
    VITE_SUI_FULLNODE_URL: import.meta.env.VITE_SUI_FULLNODE_URL,
    VITE_PREDICT_PACKAGE_ID: import.meta.env.VITE_PREDICT_PACKAGE_ID,
    VITE_PREDICT_OBJECT_ID: import.meta.env.VITE_PREDICT_OBJECT_ID,
    VITE_DUSDC_TYPE: import.meta.env.VITE_DUSDC_TYPE,
    VITE_PRIVY_APP_ID: import.meta.env.VITE_PRIVY_APP_ID,
    VITE_PRIVY_SESSION_SIGNER_ID: import.meta.env.VITE_PRIVY_SESSION_SIGNER_ID,
    VITE_APP_NAME: import.meta.env.VITE_APP_NAME,
    VITE_APP_URL: import.meta.env.VITE_APP_URL,
  },

  // Treat empty strings as unset so optionals/defaults behave.
  emptyStringAsUndefined: true,
})
