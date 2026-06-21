// Renders the trader stats card to a PNG offscreen and hands it to the native share sheet,
// falling back to a download when the Web Share API cannot take files. One canvas renderer so
// the share image stays on-brand without pulling in a DOM-to-image dependency.
import type { UserStatsDTO } from '@/lib/api'

const W = 1080
const H = 960
const FONT = '"Gabarito Variable", ui-sans-serif, system-ui, sans-serif'

// Mirror of the trader-card tokens in styles.css / StatsCard.tsx. Canvas can't read CSS vars.
const C = {
  black: '#000000',
  amberTop: '#ffd550',
  amberMid: '#ffc016',
  amberBot: '#ef9f0a',
  amberBorder: '#d9990f',
  ink: '#1a1200',
  brand400: '#ffd24a',
  up: '#34d399',
  down: '#ff5a4d',
  white: '#ffffff',
  screen: '#0a0a0a',
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
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

// Draw an image cropped to cover the target box (object-fit: cover), centered.
function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const target = w / h
  const source = img.width / img.height
  let sw: number, sh: number, sx: number, sy: number
  if (source > target) {
    sh = img.height
    sw = sh * target
    sx = (img.width - sw) / 2
    sy = 0
  } else {
    sw = img.width
    sh = sw / target
    sx = 0
    sy = (img.height - sh) / 2
  }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h)
}

const shortAddr = (a: string): string => (a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a)
const commas = (n: number): string => Math.round(n).toLocaleString('en-US')

async function renderCard(
  stats: UserStatsDTO,
  user: { displayName: string; address: string },
): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  // Wait for the brand font so text doesn't render in a system fallback.
  if (typeof document !== 'undefined' && document.fonts) {
    try {
      await document.fonts.ready
    } catch {
      // render with the fallback font
    }
  }

  ctx.fillStyle = C.black
  ctx.fillRect(0, 0, W, H)

  ctx.textBaseline = 'alphabetic'

  // ── The amber bezel (the device body) ───────────────────────────────────
  const m = 48
  const pad = 40
  const bx = m
  const by = m
  const bw = W - m * 2
  const bh = H - m * 2
  const bodyR = 72

  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.6)'
  ctx.shadowBlur = 70
  ctx.shadowOffsetY = 32
  const body = ctx.createLinearGradient(0, by, 0, by + bh)
  body.addColorStop(0, C.amberTop)
  body.addColorStop(0.46, C.amberMid)
  body.addColorStop(1, C.amberBot)
  roundRect(ctx, bx, by, bw, bh, bodyR)
  ctx.fillStyle = body
  ctx.fill()
  ctx.restore()

  // Top gloss + bottom inner shade, clipped to the body for the skeuo read.
  ctx.save()
  roundRect(ctx, bx, by, bw, bh, bodyR)
  ctx.clip()
  const gloss = ctx.createLinearGradient(0, by, 0, by + 240)
  gloss.addColorStop(0, 'rgba(255,255,255,0.4)')
  gloss.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gloss
  ctx.fillRect(bx, by, bw, 240)
  const shade = ctx.createLinearGradient(0, by + bh - 120, 0, by + bh)
  shade.addColorStop(0, 'rgba(108,66,0,0)')
  shade.addColorStop(1, 'rgba(108,66,0,0.42)')
  ctx.fillStyle = shade
  ctx.fillRect(bx, by + bh - 120, bw, 120)
  ctx.restore()

  roundRect(ctx, bx, by, bw, bh, bodyR)
  ctx.lineWidth = 2
  ctx.strokeStyle = C.amberBorder
  ctx.stroke()

  // ── Header nameplate on the bezel ───────────────────────────────────────
  const chipX = bx + pad
  const chipY = by + pad + 6
  const logo = await loadImage('/assets/logos/pips-horizontal-black.svg')
  if (logo) {
    const lh = 56
    const lw = lh * (logo.width / logo.height || 1539 / 629)
    ctx.drawImage(logo, chipX, chipY + 2, lw, lh)
  } else {
    ctx.textAlign = 'left'
    ctx.fillStyle = C.ink
    ctx.font = `800 46px ${FONT}`
    ctx.fillText('PIPS', chipX, chipY + 40)
  }

  ctx.textAlign = 'right'
  ctx.fillStyle = 'rgba(46,30,0,0.6)'
  ctx.font = `800 26px ${FONT}`
  ctx.fillText('PLAYER CARD', bx + bw - pad, chipY + 36)

  // ── The recessed screen window ──────────────────────────────────────────
  const sx = bx + pad
  const sy = by + pad + 116
  const sw = bw - pad * 2
  const sh = by + bh - pad - sy
  const sr = 42

  ctx.save()
  roundRect(ctx, sx, sy, sw, sh, sr)
  ctx.clip()
  ctx.fillStyle = C.screen
  ctx.fillRect(sx, sy, sw, sh)
  const bg = await loadImage('/assets/images/stats-bg.png')
  if (bg) drawCover(ctx, bg, sx, sy, sw, sh)
  // Scrim so text always reads over the backdrop.
  const scrim = ctx.createLinearGradient(0, sy, 0, sy + sh)
  scrim.addColorStop(0, 'rgba(0,0,0,0.46)')
  scrim.addColorStop(0.4, 'rgba(0,0,0,0.3)')
  scrim.addColorStop(1, 'rgba(0,0,0,0.64)')
  ctx.fillStyle = scrim
  ctx.fillRect(sx, sy, sw, sh)
  // Inner top shadow for the sunk-in read.
  const recess = ctx.createLinearGradient(0, sy, 0, sy + 44)
  recess.addColorStop(0, 'rgba(0,0,0,0.55)')
  recess.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = recess
  ctx.fillRect(sx, sy, sw, 44)
  ctx.restore()

  roundRect(ctx, sx, sy, sw, sh, sr)
  ctx.lineWidth = 2
  ctx.strokeStyle = 'rgba(0,0,0,0.55)'
  ctx.stroke()

  // ── Screen content ──────────────────────────────────────────────────────
  const sp = 56
  const cx = sx + sp
  const cr = sx + sw - sp

  ctx.textAlign = 'left'
  let y = sy + 86
  ctx.fillStyle = C.white
  ctx.font = `800 58px ${FONT}`
  ctx.fillText(user.displayName, cx, y)
  y += 44
  ctx.fillStyle = 'rgba(255,255,255,0.45)'
  ctx.font = `500 28px ${FONT}`
  ctx.fillText(shortAddr(user.address), cx, y)

  // Hero: win rate (left) and net P&L (right). Flat, no glow.
  y += 64
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.font = `700 26px ${FONT}`
  ctx.fillText('WIN RATE', cx, y)
  ctx.textAlign = 'right'
  ctx.fillText('NET P&L', cr, y)

  y += 118
  ctx.textAlign = 'left'
  ctx.fillStyle = C.brand400
  ctx.font = `800 124px ${FONT}`
  ctx.fillText(`${Math.round(stats.winRate * 100)}%`, cx - 2, y)

  const net = parseFloat(stats.netPnl)
  ctx.textAlign = 'right'
  ctx.fillStyle = net >= 0 ? C.up : C.down
  ctx.font = `800 70px ${FONT}`
  ctx.fillText(`${net >= 0 ? '+' : '-'}$${commas(Math.abs(net))}`, cr, y)

  // Stat row: one merged pill split into four segments by hairlines.
  const pillW = sw - sp * 2
  const pillH = 120
  const pillY = y + 56
  const segW = pillW / 3
  roundRect(ctx, cx, pillY, pillW, pillH, 20)
  ctx.fillStyle = 'rgba(0,0,0,0.4)'
  ctx.fill()
  ctx.lineWidth = 1.5
  ctx.strokeStyle = 'rgba(255,255,255,0.07)'
  ctx.stroke()
  const cells: Array<[string, string]> = [
    ['PLAYS', commas(stats.gamesPlayed)],
    ['VOLUME', `$${commas(parseFloat(stats.totalVolume))}`],
    ['STREAK', commas(Math.max(0, stats.currentStreak))],
  ]
  cells.forEach(([label, value], i) => {
    const ex = cx + i * segW
    if (i > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(ex, pillY + 22)
      ctx.lineTo(ex, pillY + pillH - 22)
      ctx.stroke()
    }
    ctx.textAlign = 'left'
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.font = `700 22px ${FONT}`
    ctx.fillText(label, ex + 26, pillY + 46)
    ctx.fillStyle = C.white
    ctx.font = `800 50px ${FONT}`
    ctx.fillText(value, ex + 26, pillY + 98)
  })

  // Footer, on the screen.
  ctx.fillStyle = 'rgba(255,255,255,0.42)'
  ctx.font = `600 26px ${FONT}`
  ctx.textAlign = 'center'
  ctx.fillText('Built on Sui · DeepBook Predict', W / 2, sy + sh - 42)

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
}

export async function shareStatsCard(
  stats: UserStatsDTO,
  user: { displayName: string; address: string },
): Promise<void> {
  const blob = await renderCard(stats, user)
  if (!blob) throw new Error('Could not render the card')
  const file = new File([blob], 'pips-card.png', { type: 'image/png' })

  // Native share sheet first (mobile); fall back to a download elsewhere.
  const nav = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean }
  if (typeof nav.share === 'function' && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: 'My PIPS card' })
      return
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return // user dismissed the sheet
      // any other share failure falls through to the download
    }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'pips-card.png'
  a.click()
  URL.revokeObjectURL(url)
}
