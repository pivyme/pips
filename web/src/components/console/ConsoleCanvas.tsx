import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import * as THREE from 'three'
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js'
import { createConsoleGui } from './consoleGui'
import { roundedRect, roundedPoly, frontZeroed, setBoxUVs, roundedRectPath, roundedPolyPath } from './consoleGeo'
import { createAudio } from './consoleAudio'
import type { ConsoleView } from './controls'
import type { ConsoleTheme } from './themes'

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
    numberWheel?: (value: number) => void
  }
}

interface ConsoleCanvasProps {
  view?: ConsoleView
  handlers?: HandlersRef
  onNav?: (tab: 'MENU' | 'GAMES') => void
  children?: ReactNode
  debug?: boolean
  // Customize studio: the device floats on a transparent backdrop, screen off, free-spin to inspect
  // front/back, and `theme` repaints the materials live. Mutually exclusive with debug.
  customize?: boolean
  theme?: ConsoleTheme
  // Done sequence: flip `outro` true and the device snaps front-on, zooms to the screen and powers
  // on, then `onOutroComplete` fires (the studio uses it to commit + leave).
  outro?: boolean
  onOutroComplete?: () => void
}

export default function ConsoleCanvas({ view, handlers, onNav, children, debug = false, customize = false, theme, outro = false, onOutroComplete }: ConsoleCanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hintRef = useRef<HTMLDivElement>(null)
  const screenLayerRef = useRef<HTMLDivElement>(null)

  // Fresh per render so the scene's input handlers never read a stale binding.
  const propsRef = useRef({ handlers, onNav, onOutroComplete })
  propsRef.current = { handlers, onNav, onOutroComplete }
  const viewRef = useRef(view)
  viewRef.current = view
  // The scene exposes its label/state updater here; the [view] effect calls it.
  const applyViewRef = useRef<(v?: ConsoleView) => void>(() => {})
  // Same pattern for the skin: the [theme] effect repaints the live materials, no rebuild.
  const applyThemeRef = useRef<(t?: ConsoleTheme) => void>(() => {})
  // And for the Done outro: the [outro] effect arms the snap-to-screen + power-on sequence.
  const applyOutroRef = useRef<(on: boolean) => void>(() => {})

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
    // The device is static unless touched, so we render on demand (see the loop). Shadows only need
    // recomputing when geometry actually moves, so drive them by hand instead of every frame.
    renderer.shadowMap.autoUpdate = false
    renderer.outputColorSpace = THREE.SRGBColorSpace
    const MAXANISO = renderer.capabilities.getMaxAnisotropy()

    // Render-on-demand gate: set true whenever the device changes (label/view update, resize) so the
    // loop paints once; live animation (press/knob) drives its own frames. Idle = no GPU work.
    let dirty = true

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
      { w: 0.98, h: 0.31, r: 0.15, depth: 0.3, dx: 0, dy: 0, baseZ: 0.2, pressedZ: 0.15, pad: 0.1 },
      { w: 1.02, h: 0.31, r: 0.15, depth: 0.3, dx: 0, dy: 0, baseZ: 0.2, pressedZ: 0.15, pad: 0.1 },
    ]
    // button pixel centers — kept here so buildBodyShape stays in sync with makeButton calls below
    const BTN_PX = [
      { x: 965, y: 1490 }, { x: 200, y: 1820 }, { x: 589, y: 1820 },
      { x: 150, y: 2150 }, { x: 425, y: 2150 },
    ]
    // knob pocket config — w/h must stay in sync with kp.height / kp.radius*2 below
    // cylinder is rotated on Z so from the front it reads as w=height, h=radius*2
    const knobPocket = { px: 975, py: 1960, w: 1, h: 2.4, r: 0.1, pad: 0.08 }
    // Compact number drum, aligned with the Menu / Games row. It owns stake selection while the
    // yellow wheel remains available for the active game's signature control.
    const numberWheelPocket = { px: 700, py: 2145, w: 0.86, h: 0.82, r: 0.12, pad: 0.035 }

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

    // Everything physical hangs off the `device` group, shifted toward the camera by DEVICE_Z so the
    // device mid-plane sits on the deck origin. That makes the "flip to back" rotation
    // (deck.rotation.y) symmetric and lets the back panel show. The camera and the screen projection
    // add the same offset, so the front view stays pixel-identical to the un-grouped device.
    const DEVICE_Z = 1.06

    // Screen L-shape corners in world space, with the top edge raised by screenExt. Drives both the
    // body cutout and the projected HTML layer, so they always agree.
    function screenWorldPts() {
      const yOf = (py: number) => wy(py) + SCREEN_MESH_Y_OFFSET + (py === 30 ? screenExt : 0)
      // z carries the device-group offset so the projected HTML layer lands on the actual cutout.
      return SCREEN_PX.map((p) => new THREE.Vector3(wx(p.x), yOf(p.y), DEVICE_Z + 0.06))
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
      const nlx = wx(numberWheelPocket.px) - wx(585)
      const nly = wy(numberWheelPocket.py) - cy
      const nw = numberWheelPocket.w + numberWheelPocket.pad * 2
      const nh = numberWheelPocket.h + numberWheelPocket.pad * 2
      s.holes.push(roundedRectPath(nlx, nly, nw, nh, Math.min(numberWheelPocket.r + numberWheelPocket.pad, nw / 2, nh / 2)))
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

    // The flip group. Deck stays the rotation pivot; `device` centers the geometry on it (see DEVICE_Z).
    const device = new THREE.Group()
    device.position.z = DEVICE_Z
    deck.add(device)

    /* body */
    const body = new THREE.Mesh(frontZeroed(buildBodyShape(), 0.6, 0.08), matBody)
    body.position.set(wx(585), wy(1130), 0)
    body.receiveShadow = true
    body.castShadow = true
    device.add(body)

    /* back panel — solid cream shell behind the body. Covers the open back (button + knob undersides)
       when the device is flipped; the slab is deep enough to swallow the deepest button and the knob.
       Same outline as the body, so it never peeks past the front silhouette. Grows with screenExt. */
    const matBack = new THREE.MeshStandardMaterial({ color: CREAM, roughness: 0.88, metalness: 0 })
    const backPanel = new THREE.Mesh(
      frontZeroed(roundedRect(6.2, 11.95 + screenExt, deviceCfg.corner), 1.2, 0.08),
      matBack,
    )
    backPanel.position.set(wx(585), wy(1130) + screenExt / 2, -0.76)
    backPanel.castShadow = true
    backPanel.receiveShadow = true
    // Hidden until the device is flipped. main's screen is an HTML layer behind the canvas, shown
    // through the body's screen hole; a solid panel here would occlude it. The flip toggle reveals it.
    backPanel.visible = false
    device.add(backPanel)

    /* embossed logo on the back panel — child of backPanel so it inherits the flip rotation and the
       hide-until-flipped visibility. The panel has no own rotation; the deck supplies the flip, which
       mirrors local +X → world -X (negate scale.x) and leaves Y alone. SVG Y is down, so negate scale.y
       too. The face we see once flipped is the extrusion's back, at the geometry's local min.z. */
    backPanel.geometry.computeBoundingBox()
    const backFaceLocalZ = backPanel.geometry.boundingBox!.min.z

    const SVG_W = 1539, SVG_H = 629
    const logoScale = 3.6 / SVG_W
    const logoW = SVG_W * logoScale
    const logoH = SVG_H * logoScale

    const logoGroup = new THREE.Group()
    logoGroup.scale.set(-logoScale, -logoScale, 1)
    // SVG center (769.5, 314.5) maps to panel-local (0,0) once the mirrored scale is undone.
    logoGroup.position.set(logoW / 2, logoH / 2, backFaceLocalZ)
    backPanel.add(logoGroup)

    const logoGeo: THREE.BufferGeometry[] = []
    const matLogoDark = new THREE.MeshStandardMaterial({ color: 0xff4444, roughness: 0.93, metalness: 0 })
    const matLogoWhite = new THREE.MeshStandardMaterial({ color: 0x4488ff, roughness: 0.8, metalness: 0 })
    // How far each level stands off the back face toward the viewer (panel-local -Z = outward when flipped).
    const logoProtrude = { white: -0.06, dark: -0.01 }

    new SVGLoader().load('/assets/pips-horizontal-black.svg', ({ paths }) => {
      for (const path of paths) {
        const fillStr = (path.userData?.style?.fill as string) ?? ''
        const isWhite = /^(white|#fff(fff)?|rgb\(\s*255,\s*255,\s*255\s*\))$/i.test(fillStr)
        const zOff = isWhite ? logoProtrude.white : logoProtrude.dark
        for (const svgShape of SVGLoader.createShapes(path)) {
          const g = new THREE.ExtrudeGeometry(svgShape, { depth: 0.02, bevelEnabled: false })
          g.computeBoundingBox()
          g.translate(0, 0, -g.boundingBox!.max.z)
          g.computeVertexNormals()
          logoGeo.push(g)
          const mesh = new THREE.Mesh(g, isWhite ? matLogoWhite : matLogoDark)
          mesh.position.z = zOff
          logoGroup.add(mesh)
        }
      }
      dirty = true
    }, undefined, (e) => console.error('[ConsoleCanvas] back logo SVG failed:', e))

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
    // would only occlude it. Hidden in play. In customize the device is off and free-spinning, so we
    // show this matte panel instead: it reads as a dark powered-off screen and rotates with the body
    // (an HTML layer couldn't follow the spin).
    screenMesh.visible = customize
    device.add(screenMesh)

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
      mesh.userData = { kind: 'button', baseZ, pressedZ, depth, pressed: false, glow: 0 }
      device.add(mesh)
      interactive.push(mesh)
      return mesh
    }

    const bm = [
      makeButton(wx(965), wy(1490), buttons[0].w, buttons[0].h, buttons[0].r, buttons[0].baseZ, buttons[0].pressedZ, buttons[0].depth, RED, 0xff5a3c),
      makeButton(wx(200), wy(1820), buttons[1].w, buttons[1].h, buttons[1].r, buttons[1].baseZ, buttons[1].pressedZ, buttons[1].depth, BLUE, 0x5e9bff),
      makeButton(wx(589), wy(1820), buttons[2].w, buttons[2].h, buttons[2].r, buttons[2].baseZ, buttons[2].pressedZ, buttons[2].depth, BLUE, 0x5e9bff),
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
      device.add(floor)
    })
    // knob pocket floor
    const kfw = knobPocket.w + knobPocket.pad * 2 - 0.04
    const kfh = knobPocket.h + knobPocket.pad * 2 - 0.04
    const knobFloorGeo = new THREE.ShapeGeometry(roundedRect(kfw, kfh, Math.min(knobPocket.r + knobPocket.pad, kfw / 2, kfh / 2)), 48)
    const knobFloor = new THREE.Mesh(knobFloorGeo, matPocket)
    knobFloor.position.set(wx(knobPocket.px), wy(knobPocket.py), body.position.z - 0.04)
    knobFloor.receiveShadow = true
    device.add(knobFloor)
    const nfw = numberWheelPocket.w + numberWheelPocket.pad * 2 - 0.04
    const nfh = numberWheelPocket.h + numberWheelPocket.pad * 2 - 0.04
    const numberWheelFloor = new THREE.Mesh(
      new THREE.ShapeGeometry(
        roundedRect(nfw, nfh, Math.min(numberWheelPocket.r + numberWheelPocket.pad, nfw / 2, nfh / 2)),
        48,
      ),
      matPocket,
    )
    numberWheelFloor.position.set(wx(numberWheelPocket.px), wy(numberWheelPocket.py), body.position.z - 0.04)
    numberWheelFloor.receiveShadow = true
    device.add(numberWheelFloor)

    // knob pocket bevel — chamfered ring sloping from the body front face inward into the pocket, so
    // the rim reads as a real machined recess. Outer ring matches the body hole (pocket pad), inner
    // ring sits at the pocket edge one `pad` deep (45° slope).
    {
      const ow = knobPocket.w + knobPocket.pad * 2
      const oh = knobPocket.h + knobPocket.pad * 2
      const or_ = Math.min(knobPocket.r + knobPocket.pad, ow / 2, oh / 2)
      const iw = knobPocket.w, ih = knobPocket.h, ir = knobPocket.r
      const bD = knobPocket.pad // depth = pad → 45° slope
      const S = 12

      function ringPts(w: number, h: number, r: number, z: number): number[] {
        const hw = w / 2, hh = h / 2, v: number[] = []
        const corners: [number, number, number][] = [
          [hw - r, hh - r, 0], [-hw + r, hh - r, Math.PI / 2],
          [-hw + r, -hh + r, Math.PI], [hw - r, -hh + r, 3 * Math.PI / 2],
        ]
        for (const [cx, cy, a0] of corners)
          for (let i = 0; i < S; i++) {
            const a = a0 + (i / S) * (Math.PI / 2)
            v.push(cx + r * Math.cos(a), cy + r * Math.sin(a), z)
          }
        return v
      }

      const N = S * 4
      const verts = [...ringPts(ow, oh, or_, 0), ...ringPts(iw, ih, ir, -bD)]
      const idx: number[] = []
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N
        idx.push(i, N + i, j, j, N + i, N + j)
      }
      const bevelGeo = new THREE.BufferGeometry()
      bevelGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
      bevelGeo.setIndex(idx)
      bevelGeo.computeVertexNormals()
      const knobBevel = new THREE.Mesh(bevelGeo, matPocket)
      knobBevel.position.set(wx(knobPocket.px), wy(knobPocket.py), 0)
      knobBevel.receiveShadow = true
      device.add(knobBevel)
    }

    // Black beveled housing and curved drum. The drum rolls on a horizontal axle, with adjacent
    // values wrapping around its face like a mechanical counter.
    const numberWheelHousingShape = roundedRect(
      numberWheelPocket.w,
      numberWheelPocket.h,
      numberWheelPocket.r,
    )
    numberWheelHousingShape.holes.push(roundedRectPath(0, 0, 0.78, 0.74, 0.085))
    const numberWheelHousing = new THREE.Mesh(
      frontZeroed(numberWheelHousingShape, 0.24, 0.025),
      new THREE.MeshStandardMaterial({ color: 0x080808, roughness: 0.58, metalness: 0.08 }),
    )
    numberWheelHousing.position.set(wx(numberWheelPocket.px), wy(numberWheelPocket.py), 0.12)
    numberWheelHousing.castShadow = true
    numberWheelHousing.receiveShadow = true
    device.add(numberWheelHousing)

    const numberWheelRoll = new THREE.Group()
    numberWheelRoll.position.set(wx(numberWheelPocket.px), wy(numberWheelPocket.py), -0.14)
    device.add(numberWheelRoll)

    const numberWheelMat = new THREE.MeshStandardMaterial({
      color: 0x171717,
      roughness: 0.42,
      metalness: 0.18,
    })
    const numberWheelDrum = new THREE.Mesh(
      new THREE.CylinderGeometry(0.37, 0.37, 0.76, 64, 1, false),
      numberWheelMat,
    )
    numberWheelDrum.rotation.z = Math.PI / 2
    numberWheelDrum.castShadow = true
    numberWheelDrum.receiveShadow = true
    numberWheelDrum.userData = { kind: 'numberWheel' }
    numberWheelRoll.add(numberWheelDrum)
    interactive.push(numberWheelDrum)

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
      device.add(plane)
      return plane
    }

    // Updatable label that lives on a button face (or the body) and reflects the registered view.
    function makeDynLabel(worldH: number, color: string, opticalCenter = false, depthTest = false) {
      const W = 640, H = 128, FS = 92
      const c = document.createElement('canvas')
      c.width = W
      c.height = H
      const g = c.getContext('2d')!
      const tex = new THREE.CanvasTexture(c)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = MAXANISO
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, depthTest })
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
            if (opticalCenter) {
              g.textBaseline = 'alphabetic'
              const metrics = g.measureText(text)
              const y = H / 2 + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2
              g.fillText(text, W / 2, y)
            } else {
              g.textBaseline = 'middle'
              g.fillText(text, W / 2, H / 2)
            }
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
      return { plane, set, mat }
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
    device.add(knobLbl.plane)

    const NUMBER_LABEL_ANGLE = 1.02
    const NUMBER_LABEL_RADIUS = 0.375
    const MAX_NUMBER_WHEEL_LABELS = 5
    const numberWheelLabels = Array.from({ length: MAX_NUMBER_WHEEL_LABELS }, () => {
      const label = makeDynLabel(0.46, '#ffffff', true, true)
      numberWheelRoll.add(label.plane)
      return { ...label, angle: 0, active: false }
    })
    let numberWheelAngle = 0
    let numberWheelTarget = 0
    let numberWheelInitialized = false
    let debugNumberValue = 1
    const debugNumberWheel = {
      min: 0,
      max: 9,
      step: 1,
      value: debugNumberValue,
      label: 'USDC',
      format: (value: number) => String(value),
      disabled: false,
    }
    // In the studio no game binds the wheel, so it would read as an empty black drum. Park a sample
    // value on it (disabled) so the device looks complete in the product shot.
    const customizeWheel = {
      // Not disabled (so the digit shows full-bright); the studio's orbit grab already blocks any
      // interaction with it.
      min: 0, max: 9, step: 1, value: 5,
      label: '', format: (value: number) => String(value), disabled: false,
    }

    // View state mirrored from the registry, read by the input handlers for gating.
    const state = {
      mainDisabled: true, a1Disabled: true, a2Disabled: true, knobDisabled: true, numberWheelDisabled: true,
      knob: null as null | NonNullable<ConsoleView['knob']>,
      numberWheel: null as null | NonNullable<ConsoleView['numberWheel']>,
    }

    function setNumberWheelLabels(spec: NonNullable<ConsoleView['numberWheel']> | null) {
      const count = spec ? Math.floor((spec.max - spec.min) / spec.step + 0.5) + 1 : 0
      const visibleCount = Math.min(count, MAX_NUMBER_WHEEL_LABELS)
      const centerIndex = spec ? Math.round(numberWheelPosition(spec)) : 0
      const startIndex = Math.max(0, Math.min(count - visibleCount, centerIndex - 2))

      numberWheelLabels.forEach((label, i) => {
        const valueIndex = startIndex + i
        label.active = !!spec && i < visibleCount
        if (!label.active || !spec) {
          label.set('', 0)
          return
        }
        const value = Number((spec.min + valueIndex * spec.step).toFixed(6))
        label.angle = -valueIndex * NUMBER_LABEL_ANGLE
        label.plane.position.set(
          0,
          Math.sin(label.angle) * NUMBER_LABEL_RADIUS,
          Math.cos(label.angle) * NUMBER_LABEL_RADIUS,
        )
        label.plane.rotation.x = -label.angle
        label.set(spec.format ? spec.format(value) : String(value), 1)
      })
    }

    function numberWheelPosition(spec: NonNullable<ConsoleView['numberWheel']>): number {
      return (spec.value - spec.min) / spec.step
    }

    function updateNumberWheelLighting() {
      const disabledOpacity = state.numberWheelDisabled ? 0.36 : 1
      for (const label of numberWheelLabels) {
        if (!label.active) continue
        const angle = Math.atan2(
          Math.sin(label.angle - numberWheelAngle),
          Math.cos(label.angle - numberWheelAngle),
        )
        const facing = Math.max(0, Math.cos(angle))
        const light = Math.pow(facing, 2.2)
        label.mat.opacity = facing > 0 ? (0.04 + 0.96 * light) * disabledOpacity : 0
        const brightness = 0.32 + 0.68 * Math.pow(facing, 1.6)
        label.mat.color.setRGB(brightness, brightness, brightness)
      }
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
      const n =
        v?.numberWheel ??
        (debug ? { ...debugNumberWheel, value: debugNumberValue } : customize ? customizeWheel : null)
      state.numberWheel = n
      state.numberWheelDisabled = !n || !!n.disabled
      setNumberWheelLabels(n)
      if (n && !numberWheelDrag) {
        numberWheelTarget = -numberWheelPosition(n) * NUMBER_LABEL_ANGLE
        if (!numberWheelInitialized) {
          numberWheelAngle = numberWheelTarget
          numberWheelInitialized = true
        }
      }
      updateNumberWheelLighting()
      dirty = true // labels/state moved, repaint once
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
      radius: 1.25, height: 0.95, edgeCurve: 0.1,
      dragSensitivity: 0.5, pxPerStep: 22, ridgePhase: 0,
      snapInterval: 20, snapSpeed: 5,
      ridgeLength: 0.825,
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
      // ridges occupy a centered fraction (ridgeLength) of the V range; the rounded ends stay flat (255)
      const margin = (1 - kp.ridgeLength) / 2
      const lo = margin * 128, hi = (1 - margin) * 128
      for (let y = 0; y < 128; y++) {
        for (let x = 0; x < 128; x++) {
          let v = 255
          if (y >= lo && y <= hi) {
            const phase = x % pitch
            if (phase < kp.grooveWidth) {
              const t = phase / kp.grooveWidth
              v = Math.round((1 - Math.sin(t * Math.PI)) * kp.cornerCurve * 255)
            }
          }
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

    // Quarter-circle rounds at each end of the profile. LatheGeometry has no flat cap faces, so the
    // ridge bump never bleeds a UV stripe across a hard edge the way a capped cylinder does.
    function knobProfile(): THREE.Vector2[] {
      const { radius, height, edgeCurve: r } = kp
      const pts: THREE.Vector2[] = []
      pts.push(new THREE.Vector2(0, -height / 2))
      for (let i = 0; i <= 12; i++) {
        const a = -Math.PI / 2 + (i / 12) * (Math.PI / 2)
        pts.push(new THREE.Vector2(radius - r + r * Math.cos(a), -height / 2 + r + r * Math.sin(a)))
      }
      pts.push(new THREE.Vector2(radius, height / 2 - r))
      for (let i = 1; i <= 12; i++) {
        const a = (i / 12) * (Math.PI / 2)
        pts.push(new THREE.Vector2(radius - r + r * Math.cos(a), height / 2 - r + r * Math.sin(a)))
      }
      pts.push(new THREE.Vector2(0, height / 2))
      return pts
    }

    const knobSlab = new THREE.Mesh(new THREE.LatheGeometry(knobProfile(), 64), matKnobSlab)
    knobSlab.rotation.z = Math.PI / 2
    knobSlab.position.set(wx(975), wy(1960), -0.5)
    knobSlab.castShadow = true
    knobSlab.receiveShadow = true
    knobSlab.userData = { kind: 'knob' }
    device.add(knobSlab)
    interactive.push(knobSlab)

    // Repaint the device to a skin. Colors only, no geometry touched, so it's cheap enough to run on
    // every card tap in the studio. emissive tracks the color so the press glow stays in-palette.
    function applyTheme(t?: ConsoleTheme) {
      if (!t) return
      matBody.color.set(t.body)
      matBack.color.set(t.back ?? t.body)
      matKnob.color.set(t.knob)
      matKnobSlab.color.set(t.knob)
      // Embossed back logo: letters + eyes. Most skins use one accent tone; Classic keeps red/blue.
      const logoColor = t.logo ?? t.knob
      matLogoDark.color.set(logoColor)
      matLogoWhite.color.set(t.logoEyes ?? logoColor)
      const paint = (m: THREE.Mesh, c: number) => {
        const mat = m.material as THREE.MeshStandardMaterial
        mat.color.set(c)
        mat.emissive.set(c)
      }
      paint(bm[0], t.main)
      paint(bm[1], t.action)
      paint(bm[2], t.action)
      paint(bm[3], t.pills)
      paint(bm[4], t.pills)
      dirty = true
    }
    applyThemeRef.current = applyTheme
    applyTheme(theme)

    function rebuildKnobGeo() {
      knobSlab.geometry.dispose()
      knobSlab.geometry = new THREE.LatheGeometry(knobProfile(), 64)
    }

    let knobOffset = 0
    let knobTarget = 0

    function rebuildBodyGeo() {
      body.geometry.dispose()
      body.geometry = frontZeroed(buildBodyShape(), 0.6, 0.08)
      body.position.y = wy(1130) + screenExt / 2
      // back panel tracks the body so it stays a full cover when the screen stretches
      backPanel.geometry.dispose()
      backPanel.geometry = frontZeroed(roundedRect(6.2, 11.95 + screenExt, deviceCfg.corner), 1.2, 0.08)
      backPanel.position.y = wy(1130) + screenExt / 2
    }

    // Stretch the screen + body top to `ext` world units past natural, then refresh the projection
    // points. The control deck stays fixed. No-op when unchanged so resize churn stays cheap.
    function relayout(ext: number) {
      if (ext === screenExt) return
      screenExt = ext
      rebuildBodyGeo()
      screenWorld = screenWorldPts()
    }

    /* customize studio — the device floats as a hero product shot you can spin. The intro eases the
       camera from a bigger, near-front pose into a pulled-back 3/4 (it "shrinks into the center");
       after that, drag spins the deck so you can read the front, the sides and the embossed back. */
    const CUST = {
      // intro: start pose → rest pose, lerped by easeOutExpo(introT). Rest sits the device small and
      // high so the workshop breathes around it and the preset rail has room below.
      camZ: [29, 47] as const,
      lookY: [-0.6, -2.5] as const,
      yaw: [-0.1, -0.5] as const,
      pitch: [-0.03, -0.17] as const,
      introMs: 880,
      outroMs: 820,
      frontLookY: 1.45, // outro target: framed on the screen
    }
    let introT = customize ? 0 : 1 // 0 → start, 1 → settled
    let orbitYaw = 0 // persists, so you can park it facing back
    let orbitPitch = 0 // eases back to level on release
    let orbitDrag = false
    let orbitStartX = 0, orbitStartY = 0, orbitBaseYaw = 0, orbitBasePitch = 0
    // Done outro: 0 → product shot, 1 → snapped front-on with the screen lit.
    let outroActive = false
    let outroT = 0
    let outroFired = false

    const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t))
    const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t

    // Power the off screen up: a cool LCD glow ramps in so the device reads as "booting".
    function setScreenPower(p: number) {
      matScreen.emissive.setRGB(0.1 * p, 0.16 * p, 0.28 * p)
      matScreen.emissiveIntensity = p * 2.6
      const base = 0.02 + 0.06 * p
      matScreen.color.setRGB(base, base + 0.01 * p, base + 0.04 * p)
    }

    function placeCustomizeCamera() {
      const e = easeOutExpo(introT)
      let lookY = lerp(CUST.lookY[0], CUST.lookY[1], e)
      let camZ = lerp(CUST.camZ[0], CUST.camZ[1], e)
      let yaw = lerp(CUST.yaw[0], CUST.yaw[1], e) + orbitYaw * e
      let pitch = lerp(CUST.pitch[0], CUST.pitch[1], e) + orbitPitch * e
      if (outroActive) {
        // Zoom in and rotate flat to the front, framing the screen as it powers on.
        const o = easeInOutCubic(outroT)
        const tanHalf = Math.tan((camera.fov * Math.PI) / 180 / 2)
        const frontZ = (6.2 * 0.5) / (tanHalf * Math.max(camera.aspect, 0.0001)) + DEVICE_Z + 0.6
        lookY = lerp(lookY, CUST.frontLookY, o)
        camZ = lerp(camZ, frontZ, o)
        yaw = lerp(yaw, 0, o)
        pitch = lerp(pitch, 0, o)
      }
      camera.position.set(0, lookY, camZ)
      camera.lookAt(0, lookY, 0)
      deck.rotation.set(pitch, yaw, 0)
      // The solid back fades in once the body turns past side-on, so it never occludes the front.
      backPanel.visible = !outroActive && Math.abs(yaw) > Math.PI / 2
    }

    applyOutroRef.current = (on: boolean) => {
      if (on) {
        introT = 1 // settle instantly so the outro starts from the rest pose
        outroActive = true
        outroT = 0
        outroFired = false
      } else {
        outroActive = false
        outroT = 0
        outroFired = false
        setScreenPower(0)
      }
      dirty = true
    }

    /* dev GUI — only when explicitly debugging (e.g. the /console playground) */
    const gui = debug
      ? createConsoleGui({
          kp, buttons, knobPocket, deviceCfg, bm, matKnobSlab, knobBump, matScreen, deck, backPanel,
          lights: { key, fill, hemi, ambient },
          logo: { group: logoGroup, darkMat: matLogoDark, whiteMat: matLogoWhite, protrude: logoProtrude },
          onRedrawBump: redrawBump,
          onRebuildBodyGeo: rebuildBodyGeo,
          onRebuildBtnGeo: rebuildBtnGeo,
          onRebuildKnobGeo: rebuildKnobGeo,
          requestRender: () => { dirty = true },
        })
      : null

    /* pointer handling */
    const raycaster = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const MIN_PRESS_MS = 120
    const pressTimers: ReturnType<typeof setTimeout>[] = []
    let active: THREE.Mesh | null = null
    let knobDrag = false, knobStartY = 0, knobBase = 0, knobLastStep = 0, knobLastRidge = 0, knobStartValue = 0
    let numberWheelDrag = false, numberWheelStartY = 0, numberWheelLastStep = 0, numberWheelStartValue = 0
    let numberWheelStartPosition = 0
    const NUMBER_WHEEL_PX_PER_STEP = 28

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
      // In the studio the controls don't fire; the whole device is a turntable. Once the Done outro
      // is rolling, it's locked.
      if (customize) {
        if (outroActive) return
        canvas.setPointerCapture(e.pointerId)
        orbitDrag = true
        orbitStartX = e.clientX
        orbitStartY = e.clientY
        orbitBaseYaw = orbitYaw
        orbitBasePitch = orbitPitch
        canvas.style.cursor = 'grabbing'
        return
      }
      toNDC(e)
      const obj = pick()
      if (!obj) return
      if (obj.userData.kind === 'numberWheel') {
        if (state.numberWheelDisabled && !debug) return
        canvas.setPointerCapture(e.pointerId)
        numberWheelDrag = true
        numberWheelStartY = e.clientY
        numberWheelLastStep = 0
        numberWheelStartValue = state.numberWheel?.value ?? debugNumberValue
        numberWheelStartPosition = state.numberWheel ? numberWheelPosition(state.numberWheel) : 0
        return
      }
      if (obj.userData.kind === 'knob') {
        // In the standalone playground no game binds a view, so everything reads disabled. Let the
        // controls still respond physically there (press + turn) so the device is testable on its own.
        if (state.knobDisabled && !debug) return
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
      if (isBtnDisabled(bi) && !debug) return
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
      if (customize) {
        if (orbitDrag) {
          orbitYaw = orbitBaseYaw + (e.clientX - orbitStartX) * 0.011
          orbitPitch = Math.max(-0.5, Math.min(0.46, orbitBasePitch + (e.clientY - orbitStartY) * 0.006))
        } else {
          canvas.style.cursor = 'grab'
        }
        return
      }
      toNDC(e)
      if (numberWheelDrag) {
        const wheel = state.numberWheel
        if (!wheel) return
        const rawSteps = (numberWheelStartY - e.clientY) / NUMBER_WHEEL_PX_PER_STEP
        const minSteps = (wheel.min - numberWheelStartValue) / wheel.step
        const maxSteps = (wheel.max - numberWheelStartValue) / wheel.step
        const resistedSteps =
          rawSteps < minSteps
            ? minSteps - Math.min(0.28, (minSteps - rawSteps) * 0.16)
            : rawSteps > maxSteps
              ? maxSteps + Math.min(0.28, (rawSteps - maxSteps) * 0.16)
              : rawSteps
        const steps = Math.round(Math.min(maxSteps, Math.max(minSteps, resistedSteps)))
        numberWheelAngle = -(numberWheelStartPosition + resistedSteps) * NUMBER_LABEL_ANGLE
        numberWheelTarget = numberWheelAngle
        if (steps !== numberWheelLastStep) {
          numberWheelLastStep = steps
          audio.playSfx('knob')
          if (!state.numberWheelDisabled) {
            const raw = numberWheelStartValue + steps * wheel.step
            const next = Math.min(wheel.max, Math.max(wheel.min, Number(raw.toFixed(6))))
            if (next !== wheel.value) {
              const handler = propsRef.current.handlers?.current.numberWheel
              if (handler) handler(next)
              else if (debug) {
                debugNumberValue = next
                const debugSpec = { ...debugNumberWheel, value: debugNumberValue }
                state.numberWheel = debugSpec
                setNumberWheelLabels(debugSpec)
              }
            }
          }
        }
        return
      }
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
      const target = pick()
      canvas.style.cursor = target
        ? target.userData.kind === 'knob' || target.userData.kind === 'numberWheel' ? 'ns-resize' : 'pointer'
        : 'default'
    }

    function release() {
      if (orbitDrag) {
        orbitDrag = false
        renderer.domElement.style.cursor = 'grab'
        return
      }
      if (numberWheelDrag) {
        numberWheelTarget = -(numberWheelStartPosition + numberWheelLastStep) * NUMBER_LABEL_ANGLE
        numberWheelDrag = false
      }
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
    // Returning to the tab can drop the drawing buffer; force one repaint so the device never
    // shows a blank frame after we have been idle (not rendering).
    const onVisible = () => { dirty = true }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)

    /* resize — fits the device to the container, then projects the cutout onto the screen layer */
    function resize() {
      const container = rootRef.current
      if (!container) return
      const w = container.clientWidth, h = container.clientHeight
      if (w === 0 || h === 0) return
      renderer.setSize(w, h)
      camera.aspect = w / h

      if (customize) {
        // No screen layer to project (the device is off); the loop owns the camera during the
        // intro + spin, this just keeps the aspect correct and paints the current pose.
        camera.updateProjectionMatrix()
        placeCustomizeCamera()
        camera.updateMatrixWorld()
        dirty = true
        return
      }

      const fov = (camera.fov * Math.PI) / 180
      const tanHalf = Math.tan(fov / 2)

      if (debug) {
        // Playground: contain the whole device (with margin), screen at natural height.
        relayout(0)
        const fitH = (11.95 * 0.5 * 1.06) / tanHalf
        const fitW = (6.2 * 0.5 * 1.06) / (tanHalf * camera.aspect)
        camera.position.set(0, 0, Math.max(fitH, fitW) + DEVICE_Z)
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
        camera.position.set(0, cy, d + DEVICE_Z)
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
      dirty = true // camera/geometry moved, repaint once
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
      let animating = false

      if (customize) {
        if (introT < 1) {
          introT = Math.min(1, introT + (dt * 1000) / CUST.introMs)
          animating = true
        }
        if (outroActive) {
          if (outroT < 1) {
            outroT = Math.min(1, outroT + (dt * 1000) / CUST.outroMs)
            animating = true
          }
          // Screen blinks on through the back half of the snap.
          setScreenPower(Math.max(0, Math.min(1, (outroT - 0.4) / 0.6)))
          if (outroT >= 1 && !outroFired) {
            outroFired = true
            propsRef.current.onOutroComplete?.()
          }
        } else if (orbitDrag) {
          animating = true
        } else if (Math.abs(orbitPitch) > 0.0006) {
          orbitPitch += (0 - orbitPitch) * Math.min(1, dt * 5) // level out the tilt on release
          animating = true
        }
        if (animating) placeCustomizeCamera()
      }

      interactive.forEach((o) => {
        const d = o.userData
        if (d.kind === 'numberWheel' || d.kind === 'knob') return
        const targetZ = d.pressed ? d.pressedZ : d.baseZ
        if (Math.abs(targetZ - o.position.z) > 0.0002) animating = true
        o.position.z += (targetZ - o.position.z) * Math.min(1, dt * 20)
        if (d.pressed) { d.glow = Math.min(1, d.glow + dt * 9); animating = true }
        else { if (d.glow > 0.002) animating = true; d.glow *= Math.pow(0.015, dt) }
          ; (o.material as THREE.MeshStandardMaterial).emissiveIntensity = d.glow * 0.95
      })

      if (knobDrag) {
        knobTarget = knobOffset
        animating = true
      } else {
        if (Math.abs(knobTarget - knobOffset) > 0.001) animating = true
        knobOffset += (knobTarget - knobOffset) * Math.min(1, dt * kp.snapSpeed)
        if (Math.abs(knobTarget - knobOffset) < 0.001) knobOffset = knobTarget
      }
      knobBump.offset.x = knobOffset / kp.ridgeRepeat

      if (numberWheelDrag) {
        animating = true
      } else {
        if (Math.abs(numberWheelTarget - numberWheelAngle) > 0.001) animating = true
        numberWheelAngle += (numberWheelTarget - numberWheelAngle) * Math.min(1, dt * 12)
        if (Math.abs(numberWheelTarget - numberWheelAngle) < 0.001) numberWheelAngle = numberWheelTarget
      }
      numberWheelRoll.rotation.x = numberWheelAngle
      updateNumberWheelLighting()

      // Only touch the GPU when something actually changed. An idle device paints nothing; the
      // shadow pass (the heavy bit) runs only on the frames we render.
      if (dirty || animating) {
        renderer.shadowMap.needsUpdate = true
        renderer.render(scene, camera)
        dirty = false
      }
    }
    loop()

    return () => {
      cancelAnimationFrame(rafId)
      canvas.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
      ro.disconnect()
      pressTimers.forEach(clearTimeout)
      applyViewRef.current = () => {}
      applyThemeRef.current = () => {}
      applyOutroRef.current = () => {}
      gui?.destroy()
      logoGeo.forEach((g) => g.dispose())
      matLogoDark.dispose()
      matLogoWhite.dispose()
      renderer.dispose()
      audio.dispose()
    }
    // Scene is built once per mode; live bindings flow through refs + the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debug, customize])

  // Push label/state updates into the scene whenever the registered view changes.
  useEffect(() => {
    applyViewRef.current(view)
  }, [view])

  // Repaint the device whenever the skin changes (no rebuild).
  useEffect(() => {
    applyThemeRef.current(theme)
  }, [theme])

  // Arm / disarm the Done outro.
  useEffect(() => {
    applyOutroRef.current(outro)
  }, [outro])

  return (
    <div
      ref={rootRef}
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        // Playground sits the device on a warm backdrop to inspect the model; the real app stays
        // black so the device reads as a product shot. Customize is transparent so the workshop
        // backdrop shows around the floating device, and sits above it in the studio stack.
        background: debug
          ? 'radial-gradient(circle at 50% 38%, #f4ead6 0%, #decdab 82%)'
          : customize
            ? 'transparent'
            : '#000',
        zIndex: customize ? 10 : undefined,
      }}
    >
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
          // Real app: black backing so any rim seam reads as screen. Playground: transparent so the
          // empty layer doesn't show as a black strip when the device is rotated (screenMesh is the screen).
          background: debug ? 'transparent' : '#000',
          // Customize uses the 3D screenMesh (it spins with the body), so the HTML layer is dead weight.
          display: customize ? 'none' : undefined,
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
          {onNav ? 'Turn the wheels · press to play' : ''}
        </div>
      </div>
    </div>
  )
}
