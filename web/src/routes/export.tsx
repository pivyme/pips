import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType, CSSProperties } from 'react'
import { toPng } from 'html-to-image'
import ConsoleCanvas from '@/components/console/ConsoleCanvas'
import { THEMES } from '@/components/console/themes'
import { ConsoleControlsProvider, DeviceSettledProvider, useConsoleView } from '@/components/console/controls'
import { GamesConsole } from './_app/games/index'
import { LuckyScreen } from './_app/games/lucky'
import { RangeScreen } from './_app/games/range'
import { LineRiderScreen } from './_app/games/line-rider'
import { CandleHopScreen } from './_app/games/candle-hop'
import { isDemo } from '@/lib/demo'

// Dev-only asset dump (personal tooling, not part of the product). Two modes:
//  - "Bare device": the handheld dead front-on, screen off, per skin, spinnable in 3D (the original).
//  - "Game screens": two handhelds. The LEFT one is live and playable, use the buttons + knob to set up
//    the shot (spin Lucky, fly Flappy, etc). The RIGHT one paints a snapshot of that screen onto its 3D
//    screen so the whole device holding the game spins in 3D and exports cleanly. Plus a screen-only PNG.
// The games need live content with no backend, so this route forces demo mode (it reloads once into it).
export const Route = createFileRoute('/export')({ component: ExportPage })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The in-device screens, keyed for the picker + filenames.
const SCREENS: { key: string; name: string; Comp: ComponentType }[] = [
  { key: 'home', name: 'Home', Comp: GamesConsole },
  { key: 'lucky', name: 'Lucky', Comp: LuckyScreen },
  { key: 'range', name: 'Range', Comp: RangeScreen },
  { key: 'line-rider', name: 'Line Rider', Comp: LineRiderScreen },
  { key: 'candle-hop', name: 'Candle Hop', Comp: CandleHopScreen },
]

function download(dataUrl: string, name: string) {
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = name
  a.click()
}

// Device aspect is 0.56 (w/h). Size the stage devices by whichever of height/width actually binds, so
// they never overflow and crop on a narrow window. Game mode fits two side by side (the width budget is
// halved); bare mode fits one. The px reserve leaves room for the 320px controls panel + paddings + gap.
const GAME_BOX: CSSProperties = {
  position: 'relative',
  height: 'min(74vh, (100vw - 470px) / 1.12)',
  width: 'calc(min(74vh, (100vw - 470px) / 1.12) * 0.56)',
}
const BARE_BOX: CSSProperties = {
  position: 'relative',
  height: 'min(86vh, (100vw - 420px) / 0.56)',
  width: 'calc(min(86vh, (100vw - 420px) / 0.56) * 0.56)',
}

function ExportPage() {
  const [mode, setMode] = useState<'device' | 'screens'>('screens')
  const [themeId, setThemeId] = useState(THEMES[0].id)
  const [gameKey, setGameKey] = useState(SCREENS[1].key) // default Lucky
  const [busy, setBusy] = useState<string | null>(null)
  const [rotX, setRotX] = useState(0) // pitch, degrees
  const [rotY, setRotY] = useState(0) // yaw, degrees
  const [snap, setSnap] = useState<string | null>(null) // current screen snapshot (the mesh texture)

  const liveRef = useRef<HTMLDivElement>(null) // the live, playable device (snapshot source)
  const exportRef = useRef<HTMLDivElement>(null) // the 3D textured device (read its <canvas> back)
  const bareRef = useRef<HTMLDivElement>(null) // bare-device mode

  const theme = THEMES.find((t) => t.id === themeId) ?? THEMES[0]
  const game = SCREENS.find((s) => s.key === gameKey) ?? SCREENS[0]
  const rad = (deg: number) => (deg * Math.PI) / 180
  const exportRot = useMemo(() => ({ x: rad(rotX), y: rad(rotY) }), [rotX, rotY])

  // The games hit the demo seam for prices/plays, so force demo on. isDemo() reads localStorage fresh,
  // but AuthProvider (in __root) decides authed-vs-anon once at boot, so flip the flag and reload into it.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!isDemo()) {
      try {
        localStorage.setItem('pips_demo', '1')
      } catch {
        // storage blocked: the live screens won't have content, but the tool still loads.
      }
      window.location.reload()
      return
    }
    setReady(true)
  }, [])

  // Snapshot the live device's screen (the projected HTML layer, CRT finish and all) to a PNG. Feeds
  // both the export device's screen-mesh texture and the screen-only PNG. The screen surface is
  // absolutely positioned at the projected cutout (a non-zero left/top); html-to-image keeps that
  // offset and would shove the content into the bottom-right with a blank top-left, so pin it to 0,0
  // (and drop any transform) for the capture only.
  async function takeSnapshot(): Promise<string | null> {
    const node = liveRef.current?.querySelector('.console-screen-surface') as HTMLElement | null
    if (!node) return null
    try {
      const url = await toPng(node, {
        pixelRatio: 2,
        cacheBust: true,
        backgroundColor: '#000',
        style: { left: '0px', top: '0px', margin: '0', transform: 'none' },
      })
      setSnap(url)
      return url
    } catch {
      return null
    }
  }

  // Mirror the live screen onto the export device while in game mode. A still tool, so a slow refresh
  // is plenty and keeps the html-to-image cost low. Plays update the next time it ticks.
  useEffect(() => {
    if (!ready || mode !== 'screens') return
    let alive = true
    const tick = () => {
      if (alive) void takeSnapshot()
    }
    const first = window.setTimeout(tick, 2600) // let the screen mount + the chart actually draw first
    const iv = window.setInterval(tick, 2200)
    return () => {
      alive = false
      window.clearTimeout(first)
      window.clearInterval(iv)
    }
    // gameKey: re-arm the first snapshot when the game switches (it remounts the screen).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, mode, gameKey])

  // Read a ConsoleCanvas's WebGL buffer straight back (lossless, transparent). exportMode keeps the
  // buffer around. Used for both the bare shot and the textured game shot.
  function captureCanvas(box: HTMLDivElement | null, name: string) {
    const canvas = box?.querySelector('canvas')
    if (!canvas) return
    download(canvas.toDataURL('image/png'), name)
  }

  // Refresh the texture from the current live screen, then read the export device back, so a Device PNG
  // always captures exactly what's on the live screen right now, at the chosen angle.
  async function captureDevicePng(name: string) {
    await takeSnapshot()
    await sleep(380) // let the snapshot upload as a texture + a frame render
    captureCanvas(exportRef.current, name)
  }

  async function captureScreenPng(name: string) {
    const url = await takeSnapshot()
    if (url) download(url, name)
  }

  async function downloadAllThemes() {
    setBusy('themes')
    for (const t of THEMES) {
      setThemeId(t.id)
      await sleep(900) // let the skin/logo SVGs load and the scene repaint before grabbing the buffer
      captureCanvas(bareRef.current, `pips-device-${t.id}.png`)
      await sleep(250) // stagger so the browser doesn't drop back-to-back downloads
    }
    setBusy(null)
  }

  async function downloadAllScreens() {
    setBusy('screens')
    for (const s of SCREENS) {
      setGameKey(s.key)
      await sleep(3600) // let the screen mount + its charts stream real data before the shot
      const url = await takeSnapshot() // refresh the mesh texture for this game
      await sleep(700) // let the texture upload + a frame render before reading the canvas back
      captureCanvas(exportRef.current, `pips-device-${s.key}-${themeId}.png`)
      await sleep(150)
      if (url) download(url, `pips-screen-${s.key}.png`)
      await sleep(200)
    }
    setBusy(null)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#1b1b1f', display: 'flex' }}>
      {/* stage */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 36, minWidth: 0, minHeight: 0, padding: 24, overflow: 'hidden' }}>
        {!ready ? (
          <span style={{ color: '#9aa', fontFamily: 'system-ui, sans-serif', fontSize: 13 }}>Preparing demo…</span>
        ) : mode === 'device' ? (
          <div ref={bareRef} style={BARE_BOX}>
            <ConsoleCanvas customize exportMode theme={theme} exportRot={exportRot} />
          </div>
        ) : (
          <>
            <DeviceColumn caption="▶ PLAY · set up the shot">
              <div ref={liveRef} style={GAME_BOX}>
                <ConsoleControlsProvider>
                  <LiveDevice theme={theme} Comp={game.Comp} gameKey={gameKey} />
                </ConsoleControlsProvider>
              </div>
            </DeviceColumn>

            <DeviceColumn caption="⤢ ROTATE · export">
              <div ref={exportRef} style={GAME_BOX}>
                <ConsoleCanvas customize exportMode theme={theme} exportRot={exportRot} screenTexture={snap} />
              </div>
            </DeviceColumn>
          </>
        )}
      </div>

      {/* controls */}
      <div style={{ width: 320, flexShrink: 0, padding: 24, color: '#e7e7ea', fontFamily: '-apple-system, system-ui, sans-serif', overflowY: 'auto', borderLeft: '1px solid #2a2a30' }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>PNG export</h1>
        <p style={{ fontSize: 12, opacity: 0.6, marginBottom: 16 }}>
          {mode === 'device' ? 'Front-on, screen off, transparent. Spin with the sliders.' : 'Play the left device to set up the shot, spin + export the right one. Demo mode.'}
        </p>

        <Segmented
          value={mode}
          onChange={(v) => setMode(v as typeof mode)}
          options={[
            { value: 'screens', label: 'Game screens' },
            { value: 'device', label: 'Bare device' },
          ]}
        />

        {mode === 'screens' ? (
          <>
            <Section label="Screen">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {SCREENS.map((s) => (
                  <button key={s.key} onClick={() => setGameKey(s.key)} style={pillStyle(s.key === gameKey)}>
                    {s.name}
                  </button>
                ))}
              </div>
            </Section>

            <Section label="Export">
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => captureDevicePng(`pips-device-${gameKey}-${themeId}.png`)} style={{ ...ghostStyle, flex: 1 }}>
                  Device PNG
                </button>
                <button onClick={() => captureScreenPng(`pips-screen-${gameKey}.png`)} style={{ ...ghostStyle, flex: 1 }}>
                  Screen PNG
                </button>
              </div>
              <button onClick={downloadAllScreens} disabled={!!busy} style={primaryStyle(!!busy)}>
                {busy === 'screens' ? 'Exporting…' : `Download all (${SCREENS.length * 2})`}
              </button>
            </Section>

            <Section label="Rotation (export device)">
              <RotSlider label="Pitch" value={rotX} onChange={setRotX} />
              <RotSlider label="Yaw" value={rotY} onChange={setRotY} />
              <button onClick={() => { setRotX(0); setRotY(0) }} style={{ ...ghostStyle, marginTop: 4 }}>Reset</button>
            </Section>

            <Section label="Device skin">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {THEMES.map((t) => (
                  <button key={t.id} onClick={() => setThemeId(t.id)} style={pillStyle(t.id === themeId)}>
                    {t.name}
                  </button>
                ))}
              </div>
            </Section>
          </>
        ) : (
          <>
            <button onClick={downloadAllThemes} disabled={!!busy} style={primaryStyle(!!busy)}>
              {busy === 'themes' ? 'Exporting…' : `Download all (${THEMES.length})`}
            </button>

            <Section label="Rotation">
              <RotSlider label="Pitch" value={rotX} onChange={setRotX} />
              <RotSlider label="Yaw" value={rotY} onChange={setRotY} />
              <button onClick={() => { setRotX(0); setRotY(0) }} style={{ ...ghostStyle, marginTop: 4 }}>Reset</button>
            </Section>

            <Section label="Skin">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {THEMES.map((t) => (
                  <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button onClick={() => setThemeId(t.id)} style={pillStyle(t.id === themeId, 150)}>
                      {t.name}
                    </button>
                    <button onClick={() => captureCanvas(bareRef.current, `pips-device-${t.id}.png`)} style={ghostStyle}>
                      PNG
                    </button>
                  </div>
                ))}
              </div>
            </Section>
          </>
        )}
      </div>
    </div>
  )
}

// The live, playable shell, wired like _app's Console3DRoute: the screen registers its controls and the
// device reads them back, so pressing the device buttons + knob actually plays the game. Switching games
// swaps the screen content (keyed) without rebuilding the WebGL device.
function LiveDevice({ theme, Comp, gameKey }: { theme: (typeof THEMES)[number]; Comp: ComponentType; gameKey: string }) {
  const { view, handlers } = useConsoleView()
  return (
    <ConsoleCanvas view={view} handlers={handlers} theme={theme} stage="app" instant screenContentVisible onNav={() => {}}>
      <DeviceSettledProvider settled>
        <Comp key={gameKey} />
      </DeviceSettledProvider>
    </ConsoleCanvas>
  )
}

function DeviceColumn({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, minWidth: 0 }}>
      {children}
      <span style={{ color: '#8a8a92', fontFamily: 'system-ui, sans-serif', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{caption}</span>
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.45, marginBottom: 8 }}>{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
    </div>
  )
}

function Segmented({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div style={{ display: 'flex', gap: 4, padding: 3, background: '#26262d', borderRadius: 8 }}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          style={{
            flex: 1,
            padding: '7px 0',
            background: o.value === value ? '#f2c044' : 'transparent',
            color: o.value === value ? '#1b1b1f' : '#cfcfd4',
            border: 0,
            borderRadius: 6,
            fontWeight: 600,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          {o.label}
        </button>
      ))}
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
      <input type="range" min={-180} max={180} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ width: '100%' }} />
    </label>
  )
}

const ghostStyle: CSSProperties = {
  padding: '6px 10px',
  background: 'transparent',
  color: '#9aa',
  border: '1px solid #3a3a42',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 12,
}

function pillStyle(active: boolean, width?: number): CSSProperties {
  return {
    width,
    textAlign: width ? 'left' : 'center',
    padding: '6px 10px',
    background: active ? '#33333a' : 'transparent',
    color: '#e7e7ea',
    border: `1px solid ${active ? '#5a5a66' : '#3a3a42'}`,
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
  }
}

function primaryStyle(disabled: boolean): CSSProperties {
  return {
    marginTop: 8,
    width: '100%',
    padding: '9px 14px',
    background: '#f2c044',
    color: '#1b1b1f',
    border: 0,
    borderRadius: 8,
    fontWeight: 600,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  }
}
