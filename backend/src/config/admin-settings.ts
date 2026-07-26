// Runtime tunables for the admin dashboard. NOT env vars: none of these are secrets and none are needed
// before the DB is up, so they live in the existing AppConfig table where the dashboard can edit them live.
// See bigdev/plans/cont/03-ADMIN-DASHBOARD.md §2.6 and lesson L-022.
//
// Defaults ship in code, so a fresh clone, CI, and a bare prod box all boot with zero configuration.
// A row exists only for a value someone deliberately changed.

import { prismaQuery } from '../lib/prisma.ts';

// The only place a tunable is declared. Adding a knob is one line here and nothing else.
export const SETTINGS = {
  'analytics.enabled': { type: 'bool', def: true },
  'analytics.daily_max': { type: 'int', def: 200_000, min: 10_000, max: 5_000_000 },
  'analytics.error_daily_max': { type: 'int', def: 20_000, min: 1_000, max: 500_000 },
  'retention.event_days': { type: 'int', def: 365, min: 30, max: 1095, destructive: true },
  'retention.error_days': { type: 'int', def: 365, min: 30, max: 1095, destructive: true },
  'retention.samples_per_group': { type: 'int', def: 20, min: 5, max: 100, destructive: true },
  'rate.track_max': { type: 'int', def: 60, min: 10, max: 600 },
  'rate.track_anon_max': { type: 'int', def: 10, min: 2, max: 120 },
  'rate.admin_max': { type: 'int', def: 60, min: 10, max: 600 },
  'client_errors.enabled': { type: 'bool', def: true }, // kill switch if a client loop floods
} as const;

export type SettingKey = keyof typeof SETTINGS;
type SettingDef = (typeof SETTINGS)[SettingKey] | DynamicDef;

// Detector thresholds (§6) are declared by the detector itself in services/insights.ts, so adding a
// detector stays one array entry and its two knobs come along. They share this module's storage, cache,
// and read-clamp; they are just not in the literal above, which stays the typed product-knob list.
type DynamicDef = { type: 'int'; def: number; min: number; max: number; label: string };
const dynamic = new Map<string, DynamicDef>();

export function registerTunable(key: string, def: DynamicDef): void {
  dynamic.set(key, def);
}

function defOf(key: string): SettingDef | undefined {
  return isSettingKey(key) ? SETTINGS[key] : dynamic.get(key);
}

// Value type per key, so getSetting('analytics.enabled') is boolean and getSetting('rate.admin_max') is number.
export type SettingValue<K extends SettingKey> = (typeof SETTINGS)[K]['type'] extends 'bool' ? boolean : number;

const ROW_PREFIX = 'setting:';
const CACHE_TTL_MS = 30_000;

const cache = new Map<string, { value: unknown; at: number }>();

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, key);
}

export function isDestructive(key: SettingKey): boolean {
  return 'destructive' in SETTINGS[key] && SETTINGS[key].destructive === true;
}

// Clamp on READ, every time. A hand-edited SQL row, a bad migration, or a corrupt JSON blob can never
// push retention below its floor, because the bound is enforced at the point of use. Write-side
// validation alone is theatre.
function coerce(def: SettingDef, raw: unknown): unknown {
  if (def.type === 'bool') return typeof raw === 'boolean' ? raw : def.def;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return def.def;
  const min = 'min' in def ? def.min : Number.NEGATIVE_INFINITY;
  const max = 'max' in def ? def.max : Number.POSITIVE_INFINITY;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// Validate a candidate write. Out-of-bounds is rejected outright rather than silently clamped, so the
// dashboard tells you "no" instead of quietly storing something else.
export function validateSetting(key: string, value: unknown): { ok: true; value: boolean | number } | { ok: false; reason: string } {
  const def = defOf(key);
  if (!def) return { ok: false, reason: 'unknown setting key' };
  if (def.type === 'bool') {
    if (typeof value !== 'boolean') return { ok: false, reason: 'expected a boolean' };
    return { ok: true, value };
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, reason: 'expected an integer' };
  const min = 'min' in def ? def.min : Number.NEGATIVE_INFINITY;
  const max = 'max' in def ? def.max : Number.POSITIVE_INFINITY;
  if (n < min || n > max) return { ok: false, reason: `must be between ${min} and ${max}` };
  return { ok: true, value: n };
}

// Never hits the DB on a hot path: 30s in-memory cache, and a DB failure falls back to the code default
// rather than throwing into a caller that only wanted a number.
export async function getSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
  return read(key) as Promise<SettingValue<K>>;
}

/** A detector threshold, which is a registered tunable rather than one of the literal product knobs. */
export async function getTunable(key: string, fallback: number): Promise<number> {
  if (!dynamic.has(key)) return fallback;
  return (await read(key)) as number;
}

async function read(key: string): Promise<boolean | number> {
  const def = defOf(key);
  if (!def) throw new Error(`getSetting: unknown key ${key}`);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as boolean | number;

  let stored: unknown;
  try {
    const row = await prismaQuery.appConfig.findUnique({ where: { key: ROW_PREFIX + key } });
    stored = row ? JSON.parse(row.value) : undefined;
  } catch {
    stored = undefined;
  }
  const value = stored === undefined ? def.def : coerce(def, stored);
  cache.set(key, { value, at: Date.now() });
  return value as boolean | number;
}

export async function setSetting(key: string, value: unknown): Promise<{ ok: true; value: boolean | number } | { ok: false; reason: string }> {
  if (!defOf(key)) return { ok: false, reason: 'unknown setting key' };
  const checked = validateSetting(key, value);
  if (!checked.ok) return checked;

  const json = JSON.stringify(checked.value);
  await prismaQuery.appConfig.upsert({
    where: { key: ROW_PREFIX + key },
    create: { key: ROW_PREFIX + key, value: json },
    update: { value: json },
  });
  cache.set(key, { value: checked.value, at: Date.now() });
  return checked;
}

export interface SettingRow {
  key: string;
  type: string;
  def: boolean | number;
  min?: number;
  max?: number;
  destructive: boolean;
  value: boolean | number;
  /** Set on a registered detector threshold, so the drawer can group them away from the product knobs. */
  label?: string;
}

// All keys with their schema and current values, for the settings drawer.
export async function allSettings(): Promise<SettingRow[]> {
  const keys = [...(Object.keys(SETTINGS) as SettingKey[]), ...dynamic.keys()];
  return Promise.all(
    keys.map(async (key) => {
      const def = defOf(key)!;
      return {
        key,
        type: def.type,
        def: def.def,
        min: 'min' in def ? def.min : undefined,
        max: 'max' in def ? def.max : undefined,
        destructive: isSettingKey(key) && isDestructive(key),
        value: await read(key),
        ...('label' in def ? { label: def.label } : {}),
      };
    })
  );
}

// Test seam: drop the cache so a test can observe a fresh read.
export function clearSettingsCache(): void {
  cache.clear();
}
