import { useEffect, useRef } from 'react'

// A coin that flips on its Y axis behind the device glass, rendered as low-res amber pixels with
// ordered (Bayer) dithering and a scanline wash, so it reads like an old monochrome arcade screen
// rather than a crisp HD logo. The front face is the token logo (when we have one), the back is the
// ticker struck into the disc. Lives in the in-screen language (docs/SCREEN.md): true black, one
// amber accent, no soft 3D. `crt` toggles the dither/scanlines off for a clean readout.

type Props = {
  ticker: string
  logoSrc?: string
  // Backing resolution in pixels. Lower = chunkier pixels. ~60 is "high pixel art", not 8-bit mush.
  lores?: number
  spin?: boolean
  crt?: boolean
  className?: string
}

// Amber ramp the dithered luminance maps onto. Index 0 is near-black so the dither pattern breathes
// against the OLED panel; the top is the bright brand amber. BTC's orange sits naturally on this.
const RAMP: ReadonlyArray<[number, number, number]> = [
  [18, 11, 0],
  [92, 54, 0],
  [178, 116, 8],
  [255, 198, 64],
]
const LEVELS = RAMP.length - 1
// 4x4 Bayer matrix, normalized to a [-0.5, 0.5) bias. Classic ordered dither, no per-frame noise.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(
  (v) => (v + 0.5) / 16 - 0.5,
)

const SPIN_MS = 4600 // one full flip
const FRAME_MS = 1000 / 30 // chunky pixels don't need 60fps

export function CoinCRT({
  ticker,
  logoSrc,
  lores = 60,
  spin = true,
  crt = true,
  className,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const imgReady = useRef(false)
  // When the coin isn't flipping, redraw only on a real change (logo loaded, crt/ticker flipped)
  // instead of re-dithering the same frame 30x a second.
  const dirty = useRef(true)

  // Latest props the rAF loop reads, so we never tear down the loop just to flip a flag.
  const cfg = useRef({ ticker, spin, crt, lores })
  cfg.current = { ticker, spin, crt, lores }
  useEffect(() => {
    dirty.current = true
  }, [ticker, spin, crt, lores])

  // Load the logo once per src. Same-origin (public/), so the canvas never taints.
  useEffect(() => {
    imgReady.current = false
    imgRef.current = null
    if (!logoSrc) return
    const img = new Image()
    img.onload = () => {
      imgRef.current = img
      imgReady.current = true
      dirty.current = true
    }
    img.src = logoSrc
  }, [logoSrc])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return

    let raf = 0
    let last = 0
    let angle = 0

    const draw = (t: number) => {
      raf = requestAnimationFrame(draw)
      const { spin: spinning, crt: crtOn, ticker: tick } = cfg.current
      // Throttle to FRAME_MS; advance the flip by real elapsed time so it stays smooth.
      const dt = last ? t - last : 0
      if (dt < FRAME_MS && last) return
      last = t
      if (spinning) angle += (dt / SPIN_MS) * Math.PI * 2
      else if (!dirty.current) return
      dirty.current = false

      const W = canvas.width
      const H = canvas.height
      const cx = W / 2
      const cy = H / 2
      const R = Math.min(W, H) * 0.46

      ctx.clearRect(0, 0, W, H)

      // The flip: squash the face horizontally by |cos|. Front shows the logo, back the ticker.
      const c = Math.cos(spinning ? angle : 0.62) // resting tilt when motion is off
      const sx = Math.max(Math.abs(c), 0.001)
      const front = c >= 0

      ctx.save()
      ctx.translate(cx, cy)
      ctx.scale(sx, 1)

      // Disc body: a top-lit radial so the dither has a gradient to chew on (reads as a struck coin).
      const g = ctx.createRadialGradient(0, -R * 0.35, R * 0.1, 0, 0, R)
      g.addColorStop(0, '#ffd66b')
      g.addColorStop(0.55, '#d68a12')
      g.addColorStop(1, '#5c3500')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(0, 0, R, 0, Math.PI * 2)
      ctx.fill()

      if (front && imgReady.current && imgRef.current) {
        const d = R * 1.5
        ctx.drawImage(imgRef.current, -d / 2, -d / 2, d, d)
      } else {
        // Back face (or no logo): strike the ticker into the disc.
        ctx.fillStyle = '#2a1800'
        ctx.font = `900 ${Math.round(R * (tick.length > 3 ? 0.52 : 0.72))}px ui-sans-serif, system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(tick, 0, R * 0.04)
      }
      ctx.restore()

      // Rim flash: a bright vertical sliver as the coin turns edge-on, sells the 3D flip.
      const edge = Math.pow(1 - sx, 2.2)
      if (edge > 0.02) {
        ctx.save()
        ctx.globalAlpha = Math.min(edge, 1)
        ctx.fillStyle = '#ffd98a'
        const ew = Math.max(W * 0.02, 1.5)
        ctx.fillRect(cx - ew / 2, cy - R, ew, R * 2)
        ctx.restore()
      }

      if (!crtOn) return

      // Ordered dither pass: quantize luminance onto the amber ramp with the Bayer bias, and snap
      // alpha hard so pixels keep crisp square edges (no anti-aliased fringe = real pixel art).
      const buf = ctx.getImageData(0, 0, W, H)
      const px = buf.data
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4
          const a = px[i + 3]
          if (a < 64) {
            px[i + 3] = 0
            continue
          }
          const lum =
            (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255
          const bias = BAYER[(y & 3) * 4 + (x & 3)]
          let lvl = Math.round(lum * LEVELS + bias)
          if (lvl < 0) lvl = 0
          else if (lvl > LEVELS) lvl = LEVELS
          const [r, gg, b] = RAMP[lvl]
          px[i] = r
          px[i + 1] = gg
          px[i + 2] = b
          px[i + 3] = 255
        }
      }
      ctx.putImageData(buf, 0, 0)
    }

    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className={className} style={{ position: 'relative' }}>
      <canvas
        ref={canvasRef}
        width={lores}
        height={lores}
        style={{
          width: '100%',
          height: '100%',
          imageRendering: 'pixelated',
          display: 'block',
        }}
      />
      {crt && (
        <div
          aria-hidden
          className="viz-scanlines pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(120% 120% at 50% 38%, transparent 52%, rgba(0,0,0,0.6) 100%)',
          }}
        />
      )}
    </div>
  )
}
