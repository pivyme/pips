// Renders a single play to a 16:9 PNG "PnL card" for sharing, offscreen on a canvas, then hands it to the
// native share sheet (download fallback). The frame is the real template art (pnl-card-template-{win,lose}.webp,
// flat rasters so mobile decode is cheap): the amber device body, the recessed black screen, the PIPS logo badge,
// and the website badge, drawn pixel-for-pixel. All the play's numbers render INSIDE that black screen in the
// Teenage Engineering instrument language: true black, mono uppercase micro-labels over big bold tabular
// numbers, one tone accent (green win / red loss).
import type { LuckyParams, PlayDTO, RangeParams } from '@/lib/api'
import { loadCardFonts, loadImage } from '@/lib/cardAssets'

// Render options. The dollar PnL is private for a lot of people, so it's opt-in (default off); the ROI %
// (no absolute amount) always shows.
export type PlayCardOpts = { showPnl?: boolean }

const W = 1600
const H = 900
const FONT = '"Gabarito Variable", ui-sans-serif, system-ui, sans-serif'
const MONO = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace'

// The black screen rect baked into the win/lose templates (rect x=20 y=19 w=1561 h=809 rx=54). Content lives inside it.
const SCREEN = { x: 20, y: 19, w: 1561, h: 809, r: 54 }
// The template's logo + website badges sit at the very bottom of the screen; keep content clear of them.
const BADGE_TOP = 732

// Screen ink tokens (docs/SCREEN.md). Brighter than the App Surface greys, they read on true black.
const C = {
  ink: '#F2F2F2',
  ink2: '#B6B6B6',
  ink3: '#8A8A8A',
  up: '#34d399',
  down: '#ff5a4d',
  amber: '#ffc016',
  rule: 'rgba(255,255,255,0.16)',
}

// Token chip: the real coin art at /assets/images/coins/<ticker>-logo.png; assets without art fall back to a
// filled circle in this color with the ticker's first letter.
const ASSET: Record<string, string> = { BTC: '#f7931a', ETH: '#627eea', SOL: '#14f195', SUI: '#4da2ff' }

// The per-game line glyphs, same lucide icons the /games home uses (lucky=Dices, range=Target, moonshot=Rocket).
const GAME_ICON: Record<string, string> = {
  lucky:
    '<rect width="12" height="12" x="2" y="10" rx="2" ry="2"/><path d="m17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6"/><path d="M6 18h.01"/><path d="M10 14h.01"/><path d="M15 6h.01"/><path d="M18 9h.01"/>',
  range: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  moonshot:
    '<path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09"/><path d="M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05"/>',
}

// Wrap a lucide icon's children in an SVG with the stroke color baked in, as a data URI drawable on canvas.
function lucideDataUri(children: string, color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${children}</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

type Tone = 'win' | 'loss'
interface Cell {
  label: string
  value: string
}
export interface PlayCardModel {
  asset: string
  tone: Tone
  positive: boolean // drives the direction arrow (up on a gain, down on a loss)
  result: string // WON | LOST | CASHED OUT
  badge: string // "13x LONG"
  hero: string // the giant number: ROI ("+1,150%"), or the missed profit % on a full loss ("+738%")
  heroSub?: string // "MISSED PROFIT" under the giant on a full loss (a -100% ROI says nothing)
  netPnl: string // "+$12.34"
  showPnl: boolean // render the dollar PnL block
  duration: string // "30S"
  game: string // "LUCKY"
  settled: string // "Jul 18, 2026"
  cells: [Cell, Cell] // the two price levels (entry/settle, or the range band)
}

const multLabel = (n: number): string => `${n.toFixed(2).replace(/\.?0+$/, '')}x`

function price(s?: string): string {
  if (!s) return '—'
  const n = parseFloat(s)
  if (!Number.isFinite(n)) return '—'
  const d = n >= 1000 ? 0 : n >= 1 ? 2 : 6
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: d })}`
}

// Signed dollar amount, always 2dp: "+$12.34", "-$4.00". Used for stake, payout, and net PnL.
function usd(s?: string, signed = false): string {
  const n = parseFloat(s ?? '')
  if (!Number.isFinite(n)) return '—'
  const body = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const sign = signed ? (n >= 0 ? '+' : '-') : ''
  return `${sign}$${body}`
}

// ROI on cost basis. A binary loss is exactly -100%; big wins stay punchy (rounded once past 100%).
function roiLabel(pnl: number, cost: number): string {
  const p = cost > 0 ? (pnl / cost) * 100 : 0
  const abs = Math.abs(p)
  const body = abs >= 100 ? Math.round(abs).toLocaleString('en-US') : abs.toFixed(2).replace(/\.?0+$/, '')
  return `${p >= 0 ? '+' : '-'}${body}%`
}

function fmtDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function buildPlayCard(play: PlayDTO, opts?: PlayCardOpts): PlayCardModel {
  const pnl = parseFloat(play.pnl) || 0
  const cost = parseFloat(play.entryValue) || parseFloat(play.stake) || 0
  const positive = play.status === 'won' || (play.status === 'cashed_out' && pnl > 0)
  const tone: Tone = positive ? 'win' : 'loss'
  const result = play.status === 'won' ? 'WON' : play.status === 'cashed_out' ? 'CASHED OUT' : 'LOST'
  const asset = (play.params as { asset?: string }).asset || play.market.asset || 'BTC'
  const mult = multLabel(play.multiplier)

  let badge: string
  let cells: [Cell, Cell]
  if (play.game === 'range') {
    const rp = play.params as RangeParams
    badge = `${mult} RANGE`
    cells = [
      { label: 'LOWER', value: price(play.market.lower ?? rp.lower) },
      { label: 'UPPER', value: price(play.market.upper ?? rp.upper) },
    ]
  } else {
    const lp = play.params as LuckyParams
    const dir = play.game === 'moonshot' ? (lp.side === 'up' ? 'LONG' : 'SHORT') : lp.side === 'up' ? 'UP' : 'DOWN'
    badge = `${mult} ${dir}`
    const closed = play.settlePrice ?? play.market.strike
    cells = [
      { label: 'ENTRY', value: price(play.entrySpot) },
      { label: play.settlePrice ? 'SETTLE' : 'TARGET', value: price(closed) },
    ]
  }
  // A full loss is always exactly -100%, which says nothing. Lead with the payout that got away.
  const missed = cost * play.multiplier - cost
  const lostWithMissed = play.status === 'lost' && Number.isFinite(missed) && missed > 0

  return {
    asset,
    tone,
    positive,
    result,
    badge,
    hero: lostWithMissed ? roiLabel(missed, cost) : roiLabel(pnl, cost),
    heroSub: lostWithMissed ? 'MISSED PROFIT' : undefined,
    netPnl: usd(play.pnl, true),
    showPnl: opts?.showPnl ?? false,
    duration: `${play.params.duration}S`,
    game: play.game.toUpperCase(),
    settled: fmtDate(play.settledAt ?? play.openedAt),
    cells,
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// Tracked (letter-spaced) text, the mono silkscreen look. Baseline/align are set by the caller.
function tracked(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, em: number, size: number): void {
  ctx.letterSpacing = `${em * size}px`
  ctx.fillText(text, x, y)
  ctx.letterSpacing = '0px'
}

// A hairline-bordered mono pill (SCREEN.md status tag): bordered, never a filled candy pill. Returns its width.
function pill(ctx: CanvasRenderingContext2D, text: string, x: number, cy: number, color: string, size: number): number {
  ctx.font = `700 ${size}px ${MONO}`
  ctx.letterSpacing = `${0.08 * size}px`
  const tw = ctx.measureText(text).width + 0.08 * size
  const padX = size * 0.9
  const h = size + 22
  const w = tw + padX * 2
  roundRect(ctx, x, cy - h / 2, w, h, h / 2)
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.fillStyle = color
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x + padX, cy + 1)
  ctx.letterSpacing = '0px'
  return w
}

// A small filled direction triangle (up on a gain, down on a loss), the one bit of line-glyph identity.
function triangle(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, up: boolean, color: string): void {
  ctx.fillStyle = color
  ctx.beginPath()
  if (up) {
    ctx.moveTo(cx, cy - s)
    ctx.lineTo(cx + s, cy + s * 0.8)
    ctx.lineTo(cx - s, cy + s * 0.8)
  } else {
    ctx.moveTo(cx, cy + s)
    ctx.lineTo(cx + s, cy - s * 0.8)
    ctx.lineTo(cx - s, cy - s * 0.8)
  }
  ctx.closePath()
  ctx.fill()
}

function hairline(ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number): void {
  ctx.strokeStyle = C.rule
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(x0, y + 0.75)
  ctx.lineTo(x1, y + 0.75)
  ctx.stroke()
}

export async function renderPlayCard(play: PlayDTO, opts?: PlayCardOpts): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  await loadCardFonts(['800 170px "Gabarito Variable"', '700 40px "Gabarito Variable"', `700 26px ${MONO}`])

  const m = buildPlayCard(play, opts)
  const tone = m.tone === 'win' ? C.up : C.down

  // ── The frame: the real template art, pixel-for-pixel (amber body + black screen + tone emblem + badges).
  //    Win and loss have their own template, picked by the play's outcome. ──
  const template = await loadImage(`/assets/pnl-card-template-${m.tone === 'win' ? 'win' : 'lose'}.webp`)
  if (template) ctx.drawImage(template, 0, 0, W, H)
  else {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, W, H)
  }

  // Everything from here renders inside the black screen; clip so nothing spills onto the amber bezel.
  ctx.save()
  roundRect(ctx, SCREEN.x, SCREEN.y, SCREEN.w, SCREEN.h, SCREEN.r)
  ctx.clip()

  // The right ~half of the screen is the tone mascot art, so ALL info stays in the left column.
  const CL = 92 // content left, inset off the rounded screen bezel
  const LEFTMAX = 782 // right bound: keep text and rules clear of the mascot
  const RX0 = 44 // hairline rule left, tucked under the left rim

  // ── Eyebrow: game icon + name (bigger, like the /games home), then duration · date trailing, mono ──
  const gy = 76
  let ex = CL
  const gameGlyph = GAME_ICON[play.game] ? await loadImage(lucideDataUri(GAME_ICON[play.game], C.ink2)) : null
  if (gameGlyph) {
    ctx.drawImage(gameGlyph, ex, gy - 16, 32, 32)
    ex += 32 + 13
  }
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = C.ink2
  ctx.font = `700 31px ${MONO}`
  ctx.letterSpacing = `${0.06 * 31}px`
  ctx.fillText(m.game, ex, gy + 1)
  ex += ctx.measureText(m.game).width + 0.06 * 31 + 20
  ctx.letterSpacing = '0px'
  const trail = [m.duration, m.settled.toUpperCase()].filter(Boolean).join('  ·  ')
  if (trail) {
    ctx.fillStyle = C.ink3
    ctx.font = `500 24px ${MONO}`
    tracked(ctx, `·  ${trail}`, ex, gy + 1, 0.06, 24)
  }

  // ── Identity: token chip · TICKER · direction/mult pill ──
  const cy1 = 168
  const chipR = 38
  const chipCX = CL + chipR
  const coin = await loadImage(`/assets/images/coins/${m.asset.toLowerCase()}-logo.png`)
  ctx.save()
  ctx.beginPath()
  ctx.arc(chipCX, cy1, chipR, 0, Math.PI * 2)
  ctx.closePath()
  if (coin) {
    ctx.clip()
    const scale = Math.max((chipR * 2) / coin.width, (chipR * 2) / coin.height)
    ctx.drawImage(coin, chipCX - (coin.width * scale) / 2, cy1 - (coin.height * scale) / 2, coin.width * scale, coin.height * scale)
  } else {
    ctx.fillStyle = ASSET[m.asset.toUpperCase()] ?? '#5b6472'
    ctx.fill()
    ctx.fillStyle = C.ink
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `800 40px ${FONT}`
    ctx.fillText(m.asset.charAt(0).toUpperCase(), chipCX, cy1 + 2)
  }
  ctx.restore()

  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = C.ink
  ctx.font = `800 60px ${FONT}`
  const tickerX = chipCX + chipR + 26
  ctx.fillText(m.asset.toUpperCase(), tickerX, cy1 + 1)
  const badgeX = tickerX + ctx.measureText(m.asset.toUpperCase()).width + 26
  pill(ctx, m.badge, badgeX, cy1, tone, 26)

  hairline(ctx, RX0, LEFTMAX, 236)

  // ── The hero: result (with the optional net PnL inline) over the giant ROI ──
  const resultY = 314
  triangle(ctx, CL + 15, resultY - 8, 15, m.positive, tone)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = tone
  ctx.font = `800 34px ${MONO}`
  tracked(ctx, m.result, CL + 44, resultY, 0.14, 34)
  if (m.showPnl) {
    ctx.letterSpacing = `${0.14 * 34}px`
    const resultW = ctx.measureText(m.result).width + 0.14 * 34
    ctx.letterSpacing = '0px'
    let px = CL + 44 + resultW + 26
    ctx.fillStyle = C.ink3
    ctx.font = `700 30px ${FONT}`
    ctx.fillText('·', px, resultY - 1)
    px += ctx.measureText('·').width + 22
    ctx.fillStyle = tone
    ctx.font = `800 40px ${FONT}`
    ctx.fillText(m.netPnl, px, resultY + 3)
  }

  // Giant hero (ROI, or missed profit on a loss), shrunk to fit the left column so it never runs into the mascot.
  let roiFont = 168
  ctx.font = `800 ${roiFont}px ${FONT}`
  while (ctx.measureText(m.hero).width > LEFTMAX - CL && roiFont > 96) {
    roiFont -= 4
    ctx.font = `800 ${roiFont}px ${FONT}`
  }
  ctx.fillStyle = tone
  ctx.fillText(m.hero, CL - 4, 486)
  if (m.heroSub) {
    ctx.fillStyle = C.ink3
    ctx.font = `700 26px ${MONO}`
    tracked(ctx, m.heroSub, CL, 540, 0.14, 26)
  }

  hairline(ctx, RX0, LEFTMAX, 568)

  // ── Cells band: the two price levels, hairline-split, docked in the left column above the badges ──
  const segW = (LEFTMAX - CL) / 2
  m.cells.forEach((c, i) => {
    const x = CL + i * segW
    if (i > 0) {
      ctx.strokeStyle = C.rule
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(x - 26, 600)
      ctx.lineTo(x - 26, BADGE_TOP - 20)
      ctx.stroke()
    }
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = C.ink3
    ctx.font = `700 26px ${MONO}`
    tracked(ctx, c.label, x, 620, 0.12, 26)
    ctx.fillStyle = C.ink
    ctx.font = `800 52px ${FONT}`
    ctx.fillText(c.value, x, 680)
  })

  ctx.restore()

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
}

export async function sharePlayCard(play: PlayDTO, opts?: PlayCardOpts): Promise<void> {
  const blob = await renderPlayCard(play, opts)
  if (!blob) throw new Error('Could not render the card')
  const file = new File([blob], 'pips-pnl.png', { type: 'image/png' })

  const nav = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean }
  if (typeof nav.share === 'function' && nav.canShare?.({ files: [file] })) {
    try {
      // Files only, no title: a title alongside files makes iOS/Safari share the image twice.
      await nav.share({ files: [file] })
      return
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return // user dismissed the sheet
      // any other share failure falls through to the download
    }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'pips-pnl.png'
  a.click()
  URL.revokeObjectURL(url)
}
