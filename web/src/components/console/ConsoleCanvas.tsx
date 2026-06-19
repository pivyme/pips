import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import * as THREE from 'three'
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js'
import { createConsoleGui } from './consoleGui'
import { createCustomizeGui } from './customizeGui'
import {
  roundedRect,
  roundedPoly,
  frontZeroed,
  setBoxUVs,
  roundedRectPath,
  roundedPolyPath,
} from './consoleGeo'
import {
  createButtons,
  createKnob,
  createNumberWheel,
  createActionScreens,
} from './consoleElements'
import { createAudio } from './consoleAudio'
import type { ConsoleView, ButtonColor } from './controls'
import { themeBackdrop, type ConsoleTheme } from './themes'

// The 3D handheld, driven by the console controls registry. A game registers its bindings via
// useConsoleControls(); this paints live labels on the buttons + knob and dispatches the physical
// press/drag to those handlers. The game's screen content (the chart) renders in a black HTML layer
// positioned on the projected screen cutout, masked to the L-shape by the device body.

// Parsed logo SVG, cached for the page lifetime. The scene effect remounts on every debug/customize
// toggle, so without this the back logo + the main button's embossed P would re-fetch and re-parse
// async on each rebuild and pop in a few frames late. Parsed once, every later mount builds it sync.
type SvgPaths = Parameters<
  NonNullable<Parameters<SVGLoader['load']>[1]>
>[0]['paths']
let svgPathsCache: SvgPaths | null = null

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
  // Done sequence: flip `outro` true and the device snaps front-on to the exact game position with
  // the screen black, then `onOutroComplete` fires (the studio commits + leaves, and the game fades
  // its own screen content in).
  outro?: boolean
  onOutroComplete?: () => void
  // Keep the physical screen black while destination content mounts, then fade only the HTML UI in.
  screenContentVisible?: boolean
  // A prepared customize canvas renders once while hidden, then resumes its intro when revealed.
  active?: boolean
}

export default function ConsoleCanvas({
  view,
  handlers,
  onNav,
  children,
  debug = false,
  customize = false,
  theme,
  outro = false,
  onOutroComplete,
  screenContentVisible = true,
  active = true,
}: ConsoleCanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hintRef = useRef<HTMLDivElement>(null)
  const screenLayerRef = useRef<HTMLDivElement>(null)

  // Fresh per render so the scene's input handlers never read a stale binding.
  const propsRef = useRef({ handlers, onNav, onOutroComplete })
  propsRef.current = { handlers, onNav, onOutroComplete }
  const viewRef = useRef(view)
  viewRef.current = view
  const activeRef = useRef(active)
  activeRef.current = active
  // The scene exposes its label/state updater here; the [view] effect calls it.
  const applyViewRef = useRef<(v?: ConsoleView) => void>(() => {})
  // Same pattern for the skin: the [theme] effect repaints the live materials, no rebuild.
  const applyThemeRef = useRef<(t?: ConsoleTheme) => void>(() => {})
  // And for the Done outro: the [outro] effect arms the snap-to-screen + power-on sequence.
  const applyOutroRef = useRef<(on: boolean) => void>(() => {})
  const applyActiveRef = useRef<(on: boolean) => void>(() => {})

  useEffect(() => {
    const canvas = canvasRef.current
    const hint = hintRef.current
    if (!canvas || !hint) return

    const CREAM = 0xe9dbbf,
      RED = 0xd63a2e,
      BLUE = 0x3568c9,
      YELLOW = 0xefc03b

    /* renderer */
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    })
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
    const SCALE = 1 / 200,
      CX = 585,
      CY = 1155
    const wx = (px: number) => (px - CX) * SCALE
    const wy = (py: number) => (CY - py) * SCALE

    /* pocket holes — shared config needed before body geometry is built */
    const deviceCfg = { corner: 0.05 }
    const buttons = [
      // pad = gap between button edge and pocket rim on each side
      // pills share a wall so their pad is capped to avoid holes touching (~0.14 max before they'd merge)
      {
        w: 1.6,
        h: 1.5,
        r: 0.15,
        depth: 1,
        dx: 0,
        dy: 0,
        baseZ: 0.35,
        pressedZ: 0.2,
        pad: 0.15,
      },
      // the two action caps are thin, recessed screen panels: a metal bezel + acrylic mounts over them
      // (createActionScreens), so they sit low and read as little LCDs behind the frame, not pillows.
      // Wide cap + small pad so the screen fills the aperture and the bezel stays a slim rim; the hole
      // (w + pad*2) is unchanged from the old 1.6/0.15, so the two pockets still clear each other.
      {
        w: 1.72,
        h: 1.62,
        r: 0.15,
        depth: 0.44,
        dx: 0,
        dy: 0,
        baseZ: 0.16,
        pressedZ: 0.09,
        pad: 0.09,
      },
      {
        w: 1.72,
        h: 1.62,
        r: 0.15,
        depth: 0.44,
        dx: 0,
        dy: 0,
        baseZ: 0.16,
        pressedZ: 0.09,
        pad: 0.09,
      },
      {
        w: 0.98,
        h: 0.31,
        r: 0.15,
        depth: 0.3,
        dx: 0,
        dy: 0,
        baseZ: 0.2,
        pressedZ: 0.15,
        pad: 0.1,
      },
      {
        w: 1.02,
        h: 0.31,
        r: 0.15,
        depth: 0.3,
        dx: 0,
        dy: 0,
        baseZ: 0.2,
        pressedZ: 0.15,
        pad: 0.1,
      },
    ]
    // button pixel centers — kept here so buildBodyShape stays in sync with makeButton calls below
    const BTN_PX = [
      { x: 965, y: 1490 },
      { x: 200, y: 1840 },
      { x: 589, y: 1840 },
      { x: 150, y: 2150 },
      { x: 425, y: 2150 },
    ]
    // knob pocket config — w/h must stay in sync with kp.height / kp.radius*2 below
    // cylinder is rotated on Z so from the front it reads as w=height, h=radius*2
    const knobPocket = { px: 975, py: 1960, w: 1, h: 2.4, r: 0.1, pad: 0.08 }
    // Compact number drum, aligned with the Menu / Games row. It owns stake selection while the
    // yellow wheel remains available for the active game's signature control.
    const numberWheelPocket = {
      px: 690,
      py: 2140,
      w: 0.86,
      h: 0.82,
      r: 0.12,
      pad: 0.035,
    }

    // screen L-shape in pixel coords — mirrors screenPts used for the screen mesh
    // screenMesh.position.y = 0.13 is baked in here as a world-space offset before converting to body-local
    const SCREEN_PX = [
      { x: 30, y: 1680 },
      { x: 760, y: 1680 },
      { x: 760, y: 1325 },
      { x: 1140, y: 1325 },
      { x: 1140, y: 30 },
      { x: 30, y: 30 },
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
      const yOf = (py: number) =>
        wy(py) + SCREEN_MESH_Y_OFFSET + (py === 30 ? screenExt : 0)
      // z carries the device-group offset so the projected HTML layer lands on the actual cutout.
      return SCREEN_PX.map(
        (p) => new THREE.Vector3(wx(p.x), yOf(p.y), DEVICE_Z + 0.06),
      )
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
        s.holes.push(
          roundedRectPath(
            lx,
            ly,
            hw,
            hh,
            Math.min(buttons[i].r + pad, hw / 2, hh / 2),
          ),
        )
      })
      // knob pocket — rectangular hole (cylinder lies on X-axis so front face is w×h)
      const klx = wx(knobPocket.px) - wx(585)
      const kly = wy(knobPocket.py) - cy
      const kw = knobPocket.w + knobPocket.pad * 2
      const kh = knobPocket.h + knobPocket.pad * 2
      s.holes.push(
        roundedRectPath(
          klx,
          kly,
          kw,
          kh,
          Math.min(knobPocket.r + knobPocket.pad, kw / 2, kh / 2),
        ),
      )
      const nlx = wx(numberWheelPocket.px) - wx(585)
      const nly = wy(numberWheelPocket.py) - cy
      const nw = numberWheelPocket.w + numberWheelPocket.pad * 2
      const nh = numberWheelPocket.h + numberWheelPocket.pad * 2
      s.holes.push(
        roundedRectPath(
          nlx,
          nly,
          nw,
          nh,
          Math.min(numberWheelPocket.r + numberWheelPocket.pad, nw / 2, nh / 2),
        ),
      )
      // screen cutout — the L-shape (top raised by screenExt), converted to body-local coords
      s.holes.push(
        roundedPolyPath(
          screenWorldPts().map((v) => ({ x: v.x - wx(585), y: v.y - cy })),
          0.25,
        ),
      )
      return s
    }

    /* audio */
    const audio = createAudio()

    // Screen: a matte true-black panel set into the body. The live chart renders as an HTML
    // layer on top (positioned to this aperture), so this mesh is just the dark backing that
    // shows at the very edge seam.
    const matScreen = new THREE.MeshStandardMaterial({
      color: 0x000000,
      roughness: 1,
      metalness: 0,
    })

    const matBody = new THREE.MeshStandardMaterial({
      color: CREAM,
      roughness: 0.82,
      metalness: 0,
    })
    const matKnob = new THREE.MeshStandardMaterial({
      color: YELLOW,
      roughness: 0.55,
      metalness: 0,
    })

    const deck = new THREE.Group()
    scene.add(deck)

    // The flip group. Deck stays the rotation pivot; `device` centers the geometry on it (see DEVICE_Z).
    const device = new THREE.Group()
    device.position.z = DEVICE_Z
    deck.add(device)

    /* body */
    const body = new THREE.Mesh(
      frontZeroed(buildBodyShape(), 0.6, 0.08),
      matBody,
    )
    body.position.set(wx(585), wy(1130), 0)
    body.receiveShadow = true
    body.castShadow = true
    device.add(body)

    /* back panel — solid cream shell behind the body. Covers the open back (button + knob undersides)
       when the device is flipped; the slab is deep enough to swallow the deepest button and the knob.
       Same outline as the body, so it never peeks past the front silhouette. Grows with screenExt. */
    const matBack = new THREE.MeshStandardMaterial({
      color: CREAM,
      roughness: 0.88,
      metalness: 0,
    })
    const backPanel = new THREE.Mesh(
      frontZeroed(
        roundedRect(6.2, 11.95 + screenExt, deviceCfg.corner),
        1.2,
        0.08,
      ),
      matBack,
    )
    backPanel.position.set(wx(585), wy(1130) + screenExt / 2, -0.76)
    backPanel.castShadow = true
    backPanel.receiveShadow = true
    // Hidden until the device is flipped. main's screen is an HTML layer behind the canvas, shown
    // through the body's screen hole; a solid panel here would occlude it. The flip toggle reveals it.
    backPanel.visible = false
    device.add(backPanel)

    // carved back logo
    backPanel.geometry.computeBoundingBox()
    let backFaceLocalZ = backPanel.geometry.boundingBox!.min.z

    const SVG_W = 1539,
      SVG_H = 629
    const logoScale = 3.6 / SVG_W
    const logoW = SVG_W * logoScale
    const logoH = SVG_H * logoScale

    // Carve knobs, tuned live by the customize GUI. z = letter recess below the rear face, eyeZ =
    // the eyes' depth (negative pops them out as raised ovals in front), depth = extrude thickness.
    const logoCarve = { z: 0.17, eyeZ: 0.1, depth: 0.1 }

    // Letter outlines cut through the panel, in panel-local 2D. Filled once the SVG loads; the panel
    // geometry is built from these so a screen-stretch rebuild keeps the cut.
    const logoHoles: THREE.Path[] = []
    const toPanel = (p: THREE.Vector2) =>
      new THREE.Vector2(
        -logoScale * p.x + logoW / 2,
        -logoScale * p.y + logoH / 2,
      )
    const signedArea = (pts: THREE.Vector2[]) => {
      let a = 0
      for (let i = 0; i < pts.length; i++) {
        const q = pts[(i + 1) % pts.length]
        a += pts[i].x * q.y - q.x * pts[i].y
      }
      return a / 2
    }
    function buildBackPanelGeo() {
      // The body extrudes with a 0.08 bevel, which grows its silhouette by that much on every side. We
      // run no bevel here (straight 90° letter cuts), so grow the outline by the same amount to match.
      const s = roundedRect(
        6.2 + 0.16,
        11.95 + screenExt + 0.16,
        deviceCfg.corner + 0.08,
      )
      for (const h of logoHoles) s.holes.push(h)
      // no bevel: a chamfer cuts the letter walls at 45° (a triangular notch) and swallows thin strokes.
      // 0 gives straight 90° cut walls so the carve keeps the letter shape, eyes included.
      return frontZeroed(s, 1.2, 0)
    }

    // The cavity floor is a single cream plane seen from the flipped side, so it needs both faces.
    matBack.side = THREE.DoubleSide
    const cavityFloor = new THREE.Mesh(
      new THREE.ShapeGeometry(roundedRect(logoW + 0.5, logoH + 0.5, 0.1)),
      matBack,
    )
    backPanel.add(cavityFloor)

    const logoGroup = new THREE.Group()
    logoGroup.scale.set(-logoScale, -logoScale, 1)
    // SVG center (769.5, 314.5) maps to panel-local (0,0) once the mirrored scale is undone.
    logoGroup.position.set(logoW / 2, logoH / 2, backFaceLocalZ)
    backPanel.add(logoGroup)

    const logoGeo: THREE.BufferGeometry[] = []
    const matLogoDark = new THREE.MeshStandardMaterial({
      color: 0xff4444,
      roughness: 0.93,
      metalness: 0,
    })
    const matLogoWhite = new THREE.MeshStandardMaterial({
      color: 0x4488ff,
      roughness: 0.8,
      metalness: 0,
    })
    // Main-button glyph: its own tone so it reads as part of the button, not the back logo. The raised P
    // is a shade darker than the cap face; its counter stays open so the face shows through as the eye.
    // Recolored from t.main in applyTheme.
    const matMainGlyph = new THREE.MeshStandardMaterial({
      roughness: 0.6,
      metalness: 0,
    })
    // Dark letters (carved into the panel) and the eye ovals (raised in front), lifted from the
    // letters' own counters. The SVG's white rects were just flat backing and are dropped.
    const logoLetters: THREE.Shape[] = []
    const logoEyes: THREE.Shape[] = []

    // z = letter recess below the rear face, eyeZ = the eyes' depth (negative pops them out in front).
    const pieceZ = (kind: string) =>
      kind === 'eye' ? logoCarve.eyeZ : logoCarve.z

    // Re-seat the carved pieces at the current carve depth (cheap: position only, no new geometry).
    function placeLogoCarve() {
      logoGroup.children.forEach((c) => {
        c.position.z = pieceZ(c.userData.kind)
      })
      // floor sits behind the deepest piece so counters always bottom out on cream
      cavityFloor.position.z =
        backFaceLocalZ + Math.max(logoCarve.z, logoCarve.eyeZ) + 0.012
      dirty = true
    }

    // Rebuild the letter + eye meshes at the current extrude depth (needed when `depth` changes).
    function rebuildLogo() {
      for (const c of [...logoGroup.children]) logoGroup.remove(c)
      while (logoGeo.length) logoGeo.pop()!.dispose()
      const add = (shape: THREE.Shape, mat: THREE.Material, kind: string) => {
        const g = new THREE.ExtrudeGeometry(shape, {
          depth: logoCarve.depth,
          bevelEnabled: false,
        })
        g.computeBoundingBox()
        g.translate(0, 0, -g.boundingBox!.max.z)
        g.computeVertexNormals()
        logoGeo.push(g)
        const mesh = new THREE.Mesh(g, mat)
        mesh.userData.kind = kind
        logoGroup.add(mesh)
      }
      for (const shape of logoLetters) add(shape, matLogoDark, 'letter')
      for (const eye of logoEyes) add(eye, matLogoWhite, 'eye')
      placeLogoCarve()
    }

    // Derive the carved letters / eyes / panel holes from the parsed SVG, then (re)build the back logo
    // and the main button glyph. Runs sync from cache on remount, or once from the async load below.
    function buildFromSvg(paths: SvgPaths) {
      for (const path of paths) {
        const fillStr = (path.userData?.style?.fill as string) ?? ''
        const isWhite =
          /^(white|#fff(fff)?|rgb\(\s*255,\s*255,\s*255\s*\))$/i.test(fillStr)
        // Drop the flat white backing rects; the eyes are rebuilt from the dark letters' counters.
        if (isWhite) continue
        for (const shape of SVGLoader.createShapes(path)) {
          logoLetters.push(shape)
          // Each counter (the oval hole in a letter) becomes a raised eye sitting in front.
          for (const h of shape.holes) {
            const eye = new THREE.Shape()
            eye.setFromPoints(h.getPoints(40))
            logoEyes.push(eye)
          }
          // Cut this letter's outer outline through the panel (holes wind CW, opposite the body).
          const pts = shape.getPoints(40).map(toPanel)
          if (signedArea(pts) > 0) pts.reverse()
          const hole = new THREE.Path()
          hole.setFromPoints(pts)
          logoHoles.push(hole)
        }
      }
      backPanel.geometry.dispose()
      backPanel.geometry = buildBackPanelGeo()
      backPanel.geometry.computeBoundingBox()
      backFaceLocalZ = backPanel.geometry.boundingBox!.min.z
      logoGroup.position.z = backFaceLocalZ
      rebuildLogo()
      buildMainGlyph()
    }

    // Invoked below, once createButtons + buildMainGlyph exist (buildFromSvg builds the glyph onto bm).

    /* screen mesh — rebuilt by relayout() so the lit panel tracks the stretched cutout. The Done
       outro stretches it to the live game height so the handoff to the game device is seamless. */
    function buildScreenGeo() {
      const pts = SCREEN_PX.map((p) => ({
        x: wx(p.x),
        y: wy(p.y) + (p.y === 30 ? screenExt : 0),
      }))
      const g = frontZeroed(roundedPoly(pts, 0.25), 0.12, 0.03)
      setBoxUVs(g)
      return g
    }
    const screenMesh = new THREE.Mesh(buildScreenGeo(), matScreen)
    screenMesh.position.z = -0.25
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

    /* device elements — buttons + number wheel. Geometry/mesh factories live in consoleElements.ts;
       the canvas only places them and keeps the handles the loop / theme / GUI need. The knob is built
       lower down (after its `kp` tuning block). */
    const interactive: THREE.Mesh[] = []
    const matPocket = new THREE.MeshStandardMaterial({
      color: 0x19160f,
      roughness: 0.95,
      metalness: 0,
    })

    const bm = createButtons(
      device,
      interactive,
      matPocket,
      buttons,
      BTN_PX,
      [
        { color: RED, glow: 0xff5a3c },
        { color: BLUE, glow: 0x5e9bff },
        { color: BLUE, glow: 0x5e9bff },
        { color: CREAM, glow: 0xff7a1a },
        { color: CREAM, glow: 0xff7a1a },
      ],
      wx,
      wy,
    )
    const bmOrigin = bm.map((m) => ({ x: m.position.x, y: m.position.y }))

    // Frame the two action caps as mini LCD screens: a machined metal bezel + a glossy acrylic window
    // over each. The cap stays bm[i] (the raycast + press target); we just drive its color like a panel.
    const ACTION_IDX = [1, 2]
    const { dispose: disposeActionScreens, glow: actionGlow } =
      createActionScreens(device, bm, ACTION_IDX, buttons, BTN_PX, wx, wy)

    // The binding's color lights the screen (LONG → green, SHORT → red, …); off-binding the cap idles
    // dim at the theme's action tone, so it still reads as a powered screen. The loop adds the press
    // flash onto baseEmissive.
    // Pure-ish hues so the screen's own emissive glow keeps the color true instead of washing toward
    // white (a red with green/blue in it goes pink once it self-lights). Neutral is a dark LCD, not a
    // grey one, so the white label reads with full contrast (the references' black ENTER/SCAN screens).
    const SCREEN_COLORS: Record<string, string> = {
      up: '#15db6e',
      down: '#ff2a20',
      amber: '#f7b417',
      neutral: '#171a21',
    }
    let actionThemeColor = '#3568c9'
    function lightActionScreen(i: number, color: string, baseEmissive: number) {
      const mat = bm[i].material as THREE.MeshStandardMaterial
      mat.color.set(color)
      mat.emissive.set(color)
      bm[i].userData.baseEmissive = baseEmissive
      // The bloom halo is tinted to the screen color; a dark/neutral color tints it near-black so it
      // barely glows, a vivid up/down color glows strong. Idle screens bloom less.
      const halo = actionGlow[i]
      if (halo) {
        halo.color.set(color)
        halo.opacity = baseEmissive > 0.4 ? 0.4 : 0.14
      }
    }
    function relightActionScreens() {
      const one = (
        i: number,
        color: ButtonColor | undefined,
        available: boolean,
      ) => {
        const hex = (color && SCREEN_COLORS[color]) || actionThemeColor
        lightActionScreen(i, hex, available ? 0.62 : 0.14)
      }
      one(1, state.a1Color, state.a1Available)
      one(2, state.a2Color, state.a2Available)
      dirty = true
    }
    // Ambient light-show clock + a scratch color, used by the loop while state.lightShow is on.
    let lightT = 0
    const lightColor = new THREE.Color()

    // The main button wears the first glyph of the Pips wordmark, raised proud of the cap face (built
    // once the logo SVG loads, see buildMainGlyph). The glyph is a separate mesh, so the cap stays a
    // solid full-bevel pillow and keeps its glossy, light-catching rim. Cutting the glyph through the
    // cap would force a near-flat bevel (to keep the letter crisp) and kill that gloss.
    function mainCapGeo() {
      const c = buttons[0]
      return frontZeroed(roundedRect(c.w, c.h, c.r), c.depth, 0.06)
    }
    function buildMainGlyph() {
      // Leftmost letter = the first glyph in reading order.
      let glyph: THREE.Shape | null = null
      let leftmost = Infinity
      for (const s of logoLetters) {
        let minX = Infinity
        for (const p of s.getPoints(12)) minX = Math.min(minX, p.x)
        if (minX < leftmost) {
          leftmost = minX
          glyph = s
        }
      }
      if (!glyph) return

      const c = buttons[0]
      const outline = glyph.getPoints(24)
      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity
      for (const p of outline) {
        minX = Math.min(minX, p.x)
        maxX = Math.max(maxX, p.x)
        minY = Math.min(minY, p.y)
        maxY = Math.max(maxY, p.y)
      }
      const gw = maxX - minX,
        gh = maxY - minY
      const gx = (minX + maxX) / 2,
        gy = (minY + maxY) / 2
      // Fit the glyph onto the face with margin; svg y is down, so flip y as we map to button-local.
      const scale = (Math.min(c.w, c.h) * 0.6) / Math.max(gw, gh)
      const map = (p: THREE.Vector2) =>
        new THREE.Vector2(scale * (p.x - gx), -scale * (p.y - gy))

      const outlinePts = outline.map(map)
      if (signedArea(outlinePts) > 0) outlinePts.reverse()

      const raise = 0.06,
        depth = 0.2
      const extrude = (shape: THREE.Shape) => {
        const g = new THREE.ExtrudeGeometry(shape, {
          depth,
          bevelEnabled: false,
        })
        g.computeBoundingBox()
        g.translate(0, 0, -g.boundingBox!.max.z) // front face to z=0
        g.computeVertexNormals()
        return g
      }

      // Raised letter: the silhouette minus its counters (the eyes), standing proud of the cap face.
      // The open counters let the cap face read through as the eye, the same look the back-panel carve
      // gets from its lifted ovals. castShadow drops a faint emboss shadow onto the glossy face.
      const letterShape = new THREE.Shape(outlinePts)
      for (const h of glyph.holes)
        letterShape.holes.push(new THREE.Path(h.getPoints(40).map(map)))
      const letter = new THREE.Mesh(extrude(letterShape), matMainGlyph)
      letter.position.z = raise
      letter.castShadow = true
      letter.receiveShadow = true
      bm[0].add(letter)
    }

    // Now that bm + buildMainGlyph exist, build the logo + glyph: sync from cache on remount (no blink),
    // or once from the async load (first paint, then cached for every later customize/debug toggle).
    if (svgPathsCache) {
      buildFromSvg(svgPathsCache)
    } else {
      new SVGLoader().load(
        '/assets/pips-horizontal-black.svg',
        ({ paths }) => {
          svgPathsCache = paths
          buildFromSvg(paths)
        },
        undefined,
        (e) => console.error('[ConsoleCanvas] back logo SVG failed:', e),
      )
    }

    const { numberWheelRoll } = createNumberWheel(
      device,
      interactive,
      matPocket,
      numberWheelPocket,
      wx,
      wy,
      body.position.z,
    )

    // Canvas-texture label. Static caption (makeLabel) or live, updatable (makeDynLabel).
    function drawLabel(
      c: HTMLCanvasElement,
      g: CanvasRenderingContext2D,
      text: string,
      color: string,
      fs = 64,
    ) {
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

    function makeLabel(
      text: string,
      cx: number,
      cy: number,
      worldH: number,
      color: string,
    ) {
      const c = document.createElement('canvas'),
        g = c.getContext('2d')!
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
      // Repaint the caption when the skin changes its label tint.
      const recolor = (col: string) => {
        drawLabel(c, g, text, col)
        tex.needsUpdate = true
        dirty = true
      }
      return { plane, recolor }
    }

    // Updatable label that lives on a button face (or the body) and reflects the registered view.
    function makeDynLabel(
      worldH: number,
      color: string,
      opticalCenter = false,
      depthTest = false,
    ) {
      const W = 640,
        H = 128,
        FS = 92
      const c = document.createElement('canvas')
      c.width = W
      c.height = H
      const g = c.getContext('2d')!
      const tex = new THREE.CanvasTexture(c)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = MAXANISO
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        depthTest,
      })
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
              const y =
                H / 2 +
                (metrics.actualBoundingBoxAscent -
                  metrics.actualBoundingBoxDescent) /
                  2
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
    const menuLbl = makeLabel(
      'MENU',
      bm[3].position.x,
      bm[3].position.y + LABEL_DY,
      0.26,
      '#7c7870',
    )
    const gamesLbl = makeLabel(
      'HOME',
      bm[4].position.x,
      bm[4].position.y + LABEL_DY,
      0.26,
      '#7c7870',
    )

    // Live labels: action1 / action2 on their faces. The main button wears the embossed Pips glyph
    // instead of a text label (carved once the logo SVG loads, see buildMainGlyph).
    // Sits on the screen face under the acrylic. Kept small so even a 6-char label clears the bezel
    // window (the label draws depth-test-free, so it must not overrun the metal frame).
    const a1Lbl = makeDynLabel(0.36, '#ffffff')
    a1Lbl.plane.position.set(0, 0, 0.02)
    bm[1].add(a1Lbl.plane)
    const a2Lbl = makeDynLabel(0.36, '#ffffff')
    a2Lbl.plane.position.set(0, 0, 0.02)
    bm[2].add(a2Lbl.plane)

    // The right action cap is the token button: wear the coin on its face, the symbol label still
    // struck white over the center. The coin sits just proud of the cap and under the text label
    // (renderOrder 9 < 10), depth-test-free so it always reads through the acrylic window. For now
    // it's hardcoded to BTC; later this swaps per selected token.
    const a2CoinGeo = new THREE.PlaneGeometry(1, 1)
    const a2CoinMat = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      opacity: 0,
    })
    const a2Coin = new THREE.Mesh(a2CoinGeo, a2CoinMat)
    a2Coin.renderOrder = 9
    const a2CoinFit = Math.min(buttons[2].w, buttons[2].h) * 0.64
    a2Coin.scale.set(a2CoinFit, a2CoinFit, 1)
    a2Coin.position.set(0, 0, 0.012)
    bm[2].add(a2Coin)
    new THREE.TextureLoader().load(
      '/assets/images/coins/btc-logo.png',
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace
        tex.anisotropy = MAXANISO
        a2CoinMat.map = tex
        a2CoinMat.opacity = 1
        a2CoinMat.needsUpdate = true
        dirty = true
      },
    )

    const NUMBER_LABEL_ANGLE = 1.02
    const NUMBER_LABEL_RADIUS = 0.4
    const MAX_NUMBER_WHEEL_LABELS = 5
    const numberWheelLabels = Array.from(
      { length: MAX_NUMBER_WHEEL_LABELS },
      () => {
        // Keep the digits above the drum instead of depth-fighting into its black surface.
        const label = makeDynLabel(0.46, '#ffffff', true)
        numberWheelRoll.add(label.plane)
        return { ...label, angle: 0, active: false }
      },
    )
    let numberWheelAngle = 0
    let numberWheelTarget = 0
    let numberWheelInitialized = false
    let debugNumberValue = 1
    let idleNumberValue = 2
    const idleStakes = [1, 5, 10, 25, 50, 100]
    const debugNumberWheel = {
      min: 0,
      max: 9,
      step: 1,
      value: debugNumberValue,
      label: 'USDC',
      format: (value: number) => String(value),
    }
    // In the studio no game binds the wheel, so it would read as an empty black drum. Park a sample
    // value on it so the device looks complete in the product shot.
    const customizeWheel = {
      // The studio's orbit grab already blocks interaction with it.
      min: 0,
      max: 9,
      step: 1,
      value: 5,
      label: '',
      format: (value: number) => String(value),
    }
    const idleNumberWheel = {
      min: 0,
      max: idleStakes.length - 1,
      step: 1,
      value: idleNumberValue,
      label: 'USDC',
      format: (value: number) => String(idleStakes[value]),
    }

    // View state mirrored from the registry. Registered controls remain physically interactive;
    // unbound controls still move and sound, but only registered controls dispatch into a screen.
    const state = {
      mainAvailable: false,
      a1Available: false,
      a2Available: false,
      knobAvailable: false,
      numberWheelBound: false,
      a1Color: undefined as ButtonColor | undefined,
      a2Color: undefined as ButtonColor | undefined,
      knob: null as null | NonNullable<ConsoleView['knob']>,
      numberWheel: null as null | NonNullable<ConsoleView['numberWheel']>,
      lightShow: false,
    }

    function setNumberWheelLabels(
      spec: NonNullable<ConsoleView['numberWheel']> | null,
    ) {
      const count = spec
        ? Math.floor((spec.max - spec.min) / spec.step + 0.5) + 1
        : 0
      const visibleCount = Math.min(count, MAX_NUMBER_WHEEL_LABELS)
      const centerIndex = spec ? Math.round(numberWheelPosition(spec)) : 0
      const startIndex = Math.max(
        0,
        Math.min(count - visibleCount, centerIndex - 2),
      )

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

    function numberWheelPosition(
      spec: NonNullable<ConsoleView['numberWheel']>,
    ): number {
      return (spec.value - spec.min) / spec.step
    }

    function updateNumberWheelLighting() {
      for (const label of numberWheelLabels) {
        if (!label.active) continue
        const angle = Math.atan2(
          Math.sin(label.angle - numberWheelAngle),
          Math.cos(label.angle - numberWheelAngle),
        )
        const facing = Math.max(0, Math.cos(angle))
        const light = Math.pow(facing, 2.2)
        label.mat.opacity = facing > 0 ? 0.12 + 0.88 * light : 0
        const brightness = 0.32 + 0.68 * Math.pow(facing, 1.6)
        label.mat.color.setRGB(brightness, brightness, brightness)
      }
    }

    function applyView(v?: ConsoleView) {
      const m = v?.main
      state.mainAvailable = !!m
      // The two action caps are lit screens. A bound game owns their label + color; in the playground
      // there is no game, so seed LONG / SHORT to demo the screens lighting up dynamically.
      const a1 =
        v?.action1 ?? (debug ? { label: 'LONG', color: 'up' as const } : null)
      const a2 =
        v?.action2 ??
        (debug ? { label: 'SHORT', color: 'down' as const } : null)
      state.a1Available = !!a1
      state.a1Color = a1?.color
      a1Lbl.set(a1?.label ?? '', state.a1Available ? 1 : 0.34)
      state.a2Available = !!a2
      state.a2Color = a2?.color
      a2Lbl.set(a2?.label ?? '', state.a2Available ? 1 : 0.34)
      state.lightShow = !!v?.lightShow
      // When the show ends, relight settles the screens back to their idle / bound color; while it runs
      // the loop owns their color, so this is just the baseline it animates away from.
      relightActionScreens()
      const k = v?.knob ?? null
      state.knob = k
      state.knobAvailable = !!k
      state.numberWheelBound = !!v?.numberWheel
      const n =
        v?.numberWheel ??
        (debug
          ? { ...debugNumberWheel, value: debugNumberValue }
          : customize
            ? customizeWheel
            : { ...idleNumberWheel, value: idleNumberValue })
      state.numberWheel = n
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

    function dispatch(i: number) {
      const h = propsRef.current.handlers?.current
      if (i === 0) h?.main?.()
      else if (i === 1) h?.action1?.()
      else if (i === 2) h?.action2?.()
      else if (i === 3) propsRef.current.onNav?.('MENU')
      else if (i === 4) propsRef.current.onNav?.('GAMES')
    }

    function rebuildBtnGeo(i: number) {
      const m = bm[i],
        c = buttons[i]
      m.geometry.dispose()
      m.geometry =
        i === 0
          ? mainCapGeo()
          : frontZeroed(roundedRect(c.w, c.h, c.r), c.depth, 0.06)
      m.position.x = bmOrigin[i].x + c.dx
      m.position.y = bmOrigin[i].y + c.dy
      m.userData.depth = c.depth
      rebuildBodyGeo()
    }

    /* knob */
    const kp = {
      ridgeWidth: 120,
      grooveWidth: 50,
      bumpScale: 45,
      ridgeRepeat: 20,
      cornerCurve: 0.2,
      radius: 1.25,
      height: 0.95,
      edgeCurve: 0.1,
      dragSensitivity: 0.5,
      ridgePhase: 0,
      snapInterval: 20,
      snapSpeed: 5,
      ridgeLength: 0.825,
    }

    const { knobSlab, knobBump, matKnobSlab, redrawBump, knobProfile } =
      createKnob(
        device,
        interactive,
        matPocket,
        matKnob,
        kp,
        knobPocket,
        wx,
        wy,
        body.position.z,
      )

    // Body skin: some themes wrap an SVG across the front body instead of a flat color. We load it
    // once (cached), project it onto the body front as a normalized planar map, and cover-fit it so
    // its squares stay square at any frame height (screenExt stretches the body). Texture transform
    // does the cover crop, so a relayout never needs to touch the loaded image.
    const texLoader = new THREE.TextureLoader()
    const skinCache = new Map<string, THREE.Texture>()
    let bodySkinTex: THREE.Texture | null = null
    let pendingSkinUrl: string | null = null

    function fitBodySkin() {
      if (!bodySkinTex) return
      setBoxUVs(body.geometry) // normalize the front face to 0..1 across the current body box
      const bb = body.geometry.boundingBox!
      const bodyA = (bb.max.x - bb.min.x) / (bb.max.y - bb.min.y)
      const img = bodySkinTex.image as
        | { width?: number; height?: number }
        | undefined
      const texA = (img?.width ?? 1400) / (img?.height ?? 2489)
      const ratio = bodyA / texA
      if (ratio <= 1) {
        bodySkinTex.repeat.set(ratio, 1) // body taller than the art → crop the sides, keep full height
        bodySkinTex.offset.set((1 - ratio) / 2, 0)
      } else {
        bodySkinTex.repeat.set(1, 1 / ratio) // body wider → crop top/bottom, keep full width
        bodySkinTex.offset.set(0, (1 - 1 / ratio) / 2)
      }
      bodySkinTex.needsUpdate = true
    }

    function setBodySkin(url?: string) {
      if (!url) {
        if (matBody.map) {
          matBody.map = null
          matBody.needsUpdate = true
          dirty = true
        }
        bodySkinTex = null
        return
      }
      const apply = (tex: THREE.Texture) => {
        bodySkinTex = tex
        matBody.map = tex
        matBody.color.set(0xffffff) // map multiplies by color, so go white to show the art true
        matBody.needsUpdate = true
        fitBodySkin()
        dirty = true
      }
      const cached = skinCache.get(url)
      if (cached) {
        apply(cached)
        return
      }
      texLoader.load(
        url,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace
          tex.anisotropy = MAXANISO
          tex.wrapS = THREE.ClampToEdgeWrapping
          tex.wrapT = THREE.ClampToEdgeWrapping
          skinCache.set(url, tex)
          if (pendingSkinUrl === url) apply(tex) // ignore if the skin changed mid-load
        },
        undefined,
        (e) => console.error('[ConsoleCanvas] body skin SVG failed:', e),
      )
    }

    // Repaint the device to a skin. Colors only, no geometry touched, so it's cheap enough to run on
    // every card tap in the studio. emissive tracks the color so the press glow stays in-palette.
    function applyTheme(t?: ConsoleTheme) {
      if (!t) return
      // Body color is the flat skin and the pre-load tint; setBodySkin overlays the SVG when present.
      matBody.color.set(t.body)
      pendingSkinUrl = t.skin ?? null
      setBodySkin(t.skin)
      matBack.color.set(t.back ?? t.body)
      matKnob.color.set(t.knob)
      matKnobSlab.color.set(t.knob)
      // Carved back logo: letters take the accent tone, the raised eyes match the back panel so they
      // read as the same material punched through, not a separate inlay.
      const logoColor = t.logo ?? t.knob
      matLogoDark.color.set(logoColor)
      matLogoWhite.color.set(t.back ?? t.body)
      const paint = (m: THREE.Mesh, c: string) => {
        const mat = m.material as THREE.MeshStandardMaterial
        mat.color.set(c)
        mat.emissive.set(c)
      }
      paint(bm[0], t.main)
      // Raised P tracks the button: a shade darker than the face, its open counter reads as the eye.
      matMainGlyph.color.set(t.main).multiplyScalar(0.7)
      // The action caps are screens, not flat buttons: the theme tone is just their dim idle glow; a
      // bound game overrides it with the live up/down color (relightActionScreens).
      actionThemeColor = t.action
      relightActionScreens()
      paint(bm[3], t.pills)
      paint(bm[4], t.pills)
      // MENU / GAMES captions under the nav pills
      const labelColor = t.label ?? '#7c7870'
      menuLbl.recolor(labelColor)
      gamesLbl.recolor(labelColor)
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
      if (bodySkinTex) fitBodySkin() // re-project the skin onto the new (stretched) body box
      body.position.y = wy(1130) + screenExt / 2
      // back panel tracks the body so it stays a full cover when the screen stretches, keeping the cut logo
      backPanel.geometry.dispose()
      backPanel.geometry = buildBackPanelGeo()
      backPanel.position.y = wy(1130) + screenExt / 2
    }

    // Stretch the screen + body top to `ext` world units past natural, then refresh the projection
    // points. The control deck stays fixed. No-op when unchanged so resize churn stays cheap.
    function relayout(ext: number) {
      if (ext === screenExt) return
      screenExt = ext
      rebuildBodyGeo()
      screenMesh.geometry.dispose()
      screenMesh.geometry = buildScreenGeo()
      screenWorld = screenWorldPts()
    }

    /* customize studio — the device floats as a hero product shot you can spin. The intro eases the
       camera from a bigger, near-front pose into a pulled-back 3/4 (it "shrinks into the center");
       after that, drag spins the deck so you can read the front, the sides and the embossed back. */
    const CUST = {
      // intro: start pose → rest pose, lerped by easeOutExpo(introT). Rest sits the device small and
      // high so the workshop breathes around it and the preset rail has room below.
      camZ: [29, 40] as const,
      lookY: [-0.6, -3.2] as const,
      yaw: [-0.1, -0.5] as const,
      pitch: [-0.03, -0.17] as const,
      introMs: 880,
      outroMs: 700,
      fadeMs: 40, // one clean black frame once the snap settles, then hand off to the live device
    }
    // Studio camera distance multiplier on the rest pose (1 = default, lower = pulled closer).
    const custCam = { zoom: 1 }
    // Studio idle float tuning. speed = overall cycle rate, bob = up/down height (world units),
    // tiltX/tiltZ = pitch/roll sway (radians). Set any to 0 to drop that axis.
    const FLOAT = { speed: 1.5, bob: 0.15, tiltX: 0.07, tiltZ: 0.05 }
    let floatPhase = 0 // drives the studio idle float
    let introT = customize ? 0 : 1 // 0 → start, 1 → settled
    let orbitYaw = 0 // persists, so you can park it facing back
    let orbitPitch = 0 // eases back to level on release
    let orbitDrag = false
    let orbitStartX = 0,
      orbitStartY = 0,
      orbitBaseYaw = 0,
      orbitBasePitch = 0
    // Done outro: 0 → product shot, 1 → snapped front-on with the screen lit.
    let outroActive = false
    let outroT = 0
    let outroFade = 0 // screen fade-to-black, runs only once the zoom has fully settled
    let outroFired = false

    const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t))
    const easeInOutCubic = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t
    const responsiveScreenExt = () => {
      const aspect = Math.max(camera.aspect, 0.0001)
      return Math.max(0, Math.round((6.2 / aspect - 11.95) * 100) / 100)
    }

    // Keep zero power physically black. Non-zero values retain the optional cool LCD boot glow.
    function setScreenPower(p: number) {
      if (p <= 0) {
        matScreen.color.setRGB(0, 0, 0)
        matScreen.emissive.setRGB(0, 0, 0)
        matScreen.emissiveIntensity = 0
        return
      }
      matScreen.emissive.setRGB(0.1 * p, 0.16 * p, 0.28 * p)
      matScreen.emissiveIntensity = p * 2.6
      const base = 0.06 * p
      matScreen.color.setRGB(base, base + 0.01 * p, base + 0.04 * p)
    }

    function placeCustomizeCamera() {
      const e = easeOutExpo(introT)
      let lookY = lerp(CUST.lookY[0], CUST.lookY[1], e)
      let camZ = lerp(CUST.camZ[0], CUST.camZ[1], e) * custCam.zoom
      let yaw = lerp(CUST.yaw[0], CUST.yaw[1], e) + orbitYaw * e
      let pitch = lerp(CUST.pitch[0], CUST.pitch[1], e) + orbitPitch * e
      if (outroActive) {
        // Land on the exact pose the games view computes for this aspect (same cy/d math as the
        // resize handler), so when the studio hands off to the live game device there's no jump.
        // The device was stretched to that height when the outro armed.
        const o = easeInOutCubic(outroT)
        const tanHalf = Math.tan((camera.fov * Math.PI) / 180 / 2)
        const aspect = Math.max(camera.aspect, 0.0001)
        const ext = responsiveScreenExt()
        const cy = wy(1130) + ext / 2
        const frontZ =
          (ext > 0
            ? (6.2 * 0.5) / (tanHalf * aspect)
            : (11.95 * 0.5) / tanHalf) + DEVICE_Z
        lookY = lerp(lookY, cy, o)
        camZ = lerp(camZ, frontZ, o)
        yaw = lerp(yaw, 0, o)
        pitch = lerp(pitch, 0, o)
      }
      camera.position.set(0, lookY, camZ)
      camera.lookAt(0, lookY, 0)
      deck.rotation.set(pitch, yaw, 0)
      // Keep the solid back on through the whole spin and only drop it once we're basically front-on,
      // so it doesn't pop while the device is still angled. By then it's occluded anyway.
      backPanel.visible = !outroActive || easeInOutCubic(outroT) < 0.9
    }

    applyOutroRef.current = (on: boolean) => {
      if (on) {
        introT = 1 // settle instantly so the outro starts from the rest pose
        // Stretch the device to the live game height up front so the screen we zoom into is exactly
        // the one the games view mounts, keeping the handoff seamless.
        relayout(responsiveScreenExt())
        outroActive = true
        outroT = 0
        outroFade = 0
        outroFired = false
      } else {
        outroActive = false
        outroT = 0
        outroFade = 0
        outroFired = false
        relayout(customize ? responsiveScreenExt() : 0)
        setScreenPower(0)
      }
      dirty = true
    }

    /* GUI — the full dev panel when debugging (the /console playground), a slim carve panel in the studio */
    const gui = debug
      ? createConsoleGui({
          kp,
          buttons,
          knobPocket,
          deviceCfg,
          bm,
          matKnobSlab,
          knobBump,
          matScreen,
          deck,
          backPanel,
          lights: { key, fill, hemi, ambient },
          logo: {
            carve: logoCarve,
            onPlace: placeLogoCarve,
            onRebuild: rebuildLogo,
          },
          onRedrawBump: redrawBump,
          onRebuildBodyGeo: rebuildBodyGeo,
          onRebuildBtnGeo: rebuildBtnGeo,
          onRebuildKnobGeo: rebuildKnobGeo,
          requestRender: () => {
            dirty = true
          },
        })
      : customize
        ? createCustomizeGui({
            carve: logoCarve,
            onPlaceLogo: placeLogoCarve,
            onRebuildLogo: rebuildLogo,
            cam: custCam,
            onCam: () => {
              placeCustomizeCamera()
              dirty = true
            },
          })
        : null
    applyActiveRef.current = (on: boolean) => {
      if (customize && gui) {
        if (on) gui.show()
        else gui.hide()
      }
      dirty = true
    }
    applyActiveRef.current(activeRef.current)

    /* pointer handling */
    const raycaster = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const MIN_PRESS_MS = 120
    const pressTimers: ReturnType<typeof setTimeout>[] = []
    let active: THREE.Mesh | null = null
    let knobDrag = false,
      knobStartY = 0,
      knobBase = 0,
      knobStartDetent = 0,
      knobLastStep = 0,
      knobStartValue = 0
    let numberWheelDrag = false,
      numberWheelStartY = 0,
      numberWheelLastStep = 0,
      numberWheelStartValue = 0
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
        canvas.setPointerCapture(e.pointerId)
        numberWheelDrag = true
        numberWheelStartY = e.clientY
        numberWheelLastStep = 0
        numberWheelStartValue = state.numberWheel?.value ?? debugNumberValue
        numberWheelStartPosition = state.numberWheel
          ? numberWheelPosition(state.numberWheel)
          : 0
        return
      }
      if (obj.userData.kind === 'knob') {
        canvas.setPointerCapture(e.pointerId)
        knobDrag = true
        knobStartY = e.clientY
        knobBase = knobOffset
        knobStartDetent = Math.round(knobOffset / kp.snapInterval)
        knobLastStep = 0
        knobStartValue = state.knob?.value ?? 0
        return
      }
      const bi = bm.indexOf(obj)
      canvas.setPointerCapture(e.pointerId)
      obj.userData.pressed = true
      obj.userData.pressedAt = performance.now()
      obj.userData.glow = Math.max(obj.userData.glow, 0.001)
      active = obj
      if (bi === 0) audio.playSfx('mainPress', 'main')
      else if (bi === 1) audio.playSfx('actionPress', 'action1')
      else if (bi === 2) audio.playSfx('actionPress', 'action2')
      else if (bi === 3) audio.playSfx('pillPress', 'menu')
      else if (bi === 4) audio.playSfx('pillPress', 'home')
      dispatch(bi)
    }

    const onPointerMove = (e: PointerEvent) => {
      if (customize) {
        if (orbitDrag) {
          orbitYaw = orbitBaseYaw + (e.clientX - orbitStartX) * 0.011
          orbitPitch = Math.max(
            -0.5,
            Math.min(0.46, orbitBasePitch + (e.clientY - orbitStartY) * 0.006),
          )
        } else {
          canvas.style.cursor = 'grab'
        }
        return
      }
      toNDC(e)
      if (numberWheelDrag) {
        const wheel = state.numberWheel
        if (!wheel) return
        const rawSteps =
          (numberWheelStartY - e.clientY) / NUMBER_WHEEL_PX_PER_STEP
        const minSteps = (wheel.min - numberWheelStartValue) / wheel.step
        const maxSteps = (wheel.max - numberWheelStartValue) / wheel.step
        const resistedSteps =
          rawSteps < minSteps
            ? minSteps - Math.min(0.28, (minSteps - rawSteps) * 0.16)
            : rawSteps > maxSteps
              ? maxSteps + Math.min(0.28, (rawSteps - maxSteps) * 0.16)
              : rawSteps
        const steps = Math.round(
          Math.min(maxSteps, Math.max(minSteps, resistedSteps)),
        )
        numberWheelAngle =
          -(numberWheelStartPosition + resistedSteps) * NUMBER_LABEL_ANGLE
        numberWheelTarget = numberWheelAngle
        if (steps !== numberWheelLastStep) {
          const direction = Math.sign(steps - numberWheelLastStep)
          for (
            let detent = numberWheelLastStep + direction;
            detent !== steps + direction;
            detent += direction
          ) {
            audio.playSfx('knob', 'thumbwheel')
            const raw = numberWheelStartValue + detent * wheel.step
            const next = Math.min(
              wheel.max,
              Math.max(wheel.min, Number(raw.toFixed(6))),
            )
            const handler = propsRef.current.handlers?.current.numberWheel
            if (handler) {
              handler(next)
            } else if (!state.numberWheelBound) {
              if (debug) {
                debugNumberValue = next
                const debugSpec = {
                  ...debugNumberWheel,
                  value: debugNumberValue,
                }
                state.numberWheel = debugSpec
                setNumberWheelLabels(debugSpec)
              } else if (!customize) {
                idleNumberValue = next
                const idleSpec = { ...idleNumberWheel, value: idleNumberValue }
                state.numberWheel = idleSpec
                setNumberWheelLabels(idleSpec)
              }
            }
          }
          numberWheelLastStep = steps
        }
        return
      }
      if (knobDrag) {
        const dyDown = e.clientY - knobStartY // down positive — drives the visual ridge scroll
        knobOffset = knobBase + dyDown * kp.dragSensitivity
        const detent = Math.round(knobOffset / kp.snapInterval)
        const steps = knobStartDetent - detent // dragging up advances one value per physical click
        if (steps !== knobLastStep) {
          const direction = Math.sign(steps - knobLastStep)
          for (
            let step = knobLastStep + direction;
            step !== steps + direction;
            step += direction
          ) {
            audio.playSfx('knob', 'knob')
            const k = state.knob
            if (k && state.knobAvailable) {
              const next = Math.min(
                k.max,
                Math.max(k.min, knobStartValue + step * k.step),
              )
              propsRef.current.handlers?.current.knob?.(next)
            }
          }
          knobLastStep = steps
        }
        return
      }
      const target = pick()
      canvas.style.cursor = target
        ? target.userData.kind === 'knob' ||
          target.userData.kind === 'numberWheel'
          ? 'ns-resize'
          : 'pointer'
        : 'default'
    }

    function release() {
      if (orbitDrag) {
        orbitDrag = false
        renderer.domElement.style.cursor = 'grab'
        return
      }
      if (numberWheelDrag) {
        numberWheelTarget =
          -(numberWheelStartPosition + numberWheelLastStep) * NUMBER_LABEL_ANGLE
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
          if (bi === 0) audio.playSfx('mainRelease', 'main')
          else if (bi === 1) audio.playSfx('actionRelease', 'action1')
          else if (bi === 2) audio.playSfx('actionRelease', 'action2')
          else if (bi === 3) audio.playSfx('pillRelease', 'menu')
          else if (bi === 4) audio.playSfx('pillRelease', 'home')
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
    const onVisible = () => {
      dirty = true
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)

    /* resize — fits the device to the container, then projects the cutout onto the screen layer */
    function resize() {
      const container = rootRef.current
      if (!container) return
      const w = container.clientWidth,
        h = container.clientHeight
      if (w === 0 || h === 0) return
      renderer.setSize(w, h)
      camera.aspect = w / h

      if (customize) {
        // Match the live console's responsive height before the studio paints. Tall phones extend
        // the screen instead of snapping the device back to its shorter natural geometry.
        relayout(responsiveScreenExt())
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
        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity
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
        // Rim-safe inset for HTML content, published as --screen-rim. The device is responsive, so
        // a fixed px pad crops once it scales up: this tracks the projected screen and clears the
        // rounded, beveled cutout edge (~corner radius 0.25 world + bevel). Screens inset text by
        // var(--screen-rim); rules and charts bleed full width and tuck under the rim. This is the
        // layout boundary every console screen lays out against.
        const scale = (maxX - minX) / (wx(1140) - wx(30))
        el.style.setProperty(
          '--screen-rim',
          `${Math.max(16, Math.round(M + 0.33 * scale))}px`,
        )
      }
      dirty = true // camera/geometry moved, repaint once
    }
    const ro = new ResizeObserver(() => resize())
    if (rootRef.current) ro.observe(rootRef.current)
    resize()
    applyView(viewRef.current)

    // Game side only: the layer starts hidden (opacity 0) only so it doesn't flash before it's been
    // sized, then snaps to visible on the next frame. No fade, no entry animation, the screen just
    // shows its content the instant it's laid out.
    if (!customize) {
      requestAnimationFrame(() => {
        if (screenLayerRef.current) screenLayerRef.current.style.opacity = '1'
      })
    }

    /* render loop */
    const clock = new THREE.Clock()
    let rafId: number

    function loop() {
      rafId = requestAnimationFrame(loop)
      const dt = Math.min(clock.getDelta(), 0.05)
      let animating = false

      if (customize) {
        if (!activeRef.current && !outroActive) {
          if (dirty) {
            renderer.shadowMap.needsUpdate = true
            renderer.render(scene, camera)
            dirty = false
          }
          return
        }
        // Idle float: a slow sine bob plus a gentle tilt sway so the hero shot feels alive. The axes
        // run at offset rates so it never looks mechanical. Eases out during the Done snap so it
        // doesn't fight the front framing. Keeps the loop painting while the studio is open.
        floatPhase += dt * FLOAT.speed
        const floatFade = outroActive ? Math.max(0, 1 - outroT * 2.5) : 1
        device.position.y = Math.sin(floatPhase) * FLOAT.bob * floatFade
        device.rotation.x =
          Math.sin(floatPhase * 0.8 + 0.6) * FLOAT.tiltX * floatFade
        device.rotation.z = Math.cos(floatPhase * 0.6) * FLOAT.tiltZ * floatFade
        animating = true
        if (introT < 1) {
          introT = Math.min(1, introT + (dt * 1000) / CUST.introMs)
          animating = true
        }
        if (outroActive) {
          // Screen stays off through the whole snap, so the device lands in the exact black
          // "game loading" state. The fade-in belongs to the game, not the studio.
          setScreenPower(0)
          if (outroT < 1) {
            outroT = Math.min(1, outroT + (dt * 1000) / CUST.outroMs)
            animating = true
          } else {
            // Settled at the game position: hold the black beat, then hand off so the game
            // mounts and fades its own screen content in.
            outroFade = Math.min(1, outroFade + (dt * 1000) / CUST.fadeMs)
            if (outroFade < 1) animating = true
            else if (!outroFired) {
              outroFired = true
              propsRef.current.onOutroComplete?.()
            }
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
        if (d.pressed) {
          d.glow = Math.min(1, d.glow + dt * 9)
          animating = true
        } else {
          if (d.glow > 0.002) animating = true
          d.glow *= Math.pow(0.015, dt)
        }
        // Screen caps hold a steady idle glow (baseEmissive); the press flash rides on top of it.
        ;(o.material as THREE.MeshStandardMaterial).emissiveIntensity =
          (d.baseEmissive ?? 0) + d.glow * 0.95
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
        if (Math.abs(numberWheelTarget - numberWheelAngle) > 0.001)
          animating = true
        numberWheelAngle +=
          (numberWheelTarget - numberWheelAngle) * Math.min(1, dt * 12)
        if (Math.abs(numberWheelTarget - numberWheelAngle) < 0.001)
          numberWheelAngle = numberWheelTarget
      }
      numberWheelRoll.rotation.x = numberWheelAngle
      updateNumberWheelLighting()

      // Ambient light show: while a game flags it (a live run), the two unbound action screens drift
      // slowly through the spectrum as decoration. Pure color + glow, no geometry moves, so it must not
      // trigger the shadow pass; `lightOnly` keeps these frames cheap so it never costs the game fps.
      let lightOnly = false
      if (state.lightShow) {
        lightOnly = !animating && !dirty
        lightT += dt
        const hueBase = (lightT / 14) % 1 // a calm ~14s lap of the color wheel
        ACTION_IDX.forEach((i, k) => {
          lightColor.setHSL((hueBase + k * 0.5) % 1, 0.85, 0.5) // the two sit complementary
          const mat = bm[i].material as THREE.MeshStandardMaterial
          mat.color.copy(lightColor)
          mat.emissive.copy(lightColor)
          // gentle breathing, offset between the two so they don't pulse in lockstep
          bm[i].userData.baseEmissive =
            0.42 + 0.1 * Math.sin(lightT * 1.5 + k * Math.PI)
          const halo = actionGlow[i]
          if (halo) {
            halo.color.copy(lightColor)
            halo.opacity = 0.34
          }
        })
        animating = true
      }

      // Only touch the GPU when something actually changed. An idle device paints nothing; the shadow
      // pass (the heavy bit) runs only when geometry moved, never for the color-only light show.
      if (dirty || animating) {
        if (!lightOnly) renderer.shadowMap.needsUpdate = true
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
      applyActiveRef.current = () => {}
      gui?.destroy()
      disposeActionScreens()
      a2CoinMat.map?.dispose()
      a2CoinMat.dispose()
      a2CoinGeo.dispose()
      logoGeo.forEach((g) => g.dispose())
      skinCache.forEach((t) => t.dispose())
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

  useEffect(() => {
    applyActiveRef.current(active)
  }, [active])

  return (
    <div
      ref={rootRef}
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        // Playground sits the device on a warm backdrop to inspect the model; the real app frames it
        // on a deep tint of the active skin so the surround feels themed, not flat black. Customize is
        // transparent so the workshop backdrop shows around the floating device.
        background: debug
          ? 'radial-gradient(circle at 50% 38%, #f4ead6 0%, #decdab 82%)'
          : customize
            ? 'transparent'
            : theme
              ? themeBackdrop(theme)
              : '#000',
        zIndex: customize ? 10 : undefined,
      }}
    >
      {/* screen content sits behind the device; the body's hole cuts it to the L-shape and the
          beveled rim frames it. Total black so any rim seam reads as screen, not a gap. */}
      <div
        ref={screenLayerRef}
        className={debug || customize ? undefined : 'console-screen-surface'}
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
          // Hidden until sized (so it doesn't flash mispositioned), then snapped to visible. No fade:
          // the screen content appears instantly, no entry animation.
          opacity: customize ? undefined : 0,
          overflow: 'hidden',
        }}
      >
        <div
          className="console-screen-content"
          data-visible={screenContentVisible ? 'true' : 'false'}
          aria-hidden={!screenContentVisible}
        >
          {children}
        </div>
      </div>

      {/* device canvas on top — transparent through the screen hole + outside the body */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 10,
          touchAction: 'none',
        }}
      >
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
        ></div>
      </div>
    </div>
  )
}
