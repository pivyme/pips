// @vitest-environment jsdom
// The track() contract (§13 rule 11, Addendum A6 item 5). Three claims, and all three are the kind that
// only hold if something asserts them:
//
//   1. it cannot throw. A malformed prop, a circular object, an unknown name, a dead network: all no-op.
//   2. it cannot grow. 500 calls leave 200 queued, and the ones dropped are the OLDEST. We already crashed
//      an iOS tab at 514MB once, and analytics is not going to be the cause of the second time.
//   3. it cannot break itself over crypto. No crypto.subtle still queues, and still flushes as plaintext.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EVENT_NAMES, flushTrack, queuedCount, queuedPayloads, resetTrackState, sealedCount, track } from './track'

const originalFetch = globalThis.fetch
const realSubtle = globalThis.crypto.subtle

function mockFetch(): void {
  globalThis.fetch = vi.fn((url: unknown) =>
    String(url).endsWith('/a/hello')
      ? Promise.resolve(new Response(JSON.stringify({ data: { sid: 'AAAAAAAAAAAAAAAAAAAAAA', key: btoa('k'.repeat(32)) } }), { status: 200 }))
      : Promise.resolve(new Response('{}', { status: 202 })),
  ) as unknown as typeof fetch
}

const fetchCalls = (): unknown[][] => (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls

beforeEach(() => {
  resetTrackState()
  localStorage.clear()
  mockFetch()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.defineProperty(globalThis.crypto, 'subtle', { value: realSubtle, configurable: true })
  vi.restoreAllMocks()
})

// Waits for the per-event seal microtasks to settle. Sealing is deliberately off the call path, so
// everything after track() has to give it a turn. Polls the seam rather than yielding once: crypto.subtle
// is genuinely async, and a single macrotask tick loses the race under parallel test load.
const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 1))
    if (queuedCount() === 0 || sealedCount() === queuedCount()) return
  }
}

describe('returns void and never throws', () => {
  it('no-ops on an unknown name instead of queueing an unbounded label', () => {
    // @ts-expect-error deliberately off-catalog: the compile error IS the first line of defence
    expect(track('game.totally_made_up')).toBeUndefined()
    expect(queuedCount()).toBe(0)
  })

  it('survives a circular object, a symbol, a function, and a non-finite number in props', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular

    const bad = [
      { nested: circular },
      { fn: () => 1 },
      { sym: Symbol('x') },
      { n: Number.NaN },
      { n: Number.POSITIVE_INFINITY },
      { 'Bad Key!': 'x' },
      { ['k'.repeat(80)]: 'x' },
    ]
    for (const props of bad) {
      expect(track('hub.view', props as never)).toBeUndefined()
    }

    // Every call queued the event and dropped only the offending prop, so a bad call site loses a prop
    // rather than an event.
    expect(queuedCount()).toBe(bad.length)
    for (const json of queuedPayloads()) {
      const parsed = JSON.parse(json) as { name: string; props?: Record<string, unknown> }
      expect(parsed.name).toBe('hub.view')
      expect(parsed.props?.nested).toBeUndefined()
      expect(parsed.props?.fn).toBeUndefined()
      expect(parsed.props?.n).toBeUndefined()
    }
  })

  it('keeps the valid props alongside the dropped ones', () => {
    track('game.play_tap', { game: 'lucky', stake: 2, tier: null, bad: Number.NaN })
    const parsed = JSON.parse(queuedPayloads()[0]) as { props: Record<string, unknown> }
    expect(parsed.props).toEqual({ game: 'lucky', stake: 2, tier: null })
  })

  it('swallows a rejected flush rather than surfacing it', async () => {
    track('hub.view')
    await settle()
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('offline'))) as unknown as typeof fetch
    expect(() => flushTrack()).not.toThrow()
  })

  it('truncates a 300-char string prop to 200 rather than sending it whole', () => {
    track('menu.section', { section: 'x'.repeat(300) })
    const parsed = JSON.parse(queuedPayloads()[0]) as { props: { section: string } }
    expect(parsed.props.section).toHaveLength(200)
  })
})

describe('the queue cannot grow', () => {
  it('caps 500 rapid calls at exactly 200, dropping the oldest', () => {
    for (let i = 0; i < 500; i++) track('hub.view', { section: `call_${i}` })

    expect(queuedCount()).toBe(200)

    const sections = queuedPayloads().map((j) => (JSON.parse(j) as { props: { section: string } }).props.section)
    // The survivors are the NEWEST 200. Dropping the newest would mean losing the events around a crash,
    // which are the only interesting ones.
    expect(sections[0]).toBe('call_300')
    expect(sections[sections.length - 1]).toBe('call_499')
  })

  it('does not retry a flushed batch, so a failed send costs those events and nothing else', async () => {
    for (let i = 0; i < 20; i++) track('hub.view')
    await settle()
    const before = queuedCount()
    flushTrack()
    expect(queuedCount()).toBeLessThan(before)
    flushTrack()
    // No queue growth, no second send of the same bytes.
    expect(fetchCalls().filter((c) => String(c[0]).endsWith('/a/e')).length).toBeLessThanOrEqual(2)
  })
})

describe('crypto', () => {
  it('seals each event at queue time, so a flush sends opaque bytes', async () => {
    track('game.play_tap', { game: 'lucky' })
    await settle()
    flushTrack()

    const send = fetchCalls().find((c) => String(c[0]).endsWith('/a/e'))
    expect(send).toBeDefined()
    const init = send![1] as { body: Uint8Array; headers: Record<string, string> }
    expect(init.headers['Content-Type']).toBe('application/octet-stream')
    // Version byte 1 sits behind the 2-byte length prefix, and the name is nowhere in the bytes.
    expect(init.body[2]).toBe(1)
    expect(new TextDecoder().decode(init.body)).not.toContain('game.play_tap')
  })

  it('still queues and flushes as version-byte 0 plaintext with no crypto.subtle', async () => {
    Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true })

    track('game.play_tap', { game: 'lucky' })
    expect(queuedCount()).toBe(1)
    await settle()
    flushTrack()

    const send = fetchCalls().find((c) => String(c[0]).endsWith('/a/e'))
    expect(send).toBeDefined()
    const body = (send![1] as { body: Uint8Array }).body
    expect(body[2]).toBe(0)
    // Legible on the wire, which is the accepted cost of never breaking analytics over crypto.
    expect(new TextDecoder().decode(body)).toContain('game.play_tap')
  })

  it('falls back to plaintext when the handshake itself fails', async () => {
    globalThis.fetch = vi.fn((url: unknown) =>
      String(url).endsWith('/a/hello') ? Promise.reject(new Error('offline')) : Promise.resolve(new Response('{}', { status: 202 })),
    ) as unknown as typeof fetch

    track('hub.view')
    await settle()
    expect(() => flushTrack()).not.toThrow()
    const send = fetchCalls().find((c) => String(c[0]).endsWith('/a/e'))
    expect((send![1] as { body: Uint8Array }).body[2]).toBe(0)
  })
})

describe('identity', () => {
  it('reuses one anonId across events so the pre-auth funnel joins to the user after login', () => {
    track('door.landing_view')
    track('door.auth_ok')
    const ids = queuedPayloads().map((j) => (JSON.parse(j) as { anonId: string }).anonId)
    expect(ids[0]).toBe(ids[1])
    expect(localStorage.getItem('pips_anon')).toBe(ids[0])
  })
})

// Demo is entered by a landing toggle that writes localStorage, not by rebuilding with an env var, so an
// env-only check leaves every demo session posting fake plays into the real Event table and 401ing in the
// console on the way. The gate has to read the same seam api.ts does.
describe('demo mode', () => {
  it('queues nothing and touches no network once the demo override is set', async () => {
    localStorage.setItem('pips_demo', '1')
    track('door.landing_view')
    track('game.play_tap', { game: 'lucky' })
    await settle()
    flushTrack()
    expect(queuedCount()).toBe(0)
    expect(fetchCalls()).toHaveLength(0)
  })

  it('reports errors again once demo is switched back off', async () => {
    localStorage.setItem('pips_demo', '0')
    track('door.landing_view')
    await settle()
    expect(queuedCount()).toBe(1)
  })
})

describe('the catalog', () => {
  it('has no duplicates, and every name is namespaced', () => {
    expect(new Set(EVENT_NAMES).size).toBe(EVENT_NAMES.length)
    for (const name of EVENT_NAMES) expect(name).toMatch(/^[a-z]+\.[a-z0-9_]+$/)
  })
})
