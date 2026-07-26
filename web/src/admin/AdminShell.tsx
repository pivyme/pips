// The dashboard frame: a 232px rail, a health readout, and a fluid content area. It wears the product's
// skin (black canvas, molded panels, amber accent, Gabarito) but not its posture: this is dense and
// desktop-first, an instrument you read rather than a device you play.
//
// Never mounts the device: no console, no game screens, no three, no gsap. `bun run check:admin`
// enforces that in the gate.

import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, BarChart3, Gauge, LayoutDashboard, LogOut, Settings2, type LucideIcon } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { useAuth } from '@/lib/auth'
import { SettingsDrawer } from './components/SettingsDrawer'
import { opsQuery, pingQuery } from './queries'
import './admin.css'

const NAV: Array<{ to: string; label: string; icon: LucideIcon; hint: string }> = [
  { to: '/admin', label: 'Overview', icon: LayoutDashboard, hint: 'Users, plays, money, chain' },
  { to: '/admin/errors', label: 'Errors', icon: AlertTriangle, hint: 'Grouped bugs and their briefs' },
  { to: '/admin/usage', label: 'Usage', icon: BarChart3, hint: 'What people actually touch' },
  { to: '/admin/perf', label: 'Performance', icon: Gauge, hint: 'Latency and worker health' },
]

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

  if (settling || !isAdmin) {
    return (
      <div data-admin className="flex min-h-screen items-center justify-center" style={{ color: 'var(--a-text-3)' }}>
        {settling ? 'Checking access' : 'Not found'}
      </div>
    )
  }

  return (
    <div data-admin className="flex min-h-screen">
      {/* Pinned to the viewport, not to the page. Overview runs well past 100vh and a rail that scrolls
          away takes the nav and the health dot with it. h-screen + self-start keeps flex from stretching
          it to the full document height, which is what silently breaks sticky. */}
      <nav className="a-rail sticky top-0 hidden h-screen w-[232px] shrink-0 flex-col justify-between self-start overflow-y-auto p-3 lg:flex">
        <div className="flex min-h-0 flex-col gap-1">
          <Brand />
          <span className="a-label mb-1 mt-4 px-3">Dashboard</span>
          {NAV.map((item) => (
            <NavLink key={item.to} item={item} pathname={location.pathname} />
          ))}
        </div>
        <ShellFooter username={user?.username ?? null} />
      </nav>

      {/* Mobile keeps the nav as a plain strip: Errors is the one page worth triaging from a phone. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className="sticky top-0 z-20 flex items-center gap-1 overflow-x-auto border-b px-2 py-2 lg:hidden"
          style={{ background: 'var(--a-surface)', borderColor: 'var(--a-border)' }}
        >
          <HealthDot />
          {NAV.map((item) => (
            <NavLink key={item.to} item={item} pathname={location.pathname} compact />
          ))}
        </div>
        <main className="mx-auto min-w-0 w-full max-w-[1600px] flex-1 p-4 lg:p-6">{children}</main>
      </div>
    </div>
  )
}

function NavLink({ item, pathname, compact }: { item: (typeof NAV)[number]; pathname: string; compact?: boolean }) {
  const Icon = item.icon
  return (
    <Link to={item.to} className="a-nav-item" data-active={isActive(pathname, item.to)} title={compact ? item.label : item.hint}>
      <Icon size={16} strokeWidth={2.3} className="a-nav-icon" />
      {item.label}
    </Link>
  )
}

// The wordmark block. A small amber cartridge tile, the network, and the health readout, so "which
// chain am I looking at" is answered before you read a single number.
function Brand() {
  const q = useQuery(pingQuery())
  return (
    <div className="flex items-center gap-2.5 px-1 pt-1">
      <span className="a-brandmark" aria-hidden>
        P
      </span>
      <span className="flex min-w-0 flex-col">
        <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: '-0.01em' }}>PIPS admin</span>
        <span className="flex items-center gap-1.5">
          <HealthDot />
          <span className="a-label truncate">{q.data?.network ?? 'connecting'}</span>
        </span>
      </span>
    </div>
  )
}

// Exact match for the index route, prefix match for the rest, so /admin does not light up on /admin/errors.
function isActive(pathname: string, to: string): boolean {
  const p = pathname.replace(/\/$/, '') || '/admin'
  return to === '/admin' ? p === '/admin' : p.startsWith(to)
}

// One dot for "is it up and is it well". It carries the ops verdict too, because a green dot above a red
// banner is the kind of small contradiction that teaches people not to trust either.
function HealthDot() {
  const q = useQuery(pingQuery())
  const ops = useQuery(opsQuery())

  const worst = ops.data?.worst ?? 'ok'
  const color = q.isPending
    ? 'var(--a-text-muted)'
    : q.isError || worst === 'critical'
      ? 'var(--a-critical)'
      : worst === 'warn'
        ? 'var(--a-warn)'
        : 'var(--a-ok)'
  const label = q.isPending
    ? 'Checking the API'
    : q.isError
      ? 'API unreachable or access revoked'
      : worst === 'ok'
        ? `Healthy (${q.data?.network})`
        : `${worst === 'critical' ? 'Critical' : 'Degraded'}: see the Overview banner`
  return <span className="a-dot" style={{ background: color, color }} title={label} aria-label={label} />
}

// Settings opens from here as a drawer, deliberately not a fifth page: it is a config surface you visit
// twice a month, and giving it a nav slot would put it next to four pages you read daily.
function ShellFooter({ username }: { username: string | null }) {
  const q = useQuery(pingQuery())
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-1">
      {q.data && !q.data.analyticsEnabled && (
        <span className="a-badge a-badge-warn mx-3 mb-1 self-start" title="Ingest is off, so Usage will look empty">
          analytics off
        </span>
      )}
      <button type="button" className="a-nav-item w-full text-left" onClick={() => setOpen(true)}>
        <Settings2 size={16} strokeWidth={2.3} className="a-nav-icon" />
        Settings
      </button>
      <Link to="/games" className="a-nav-item">
        <LogOut size={16} strokeWidth={2.3} className="a-nav-icon" />
        Back to PIPS
      </Link>
      {username && (
        <span className="mt-1 border-t px-3 pb-1 pt-2.5" style={{ borderColor: 'var(--a-border)', color: 'var(--a-text-muted)', fontSize: 11.5 }}>
          signed in as @{username}
        </span>
      )}
      {open && <SettingsDrawer onClose={() => setOpen(false)} />}
    </div>
  )
}
