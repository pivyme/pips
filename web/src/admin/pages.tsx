// Overview, Usage, and Performance. Their data sources land with the analytics ingest, the detectors, and
// the latency queries; until then each page says exactly what it is waiting on rather than rendering an
// empty chart, which reads as "nothing is happening" instead of "this is not wired yet".

import { Link } from '@tanstack/react-router'

import { DesktopOnlyNotice, Panel } from './components/primitives'

export function OverviewPage() {
  return (
    <Pending
      title="Overview"
      lead="The ten-second page: health banner, users, plays, money, and chain."
      waitingOn="the ops detectors and the business aggregates"
    />
  )
}

export function PerfPage() {
  return (
    <Pending
      title="Performance"
      lead="Mint latency, settle lag, per-route p95, and worker health."
      waitingOn="the latency queries over the play timestamps we already record"
    />
  )
}

function Pending({ title, lead, waitingOn }: { title: string; lead: string; waitingOn: string }) {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="a-page-title">{title}</h1>
      <DesktopOnlyNotice page={title} />
      <Panel>
        <div className="flex flex-col gap-2 p-4">
          <p style={{ color: 'var(--a-text-2)' }}>{lead}</p>
          <p style={{ color: 'var(--a-text-3)' }}>Waiting on {waitingOn}.</p>
          <Link to="/admin/errors" className="a-btn mt-1 w-fit">
            Go to Errors
          </Link>
        </div>
      </Panel>
    </div>
  )
}
