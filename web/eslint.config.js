//  @ts-check

import { tanstackConfig } from '@tanstack/eslint-config'

export default [
  ...tanstackConfig,
  {
    // Editor squiggles only. This package's lint baseline is red and nobody runs it, so the real
    // enforcement of the admin import rule is `bun run check:admin`, which sits in the gate (L-020).
    files: ['src/admin/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['three', '@react-three/*', 'gsap', 'motion', 'framer-motion', '@heroui/*'], message: 'src/admin/ must not pull the device shell into its chunk.' },
            { group: ['@/components/console/*', '@/components/game/*', '@/ui/*'], message: 'src/admin/ has its own component language; see admin.css.' },
          ],
        },
      ],
    },
  },
]
