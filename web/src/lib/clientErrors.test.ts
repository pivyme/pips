// @vitest-environment jsdom
// The per-session dedupe is the whole point of this file: a render loop can throw thousands of times a
// second, and without it the first bad deploy floods the ingest endpoint and the error table.
//
// The other half is that capturing an error must never become the error, so every hook is asserted to
// swallow rather than rethrow.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clientFingerprint, installClientErrorHooks, reportClientError, reportedCount, resetClientErrorState } from './clientErrors'

const originalFetch = globalThis.fetch

beforeEach(() => {
  resetClientErrorState()
  globalThis.fetch = vi.fn(() => Promise.resolve(new Response('{}', { status: 202 }))) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

const calls = () => (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length

describe('per-session dedupe', () => {
  it('sends the first occurrence and suppresses every repeat of the same fingerprint', () => {
    const err = new Error('Cannot read properties of undefined (reading map)')
    expect(reportClientError(err)).toBe(true)
    for (let i = 0; i < 500; i++) reportClientError(new Error('Cannot read properties of undefined (reading map)'))

    expect(calls()).toBe(1)
    expect(reportedCount()).toBe(1)
  })

  it('still reports a genuinely different error', () => {
    expect(reportClientError(new Error('first failure'))).toBe(true)
    expect(reportClientError(new Error('a completely different failure'))).toBe(true)
    expect(calls()).toBe(2)
  })

  it('collapses the same bug carrying different ids, amounts, and addresses', () => {
    // One throw site, two payloads: this is the shape a real loop takes, where the values change and the
    // frame does not.
    const throwOnce = (playId: string, addr: string, amount: number) =>
      reportClientError(new Error(`play ${playId} failed for ${addr} with ${amount}`))

    expect(throwOnce('clzt1a2b3c4d5e6f7g8h9i0j', '0xdeadbeefcafe', 1_500_000)).toBe(true)
    expect(throwOnce('clqq9z8y7x6w5v4u3t2s1r0q', '0xfeedface9876', 2_750_000)).toBe(false)
    expect(calls()).toBe(1)
  })

  it('caps the session at 20 distinct fingerprints, so even varied garbage cannot flood', () => {
    for (let i = 0; i < 100; i++) reportClientError(new Error(`distinct failure kind ${String.fromCharCode(97 + (i % 26))}${i}x`))
    expect(reportedCount()).toBeLessThanOrEqual(20)
    expect(calls()).toBeLessThanOrEqual(20)
  })
})

describe('fingerprinting', () => {
  it('normalizes hex, cuids, uuids, and long numbers, and keeps different messages apart', () => {
    const stack = 'Error\n    at play (https://playpips.fun/assets/lucky-abc.js:1:200)'
    const same = (a: string, b: string) => expect(clientFingerprint(a, stack)).toBe(clientFingerprint(b, stack))

    same('boom 0xaabbccddeeff at 1234567', 'boom 0x112233445566 at 7654321')
    same('play clzt1a2b3c4d5e6f7g8h9i0j', 'play clqq9z8y7x6w5v4u3t2s1r0q')
    same('session 3f2504e0-4f89-11d3-9a0c-0305e82c3301 gone', 'session 9c858901-8a57-4791-81fe-4c455b099bc9 gone')

    expect(clientFingerprint('boom a', stack)).not.toBe(clientFingerprint('boom b', stack))
  })

  it('keeps the same message thrown from different code apart', () => {
    const a = 'Error\n    at lucky (https://playpips.fun/assets/lucky-abc.js:1:200)'
    const b = 'Error\n    at range (https://playpips.fun/assets/range-def.js:9:12)'
    expect(clientFingerprint('render failed', a)).not.toBe(clientFingerprint('render failed', b))
  })
})

describe('never throws into the app', () => {
  it('swallows a rejected transport instead of surfacing it', () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('offline'))) as unknown as typeof fetch
    expect(() => reportClientError(new Error('boom'))).not.toThrow()
  })

  it('handles a thrown non-Error, including null, undefined, and a circular object', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    for (const thrown of [null, undefined, 42, 'a string', circular, Symbol('x')]) {
      expect(() => reportClientError(thrown)).not.toThrow()
    }
  })

  it('installs the global hooks once and lets an error event through without rethrowing', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    installClientErrorHooks()
    installClientErrorHooks()
    const kinds = addSpy.mock.calls.map((c) => c[0])
    expect(kinds.filter((k) => k === 'error')).toHaveLength(1)
    expect(kinds.filter((k) => k === 'unhandledrejection')).toHaveLength(1)

    // The real listener runs here. If it rethrew, dispatchEvent would surface it.
    expect(() => window.dispatchEvent(new ErrorEvent('error', { message: 'window level boom', error: new Error('window level boom') }))).not.toThrow()
    expect(calls()).toBe(1)
  })

  it('does not preventDefault, so the browser console and other listeners still see the error', () => {
    installClientErrorHooks()
    const event = new ErrorEvent('error', { message: 'visible boom', error: new Error('visible boom'), cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})
