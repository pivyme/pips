// Renders the trader stats card to a PNG offscreen and hands it to the native share sheet,
// falling back to a download when the Web Share API cannot take files. One canvas renderer so
// the share image stays on-brand without pulling in a DOM-to-image dependency.
import type { UserStatsDTO } from '@/lib/api'

const W = 1080
const H = 1350
const FONT = '"Gabarito Variable", ui-sans-serif, system-ui, sans-serif'

// Mirror of the design tokens (docs/DESIGN.md). Canvas can't read CSS vars.
const C = {
  black: '#000000',
  cardTop: '#2d2d2c',
  cardBot: '#202020',
  line: 'rgba(255,255,255,0.08)',
  amber: '#ffc016',
  up: '#34d399',
  down: '#ff5a4d',
  text: '#dfdfdf',
  text3: '#5e5e5e',
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
  const halo = ctx.createRadialGradient(W / 2, 300, 60, W / 2, 300, 720)
  halo.addColorStop(0, 'rgba(255,192,22,0.20)')
  halo.addColorStop(1, 'rgba(255,192,22,0)')
  ctx.fillStyle = halo
  ctx.fillRect(0, 0, W, H)

  // The card panel: card-neo gradient + faint border.
  const m = 56
  const cw = W - m * 2
  const ch = H - m * 2
  const grad = ctx.createLinearGradient(0, m, 0, m + ch)
  grad.addColorStop(0, C.cardTop)
  grad.addColorStop(1, C.cardBot)
  roundRect(ctx, m, m, cw, ch, 56)
  ctx.fillStyle = grad
  ctx.fill()
  ctx.lineWidth = 2
  ctx.strokeStyle = C.line
  ctx.stroke()

  const px = m + 64
  ctx.textBaseline = 'alphabetic'

  // Header: logo + wordmark on the left, a tag on the right.
  let y = m + 120
  const logo = await loadImage('/assets/logos/pips-512.png')
  if (logo) ctx.drawImage(logo, px, y - 64, 72, 72)
  ctx.textAlign = 'left'
  ctx.fillStyle = C.amber
  ctx.font = `800 46px ${FONT}`
  ctx.fillText('PIPS', px + (logo ? 90 : 0), y)
  ctx.textAlign = 'right'
  ctx.fillStyle = C.text3
  ctx.font = `700 26px ${FONT}`
  ctx.fillText('TRADER CARD', W - px, y - 10)

  // Handle + address.
  ctx.textAlign = 'left'
  y += 130
  ctx.fillStyle = C.text
  ctx.font = `800 76px ${FONT}`
  ctx.fillText(user.displayName, px, y)
  y += 46
  ctx.fillStyle = C.text3
  ctx.font = `500 30px ${FONT}`
  ctx.fillText(shortAddr(user.address), px, y)

  // Divider.
  y += 70
  ctx.strokeStyle = C.line
  ctx.beginPath()
  ctx.moveTo(px, y)
  ctx.lineTo(W - px, y)
  ctx.stroke()

  // Hero: win rate (left) and net P&L (right).
  y += 80
  ctx.fillStyle = C.text3
  ctx.font = `700 30px ${FONT}`
  ctx.fillText('WIN RATE', px, y)
  ctx.textAlign = 'right'
  ctx.fillText('NET P&L', W - px, y)
  y += 150
  ctx.textAlign = 'left'
  ctx.fillStyle = C.amber
  ctx.font = `800 170px ${FONT}`
  ctx.fillText(`${Math.round(stats.winRate * 100)}%`, px - 4, y)
  const net = parseFloat(stats.netPnl)
  ctx.textAlign = 'right'
  ctx.fillStyle = net >= 0 ? C.up : C.down
  ctx.font = `800 88px ${FONT}`
  ctx.fillText(`${net >= 0 ? '+' : '-'}$${commas(Math.abs(net))}`, W - px, y)

  // Stat grid (2 x 2).
  ctx.textAlign = 'left'
  y += 110
  const colX = [px, W / 2 + 8]
  const cells: Array<[string, string]> = [
    ['GAMES PLAYED', commas(stats.gamesPlayed)],
    ['VOLUME', `$${commas(parseFloat(stats.totalVolume))}`],
    ['CURRENT STREAK', commas(stats.currentStreak)],
    ['BEST STREAK', commas(stats.maxStreak)],
  ]
  cells.forEach(([label, value], i) => {
    const cx = colX[i % 2]
    const cy = y + Math.floor(i / 2) * 160
    ctx.fillStyle = C.text3
    ctx.font = `700 26px ${FONT}`
    ctx.fillText(label, cx, cy)
    ctx.fillStyle = C.text
    ctx.font = `800 64px ${FONT}`
    ctx.fillText(value, cx, cy + 66)
  })

  // Footer.
  ctx.fillStyle = C.text3
  ctx.font = `600 28px ${FONT}`
  ctx.textAlign = 'center'
  ctx.fillText('Built on Sui · DeepBook Predict', W / 2, H - m - 56)

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
      await nav.share({ files: [file], title: 'My Pips card' })
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
