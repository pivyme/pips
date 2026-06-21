import type { CSSProperties, ReactNode } from 'react'
import { cnm } from '@/utils/style'

// Teenage-engineering style game-screen instruments, but trading-native. Crisp vivid vector
// lines on true black, the "electric" layer that renders inside the console screen
// (docs/DESIGN.md). Every piece speaks trading: price, leverage, bet, payout, liquidation,
// long/short, expiry, P&L. Each is a pure SVG component: `hue` picks the accent, `frozen`
// drops motion for reduced-motion. Motion lives in styles.css as cheap viz-* transforms.
//
// Color note: var(--color-*) only resolves in CSS context, never in an SVG presentation
// attribute. Dynamic hues go through inline `style`; fixed tokens use stroke-*/fill-*
// Tailwind utilities (also CSS). No raw stroke="var(...)" attributes.

export type Hue =
  | 'up'
  | 'down'
  | 'info'
  | 'amber'
  | 'violet'
  | 'cyan'
  | 'white'
  | 'dim'

export const HUE: Record<Hue, string> = {
  up: 'var(--color-up)',
  down: 'var(--color-down)',
  info: 'var(--color-info)',
  amber: 'var(--color-brand-500)',
  violet: 'var(--color-premium-500)',
  cyan: 'var(--color-viz-cyan)',
  white: 'var(--color-text)',
  dim: 'var(--color-text-3)',
}

export interface VizProps {
  hue?: Hue
  frozen?: boolean
  className?: string
}

const glow = (c: string, r = 4) => `drop-shadow(0 0 ${r}px ${c})`
// Vivid hue stroke + matching glow, the house "lit line" treatment.
const lit = (c: string, g = 3): CSSProperties => ({ stroke: c, filter: glow(c, g) })

// 0deg = 12 o'clock, clockwise. Gauges and rings lay out from the top.
function pol(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
}
function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = pol(cx, cy, r, a0)
  const [x1, y1] = pol(cx, cy, r, a1)
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0
  const sweep = a1 >= a0 ? 1 : 0
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`
}

const VB = '0 0 240 150' // shared landscape viewBox
const SQ = '0 0 150 150' // shared square viewBox (rotation centers on its middle)

function Svg({
  square,
  children,
  className,
  fill,
}: {
  square?: boolean
  children: ReactNode
  className?: string
  fill?: boolean
}) {
  return (
    <svg
      viewBox={square ? SQ : VB}
      preserveAspectRatio={fill ? 'none' : 'xMidYMid meet'}
      className={cnm('block h-full w-full', className)}
      aria-hidden
    >
      {children}
    </svg>
  )
}

// Tiny mono readout, the hardware-label flavor, in SVG user units.
function Tag({
  x,
  y,
  children,
  anchor = 'start',
  size = 9,
  hue = 'dim',
}: {
  x: number
  y: number
  children: ReactNode
  anchor?: 'start' | 'middle' | 'end'
  size?: number
  hue?: Hue
}) {
  return (
    <text
      x={x}
      y={y}
      fontSize={size}
      textAnchor={anchor}
      className="font-mono"
      style={{ fill: HUE[hue], letterSpacing: '0.12em' }}
    >
      {children}
    </text>
  )
}

function Num({
  x,
  y,
  children,
  anchor = 'start',
  size = 34,
  hue = 'white',
  weight = 800,
}: {
  x: number
  y: number
  children: ReactNode
  anchor?: 'start' | 'middle' | 'end'
  size?: number
  hue?: Hue
  weight?: number
}) {
  return (
    <text
      x={x}
      y={y}
      fontSize={size}
      textAnchor={anchor}
      style={{
        fill: HUE[hue],
        fontWeight: weight,
        letterSpacing: '-0.02em',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {children}
    </text>
  )
}

// ── Price / charts ─────────────────────────────────────────────────────────

export function PriceTape({ hue = 'up', frozen, className }: VizProps) {
  // Live price line streaming left, the signature trace. Tinted to the position.
  const c = HUE[hue]
  let d = ''
  for (let x = 0; x <= 240; x += 3) {
    const env = Math.exp(-Math.pow((x - 120) / 150, 2) * 0.6)
    const y = 80 + Math.sin(x / 17) * 26 * env + Math.sin(x / 6.5) * 6 * env
    d += `${x === 0 ? 'M' : 'L'}${x} ${y.toFixed(1)} `
  }
  return (
    <Svg className={className}>
      <g className="stroke-viz-line" strokeWidth={1}>
        {[40, 80, 120].map((y) => (
          <line key={y} x1={0} y1={y} x2={240} y2={y} />
        ))}
        {[48, 96, 144, 192].map((x) => (
          <line key={x} x1={x} y1={26} x2={x} y2={144} />
        ))}
      </g>
      <path d={d} fill="none" strokeWidth={1.25} strokeOpacity={0.26} vectorEffect="non-scaling-stroke" style={{ stroke: c }} />
      <path d={d} pathLength={100} fill="none" strokeWidth={2} strokeLinecap="round" vectorEffect="non-scaling-stroke" className={frozen ? undefined : 'viz-draw'} style={lit(c)} />
      {!frozen && <line x1={0} y1={26} x2={0} y2={144} strokeWidth={1} strokeOpacity={0.3} vectorEffect="non-scaling-stroke" className="viz-scan stroke-text" />}
      <Tag x={8} y={16}>
        BTC / USD
      </Tag>
      <Num x={232} y={19} anchor="end" size={15} hue={hue}>
        $64,182
      </Num>
    </Svg>
  )
}

export function PriceChart({ hue = 'up', frozen, className }: VizProps) {
  // Price line with the entry level and a glowing live mark. Hub / history thumbnails.
  const c = HUE[hue]
  const pts = [12, 30, 22, 44, 36, 58, 50, 74, 66, 92, 80, 70, 96, 108]
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i / (pts.length - 1)) * 224 + 8} ${130 - p}`).join(' ')
  const [nx, ny] = [232, 130 - pts[pts.length - 1]]
  const entryY = 130 - 40
  return (
    <Svg className={className}>
      <g className="stroke-viz-line" strokeWidth={1}>
        {[34, 66, 98].map((y) => (
          <line key={y} x1={8} y1={y} x2={232} y2={y} strokeDasharray="2 4" />
        ))}
      </g>
      <line x1={8} y1={entryY} x2={232} y2={entryY} strokeWidth={1} strokeDasharray="5 4" className="stroke-text-3" />
      <path d={`${d} L232 130 L8 130 Z`} stroke="none" style={{ fill: c, fillOpacity: 0.08 }} />
      <path d={d} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" style={lit(c)} />
      <circle cx={nx} cy={ny} r={3.5} className={frozen ? undefined : 'viz-pulse'} style={{ fill: c, filter: glow(c, 5) }} />
      <Tag x={8} y={16} hue="dim">
        BTC · 30s
      </Tag>
      <Tag x={232} y={entryY - 4} anchor="end" hue="dim">
        ENTRY
      </Tag>
      <Num x={8} y={148} size={11} hue={hue}>
        +2.4%
      </Num>
    </Svg>
  )
}

export function DepthSurface({ frozen, className }: VizProps) {
  // Perspective book depth over time, rainbow ridges receding. The hero piece.
  const HUES: Array<Hue> = ['up', 'cyan', 'info', 'violet', 'amber', 'down']
  const ridges = 11
  const profile = (i: number, t: number) => {
    const peak = Math.exp(-Math.pow((t - 0.34 - i * 0.012) / 0.16, 2))
    const peak2 = 0.55 * Math.exp(-Math.pow((t - 0.7) / 0.12, 2))
    return Math.max(0, peak + peak2 + 0.06 * Math.sin(t * 22 + i))
  }
  return (
    <Svg className={className} fill>
      <g fill="none" strokeWidth={1.1} strokeLinejoin="round" vectorEffect="non-scaling-stroke">
        {Array.from({ length: ridges }, (_, i) => {
          const depth = i / (ridges - 1)
          const baseY = 128 - depth * 78
          const x0 = 16 + depth * 30
          const w = 208 - depth * 52
          const amp = 34 * (1 - depth * 0.45)
          let d = ''
          for (let s = 0; s <= 24; s++) {
            const t = s / 24
            const y = baseY - profile(i, t) * amp
            d += `${s === 0 ? 'M' : 'L'}${(x0 + t * w).toFixed(1)} ${y.toFixed(1)} `
          }
          const c = HUE[HUES[i % HUES.length]]
          return <path key={i} d={d} strokeOpacity={0.35 + depth * 0.6} className={frozen ? undefined : 'viz-pulse'} style={{ stroke: c, filter: depth > 0.5 ? glow(c, 2) : undefined }} />
        })}
      </g>
      <Tag x={10} y={140} hue="up">
        BIDS
      </Tag>
      <Tag x={10} y={20} hue="dim">
        DEPTH
      </Tag>
      <Tag x={228} y={20} anchor="end" hue="dim">
        NOW
      </Tag>
    </Svg>
  )
}

export function PayoutCurve({ hue = 'amber', frozen, className }: VizProps) {
  // Payout vs outcome: peak multiplier at the strike, decaying to the edges. Range game.
  const c = HUE[hue]
  const d = `M10 128 L70 26 Q120 8 170 26 L230 128`
  return (
    <Svg className={className}>
      <line x1={10} y1={128} x2={232} y2={128} className="stroke-viz-line" strokeWidth={1} />
      <line x1={10} y1={16} x2={10} y2={128} className="stroke-viz-line" strokeWidth={1} />
      <path d={`${d} L230 128 L10 128 Z`} style={{ fill: c, fillOpacity: 0.07 }} />
      <path d={d} fill="none" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" style={lit(c)} />
      <circle cx={120} cy={18} r={4} strokeWidth={1.5} className={frozen ? undefined : 'viz-pulse'} style={{ fill: c, stroke: c, filter: glow(c, 4) }} />
      <line x1={120} y1={22} x2={120} y2={128} strokeWidth={1} strokeDasharray="4 4" className="stroke-text-3" />
      <Tag x={10} y={16} hue="dim">
        PAYOUT
      </Tag>
      <Num x={132} y={24} size={14} hue={hue}>
        12.4×
      </Num>
      <Tag x={120} y={144} anchor="middle" hue="dim">
        STRIKE
      </Tag>
      <Tag x={14} y={144} hue="dim">
        LOW
      </Tag>
      <Tag x={228} y={144} anchor="end" hue="dim">
        HIGH
      </Tag>
    </Svg>
  )
}

export function VolumeBars({ hue = 'info', frozen, className }: VizProps) {
  // 24h volume by bucket, live.
  const c = HUE[hue]
  const pattern = [0.4, 0.72, 1, 0.58, 0.86, 0.5, 0.95, 0.68, 0.55, 0.8, 1, 0.46, 0.74, 0.9, 0.62, 0.36]
  const n = pattern.length
  return (
    <Svg className={className}>
      <line x1={8} y1={130} x2={232} y2={130} className="stroke-viz-line" strokeWidth={1} />
      {pattern.map((p, i) => {
        const x = 12 + i * ((232 - 12) / n)
        const h = p * 96
        const base: CSSProperties = { fill: c, filter: glow(c, 2) }
        return <rect key={i} x={x} y={130 - h} width={9} height={h} rx={1.5} fillOpacity={0.85} className={frozen ? undefined : 'viz-eq'} style={frozen ? base : { ...base, animationDelay: `${(i % 6) * 90}ms`, animationDuration: `${800 + (i % 4) * 140}ms` }} />
      })}
      <Tag x={8} y={16} hue="dim">
        VOLUME 24H
      </Tag>
      <Num x={232} y={19} anchor="end" size={13} hue={hue}>
        $2.4M
      </Num>
    </Svg>
  )
}

export function DepthLadder({ frozen, className }: VizProps) {
  // Order book: bids left (up), asks right (down), mid in the middle.
  const bids = [0.95, 0.7, 0.55, 0.4, 0.3]
  const asks = [0.9, 0.62, 0.5, 0.34, 0.22]
  const rowH = 18
  return (
    <Svg className={className} fill>
      <line x1={120} y1={26} x2={120} y2={136} className="stroke-viz-line" strokeWidth={1} />
      {bids.map((b, i) => (
        <rect key={`b${i}`} x={120 - b * 104} y={30 + i * rowH} width={b * 104} height={rowH - 6} rx={1.5} fillOpacity={0.22 + (1 - i / 5) * 0.4} className={!frozen && i === 0 ? 'viz-pulse' : undefined} style={{ fill: HUE.up }} />
      ))}
      {asks.map((a, i) => (
        <rect key={`a${i}`} x={120} y={30 + i * rowH} width={a * 104} height={rowH - 6} rx={1.5} fillOpacity={0.22 + (1 - i / 5) * 0.4} className={!frozen && i === 0 ? 'viz-pulse' : undefined} style={{ fill: HUE.down }} />
      ))}
      <Tag x={12} y={16} hue="up">
        BIDS
      </Tag>
      <Tag x={120} y={16} anchor="middle" hue="dim">
        $64,182
      </Tag>
      <Tag x={228} y={16} anchor="end" hue="down">
        ASKS
      </Tag>
    </Svg>
  )
}

// ── Gauges / meters ────────────────────────────────────────────────────────

function needle(cx: number, cy: number, r: number, value: number, span = 270, start = -135) {
  return pol(cx, cy, r, start + value * span)
}

export function ArcGauge({
  hue = 'amber',
  frozen,
  className,
  value = 0.5,
  display = '25×',
  label = 'LEVERAGE',
}: VizProps & { value?: number; display?: string; label?: string }) {
  const c = HUE[hue]
  const cx = 75
  const cy = 82
  const r = 52
  const start = -135
  const span = 270
  const [nx, ny] = needle(cx, cy, r - 8, value, span, start)
  return (
    <Svg square className={className}>
      <path d={arc(cx, cy, r, start, start + span)} fill="none" className="stroke-viz-line" strokeWidth={6} strokeLinecap="round" />
      <path d={arc(cx, cy, r, start, start + span * value)} fill="none" strokeWidth={6} strokeLinecap="round" vectorEffect="non-scaling-stroke" style={lit(c, 4)} />
      {Array.from({ length: 11 }, (_, i) => {
        const [x1, y1] = pol(cx, cy, r + 5, start + (i / 10) * span)
        const [x2, y2] = pol(cx, cy, r + 10, start + (i / 10) * span)
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className="stroke-text-3" strokeWidth={1} />
      })}
      <line x1={cx} y1={cy} x2={nx} y2={ny} strokeWidth={1.5} strokeLinecap="round" className={cnm('stroke-text', !frozen && 'viz-pulse')} />
      <circle cx={cx} cy={cy} r={4} className="fill-text" />
      <Num x={cx} y={cy - 14} anchor="middle" size={28} hue={hue}>
        {display}
      </Num>
      <Tag x={cx} y={cy + 26} anchor="middle">
        {label}
      </Tag>
    </Svg>
  )
}

export function GaugeCluster({ frozen, className }: VizProps) {
  // Four trading readouts at once: leverage, odds, size, risk.
  const cells: Array<{ hue: Hue; v: number; n: string; l: string }> = [
    { hue: 'info', v: 0.5, n: '25', l: 'LEV' },
    { hue: 'up', v: 0.68, n: '68', l: 'ODDS' },
    { hue: 'white', v: 0.4, n: '10', l: 'SIZE' },
    { hue: 'down', v: 0.3, n: '08', l: 'RISK' },
  ]
  return (
    <Svg className={className} fill>
      {cells.map((cell, i) => {
        const cx = 32 + i * 59
        const cy = 60
        const r = 22
        const c = HUE[cell.hue]
        const [nx, ny] = needle(cx, cy, r - 4, cell.v, 200, -100)
        return (
          <g key={i}>
            <Tag x={cx} y={20} anchor="middle">
              {cell.l}
            </Tag>
            <path d={arc(cx, cy, r, -100, 100)} fill="none" className="stroke-viz-line" strokeWidth={3} strokeLinecap="round" />
            <path d={arc(cx, cy, r, -100, -100 + 200 * cell.v)} fill="none" strokeWidth={3} strokeLinecap="round" style={lit(c)} />
            <line x1={cx} y1={cy} x2={nx} y2={ny} strokeWidth={1.25} className={cnm('stroke-text', !frozen && 'viz-pulse')} />
            <circle cx={cx} cy={cy} r={2.4} className="fill-text" />
            <Num x={cx} y={132} anchor="middle" size={26} hue={cell.hue}>
              {cell.n}
            </Num>
          </g>
        )
      })}
    </Svg>
  )
}

export function RadialMeter({
  hue = 'violet',
  frozen,
  className,
  value = 0.74,
  display = '74%',
  sub = 'MARGIN',
}: VizProps & { value?: number; display?: string; sub?: string }) {
  const c = HUE[hue]
  const cx = 75
  const cy = 75
  const r = 50
  const circ = 2 * Math.PI * r
  return (
    <Svg square className={className}>
      <circle cx={cx} cy={cy} r={r} fill="none" className="stroke-viz-line" strokeWidth={7} />
      <circle cx={cx} cy={cy} r={r} fill="none" strokeWidth={7} strokeLinecap="round" transform={`rotate(-90 ${cx} ${cy})`} strokeDasharray={circ} strokeDashoffset={circ * (1 - value)} style={lit(c, 5)} />
      {Array.from({ length: 36 }, (_, i) => {
        const [x1, y1] = pol(cx, cy, r - 11, i * 10)
        const [x2, y2] = pol(cx, cy, r - 14, i * 10)
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className="stroke-text-3" strokeWidth={i % 9 === 0 ? 1.5 : 0.75} />
      })}
      <Num x={cx} y={cy + 6} anchor="middle" size={32} hue={hue}>
        {display}
      </Num>
      <Tag x={cx} y={cy + 24} anchor="middle">
        {sub}
      </Tag>
      <circle cx={cx} cy={cy - r} r={3} className={frozen ? undefined : 'viz-pulse'} style={{ fill: c, filter: glow(c, 5) }} />
    </Svg>
  )
}

export function BetFader({ hue = 'amber', frozen, className, value = 0.62 }: VizProps & { value?: number }) {
  // Bet amount slider, the knob's on-screen twin.
  const c = HUE[hue]
  const x0 = 18
  const x1 = 222
  const cx = x0 + (x1 - x0) * value
  return (
    <Svg className={className}>
      <Tag x={x0} y={34}>
        BET AMOUNT
      </Tag>
      {Array.from({ length: 21 }, (_, i) => {
        const x = x0 + (i / 20) * (x1 - x0)
        return <line key={i} x1={x} y1={i % 5 === 0 ? 50 : 56} x2={x} y2={64} className="stroke-text-3" strokeWidth={1} />
      })}
      <line x1={x0} y1={78} x2={x1} y2={78} className="stroke-viz-line" strokeWidth={4} strokeLinecap="round" />
      <line x1={x0} y1={78} x2={cx} y2={78} strokeWidth={4} strokeLinecap="round" style={lit(c)} />
      <g className={frozen ? undefined : 'viz-pulse'}>
        <rect x={cx - 5} y={68} width={10} height={20} rx={2.5} className="fill-text" style={{ filter: glow(c, 4) }} />
        <line x1={cx} y1={72} x2={cx} y2={84} className="stroke-text-3" strokeWidth={1} />
      </g>
      <Num x={120} y={124} anchor="middle" size={30} hue={hue}>
        $62
      </Num>
      <Tag x={x0} y={144} hue="dim">
        MIN $1
      </Tag>
      <Tag x={x1} y={144} anchor="end" hue="dim">
        MAX $200
      </Tag>
    </Svg>
  )
}

export function ExposureBars({ frozen, className }: VizProps) {
  // Long vs short exposure, segmented.
  const seg = 12
  const rows: Array<{ label: string; hue: Hue; on: number }> = [
    { label: 'LONG', hue: 'up', on: 8 },
    { label: 'SHORT', hue: 'down', on: 4 },
  ]
  return (
    <Svg className={className} fill>
      {rows.map((row, ri) => {
        const c = HUE[row.hue]
        const y = ri === 0 ? 18 : 84
        return (
          <g key={row.label}>
            <Tag x={14} y={y + 18} hue={row.hue}>
              {row.label}
            </Tag>
            {Array.from({ length: seg }, (_, i) => {
              const lt = i < row.on
              return <rect key={i} x={64 + i * 14} y={y} width={9} height={28} rx={1.5} className={!frozen && lt && i === row.on - 1 ? 'viz-blink' : undefined} style={{ fill: lt ? c : 'var(--color-viz-line)', filter: lt ? glow(c, 2) : undefined }} />
            })}
          </g>
        )
      })}
    </Svg>
  )
}

export function LeverageLadder({ hue = 'amber', frozen, className }: VizProps) {
  // Pick leverage. The classic perp ladder, one rung lit.
  const c = HUE[hue]
  const steps = ['2×', '5×', '10×', '25×', '50×', '100×']
  const sel = 3
  const xL = 46
  const top = 26
  const bot = 128
  const yOf = (i: number) => bot - (i / (steps.length - 1)) * (bot - top)
  return (
    <Svg className={className} fill>
      <line x1={xL} y1={top} x2={xL} y2={bot} className="stroke-viz-line" strokeWidth={1} />
      {steps.map((s, i) => {
        const y = yOf(i)
        const on = i === sel
        return (
          <g key={s}>
            <line x1={xL - 6} y1={y} x2={xL + 6} y2={y} strokeWidth={on ? 2 : 1} style={{ stroke: on ? c : 'var(--color-text-3)' }} />
            <text x={xL - 12} y={y + 3.5} fontSize={10} textAnchor="end" className="font-mono" style={{ fill: on ? c : 'var(--color-text-3)', fontWeight: on ? 800 : 500 }}>
              {s}
            </text>
            {on && <circle cx={xL} cy={y} r={4} className={frozen ? undefined : 'viz-pulse'} style={{ fill: c, filter: glow(c, 4) }} />}
          </g>
        )
      })}
      <line x1={xL + 4} y1={yOf(sel)} x2={132} y2={86} strokeWidth={1} strokeDasharray="3 3" style={{ stroke: c }} />
      <Num x={150} y={96} anchor="middle" size={46} hue={hue}>
        25×
      </Num>
      <Tag x={150} y={118} anchor="middle">
        LEVERAGE
      </Tag>
    </Svg>
  )
}

// ── Timers ───────────────────────────────────────────────────────────────

export function CountdownRing({ hue = 'down', frozen, className }: VizProps) {
  // Time to expiry.
  const c = HUE[hue]
  const cx = 75
  const cy = 75
  const r = 52
  const circ = 2 * Math.PI * r
  const motion: CSSProperties = frozen ? { strokeDashoffset: circ * 0.32 } : ({ ['--viz-circ']: `${circ}`, ['--viz-dur']: '8s', strokeDashoffset: 0 } as CSSProperties)
  return (
    <Svg square className={className}>
      <circle cx={cx} cy={cy} r={r} fill="none" className="stroke-viz-line" strokeWidth={5} />
      <circle cx={cx} cy={cy} r={r} fill="none" strokeWidth={5} strokeLinecap="round" transform={`rotate(-90 ${cx} ${cy})`} strokeDasharray={circ} className={frozen ? undefined : 'viz-deplete'} style={{ ...motion, stroke: c, filter: glow(c, 5) }} />
      {Array.from({ length: 60 }, (_, i) => {
        const [x1, y1] = pol(cx, cy, r - 9, i * 6)
        const [x2, y2] = pol(cx, cy, r - (i % 5 === 0 ? 14 : 11), i * 6)
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className="stroke-text-3" strokeWidth={0.75} />
      })}
      <Num x={cx} y={cy + 8} anchor="middle" size={40} hue={hue}>
        08s
      </Num>
      <Tag x={cx} y={cy + 26} anchor="middle">
        TO EXPIRY
      </Tag>
    </Svg>
  )
}

export function RoundTimeline({ hue = 'amber', frozen, className }: VizProps) {
  // The position's life: open on the left, expiry on the right, now in between.
  const c = HUE[hue]
  const x0 = 20
  const x1 = 220
  const now = x0 + (x1 - x0) * 0.62
  return (
    <Svg className={className} fill>
      <Num x={120} y={50} anchor="middle" size={32} hue={hue}>
        08s
      </Num>
      <Tag x={120} y={66} anchor="middle">
        TIME LEFT
      </Tag>
      {Array.from({ length: 21 }, (_, i) => {
        const x = x0 + (i / 20) * (x1 - x0)
        return <line key={i} x1={x} y1={84} x2={x} y2={i % 5 === 0 ? 78 : 81} className="stroke-text-3" strokeWidth={1} />
      })}
      <line x1={x0} y1={94} x2={x1} y2={94} className="stroke-viz-line" strokeWidth={4} strokeLinecap="round" />
      <line x1={x0} y1={94} x2={now} y2={94} strokeWidth={4} strokeLinecap="round" style={lit(c)} />
      <circle cx={now} cy={94} r={5} className={frozen ? undefined : 'viz-pulse'} style={{ fill: c, filter: glow(c, 5) }} />
      <circle cx={x0} cy={94} r={3} className="fill-text-3" />
      <circle cx={x1} cy={94} r={3} className="fill-text-3" />
      <Tag x={x0} y={120} hue="up">
        OPEN
      </Tag>
      <Tag x={x1} y={120} anchor="end" hue="dim">
        SETTLE
      </Tag>
    </Svg>
  )
}

export function VolatilityScan({ hue = 'cyan', frozen, className }: VizProps) {
  // Sweep the markets for a move. Blips are live pairs.
  const c = HUE[hue]
  const cx = 75
  const cy = 75
  const blips: Array<[number, number]> = [
    [98, 52],
    [54, 96],
    [104, 92],
  ]
  const [ex, ey] = pol(cx, cy, 50, 52)
  return (
    <Svg square className={className}>
      {[18, 34, 50].map((r) => (
        <circle key={r} cx={cx} cy={cy} r={r} fill="none" strokeWidth={1} strokeOpacity={0.28} style={{ stroke: c }} />
      ))}
      <line x1={cx - 56} y1={cy} x2={cx + 56} y2={cy} strokeWidth={1} strokeOpacity={0.18} style={{ stroke: c }} />
      <line x1={cx} y1={cy - 56} x2={cx} y2={cy + 56} strokeWidth={1} strokeOpacity={0.18} style={{ stroke: c }} />
      <g className={frozen ? undefined : 'viz-sweep'}>
        <path d={`M${cx} ${cy} L${cx} ${cy - 50} A50 50 0 0 1 ${ex.toFixed(1)} ${ey.toFixed(1)} Z`} style={{ fill: c, fillOpacity: 0.16 }} />
        <line x1={cx} y1={cy} x2={cx} y2={cy - 50} strokeWidth={1.5} style={lit(c, 4)} />
      </g>
      {blips.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={2.5} className={frozen ? undefined : 'viz-pulse'} style={{ fill: c, filter: glow(c, 4), animationDelay: `${i * 600}ms` }} />
      ))}
      <circle cx={cx} cy={cy} r={2.5} style={{ fill: c, filter: glow(c, 4) }} />
      <Tag x={cx} y={140} anchor="middle" hue={hue}>
        VOLATILITY
      </Tag>
    </Svg>
  )
}

// ── Inputs / selectors ─────────────────────────────────────────────────────

export function DirectionPad({ frozen, className, active = 'up' }: VizProps & { active?: 'up' | 'down' }) {
  // Long / short. Bound to Action 1/2 on the console.
  const cell = (dir: 'up' | 'down') => {
    const on = active === dir
    const c = dir === 'up' ? HUE.up : HUE.down
    const y = dir === 'up' ? 12 : 78
    const arrow = dir === 'up' ? `M120 ${y + 14} l22 26 l-14 0 l0 18 l-16 0 l0 -18 l-14 0 Z` : `M120 ${y + 46} l22 -26 l-14 0 l0 -18 l-16 0 l0 18 l-14 0 Z`
    return (
      <g key={dir}>
        <rect x={64} y={y} width={112} height={56} rx={8} strokeWidth={on ? 1.5 : 1} style={on ? { fill: c, fillOpacity: 0.14, stroke: c, filter: glow(c, 4) } : { fill: 'transparent', stroke: 'var(--color-line-strong)' }} />
        <path d={arrow} className={on && !frozen ? 'viz-pulse' : undefined} style={on ? { fill: c, filter: glow(c, 3) } : { fill: 'var(--color-text-3)' }} />
      </g>
    )
  }
  return (
    <Svg className={className} fill>
      {cell('up')}
      {cell('down')}
      <Tag x={32} y={42} anchor="middle" hue={active === 'up' ? 'up' : 'dim'}>
        LONG
      </Tag>
      <Tag x={32} y={110} anchor="middle" hue={active === 'down' ? 'down' : 'dim'}>
        SHORT
      </Tag>
    </Svg>
  )
}

export function AssetList({ hue = 'amber', className }: VizProps) {
  // Market picker, TE selection bar.
  const items: Array<[string, string, Hue]> = [
    ['BTC', '+2.4%', 'up'],
    ['ETH', '-0.8%', 'down'],
    ['SUI', '+5.1%', 'up'],
    ['SOL', '+1.2%', 'up'],
    ['DEEP', '-3.0%', 'down'],
  ]
  const sel = 0
  const c = HUE[hue]
  return (
    <Svg className={className} fill>
      <Tag x={14} y={20}>
        MARKET
      </Tag>
      {items.map(([sym, chg, ch], i) => {
        const y = 30 + i * 22
        const on = i === sel
        return (
          <g key={sym}>
            {on && <rect x={10} y={y} width={220} height={20} rx={3} strokeWidth={1} style={{ fill: c, fillOpacity: 0.16, stroke: c, filter: glow(c, 2) }} />}
            <text x={20} y={y + 14} fontSize={13} style={{ fill: on ? c : 'var(--color-text-2)', fontWeight: on ? 800 : 600 }}>
              {sym}
            </text>
            <text x={220} y={y + 14} fontSize={11} textAnchor="end" className="font-mono" style={{ fill: HUE[ch] }}>
              {chg}
            </text>
          </g>
        )
      })}
    </Svg>
  )
}

export function StrikeReticle({ hue = 'amber', frozen, className }: VizProps) {
  // Entry / strike targeting for Range.
  const c = HUE[hue]
  const cx = 75
  const cy = 75
  return (
    <Svg square className={className}>
      {[16, 30, 46].map((r, i) => (
        <circle key={r} cx={cx} cy={cy} r={r} fill="none" strokeWidth={1} strokeOpacity={i === 1 ? 0.7 : 0.3} strokeDasharray={i === 2 ? '3 5' : undefined} className={!frozen && i === 1 ? 'viz-pulse' : undefined} style={{ stroke: c }} />
      ))}
      <line x1={6} y1={cy} x2={cx - 18} y2={cy} strokeWidth={1} style={{ stroke: c }} />
      <line x1={cx + 18} y1={cy} x2={144} y2={cy} strokeWidth={1} style={{ stroke: c }} />
      <line x1={cx} y1={6} x2={cx} y2={cy - 18} strokeWidth={1} style={{ stroke: c }} />
      <line x1={cx} y1={cy + 18} x2={cx} y2={144} strokeWidth={1} style={{ stroke: c }} />
      <circle cx={cx} cy={cy} r={2.5} style={{ fill: c, filter: glow(c, 4) }} />
      {(
        [
          [10, 10, 1, 1],
          [140, 10, -1, 1],
          [10, 140, 1, -1],
          [140, 140, -1, -1],
        ] as Array<[number, number, number, number]>
      ).map(([x, y, sx, sy], i) => (
        <path key={i} d={`M${x + sx * 10} ${y} L${x} ${y} L${x} ${y + sy * 10}`} fill="none" strokeWidth={1.25} strokeOpacity={0.6} style={{ stroke: c }} />
      ))}
      <Tag x={cx} y={cy - 24} anchor="middle" hue={hue}>
        STRIKE
      </Tag>
      <Tag x={cx} y={cy + 32} anchor="middle" hue="dim">
        $64,180
      </Tag>
    </Svg>
  )
}

// ── Status / readouts ───────────────────────────────────────────────────────

export function StatusBadge({
  className,
  state = 'live',
  frozen,
}: VizProps & { state?: 'flat' | 'live' | 'placing' | 'armed' }) {
  const map = {
    flat: { hue: 'info' as Hue, label: 'FLAT' },
    live: { hue: 'up' as Hue, label: 'LIVE' },
    placing: { hue: 'down' as Hue, label: 'PLACING' },
    armed: { hue: 'amber' as Hue, label: 'ARMED' },
  }
  const { hue, label } = map[state]
  const c = HUE[hue]
  const boxed = state === 'placing'
  return (
    <Svg className={className} fill>
      {boxed ? (
        <rect x={56} y={56} width={128} height={38} rx={6} fill="none" strokeWidth={1.5} className={frozen ? undefined : 'viz-blink'} style={{ stroke: c, filter: glow(c, 4) }} />
      ) : (
        <circle cx={72} cy={75} r={6} className={frozen ? undefined : 'viz-blink'} style={{ fill: c, filter: glow(c, 5) }} />
      )}
      <text x={boxed ? 120 : 90} y={81} fontSize={22} textAnchor={boxed ? 'middle' : 'start'} style={{ fill: c, fontWeight: 800, letterSpacing: '0.08em', filter: glow(c, 4) }}>
        {label}
      </text>
      <Tag x={120} y={128} anchor="middle">
        DEEPBOOK PREDICT
      </Tag>
    </Svg>
  )
}

export function PnlReadout({ hue = 'up', className, value = '+$18.42', label = 'LIVE P&L' }: VizProps & { value?: string; label?: string }) {
  return (
    <Svg className={className} fill>
      <Tag x={16} y={36}>
        {label}
      </Tag>
      <Num x={16} y={96} size={52} hue={hue}>
        {value}
      </Num>
      <line x1={16} y1={112} x2={224} y2={112} className="stroke-viz-line" strokeWidth={1} />
      <Tag x={16} y={132} hue="dim">
        PAYOUT
      </Tag>
      <text x={224} y={132} fontSize={12} textAnchor="end" className="fill-text-2" style={{ fontWeight: 700 }}>
        $42.00
      </text>
    </Svg>
  )
}

export function StatusStrip({ frozen, className }: VizProps) {
  // The console sensor bar: network, balance, signal, battery.
  return (
    <Svg className={className} fill>
      <Tag x={14} y={42} hue="up">
        ◆ DEVNET
      </Tag>
      <Num x={120} y={52} anchor="middle" size={26} hue="amber">
        $24.80
      </Num>
      <g transform="translate(176 30)" className={frozen ? undefined : 'viz-pulse'}>
        {[4, 8, 12].map((r, i) => (
          <path key={r} d={arc(10, 18, r, -50, 50)} fill="none" strokeWidth={1.25} strokeOpacity={1 - i * 0.2} className="stroke-text-2" />
        ))}
        <circle cx={10} cy={18} r={1.5} className="fill-text" />
      </g>
      <g transform="translate(204 24)">
        <rect x={0} y={0} width={26} height={13} rx={2.5} fill="none" strokeWidth={1.25} className="stroke-text-2" />
        <rect x={26} y={4} width={2.5} height={5} rx={1} className="fill-text-2" />
        <rect x={2} y={2} width={16} height={9} rx={1.5} style={{ fill: HUE.up }} />
      </g>
      <line x1={14} y1={72} x2={226} y2={72} className="stroke-viz-line" strokeWidth={1} />
      <Tag x={14} y={98} hue="dim">
        BALANCE
      </Tag>
      <Tag x={226} y={98} anchor="end" hue="dim">
        0xF8 · · 1756
      </Tag>
    </Svg>
  )
}

export function StatGrid({ className }: VizProps) {
  // Four stats in the colored-numeral style: win rate, volume, leverage, P&L.
  const cells: Array<{ n: string; hue: Hue; l: string }> = [
    { n: '62', hue: 'info', l: 'WIN %' },
    { n: '34', hue: 'up', l: 'VOL' },
    { n: '25', hue: 'white', l: 'LEV' },
    { n: '18', hue: 'down', l: 'P&L' },
  ]
  return (
    <Svg className={className} fill>
      {cells.map((c, i) => {
        const cx = 32 + i * 59
        return (
          <g key={i}>
            <Num x={cx} y={86} anchor="middle" size={38} hue={c.hue}>
              {c.n}
            </Num>
            <Tag x={cx} y={108} anchor="middle">
              {c.l}
            </Tag>
            {i > 0 && <line x1={cx - 29} y1={40} x2={cx - 29} y2={100} className="stroke-viz-line" strokeWidth={1} />}
          </g>
        )
      })}
    </Svg>
  )
}

export function OrderTicket({ hue = 'up', frozen, className }: VizProps) {
  // The position at a glance: side, asset, leverage, entry, liquidation, live P&L.
  const c = HUE[hue]
  return (
    <Svg className={className} fill>
      <rect x={14} y={12} width={50} height={22} rx={4} strokeWidth={1.25} style={{ fill: c, fillOpacity: 0.16, stroke: c }} />
      <text x={39} y={27} fontSize={11} textAnchor="middle" style={{ fill: c, fontWeight: 800, letterSpacing: '0.08em' }}>
        LONG
      </text>
      <text x={74} y={29} fontSize={15} style={{ fill: 'var(--color-text)', fontWeight: 800 }}>
        BTC
      </text>
      <Num x={226} y={30} anchor="end" size={18} hue="amber">
        25×
      </Num>
      <line x1={14} y1={44} x2={226} y2={44} className="stroke-viz-line" strokeWidth={1} />
      <Tag x={14} y={64} hue="dim">
        ENTRY
      </Tag>
      <text x={226} y={64} fontSize={12} textAnchor="end" className="fill-text" style={{ fontWeight: 700 }}>
        $64,180
      </text>
      <Tag x={14} y={86} hue="dim">
        LIQ
      </Tag>
      <text x={226} y={86} fontSize={12} textAnchor="end" style={{ fill: HUE.down, fontWeight: 700 }}>
        $58,900
      </text>
      <line x1={14} y1={100} x2={226} y2={100} className="stroke-viz-line" strokeWidth={1} />
      <Tag x={14} y={134} hue="dim">
        LIVE P&L
      </Tag>
      <text x={226} y={138} fontSize={26} textAnchor="end" className={frozen ? undefined : 'viz-pulse'} style={{ fill: c, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
        +$18.42
      </text>
    </Svg>
  )
}

// ── Schematic ────────────────────────────────────────────────────────────

export function PlayFlow({ hue = 'cyan', frozen, className }: VizProps) {
  // The play lifecycle: you open a position, it mints, it settles. Gasless, on-chain.
  const c = HUE[hue]
  const node = (x: number, label: string, on?: boolean) => (
    <g>
      <rect x={x} y={56} width={44} height={30} rx={4} strokeWidth={1.25} style={on ? { fill: c, fillOpacity: 0.14, stroke: c } : { fill: 'transparent', stroke: 'var(--color-line-strong)' }} />
      <text x={x + 22} y={75} fontSize={9} textAnchor="middle" className="font-mono" style={{ fill: on ? c : 'var(--color-text-2)', letterSpacing: '0.04em' }}>
        {label}
      </text>
    </g>
  )
  const conn = (x1: number, x2: number) => (
    <g style={{ stroke: c }}>
      <line x1={x1} y1={71} x2={x2 - 5} y2={71} strokeWidth={1.25} strokeDasharray="3 4" className={frozen ? undefined : 'viz-march'} />
      <path d={`M${x2 - 5} 71 l-6 -3 l0 6 Z`} style={{ fill: c, stroke: 'none' }} />
    </g>
  )
  return (
    <Svg className={className} fill>
      {node(14, 'YOU', true)}
      {conn(58, 98)}
      {node(98, 'OPEN')}
      {conn(142, 182)}
      {node(182, 'SETTLE')}
      <line x1={120} y1={56} x2={120} y2={34} strokeWidth={1} strokeOpacity={0.6} style={{ stroke: c }} />
      <path d="M120 18 l8 14 l-16 0 Z" fill="none" strokeWidth={1.25} style={{ stroke: HUE.amber }} />
      <text x={120} y={30} fontSize={8} textAnchor="middle" style={{ fill: HUE.amber, fontWeight: 800 }}>
        !
      </text>
      <path d="M14 112 q30 -16 60 0 t60 0 t60 0" fill="none" strokeWidth={1.25} strokeOpacity={0.5} style={{ stroke: c }} />
      <Tag x={14} y={140} hue="dim">
        ON-CHAIN · GASLESS
      </Tag>
    </Svg>
  )
}

export function LiquidationBar({ hue = 'down', frozen, className }: VizProps) {
  // Distance to liquidation on a price axis: danger zone, entry, live mark.
  const c = HUE[hue]
  const x0 = 20
  const x1 = 220
  const liq = x0 + 16
  const entry = 150
  const mark = 124
  return (
    <Svg className={className} fill>
      <Tag x={16} y={24}>
        DISTANCE TO LIQ
      </Tag>
      <Num x={224} y={30} anchor="end" size={22} hue={hue}>
        -8.2%
      </Num>
      {/* danger zone */}
      <rect x={x0} y={84} width={liq + 28 - x0} height={12} rx={2} style={{ fill: c, fillOpacity: 0.16 }} />
      <line x1={x0} y1={90} x2={x1} y2={90} className="stroke-viz-line" strokeWidth={4} strokeLinecap="round" />
      <line x1={liq + 28} y1={90} x2={x1} y2={90} strokeWidth={4} strokeLinecap="round" style={{ stroke: 'var(--color-up)', filter: glow('var(--color-up)', 2) }} />
      {/* liq tick */}
      <line x1={liq} y1={80} x2={liq} y2={100} strokeWidth={1.5} style={{ stroke: c }} />
      {/* entry tick */}
      <line x1={entry} y1={82} x2={entry} y2={98} strokeWidth={1.5} className="stroke-text-2" strokeDasharray="3 3" />
      {/* live mark */}
      <circle cx={mark} cy={90} r={5} className={frozen ? undefined : 'viz-pulse'} style={{ fill: 'var(--color-up)', filter: glow('var(--color-up)', 5) }} />
      <Tag x={liq} y={118} anchor="middle" hue={hue}>
        LIQ
      </Tag>
      <Tag x={entry} y={118} anchor="middle" hue="dim">
        ENTRY
      </Tag>
      <Tag x={x1} y={118} anchor="end" hue="up">
        SAFE
      </Tag>
    </Svg>
  )
}

// ── Hero / result ────────────────────────────────────────────────────────

export function ResultBurst({ hue = 'up', frozen, className }: VizProps) {
  const c = HUE[hue]
  const cx = 120
  const cy = 64
  return (
    <Svg className={className} fill>
      <g className={frozen ? undefined : 'viz-pulse'} style={{ stroke: c }}>
        {Array.from({ length: 16 }, (_, i) => {
          const [x1, y1] = pol(cx, cy, 26, i * 22.5)
          const [x2, y2] = pol(cx, cy, i % 2 ? 44 : 38, i * 22.5)
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={1.5} strokeLinecap="round" style={{ filter: glow(c, 2) }} />
        })}
      </g>
      <circle cx={cx} cy={cy} r={22} fill="none" strokeWidth={1.5} style={lit(c, 4)} />
      <path d="M111 64 l6 7 l13 -15" fill="none" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" style={{ stroke: c }} />
      <Num x={cx} y={118} anchor="middle" size={34} hue={hue}>
        +$28.40
      </Num>
      <Tag x={cx} y={138} anchor="middle" hue={hue}>
        IN THE ZONE
      </Tag>
    </Svg>
  )
}

export function LuckyWheel({ frozen, className }: VizProps) {
  // I Feel Lucky: segments are multipliers, it spins to a stop.
  const cx = 75
  const cy = 75 // centered in the square viewBox so viz-sweep pivots true
  const r = 50
  const segHues: Array<Hue> = ['up', 'down', 'up', 'down', 'up', 'down', 'amber', 'down']
  const labels = ['2×', '0', '3×', '0', '5×', '0', '10×', '0']
  const segs = segHues.length
  return (
    <Svg square className={className}>
      <g className={frozen ? undefined : 'viz-sweep'}>
        {Array.from({ length: segs }, (_, i) => {
          const [x0, y0] = pol(cx, cy, r, (i / segs) * 360)
          const [x1, y1] = pol(cx, cy, r, ((i + 1) / segs) * 360)
          const cc = HUE[segHues[i]]
          const [lx, ly] = pol(cx, cy, r * 0.66, ((i + 0.5) / segs) * 360)
          return (
            <g key={i}>
              <path d={`M${cx} ${cy} L${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z`} strokeWidth={1.25} style={{ fill: cc, fillOpacity: 0.16, stroke: cc }} />
              <text x={lx} y={ly + 3} fontSize={9} textAnchor="middle" className="font-mono" style={{ fill: cc, fontWeight: 800 }}>
                {labels[i]}
              </text>
            </g>
          )
        })}
        <circle cx={cx} cy={cy} r={r} fill="none" className="stroke-text-2" strokeWidth={1.5} />
      </g>
      <circle cx={cx} cy={cy} r={8} className="fill-canvas stroke-text-2" strokeWidth={1.5} />
      <path d={`M${cx} ${cy - r - 8} l-6 -10 l12 0 Z`} style={{ fill: HUE.amber, filter: glow(HUE.amber, 4) }} />
      <Tag x={cx} y={144} anchor="middle" hue="amber">
        I FEEL LUCKY
      </Tag>
    </Svg>
  )
}
