// Day bucketing is the whole reason the admin charts were wrong, so the zones that break naive maths get
// a case each: a whole-hour offset, a :45 offset, and both sides of a DST jump.

import { describe, expect, test } from 'bun:test';

import { safeTimeZone, tzAddDays, tzDayStart, tzIsoDay, tzOffsetMs } from './timeUtils.ts';

const HOUR = 3_600_000;

describe('safeTimeZone', () => {
  test('keeps a real IANA zone', () => {
    expect(safeTimeZone('Asia/Jakarta')).toBe('Asia/Jakarta');
  });

  test('falls back to UTC on junk, since a query param reaches it', () => {
    expect(safeTimeZone('Mars/Olympus')).toBe('UTC');
    expect(safeTimeZone('')).toBe('UTC');
    expect(safeTimeZone(undefined)).toBe('UTC');
  });
});

describe('tzOffsetMs', () => {
  test('Jakarta is a flat +7', () => {
    expect(tzOffsetMs(Date.parse('2026-08-09T12:00:00Z'), 'Asia/Jakarta')).toBe(7 * HOUR);
    expect(tzOffsetMs(Date.parse('2026-01-09T12:00:00Z'), 'Asia/Jakarta')).toBe(7 * HOUR);
  });

  test('Kathmandu is +5:45, which whole-hour maths gets wrong', () => {
    expect(tzOffsetMs(Date.parse('2026-08-09T12:00:00Z'), 'Asia/Kathmandu')).toBe(5 * HOUR + 45 * 60_000);
  });

  test('New York moves across the DST boundary', () => {
    expect(tzOffsetMs(Date.parse('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-5 * HOUR);
    expect(tzOffsetMs(Date.parse('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(-4 * HOUR);
  });
});

describe('tzDayStart', () => {
  test('Jakarta midnight is 17:00Z the day before', () => {
    const t = Date.parse('2026-08-09T03:30:00Z'); // 10:30 in Jakarta
    expect(new Date(tzDayStart(t, 'Asia/Jakarta')).toISOString()).toBe('2026-08-08T17:00:00.000Z');
  });

  test('an evening UTC instant still lands on the NEXT Jakarta day', () => {
    const t = Date.parse('2026-08-09T18:00:00Z'); // 01:00 on the 10th in Jakarta
    expect(new Date(tzDayStart(t, 'Asia/Jakarta')).toISOString()).toBe('2026-08-09T17:00:00.000Z');
  });

  test('Kathmandu midnight carries the 45 minutes', () => {
    const t = Date.parse('2026-08-09T06:00:00Z');
    expect(new Date(tzDayStart(t, 'Asia/Kathmandu')).toISOString()).toBe('2026-08-08T18:15:00.000Z');
  });

  test('UTC is unchanged', () => {
    const t = Date.parse('2026-08-09T13:45:12.500Z');
    expect(new Date(tzDayStart(t, 'UTC')).toISOString()).toBe('2026-08-09T00:00:00.000Z');
  });

  test('is idempotent: the start of a day is its own day start', () => {
    for (const tz of ['Asia/Jakarta', 'Asia/Kathmandu', 'America/New_York', 'UTC']) {
      const start = tzDayStart(Date.parse('2026-03-08T12:00:00Z'), tz);
      expect(tzDayStart(start, tz)).toBe(start);
    }
  });

  test('the US spring-forward day is 23 hours, and both halves bucket to it', () => {
    // 2026-03-08 is the US DST jump: 02:00 local becomes 03:00.
    const before = tzDayStart(Date.parse('2026-03-08T06:00:00Z'), 'America/New_York'); // 01:00 EST
    const after = tzDayStart(Date.parse('2026-03-08T20:00:00Z'), 'America/New_York'); // 16:00 EDT
    expect(before).toBe(after);
    expect(new Date(before).toISOString()).toBe('2026-03-08T05:00:00.000Z');
  });
});

describe('tzAddDays', () => {
  test('walks calendar days, not fixed 24h blocks, across spring forward', () => {
    const day = tzDayStart(Date.parse('2026-03-08T20:00:00Z'), 'America/New_York');
    const prev = tzAddDays(day, -1, 'America/New_York');
    expect(new Date(prev).toISOString()).toBe('2026-03-07T05:00:00.000Z');
    // 23 hours, not 24: that difference is what shifts a naive series by one bucket.
    expect(day - prev).toBe(24 * HOUR);
    const next = tzAddDays(day, 1, 'America/New_York');
    expect(next - day).toBe(23 * HOUR);
  });

  test('walks 14 days back in Jakarta without drift', () => {
    let cursor = tzDayStart(Date.parse('2026-08-09T03:00:00Z'), 'Asia/Jakarta');
    for (let i = 0; i < 14; i++) cursor = tzAddDays(cursor, -1, 'Asia/Jakarta');
    expect(tzIsoDay(cursor, 'Asia/Jakarta')).toBe('2026-07-26');
  });
});

describe('tzIsoDay', () => {
  test('names the local day, not the UTC one', () => {
    const t = Date.parse('2026-08-09T18:00:00Z');
    expect(tzIsoDay(t, 'UTC')).toBe('2026-08-09');
    expect(tzIsoDay(t, 'Asia/Jakarta')).toBe('2026-08-10');
    expect(tzIsoDay(t, 'America/New_York')).toBe('2026-08-09');
  });
});
