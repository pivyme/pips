// Renders the trader stats card to a PNG offscreen and hands it to the native share sheet, falling back to a
// download when the Web Share API can't take files. One canvas renderer, no DOM-to-image dependency.
import type { UserStatsDTO } from '@/lib/api'
import type { CardTone } from '@/lib/playerCard'
import { buildCardModel } from '@/lib/playerCard'
import { avatarColor, avatarInitial } from '@/lib/avatar'

// 16:9 full-bleed share card: the amber body fills the whole PNG (no outer margin, no rounding), a dark
// screen window holds the content, name + avatar up top, hero centered, the three stats on the bottom.
const W = 1600
const H = 900
const FONT = '"Gabarito Variable", ui-sans-serif, system-ui, sans-serif'
const AVATAR_FONT = "'Open Runde', var(--font-sans), ui-sans-serif, sans-serif"

// Mirror of the trader-card tokens in styles.css / StatsCard.tsx. Canvas can't read CSS vars.
const C = {
  amberTop: '#ffd550',
  amberMid: '#ffc016',
  amberBot: '#ef9f0a',
  ink: '#1a1200',
  brand400: '#ffd24a',
  up: '#34d399',
  down: '#ff5a4d',
  white: '#ffffff',
  screen: '#0a0a0a',
}

// Mirror of toneText in StatsCard.tsx: gold featured, up/down signed, white neutral.
const toneColor = (t: CardTone): string =>
  t === 'gold' ? C.brand400 : t === 'up' ? C.up : t === 'down' ? C.down : C.white

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

// Load a possibly cross-origin avatar so it can paint into the canvas without tainting it (toBlob would
// throw on a tainted canvas). crossOrigin='anonymous' means a non-CORS host just fails the load instead
// of tainting, so we cleanly fall back to the identicon.
function loadImageCors(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

async function renderCard(
  stats: UserStatsDTO,
  user: { displayName: string; avatarUrl?: string | null },
): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  // Force the exact faces the canvas draws (handle = Gabarito, identicon = Open Runde) so nothing
  // renders in a system fallback at the wrong size.
  if (typeof document !== 'undefined' && document.fonts) {
    try {
      await Promise.all([
        document.fonts.load(`800 140px "Gabarito Variable"`),
        document.fonts.load(`700 60px 'Open Runde'`),
      ])
      await document.fonts.ready
    } catch {
      // render with the fallback font
    }
  }

  ctx.textBaseline = 'alphabetic'

  // ── Full-bleed amber body (edge to edge, no black background, no outer rounding) ──
  const body = ctx.createLinearGradient(0, 0, 0, H)
  body.addColorStop(0, C.amberTop)
  body.addColorStop(0.46, C.amberMid)
  body.addColorStop(1, C.amberBot)
  ctx.fillStyle = body
  ctx.fillRect(0, 0, W, H)
  // Top gloss + bottom inner shade for the skeuo read, across the full width.
  const gloss = ctx.createLinearGradient(0, 0, 0, 300)
  gloss.addColorStop(0, 'rgba(255,255,255,0.42)')
  gloss.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gloss
  ctx.fillRect(0, 0, W, 300)
  const shade = ctx.createLinearGradient(0, H - 160, 0, H)
  shade.addColorStop(0, 'rgba(108,66,0,0)')
  shade.addColorStop(1, 'rgba(108,66,0,0.4)')
  ctx.fillStyle = shade
  ctx.fillRect(0, H - 160, W, 160)

  // ── Header on the bezel: logo left, PLAYER CARD right ──
  const pad = 64
  const headY = 60
  const logo = await loadImage('/assets/logos/pips-horizontal-black.svg')
  if (logo) {
    const lh = 62
    const lw = lh * (logo.width / logo.height || 1539 / 629)
    ctx.drawImage(logo, pad, headY, lw, lh)
  } else {
    ctx.textAlign = 'left'
    ctx.fillStyle = C.ink
    ctx.font = `800 52px ${FONT}`
    ctx.fillText('PIPS', pad, headY + 48)
  }
  ctx.textAlign = 'right'
  ctx.fillStyle = 'rgba(46,30,0,0.6)'
  ctx.font = `800 30px ${FONT}`
  ctx.fillText('PLAYER CARD', W - pad, headY + 44)

  // ── The recessed screen window (fills the body below the header) ──
  const sx = pad
  const sy = 168
  const sw = W - pad * 2
  const sh = H - sy - pad
  const sr = 44

  ctx.save()
  roundRect(ctx, sx, sy, sw, sh, sr)
  ctx.clip()
  ctx.fillStyle = C.screen
  ctx.fillRect(sx, sy, sw, sh)
  const bg = await loadImage('/assets/images/stats-bg.webp')
  if (bg) drawCover(ctx, bg, sx, sy, sw, sh)
  const scrim = ctx.createLinearGradient(0, sy, 0, sy + sh)
  scrim.addColorStop(0, 'rgba(0,0,0,0.5)')
  scrim.addColorStop(0.45, 'rgba(0,0,0,0.34)')
  scrim.addColorStop(1, 'rgba(0,0,0,0.66)')
  ctx.fillStyle = scrim
  ctx.fillRect(sx, sy, sw, sh)
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

  // ── Screen content ──
  const sp = 72
  const cx = sx + sp
  const cr = sx + sw - sp
  const card = buildCardModel(stats)

  // Top: avatar (real photo if set, else the PIPS identicon) + handle (left), persona chip (right).
  const avR = 58
  const avCX = cx + avR
  const avCY = sy + 66 + avR
  const avatarImg = user.avatarUrl ? await loadImageCors(user.avatarUrl) : null
  if (avatarImg) {
    ctx.save()
    ctx.beginPath()
    ctx.arc(avCX, avCY, avR, 0, Math.PI * 2)
    ctx.closePath()
    ctx.clip()
    drawCover(ctx, avatarImg, avCX - avR, avCY - avR, avR * 2, avR * 2)
    ctx.restore()
  } else {
    const { bg: avBg, ink: avInk } = avatarColor(user.displayName)
    ctx.beginPath()
    ctx.arc(avCX, avCY, avR, 0, Math.PI * 2)
    ctx.closePath()
    ctx.fillStyle = avBg
    ctx.fill()
    ctx.fillStyle = avInk
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `700 ${Math.round(avR * 2 * 0.52)}px ${AVATAR_FONT}` // match <Avatar>: 0.52 of the diameter
    ctx.fillText(avatarInitial(user.displayName), avCX, avCY + 2)
    ctx.textBaseline = 'alphabetic'
  }
  ctx.beginPath()
  ctx.arc(avCX, avCY, avR, 0, Math.PI * 2)
  ctx.closePath()
  ctx.lineWidth = 2
  ctx.strokeStyle = 'rgba(255,255,255,0.16)'
  ctx.stroke()

  // Handle, vertically centered on the avatar (no address).
  const nameX = avCX + avR + 30
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = C.white
  ctx.font = `800 64px ${FONT}`
  ctx.fillText(user.displayName, nameX, avCY + 2)
  ctx.textBaseline = 'alphabetic'

  if (card.title) {
    ctx.font = `800 26px ${FONT}`
    const tw = ctx.measureText(card.title).width
    const chipH = 52
    const chipW = tw + 40
    const chipX = cr - chipW
    const chipY = avCY - chipH / 2
    roundRect(ctx, chipX, chipY, chipW, chipH, 14)
    ctx.fillStyle = 'rgba(255,210,74,0.16)'
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = 'rgba(255,210,74,0.42)'
    ctx.stroke()
    ctx.fillStyle = C.brand400
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(card.title, chipX + chipW / 2, chipY + chipH / 2 + 1)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
  }

  // Bottom: the three stats as one merged pill, anchored just above the footer.
  const footerY = sy + sh - 48
  const rowH = 150
  const rowY = footerY - 36 - rowH
  const rowW = sw - sp * 2
  const segW = rowW / 3
  roundRect(ctx, cx, rowY, rowW, rowH, 22)
  ctx.fillStyle = 'rgba(0,0,0,0.38)'
  ctx.fill()
  ctx.lineWidth = 1.5
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'
  ctx.stroke()
  card.grid.forEach((c, i) => {
    const ex = cx + i * segW
    if (i > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.09)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(ex, rowY + 28)
      ctx.lineTo(ex, rowY + rowH - 28)
      ctx.stroke()
    }
    // Center the label + value block in the pill: label cap-top ~rowY+38, value baseline ~rowY+112.
    ctx.textAlign = 'left'
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.font = `700 24px ${FONT}`
    ctx.fillText(c.label.toUpperCase(), ex + 36, rowY + 56)
    ctx.fillStyle = toneColor(c.tone)
    ctx.font = `800 58px ${FONT}`
    ctx.fillText(c.value, ex + 36, rowY + 112)
  })

  // Middle: the hero (left) + Net P&L (right), centered in the band between the name block and stats.
  const bandTop = avCY + avR
  const bandMid = (bandTop + rowY) / 2
  const labelY = bandMid - 66
  const valueY = bandMid + 52
  ctx.textAlign = 'left'
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.font = `700 28px ${FONT}`
  ctx.fillText(card.hero.label.toUpperCase(), cx, labelY)
  ctx.textAlign = 'right'
  ctx.fillText(card.netPnl.label.toUpperCase(), cr, labelY)

  ctx.textAlign = 'left'
  ctx.fillStyle = toneColor(card.hero.tone)
  ctx.font = `800 140px ${FONT}`
  ctx.fillText(card.hero.value, cx - 2, valueY)
  ctx.textAlign = 'right'
  ctx.fillStyle = toneColor(card.netPnl.tone)
  ctx.font = `800 90px ${FONT}`
  ctx.fillText(card.netPnl.value, cr, valueY)

  // Footer, on the screen.
  ctx.fillStyle = 'rgba(255,255,255,0.42)'
  ctx.font = `600 28px ${FONT}`
  ctx.textAlign = 'center'
  ctx.fillText('Built on Sui · DeepBook Predict', sx + sw / 2, footerY)

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
}

export async function shareStatsCard(
  stats: UserStatsDTO,
  user: { displayName: string; avatarUrl?: string | null },
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
