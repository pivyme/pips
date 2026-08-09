// Every dashboard fetch. Deliberately does not go through lib/api.ts: that client is wrapped in the
// demo-mode proxy and the admin surface has no demo twin, so a demo session must never see admin data.

import { queryOptions } from '@tanstack/react-query'

import { getAuthToken } from '@/lib/api'
import { env } from '@/env'
import type { AdminPing, ErrorDetail, ErrorGroupRow, ErrorStatus, LiveReport, OpsSnapshot, OverviewReport, PerfReport, RetentionPreview, SettingRow, UsageReport } from './types'

const BASE = env.VITE_API_URL

// Day buckets are cut server-side in the reader's zone, or a chart at GMT+7 names the wrong day. SSR has
// no reader, so it falls back to UTC and the first client render refetches with the real one.
const readerTz = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export class AdminError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAuthToken()
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  })
  const json = (await res.json().catch(() => null)) as { success?: boolean; error?: { message?: string }; data?: T } | null
  if (!res.ok || !json?.success) {
    // The backend answers 404 for a non-admin on purpose (§7.5), so this is the message a normal user sees.
    throw new AdminError(res.status === 404 ? 'Not found' : (json?.error?.message ?? 'Request failed'), res.status)
  }
  return json.data as T
}

// text/markdown, so it bypasses the envelope entirely.
export async function fetchBrief(fingerprint: string): Promise<string> {
  const token = getAuthToken()
  const res = await fetch(`${BASE}/admin/errors/${encodeURIComponent(fingerprint)}/brief`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new AdminError('Could not build the brief', res.status)
  return res.text()
}

export const pingQuery = () =>
  queryOptions({
    queryKey: ['admin', 'ping'],
    queryFn: () => adminFetch<AdminPing>('/admin/ping'),
    staleTime: 30_000,
    retry: false,
  })

export interface ErrorFilters {
  status: string
  level: string
  kind: string
}

export const errorsQuery = (f: ErrorFilters) =>
  queryOptions({
    queryKey: ['admin', 'errors', f],
    queryFn: () => {
      const q = new URLSearchParams()
      if (f.status) q.set('status', f.status)
      if (f.level) q.set('level', f.level)
      if (f.kind) q.set('kind', f.kind)
      return adminFetch<{ groups: ErrorGroupRow[]; resolvedThisWeek: number }>(`/admin/errors?${q.toString()}`)
    },
    refetchInterval: 30_000,
    retry: false,
  })

export const errorDetailQuery = (fingerprint: string | null) =>
  queryOptions({
    queryKey: ['admin', 'error', fingerprint],
    queryFn: () => adminFetch<ErrorDetail>(`/admin/errors/${encodeURIComponent(fingerprint!)}`),
    enabled: !!fingerprint,
    retry: false,
  })

export function setErrorStatus(fingerprint: string, status: ErrorStatus): Promise<{ group: ErrorGroupRow }> {
  return adminFetch(`/admin/errors/${encodeURIComponent(fingerprint)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
}

export const usageQuery = (days: number) => {
  const tz = readerTz()
  return queryOptions({
    queryKey: ['admin', 'usage', days, tz],
    queryFn: () => adminFetch<UsageReport>(`/admin/usage?days=${days}&tz=${encodeURIComponent(tz)}`),
    staleTime: 60_000,
    retry: false,
  })
}

export const overviewQuery = () => {
  const tz = readerTz()
  return queryOptions({
    queryKey: ['admin', 'overview', tz],
    queryFn: () => adminFetch<OverviewReport>(`/admin/overview?tz=${encodeURIComponent(tz)}`),
    staleTime: 60_000,
    retry: false,
  })
}

// The one genuinely live read. 5s is fast enough to feel like "right now" and still only 12 calls a
// minute against the 60/min admin bucket.
export const liveQuery = () =>
  queryOptions({
    queryKey: ['admin', 'live'],
    queryFn: () => adminFetch<LiveReport>('/admin/live'),
    staleTime: 4_000,
    refetchInterval: 5_000,
    retry: false,
  })

export const perfQuery = (hours: number) =>
  queryOptions({
    queryKey: ['admin', 'perf', hours],
    queryFn: () => adminFetch<PerfReport>(`/admin/perf?hours=${hours}`),
    staleTime: 30_000,
    retry: false,
  })

export const settingsQuery = () =>
  queryOptions({
    queryKey: ['admin', 'settings'],
    queryFn: () => adminFetch<{ settings: SettingRow[] }>('/admin/settings'),
    staleTime: 30_000,
    retry: false,
  })

export function saveSetting(key: string, value: boolean | number, confirm?: string): Promise<{ key: string; value: boolean | number }> {
  return adminFetch('/admin/settings', { method: 'PATCH', body: JSON.stringify({ key, value, confirm }) })
}

// What a value would delete, before anything is deleted. The server recomputes at apply time anyway, so
// this is the number a human reads, not the number that authorises the delete.
export function previewSetting(key: string, value: number): Promise<RetentionPreview> {
  return adminFetch<RetentionPreview>(`/admin/settings/preview?key=${encodeURIComponent(key)}&value=${value}`)
}

// The banner refreshes on its own: an ops page left open on a second monitor should go red without a
// reload. 30s matches the cron's cadence closely enough without polling for nothing.
export const opsQuery = () =>
  queryOptions({
    queryKey: ['admin', 'ops'],
    queryFn: () => adminFetch<OpsSnapshot>('/admin/ops'),
    staleTime: 20_000,
    refetchInterval: 30_000,
    retry: false,
  })
