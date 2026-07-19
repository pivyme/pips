import { useEffect, useMemo, useRef, useState } from 'react'

import { haptic } from '@/lib/haptics'
import { slotLock } from '@/lib/sound'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import type { Side } from '@/lib/api'

// Two prize wheels deal the LUCKY hand: a direction wheel (up/down arrows) and a multiplier wheel (2/3/5/10x).
// Each free-spins to mask the server deal, then decelerates to a stop on the dealt segment. No center hub, the
// slices run to the middle and the labels carry the read. Every label (arrows and numbers) rides its own segment
// angle and settles upright once its segment lands under the top pointer. Same cycling/landing/stopAt contract
// the reels used, so lucky.tsx wires it 1:1.

type Hue = 'up' | 'down' | 'amber'
const HUE_VAR: Record<Hue, string> = {
  up: 'var(--color-up)',
  down: 'var(--color-down)',
  amber: 'var(--color-brand-500)',
}

type Seg = { text?: string; hue: Hue }
type LabelKind = 'arrow' | 'number'

const CX = 50
const CY = 50
const R = 46 // slice radius (runs to center, no hub)
const RIM = 47 // outer frame radius
const RL_NUM = 27 // multiplier number radius
const RL_ARROW = 25 // direction arrow radius
const FREE_DEG_PER_MS = 0.72 // free-spin speed while the deal lands
const IDLE_DEG_PER_MS = 0.03 // gentle carousel drift at rest, so the wheels always feel alive (~12s/turn)
const LAND_TURNS = 3 // full turns before settling, for the arcade wind-down
const easeOut = (p: number): number => 1 - Math.pow(1 - p, 3)

// 0deg = top (under the pointer), increasing clockwise.
function polar(r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)]
}

// Rotation that seats segment i's center under the top pointer.
function alignAngle(i: number, n: number): number {
  const center = (i + 0.5) * (360 / n)
  return (360 - (center % 360)) % 360
}
const norm = (deg: number): number => ((deg % 360) + 360) % 360

// Upright triangle centered at (x,y); flips to point down for a 'down' segment.
function triPath(x: number, y: number, s: number, down: boolean): string {
  return down
    ? `M${x} ${y + s} L${x - s * 0.86} ${y - s * 0.62} L${x + s * 0.86} ${y - s * 0.62} Z`
    : `M${x} ${y - s} L${x - s * 0.86} ${y + s * 0.62} L${x + s * 0.86} ${y + s * 0.62} Z`
}

function SpinWheel({
  label,
  segments,
  labelKind,
  targetKey,
  targetIdxs,
  size = 150,
  cycling,
  landing,
  stopAt,
  index,
  last = false,
}: {
  label: string
  segments: Seg[]
  labelKind: LabelKind
  targetKey: string // stable scalar for the effect dep (the reactive targetIdxs is read via ref)
  targetIdxs: number[] | null
  size?: number
  cycling: boolean
  landing: boolean
  stopAt: number
  index: number
  last?: boolean
}) {
  const gRef = useRef<SVGGElement | null>(null)
  const rot = useRef(0) // current absolute rotation (deg), driven imperatively for 60fps
  const raf = useRef(0)
  const spinNo = useRef(0)
  const lastPick = useRef<number | null>(null)
  const idxsRef = useRef<number[] | null>(targetIdxs)
  idxsRef.current = targetIdxs
  const [landed, setLanded] = useState<number | null>(null)
  const reduced = useReducedMotion()

  const n = segments.length
  const seg = 360 / n
  const centers = useMemo(() => segments.map((_, i) => (i + 0.5) * seg), [segments, seg])

  useEffect(() => {
    const write = (deg: number) => {
      rot.current = deg
      gRef.current?.setAttribute('transform', `rotate(${deg.toFixed(2)} ${CX} ${CY})`)
    }
    const cancel = () => {
      if (raf.current) cancelAnimationFrame(raf.current)
      raf.current = 0
    }
    cancel()

    const idxs = idxsRef.current
    if (cycling) {
      if (landing && idxs && idxs.length) {
        // Decelerate onto the dealt segment. Vary which matching segment across spins so it never looks rigged.
        const pick = idxs[spinNo.current % idxs.length]
        spinNo.current += 1
        lastPick.current = pick
        setLanded(null)
        const start = rot.current
        let end = start + LAND_TURNS * 360
        end += (((alignAngle(pick, n) - end) % 360) + 360) % 360
        const t0 = performance.now()
        const tick = (now: number) => {
          const p = Math.min(1, (now - t0) / stopAt)
          write(start + (end - start) * easeOut(p))
          if (p < 1) raf.current = requestAnimationFrame(tick)
          else {
            raf.current = 0
            setLanded(pick)
            haptic('rigid')
            slotLock(index, last)
          }
        }
        raf.current = requestAnimationFrame(tick)
      } else {
        // Free spin while the server deals, so the wheel is already moving when the target arrives.
        setLanded(null)
        let prev = performance.now()
        const tick = (now: number) => {
          write(rot.current + (now - prev) * FREE_DEG_PER_MS)
          prev = now
          raf.current = requestAnimationFrame(tick)
        }
        raf.current = requestAnimationFrame(tick)
      }
    } else if (idxs && idxs.length) {
      // Resting on a dealt hand (round open, or remounted mid-round): sit aligned, no re-spin.
      const pick = lastPick.current != null && idxs.includes(lastPick.current) ? lastPick.current : idxs[0]
      const align = alignAngle(pick, n)
      if (Math.abs(norm(rot.current) - align) > 0.5) write(align)
      lastPick.current = pick
      setLanded(pick)
    } else {
      // Fully idle (no dealt hand): drift slowly like a real prize wheel so the cluster never feels dead.
      // The two wheels turn opposite ways for a bit of life. Calm to a stop under reduced-motion.
      lastPick.current = null
      setLanded(null)
      if (!reduced) {
        const dir = index % 2 === 0 ? 1 : -1
        let prev = performance.now()
        const tick = (now: number) => {
          write(rot.current + (now - prev) * IDLE_DEG_PER_MS * dir)
          prev = now
          raf.current = requestAnimationFrame(tick)
        }
        raf.current = requestAnimationFrame(tick)
      }
    }
    return cancel
    // idxs read via ref; targetKey is the stable dep that tracks its content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycling, landing, stopAt, targetKey, n, index, last, reduced])

  const hasLanded = landed != null
  const lit = hasLanded && !cycling // fully locked: glow + accent, mirrors the reel's dim-then-light

  return (
    <div className="relative flex flex-1 flex-col items-center justify-center gap-2 border-l border-white/25 bg-black px-2 py-3 first:border-l-0">
      <span className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-text-3">{label}</span>
      <svg viewBox="0 0 100 100" width={size} height={size} style={{ overflow: 'visible' }}>
        <g ref={gRef}>
          {segments.map((s, i) => {
            const [x0, y0] = polar(R, i * seg)
            const [x1, y1] = polar(R, (i + 1) * seg)
            const c = HUE_VAR[s.hue]
            const isLanded = landed === i
            const fillOp = isLanded ? (lit ? 0.36 : 0.24) : cycling ? 0.2 : lit ? 0.14 : 0.12
            const strokeOp = isLanded ? 1 : cycling ? 0.85 : 0.62
            const labelOp = isLanded ? 1 : cycling ? 1 : lit ? 0.82 : 0.72
            // Labels charge up while the wheel spins and stay lit once locked.
            const labelGlow = isLanded && lit ? 5 : cycling ? 3 : 0
            const slice = (
              <path
                d={`M${CX} ${CY} L${x0.toFixed(2)} ${y0.toFixed(2)} A${R} ${R} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`}
                style={{ fill: c, fillOpacity: fillOp, stroke: c, strokeOpacity: strokeOp, strokeWidth: 1 }}
              />
            )
            if (labelKind === 'arrow') {
              const [ax, ay] = polar(RL_ARROW, centers[i])
              const aSize = isLanded ? 9 : 7.2
              return (
                <g key={i}>
                  {slice}
                  <path
                    d={triPath(ax, ay, aSize, s.hue === 'down')}
                    transform={`rotate(${centers[i].toFixed(2)} ${ax.toFixed(2)} ${ay.toFixed(2)})`}
                    style={{ fill: c, opacity: labelOp, filter: labelGlow ? `drop-shadow(0 0 ${labelGlow}px ${c})` : undefined }}
                  />
                </g>
              )
            }
            const [lx, ly] = polar(RL_NUM, centers[i])
            return (
              <g key={i}>
                {slice}
                <text
                  x={lx.toFixed(2)}
                  y={ly.toFixed(2)}
                  textAnchor="middle"
                  dominantBaseline="central"
                  transform={`rotate(${centers[i].toFixed(2)} ${lx.toFixed(2)} ${ly.toFixed(2)})`}
                  fontSize={isLanded ? 17 : 15}
                  className="tnum"
                  style={{ fill: c, fontWeight: 900, opacity: labelOp, filter: labelGlow ? `drop-shadow(0 0 ${labelGlow}px ${c})` : undefined }}
                >
                  {s.text}
                </text>
              </g>
            )
          })}
        </g>

        <circle
          cx={CX}
          cy={CY}
          r={RIM}
          fill="none"
          stroke={cycling ? 'var(--color-brand-500)' : 'var(--color-line-strong)'}
          strokeOpacity={cycling ? 0.9 : 1}
          strokeWidth={1.25}
          style={{ filter: cycling ? 'drop-shadow(0 0 4px var(--color-brand-500))' : undefined }}
        />
        <path
          d="M50 12 L44 2 L56 2 Z"
          style={{ fill: 'var(--color-brand-500)', filter: `drop-shadow(0 0 ${lit || cycling ? 5 : 2}px var(--color-brand-500))` }}
        />
      </svg>
    </div>
  )
}

// Direction: four alternating up/down segments so the spin reads as a real wheel, not a coin flip.
const DIR_SEGS: Seg[] = [{ hue: 'up' }, { hue: 'down' }, { hue: 'up' }, { hue: 'down' }]

export function DirectionWheel({
  side,
  size,
  cycling,
  landing,
  stopAt,
  index,
  last,
}: {
  side?: Side
  size?: number
  cycling: boolean
  landing: boolean
  stopAt: number
  index: number
  last?: boolean
}) {
  const targetIdxs = useMemo(
    () => (side ? DIR_SEGS.map((s, i) => (s.hue === side ? i : -1)).filter((i) => i >= 0) : null),
    [side],
  )
  return (
    <SpinWheel
      label="Up Down"
      segments={DIR_SEGS}
      labelKind="arrow"
      targetKey={side ?? ''}
      targetIdxs={targetIdxs}
      size={size}
      cycling={cycling}
      landing={landing}
      stopAt={stopAt}
      index={index}
      last={last}
    />
  )
}

// Multiplier: one segment per tier (no repeats) so each number is big. The wheel lands on the nearest tier.
const MULT_TIERS = [2, 3, 5, 10]
const MULT_SEGS: Seg[] = MULT_TIERS.map((t) => ({ text: `${t}×`, hue: 'amber' as const }))

function nearestTier(m: number): number {
  return MULT_TIERS.reduce((best, t) => (Math.abs(m - t) < Math.abs(m - best) ? t : best), MULT_TIERS[0])
}

export function MultiplierWheel({
  multiplier,
  size,
  cycling,
  landing,
  stopAt,
  index,
  last,
}: {
  multiplier?: number
  size?: number
  cycling: boolean
  landing: boolean
  stopAt: number
  index: number
  last?: boolean
}) {
  const tierLabel = multiplier != null && multiplier > 0 ? `${nearestTier(multiplier)}×` : ''
  const targetIdxs = useMemo(
    () => (tierLabel ? MULT_SEGS.map((s, i) => (s.text === tierLabel ? i : -1)).filter((i) => i >= 0) : null),
    [tierLabel],
  )
  return (
    <SpinWheel
      label="Multiplier"
      segments={MULT_SEGS}
      labelKind="number"
      targetKey={tierLabel}
      targetIdxs={targetIdxs}
      size={size}
      cycling={cycling}
      landing={landing}
      stopAt={stopAt}
      index={index}
      last={last}
    />
  )
}
