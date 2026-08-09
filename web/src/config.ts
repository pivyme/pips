// App-level brand and links. Sui package/object IDs live in src/lib/sui/config.ts
// (read from env, never inlined), per the monorepo rule.

// Canonical prod origin. Only for places with no runtime origin to read (SSR meta tags), never as the
// base of a link the user copies, that follows the browser's own origin. See lib/referral.ts.
export const SITE_URL = 'https://playpips.fun'

export const config = {
  appName: 'PIPS',
  tagline: 'Built for fun and money.',
  description:
    'The simplest, most fun way to trade. A gamified trading console on Sui, powered by DeepBook Predict.',

  links: {
    twitter: 'https://x.com/PlayPipsFun',
    github: 'https://github.com/kelvinkn17/pips',
    docs: 'https://blog.sui.io/introducing-deepbook-predict/',
    // Direct line for reviewers/judges when something breaks mid-demo.
    support: 'https://t.me/KelvinAdithya',
    pivy: 'https://pivy.me',
  },
} as const

export type Config = typeof config
