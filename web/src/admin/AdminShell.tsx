// The dashboard frame: a 220px fixed sidebar, a health dot, and a fluid content area. Deliberately not
// the product's language, neither the rounded App Surface nor the TE screen: it should be obvious at a
// glance that you left the toy and picked up the instrument.
//
// Imports nothing from the device shell (no console, no game, no three, no gsap, no motion, no HeroUI),
// which `bun run check:admin` enforces in the gate.

import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useEffect, type ReactNode } from 'react'

import { useAuth } from '@/lib/auth'
import { pingQuery } from './queries'
import './admin.css'

const NAV = [
  { to: '/admin', label: 'Overview' },
  { to: '/admin/errors', label: 'Errors' },
  { to: '/admin/usage', label: 'Usage' },
  { to: '/admin/perf', label: 'Performance' },
] as const

export function AdminShell({ children }: { children: ReactNode }) {
  const { user, status } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const isAdmin = !!user?.specialRoles?.includes('ADMIN')
  const settling = status === 'loading'

  // UX only. The backend answers 404 on every /admin/* route for a non-admin, and that is the real gate.
  useEffect(() => {
    if (!settling && !isAdmin) void navigate({ to: '/games', replace: true })
  }, [settling, isAdmin, navigate])

  if (settling) {
    return (
      <div data-admin className="flex min-h-screen items-center justify-center" style={{ color: 'var(--a-text-3)' }}>
        Checking access
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div data-admin className="flex min-h-screen items-center justify-center" style={{ color: 'var(--a-text-3)' }}>
        Not found
      </div>
    )
  }

  return (
    <div data-admin className="flex min-h-screen">
      <nav
        className="hidden w-[220px] shrink-0 flex-col justify-between border-r p-3 lg:flex"
        style={{ background: 'var(--a-surface)', borderColor: 'var(--a-border)' }}
      >
        <div className="flex flex-col gap-1">
          <div className="mb-3 flex items-center gap-2 px-2.5 pt-1">
            <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.02em' }}>PIPS admin</span>
            <HealthDot />
          </div>
          {NAV.map((item) => (
            <Link key={item.to} to={item.to} className="a-nav-item" data-active={isActive(location.pathname, item.to)}>
              {item.label}
            </Link>
          ))}
        </div>
        <ShellFooter />
      </nav>

      {/* Mobile keeps the nav as a plain strip: Errors is the one page worth triaging from a phone. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className="flex items-center gap-1 overflow-x-auto border-b px-2 py-2 lg:hidden"
          style={{ background: 'var(--a-surface)', borderColor: 'var(--a-border)' }}
        >
          <HealthDot />
          {NAV.map((item) => (
            <Link key={item.to} to={item.to} className="a-nav-item" data-active={isActive(location.pathname, item.to)}>
              {item.label}
            </Link>
          ))}
        </div>
        <main className="min-w-0 flex-1 p-4">{children}</main>
      </div>
    </div>
  )
}

// Exact match for the index route, prefix match for the rest, so /admin does not light up on /admin/errors.
function isActive(pathname: string, to: string): boolean {
  const p = pathname.replace(/\/$/, '') || '/admin'
  return to === '/admin' ? p === '/admin' : p.startsWith(to)
}

// Green when the API answers as an admin, red when it does not. One dot is the whole "is it up" question.
function HealthDot() {
  const q = useQuery(pingQuery())
  const color = q.isPending ? 'var(--a-text-muted)' : q.isError ? 'var(--a-critical)' : 'var(--a-ok)'
  const label = q.isPending ? 'Checking the API' : q.isError ? 'API unreachable or access revoked' : `API healthy (${q.data?.network})`
  return <span className="a-dot" style={{ background: color }} title={label} aria-label={label} />
}

function ShellFooter() {
  const q = useQuery(pingQuery())
  return (
    <div className="flex flex-col gap-1.5 px-2.5 pb-1">
      {q.data && !q.data.analyticsEnabled && (
        <span className="a-badge a-badge-warn" title="Ingest is off, so Usage will look empty">
          analytics off
        </span>
      )}
      <span className="a-label">{q.data?.network ?? ''}</span>
      <Link to="/games" className="a-nav-item px-0">
        Back to PIPS
      </Link>
    </div>
  )
}
