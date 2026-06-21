// App-level brand and links. Sui package/object IDs live in src/lib/sui/config.ts
// (read from env, never inlined), per the monorepo rule.

export const config = {
  appName: 'PIPS',
  tagline: 'Built for fun and money.',
  description:
    'The simplest, most fun way to trade. A gamified trading console on Sui, powered by DeepBook Predict.',

  links: {
    twitter: '',
    github: 'https://github.com/kelvinkn17/pips',
    docs: 'https://docs.sui.io/onchain-finance/deepbook-predict/',
    // Direct line for reviewers/judges when something breaks mid-demo.
    support: 'https://t.me/KelvinAdithya',
  },
} as const

export type Config = typeof config
