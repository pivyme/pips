import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useRef, useState } from 'react'
import ConsoleCanvas from '@/components/console/ConsoleCanvas'
import { THEMES } from '@/components/console/themes'

// Dev-only asset dump: renders the device dead front-on with the screen off (the customize look) on a
// transparent backdrop, and downloads one PNG per skin. Personal tooling, not part of the product.
export const Route = createFileRoute('/export')({ component: ExportPage })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function ExportPage() {
  const [themeId, setThemeId] = useState(THEMES[0].id)
  const [busy, setBusy] = useState(false)
  const [rotX, setRotX] = useState(0) // pitch, degrees
  const [rotY, setRotY] = useState(0) // yaw, degrees
  const boxRef = useRef<HTMLDivElement>(null)
  const theme = THEMES.find((t) => t.id === themeId) ?? THEMES[0]
  const rad = (deg: number) => (deg * Math.PI) / 180
  const exportRot = useMemo(() => ({ x: rad(rotX), y: rad(rotY) }), [rotX, rotY])

  function capture(name: string) {
    const canvas = boxRef.current?.querySelector('canvas')
    if (!canvas) return
    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = `pips-device-${name}.png`
    a.click()
  }

  async function downloadAll() {
    setBusy(true)
    for (const t of THEMES) {
      setThemeId(t.id)
      await sleep(900) // let the skin/logo SVGs load and the scene repaint before grabbing the buffer
      capture(t.id)
      await sleep(250) // stagger so the browser doesn't drop back-to-back downloads
    }
    setBusy(false)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#1b1b1f', display: 'flex' }}>
      {/* device stage — box ratio kept wider than the device so it's always contained, never cropped */}
      <div ref={boxRef} style={{ position: 'relative', height: '92vh', width: 'calc(92vh * 0.56)', alignSelf: 'center', marginLeft: 24 }}>
        <ConsoleCanvas customize exportMode theme={theme} exportRot={exportRot} />
      </div>

      <div style={{ flex: 1, padding: 24, color: '#e7e7ea', fontFamily: '-apple-system, system-ui, sans-serif', overflowY: 'auto' }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Device PNG export</h1>
        <p style={{ fontSize: 13, opacity: 0.6, marginBottom: 16 }}>Front-on, screen off, transparent background.</p>

        <button
          onClick={downloadAll}
          disabled={busy}
          style={{ padding: '8px 14px', background: '#f2c044', color: '#1b1b1f', border: 0, borderRadius: 8, fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1 }}
        >
          {busy ? 'Exporting…' : `Download all (${THEMES.length})`}
        </button>

        <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <RotSlider label="Rotate X (pitch)" value={rotX} onChange={setRotX} />
          <RotSlider label="Rotate Y (yaw)" value={rotY} onChange={setRotY} />
          <button
            onClick={() => { setRotX(0); setRotY(0) }}
            style={{ alignSelf: 'flex-start', padding: '4px 10px', background: 'transparent', color: '#9aa', border: '1px solid #3a3a42', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}
          >
            Reset rotation
          </button>
        </div>

        <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {THEMES.map((t) => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={() => setThemeId(t.id)}
                style={{ width: 130, textAlign: 'left', padding: '6px 10px', background: t.id === themeId ? '#33333a' : 'transparent', color: '#e7e7ea', border: '1px solid #3a3a42', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}
              >
                {t.name}
              </button>
              <button
                onClick={() => capture(t.id)}
                style={{ padding: '6px 10px', background: 'transparent', color: '#9aa', border: '1px solid #3a3a42', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}
              >
                PNG
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function RotSlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
      <span style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.8 }}>
        <span>{label}</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}°</span>
      </span>
      <input
        type="range"
        min={-180}
        max={180}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%' }}
      />
    </label>
  )
}
