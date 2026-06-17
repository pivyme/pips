import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import * as THREE from 'three'
import { createConsoleGui } from './consoleGui'
import { roundedRect, roundedPoly, frontZeroed, setBoxUVs, roundedRectPath, roundedPolyPath } from './consoleGeo'
import { createAudio } from './consoleAudio'
import type { ConsoleView } from './controls'

// The 3D handheld, driven by the console controls registry. A game registers its bindings via
// useConsoleControls(); this paints live labels on the buttons + knob and dispatches the physical
// press/drag to those handlers. The game's screen content (the chart) renders in a black HTML layer
// positioned on the projected screen cutout, masked to the L-shape by the device body.

type HandlersRef = {
  current: {
    main?: () => void
    action1?: () => void
    action2?: () => void
    knob?: (value: number) => void
  }
}

interface ConsoleCanvasProps {
  view?: ConsoleView
  handlers?: HandlersRef
  onNav?: (tab: 'MENU' | 'GAMES') => void
  children?: ReactNode
  debug?: boolean
}

export default function ConsoleCanvas({ view, handlers, onNav, children, debug = false }: ConsoleCanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hintRef = useRef<HTMLDivElement>(null)
  const screenLayerRef = useRef<HTMLDivElement>(null)

  // Fresh per render so the scene's input handlers never read a stale binding.
  const propsRef = useRef({ handlers, onNav })
  propsRef.current = { handlers, onNav }
  const viewRef = useRef(view)
  viewRef.current = view
  // The scene exposes its label/state updater here; the [view] effect calls it.
  const applyViewRef = useRef<(v?: ConsoleView) => void>(() => {})

  useEffect(() => {
    const canvas = canvasRef.current
    const hint = hintRef.current
    if (!canvas || !hint) return

    const CREAM = 0xe9dbbf, RED = 0xd63a2e, BLUE = 0x3568c9, YELLOW = 0xefc03b

    /* renderer */
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    renderer.setClearColor(0x000000, 0)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.outputColorSpace = THREE.SRGBColorSpace
    const MAXANISO = renderer.capabilities.getMaxAnisotropy()

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100)

    /* lights */
    const hemi = new THREE.HemisphereLight(0xfff4e0, 0xcdbb98, 1.73)
    scene.add(hemi)
    const ambient = new THREE.AmbientLight(0xffffff, 0.5)
    scene.add(ambient)
    const key = new THREE.DirectionalLight(0xfff1da, 2.98)
    key.position.set(-4, 5, 9)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.radius = 4
    key.shadow.bias = -0.0005
    key.shadow.normalBias = 0.1
    key.shadow.camera.near = 0.5
    key.shadow.camera.far = 40
    key.shadow.camera.left = -8
    key.shadow.camera.right = 8
    key.shadow.camera.top = 10
    key.shadow.camera.bottom = -10
    scene.add(key)
    const fill = new THREE.DirectionalLight(0xffe9cf, 0.69)
    fill.position.set(5, 1, 6)
    scene.add(fill)

    /* coord helpers — maps pixel coords from the original layout to world units */
    const SCALE = 1 / 200, CX = 585, CY = 1155
    const wx = (px: number) => (px - CX) * SCALE
    const wy = (py: number) => (CY - py) * SCALE

    /* pocket holes — shared config needed before body geometry is built */
    const deviceCfg = { corner: 0.05 }
    const buttons = [
      // pad = gap between button edge and pocket rim on each side
      // pills share a wall so their pad is capped to avoid holes touching (~0.14 max before they'd merge)
      { w: 1.6, h: 1.5, r: 0.15, depth: 2, dx: 0, dy: 0, baseZ: 0.8, pressedZ: 0.4, pad: 0.12 },
      { w: 1.6, h: 1.5, r: 0.15, depth: 2, dx: 0, dy: 0, baseZ: 0.5, pressedZ: 0.4, pad: 0.12 },
      { w: 1.6, h: 1.5, r: 0.15, depth: 2, dx: 0, dy: 0, baseZ: 0.5, pressedZ: 0.4, pad: 0.12 },
      { w: 1.07, h: 0.35, r: 0.17, depth: 0.3, dx: 0, dy: 0, baseZ: 0.2, pressedZ: 0.15, pad: 0.12 },
      { w: 1.12, h: 0.35, r: 0.17, depth: 0.3, dx: 0, dy: 0, baseZ: 0.2, pressedZ: 0.15, pad: 0.12 },
    ]
    // button pixel centers — kept here so buildBodyShape stays in sync with makeButton calls below
    const BTN_PX = [
      { x: 965, y: 1490 }, { x: 200, y: 1860 }, { x: 589, y: 1860 },
      { x: 150, y: 2150 }, { x: 425, y: 2150 },
    ]
    // knob pocket config — w/h must stay in sync with kp.height / kp.radius*2 below
    // cylinder is rotated on Z so from the front it reads as w=height, h=radius*2
    const knobPocket = { px: 975, py: 1960, w: 1, h: 2.5, r: 0.02, pad: 0.04 }

    // screen L-shape in pixel coords — mirrors screenPts used for the screen mesh
    // screenMesh.position.y = 0.13 is baked in here as a world-space offset before converting to body-local
    const SCREEN_PX = [
      { x: 30, y: 1680 }, { x: 760, y: 1680 }, { x: 760, y: 1325 },
      { x: 1140, y: 1325 }, { x: 1140, y: 30 }, { x: 30, y: 30 },
    ]
    const SCREEN_MESH_Y_OFFSET = 0.13

    // The screen stretches to fill frames taller than the device's own ratio: `screenExt` is the
    // world height added above the natural body. The screen top + body top rise by it; the bottom
    // edge and the whole control deck stay put. 0 = natural device.
    let screenExt = 0

    // Screen L-shape corners in world space, with the top edge raised by screenExt. Drives both the
    // body cutout and the projected HTML layer, so they always agree.
    function screenWorldPts() {
      const yOf = (py: number) => wy(py) + SCREEN_MESH_Y_OFFSET + (py === 30 ? screenExt : 0)
      return SCREEN_PX.map((p) => new THREE.Vector3(wx(p.x), yOf(p.y), 0.06))
    }

    function buildBodyShape() {
      const cy = wy(1130) + screenExt / 2 // body center rises by ext/2 so the bottom edge stays fixed
      const s = roundedRect(6.2, 11.95 + screenExt, deviceCfg.corner)
      BTN_PX.forEach((p, i) => {
        // hole center in body-local space (body mesh sits at wx(585), cy)
        const lx = wx(p.x) + buttons[i].dx - wx(585)
        const ly = wy(p.y) + buttons[i].dy - cy
        const pad = buttons[i].pad
        const hw = buttons[i].w + pad * 2
        const hh = buttons[i].h + pad * 2
        // r + pad keeps the hole perfectly concentric with the button shape
        s.holes.push(roundedRectPath(lx, ly, hw, hh, Math.min(buttons[i].r + pad, hw / 2, hh / 2)))
      })
      // knob pocket — rectangular hole (cylinder lies on X-axis so front face is w×h)
      const klx = wx(knobPocket.px) - wx(585)
      const kly = wy(knobPocket.py) - cy
      const kw = knobPocket.w + knobPocket.pad * 2
      const kh = knobPocket.h + knobPocket.pad * 2
      s.holes.push(roundedRectPath(klx, kly, kw, kh, Math.min(knobPocket.r + knobPocket.pad, kw / 2, kh / 2)))
      // screen cutout — the L-shape (top raised by screenExt), converted to body-local coords
      s.holes.push(roundedPolyPath(
        screenWorldPts().map((v) => ({ x: v.x - wx(585), y: v.y - cy })),
        0.25,
      ))
      return s
    }

    /* audio */
    const audio = createAudio()

    // Screen: a matte near-black panel set into the body. The live chart renders as an HTML
    // layer on top (positioned to this aperture), so this mesh is just the dark backing that
    // shows at the very edge seam.
    const matScreen = new THREE.MeshStandardMaterial({
      color: 0x050505, roughness: 0.6, metalness: 0.2,
    })

    const matBody = new THREE.MeshStandardMaterial({ color: CREAM, roughness: 0.82, metalness: 0 })
    const matKnob = new THREE.MeshStandardMaterial({ color: YELLOW, roughness: 0.55, metalness: 0 })

    const deck = new THREE.Group()
    scene.add(deck)

    /* body */
    const body = new THREE.Mesh(frontZeroed(buildBodyShape(), 0.6, 0.08), matBody)
    body.position.set(wx(585), wy(1130), 0)
    body.receiveShadow = true
    body.castShadow = true
    deck.add(body)

    /* screen mesh */
    const screenPts = [
      { x: wx(30), y: wy(1680) },
      { x: wx(760), y: wy(1680) },
      { x: wx(760), y: wy(1325) },
      { x: wx(1140), y: wy(1325) },
      { x: wx(1140), y: wy(30) },
      { x: wx(30), y: wy(30) },
    ]
    const screenGeo = frontZeroed(roundedPoly(screenPts, 0.25), 0.12, 0.03)
    setBoxUVs(screenGeo)
    const screenMesh = new THREE.Mesh(screenGeo, matScreen)
    screenMesh.position.z = 0.06
    screenMesh.position.y = SCREEN_MESH_Y_OFFSET
    screenMesh.receiveShadow = true
    // The live HTML screen sits behind the device and shows through this cutout, so the panel mesh
    // would only occlude it. Keep it for the debug playground; hide it when a screen is bound.
    screenMesh.visible = debug
    deck.add(screenMesh)

    // Screen cutout in world space — projected to pixels each resize to place the HTML layer.
    // Reassigned by relayout() when the screen stretches to fill a tall frame.
    let screenWorld = screenWorldPts()

    /* buttons */
    const interactive: THREE.Mesh[] = []

    function makeButton(
      cx: number, cy: number, w: number, h: number, cornerR: number,
      baseZ: number, pressedZ: number, depth: number, color: number, glow: number,
    ): THREE.Mesh {
      const mat = new THREE.MeshStandardMaterial({
        color, roughness: 0.5, metalness: 0,
        emissive: new THREE.Color(glow), emissiveIntensity: 0,
      })
      const mesh = new THREE.Mesh(frontZeroed(roundedRect(w, h, cornerR), depth, 0.06), mat)
      mesh.position.set(cx, cy, baseZ)
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.userData = { kind: 'button', baseZ, pressedZ, depth, pressed: false, glow: 0, hover: 0 }
      deck.add(mesh)
      interactive.push(mesh)
      return mesh
    }

    const bm = [
      makeButton(wx(965), wy(1490), buttons[0].w, buttons[0].h, buttons[0].r, buttons[0].baseZ, buttons[0].pressedZ, buttons[0].depth, RED, 0xff5a3c),
      makeButton(wx(200), wy(1860), buttons[1].w, buttons[1].h, buttons[1].r, buttons[1].baseZ, buttons[1].pressedZ, buttons[1].depth, BLUE, 0x5e9bff),
      makeButton(wx(589), wy(1860), buttons[2].w, buttons[2].h, buttons[2].r, buttons[2].baseZ, buttons[2].pressedZ, buttons[2].depth, BLUE, 0x5e9bff),
      makeButton(wx(150), wy(2150), buttons[3].w, buttons[3].h, buttons[3].r, buttons[3].baseZ, buttons[3].pressedZ, buttons[3].depth, CREAM, 0xff7a1a),
      makeButton(wx(425), wy(2150), buttons[4].w, buttons[4].h, buttons[4].r, buttons[4].baseZ, buttons[4].pressedZ, buttons[4].depth, CREAM, 0xff7a1a),
    ]
    const bmOrigin = bm.map(m => ({ x: m.position.x, y: m.position.y }))

    /* pocket floors — dark inset plane visible in the gap between button edge and chamfered rim */
    const matPocket = new THREE.MeshStandardMaterial({ color: 0x19160f, roughness: 0.95, metalness: 0 })
    bm.forEach((btn, i) => {
      const c = buttons[i]
      const pad = c.pad
      const fw = c.w + pad * 2 - 0.04
      const fh = c.h + pad * 2 - 0.04
      const fr = Math.min(c.r + pad, fw / 2, fh / 2)
      const geo = new THREE.ShapeGeometry(roundedRect(fw, fh, fr), 48)
      const floor = new THREE.Mesh(geo, matPocket)
      floor.position.set(btn.position.x, btn.position.y, -0.04)
      floor.receiveShadow = true
      deck.add(floor)
    })
    // knob pocket floor
    const kfw = knobPocket.w + knobPocket.pad * 2 - 0.04
    const kfh = knobPocket.h + knobPocket.pad * 2 - 0.04
    const knobFloorGeo = new THREE.ShapeGeometry(roundedRect(kfw, kfh, Math.min(knobPocket.r + knobPocket.pad, kfw / 2, kfh / 2)), 48)
    const knobFloor = new THREE.Mesh(knobFloorGeo, matPocket)
    knobFloor.position.set(wx(knobPocket.px), wy(knobPocket.py), body.position.z - 0.04)
    knobFloor.receiveShadow = true
    deck.add(knobFloor)

    // Canvas-texture label. Static caption (makeLabel) or live, updatable (makeDynLabel).
    function drawLabel(c: HTMLCanvasElement, g: CanvasRenderingContext2D, text: string, color: string, fs = 64) {
      g.font = `700 ${fs}px -apple-system,"Segoe UI",system-ui,sans-serif`
      const tw = Math.max(1, Math.ceil(g.measureText(text || ' ').width))
      c.width = tw + 24
      c.height = fs + 24
      g.font = `700 ${fs}px -apple-system,"Segoe UI",system-ui,sans-serif`
      g.clearRect(0, 0, c.width, c.height)
      g.fillStyle = color
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(text, c.width / 2, c.height / 2)
    }

    function makeLabel(text: string, cx: number, cy: number, worldH: number, color: string) {
      const c = document.createElement('canvas'), g = c.getContext('2d')!
      drawLabel(c, g, text, color)
      const tex = new THREE.CanvasTexture(c)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = MAXANISO
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(worldH * (c.width / c.height), worldH),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
      )
      plane.position.set(cx, cy, 0.06)
      deck.add(plane)
      return plane
    }

    // Updatable label that lives on a button face (or the body) and reflects the registered view.
    function makeDynLabel(worldH: number, color: string) {
      const W = 640, H = 128, FS = 92
      const c = document.createElement('canvas')
      c.width = W
      c.height = H
      const g = c.getContext('2d')!
      const tex = new THREE.CanvasTexture(c)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = MAXANISO
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false })
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat)
      plane.renderOrder = 10
      let cur = '\0'
      let curColor = color
      function set(text: string, opacity = 1, color2?: string) {
        const col = color2 ?? curColor
        if (text !== cur || col !== curColor) {
          cur = text
          curColor = col
          g.clearRect(0, 0, W, H)
          if (text) {
            g.font = `700 ${FS}px -apple-system,"Segoe UI",system-ui,sans-serif`
            g.fillStyle = col
            g.textAlign = 'center'
            g.textBaseline = 'middle'
            g.fillText(text, W / 2, H / 2)
            const tw = Math.min(W, g.measureText(text).width + 36)
            tex.repeat.x = tw / W
            tex.offset.x = (1 - tw / W) / 2
            plane.scale.set(worldH * (tw / H), worldH, 1)
          }
          tex.needsUpdate = true
        }
        mat.opacity = text ? opacity : 0
      }
      set('', 0)
      return { plane, set }
    }

    const LABEL_DY = -0.45
    makeLabel('MENU', bm[3].position.x, bm[3].position.y + LABEL_DY, 0.26, '#7c7870')
    makeLabel('GAMES', bm[4].position.x, bm[4].position.y + LABEL_DY, 0.26, '#7c7870')

    // Live labels: main / action1 / action2 on their button faces, knob value on the body.
    const mainLbl = makeDynLabel(0.42, '#ffffff')
    mainLbl.plane.position.set(0, 0, 0.02)
    bm[0].add(mainLbl.plane)
    const a1Lbl = makeDynLabel(0.5, '#ffffff')
    a1Lbl.plane.position.set(0, 0, 0.02)
    bm[1].add(a1Lbl.plane)
    const a2Lbl = makeDynLabel(0.5, '#ffffff')
    a2Lbl.plane.position.set(0, 0, 0.02)
    bm[2].add(a2Lbl.plane)
    const knobLbl = makeDynLabel(0.42, '#2c2722')
    knobLbl.plane.position.set(wx(knobPocket.px), wy(knobPocket.py) - 1.55, 0.07)
    deck.add(knobLbl.plane)

    // View state mirrored from the registry, read by the input handlers for gating.
    const state = {
      mainDisabled: true, a1Disabled: true, a2Disabled: true, knobDisabled: true,
      knob: null as null | NonNullable<ConsoleView['knob']>,
    }

    function applyView(v?: ConsoleView) {
      const m = v?.main
      state.mainDisabled = !m || !!m.disabled || !!m.loading
      mainLbl.set(m?.loading ? '•••' : (m?.label ?? ''), state.mainDisabled ? 0.34 : 1)
      const a1 = v?.action1
      state.a1Disabled = !a1 || !!a1.disabled
      a1Lbl.set(a1?.label ?? '', state.a1Disabled ? 0.34 : 1)
      const a2 = v?.action2
      state.a2Disabled = !a2 || !!a2.disabled
      a2Lbl.set(a2?.label ?? '', state.a2Disabled ? 0.34 : 1)
      const k = v?.knob ?? null
      state.knob = k
      state.knobDisabled = !k || !!k.disabled
      knobLbl.set(k ? (k.format ? k.format(k.value) : String(k.value)) : '', state.knobDisabled ? 0.4 : 1)
    }
    applyViewRef.current = applyView

    function isBtnDisabled(i: number) {
      if (i === 0) return state.mainDisabled
      if (i === 1) return state.a1Disabled
      if (i === 2) return state.a2Disabled
      return false // pills (nav) are never disabled
    }
    function dispatch(i: number) {
      const h = propsRef.current.handlers?.current
      if (i === 0) h?.main?.()
      else if (i === 1) h?.action1?.()
      else if (i === 2) h?.action2?.()
      else if (i === 3) propsRef.current.onNav?.('MENU')
      else if (i === 4) propsRef.current.onNav?.('GAMES')
    }

    function rebuildBtnGeo(i: number) {
      const m = bm[i], c = buttons[i]
      m.geometry.dispose()
      m.geometry = frontZeroed(roundedRect(c.w, c.h, c.r), c.depth, 0.06)
      m.position.x = bmOrigin[i].x + c.dx
      m.position.y = bmOrigin[i].y + c.dy
      m.userData.depth = c.depth
      rebuildBodyGeo()
    }

    /* knob */
    const kp = {
      ridgeWidth: 120, grooveWidth: 50, bumpScale: 45, ridgeRepeat: 20,
      cornerCurve: 0.2,
      radius: 1.25, height: 0.95,
      dragSensitivity: 0.5, pxPerStep: 22, ridgePhase: 0,
      snapInterval: 20, snapSpeed: 5,
    }

    const bumpc = document.createElement('canvas')
    bumpc.width = 128
    bumpc.height = 128
    const bx = bumpc.getContext('2d')!
    const knobBump = new THREE.CanvasTexture(bumpc)
    knobBump.wrapS = knobBump.wrapT = THREE.RepeatWrapping

    function redrawBump() {
      const img = bx.createImageData(128, 128)
      const pitch = kp.ridgeWidth + kp.grooveWidth
      for (let x = 0; x < 128; x++) {
        const phase = x % pitch
        let v = 255
        if (phase < kp.grooveWidth) {
          const t = phase / kp.grooveWidth
          const valley = 1 - Math.sin(t * Math.PI)
          v = Math.round(valley * kp.cornerCurve * 255)
        }
        for (let y = 0; y < 128; y++) {
          const i = (y * 128 + x) * 4
          img.data[i] = img.data[i + 1] = img.data[i + 2] = v
          img.data[i + 3] = 255
        }
      }
      bx.putImageData(img, 0, 0)
      knobBump.needsUpdate = true
    }
    redrawBump()

    const matKnobSlab = matKnob.clone()
    matKnobSlab.bumpMap = knobBump
    matKnobSlab.bumpScale = kp.bumpScale
    matKnobSlab.roughness = 0.88
    knobBump.repeat.set(kp.ridgeRepeat, 1)

    const knobSlab = new THREE.Mesh(
      new THREE.CylinderGeometry(kp.radius, kp.radius, kp.height, 64, 4),
      matKnobSlab,
    )
    knobSlab.rotation.z = Math.PI / 2
    knobSlab.position.set(wx(975), wy(1960), -0.3)
    knobSlab.castShadow = true
    knobSlab.receiveShadow = true
    knobSlab.userData = { kind: 'knob', hover: 0 }
    deck.add(knobSlab)
    interactive.push(knobSlab)

    let knobOffset = 0
    let knobTarget = 0

    function rebuildBodyGeo() {
      body.geometry.dispose()
      body.geometry = frontZeroed(buildBodyShape(), 0.6, 0.08)
      body.position.y = wy(1130) + screenExt / 2
    }

    // Stretch the screen + body top to `ext` world units past natural, then refresh the projection
    // points. The control deck stays fixed. No-op when unchanged so resize churn stays cheap.
    function relayout(ext: number) {
      if (ext === screenExt) return
      screenExt = ext
      rebuildBodyGeo()
      screenWorld = screenWorldPts()
    }

    /* dev GUI — only when explicitly debugging (e.g. the /console playground) */
    const gui = debug
      ? createConsoleGui({
          kp, buttons, knobPocket, deviceCfg, bm, knobSlab, matKnobSlab, knobBump, matScreen, deck,
          lights: { key, fill, hemi, ambient },
          onRedrawBump: redrawBump,
          onRebuildBodyGeo: rebuildBodyGeo,
          onRebuildBtnGeo: rebuildBtnGeo,
        })
      : null

    /* pointer handling */
    const raycaster = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const MIN_PRESS_MS = 120
    const pressTimers: ReturnType<typeof setTimeout>[] = []
    let hovered: THREE.Mesh | null = null, active: THREE.Mesh | null = null
    let knobDrag = false, knobStartY = 0, knobBase = 0, knobLastStep = 0, knobLastRidge = 0, knobStartValue = 0

    function toNDC(e: PointerEvent) {
      const r = renderer.domElement.getBoundingClientRect()
      ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1
      ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1
    }
    function pick() {
      raycaster.setFromCamera(ndc, camera)
      const hit = raycaster.intersectObjects(interactive, false)
      return hit.length ? (hit[0].object as THREE.Mesh) : null
    }

    // Arrow consts (not hoisted declarations) so the post-guard non-null narrowing of canvas/hint holds.
    const onPointerDown = (e: PointerEvent) => {
      audio.resumeAudio()
      hint.style.opacity = '0'
      toNDC(e)
      const obj = pick()
      if (!obj) return
      if (obj.userData.kind === 'knob') {
        if (state.knobDisabled) return
        canvas.setPointerCapture(e.pointerId)
        knobDrag = true
        knobStartY = e.clientY
        knobBase = knobOffset
        knobLastStep = 0
        knobLastRidge = Math.round(knobOffset / kp.snapInterval)
        knobStartValue = state.knob?.value ?? 0
        return
      }
      const bi = bm.indexOf(obj)
      if (isBtnDisabled(bi)) return
      canvas.setPointerCapture(e.pointerId)
      obj.userData.pressed = true
      obj.userData.pressedAt = performance.now()
      obj.userData.glow = Math.max(obj.userData.glow, 0.001)
      active = obj
      if (bi === 0) audio.playSfx('mainPress')
      else if (bi === 1 || bi === 2) audio.playSfx('actionPress')
      else if (bi === 3 || bi === 4) audio.playSfx('pillPress')
      dispatch(bi)
    }

    const onPointerMove = (e: PointerEvent) => {
      toNDC(e)
      if (knobDrag) {
        const dyDown = e.clientY - knobStartY // down positive — drives the visual ridge scroll
        knobOffset = knobBase + dyDown * kp.dragSensitivity
        const detent = Math.round(knobOffset / kp.snapInterval)
        if (detent !== knobLastRidge) {
          knobLastRidge = detent
          audio.playSfx('knob')
        }
        const k = state.knob
        if (k && !state.knobDisabled) {
          const steps = Math.round((knobStartY - e.clientY) / kp.pxPerStep) // up = increase
          if (steps !== knobLastStep) {
            knobLastStep = steps
            const next = Math.min(k.max, Math.max(k.min, knobStartValue + steps * k.step))
            if (next !== k.value) propsRef.current.handlers?.current.knob?.(next)
          }
        }
        return
      }
      hovered = pick()
      canvas.style.cursor = hovered
        ? hovered.userData.kind === 'knob' ? 'ns-resize' : 'pointer'
        : 'default'
    }

    function release() {
      if (knobDrag) {
        knobTarget = Math.round(knobOffset / kp.snapInterval) * kp.snapInterval
        knobDrag = false
      }
      if (active) {
        const btn = active
        const bi = bm.indexOf(btn)
        active = null
        const elapsed = performance.now() - (btn.userData.pressedAt ?? 0)
        const delay = Math.max(0, MIN_PRESS_MS - elapsed)
        const t = setTimeout(() => {
          if (bi === 0) audio.playSfx('mainRelease')
          else if (bi === 1 || bi === 2) audio.playSfx('actionRelease')
          else if (bi === 3 || bi === 4) audio.playSfx('pillRelease')
          btn.userData.pressed = false
        }, delay)
        pressTimers.push(t)
      }
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)

    /* resize — fits the device to the container, then projects the cutout onto the screen layer */
    function resize() {
      const container = rootRef.current
      if (!container) return
      const w = container.clientWidth, h = container.clientHeight
      if (w === 0 || h === 0) return
      renderer.setSize(w, h)
      camera.aspect = w / h
      const fov = (camera.fov * Math.PI) / 180
      const tanHalf = Math.tan(fov / 2)

      if (debug) {
        // Playground: contain the whole device (with margin), screen at natural height.
        relayout(0)
        const fitH = (11.95 * 0.5 * 1.06) / tanHalf
        const fitW = (6.2 * 0.5 * 1.06) / (tanHalf * camera.aspect)
        camera.position.set(0, 0, Math.max(fitH, fitW))
        camera.lookAt(0, 0, 0)
      } else {
        // Always fill the width. A frame taller than the device's ratio grows the screen to fill
        // the extra height (the control deck keeps its size); a wider frame falls back to
        // contain-by-height, so the device gaps at the sides but is never cropped.
        const visibleH = 6.2 / camera.aspect // world height when the device width is fit edge to edge
        const ext = Math.max(0, Math.round((visibleH - 11.95) * 100) / 100)
        relayout(ext)
        const cy = wy(1130) + ext / 2 // device center after the top extension
        const d =
          ext > 0
            ? (6.2 * 0.5) / (tanHalf * camera.aspect) // fill width
            : (11.95 * 0.5) / tanHalf // contain by height (wider frame)
        camera.position.set(0, cy, d)
        camera.lookAt(0, cy, 0)
      }
      camera.updateProjectionMatrix()
      camera.updateMatrixWorld()

      // Screen content sits behind the device; the body's hole masks it to the L-shape and the
      // beveled rim frames it. Oversize a touch so the chart tucks under the rim with no seam.
      const el = screenLayerRef.current
      if (el) {
        const M = 4
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const v of screenWorld) {
          const n = v.clone().project(camera)
          const x = (n.x * 0.5 + 0.5) * w
          const y = (-n.y * 0.5 + 0.5) * h
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
        el.style.left = `${minX - M}px`
        el.style.top = `${minY - M}px`
        el.style.width = `${maxX - minX + M * 2}px`
        el.style.height = `${maxY - minY + M * 2}px`
      }
    }
    const ro = new ResizeObserver(() => resize())
    if (rootRef.current) ro.observe(rootRef.current)
    resize()
    applyView(viewRef.current)

    /* render loop */
    const clock = new THREE.Clock()
    let rafId: number

    function loop() {
      rafId = requestAnimationFrame(loop)
      const dt = Math.min(clock.getDelta(), 0.05)

      interactive.forEach((o) => {
        const d = o.userData
        d.hover += ((hovered === o ? 1 : 0) - d.hover) * Math.min(1, dt * 12)
        if (d.kind === 'knob') return
        const lift = !d.pressed ? d.hover * 0.035 : 0
        const targetZ = (d.pressed ? d.pressedZ : d.baseZ) + lift
        o.position.z += (targetZ - o.position.z) * Math.min(1, dt * 20)
        if (d.pressed) d.glow = Math.min(1, d.glow + dt * 9)
        else d.glow *= Math.pow(0.015, dt)
          ; (o.material as THREE.MeshStandardMaterial).emissiveIntensity = d.glow * 0.95 + d.hover * 0.05
      })

      if (knobDrag) {
        knobTarget = knobOffset
      } else {
        knobOffset += (knobTarget - knobOffset) * Math.min(1, dt * kp.snapSpeed)
        if (Math.abs(knobTarget - knobOffset) < 0.001) knobOffset = knobTarget
      }
      knobBump.offset.x = knobOffset / kp.ridgeRepeat

      renderer.render(scene, camera)
    }
    loop()

    return () => {
      cancelAnimationFrame(rafId)
      canvas.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      ro.disconnect()
      pressTimers.forEach(clearTimeout)
      applyViewRef.current = () => {}
      gui?.destroy()
      renderer.dispose()
      audio.dispose()
    }
    // Scene is built once; live bindings flow through refs + the [view] effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debug])

  // Push label/state updates into the scene whenever the registered view changes.
  useEffect(() => {
    applyViewRef.current(view)
  }, [view])

  return (
    <div ref={rootRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#000' }}>
      {/* screen content sits behind the device; the body's hole cuts it to the L-shape and the
          beveled rim frames it. Total black so any rim seam reads as screen, not a gap. */}
      <div
        ref={screenLayerRef}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: 0,
          height: 0,
          zIndex: 1,
          background: '#000',
          overflow: 'hidden',
        }}
      >
        {children}
      </div>

      {/* device canvas on top — transparent through the screen hole + outside the body */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 10, touchAction: 'none' }}>
        <canvas ref={canvasRef} style={{ display: 'block' }} />
        <div
          ref={hintRef}
          style={{
            position: 'absolute',
            bottom: 12,
            left: 0,
            width: '100%',
            textAlign: 'center',
            color: '#6b6b6b',
            fontSize: 11,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            opacity: 0.6,
            transition: 'opacity 0.8s ease',
            pointerEvents: 'none',
            userSelect: 'none',
            fontFamily: '-apple-system, "Segoe UI", system-ui, sans-serif',
          }}
        >
          {onNav ? 'Turn the knob · press to play' : ''}
        </div>
      </div>
    </div>
  )
}
