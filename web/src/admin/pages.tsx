// Overview and Performance. Four pages total, and this file holds the two that are mostly numbers, so the
// shared formatters live in one place instead of drifting apart across two files.

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { OpsBanner } from './components/OpsBanner'
import {
  DesktopOnlyNotice,
  EmptyState,
  ErrorState,
  LatencyChart,
  LoadingState,
  Metric,
  Panel,
  Sparkline,
  When,
} from './components/primitives'
import { overviewQuery, perfQuery } from './queries'
import type { OverviewReport, PerfReport, WalletBalance } from './types'

const num = (n: number | null | undefined, digits = 0): string =>
  n == null ? '--' : n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })

const usd = (n: number | null | undefined): string => (n == null ? '--' : `$${num(n, 2)}`)
const pct = (n: number | null | undefined): string => (n == null ? '--' : `${num(n, 1)}%`)
const ms = (n: number | null | undefined): string => (n == null ? '--' : `${num(Math.round(n))}ms`)

export function OverviewPage() {
  const q = useQuery(overviewQuery())

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="a-page-title">Overview</h1>
        {q.data && (
          <span style={{ color: 'var(--a-text-3)', fontSize: 12 }}>
            as of <When iso={q.data.generatedAt} />
          </span>
        )}
      </div>
      <DesktopOnlyNotice page="Overview" />
      <OpsBanner />

      {q.isPending && <LoadingState label="Reading users, plays, money, and chain" />}
      {q.isError && <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />}
      {q.data && <OverviewBody data={q.data} />}
    </div>
  )
}

function OverviewBody({ data }: { data: OverviewReport }) {
  const { users, plays, money, chain, sparklines } = data
  const balances = money.balances

  return (
    <>
      <Section label="Users">
        <Metric label="Total" value={num(users.total)} hint={`${num(users.newToday)} today, ${num(users.new7d)} this week`} />
        <Metric label="DAU" value={num(users.dau)} hint="played today" />
        <Metric label="WAU" value={num(users.wau)} hint="played in 7 days" />
        <Metric label="Onboarded" value={pct(users.onboardedPct)} hint="picked a username" />
        <Metric label="Returning" value={pct(users.returningPct)} hint="signed in this week" />
      </Section>

      <Section label="Plays, last 7 days">
        <Metric label="Today" value={num(plays.today)} hint={`${num(plays.plays)} this week, ${num(plays.settled)} settled`} />
        <Metric label="Volume" value={usd(plays.volume)} hint="entry cost on settled plays" />
        <Metric label="Win rate" value={pct(plays.winRatePct)} hint={`avg stake ${usd(plays.avgStake)}`} />
        <Metric
          label="Net house PnL"
          value={usd(plays.netHousePnl)}
          tone={plays.netHousePnl < 0 ? 'critical' : undefined}
          hint="counterparty is the Predict vault, not us"
        />
        <Metric label="Rake" value={usd(plays.rake)} hint={`avg multiplier ${plays.avgMultiplier == null ? '--' : `${num(plays.avgMultiplier, 2)}x`}`} />
      </Section>

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="Plays per game, 7 days">
          {plays.byGame.length === 0 ? (
            <EmptyState title="No plays in the last 7 days" hint="Not an outage on its own, but check the Errors page if you expected traffic." />
          ) : (
            <table className="a-table">
              <thead>
                <tr>
                  <th>Game</th>
                  <th className="a-num">Plays</th>
                  <th className="a-num">Volume</th>
                </tr>
              </thead>
              <tbody>
                {plays.byGame.map((g) => (
                  <tr key={g.game}>
                    <td style={{ color: 'var(--a-text)' }}>{g.game}</td>
                    <td className="a-num">{num(g.plays)}</td>
                    <td className="a-num">{usd(g.volume)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="14 days">
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <span className="a-label">Plays per day</span>
              <Sparkline data={sparklines.plays} />
            </div>
            <div className="flex flex-col gap-1">
              <span className="a-label">Errors per day</span>
              <Sparkline data={sparklines.errors} tone="var(--a-critical)" />
            </div>
          </div>
        </Panel>
      </div>

      <Section label="Money, last 7 days">
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
        <Metric label="Chips out" value={usd(money.withdrawals.amount)} hint={`${num(money.withdrawals.count)} DUSDC transfers off account`} />
        <Metric label="Faucet out" value={usd(money.faucetOut)} hint="DUSDC via the faucet" />
        <Metric label="Grants out" value={usd(money.grantOut)} hint="starter and top-up chips" />
        <Metric
          label="Deposits"
          value={num(money.depositsByChain.reduce((sum, d) => sum + d.count, 0))}
          hint={money.depositsByChain.map((d) => `${d.chain} ${d.done}/${d.count}`).join(', ') || 'none this week'}
        />
      </Section>

      <Section label="Chain">
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

      <Panel title="Ops wallets">
        {chain.wallets.length === 0 ? (
          <EmptyState title="Balances have not been swept yet" hint="The sweep runs every 15 minutes and writes one row." />
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
        <td style={{ color: 'var(--a-text)' }}>{wallet.name}</td>
        <td colSpan={3} style={{ color: 'var(--a-text-3)' }}>
          not configured
        </td>
      </tr>
    )
  }
  return (
    <tr>
      <td style={{ color: 'var(--a-text)' }}>{wallet.name}</td>
      <td title={wallet.address} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5 }}>
        {`${wallet.address.slice(0, 10)}...${wallet.address.slice(-6)}`}
      </td>
      <td className="a-num">{num(wallet.sui, 3)}</td>
      <td className="a-num">{wallet.dusdc == null ? '' : num(wallet.dusdc, 2)}</td>
    </tr>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="a-label">{label}</span>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{children}</div>
    </div>
  )
}

const WINDOWS = [1, 6, 24, 168] as const

export function PerfPage() {
  const [hours, setHours] = useState<number>(6)
  const q = useQuery(perfQuery(hours))

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="a-page-title">Performance</h1>
        <div className="flex items-center gap-2">
          <span className="a-label">Window</span>
          <select className="a-select" value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Time window">
            {WINDOWS.map((h) => (
              <option key={h} value={h}>
                {h < 24 ? `${h}h` : `${h / 24}d`}
              </option>
            ))}
          </select>
        </div>
      </div>
      <DesktopOnlyNotice page="Performance" />

      {q.isPending && <LoadingState label="Reading play timings and worker health" />}
      {q.isError && <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />}
      {q.data && <PerfBody data={q.data} />}
    </div>
  )
}

function PerfBody({ data }: { data: PerfReport }) {
  return (
    <>
      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title={`Mint latency, ${data.mint.n} mints`}>
          <div className="flex flex-col gap-2 p-4">
            <div className="flex gap-6">
              <Stat label="p50" value={ms(data.mint.p50)} />
              <Stat label="p95" value={ms(data.mint.p95)} accent />
            </div>
            <LatencyChart data={data.mint.series} />
          </div>
        </Panel>
        <Panel title={`Settle lag, ${data.settle.n} settles`}>
          <div className="flex flex-col gap-2 p-4">
            <div className="flex gap-6">
              <Stat label="p50" value={ms(data.settle.p50)} />
              <Stat label="p95" value={ms(data.settle.p95)} accent />
            </div>
            <LatencyChart data={data.settle.series} />
          </div>
        </Panel>
      </div>

      <Panel title="Route latency, since this instance booted">
        {data.routes.length === 0 ? (
          <EmptyState title="No requests recorded yet" hint="The ring fills as traffic arrives and resets on restart." />
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
                  <td style={{ color: 'var(--a-text)', fontFamily: 'ui-monospace, monospace', fontSize: 11.5 }}>{r.route}</td>
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

      <Panel title="Workers">
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
                <td style={{ color: 'var(--a-text)' }}>{w.name}</td>
                <td>
                  <span className={`a-badge ${w.stale ? 'a-badge-critical' : 'a-badge-ok'}`}>{w.stale ? 'stale' : 'running'}</span>
                </td>
                <td className="a-num">{w.intervalMs == null ? 'event' : formatCadence(w.intervalMs)}</td>
                <td className="a-num">{w.lastRunAt ? <When iso={new Date(w.lastRunAt).toISOString()} /> : 'never'}</td>
                <td className="a-num">{ms(w.lastDurationMs)}</td>
                <td style={{ color: w.lastError ? 'var(--a-critical)' : 'var(--a-text-3)' }} className="max-w-[28ch] truncate" title={w.lastError ?? ''}>
                  {w.lastError ?? 'none'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="a-label">{label}</span>
      <span style={{ fontSize: 20, fontWeight: 600, color: accent ? 'var(--a-accent)' : 'var(--a-text)' }}>{value}</span>
    </div>
  )
}

function formatCadence(intervalMs: number): string {
  if (intervalMs < 1000) return `${intervalMs}ms`
  if (intervalMs < 60_000) return `${Math.round(intervalMs / 1000)}s`
  if (intervalMs < 3_600_000) return `${Math.round(intervalMs / 60_000)}m`
  return `${Math.round(intervalMs / 3_600_000)}h`
}
