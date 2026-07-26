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
  const { data, isPending, error } = useQuery(opsQuery())

  if (isPending || error || !data) return null
  return <Banner snapshot={data} />
}

function Banner({ snapshot }: { snapshot: OpsSnapshot }) {
  const tone = TONE[snapshot.worst] ?? TONE.ok!
  const bad = snapshot.detectors.filter((d) => d.level !== 'ok')
  const checked = snapshot.checkedAt

  return (
    <section className="a-panel-flush" style={{ borderColor: bad.length ? tone.color : undefined }}>
      <header className="flex h-8 items-center justify-between border-b border-[var(--a-border)] px-3">
        <span className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: tone.color }} aria-hidden />
          <span className="a-label" style={{ color: tone.color }}>
            {tone.label}
          </span>
          <span style={{ color: 'var(--a-text-3)', fontSize: 12 }}>
            {bad.length ? `${bad.length} of ${snapshot.detectors.length} detectors firing` : `all ${snapshot.detectors.length} detectors clear`}
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
    <li className="flex gap-3 border-b border-[var(--a-border)] px-3 py-2 last:border-b-0">
      <span className="a-badge shrink-0" style={{ color, background: 'color-mix(in srgb, currentColor 12%, transparent)' }}>
        {detector.level}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span style={{ color: 'var(--a-text)' }}>{detector.title}</span>
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
