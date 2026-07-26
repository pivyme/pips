// Every dashboard fetch. Deliberately does not go through lib/api.ts: that client is wrapped in the
// demo-mode proxy and the admin surface has no demo twin, so a demo session must never see admin data.

import { queryOptions } from '@tanstack/react-query'

import { getAuthToken } from '@/lib/api'
import { env } from '@/env'
import type { AdminPing, ErrorDetail, ErrorGroupRow, ErrorStatus } from './types'

const BASE = env.VITE_API_URL

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
      return adminFetch<{ groups: ErrorGroupRow[] }>(`/admin/errors?${q.toString()}`)
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
