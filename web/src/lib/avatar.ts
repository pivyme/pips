// Avatar helpers: the letter-fallback derivation (shared by <Avatar> and any chip surface) and a
// dependency-free client-side shrink of an uploaded image to a square webp for the upload route.

// On-brand chip palette, tuned to styles.css. Pick is deterministic (djb2 hash of the lowercased
// handle), so a handle always gets the same color across surfaces and reloads.
const CHIP_COLORS = ['#ffc016', '#34d399', '#ff5a4d', '#a78bfa', '#38bdf8', '#f472b6', '#facc15', '#4ade80'] as const
const CHIP_INK = '#0b0b0f'

function djb2(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

// First alphanumeric char of the handle, uppercased; '?' when there isn't one.
export function avatarInitial(name: string): string {
  const m = (name || '').match(/[a-z0-9]/i)
  return m ? m[0].toUpperCase() : '?'
}

// { bg, ink } for the letter chip, deterministic per handle.
export function avatarColor(name: string): { bg: string; ink: string } {
  const bg = CHIP_COLORS[djb2((name || '').toLowerCase()) % CHIP_COLORS.length]
  return { bg, ink: CHIP_INK }
}

const MAX_SOURCE_DIM = 8192 // reject absurd sources before they hit the canvas

// Shrink an image File to a square webp data URL, center-cover cropped (fill + center, never
// stretched/warped). Downscale only: a source smaller than `size` keeps its native side, it's never
// upscaled. Rejects a non-image or an unreadable/oversized source. No dependencies.
export async function toSquareWebp(file: File, size = 500, quality = 0.82): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('That file is not an image')
  const img = await loadImage(file)
  if (Math.max(img.width, img.height) > MAX_SOURCE_DIM) throw new Error('That image is too large')

  const side = Math.min(img.width, img.height) // the square crop side in source pixels
  const out = Math.min(size, side) // downscale-only output side
  const canvas = document.createElement('canvas')
  canvas.width = out
  canvas.height = out
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is unavailable')

  // Cover: scale by the smaller dimension so the square fills, center the overflow, crop the rest.
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  const scale = out / side
  const dw = img.width * scale
  const dh = img.height * scale
  ctx.drawImage(img, (out - dw) / 2, (out - dh) / 2, dw, dh)

  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', quality))
  if (!blob) throw new Error('Could not process that image')
  return await blobToDataUrl(blob)
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not read that image'))
    }
    img.src = url
  })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Could not read that image'))
    reader.readAsDataURL(blob)
  })
}
