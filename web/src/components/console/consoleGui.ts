import GUI from 'lil-gui'
import type * as THREE from 'three'

interface KnobParams {
  ridgeWidth: number; grooveWidth: number; bumpScale: number; cornerCurve: number
  ridgeRepeat: number; ridgePhase: number; radius: number; height: number; edgeCurve: number
  ridgeLength: number
  dragSensitivity: number; pxPerStep: number; snapInterval: number; snapSpeed: number
}

interface ButtonCfg {
  dx: number; dy: number; r: number; depth: number; baseZ: number; pressedZ: number; pad: number
}

interface GuiParams {
  kp: KnobParams
  buttons: ButtonCfg[]
  knobPocket: { pad: number; r: number }
  deviceCfg: { corner: number }
  bm: THREE.Mesh[]
  matKnobSlab: THREE.MeshStandardMaterial
  knobBump: THREE.CanvasTexture
  matScreen: THREE.MeshStandardMaterial
  deck: THREE.Group
  backPanel: THREE.Mesh
  lights: {
    key: THREE.DirectionalLight
    fill: THREE.DirectionalLight
    hemi: THREE.HemisphereLight
    ambient: THREE.AmbientLight
  }
  onRedrawBump: () => void
  onRebuildBodyGeo: () => void
  onRebuildBtnGeo: (i: number) => void
  onRebuildKnobGeo: () => void
  requestRender: () => void
}

export function createConsoleGui(p: GuiParams): GUI {
  const { kp, buttons, knobPocket, deviceCfg, bm, matKnobSlab, knobBump, matScreen, deck, backPanel, lights } = p

  const gui = new GUI({ title: 'Console', width: 280 })

  const gKnob = gui.addFolder('Knob')

  const gRidges = gKnob.addFolder('Ridges')
  gRidges.add(kp, 'ridgeWidth', 5, 120, 1).name('width').onChange(p.onRedrawBump)
  gRidges.add(kp, 'grooveWidth', 5, 120, 1).name('groove').onChange(p.onRedrawBump)
  gRidges.add(kp, 'bumpScale', 0, 30, 0.5).name('depth').onChange((v: number) => { matKnobSlab.bumpScale = v })
  gRidges.add(kp, 'cornerCurve', 0, 1, 0.01).name('curviness').onChange(p.onRedrawBump)
  gRidges.add(kp, 'ridgeLength', 0, 1, 0.01).name('length').onChange(p.onRedrawBump)
  gRidges.add(kp, 'ridgeRepeat', 1, 20, 0.5).name('repeat ×').onChange((v: number) => { knobBump.repeat.set(v, 1) })
  gRidges.add(kp, 'ridgePhase', 0, 1, 0.01).name('phase')

  const gKShape = gKnob.addFolder('Shape')
  gKShape.add(kp, 'radius', 0.3, 3, 0.05).name('radius').onChange(p.onRebuildKnobGeo)
  gKShape.add(kp, 'height', 0.1, 3, 0.05).name('height').onChange(p.onRebuildKnobGeo)
  gKShape.add(kp, 'edgeCurve', 0, 0.5, 0.01).name('edge round').onChange(p.onRebuildKnobGeo)

  const gKFeel = gKnob.addFolder('Feel')
  gKFeel.add(kp, 'dragSensitivity', 0.01, 0.5, 0.005).name('ridges / px')
  gKFeel.add(kp, 'pxPerStep', 10, 120, 5).name('px / step')
  gKFeel.add(kp, 'snapInterval').name('snap interval')
  gKFeel.add(kp, 'snapSpeed').name('snap speed')

  const gKPocket = gKnob.addFolder('Pocket')
  gKPocket.add(knobPocket, 'pad').name('pad').onChange(p.onRebuildBodyGeo)
  gKPocket.add(knobPocket, 'r').name('corner').onChange(p.onRebuildBodyGeo)

  const gBtns = gui.addFolder('Buttons')
  ;['Select', 'Up', 'Down', 'Menu', 'Games'].forEach((name, i) => {
    const f = gBtns.addFolder(name)
    f.add(buttons[i], 'dx', -2, 2, 0.01).name('x').onChange(() => p.onRebuildBtnGeo(i))
    f.add(buttons[i], 'dy', -2, 2, 0.01).name('y').onChange(() => p.onRebuildBtnGeo(i))
    f.add(buttons[i], 'r', 0, 0.8, 0.01).name('corner').onChange(() => p.onRebuildBtnGeo(i))
    f.add(buttons[i], 'depth').name('thickness').onChange(() => p.onRebuildBtnGeo(i))
    f.add(buttons[i], 'baseZ').name('z rest').onChange(() => { bm[i].userData.baseZ = buttons[i].baseZ })
    f.add(buttons[i], 'pressedZ').name('z press').onChange(() => { bm[i].userData.pressedZ = buttons[i].pressedZ })
    f.add(buttons[i], 'pad').name('pocket pad').onChange(p.onRebuildBodyGeo)
    f.close()
  })

  const flipState = { flipped: false }
  gui.add(flipState, 'flipped').name('flip to back').onChange((v: boolean) => {
    deck.rotation.y = v ? Math.PI : 0
    backPanel.visible = v // solid back only when we're looking at it (hidden it occludes the screen)
    p.requestRender() // single click, no drag to nudge the on-demand loop, so paint it now
  })

  const gScreen = gui.addFolder('Screen')
  gScreen.add(matScreen, 'opacity', 0, 1, 0.01).name('tint opacity')
  gScreen.add(matScreen, 'roughness', 0, 1, 0.01).name('roughness')
  gScreen.add(matScreen, 'metalness', 0, 1, 0.01).name('metalness')
  gScreen.add(matScreen, 'emissiveIntensity', 0, 10, 0.1).name('brightness')

  const gDevice = gui.addFolder('Device')
  gDevice.add(deviceCfg, 'corner', 0, 2, 0.01).name('body corner').onChange(p.onRebuildBodyGeo)

  const gLights = gui.addFolder('Lights')
  gLights.add(lights.key, 'intensity', 0, 6, 0.1).name('key')
  gLights.add(lights.fill, 'intensity', 0, 3, 0.1).name('fill')
  gLights.add(lights.hemi, 'intensity', 0, 4, 0.1).name('hemi')
  gLights.add(lights.ambient, 'intensity', 0, 2, 0.05).name('ambient')
  gLights.add(lights.key.shadow, 'radius', 0, 20, 0.5).name('shadow soft')
  gLights.add(lights.key.shadow, 'bias', -0.002, 0, 0.00005).name('shadow bias')
  gLights.add(lights.key.shadow, 'normalBias', 0, 0.1, 0.001).name('shadow nBias')

  return gui
}
