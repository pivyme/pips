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
  logo: {
    carve: { z: number; eyeZ: number; depth: number }
    onPlace: () => void   // reposition only (z / eyeZ changed)
    onRebuild: () => void // re-extrude letters (depth changed)
  }
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
  const { kp, buttons, knobPocket, deviceCfg, bm, matKnobSlab, knobBump, matScreen, deck, backPanel, logo, lights } = p

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

  // Free Y rotation to inspect the model from any angle. The solid back fades in once it faces the
  // camera (past 90°) and stays hidden up front so it never occludes the screen.
  const spin = { y: 0 }
  gui.add(spin, 'y', -180, 180, 1).name('rotate').onChange((deg: number) => {
    deck.rotation.y = (deg * Math.PI) / 180
    backPanel.visible = Math.abs(deg) > 90
    p.requestRender()
  })

  // Carved back logo — recess (how far below the rear face) for letters and eyes, plus thickness.
  const gLogo = gui.addFolder('Back logo carve')
  gLogo.add(logo.carve, 'z', 0, 0.3, 0.005).name('letters recess').onChange(logo.onPlace)
  gLogo.add(logo.carve, 'eyeZ', -0.15, 0.3, 0.005).name('eyes z (- = pop out)').onChange(logo.onPlace)
  gLogo.add(logo.carve, 'depth', 0.005, 0.2, 0.005).name('depth').onChange(logo.onRebuild)
  gLogo.close()

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
