import { describe, expect, it } from 'vitest'

import { mergeSnapshotMarket, type LivePlaySnapshot } from './useGameRound'
import type { PlayDTO } from '@/lib/api'

// A minimal open binary play, the shape the games hold after placePlay returns.
const basePlay = (): PlayDTO => ({
  id: 'p1',
  game: 'lucky',
  status: 'pending',
  stake: '10.00',
  params: { asset: 'BTC', side: 'up', multiplier: 3, duration: 15 },
  market: { asset: 'BTC', oracleId: 'o1', expiry: 1000, strike: '67000', lower: undefined, upper: undefined },
  entryValue: '10.00',
  markValue: '10.00',
  pnl: '0.00',
  multiplier: 3,
  maxPayout: '30.00',
  entrySpot: '66950',
})

const snap = (over: Partial<LivePlaySnapshot>): LivePlaySnapshot => ({
  markValue: '10.00',
  pnl: '0.00',
  multiplier: 3,
  status: 'open',
  ...over,
})

describe('mergeSnapshotMarket', () => {
  it('returns the SAME reference when the market is unchanged (no wasted render)', () => {
    const play = basePlay()
    const out = mergeSnapshotMarket(play, snap({ strike: '67000', entrySpot: '66950', expiry: 1000 }))
    expect(out).toBe(play) // identity: React bails out of the setState
  })

  it('is a no-op when the snapshot omits market fields (demo tick / P/L-only frame)', () => {
    const play = basePlay()
    const out = mergeSnapshotMarket(play, snap({})) // strike/entrySpot/expiry all undefined
    expect(out).toBe(play)
  })

  it('snaps the strike + entry on a mid-flight restrike (binary admission-abort fallback)', () => {
    const play = basePlay()
    const out = mergeSnapshotMarket(play, snap({ strike: '66500', entrySpot: '66480' }))
    expect(out).not.toBe(play)
    expect(out.market.strike).toBe('66500')
    expect(out.entrySpot).toBe('66480')
    expect(play.market.strike).toBe('67000') // original not mutated
  })

  it('snaps the expiry on a re-route so the countdown re-anchors', () => {
    const play = basePlay()
    const out = mergeSnapshotMarket(play, snap({ expiry: 2000 }))
    expect(out.market.expiry).toBe(2000)
    expect(out.market.strike).toBe('67000') // untouched field preserved
  })

  it('snaps a range band (lower/upper) on re-route', () => {
    const play: PlayDTO = {
      ...basePlay(),
      game: 'range',
      params: { asset: 'BTC', lower: '66000', upper: '68000', widthPct: 0.1, duration: 30 },
      market: { asset: 'BTC', oracleId: 'o1', expiry: 1000, lower: '66000', upper: '68000' },
    }
    const out = mergeSnapshotMarket(play, snap({ lower: '66100', upper: '68100' }))
    expect(out.market.lower).toBe('66100')
    expect(out.market.upper).toBe('68100')
  })
})
