import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

// Typed, validated client env. Import from here, never from import.meta.env directly.
export const env = createEnv({
  clientPrefix: 'VITE_',

  client: {
    VITE_API_URL: z.string().url(),
    // Demo mode: the whole app runs on an in-memory mock (no backend, no Sui, play money); a localStorage flag can override it.
    VITE_DEMO_MODE: z.enum(['true', 'false']).default('false'),
    // Soft access gate for a private test deploy: 'true' asks for VITE_ACCESS_CODE on START and remembers
    // it per-device. Not real security (the code ships in the client bundle), just keeps the public out.
    VITE_ACCESS_GUARD: z.enum(['true', 'false']).default('false'),
    VITE_ACCESS_CODE: z.string().optional(),
    // Mirrors the backend PIPS_AUTH_MODE so the UI shows the right door.
    VITE_AUTH_MODE: z.enum(['dev', 'privy']).default('dev'),
    // Chart price transport: 'true' (default) is one shared WebSocket to /ws (10Hz, all users in lock-step),
    // 'false' falls back to per-connection SSE. The client also auto-falls back to SSE if the WS can't connect.
    VITE_PRICE_WS_ENABLED: z.enum(['true', 'false']).default('true'),
    // Debug switch: force every sign-in through the full onboarding arc (handle -> skin -> welcome). Dev-only.
    VITE_ONBOARDING_DEBUG: z.enum(['true', 'false']).default('false'),
    // Mirrors backend PIPS_WALLET_AUTH_ENABLED: shows the "Connect Sui Wallet" door option, independent of VITE_AUTH_MODE.
    VITE_WALLET_CONNECT_ENABLED: z.enum(['true', 'false']).default('false'),
    VITE_SUI_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
    // Wires Privy's external MetaMask/Phantom connectors for cross-chain deposit signing. Off by default so
    // the working Google + embedded-Sui login is untouched; flip to 'true' on the mainnet deploy. The actual
    // execute gate is server-owned (/deposit/options.executeEnabled), this only enables the connect UI.
    VITE_BRIDGE_EXECUTE: z.enum(['true', 'false']).default('false'),
    VITE_SUI_FULLNODE_URL: z.string().url().optional(),
    // Public Predict ids the client needs for reads, mirrored from the backend's committed testnet deploy record; optional so the app can boot pre-deploy.
    VITE_PREDICT_PACKAGE_ID: z.string().optional(),
    VITE_PREDICT_OBJECT_ID: z.string().optional(),
    VITE_DUSDC_TYPE: z.string().optional(),
    // privy mode only: the public app id + session-signer key-quorum id the user delegates so the server signs plays without a per-spin popup.
    VITE_PRIVY_APP_ID: z.string().optional(),
    VITE_PRIVY_SESSION_SIGNER_ID: z.string().optional(),
    VITE_APP_NAME: z.string().min(1).default('PIPS'),
    VITE_APP_URL: z.string().url().optional(),
  },

  runtimeEnv: {
    VITE_API_URL: import.meta.env.VITE_API_URL,
    VITE_DEMO_MODE: import.meta.env.VITE_DEMO_MODE,
    VITE_ACCESS_GUARD: import.meta.env.VITE_ACCESS_GUARD,
    VITE_ACCESS_CODE: import.meta.env.VITE_ACCESS_CODE,
    VITE_AUTH_MODE: import.meta.env.VITE_AUTH_MODE,
    VITE_PRICE_WS_ENABLED: import.meta.env.VITE_PRICE_WS_ENABLED,
    VITE_ONBOARDING_DEBUG: import.meta.env.VITE_ONBOARDING_DEBUG,
    VITE_WALLET_CONNECT_ENABLED: import.meta.env.VITE_WALLET_CONNECT_ENABLED,
    VITE_SUI_NETWORK: import.meta.env.VITE_SUI_NETWORK,
    VITE_BRIDGE_EXECUTE: import.meta.env.VITE_BRIDGE_EXECUTE,
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
