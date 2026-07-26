// Settings are the layer everything else in the dashboard reads its knobs through, and the retention
// keys are one text field away from deleting data, so the clamps get pinned here rather than trusted.
// The DB is stubbed: these assert the clamp/validate logic, not Postgres.

import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test';

import { SETTINGS, isSettingKey, isDestructive, validateSetting, getSetting, setSetting, clearSettingsCache } from './admin-settings.ts';
import { prismaQuery } from '../lib/prisma.ts';

// One fake AppConfig row store, so no test opens a connection.
let rows: Map<string, string>;
const origFindUnique = prismaQuery.appConfig.findUnique;
const origUpsert = prismaQuery.appConfig.upsert;

beforeEach(() => {
  rows = new Map();
  clearSettingsCache();
  (prismaQuery.appConfig as any).findUnique = mock(async ({ where }: { where: { key: string } }) => {
    const value = rows.get(where.key);
    return value === undefined ? null : { key: where.key, value, updatedAt: new Date() };
  });
  (prismaQuery.appConfig as any).upsert = mock(async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
    rows.set(where.key, create.value);
    return { key: where.key, value: create.value, updatedAt: new Date() };
  });
});

afterEach(() => {
  (prismaQuery.appConfig as any).findUnique = origFindUnique;
  (prismaQuery.appConfig as any).upsert = origUpsert;
  clearSettingsCache();
});

describe('admin settings', () => {
  it('returns the code default with no row and no env', async () => {
    expect(await getSetting('retention.event_days')).toBe(365);
    expect(await getSetting('analytics.enabled')).toBe(true);
    expect(await getSetting('rate.admin_max')).toBe(60);
  });

  it('refuses to store a value below the floor', async () => {
    const res = await setSetting('retention.event_days', 7);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('between 30 and 1095');
    // and nothing was written, so the read still gives the default
    expect(await getSetting('retention.event_days')).toBe(365);
  });

  it('refuses to store a value above the ceiling', async () => {
    expect((await setSetting('retention.event_days', 5000)).ok).toBe(false);
    expect((await setSetting('retention.samples_per_group', 4)).ok).toBe(false);
  });

  it('rejects an unknown key', async () => {
    const res = await setSetting('retention.made_up_key', 90);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unknown setting key');
    expect(isSettingKey('retention.made_up_key')).toBe(false);
  });

  it('stores and reads back a valid value', async () => {
    expect((await setSetting('retention.event_days', 90)).ok).toBe(true);
    clearSettingsCache();
    expect(await getSetting('retention.event_days')).toBe(90);
  });

  it('clamps a hand-corrupted row to the floor on READ', async () => {
    // Simulates someone editing the row in psql, or a bad migration. Write-side validation cannot
    // catch this, which is exactly why the bound is enforced at the point of use.
    rows.set('setting:retention.event_days', '1');
    clearSettingsCache();
    expect(await getSetting('retention.event_days')).toBe(30);

    rows.set('setting:retention.samples_per_group', '0');
    clearSettingsCache();
    expect(await getSetting('retention.samples_per_group')).toBe(5);
  });

  it('clamps a hand-corrupted row to the ceiling on READ', async () => {
    rows.set('setting:retention.error_days', '99999');
    clearSettingsCache();
    expect(await getSetting('retention.error_days')).toBe(1095);
  });

  it('falls back to the default on a garbage row rather than throwing', async () => {
    rows.set('setting:rate.admin_max', '"not a number"');
    clearSettingsCache();
    expect(await getSetting('rate.admin_max')).toBe(60);

    rows.set('setting:analytics.enabled', '42');
    clearSettingsCache();
    expect(await getSetting('analytics.enabled')).toBe(true);
  });

  it('falls back to the default when the DB read throws', async () => {
    (prismaQuery.appConfig as any).findUnique = mock(async () => {
      throw new Error('connection refused');
    });
    clearSettingsCache();
    expect(await getSetting('retention.event_days')).toBe(365);
  });

  it('validates types: a bool key refuses a number, an int key refuses a fraction', () => {
    expect(validateSetting('analytics.enabled', 1).ok).toBe(false);
    expect(validateSetting('analytics.enabled', false).ok).toBe(true);
    expect(validateSetting('rate.track_max', 12.5).ok).toBe(false);
    expect(validateSetting('rate.track_max', 12).ok).toBe(true);
    expect(validateSetting('rate.track_max', 9).ok).toBe(false); // min is 10
  });

  it('flags exactly the destructive keys', () => {
    const destructive = (Object.keys(SETTINGS) as Array<keyof typeof SETTINGS>).filter(isDestructive);
    expect(destructive.sort()).toEqual(['retention.error_days', 'retention.event_days', 'retention.samples_per_group']);
  });
});
