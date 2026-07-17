import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Avatar } from '@/components/Avatar'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { CrowdSim, DEFAULT_CROWD, type CrowdConfig, type CrowdPlace } from '@/lib/crowd'
import { crowdPlace } from '@/lib/sound'
import type { ChartGeometry } from '@/components/game/Chart'

// The social crowd layer: a DOM overlay over the chart canvas. When a fake other-player places, their
// range flashes on the chart smoothly and a coin pops fast, then it's gone. NO persistent avatars, never
// a stack, at most one or two pulses at a time, so the round feels alive without ever overwhelming. Purely
// cosmetic and isolated (never touches api/predict/chain/demo); pinned to the price line via the chart's
// geometry snapshot. See .claude/RANGE-V2-CROWD.md.

const MAX_FLASHES = 2 // hard cap on concurrent pulses; the sim spacing keeps it near 1 anyway

interface Flash {
  id: number
  handle: string
  entryPrice: number
  halfFrac: number
  self: boolean // your own place: coin only at the now-dot, the real band already renders on the chart
}

interface CrowdLayerProps {
  geometryRef: { current: ChartGeometry | null }
  livePriceRef: { current: number }
  // Bump to pop a coin at the now-dot for your OWN play (reuses the crowd's coin primitive).
  selfPlaceSignal?: number
  density?: Partial<CrowdConfig>
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3)

export function CrowdLayer({ geometryRef, livePriceRef, selfPlaceSignal = 0, density }: CrowdLayerProps) {
  const reduced = useReducedMotion()
  const [flashes, setFlashes] = useState<Flash[]>([])
  const simRef = useRef<CrowdSim | null>(null)
  const seq = useRef(1)
  const onPlaceRef = useRef<(e: CrowdPlace) => void>(() => {})

  const cfg = useMemo<CrowdConfig>(() => ({ ...DEFAULT_CROWD, ...density, reduced }), [density, reduced])

  const push = useCallback((f: Flash) => {
    setFlashes((prev) => (prev.length >= MAX_FLASHES ? [...prev.slice(1), f] : [...prev, f]))
  }, [])
  const remove = useCallback((id: number) => {
    setFlashes((prev) => prev.filter((f) => f.id !== id))
  }, [])

  onPlaceRef.current = (e) => {
    push({ id: seq.current++, handle: e.handle, entryPrice: e.entryPrice, halfFrac: e.halfFrac, self: false })
    crowdPlace()
  }

  if (!simRef.current) {
    simRef.current = new CrowdSim(cfg, { onPlace: (e) => onPlaceRef.current(e) })
  }
  useEffect(() => {
    simRef.current?.setConfig(cfg)
  }, [cfg])

  // The sim clock: one rAF advances it off the live price. Positioning is per-flash (below).
  useEffect(() => {
    let raf = 0
    const loop = (now: number) => {
      simRef.current?.tick(now, livePriceRef.current || 0)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [livePriceRef])

  // Your own place: a single coin at the now-dot (the real locked band already draws on the chart).
  const lastSelf = useRef(0)
  useEffect(() => {
    if (selfPlaceSignal <= 0 || selfPlaceSignal === lastSelf.current) return
    lastSelf.current = selfPlaceSignal
    push({ id: seq.current++, handle: '', entryPrice: livePriceRef.current || 0, halfFrac: 0, self: true })
  }, [selfPlaceSignal, livePriceRef, push])

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden data-crowd="layer">
      {flashes.map((f) => (
        <CrowdFlash key={f.id} flash={f} geometryRef={geometryRef} livePriceRef={livePriceRef} reduced={reduced} onDone={() => remove(f.id)} />
      ))}
    </div>
  )
}

// One pulse: a soft amber band at the placer's price that smoothly fades in, holds, and fades out, with a
// coin that pops fast at its center and a small handle chip. One self-contained rAF glues it to the price
// line (via geometry) and drives the fade envelope, then it removes itself. Transform/opacity only.
function CrowdFlash({
  flash,
  geometryRef,
  livePriceRef,
  reduced,
  onDone,
}: {
  flash: Flash
  geometryRef: { current: ChartGeometry | null }
  livePriceRef: { current: number }
  reduced: boolean
  onDone: () => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const band = useRef<HTMLDivElement>(null)
  const coin = useRef<HTMLDivElement>(null)
  const chip = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const life = reduced ? 700 : 1150
    // Fast in, brief hold, gentle out. The "smooth" the round wants, without lingering.
    const envelope = (t: number): number => {
      if (t < 0.13) return easeOut(t / 0.13)
      if (t < 0.5) return 1
      return 1 - easeOut((t - 0.5) / 0.5)
    }
    // Coin appears fast: a quick pop up then settle, done in the first third.
    const coinScale = (t: number): number => {
      if (reduced) return t < 0.5 ? 1 : 1
      if (t < 0.12) return 0.2 + 1.15 * easeOut(t / 0.12)
      if (t < 0.24) return 1.35 - 0.35 * ((t - 0.12) / 0.12)
      return 1
    }

    let raf = 0
    let start = 0
    const step = (now: number) => {
      if (!start) start = now
      const t = (now - start) / life
      if (t >= 1) {
        onDone()
        return
      }
      const geo = geometryRef.current
      if (geo && geo.w > 0) {
        const yOf = (p: number) => geo.topPad + ((geo.top - p) / geo.span) * geo.plotH
        const yMin = geo.topPad + 4
        const yMax = geo.topPad + geo.plotH - 4
        if (flash.self) {
          // Coin only, riding the live leading edge.
          const cy = clamp(yOf(livePriceRef.current || flash.entryPrice), yMin, yMax)
          if (coin.current) {
            coin.current.style.left = `${geo.nowX}px`
            coin.current.style.top = `${cy}px`
          }
        } else {
          const yU = clamp(yOf(flash.entryPrice * (1 + flash.halfFrac)), yMin, yMax)
          const yL = clamp(yOf(flash.entryPrice * (1 - flash.halfFrac)), yMin, yMax)
          const cy = (yU + yL) / 2
          if (band.current) {
            band.current.style.top = `${yU}px`
            band.current.style.height = `${Math.max(2, yL - yU)}px`
          }
          if (coin.current) {
            // Small per-flash x offset so two overlapping pulses don't land the coins dead-on each other.
            coin.current.style.left = `${geo.nowX - 10 + ((flash.id % 3) - 1) * 7}px`
            coin.current.style.top = `${cy}px`
          }
          if (chip.current) {
            // Up-left of the band, over the price history, clear of the forward-zone aim/NEXT labels on the right.
            chip.current.style.left = `${clamp(geo.nowX - 104, geo.w * 0.05, geo.nowX - 56)}px`
            chip.current.style.top = `${clamp(yU - 16, geo.topPad + 6, yMax - 10)}px`
          }
        }
      }
      const op = reduced ? (t < 0.15 ? t / 0.15 : t > 0.7 ? Math.max(0, 1 - (t - 0.7) / 0.3) : 1) : envelope(t)
      if (root.current) root.current.style.opacity = op.toFixed(3)
      const scaleY = reduced ? 1 : 0.9 + 0.1 * Math.min(1, t / 0.13)
      if (band.current) band.current.style.transform = `scaleY(${scaleY.toFixed(3)})`
      if (coin.current) coin.current.style.transform = `translate(-50%,-50%) scale(${coinScale(t).toFixed(3)})`
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const coinSize = flash.self ? 20 : 15
  return (
    <div ref={root} className="absolute inset-0" style={{ opacity: 0 }} data-crowd-flash={flash.self ? 'self' : 'crowd'}>
      {!flash.self && (
        <>
          {/* The range flash: a full-bleed amber band at their level, hairline edges, soft fill. */}
          <div
            ref={band}
            className="absolute inset-x-0 will-change-transform"
            style={{
              top: -100,
              height: 2,
              background: 'linear-gradient(180deg, rgba(245,158,11,0.02), rgba(245,158,11,0.13), rgba(245,158,11,0.02))',
              borderTop: '1px solid rgba(245,158,11,0.55)',
              borderBottom: '1px solid rgba(245,158,11,0.55)',
            }}
          />
          {/* A small handle chip so the pulse has a face, single + fading, never a stack. */}
          <div ref={chip} className="absolute flex items-center gap-1.5 will-change-transform" style={{ left: -100, top: -100 }}>
            <div className="overflow-hidden rounded-full" style={{ boxShadow: '0 0 0 1px rgba(0,0,0,0.5)' }}>
              <Avatar name={flash.handle} size={16} />
            </div>
            <span className="whitespace-nowrap font-mono text-[10px] font-bold tracking-[0.02em] text-brand-500/90">{flash.handle}</span>
          </div>
        </>
      )}
      {/* The coin: a fast amber disc pop, glued to the leading edge (self) or the band center (crowd). */}
      <div
        ref={coin}
        className="absolute rounded-full will-change-transform"
        style={{
          left: -100,
          top: -100,
          width: coinSize,
          height: coinSize,
          transformStyle: 'preserve-3d',
          background: 'radial-gradient(circle at 35% 30%, #ffd97a, #f59e0b 55%, #b45309)',
          boxShadow: '0 0 0 1px rgba(0,0,0,0.5)',
        }}
      />
    </div>
  )
}
