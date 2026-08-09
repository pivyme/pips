// @vitest-environment jsdom
// A wrong invite link fails silently: it copies fine, reads fine, and lands nowhere. Production shipped
// `http://localhost:3200/@user` for exactly that reason, because a build-time env var outranked the
// origin the user was standing on. These pin the precedence so it cannot come back.

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/env', () => ({ env: { VITE_APP_URL: 'http://localhost:3200' } }))

import { buildReferralLink, shareHost, shareOrigin } from './referral'

const setOrigin = (origin: string) => {
  Object.defineProperty(window, 'location', { value: new URL(origin), configurable: true })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('shareOrigin', () => {
  it('follows the browser origin, even when VITE_APP_URL says localhost', () => {
    setOrigin('http://192.168.1.20:3200')
    expect(shareOrigin()).toBe('http://192.168.1.20:3200')
    expect(shareHost()).toBe('192.168.1.20:3200')
  })

  it('drops a www host so invites read as the bare branded domain', () => {
    setOrigin('https://www.playpips.fun')
    expect(shareOrigin()).toBe('https://playpips.fun')
    expect(shareHost()).toBe('playpips.fun')
    expect(buildReferralLink({ code: 'a7k2qx', anon: false, username: 'kelvin' })).toBe(
      'https://playpips.fun/@kelvin',
    )
  })

  it('falls back to the env / canonical domain when there is no window (SSR)', () => {
    vi.stubGlobal('window', undefined)
    expect(shareOrigin()).toBe('http://localhost:3200')
  })
})

describe('buildReferralLink', () => {
  it('uses the @username format on the live domain', () => {
    setOrigin('https://playpips.fun')
    expect(buildReferralLink({ code: 'a7k2qx', anon: false, username: 'kelvin' })).toBe(
      'https://playpips.fun/@kelvin',
    )
  })

  it('falls back to the anon code when anonymous or username-less', () => {
    setOrigin('https://playpips.fun')
    expect(buildReferralLink({ code: 'a7k2qx', anon: true, username: 'kelvin' })).toBe(
      'https://playpips.fun/r/a7k2qx',
    )
    expect(buildReferralLink({ code: 'a7k2qx', anon: false, username: null })).toBe(
      'https://playpips.fun/r/a7k2qx',
    )
  })
})
