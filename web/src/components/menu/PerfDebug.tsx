// The perf bisect UI: a HUD chip and a panel of kill switches for the menu slide. Mounted from
// MenuDrawer so it survives every menu route change and sits outside the snapshotted surface.
// Unlocked by tapping the drawer title 5 times; invisible (and idle) otherwise.
import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  FAST_MODE,
  PERF_ROWS,
  isPerfPanelOpen,
  isPerfUnlocked,
  perfFps,
  perfLastNav,
  perfOn,
  perfVersion,
  setPerfFlag,
  setPerfFlags,
  setPerfPanelOpen,
  subscribePerf,
} from '@/lib/perfDebug'

function usePerf() {
  return useSyncExternalStore(subscribePerf, perfVersion, () => 0)
}

export function PerfDebug() {
  usePerf()
  if (!isPerfUnlocked()) return null
  return (
    <>
      {perfOn('hud') && !isPerfPanelOpen() && <PerfHud />}
      {isPerfPanelOpen() && <PerfPanel />}
    </>
  )
}

// Live fps + the last nav's worst frame, so you can navigate with the panel closed and read it after.
function PerfHud() {
  const [, setBeat] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setBeat((n) => n + 1), 250)
    return () => window.clearInterval(id)
  }, [])
  const nav = perfLastNav()
  return (
    <button
      type="button"
      onClick={() => setPerfPanelOpen(true)}
      className="fixed left-2 top-[max(0.5rem,env(safe-area-inset-top))] z-[60] rounded-lg bg-black/80 px-2 py-1 text-left font-mono text-[10px] leading-tight text-white/80 ring-1 ring-white/15"
    >
      <span className="text-white">{perfFps()} fps</span>
      {nav && <span className="text-white/50"> · nav {nav.fps}fps worst {nav.worst}ms</span>}
    </button>
  )
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

      <div className="mt-2 divide-y divide-white/[0.07]">
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
        <Row
          label="Show HUD"
          hint="Live fps chip, tap it to reopen this"
          on={perfOn('hud')}
          onChange={(on) => setPerfFlag('hud', on)}
        />
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
