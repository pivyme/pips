import { describe, expect, it } from 'bun:test';

import { probit, breakoutProbs, BREAKOUT_LEG_PROBS, binaryOffsetFrac, binaryOffsetFloored, otmStrike1e9, restrikeCloser, snipeWall, SNIPE_MAX_WALL_SIGMA, pressBand, parseStake, maxStakeFor, type ResolvedReal } from './games.ts';
import { LEVERAGE_ONE, ticksForBinary, ticksForRange } from '../lib/sui/predict-real.ts';
import type { Side } from '../types/api.ts';
import { REAL_STRIKE_MIN_PROB, REAL_STRIKE_MAX_OFFSET_FRAC, REAL_BTC_ANNUAL_VOL, REAL_BINARY_MIN_OFFSET_SIGMA, MIN_STAKE, MAX_STAKE, MAX_STAKE_ADMIN } from '../config/main-config.ts';

// The real-mode strike sizer can't be exercised on-chain (needs a funded wrapper, L-012), so the math it
// rests on is pinned here: binaryOffsetFrac places a strike at z(p)*sigma off spot so entry probability lands inside the chain's (unreadable) admission band, instead of the fixed strike that always aborts on a 20-60s market.

// Acklam's inverse-normal-CDF approximation against textbook quantiles (abs error < 1.2e-9).
describe('probit', () => {
  it('matches standard-normal quantiles', () => {
    expect(probit(0.5)).toBeCloseTo(0, 6);
    expect(probit(0.975)).toBeCloseTo(1.959964, 4);
    expect(probit(0.95)).toBeCloseTo(1.644854, 4);
    expect(probit(0.84134)).toBeCloseTo(1.0, 3); // 1 sigma
    expect(probit(0.06)).toBeCloseTo(-1.554774, 4);
  });

  it('is antisymmetric about 0.5', () => {
    for (const p of [0.01, 0.1, 0.3]) expect(probit(p)).toBeCloseTo(-probit(1 - p), 6);
  });
});

describe('binaryOffsetFrac (real strike sizing)', () => {
  const SECS = 20; // a live 1m/1s BTC round is tens of seconds out

  it('sits at ATM for a coin-flip strike (strikeTier 2 -> p 0.5)', () => {
    expect(binaryOffsetFrac(2, SECS)).toBeCloseTo(0, 9);
  });

  it('goes in-the-money (offset < 0) for a low strike tier, out for a high one', () => {
    expect(binaryOffsetFrac(1.33, SECS)).toBeLessThan(0); // p ~0.75, ITM
    expect(binaryOffsetFrac(5, SECS)).toBeGreaterThan(0); // p ~0.20, OTM
  });

  it('is monotonically increasing in strike tier (further OTM = lower win odds)', () => {
    const tiers = [1.33, 1.67, 2.5, 5, 10, 25];
    const offs = tiers.map((t) => binaryOffsetFrac(t, SECS));
    for (let i = 1; i < offs.length; i++) expect(offs[i]).toBeGreaterThanOrEqual(offs[i - 1]);
  });

  it('floors the target probability so a huge tier never lands past the admissible band', () => {
    // p is clamped to >= REAL_STRIKE_MIN_PROB, so the offset saturates rather than running to +inf.
    const capOff = binaryOffsetFrac(1e6, SECS);
    const flooredOff = probitApproxOff(REAL_STRIKE_MIN_PROB, SECS);
    expect(capOff).toBeCloseTo(flooredOff, 9);
  });

  it('respects the absolute guard cap when volatility runs hot', () => {
    // A full-year horizon makes sigma huge; the offset must clamp to the guard band on both sides.
    const YEAR = 365.25 * 24 * 3600;
    expect(binaryOffsetFrac(10, YEAR)).toBeCloseTo(REAL_STRIKE_MAX_OFFSET_FRAC, 9);
    expect(binaryOffsetFrac(1.05, YEAR)).toBeCloseTo(-REAL_STRIKE_MAX_OFFSET_FRAC, 9);
  });
});

// The 2x tier prices ATM (raw offset 0), so its target would hug the entry line even after snapping to the
// grid ($1 away). The floor lifts it to a visible directional move while staying sigma-scaled/admissible (L-013).
describe('binaryOffsetFloored (2x tier is a visible move, not ATM)', () => {
  const SECS = 25;
  const sigma = REAL_BTC_ANNUAL_VOL * Math.sqrt(SECS / (365.25 * 24 * 3600));

  it('lifts the ATM 2x tier to the sigma-scaled minimum offset', () => {
    expect(binaryOffsetFrac(2, SECS)).toBeCloseTo(0, 9); // raw 2x is a coin-flip, ATM
    expect(binaryOffsetFloored(2, SECS)).toBeCloseTo(REAL_BINARY_MIN_OFFSET_SIGMA * sigma, 9);
    expect(binaryOffsetFloored(2, SECS)).toBeGreaterThan(binaryOffsetFrac(2, SECS));
  });

  it('leaves a high tier that already clears the floor untouched', () => {
    expect(binaryOffsetFloored(10, SECS)).toBeCloseTo(binaryOffsetFrac(10, SECS), 9);
  });
});

// The 2x floor prices at p=0.5 (offset 0), so the strike snapper must move it off the entry line, else
// ENTRY == TARGET (the reported bug). Pinned here since the snap can't be exercised on-chain (L-012).
describe('otmStrike1e9 (binary strike never lands on the entry line)', () => {
  const ADM = 1_000_000_000n; // BTC admission step = $1 (1e9-scaled)
  const spot = 64_196_870_000_000n; // $64,196.87, between admission boundaries

  it('pushes a coin-flip (2x, raw offset 0) strike one admission step OTM, not onto entry', () => {
    expect(otmStrike1e9('up', spot, spot, ADM)).toBe(64_197_000_000_000n); // first $1 boundary above
    expect(otmStrike1e9('down', spot, spot, ADM)).toBe(64_196_000_000_000n); // first $1 boundary below
    expect(otmStrike1e9('up', spot, spot, ADM)).toBeGreaterThan(spot);
    expect(otmStrike1e9('down', spot, spot, ADM)).toBeLessThan(spot);
  });

  it('snaps a real offset onto the admission grid on the OTM side (up ceils, down floors)', () => {
    expect(otmStrike1e9('up', 64_207_700_000_000n, spot, ADM)).toBe(64_208_000_000_000n);
    expect(otmStrike1e9('down', 64_186_300_000_000n, spot, ADM)).toBe(64_186_000_000_000n);
  });

  it('stays strictly OTM even when spot sits exactly on an admission boundary', () => {
    const onGrid = 64_196_000_000_000n; // $64,196.00
    expect(otmStrike1e9('up', onGrid, onGrid, ADM)).toBe(64_197_000_000_000n);
    expect(otmStrike1e9('down', onGrid, onGrid, ADM)).toBe(64_195_000_000_000n);
  });

  it('steps an extra boundary out when the strike would round onto the 2dp entry line', () => {
    const nearUp = 64_196_997_000_000n; // $64,196.997 -> rounds to 64,197.00, same as the first boundary above
    expect(otmStrike1e9('up', nearUp, nearUp, ADM)).toBe(64_198_000_000_000n);
    const nearDown = 64_196_003_000_000n; // $64,196.003 -> rounds to 64,196.00, same as the first boundary below
    expect(otmStrike1e9('down', nearDown, nearDown, ADM)).toBe(64_195_000_000_000n);
  });
});

// The offset at a given target probability (mirrors binaryOffsetFrac's core, for the floor assertion).
function probitApproxOff(p: number, seconds: number): number {
  const sigma = REAL_BTC_ANNUAL_VOL * Math.sqrt(seconds / (365.25 * 24 * 3600));
  return probit(1 - p) * sigma;
}

// The admission fallback used to drop leverage and re-derive the strike from the nominal tier, which pushed
// it FURTHER out of the money and through the chain's 1% min_entry_probability floor, turning a recoverable
// ELeverageAboveAdmissionCap into a dead play. It must move toward spot, and it must terminate.
describe('restrikeCloser (admission fallback)', () => {
  const SPOT = 65_000_000_000_000n; // $65,000 at 1e9
  const ADMISSION_TICK = 1_000_000_000n; // $1
  const TICK = 10_000_000n; // $0.01

  const binary = (side: Side, strike1e9: bigint): ResolvedReal => ({
    game: 'moonshot',
    kind: 'binary',
    marketId: '0x1',
    asset: 'BTC',
    spot1e9: SPOT,
    tickSize: TICK,
    admissionTickSize: ADMISSION_TICK,
    ...ticksForBinary(side, strike1e9, TICK, ADMISSION_TICK),
    leverage1e9: 3_000_000_000n,
    amountRaw: 4_400_000n,
    minQuantityRaw: 10_000n,
    expiryMs: Date.now() + 20_000,
    duration: 20,
    entrySpot: '65000',
    tierMultiplier: 10,
    side,
    strike1e9,
    strikeDisplay: String(Number(strike1e9) / 1e9),
  });

  it('moves an up strike toward spot, never further out', () => {
    const next = restrikeCloser(binary('up', SPOT + 64_000_000_000n), LEVERAGE_ONE);
    expect(next).not.toBeNull();
    expect(next!.strike1e9!).toBeLessThan(SPOT + 64_000_000_000n);
    expect(next!.strike1e9!).toBeGreaterThan(SPOT);
    expect(next!.leverage1e9).toBe(LEVERAGE_ONE);
  });

  it('moves a down strike toward spot, never further out', () => {
    const next = restrikeCloser(binary('down', SPOT - 64_000_000_000n), LEVERAGE_ONE);
    expect(next).not.toBeNull();
    expect(next!.strike1e9!).toBeGreaterThan(SPOT - 64_000_000_000n);
    expect(next!.strike1e9!).toBeLessThan(SPOT);
  });

  it('terminates: repeated fallbacks converge on the closest boundary, then return null', () => {
    let cur: ResolvedReal | null = binary('up', SPOT + 64_000_000_000n);
    let steps = 0;
    while (cur && steps < 50) {
      const next: ResolvedReal | null = restrikeCloser(cur, LEVERAGE_ONE);
      if (!next) break;
      expect(next.strike1e9!).toBeLessThan(cur.strike1e9!); // strictly monotone toward spot
      cur = next;
      steps++;
    }
    expect(steps).toBeLessThan(50); // converged rather than looping forever
    expect(restrikeCloser(cur!, LEVERAGE_ONE)).toBeNull(); // already on the closest boundary
  });

  it('keeps the strike at least one admission step clear of spot', () => {
    let cur = binary('up', SPOT + 64_000_000_000n);
    for (let i = 0; i < 20; i++) {
      const next = restrikeCloser(cur, LEVERAGE_ONE);
      if (!next) break;
      cur = next;
    }
    expect(cur.strike1e9! - SPOT).toBeGreaterThanOrEqual(ADMISSION_TICK);
  });

  // A band had no fallback at all: it re-minted the identical ticks, burned the retry and died with the play
  // in error. PIN plants its band off spot, so there is somewhere to move. RANGE centres on spot, so it must
  // stay exactly as it was.
  const band = (centre1e9: bigint, half1e9: bigint, game: 'pin' | 'range'): ResolvedReal => ({
    game,
    kind: 'range',
    marketId: '0x1',
    asset: 'BTC',
    spot1e9: SPOT,
    tickSize: TICK,
    admissionTickSize: ADMISSION_TICK,
    ...ticksForRange(centre1e9 - half1e9, centre1e9 + half1e9, TICK, ADMISSION_TICK),
    leverage1e9: LEVERAGE_ONE,
    amountRaw: 1_320_000n,
    minQuantityRaw: 10_000n,
    expiryMs: Date.now() + 20_000,
    duration: 20,
    entrySpot: '65000',
    tierMultiplier: 8,
    lowerDisplay: String(Number(centre1e9 - half1e9) / 1e9),
    upperDisplay: String(Number(centre1e9 + half1e9) / 1e9),
    ...(game === 'pin' ? { strikeDisplay: String(Number(centre1e9) / 1e9) } : {}),
  });

  const centreOf = (r: ResolvedReal): bigint => (r.lowerTick * r.tickSize + r.higherTick * r.tickSize) / 2n;
  const widthOf = (r: ResolvedReal): bigint => (r.higherTick - r.lowerTick) * r.tickSize;

  it('slides a pin band toward spot and keeps its width', () => {
    const cur = band(SPOT + 40_000_000_000n, 5_000_000_000n, 'pin');
    const next = restrikeCloser(cur, LEVERAGE_ONE);
    expect(next).not.toBeNull();
    expect(centreOf(next!)).toBeLessThan(centreOf(cur));
    expect(centreOf(next!)).toBeGreaterThan(SPOT);
    expect(widthOf(next!)).toBe(widthOf(cur));
  });

  it('carries the recorded pin with the band, so the settle reveal cannot state a miss against an unbought pin', () => {
    const cur = band(SPOT + 40_000_000_000n, 5_000_000_000n, 'pin');
    const next = restrikeCloser(cur, LEVERAGE_ONE);
    expect(parseFloat(next!.strikeDisplay!)).toBeLessThan(parseFloat(cur.strikeDisplay!));
    expect(parseFloat(next!.lowerDisplay!)).toBeLessThan(parseFloat(cur.lowerDisplay!));
    expect(parseFloat(next!.upperDisplay!)).toBeLessThan(parseFloat(cur.upperDisplay!));
  });

  it('leaves a spot-centred RANGE band alone: nothing closer exists, so it returns null', () => {
    expect(restrikeCloser(band(SPOT, 5_000_000_000n, 'range'), LEVERAGE_ONE)).toBeNull();
  });

  it('terminates: a pin band converges on spot rather than looping', () => {
    let cur: ResolvedReal = band(SPOT + 40_000_000_000n, 5_000_000_000n, 'pin');
    let steps = 0;
    for (; steps < 50; steps++) {
      const next = restrikeCloser(cur, LEVERAGE_ONE);
      if (!next) break;
      expect(centreOf(next)).toBeLessThan(centreOf(cur)); // strictly monotone toward spot
      cur = next;
    }
    expect(steps).toBeLessThan(50);
    expect(restrikeCloser(cur, LEVERAGE_ONE)).toBeNull();
  });
});

// The raised ceiling is ADMIN-only, so the guard is worth a test: a plain user asking for an admin-sized
// stake must be rejected by the same parse the play endpoints run, not merely hidden in the UI.
describe('stake ceiling by role', () => {
  const asUser = (roles: string[]) => maxStakeFor({ specialRoles: roles });

  it('caps a normal user at MAX_STAKE and an admin at MAX_STAKE_ADMIN', () => {
    expect(asUser([])).toBe(MAX_STAKE);
    expect(asUser(['KOL'])).toBe(MAX_STAKE);
    expect(asUser(['ADMIN'])).toBe(MAX_STAKE_ADMIN);
    expect(MAX_STAKE_ADMIN).toBeGreaterThan(MAX_STAKE);
  });

  it('rejects an over-cap stake for a normal user and accepts it for an admin', () => {
    expect(() => parseStake(MAX_STAKE_ADMIN, asUser([]))).toThrow(`Maximum play amount is $${MAX_STAKE}`);
    expect(parseStake(MAX_STAKE_ADMIN, asUser(['ADMIN']))).toBe(BigInt(MAX_STAKE_ADMIN) * 1_000_000n);
  });

  it('still enforces the floor and the ceiling for an admin', () => {
    expect(() => parseStake(MIN_STAKE / 2, asUser(['ADMIN']))).toThrow('Minimum play amount');
    expect(() => parseStake(MAX_STAKE_ADMIN + 1, asUser(['ADMIN']))).toThrow('Maximum play amount');
  });

  it('defaults to the public cap when no max is passed', () => {
    expect(() => parseStake(MAX_STAKE + 1)).toThrow(`Maximum play amount is $${MAX_STAKE}`);
  });
});

// SNIPE's whole game is waiting for the market to close the gap on a wall you planted, so the wall must be
// minted at the price it was planted at, not re-derived off a spot that has moved since. The near rung sits
// only ~0.15 sigma out, which on a 70s BTC round is about $2.70, so the market crosses it constantly.
describe('snipeWall (a planted wall does not move)', () => {
  const SPOT = 63_000_000_000_000n; // $63,000
  const ADMISSION = 1_000_000_000n; // $1 grid
  const SIGMA = 0.000284; // ~$17.90 on a 70s BTC round, measured off the live market
  const usd = (v: bigint) => Number(v) / 1e9;
  const at = (wall: number, side: Side, spot1e9 = SPOT) => snipeWall({ wall, side, spot1e9, sigma: SIGMA, admissionTickSize: ADMISSION });

  it('mints a planted wall at exactly the planted price', () => {
    expect(usd(at(63_010, 'up'))).toBe(63_010);
    expect(usd(at(62_990, 'down'))).toBe(62_990);
  });

  it('holds the wall as the market closes the gap, and keeps it after the crossing', () => {
    const wall = 63_010;
    // The player planted at $63,010 with spot at $63,000, then waited. Every one of these is the same bet.
    for (const spot of [63_000, 63_005, 63_009, 63_010, 63_012]) {
      const strike = at(wall, 'up', BigInt(spot) * 1_000_000_000n);
      expect(usd(strike)).toBe(wall);
    }
  });

  it('never flips the side, even once the market is through the wall', () => {
    const past = 63_020n * 1_000_000_000n;
    expect(usd(at(63_010, 'up', past))).toBe(63_010); // still an up bet, now in the money
    expect(usd(at(63_010, 'down', past))).toBe(63_010);
  });

  it('clamps only a wall outside the admissible band, and only to that edge', () => {
    const band = SNIPE_MAX_WALL_SIGMA * SIGMA * 63_000; // ~$16.80
    const far = at(63_000 + band * 4, 'up');
    expect(usd(far)).toBeLessThan(63_000 + band * 4);
    expect(usd(far)).toBeCloseTo(63_000 + band, 0);
    const farDown = at(63_000 - band * 4, 'down');
    expect(usd(farDown)).toBeCloseTo(63_000 - band, 0);
  });

  it('snaps to the $1 grid away from the winning side, never quietly improving the bet', () => {
    expect(usd(at(63_010.4, 'up'))).toBe(63_011); // up pays above, so round the wall up
    expect(usd(at(62_989.6, 'down'))).toBe(62_989); // down pays below, so round it down
  });
});

// PRESS promises "land in the innermost box and all four pay at once", which is only true if every box is
// strictly inside its parent. The price drifts between presses, so nesting has to be enforced, not assumed.
describe('pressBand (every box nests inside the one before it)', () => {
  const SPOT = 63_000_000_000_000n; // $63,000
  const SIGMA = 0.000284;
  const usd = (v: bigint) => Number(v) / 1e9;
  const open = (openIdx: number, spot1e9 = SPOT, sigma = SIGMA) => pressBand({ step: 0, openIdx, spot1e9, sigma });

  it('opens a band centred on spot, wider for a safer rung', () => {
    const safe = open(0)
    const tight = open(3)
    expect(usd(safe.lower1e9) + usd(safe.upper1e9)).toBeCloseTo(2 * 63_000, 3)
    expect(safe.upper1e9 - safe.lower1e9).toBeGreaterThan(tight.upper1e9 - tight.lower1e9)
    expect(safe.prob).toBeGreaterThan(tight.prob)
  })

  it('halves the win probability per press, so the multiple roughly doubles', () => {
    const first = open(1)
    const second = pressBand({ step: 1, openIdx: 1, spot1e9: SPOT, sigma: SIGMA, inner: first })
    expect(second.prob).toBeCloseTo(first.prob / 2, 6)
  })

  it('keeps every box strictly inside its parent as the price drifts across it', () => {
    let inner = open(1)
    // The player pressed at each of these spots, drifting toward the edge of the box they already hold.
    const drift = [63_000, 63_004, 63_009, 62_994]
    for (let step = 1; step < 4; step++) {
      const spot = BigInt(Math.round(drift[step] * 1e9))
      // sigma decays as the clock runs off, which is what makes a later press price better.
      const next = pressBand({ step, openIdx: 1, spot1e9: spot, sigma: SIGMA * Math.sqrt(1 - step / 5), inner })
      expect(next.lower1e9).toBeGreaterThanOrEqual(inner.lower1e9)
      expect(next.upper1e9).toBeLessThanOrEqual(inner.upper1e9)
      expect(next.upper1e9 - next.lower1e9).toBeLessThan(inner.upper1e9 - inner.lower1e9)
      inner = next
    }
  })

  it('slides the centre rather than clipping a bound when the price sits near the edge', () => {
    const first = open(0)
    // Hard against the parent's upper edge: the box must move, not lose half its width.
    const atEdge = first.upper1e9 - 1_000_000_000n
    const next = pressBand({ step: 1, openIdx: 0, spot1e9: atEdge, sigma: SIGMA, inner: first })
    const full = pressBand({ step: 1, openIdx: 0, spot1e9: SPOT, sigma: SIGMA, inner: first })
    // Same bet, moved. Widths differ only by the cent that half-width scaling off a drifted spot costs.
    expect(usd(next.upper1e9 - next.lower1e9)).toBeCloseTo(usd(full.upper1e9 - full.lower1e9), 1)
    expect(next.upper1e9).toBeLessThanOrEqual(first.upper1e9)
  })

  it('pulls a box inside a parent too tight to hold it', () => {
    const parent = { lower1e9: SPOT - 2_000_000_000n, upper1e9: SPOT + 2_000_000_000n } // $4 wide
    const next = pressBand({ step: 1, openIdx: 0, spot1e9: SPOT, sigma: SIGMA, inner: parent })
    expect(next.lower1e9).toBeGreaterThanOrEqual(parent.lower1e9)
    expect(next.upper1e9).toBeLessThanOrEqual(parent.upper1e9)
  })
})

// BREAKOUT's BREAK ladder. The rungs are the game's risk dial, so a non-monotonic one (a riskier setting
// paying LESS) is a product bug the chain will never report: both rungs mint fine, they just rank wrong.
describe('breakoutProbs', () => {
  const even = (i: number) => breakoutProbs(i, 0)

  it('drops the win probability on every rung, so a wider break always pays more', () => {
    for (let i = 1; i < BREAKOUT_LEG_PROBS.length; i++) {
      expect(even(i)[0].prob).toBeLessThan(even(i - 1)[0].prob)
    }
  })

  it('is symmetric on EVEN and skewed the right way on a lean', () => {
    const [up, down] = even(2)
    expect(up.side).toBe('up')
    expect(down.side).toBe('down')
    expect(up.prob).toBe(down.prob)

    // Leaning up brings the up wall CLOSER (likelier, and it pays less for exactly that reason).
    const [lu, ld] = breakoutProbs(2, 1)
    expect(lu.prob).toBeGreaterThan(up.prob)
    expect(ld.prob).toBeLessThan(down.prob)

    const [du, dd] = breakoutProbs(2, -1)
    expect(du.prob).toBeLessThan(up.prob)
    expect(dd.prob).toBeGreaterThan(down.prob)
  })

  it('keeps every leg inside the chain bounds, and clear of break-even, at both extremes', () => {
    for (let i = 0; i < BREAKOUT_LEG_PROBS.length; i++) {
      for (const lean of [0, 1, -1]) {
        for (const leg of breakoutProbs(i, lean)) {
          expect(leg.prob).toBeGreaterThanOrEqual(REAL_STRIKE_MIN_PROB)
          // Under 0.5 or the surviving leg cannot repay both premiums, which is the one way this game breaks.
          expect(leg.prob).toBeLessThan(0.5)
        }
      }
    }
  })

  it('clamps an out-of-range ladder index rather than reading off the end', () => {
    expect(breakoutProbs(-5, 0)[0].prob).toBe(BREAKOUT_LEG_PROBS[0])
    expect(breakoutProbs(99, 0)[0].prob).toBe(BREAKOUT_LEG_PROBS[BREAKOUT_LEG_PROBS.length - 1])
  })
})
