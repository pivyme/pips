// Shared image + font loading for the canvas share cards (playCard.ts, shareCard.ts).
// Two rules learned on mobile Safari: always await img.decode() before drawImage (onload fires before the
// bitmap is ready, which painted all-white cards), and cache loads module-level so reopening the sheet or
// flipping the PnL toggle re-renders instantly instead of re-fetching.

const cache = new Map<string, Promise<HTMLImageElement | null>>()

function load(src: string, cors: boolean): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    if (cors) img.crossOrigin = 'anonymous'
    img.onload = () => img.decode().then(() => resolve(img), () => resolve(img))
    img.onerror = () => resolve(null)
    img.src = src
  })
}

function cached(src: string, cors: boolean): Promise<HTMLImageElement | null> {
  let p = cache.get(src)
  if (!p) {
    p = load(src, cors)
    // A failed load (offline blip) must not poison the cache; drop it so the next render retries.
    void p.then((img) => {
      if (!img) cache.delete(src)
    })
    cache.set(src, p)
  }
  return p
}

export function loadImage(src: string): Promise<HTMLImageElement | null> {
  return cached(src, false)
}

// Cross-origin (avatar) load: crossOrigin='anonymous' so a non-CORS host fails the load cleanly instead of
// tainting the canvas (toBlob would throw). Callers fall back to the identicon on null.
export function loadImageCors(src: string): Promise<HTMLImageElement | null> {
  return cached(src, true)
}

// Load just the faces a card draws. Never document.fonts.ready (it waits for every font on the page); the
// race caps a stalled font fetch so the card can always render with fallback faces.
export function loadCardFonts(specs: Array<string>, timeoutMs = 2000): Promise<unknown> {
  if (typeof document === 'undefined') return Promise.resolve()
  const all = Promise.all(specs.map((s) => document.fonts.load(s).catch(() => [])))
  return Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))])
}

// Warm the heavy card art ahead of the share sheet so the first open renders instantly.
export function preloadPlayCardAssets(): void {
  void loadImage('/assets/pnl-card-template-win.webp')
  void loadImage('/assets/pnl-card-template-lose.webp')
}
