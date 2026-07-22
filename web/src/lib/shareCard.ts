// Renders the trader stats card to a PNG offscreen and hands it to the native share sheet, falling back to a
// download when the Web Share API can't take files. One canvas renderer, no DOM-to-image dependency.
import type { UserStatsDTO } from '@/lib/api'
import type { CardTone, RankStanding } from '@/lib/playerCard'
import { buildCardModel } from '@/lib/playerCard'
import { avatarColor, avatarInitial } from '@/lib/avatar'
import { loadCardFonts, loadImage, loadImageCors } from '@/lib/cardAssets'

// Share render options: hide dollar PnL, and the leaderboard standing that drives the rank chip.
export type CardOpts = { showNetPnl?: boolean; rank?: RankStanding | null }
// Who the card is for: handle, optional custom avatar, and the linked X account (drives the X pill).
export type CardUser = { displayName: string; avatarUrl?: string | null; twitter?: { username: string } | null }

// The X (Twitter) logo, from the same path as XGlyph, drawn at (x,y) in a size box.
const X_LOGO_PATH =
  'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231ZM17.083 19.77h1.833L7.084 4.126H5.117Z'
function drawXLogo(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(size / 24, size / 24)
  ctx.fillStyle = color
  ctx.fill(new Path2D(X_LOGO_PATH))
  ctx.restore()
}

// 16:9 full-bleed share card, laid out like the DOM StatsCard: a thin amber bezel, a header strip (logo +
// PLAYER CARD), then a recessed dark screen holding name/avatar, the hero + Net PnL, and the stats readout bar.
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
  label: 'rgba(255,255,255,0.55)',
}

// Mirror of toneText in StatsCard.tsx: gold featured, up/down signed, white neutral.
const toneColor = (t: CardTone): string =>
  t === 'gold' ? C.brand400 : t === 'up' ? C.up : t === 'down' ? C.down : C.white

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

// Tracked uppercase micro-label (mirrors the DOM's uppercase tracking on labels).
function tracked(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, em: number, size: number): void {
  ctx.letterSpacing = `${em * size}px`
  ctx.fillText(text, x, y)
  ctx.letterSpacing = '0px'
}

export async function renderCard(stats: UserStatsDTO, user: CardUser, opts?: CardOpts): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  // Force the exact faces the canvas draws (handle = Gabarito, identicon = Open Runde) so nothing
  // renders in a system fallback at the wrong size.
  await loadCardFonts([`800 150px "Gabarito Variable"`, `700 60px 'Open Runde'`])

  ctx.textBaseline = 'alphabetic'

  // ── Full-bleed amber bezel. Skeuo comes from a thin bright top lip and a dark bottom lip, not a big white
  //    wash, so the amber stays rich (matches .trader-bezel). ──
  const body = ctx.createLinearGradient(0, 0, 0, H)
  body.addColorStop(0, C.amberTop)
  body.addColorStop(0.46, C.amberMid)
  body.addColorStop(1, C.amberBot)
  ctx.fillStyle = body
  ctx.fillRect(0, 0, W, H)
  const gloss = ctx.createLinearGradient(0, 0, 0, 96)
  gloss.addColorStop(0, 'rgba(255,255,255,0.5)')
  gloss.addColorStop(0.16, 'rgba(255,255,255,0.14)')
  gloss.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gloss
  ctx.fillRect(0, 0, W, 96)
  ctx.fillStyle = 'rgba(255,255,255,0.6)' // the bright lifted top edge
  ctx.fillRect(0, 0, W, 3)
  const lip = ctx.createLinearGradient(0, H - 72, 0, H)
  lip.addColorStop(0, 'rgba(120,74,0,0)')
  lip.addColorStop(1, 'rgba(120,74,0,0.42)')
  ctx.fillStyle = lip
  ctx.fillRect(0, H - 72, W, 72)
  ctx.fillStyle = 'rgba(120,74,0,0.55)' // the hard bottom lip
  ctx.fillRect(0, H - 3, W, 3)

  // ── Header strip: logo left, PLAYER CARD right ──
  const pad = 36
  const hx = pad + 24
  const logoH = 86
  const logoY = 44
  const logo = await loadImage('/assets/logos/pips-horizontal-black.svg')
  if (logo) {
    const lw = logoH * (logo.width / logo.height || 1539 / 629)
    ctx.drawImage(logo, hx, logoY, lw, logoH)
  } else {
    ctx.textAlign = 'left'
    ctx.fillStyle = C.ink
    ctx.font = `800 72px ${FONT}`
    ctx.fillText('PIPS', hx, logoY + 66)
  }
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  ctx.font = `800 34px ${FONT}`
  ctx.fillStyle = 'rgba(255,255,255,0.28)' // soft white top-shadow, mirrors the DOM text-shadow
  tracked(ctx, 'PLAYER CARD', W - hx, logoY + logoH / 2 + 2, 0.18, 34)
  ctx.fillStyle = 'rgba(46,30,0,0.6)'
  tracked(ctx, 'PLAYER CARD', W - hx, logoY + logoH / 2, 0.18, 34)
  ctx.textBaseline = 'alphabetic'

  // ── The recessed screen window (fills the body below the header) ──
  const sx = pad
  const sy = 150
  const sw = W - pad * 2
  const sh = H - sy - pad
  const sr = 48

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
  // Bright hairline just below the recess (the amber lifts around the screen).
  ctx.strokeStyle = 'rgba(255,255,255,0.16)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(sx + sr, sy + sh + 2)
  ctx.lineTo(sx + sw - sr, sy + sh + 2)
  ctx.stroke()

  // ── Screen content ──
  const sp = 60
  const cx = sx + sp
  const cr = sx + sw - sp
  const card = buildCardModel(stats, opts)
  const gridIcons = await Promise.all(card.grid.map((c) => (c.icon ? loadImage(c.icon) : Promise.resolve(null))))

  // Stats readout bar docked flush to the bottom of the screen (mirrors the DOM). Computed first so the hero
  // band knows where it ends. Hidden when every stat is off.
  const hasGrid = card.grid.length > 0
  const rowH = 204
  const rowY = sy + sh - rowH
  const rowMid = rowY + rowH / 2

  // Top: avatar + handle (left), persona chip (right).
  const avR = 72
  const avCX = cx + avR
  const avCY = sy + sp + avR
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

  // Rank chip first (right-aligned) so the name knows how much room it has before it.
  let chipLeft = cr
  if (card.rank) {
    const rekt = card.rank.kind === 'rekt'
    const rgb = rekt ? '255,90,77' : '52,211,153'
    const label = `#${card.rank.rank} TOP ${rekt ? 'REKT' : 'GAINER'}`
    ctx.font = `900 44px ${FONT}`
    const tw = ctx.measureText(label).width
    const chipH = 84
    const chipW = tw + 90
    const chipX = cr - chipW
    const chipY = avCY - chipH / 2
    const rad = chipH / 2
    chipLeft = chipX
    // Filled enamel pill (no outline): tone gradient, recessed top, tone glow rising from the bottom.
    ctx.save()
    roundRect(ctx, chipX, chipY, chipW, chipH, rad)
    ctx.clip()
    const base = ctx.createLinearGradient(0, chipY, 0, chipY + chipH)
    base.addColorStop(0, `rgba(${rgb},0.32)`)
    base.addColorStop(1, `rgba(${rgb},0.13)`)
    ctx.fillStyle = base
    ctx.fillRect(chipX, chipY, chipW, chipH)
    const chipRecess = ctx.createLinearGradient(0, chipY, 0, chipY + 20)
    chipRecess.addColorStop(0, 'rgba(0,0,0,0.55)')
    chipRecess.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = chipRecess
    ctx.fillRect(chipX, chipY, chipW, 20)
    const glow = ctx.createLinearGradient(0, chipY + chipH - 32, 0, chipY + chipH)
    glow.addColorStop(0, `rgba(${rgb},0)`)
    glow.addColorStop(1, `rgba(${rgb},0.55)`)
    ctx.fillStyle = glow
    ctx.fillRect(chipX, chipY + chipH - 32, chipW, 32)
    ctx.restore()
    ctx.fillStyle = rekt ? C.down : C.up
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, chipX + chipW / 2, chipY + chipH / 2 + 1)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
  }

  // Handle next to the avatar, shrunk to fit the space before the rank chip. With a linked X account the
  // handle sits up top and an X pill drops beneath it.
  const nameX = avCX + avR + 32
  const nameMax = chipLeft - 24 - nameX
  let nameFont = 72
  ctx.font = `800 ${nameFont}px ${FONT}`
  while (ctx.measureText(user.displayName).width > nameMax && nameFont > 36) {
    nameFont -= 2
    ctx.font = `800 ${nameFont}px ${FONT}`
  }
  ctx.textAlign = 'left'
  ctx.fillStyle = C.white
  let pillBottom = avCY + avR
  if (user.twitter) {
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(user.displayName, nameX, avCY - 10)
    // X pill: logo + @handle, a soft rounded chip under the name.
    const at = `@${user.twitter.username}`
    ctx.font = `600 37px ${FONT}`
    const atW = ctx.measureText(at).width
    const glyph = 34
    const padX = 24
    const gap = 14
    const pillH = 68
    const pillW = padX + glyph + gap + atW + padX
    const pillY = avCY + 16
    pillBottom = pillY + pillH
    roundRect(ctx, nameX, pillY, pillW, pillH, pillH / 2)
    ctx.fillStyle = 'rgba(255,255,255,0.09)'
    ctx.fill()
    drawXLogo(ctx, nameX + padX, pillY + (pillH - glyph) / 2, glyph, C.white)
    ctx.fillStyle = 'rgba(255,255,255,0.82)'
    ctx.textBaseline = 'middle'
    ctx.fillText(at, nameX + padX + glyph + gap, pillY + pillH / 2 + 1)
    ctx.textBaseline = 'alphabetic'
  } else {
    ctx.textBaseline = 'middle'
    ctx.fillText(user.displayName, nameX, avCY + 2)
    ctx.textBaseline = 'alphabetic'
  }

  // Middle: the hero (left) + Net PnL (right, when shown). Both values sit on ONE bottom line (like the DOM's
  // items-end), and each label is tucked just above its OWN value, so a smaller Net PnL doesn't float.
  const nameBottom = user.twitter ? pillBottom : avCY + avR
  const bandTop = nameBottom
  const bandBottom = hasGrid ? rowY : sy + sh - 50
  const heroFont = 148
  const labelFont = 34
  const labelGap = 26
  const heroCap = heroFont * 0.72
  const labelCap = labelFont * 0.72
  const blockH = labelCap + labelGap + heroCap
  const valueBaseline = (bandTop + bandBottom) / 2 + blockH / 2

  ctx.textAlign = 'left'
  ctx.font = `700 ${labelFont}px ${FONT}`
  ctx.fillStyle = C.label
  tracked(ctx, card.hero.label.toUpperCase(), cx, valueBaseline - heroCap - labelGap, 0.12, labelFont)
  ctx.font = `800 ${heroFont}px ${FONT}`
  ctx.fillStyle = toneColor(card.hero.tone)
  ctx.fillText(card.hero.value, cx - 2, valueBaseline)

  if (card.netPnl) {
    const npFont = 98
    const npCap = npFont * 0.72
    ctx.textAlign = 'right'
    ctx.font = `700 ${labelFont}px ${FONT}`
    ctx.fillStyle = C.label
    tracked(ctx, card.netPnl.label.toUpperCase(), cr, valueBaseline - npCap - labelGap, 0.12, labelFont)
    ctx.font = `800 ${npFont}px ${FONT}`
    ctx.fillStyle = toneColor(card.netPnl.tone)
    ctx.fillText(card.netPnl.value, cr, valueBaseline)
  }

  // Bottom: the stats readout bar, docked flush to the bottom edge. Each cell is the icon centered next to a
  // label-over-value block, the pair vertically centered on the row (mirrors the DOM Cell's items-center).
  if (hasGrid) {
    const rowW = sw
    const segW = rowW / card.grid.length
    ctx.save()
    roundRect(ctx, sx, sy, sw, sh, sr)
    ctx.clip()
    ctx.fillStyle = 'rgba(0,0,0,0.42)'
    ctx.fillRect(sx, rowY, rowW, rowH)
    ctx.strokeStyle = 'rgba(255,255,255,0.09)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(sx, rowY + 0.75)
    ctx.lineTo(sx + rowW, rowY + 0.75)
    ctx.stroke()
    ctx.restore()
    card.grid.forEach((c, i) => {
      const ex = sx + i * segW
      if (i > 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.09)'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.moveTo(ex, rowY + 36)
        ctx.lineTo(ex, rowY + rowH - 36)
        ctx.stroke()
      }
      const icon = gridIcons[i]
      const iconSize = 94
      const padL = 50
      let textX = ex + padL
      if (icon) {
        ctx.drawImage(icon, ex + padL, rowMid - iconSize / 2, iconSize, iconSize)
        textX = ex + padL + iconSize + 22
      }
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'
      ctx.fillStyle = C.label
      ctx.font = `700 34px ${FONT}`
      tracked(ctx, c.label.toUpperCase(), textX, rowMid - 22, 0.05, 34)
      ctx.fillStyle = toneColor(c.tone)
      ctx.font = `800 70px ${FONT}`
      ctx.fillText(c.value, textX, rowMid + 52)
    })
  }

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
}

export async function shareStatsCard(stats: UserStatsDTO, user: CardUser, opts?: CardOpts): Promise<void> {
  const blob = await renderCard(stats, user, opts)
  if (!blob) throw new Error('Could not render the card')
  const file = new File([blob], 'pips-card.png', { type: 'image/png' })

  // Native share sheet first (mobile); fall back to a download elsewhere.
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
  a.download = 'pips-card.png'
  a.click()
  URL.revokeObjectURL(url)
}
