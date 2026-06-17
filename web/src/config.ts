// App-level brand and links. Sui package/object IDs live in src/lib/sui/config.ts
// (read from env, never inlined), per the monorepo rule.

export const config = {
  appName: 'Pips',
  tagline: 'Trading, but a game.',
  description:
    'The simplest, most fun way to trade. A gamified trading console on Sui, powered by DeepBook Predict.',

  links: {
    twitter: '',
    github: 'https://github.com/kelvinkn17/pips',
    docs: 'https://docs.sui.io/onchain-finance/deepbook-predict/',
  },
} as const

export type Config = typeof config
