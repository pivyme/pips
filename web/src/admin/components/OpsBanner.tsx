// The health banner: red, amber, or green, worst first, with each detector's runbook rendered right next
// to it. The runbook is the point. An alert that tells you something is wrong and not what to do about it
// is a notification, and a team that gets notifications learns to close the tab.
//
// Reads the stored snapshot from the last cron sweep, so opening this page costs one row rather than
// twelve queries, and it can never show a different verdict from the one that already paged.

import { useQuery } from '@tanstack/react-query'

import { opsQuery } from '../queries'
import type { DetectorStatus, OpsSnapshot } from '../types'
import { When } from './primitives'

const TONE: Record<string, { color: string; label: string }> = {
  critical: { color: 'var(--a-critical)', label: 'Critical' },
  warn: { color: 'var(--a-warn)', label: 'Degraded' },
  ok: { color: 'var(--a-ok)', label: 'Healthy' },
}

export function OpsBanner() {
  const { data, isPending, error, refetch } = useQuery(opsQuery())

  if (isPending) return null
  // A missing banner reads as "healthy" at a glance, which is the worst thing it could say when the
  // health read itself is the thing that failed.
  if (error || !data) {
    return (
      <section className="a-panel-flush" style={{ borderColor: 'var(--a-warn)' }}>
        <header className="a-panel-head">
          <span className="flex items-center gap-2.5">
            <span className="a-dot" style={{ background: 'var(--a-warn)', color: 'var(--a-warn)' }} aria-hidden />
            <span className="a-section-title" style={{ color: 'var(--a-warn)' }}>
              Health unknown
            </span>
            <span style={{ color: 'var(--a-text-3)', fontSize: 12 }}>
              The detector sweep could not be read, so treat every number below as unverified.
            </span>
          </span>
          <button type="button" className="a-btn" onClick={() => void refetch()}>
            Try again
          </button>
        </header>
      </section>
    )
  }
  return <Banner snapshot={data} />
}

function Banner({ snapshot }: { snapshot: OpsSnapshot }) {
  const tone = TONE[snapshot.worst] ?? TONE.ok!
  const bad = snapshot.detectors.filter((d) => d.level !== 'ok')
  const checked = snapshot.checkedAt

  return (
    <section className="a-panel-flush" style={{ borderColor: bad.length ? tone.color : undefined }}>
      <header className="a-panel-head">
        <span className="flex items-center gap-2.5">
          <span className="a-dot" style={{ background: tone.color, color: tone.color }} aria-hidden />
          <span className="a-section-title" style={{ color: tone.color }}>
            {tone.label}
          </span>
          <span style={{ color: 'var(--a-text-3)', fontSize: 12 }}>
            {bad.length
              ? `${bad.length} of ${snapshot.detectors.length} detectors firing`
              : `all ${snapshot.detectors.length} detectors clear`}
          </span>
        </span>
        <span style={{ color: 'var(--a-text-3)', fontSize: 12 }}>
          checked <When iso={checked} />
        </span>
      </header>

      {bad.length > 0 && (
        <ul className="flex flex-col">
          {bad.map((d) => (
            <Row key={d.key} detector={d} />
          ))}
        </ul>
      )}
    </section>
  )
}

function Row({ detector }: { detector: DetectorStatus }) {
  const color = detector.level === 'critical' ? 'var(--a-critical)' : 'var(--a-warn)'
  return (
    <li className="flex gap-3 border-b border-[var(--a-border)] px-4 py-2.5 last:border-b-0">
      <span className="a-badge mt-0.5 shrink-0" style={{ color, background: 'color-mix(in srgb, currentColor 13%, transparent)' }}>
        {detector.level}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span style={{ color: 'var(--a-text)', fontWeight: 600 }}>{detector.title}</span>
          <span className="a-num" style={{ color }}>
            {detector.display}
          </span>
          {detector.detail && (
            <span className="truncate" style={{ color: 'var(--a-text-3)', fontSize: 12 }}>
              {detector.detail}
            </span>
          )}
        </div>
        <p className="mt-0.5" style={{ color: 'var(--a-text-2)', fontSize: 12 }}>
          {detector.runbook}
        </p>
      </div>
    </li>
  )
}
