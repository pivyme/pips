import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

// Typed, validated client env. Import from here, never from import.meta.env directly.
export const env = createEnv({
  clientPrefix: 'VITE_',

  client: {
    VITE_API_URL: z.string().url(),
    // Mirrors the backend PIPS_AUTH_MODE so the UI shows the right door.
    VITE_AUTH_MODE: z.enum(['dev', 'enoki']).default('dev'),
    VITE_SUI_NETWORK: z.enum(['testnet', 'mainnet', 'devnet']).default('testnet'),
    VITE_SUI_FULLNODE_URL: z.string().url().optional(),
    // enoki mode only: public Enoki key + Google OAuth client id.
    VITE_ENOKI_API_KEY: z.string().optional(),
    VITE_GOOGLE_CLIENT_ID: z.string().optional(),
    VITE_APP_NAME: z.string().min(1).default('Pips'),
    VITE_APP_URL: z.string().url().optional(),
  },

  runtimeEnv: {
    VITE_API_URL: import.meta.env.VITE_API_URL,
    VITE_AUTH_MODE: import.meta.env.VITE_AUTH_MODE,
    VITE_SUI_NETWORK: import.meta.env.VITE_SUI_NETWORK,
    VITE_SUI_FULLNODE_URL: import.meta.env.VITE_SUI_FULLNODE_URL,
    VITE_ENOKI_API_KEY: import.meta.env.VITE_ENOKI_API_KEY,
    VITE_GOOGLE_CLIENT_ID: import.meta.env.VITE_GOOGLE_CLIENT_ID,
    VITE_APP_NAME: import.meta.env.VITE_APP_NAME,
    VITE_APP_URL: import.meta.env.VITE_APP_URL,
  },

  // Treat empty strings as unset so optionals/defaults behave.
  emptyStringAsUndefined: true,
})
