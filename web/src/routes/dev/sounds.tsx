import { Link, createFileRoute } from '@tanstack/react-router'
import { Play, Square, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  achievementUnlock,
  chipsGranted,
  crowdPlace,
  depositLanded,
  hopLose,
  hopResetCombo,
  hopScore,
  luckyCashout,
  luckyLose,
  luckyWin,
  moonshotCashout,
  moonshotFire,
  moonshotFlip,
  moonshotLose,
  moonshotWin,
  rangeBuzzer,
  rangeCross,
  rangeLock,
  rangeLose,
  rangeWin,
  rideCrash,
  rideStart,
  setRideState,
  setSoundEnabled,
  slotLock,
  slotPick,
  slotSpin,
  slotTick,
  sound,
  startBgm,
  startLuckyBgm,
  startMoonshotBgm,
  startRangeBgm,
  startRideBgm,
  stopBgm,
  stopLuckyBgm,
  stopMoonshotBgm,
  stopRangeBgm,
  stopRideBgm,
  unlockAudio,
  welcomeJingle,
} from '@/lib/sound'
import { cnm } from '@/utils/style'

export const Route = createFileRoute('/dev/sounds')({ component: SoundLab })

// The whole synth catalog in one manifest, so every game's music + SFX is trackable here as we revamp it.
// `sound.ts` stays the engine; this page is the index + audition bench. Add a voice there, list it here.

type Tone = 'up' | 'down' | 'amber'
type Sfx = { id: string; label: string; desc?: string; tone?: Tone; play: () => void }
type Bed = { start: () => void; stop: () => void }
type Group = { id: string; name: string; vibe: string; bed?: Bed; sfx: Sfx[] }

const GROUPS: Group[] = [
  {
    id: 'app',
    name: 'App',
    vibe: 'Global jingles · onboarding, achievements, generic ding',
    sfx: [
      { id: 'welcome', label: 'Welcome', desc: 'C-major sparkle', tone: 'amber', play: welcomeJingle },
      { id: 'achieve', label: 'Achievement', desc: 'Cmaj9 fanfare', tone: 'amber', play: achievementUnlock },
      { id: 'chips', label: 'Chips granted', desc: 'coin plinks + bloom', tone: 'amber', play: chipsGranted },
      { id: 'deposit', label: 'Deposit landed', desc: 'F-major vault resolve', tone: 'up', play: depositLanded },
      { id: 'win', label: 'Win', desc: 'rising third', tone: 'up', play: () => sound('win') },
      { id: 'lose', label: 'Lose', desc: 'downward step', tone: 'down', play: () => sound('lose') },
    ],
  },
  {
    id: 'lucky',
    name: 'Lucky',
    vibe: 'D-Dorian funk · 102bpm · mallet riff + syncopated bass',
    bed: { start: startLuckyBgm, stop: stopLuckyBgm },
    sfx: [
      { id: 'spin', label: 'Spin', desc: 'reel launch whoosh', play: slotSpin },
      { id: 'tick', label: 'Tick', desc: 'ratchet detent', play: slotTick },
      { id: 'lock1', label: 'Lock 1', desc: 'reel land A5', play: () => slotLock(0) },
      { id: 'lock2', label: 'Lock 2', desc: 'reel land C#6', play: () => slotLock(1) },
      { id: 'lock3', label: 'Lock 3', desc: 'reel land E6', play: () => slotLock(2) },
      { id: 'lockF', label: 'Lock final', desc: 'payoff + sparkle', tone: 'amber', play: () => slotLock(2, true) },
      { id: 'pick', label: 'Pick', desc: 'chart lock-in', play: slotPick },
      { id: 'lwin', label: 'Win', desc: 'jackpot climb', tone: 'up', play: luckyWin },
      { id: 'lcash', label: 'Cash out', desc: 'locked-in chime', tone: 'up', play: luckyCashout },
      { id: 'llose', label: 'Lose', desc: 'miss sigh', tone: 'down', play: luckyLose },
    ],
  },
  {
    id: 'range',
    name: 'Range',
    vibe: 'Dark minor i-VI-VII-V · 122bpm · resonant saw arp + 4-on-floor',
    bed: { start: startRangeBgm, stop: stopRangeBgm },
    sfx: [
      { id: 'rlock', label: 'Lock', desc: 'committing thud', play: rangeLock },
      { id: 'crossIn', label: 'Cross in', desc: 'rising fifth', tone: 'up', play: () => rangeCross(true) },
      { id: 'crossOut', label: 'Cross out', desc: 'falling step', tone: 'down', play: () => rangeCross(false) },
      { id: 'buzz', label: 'Buzzer', desc: 'settle riser', tone: 'amber', play: rangeBuzzer },
      { id: 'rwin', label: 'Win', desc: 'D-major triumph', tone: 'up', play: rangeWin },
      { id: 'rlose', label: 'Lose', desc: 'minor sigh', tone: 'down', play: rangeLose },
      { id: 'crowd', label: 'Crowd', desc: 'distant coin plink', play: crowdPlace },
    ],
  },
  {
    id: 'moonshot',
    name: 'Moonshot',
    vibe: 'G-minor euphoric trance · 150bpm · supersaw pads + arp',
    bed: { start: startMoonshotBgm, stop: stopMoonshotBgm },
    sfx: [
      { id: 'fire', label: 'Fire', desc: 'launch thump', tone: 'amber', play: moonshotFire },
      { id: 'flip', label: 'Flip', desc: 'direction tick', play: moonshotFlip },
      { id: 'mwin', label: 'Win', desc: 'G-major arp', tone: 'up', play: moonshotWin },
      { id: 'mcash', label: 'Cash out', desc: 'rising fourth', tone: 'up', play: moonshotCashout },
      { id: 'mlose', label: 'Lose', desc: 'minor-third sigh', tone: 'down', play: moonshotLose },
    ],
  },
  {
    id: 'flappy',
    name: 'Flappy Piper',
    vibe: 'A-minor Am-F-C-G · 112bpm · triangle arp bed',
    bed: { start: startBgm, stop: stopBgm },
    sfx: [
      { id: 'hop', label: 'Score', desc: 'climbs each press', tone: 'up', play: hopScore },
      { id: 'hoplose', label: 'Crash', desc: 'falling sigh', tone: 'down', play: hopLose },
      { id: 'hopreset', label: 'Reset combo', desc: 'drops the climb', play: hopResetCombo },
    ],
  },
  {
    id: 'ride',
    name: 'Line Rider',
    vibe: 'E-major synthwave glide · 90bpm · adaptive lowpass',
    bed: { start: startRideBgm, stop: stopRideBgm },
    sfx: [
      { id: 'ridestart', label: 'Takeoff', desc: 'airy whoosh', tone: 'amber', play: rideStart },
      { id: 'ridecrash', label: 'Wipeout', desc: 'pentatonic tumble', tone: 'down', play: rideCrash },
    ],
  },
]

function SoundLab() {
  const [activeBed, setActiveBed] = useState<string | null>(null)
  const [pulse, setPulse] = useState<string | null>(null)
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Force the engine on and unlock the context so the lab always makes sound, whatever the user's setting.
  useEffect(() => {
    setSoundEnabled(true)
    unlockAudio()
    return () => stopAllBeds()
  }, [])

  function stopAllBeds() {
    for (const g of GROUPS) g.bed?.stop()
  }

  function toggleBed(g: Group) {
    if (!g.bed) return
    if (activeBed === g.id) {
      g.bed.stop()
      setActiveBed(null)
      return
    }
    stopAllBeds()
    g.bed.start()
    setActiveBed(g.id)
    if (g.id === 'ride') setRideState(ride)
  }

  function trigger(s: Sfx) {
    s.play()
    setPulse(s.id)
    if (pulseTimer.current) clearTimeout(pulseTimer.current)
    pulseTimer.current = setTimeout(() => setPulse(null), 220)
  }

  // Line Rider's bed reads this live via setRideState; safe to call while stopped (it no-ops without a tone).
  const [ride, setRide] = useState({ intensity: 0.4, onLine: true, gripLow: false, mult: 1 })
  function applyRide(patch: Partial<typeof ride>) {
    const next = { ...ride, ...patch }
    setRide(next)
    setRideState(next)
  }

  return (
    <div className="min-h-dvh w-full bg-black px-5 pb-24 pt-[max(env(safe-area-inset-top),1.25rem)] text-text sm:px-8">
      <div className="mx-auto w-full max-w-4xl">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-6">
          <div>
            <div className="flex items-center gap-2 text-brand-500">
              <Volume2 size={16} />
              <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em]">Sound Lab</span>
            </div>
            <h1 className="mt-2 text-2xl font-bold tracking-tight">Every game&apos;s music + SFX</h1>
            <p className="mt-1 max-w-xl text-sm text-text-3">
              Synthesized live via Web Audio, zero asset files. Dev bench for auditioning and revamping the sound.
              Engine is force-enabled while this page is open.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                stopAllBeds()
                setActiveBed(null)
              }}
              className="flex items-center gap-2 border border-line-strong px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-text-2 transition hover:border-down hover:text-down"
            >
              <VolumeX size={13} />
              Stop all
            </button>
            <Link
              to="/games"
              className="border border-line-strong px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-text-2 transition hover:border-line-strong hover:text-text"
            >
              To console
            </Link>
          </div>
        </header>

        <div className="mt-8 space-y-10">
          {GROUPS.map((g) => {
            const playing = activeBed === g.id
            return (
              <section key={g.id}>
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-bold tracking-tight">{g.name}</h2>
                    <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-text-3">{g.vibe}</p>
                  </div>
                  {g.bed && (
                    <button
                      onClick={() => toggleBed(g)}
                      className={cnm(
                        'flex items-center gap-2 border px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition',
                        playing
                          ? 'border-brand-500 text-brand-500'
                          : 'border-line-strong text-text-2 hover:border-text-3 hover:text-text',
                      )}
                    >
                      {playing ? <Square size={11} className="fill-current" /> : <Play size={11} className="fill-current" />}
                      {playing ? 'Bed playing' : 'Play bed'}
                      {playing && <span className="ml-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />}
                    </button>
                  )}
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                  {g.sfx.map((s) => {
                    const hit = pulse === s.id
                    const toneText =
                      s.tone === 'up' ? 'text-up' : s.tone === 'down' ? 'text-down' : s.tone === 'amber' ? 'text-brand-500' : 'text-text'
                    return (
                      <button
                        key={s.id}
                        onClick={() => trigger(s)}
                        className={cnm(
                          'flex flex-col items-start gap-1 border px-3 py-3 text-left transition active:scale-[0.98]',
                          hit ? 'border-brand-500 bg-brand-500/5' : 'border-line hover:border-line-strong',
                        )}
                      >
                        <span className={cnm('font-mono text-[11px] font-semibold uppercase tracking-wider', hit ? 'text-brand-500' : toneText)}>
                          {s.label}
                        </span>
                        {s.desc && <span className="text-[11px] leading-tight text-text-3">{s.desc}</span>}
                      </button>
                    )
                  })}
                </div>

                {g.id === 'ride' && <RidePanel ride={ride} apply={applyRide} live={playing} />}
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// The adaptive controls that drive Line Rider's bed filter in real time (feeds setRideState).
function RidePanel({
  ride,
  apply,
  live,
}: {
  ride: { intensity: number; onLine: boolean; gripLow: boolean; mult: number }
  apply: (patch: Partial<{ intensity: number; onLine: boolean; gripLow: boolean; mult: number }>) => void
  live: boolean
}) {
  return (
    <div className="mt-3 border border-line p-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-text-3">
        Adaptive drive {live ? '· live' : '· play the bed to hear it'}
      </p>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="flex justify-between font-mono text-[11px] uppercase tracking-wider text-text-2">
            Intensity <span className="text-brand-500">{ride.intensity.toFixed(2)}</span>
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={ride.intensity}
            onChange={(e) => apply({ intensity: Number(e.target.value) })}
            className="mt-2 w-full accent-[var(--color-brand-500)]"
          />
        </label>
        <label className="block">
          <span className="flex justify-between font-mono text-[11px] uppercase tracking-wider text-text-2">
            Multiplier <span className="text-brand-500">{ride.mult.toFixed(1)}x</span>
          </span>
          <input
            type="range"
            min={1}
            max={6}
            step={0.1}
            value={ride.mult}
            onChange={(e) => apply({ mult: Number(e.target.value) })}
            className="mt-2 w-full accent-[var(--color-brand-500)]"
          />
        </label>
      </div>
      <div className="mt-4 flex gap-2">
        <Toggle on={ride.onLine} label="On line" onClick={() => apply({ onLine: !ride.onLine })} />
        <Toggle on={ride.gripLow} label="Grip low" danger onClick={() => apply({ gripLow: !ride.gripLow })} />
      </div>
    </div>
  )
}

function Toggle({ on, label, danger, onClick }: { on: boolean; label: string; danger?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cnm(
        'border px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition',
        on
          ? danger
            ? 'border-down text-down'
            : 'border-brand-500 text-brand-500'
          : 'border-line-strong text-text-3 hover:text-text-2',
      )}
    >
      {label}: {on ? 'on' : 'off'}
    </button>
  )
}
