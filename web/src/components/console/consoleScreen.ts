import * as THREE from 'three'
import type { ConsoleAudio } from './consoleAudio'

const SW = 768, SH = 1200

export function createScreen(maxAniso: number, audio: Pick<ConsoleAudio, 'tone' | 'chord'>) {
  const sCanvas = document.createElement('canvas')
  sCanvas.width = SW
  sCanvas.height = SH
  const sctx = sCanvas.getContext('2d')!
  const tex = new THREE.CanvasTexture(sCanvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = maxAniso

  const lists: Record<string, string[]> = {
    GAMES: ['WICKED', 'PRICE PLINKO', 'STACKER', 'COIN PUSHER', 'DEEPBOOK PARLAY'],
    MENU: ['DISPLAY', 'SOUND', 'CONTROLS', 'ABOUT'],
  }
  let tab = 'GAMES'
  const sel: Record<string, number> = { GAMES: 0, MENU: 0 }
  let flashItem = -1, flashGlow = 0, flashLabel = ''

  function rrFill(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    c.beginPath()
    c.moveTo(x + r, y)
    c.arcTo(x + w, y, x + w, y + h, r)
    c.arcTo(x + w, y + h, x, y + h, r)
    c.arcTo(x, y + h, x, y, r)
    c.arcTo(x, y, x + w, y, r)
    c.closePath()
    c.fill()
  }

  function draw() {
    const c = sctx, pad = 48
    c.fillStyle = '#0a0a0b'
    c.fillRect(0, 0, SW, SH)
    const grad = c.createRadialGradient(SW * 0.4, 130, 40, SW * 0.4, 130, SW)
    grad.addColorStop(0, 'rgba(46,46,52,0.55)')
    grad.addColorStop(1, 'rgba(10,10,11,0)')
    c.fillStyle = grad
    c.fillRect(0, 0, SW, SH)
    c.fillStyle = 'rgba(0,0,0,0.16)'
    for (let y = 0; y < SH; y += 5) c.fillRect(0, y, SW, 2)

    c.textBaseline = 'alphabetic'
    c.textAlign = 'left'
    c.font = 'bold 32px "Courier New", monospace'
    let tabX = pad
    ;['MENU', 'GAMES'].forEach((t) => {
      const active = tab === t, w = c.measureText(t).width
      if (active) {
        c.fillStyle = 'rgba(233,112,46,0.22)'
        rrFill(c, tabX - 14, 44, w + 28, 46, 12)
      }
      c.fillStyle = active ? '#F6A86E' : '#5c5c5c'
      c.fillText(t, tabX, 78)
      tabX += w + 50
    })
    c.fillStyle = 'rgba(255,255,255,0.06)'
    c.fillRect(pad, 110, SW - 2 * pad, 2)

    if (flashGlow > 0.02) {
      c.font = 'bold 24px "Courier New", monospace'
      c.fillStyle = `rgba(255,150,70,${flashGlow})`
      c.fillText(`▶ LAUNCH ${flashLabel}`, pad, 152)
    }

    const startY = 260, rowH = 150
    lists[tab].forEach((item, i) => {
      const y = startY + i * rowH, selected = sel[tab] === i
      if (selected) {
        const f = flashItem === i ? flashGlow : 0
        c.fillStyle = `rgba(233,112,46,${0.16 + 0.55 * f})`
        rrFill(c, pad - 14, y - 48, SW - 2 * pad + 28, 70, 16)
        c.fillStyle = '#E9702E'
        rrFill(c, pad - 14, y - 48, 10, 70, 5)
      }
      c.font = selected ? 'bold 40px "Courier New", monospace' : '36px "Courier New", monospace'
      c.fillStyle = selected ? '#FFFFFF' : '#7c7c7c'
      c.fillText(item, pad + 28, y)
      c.font = '24px "Courier New", monospace'
      c.fillStyle = selected ? '#F6A86E' : '#454545'
      c.textAlign = 'right'
      c.fillText(String(i + 1).padStart(2, '0'), SW - pad - 16, y)
      c.textAlign = 'left'
    })

    c.font = '24px "Courier New", monospace'
    c.fillStyle = '#4c4c4c'
    c.fillText('▲▼ KNOB', pad, SH - 112)
    c.fillText('◉ SELECT', pad, SH - 72)

    tex.needsUpdate = true
  }

  function moveSel(dir: number, fromKnob = false) {
    const n = lists[tab].length
    const next = Math.max(0, Math.min(n - 1, sel[tab] + dir))
    if (next !== sel[tab]) {
      sel[tab] = next
      if (!fromKnob) audio.tone(380, 0.035)
      draw()
    }
  }

  function switchTab(t: string) {
    if (t === tab) return
    tab = t
    audio.chord([330, 440], 0.05)
    draw()
  }

  function select() {
    flashItem = sel[tab]
    flashLabel = lists[tab][sel[tab]]
    flashGlow = 1
    audio.chord([523, 784], 0.07)
    draw()
  }

  function tick(dt: number) {
    if (flashGlow <= 0.001) return
    flashGlow *= Math.pow(0.02, dt)
    draw()
    if (flashGlow <= 0.02) flashItem = -1
  }

  draw()

  return { tex, moveSel, switchTab, select, tick }
}
