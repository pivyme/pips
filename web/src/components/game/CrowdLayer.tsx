import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Avatar } from '@/components/Avatar'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { CrowdSim, DEFAULT_CROWD, type CrowdConfig, type Rider } from '@/lib/crowd'
import { crowdPlace, crowdWin } from '@/lib/sound'
import type { ChartGeometry } from '@/components/game/Chart'

// The social crowd layer: a DOM overlay over the chart canvas that renders fake other-players as
// identicon riders pinned to the price line (surfers on the leading edge with a live PnL floater,
// sitters holding their entry height), plus coin-pops on placement. All motion is imperative in one
// rAF that reads the published chart geometry + the sim; React re-renders ONLY when the rider set
// changes. Cosmetic and isolated: it never touches api/predict/chain/demo. See .claude/RANGE-V2-CROWD.md.

const SIZE = 34 // rider avatar diameter, px
const MAX_POPS = 8 // live coin-pops cap (the 3D console sits underneath, keep it cheap)
const TAU = Math.PI * 2
const EASE = 0.16 // per-frame lerp toward target position

interface Handle {
  root: HTMLDivElement
  ring: HTMLDivElement
  pnl: HTMLDivElement
  cx: number
  cy: number
  bob: number // idle-bob phase, per rider
  enteredAt: number
  lastRing?: string
  lastPnl?: string
  lastPnlCol?: string
}

interface Pop {
  id: number
  x: number
  y: number
  self: boolean
}

interface CrowdLayerProps {
  geometryRef: { current: ChartGeometry | null }
  livePriceRef: { current: number }
  // Bump to pop a coin at the now-dot for your OWN play (reuses the crowd's coin primitive).
  selfPlaceSignal?: number
  // Density overrides (target/max riders, spawn cadence). Defaults to the lively DEFAULT_CROWD.
  density?: Partial<CrowdConfig>
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

function readColor(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

// Slight overshoot on the pop-in, so a rider lands like it has weight instead of snapping to full size.
function easeOutBack(t: number): number {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}

function formatPnl(v: number): string {
  const a = Math.abs(v)
  return `${v >= 0 ? '+' : '−'}$${a >= 100 ? a.toFixed(0) : a.toFixed(1)}`
}

export function CrowdLayer({ geometryRef, livePriceRef, selfPlaceSignal = 0, density }: CrowdLayerProps) {
  const reduced = useReducedMotion()
  const [roster, setRoster] = useState<Array<{ id: number; name: string }>>([])
  const [pops, setPops] = useState<Pop[]>([])

  const handles = useRef<Map<number, Handle>>(new Map())
  const simRef = useRef<CrowdSim | null>(null)
  const colors = useRef({ up: '#22c55e', down: '#ef4444', brand: '#f59e0b' })
  const reducedRef = useRef(reduced)
  reducedRef.current = reduced
  const popSeq = useRef(1)
  // Latest event handlers, so the sim (built once) never fires a stale coin-spawn closure.
  const onPlaceRef = useRef<(r: Rider) => void>(() => {})
  const onResolveRef = useRef<(r: Rider) => void>(() => {})

  const cfg = useMemo<CrowdConfig>(() => {
    const base: CrowdConfig = { ...DEFAULT_CROWD, ...density, reduced }
    if (reduced) {
      base.targetRiders = Math.min(base.targetRiders, 2)
      base.maxRiders = Math.min(base.maxRiders, 2)
    }
    return base
  }, [density, reduced])

  const spawnCoin = useCallback((x: number, y: number, self: boolean) => {
    setPops((prev) => {
      const trimmed = prev.length >= MAX_POPS ? prev.slice(prev.length - (MAX_POPS - 1)) : prev
      return [...trimmed, { id: popSeq.current++, x, y, self }]
    })
  }, [])

  // A rider entered: drop a coin-pop at its entry point (behind the leading edge, at its entry height).
  const spawnCoinForRider = useCallback(
    (r: Rider) => {
      const geo = geometryRef.current
      if (!geo || geo.w === 0) return
      const yOf = (p: number) => geo.topPad + ((geo.top - p) / geo.span) * geo.plotH
      const x = clamp(geo.nowX - (r.kind === 'surfer' ? 8 : 15), 24, geo.nowX - 4)
      const y = clamp(yOf(r.entryPrice), geo.topPad + 12, geo.topPad + geo.plotH - 12)
      spawnCoin(x, y, false)
    },
    [geometryRef, spawnCoin],
  )

  onPlaceRef.current = (r) => {
    spawnCoinForRider(r)
    crowdPlace()
  }
  onResolveRef.current = (r) => {
    if (r.won) crowdWin()
  }

  // Build the sim once; roster changes drive React, everything else is imperative in the rAF below.
  if (!simRef.current) {
    simRef.current = new CrowdSim(cfg, {
      onRoster: () => setRoster((simRef.current?.riders ?? []).map((r) => ({ id: r.id, name: r.handle }))),
      onPlace: (r) => onPlaceRef.current(r),
      onResolve: (r) => onResolveRef.current(r),
    })
  }
  useEffect(() => {
    simRef.current?.setConfig(cfg)
  }, [cfg])

  useEffect(() => {
    colors.current = {
      up: readColor('--color-up', '#22c55e'),
      down: readColor('--color-down', '#ef4444'),
      brand: readColor('--color-brand-500', '#f59e0b'),
    }
  }, [])

  const register = useCallback((id: number, root: HTMLDivElement, ring: HTMLDivElement, pnl: HTMLDivElement) => {
    handles.current.set(id, { root, ring, pnl, cx: NaN, cy: NaN, bob: (id * 1.7) % TAU, enteredAt: performance.now() })
  }, [])
  const unregister = useCallback((id: number) => {
    handles.current.delete(id)
  }, [])

  // Your own place: pop a coin at the now-dot, same primitive as the crowd.
  const lastSelf = useRef(0)
  useEffect(() => {
    if (selfPlaceSignal <= 0 || selfPlaceSignal === lastSelf.current) return
    lastSelf.current = selfPlaceSignal
    const geo = geometryRef.current
    if (!geo || geo.w === 0) return
    const yOf = (p: number) => geo.topPad + ((geo.top - p) / geo.span) * geo.plotH
    spawnCoin(clamp(geo.nowX, 24, geo.w - 8), clamp(yOf(geo.price), geo.topPad + 12, geo.topPad + geo.plotH - 12), true)
  }, [selfPlaceSignal, geometryRef, spawnCoin])

  // The single motion loop: advance the sim, then pin every rider to the price line and write transforms.
  useEffect(() => {
    let raf = 0
    const loop = (now: number) => {
      const sim = simRef.current
      if (sim) {
        sim.tick(now, livePriceRef.current || 0)
        const geo = geometryRef.current
        if (geo && geo.w > 0) {
          const rm = reducedRef.current
          const c = colors.current
          const yOf = (p: number) => geo.topPad + ((geo.top - p) / geo.span) * geo.plotH
          const yMin = geo.topPad + 16
          const yMax = geo.topPad + geo.plotH - 16
          const xMax = geo.nowX - 6
          for (const r of sim.riders) {
            const h = handles.current.get(r.id)
            if (!h) continue
            // Surfer rides the live tip; sitter holds its entry height, a touch further back. Stable
            // per-rider offsets keep stacked avatars from perfectly overlapping.
            const jx = ((r.id * 37) % 14) - 7
            const jy = ((r.id * 53) % 14) - 7
            let tx = (r.kind === 'surfer' ? geo.nowX - 9 : geo.nowX - 16) + jx
            let ty = (r.kind === 'surfer' ? yOf(geo.price) : yOf(r.entryPrice)) + jy
            tx = clamp(tx, 26, xMax)
            ty = clamp(ty, yMin, yMax)
            if (Number.isNaN(h.cx)) {
              h.cx = tx
              h.cy = ty
            }
            const k = rm ? 1 : EASE
            h.cx += (tx - h.cx) * k
            h.cy += (ty - h.cy) * k

            const enterT = clamp((now - h.enteredAt) / 300, 0, 1)
            const enterScale = rm ? 1 : 0.6 + 0.4 * easeOutBack(enterT)
            let opacity = rm ? 1 : enterT
            if (r.phase === 'leaving') opacity *= 1 - clamp((now - r.phaseAt) / 520, 0, 1)
            const bob = rm ? 0 : Math.sin(now / 700 + h.bob) * 2.2
            // A little win-pop on the verdict, decaying over the resolve window.
            const winPop = !rm && r.phase === 'resolving' && r.won ? 1 + 0.14 * (1 - clamp((now - r.phaseAt) / 600, 0, 1)) : 1
            const s = enterScale * winPop
            h.root.style.transform = `translate3d(${(h.cx - SIZE / 2).toFixed(1)}px, ${(h.cy - SIZE / 2 + bob).toFixed(1)}px, 0) scale(${s.toFixed(3)})`
            h.root.style.opacity = opacity.toFixed(2)

            const ring = r.phase === 'resolving' ? (r.won ? c.up : c.down) : r.inFavor ? c.up : c.brand
            if (h.lastRing !== ring) {
              h.ring.style.boxShadow = `inset 0 0 0 2px ${ring}, 0 0 0 1px rgba(0,0,0,0.55)`
              h.lastRing = ring
            }

            const val = r.phase === 'resolving' ? r.pnl : r.livePnl
            const show = r.phase === 'resolving' || Math.abs(val) >= 0.5
            const txt = show ? formatPnl(val) : ''
            if (h.lastPnl !== txt) {
              h.pnl.textContent = txt
              h.lastPnl = txt
            }
            const pnlCol = val >= 0 ? c.up : c.down
            if (h.lastPnlCol !== pnlCol) {
              h.pnl.style.color = pnlCol
              h.lastPnlCol = pnlCol
            }
            h.pnl.style.opacity = show ? '1' : '0'
          }
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [geometryRef, livePriceRef])

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {roster.map((r) => (
        <Rider key={r.id} id={r.id} name={r.name} register={register} unregister={unregister} />
      ))}
      {pops.map((p) => (
        <CoinPop
          key={p.id}
          x={p.x}
          y={p.y}
          self={p.self}
          reduced={reduced}
          onDone={() => setPops((prev) => prev.filter((q) => q.id !== p.id))}
        />
      ))}
    </div>
  )
}

// One rider node. Registers its DOM refs once; the parent's rAF owns every per-frame write (transform,
// ring color, PnL text), so this component re-renders only on mount/unmount.
function Rider({
  id,
  name,
  register,
  unregister,
}: {
  id: number
  name: string
  register: (id: number, root: HTMLDivElement, ring: HTMLDivElement, pnl: HTMLDivElement) => void
  unregister: (id: number) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const ring = useRef<HTMLDivElement>(null)
  const pnl = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (root.current && ring.current && pnl.current) register(id, root.current, ring.current, pnl.current)
    return () => unregister(id)
  }, [id, register, unregister])
  return (
    <div ref={root} className="absolute left-0 top-0 will-change-transform" style={{ transform: 'translate3d(-200px,-200px,0)', opacity: 0 }}>
      <div
        ref={pnl}
        className="tnum absolute left-1/2 -translate-x-1/2 whitespace-nowrap font-mono text-[11px] font-bold leading-none"
        style={{ bottom: SIZE + 6, opacity: 0, transition: 'opacity 200ms ease-out' }}
      />
      <div
        ref={ring}
        className="overflow-hidden rounded-full"
        style={{ width: SIZE, height: SIZE, boxShadow: 'inset 0 0 0 2px #f59e0b, 0 0 0 1px rgba(0,0,0,0.55)' }}
      >
        <Avatar name={name} size={SIZE} />
      </div>
    </div>
  )
}

// The coin: a small amber disc that scales up then down while flipping on its Y axis, then fades. WAAPI
// (hardware-accelerated, off the main thread) so it never fights the 60fps chart or the 3D console.
function CoinPop({ x, y, self, reduced, onDone }: { x: number; y: number; self: boolean; reduced: boolean; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) {
      onDone()
      return
    }
    const frames: Keyframe[] = reduced
      ? [
          { opacity: 0, transform: 'translate(-50%,-50%) scale(0.85)' },
          { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: 0.25 },
          { opacity: 0, transform: 'translate(-50%,-50%) scale(1)' },
        ]
      : [
          { opacity: 0, transform: 'translate(-50%,-50%) scale(0.2) rotateY(0deg)' },
          { opacity: 1, transform: 'translate(-50%,-50%) scale(1.25) rotateY(200deg)', offset: 0.32 },
          { opacity: 1, transform: 'translate(-50%,-50%) scale(1.02) rotateY(400deg)', offset: 0.72 },
          { opacity: 0, transform: 'translate(-50%,-50%) scale(0.85) rotateY(540deg)' },
        ]
    const anim = el.animate(frames, { duration: reduced ? 420 : 600, easing: 'cubic-bezier(0.23,1,0.32,1)', fill: 'forwards' })
    let done = false
    const finish = () => {
      if (!done) {
        done = true
        onDone()
      }
    }
    anim.finished.then(finish).catch(finish)
    return () => {
      done = true // don't re-fire onDone on unmount teardown
      anim.cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const size = self ? 22 : 16
  return (
    <div
      ref={ref}
      className="absolute rounded-full"
      style={{
        left: x,
        top: y,
        width: size,
        height: size,
        transformStyle: 'preserve-3d',
        background: 'radial-gradient(circle at 35% 30%, #ffd97a, #f59e0b 55%, #b45309)',
        boxShadow: self ? '0 0 0 1.5px rgba(0,0,0,0.5)' : '0 0 0 1px rgba(0,0,0,0.5)',
      }}
    />
  )
}
