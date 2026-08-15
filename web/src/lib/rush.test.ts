// AUTO is the one control in the product that spends real chips with no press behind it, so its stop
// conditions are asserted rather than trusted. The cap is the important one: a runaway AUTO is a wallet
// draining itself at one take every three seconds.

import { describe, expect, it } from 'vitest'

import { APPETITES, AUTO_MAX_TAKES, autoShouldTake, type AutoInput } from './rush'

const ready: AutoInput = { auto: true, takes: 0, hasOffer: true, busy: false, canAfford: true, armed: true }

describe('autoShouldTake', () => {
  it('takes a dealt band when everything is ready', () => {
    expect(autoShouldTake(ready)).toBe(true)
  })

  it('stops dead at the per-round cap', () => {
    expect(autoShouldTake({ ...ready, takes: AUTO_MAX_TAKES - 1 })).toBe(true)
    expect(autoShouldTake({ ...ready, takes: AUTO_MAX_TAKES })).toBe(false)
    expect(autoShouldTake({ ...ready, takes: AUTO_MAX_TAKES + 3 })).toBe(false)
  })

  it('never fires without an offer, off, mid-take, broke, or into the buzzer', () => {
    expect(autoShouldTake({ ...ready, hasOffer: false })).toBe(false)
    expect(autoShouldTake({ ...ready, auto: false })).toBe(false)
    expect(autoShouldTake({ ...ready, busy: true })).toBe(false)
    expect(autoShouldTake({ ...ready, canAfford: false })).toBe(false)
    expect(autoShouldTake({ ...ready, armed: false })).toBe(false)
  })
})

describe('the appetite ladder', () => {
  it('climbs, and never asks for less than an even-money band', () => {
    expect(APPETITES[0]).toBeGreaterThan(1)
    for (let i = 1; i < APPETITES.length; i++) expect(APPETITES[i]).toBeGreaterThan(APPETITES[i - 1])
  })
})
