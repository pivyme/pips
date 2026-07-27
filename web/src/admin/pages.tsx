// Overview and Performance. Four pages total, and this file holds the two that are mostly numbers, so the
// shared formatters live in one place instead of drifting apart across two files.

import { useQuery } from '@tanstack/react-query'
import { Activity, Coins, Cpu, Gamepad2, Link2, RefreshCw, Route as RouteIcon, TrendingUp, Users, Wallet } from 'lucide-react'
import { useState } from 'react'

import { GameIcon } from '@/components/GameIcon'
import { OpsBanner } from './components/OpsBanner'
import {
  Bar,
  DesktopOnlyNotice,
  EmptyState,
  ErrorState,
  LatencyChart,
  LoadingState,
  Metric,
  PageHeader,
  Panel,
  Segmented,
  Sparkline,
  When,
} from './components/primitives'
import { overviewQuery, perfQuery } from './queries'
import type { OverviewReport, PerfReport, WalletBalance } from './types'

const num = (n: number | null | undefined, digits = 0): string =>
  n == null ? '--' : n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })

// Sign outside the symbol: "$-1,284.62" is not how anyone writes a loss.
const usd = (n: number | null | undefined): string => (n == null ? '--' : `${n < 0 ? '-' : ''}$${num(Math.abs(n), 2)}`)
const pct = (n: number | null | undefined): string => (n == null ? '--' : `${num(n, 1)}%`)
const ms = (n: number | null | undefined): string => (n == null ? '--' : `${num(Math.round(n))}ms`)

export function OverviewPage() {
  const q = useQuery(overviewQuery())

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Overview"
        sub={
          q.data ? (
            <>
              as of <When iso={q.data.generatedAt} />
            </>
          ) : (
            'Users, plays, money, and chain in one read'
          )
        }
      >
        <button type="button" className="a-btn" onClick={() => void q.refetch()} disabled={q.isFetching}>
          <RefreshCw size={13} strokeWidth={2.5} className={q.isFetching ? 'animate-spin' : undefined} />
          Refresh
        </button>
      </PageHeader>
      <DesktopOnlyNotice page="Overview" />
      <OpsBanner />

      {q.isPending && (
        <Panel title="Reading users, plays, money, and chain" icon={Activity}>
          <LoadingState label="Reading users, plays, money, and chain" rows={6} />
        </Panel>
      )}
      {q.isError && (
        <Panel title="Overview" icon={Activity}>
          <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />
        </Panel>
      )}
      {q.data && <OverviewBody data={q.data} />}
    </div>
  )
}

function OverviewBody({ data }: { data: OverviewReport }) {
  const { users, plays, money, chain, sparklines } = data
  const balances = money.balances
  const maxGame = Math.max(1, ...plays.byGame.map((g) => g.plays))

  return (
    <>
      <Section label="Users" icon={Users}>
        <Metric label="Total" value={num(users.total)} hint={`${num(users.newToday)} today, ${num(users.new7d)} this week`} />
        <Metric label="DAU" value={num(users.dau)} hint="played today" />
        <Metric label="WAU" value={num(users.wau)} hint="played in 7 days" />
        <Metric label="Onboarded" value={pct(users.onboardedPct)} hint="picked a username" />
        <Metric label="Returning" value={pct(users.returningPct)} hint="signed in this week" />
      </Section>

      <Section label="Plays, last 7 days" icon={Gamepad2}>
        <Metric label="Today" value={num(plays.today)} hint={`${num(plays.plays)} this week, ${num(plays.settled)} settled`} />
        <Metric label="Volume" value={usd(plays.volume)} hint="entry cost on settled plays" />
        <Metric label="Win rate" value={pct(plays.winRatePct)} hint={`avg stake ${usd(plays.avgStake)}`} />
        <Metric
          label="Net house PnL"
          value={usd(plays.netHousePnl)}
          tone={plays.netHousePnl < 0 ? 'critical' : 'ok'}
          hint="counterparty is the Predict vault, not us"
        />
        <Metric
          label="Rake"
          value={usd(plays.rake)}
          hint={`avg multiplier ${plays.avgMultiplier == null ? '--' : `${num(plays.avgMultiplier, 2)}x`}`}
        />
      </Section>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Panel title="Plays per game" icon={Gamepad2} note="7 days">
          {plays.byGame.length === 0 ? (
            <EmptyState
              icon={Gamepad2}
              title="No plays in the last 7 days"
              hint="Not an outage on its own, but check the Errors page if you expected traffic."
            />
          ) : (
            <table className="a-table">
              <thead>
                <tr>
                  <th>Game</th>
                  <th style={{ width: '34%' }}>Share</th>
                  <th className="a-num">Plays</th>
                  <th className="a-num">Volume</th>
                </tr>
              </thead>
              <tbody>
                {plays.byGame.map((g) => (
                  <tr key={g.game}>
                    <td className="a-key">
                      <span className="flex items-center gap-2">
                        <GameIcon game={g.game} size={14} />
                        <span className="capitalize">{g.game}</span>
                      </span>
                    </td>
                    <td>
                      <Bar fraction={g.plays / maxGame} tone="accent" />
                    </td>
                    <td className="a-num">{num(g.plays)}</td>
                    <td className="a-num">{usd(g.volume)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Last 14 days" icon={TrendingUp}>
          <div className="grid gap-5 p-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <span className="a-label">Plays per day</span>
              <Sparkline data={sparklines.plays} />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="a-label">Errors per day</span>
              <Sparkline data={sparklines.errors} tone="var(--a-critical)" />
            </div>
          </div>
        </Panel>
      </div>

      <Section label="Money, last 7 days" icon={Coins}>
        <Metric
          label="User chips"
          value={balances?.userChips == null ? '--' : usd(balances.userChips)}
          hint={
            balances ? (
              <>
                {balances.partial ?? `${num(balances.userCount)} wallets`}, as of <When iso={balances.asOf} />
              </>
            ) : (
              'the 15-minute sweep has not run yet'
            )
          }
        />
        <Metric label="Withdrawals" value={num(money.withdrawals.count)} hint={`${usd(money.withdrawals.amount)} sent out`} />
        <Metric label="Faucet out" value={usd(money.faucetOut)} hint="DUSDC via the faucet" />
        <Metric label="Grants out" value={usd(money.grantOut)} hint="starter and top-up chips" />
        <Metric
          label="Deposits"
          value={num(money.depositsByChain.reduce((sum, d) => sum + d.count, 0))}
          hint={money.depositsByChain.map((d) => `${d.chain} ${d.done}/${d.count}`).join(', ') || 'none this week'}
        />
      </Section>

      <Section label="Chain" icon={Link2} cols={3}>
        <Metric
          label="Live markets"
          value={num(chain.liveMarkets)}
          tone={chain.liveMarkets === 0 ? 'critical' : undefined}
          hint={chain.liveMarkets === 0 ? 'nothing tradeable right now' : chain.network}
        />
        <Metric label="Gas burned today" value={`${num(chain.gasBurnedToday, 3)} SUI`} hint="measured from sponsor balance drops" />
        <Metric
          label="Cost per play"
          value={chain.costPerPlaySui == null ? '--' : `${num(chain.costPerPlaySui, 4)} SUI`}
          hint={chain.costPerPlaySui == null ? 'no plays today' : 'today, gas only'}
        />
      </Section>

      <Panel title="Ops wallets" icon={Wallet}>
        {chain.wallets.length === 0 ? (
          <EmptyState icon={Wallet} title="Balances have not been swept yet" hint="The sweep runs every 15 minutes and writes one row." />
        ) : (
          <table className="a-table">
            <thead>
              <tr>
                <th>Wallet</th>
                <th>Address</th>
                <th className="a-num">SUI</th>
                <th className="a-num">DUSDC</th>
              </tr>
            </thead>
            <tbody>
              {chain.wallets.map((w) => (
                <WalletRow key={w.name} wallet={w} />
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  )
}

function WalletRow({ wallet }: { wallet: WalletBalance }) {
  if (!wallet.address) {
    return (
      <tr>
        <td className="a-key">{wallet.name}</td>
        <td colSpan={3} style={{ color: 'var(--a-text-3)' }}>
          not configured
        </td>
      </tr>
    )
  }
  return (
    <tr>
      <td className="a-key">{wallet.name}</td>
      <td className="a-mono" title={wallet.address}>
        {`${wallet.address.slice(0, 10)}...${wallet.address.slice(-6)}`}
      </td>
      <td className="a-num">{num(wallet.sui, 3)}</td>
      {/* A blank cell reads as zero. This wallet is not meant to hold chips, so say that. */}
      <td className="a-num" style={wallet.dusdc == null ? { color: 'var(--a-text-muted)' } : undefined} title={wallet.dusdc == null ? 'Not a chip-holding wallet' : undefined}>
        {wallet.dusdc == null ? 'n/a' : num(wallet.dusdc, 2)}
      </td>
    </tr>
  )
}

function Section({
  label,
  icon: Icon,
  cols = 5,
  children,
}: {
  label: string
  icon: typeof Users
  cols?: 3 | 5
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="flex items-center gap-1.5">
        <Icon size={12} strokeWidth={2.6} style={{ color: 'var(--a-text-muted)' }} />
        <span className="a-label">{label}</span>
      </span>
      <div className={cols === 3 ? 'grid gap-4 sm:grid-cols-2 xl:grid-cols-3' : 'grid gap-4 sm:grid-cols-2 xl:grid-cols-5'}>{children}</div>
    </div>
  )
}

const WINDOWS = [
  { value: 1, label: '1h' },
  { value: 6, label: '6h' },
  { value: 24, label: '24h' },
  { value: 168, label: '7d' },
]

export function PerfPage() {
  const [hours, setHours] = useState<number>(6)
  const q = useQuery(perfQuery(hours))

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Performance" sub="How long a play takes end to end, and whether the workers behind it are alive.">
        <Segmented value={hours} options={WINDOWS} onChange={setHours} label="Time window" />
      </PageHeader>
      <DesktopOnlyNotice page="Performance" />

      {q.isPending && (
        <Panel title="Reading play timings and worker health" icon={Cpu}>
          <LoadingState label="Reading play timings and worker health" rows={6} />
        </Panel>
      )}
      {q.isError && (
        <Panel title="Performance" icon={Cpu}>
          <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />
        </Panel>
      )}
      {q.data && <PerfBody data={q.data} />}
    </div>
  )
}

function PerfBody({ data }: { data: PerfReport }) {
  const stale = data.workers.filter((w) => w.stale).length

  return (
    <>
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Mint latency" icon={Activity} note={`${data.mint.n} mints`}>
          <div className="flex flex-col gap-3 p-4">
            <div className="flex gap-8">
              <Stat label="p50" value={ms(data.mint.p50)} />
              <Stat label="p95" value={ms(data.mint.p95)} accent />
            </div>
            <LatencyChart data={data.mint.series} />
          </div>
        </Panel>
        <Panel title="Settle lag" icon={Activity} note={`${data.settle.n} settles`}>
          <div className="flex flex-col gap-3 p-4">
            <div className="flex gap-8">
              <Stat label="p50" value={ms(data.settle.p50)} />
              <Stat label="p95" value={ms(data.settle.p95)} accent />
            </div>
            <LatencyChart data={data.settle.series} />
          </div>
        </Panel>
      </div>

      <Panel title="Route latency" icon={RouteIcon} note="since this instance booted">
        {data.routes.length === 0 ? (
          <EmptyState icon={RouteIcon} title="No requests recorded yet" hint="The ring fills as traffic arrives and resets on restart." />
        ) : (
          <table className="a-table">
            <thead>
              <tr>
                <th>Route</th>
                <th className="a-num">Requests</th>
                <th className="a-num">p50</th>
                <th className="a-num">p95</th>
                <th className="a-num">Max</th>
              </tr>
            </thead>
            <tbody>
              {data.routes.map((r) => (
                <tr key={r.route}>
                  <td className="a-key a-mono a-cell-fill truncate" title={r.route}>
                    {r.route}
                  </td>
                  <td className="a-num">{num(r.n)}</td>
                  <td className="a-num">{ms(r.p50)}</td>
                  <td className="a-num">{ms(r.p95)}</td>
                  <td className="a-num">{ms(r.max)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel
        title="Workers"
        icon={Cpu}
        note={data.workers.length === 0 ? 'none registered' : stale ? `${stale} stale` : `all ${data.workers.length} running`}
        action={
          <span className={`a-badge ${data.workers.length === 0 || stale ? 'a-badge-critical' : 'a-badge-ok'}`}>
            {data.workers.length === 0 ? 'nothing running' : stale ? 'attention' : 'healthy'}
          </span>
        }
      >
        {data.workers.length === 0 ? (
          // An empty worker table would otherwise read as "all clear" when it means settle, market sync,
          // and retention are all dead.
          <EmptyState
            icon={Cpu}
            title="No workers registered on this instance"
            hint="Nothing is settling plays, syncing markets, or pruning analytics. Check the API logs for a boot failure."
          />
        ) : (
        <table className="a-table">
          <thead>
            <tr>
              <th>Worker</th>
              <th>State</th>
              <th className="a-num">Cadence</th>
              <th className="a-num">Last run</th>
              <th className="a-num">Duration</th>
              <th>Last error</th>
            </tr>
          </thead>
          <tbody>
            {data.workers.map((w) => (
              <tr key={w.name}>
                <td className="a-key">{w.name}</td>
                <td>
                  <span className={`a-badge ${w.stale ? 'a-badge-critical' : 'a-badge-ok'}`}>{w.stale ? 'stale' : 'running'}</span>
                </td>
                <td className="a-num">{w.intervalMs == null ? 'event' : formatCadence(w.intervalMs)}</td>
                <td className="a-num">{w.lastRunAt ? <When iso={new Date(w.lastRunAt).toISOString()} /> : 'never'}</td>
                <td className="a-num">{ms(w.lastDurationMs)}</td>
                <td
                  style={{ color: w.lastError ? 'var(--a-critical)' : 'var(--a-text-3)' }}
                  className="max-w-[28ch] truncate"
                  title={w.lastError ?? ''}
                >
                  {w.lastError ?? 'none'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        )}
      </Panel>
    </>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="a-label">{label}</span>
      <span className="a-metric-sm" style={accent ? { color: 'var(--a-accent)' } : undefined}>
        {value}
      </span>
    </div>
  )
}

function formatCadence(intervalMs: number): string {
  if (intervalMs < 1000) return `${intervalMs}ms`
  if (intervalMs < 60_000) return `${Math.round(intervalMs / 1000)}s`
  if (intervalMs < 3_600_000) return `${Math.round(intervalMs / 60_000)}m`
  return `${Math.round(intervalMs / 3_600_000)}h`
}
