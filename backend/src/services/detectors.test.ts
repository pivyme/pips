// Ops detectors (§6). Two things are worth pinning here and nothing else is:
//
//   1. the threshold maths, driven with readings that straddle warn and critical in both directions,
//      because half the detectors are inverted (runway hours, treasury cover) and an inverted comparison
//      that reads backwards would report a healthy system while the sponsor drains.
//   2. the alerting discipline: fire on the TRANSITION into critical, once, plus one recovery. A detector
//      that pages every tick is how a team learns to ignore the dashboard, which is worse than no alerts.
//
// Both are pure functions on purpose, so they are assertable with no database and no clock.

import { describe, expect, it } from 'bun:test';

import { DETECTORS, alertTransitions, levelFor, percentile, type DetectorStatus, type OpsLevel } from './insights.ts';

const higher = { warn: 5, critical: 15 };
const lower = { warn: 12, critical: 3, lowerIsWorse: true as const };

describe('levelFor', () => {
  it('grades a higher-is-worse detector at, either side of, and between its thresholds', () => {
    expect(levelFor(higher, 0)).toBe('ok');
    expect(levelFor(higher, 4.9)).toBe('ok');
    expect(levelFor(higher, 5)).toBe('warn'); // the boundary is inclusive, so a threshold of 5 fires at 5
    expect(levelFor(higher, 14.9)).toBe('warn');
    expect(levelFor(higher, 15)).toBe('critical');
    expect(levelFor(higher, 100)).toBe('critical');
  });

  it('grades an inverted detector the other way, so a big number is the healthy one', () => {
    expect(levelFor(lower, 48)).toBe('ok');
    expect(levelFor(lower, 12.1)).toBe('ok');
    expect(levelFor(lower, 12)).toBe('warn');
    expect(levelFor(lower, 3.1)).toBe('warn');
    expect(levelFor(lower, 3)).toBe('critical');
    expect(levelFor(lower, 0)).toBe('critical');
  });

  it('reports ok for no signal rather than guessing', () => {
    // A window with too few samples abstains. Treating null as 0 would make an idle night look either
    // perfectly healthy or catastrophically broken depending on which way the detector points.
    expect(levelFor(higher, null)).toBe('ok');
    expect(levelFor(lower, null)).toBe('ok');
    expect(levelFor(higher, NaN)).toBe('ok');
    expect(levelFor(lower, Infinity)).toBe('ok');
  });
});

describe('percentile', () => {
  it('handles the three cases that make percentiles lie', () => {
    expect(percentile([], 95)).toBe(null); // empty window
    expect(percentile([42], 95)).toBe(42); // a single sample IS every percentile
    expect(percentile([10, 20, 30, 40], 50)).toBe(20); // even count, nearest-rank, never an invented average
  });

  it('picks the real observed value at p95 and does not care about input order', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile([...values].reverse(), 95)).toBe(95);
    expect(percentile(values, 50)).toBe(50);
  });
});

const status = (key: string, level: OpsLevel): DetectorStatus => ({
  key,
  title: key,
  level,
  value: 1,
  display: '1',
  warn: 1,
  critical: 2,
  runbook: 'r',
  checkedAt: '2026-07-27T00:00:00.000Z',
});

describe('alertTransitions', () => {
  it('fires once entering critical, then zero times while it stays critical', () => {
    const first = alertTransitions({ settle_lag: 'ok' }, [status('settle_lag', 'critical')]);
    expect(first).toHaveLength(1);
    expect(first[0]!.kind).toBe('critical');

    // The same reading on the next tick, and the one after: silence.
    expect(alertTransitions({ settle_lag: 'critical' }, [status('settle_lag', 'critical')])).toHaveLength(0);
  });

  it('fires exactly one recovery when it clears, and nothing after', () => {
    const recovered = alertTransitions({ settle_lag: 'critical' }, [status('settle_lag', 'ok')]);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.kind).toBe('recovered');
    expect(alertTransitions({ settle_lag: 'ok' }, [status('settle_lag', 'ok')])).toHaveLength(0);
  });

  it('counts warn as recovery from critical but never pages on warn itself', () => {
    // Expected-but-noisy conditions live at warn, and warn must never page (§6 alerting discipline).
    expect(alertTransitions({ x: 'ok' }, [status('x', 'warn')])).toHaveLength(0);
    expect(alertTransitions({ x: 'warn' }, [status('x', 'warn')])).toHaveLength(0);
    const back = alertTransitions({ x: 'critical' }, [status('x', 'warn')]);
    expect(back).toHaveLength(1);
    expect(back[0]!.kind).toBe('recovered');
  });

  it('treats a first-ever sighting as a transition, so a boot straight into critical still pages', () => {
    expect(alertTransitions({}, [status('brand_new', 'critical')])[0]!.kind).toBe('critical');
    expect(alertTransitions({}, [status('brand_new', 'ok')])).toHaveLength(0);
  });

  it('reports each detector independently in one sweep', () => {
    const out = alertTransitions({ a: 'ok', b: 'critical', c: 'critical' }, [
      status('a', 'critical'),
      status('b', 'critical'),
      status('c', 'ok'),
    ]);
    expect(out.map((t) => [t.key, t.kind])).toEqual([
      ['a', 'critical'],
      ['c', 'recovered'],
    ]);
  });
});

describe('the detector catalog', () => {
  it('has all thirteen, each with a unique key and a real runbook', () => {
    expect(DETECTORS).toHaveLength(13);
    expect(new Set(DETECTORS.map((d) => d.key)).size).toBe(13);
    for (const d of DETECTORS) {
      // An alert without a one-line "what to do" is a notification, not a tool.
      expect(d.runbook.length).toBeGreaterThan(30);
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.runbook).not.toContain('—');
    }
  });

  it('orders every threshold pair so critical is the worse side of warn', () => {
    // A pair the wrong way round makes a detector that can only ever report critical, or only ever warn.
    for (const d of DETECTORS) {
      if (d.lowerIsWorse) expect(d.critical).toBeLessThanOrEqual(d.warn);
      else expect(d.critical).toBeGreaterThanOrEqual(d.warn);
    }
  });
});
