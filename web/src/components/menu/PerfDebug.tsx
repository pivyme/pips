// The perf bisect UI: a HUD chip and a panel of kill switches for the menu slide. Mounted from
// MenuDrawer so it survives every menu route change and sits outside the snapshotted surface.
// Unlocked by tapping the drawer title 5 times; invisible (and idle) otherwise.
import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  FAST_MODE,
  PERF_ROWS,
  SLIDE_DEFAULT_MS,
  SLIDE_OPTIONS,
  isPerfPanelOpen,
  isPerfUnlocked,
  perfFps,
  perfIdle,
  perfLastNav,
  perfLastTap,
  perfOn,
  perfSlideMs,
  perfVersion,
  setPerfFlag,
  setPerfFlags,
  setPerfPanelOpen,
  setPerfSlideMs,
  subscribePerf,
} from '@/lib/perfDebug'

function usePerf() {
  return useSyncExternalStore(subscribePerf, perfVersion, () => 0)
}

export function PerfDebug() {
  usePerf()
  if (!isPerfUnlocked()) return null
  // Always visible once unlocked: a stripped app is not the real app, and forgetting a switch is off is
  // how you end up chasing a bug you introduced.
  const stripped = PERF_ROWS.filter((r) => perfOn(r.flag)).length
  if (isPerfPanelOpen()) return <PerfPanel />
  return <PerfHud stripped={stripped} />
}

// Splits a tap into the three things that can own the wait: the main thread being blocked before we get
// the event at all (input), the route commit (dom), and the slide (worst frame). Read it off the phone.
function PerfHud({ stripped }: { stripped: number }) {
  const [, setBeat] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setBeat((n) => n + 1), 250)
    return () => window.clearInterval(id)
  }, [])
  const t = perfLastTap()
  const idle = perfIdle()
  return (
    <button
      type="button"
      onClick={() => setPerfPanelOpen(true)}
      className="fixed left-2 top-[max(0.5rem,env(safe-area-inset-top))] z-[60] rounded-lg bg-black/85 px-2 py-1.5 text-left font-mono text-[10px] leading-[1.4] text-white/70 ring-1 ring-white/15"
    >
      <div>
        <span className="text-white">{perfFps()} fps</span>
        {idle && (
          <>
            {' · idle '}
            <Ms v={idle.worst} bad={120} />
          </>
        )}
        {stripped > 0 && <span className="font-bold text-brand-500"> · {stripped} OFF</span>}
      </div>
      {t ? (
        <>
          <div className="text-white">tap {t.what}</div>
          <div>
            input <Ms v={t.input} /> · click <Ms v={t.click} /> · dom{' '}
            {t.dom < 0 ? <span className="text-white/40">none</span> : <Ms v={t.dom} />}
          </div>
          <div>
            worst <Ms v={t.worst} bad={120} /> · {t.fps} fps
          </div>
        </>
      ) : (
        <div className="text-white/40">tap something</div>
      )}
    </button>
  )
}

// Red once it is past the point you would feel it.
function Ms({ v, bad = 100 }: { v: number; bad?: number }) {
  return <span className={v >= bad ? 'font-bold text-down' : 'text-up'}>{v}ms</span>
}

function PerfPanel() {
  const nav = perfLastNav()
  const fast = FAST_MODE.every((f) => perfOn(f))
  return (
    <div className="fixed inset-x-2 bottom-2 z-[60] max-h-[76vh] overflow-y-auto overscroll-contain rounded-2xl bg-[#0c0c0e] p-3 shadow-[0_-20px_60px_-20px_rgba(0,0,0,1)] ring-1 ring-white/12">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[11px] uppercase tracking-widest text-white/45">Perf bisect</div>
        <button
          type="button"
          onClick={() => setPerfPanelOpen(false)}
          className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-white"
        >
          Close
        </button>
      </div>

      <p className="mt-2 font-mono text-[10.5px] leading-relaxed text-white/45">
        Turn one off, close this, tap a few menu tiles, reopen. Whichever switch makes the slide smooth is
        the one costing frames.
      </p>

      <div className="mt-2 rounded-xl bg-white/[0.05] px-3 py-2 font-mono text-[11px] text-white/70">
        {nav ? (
          <>
            last nav <span className="text-white">{nav.fps} fps</span> · {nav.frames} frames · worst{' '}
            <span className={nav.worst > 50 ? 'text-down' : 'text-up'}>{nav.worst}ms</span>
          </>
        ) : (
          'last nav: none yet'
        )}
      </div>

      <div className="mt-3">
        <div className="text-[13px] font-semibold text-white">Slide length</div>
        <div className="mt-0.5 font-mono text-[10px] text-white/40">
          Pure feel. The slide starts on the frame after the tap, so this is the whole wait.
        </div>
        <div className="mt-2 flex gap-1.5">
          {SLIDE_OPTIONS.map((ms) => (
            <button
              key={ms}
              type="button"
              onClick={() => setPerfSlideMs(ms)}
              className={`flex-1 rounded-lg py-2 font-mono text-[11px] font-bold ${
                perfSlideMs() === ms ? 'bg-brand-500 text-black' : 'bg-white/10 text-white/70'
              }`}
            >
              {ms}
              {ms === SLIDE_DEFAULT_MS ? '*' : ''}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 divide-y divide-white/[0.07]">
        {PERF_ROWS.map((row) => (
          <Row
            key={row.flag}
            label={row.label}
            hint={row.hint}
            // The switch reads as the feature, so on = shipped behaviour and off = stripped.
            on={!perfOn(row.flag)}
            onChange={(on) => setPerfFlag(row.flag, !on)}
          />
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => setPerfFlags(fast ? [] : FAST_MODE)}
          className="flex-1 rounded-xl bg-white/10 py-2 text-xs font-bold text-white"
        >
          {fast ? 'Undo fast mode' : 'Fast mode'}
        </button>
        <button
          type="button"
          onClick={() => setPerfFlags([])}
          className="rounded-xl bg-white/10 px-4 py-2 text-xs font-bold text-white/70"
        >
          Reset
        </button>
      </div>
      <p className="mt-2 font-mono text-[10px] leading-relaxed text-white/35">
        Fast mode strips every top suspect at once. Smooth with it on means the cause is in that set, then
        switch them back one at a time to find it.
      </p>
    </div>
  )
}

function Row({
  label,
  hint,
  on,
  onChange,
}: {
  label: string
  hint: string
  on: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="flex w-full items-center gap-3 py-2.5 text-left"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-white">{label}</span>
        <span className="block truncate font-mono text-[10px] text-white/40">{hint}</span>
      </span>
      <span
        className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${on ? 'bg-up' : 'bg-white/15'}`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${on ? 'translate-x-[1.125rem]' : 'translate-x-0.5'}`}
        />
      </span>
    </button>
  )
}
