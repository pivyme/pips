import * as THREE from 'three'
import type { ConsoleAudio } from './consoleAudio'

const SW = 768, SH = 1200

export function createScreen(maxAniso: number, _audio: Pick<ConsoleAudio, 'tone' | 'chord'>) {
  const sCanvas = document.createElement('canvas')
  sCanvas.width = SW
  sCanvas.height = SH
  const sctx = sCanvas.getContext('2d')!
  const tex = new THREE.CanvasTexture(sCanvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = maxAniso

  sctx.clearRect(0, 0, SW, SH)
  tex.needsUpdate = true

  return {
    tex,
    moveSel: (_dir: number, _fromKnob = false) => {},
    switchTab: (_t: string) => {},
    select: () => {},
    tick: (_dt: number) => {},
  }
}
