import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import * as THREE from 'three'
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js'
import { createConsoleGui } from './consoleGui'
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
  createBackDetails,
  createInternals,
} from './consoleElements'
import { createAudio } from './consoleAudio'
import { unlockAudio } from '@/lib/sound'
import type { ActionDisplay, ButtonColor, ConsoleView } from './controls'
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
  // PNG export tool (/export): a still product shot, no idle float, the device pose driven entirely by
  // the x/y sliders (exportRot, radians). Forces preserveDrawingBuffer so the canvas reads out to PNG.
  exportMode?: boolean
  exportRot?: { x: number; y: number }
  // /export "Game screens": a snapshot of a real game screen, painted onto the 3D screen mesh as an
  // emissive map. Lets the export tool pose the handheld holding a live game and spin it in full 3D
  // (the HTML screen layer can't follow a spin, the textured mesh can). Customize/export path only.
  screenTexture?: string | null
  // Done sequence: flip `outro` true and the device snaps front-on to the exact game position with
  // the screen black, then `onOutroComplete` fires (the studio commits + leaves, and the game fades
  // its own screen content in).
  outro?: boolean
  onOutroComplete?: () => void
  // Keep the physical screen black while destination content mounts, then fade only the HTML UI in.
  screenContentVisible?: boolean
  // A prepared customize canvas renders once while hidden, then resumes its intro when revealed.
  active?: boolean
  // Customize only: start the intro at the exact live games/app pose (the mirror of the Done outro
  // target) instead of the studio's default fly-in. Lets onboarding hand off from the live device so it
  // reads as the same handheld zooming back out into the workshop, not a crossfade to a second one.
  introFromApp?: boolean
  // Landing/onboarding arc on the LIVE shell (customize stays false). 'hero' floats the device as a
  // pulled-back product shot with the screen showing; 'app' is the exact resting games pose (the
  // "moves to center" settle); 'welcome' zooms the camera into the screen with a turn flourish, fires
  // onWelcomeArrived once it squares up + fills (the splash content reveals then), and HOLDS there. It
  // does not auto-advance: switching stage back to 'app' plays the zoom-out and fires onWelcomeComplete.
  stage?: 'hero' | 'app' | 'welcome'
  onWelcomeComplete?: () => void
  // Fired once the welcome zoom-in settles (front-on, screen filled), so the app can reveal the splash
  // content + play its jingle in sync with the device arriving.
  onWelcomeArrived?: () => void
  reducedMotion?: boolean
  // Hold the resting app pose with no hero -> app settle. A returning session sets this so a refresh
  // never replays the entry zoom (that animation is for a real login only).
  instant?: boolean
}

export default function ConsoleCanvas({
  view,
  handlers,
  onNav,
  children,
  debug = false,
  customize = false,
  theme,
  exportMode = false,
  exportRot,
  screenTexture = null,
  outro = false,
  onOutroComplete,
  screenContentVisible = true,
  active = true,
  introFromApp = false,
  stage = 'app',
  onWelcomeComplete,
  onWelcomeArrived,
  reducedMotion = false,
  instant = false,
}: ConsoleCanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hintRef = useRef<HTMLDivElement>(null)
  const screenLayerRef = useRef<HTMLDivElement>(null)

  // Fresh per render so the scene's input handlers never read a stale binding.
  const propsRef = useRef({ handlers, onNav, onOutroComplete, onWelcomeComplete, onWelcomeArrived })
  propsRef.current = { handlers, onNav, onOutroComplete, onWelcomeComplete, onWelcomeArrived }
  const viewRef = useRef(view)
  viewRef.current = view
  const exportRotRef = useRef(exportRot)
  exportRotRef.current = exportRot
  const screenTexRef = useRef(screenTexture)
  screenTexRef.current = screenTexture
  const activeRef = useRef(active)
  activeRef.current = active
  const reducedMotionRef = useRef(reducedMotion)
  reducedMotionRef.current = reducedMotion
  const instantRef = useRef(instant)
  instantRef.current = instant
  // Read at keypress time: false while the customize studio takes the device over (screen off).
  const screenContentVisibleRef = useRef(screenContentVisible)
  screenContentVisibleRef.current = screenContentVisible
  // The scene exposes its label/state updater here; the [view] effect calls it.
  const applyViewRef = useRef<(v?: ConsoleView) => void>(() => {})
  // Same pattern for the skin: the [theme] effect repaints the live materials, no rebuild.
  const applyThemeRef = useRef<(t?: ConsoleTheme) => void>(() => {})
  // /export only: the [screenTexture] effect paints a game snapshot onto the screen mesh, no rebuild.
  const applyScreenTextureRef = useRef<(url?: string | null) => void>(() => {})
  // And for the Done outro: the [outro] effect arms the snap-to-screen + power-on sequence.
  const applyOutroRef = useRef<(on: boolean) => void>(() => {})
  const applyActiveRef = useRef<(on: boolean) => void>(() => {})
  // LIVE landing/onboarding arc: the [stage] effect drives hero / app / welcome poses.
  const applyStageRef = useRef<(s: 'hero' | 'app' | 'welcome') => void>(() => {})

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
      // The export tool reads the canvas back with toDataURL; without this the buffer is cleared after
      // each present and the PNG comes out blank.
      preserveDrawingBuffer: exportMode,
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
      // Both caps press to the same deep travel so the click reads on either one.
      {
        w: 1.72,
        h: 1.62,
        r: 0.15,
        depth: 0.44,
        dx: 0,
        dy: 0,
        baseZ: 0.16,
        pressedZ: -0.03,
        pad: 0.09,
      },
      {
        // The right cap is the coin screen. Its emissive press flash is hidden under the opaque coin,
        // so the coin itself dims on press instead (see the loop); same deep travel as the left cap.
        w: 1.72,
        h: 1.62,
        r: 0.15,
        depth: 0.44,
        dx: 0,
        dy: 0,
        baseZ: 0.16,
        pressedZ: -0.03,
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

    // Physical (not Standard) so the transparent "Clear" skin can add clearcoat for that wet-acrylic
    // look without swapping the instance. It's a Standard subclass, so every later `as
    // MeshStandardMaterial` cast and `.color/.map/.roughness` write still applies; opaque skins keep
    // clearcoat at 0, which renders identically to the old Standard material.
    const matBody = new THREE.MeshPhysicalMaterial({
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
    const matBack = new THREE.MeshPhysicalMaterial({
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

    // Back + side dress: parting seam, gunmetal corner screws, speaker grille, vent, spec label, strap
    // eyelet. Fixed gunmetal hardware; seam + recesses are darker shades of the shell, recolored per
    // theme in applyTheme. Half-extents grow with the screen stretch, so place() re-seats on relayout.
    const matMetal = new THREE.MeshStandardMaterial({
      color: 0x5f636b,
      metalness: 0.85,
      roughness: 0.34,
    })
    const matSeam = new THREE.MeshStandardMaterial({
      color: 0x8c7f64,
      roughness: 0.7,
      metalness: 0,
      side: THREE.DoubleSide,
    })
    const matBackRecess = new THREE.MeshStandardMaterial({
      color: 0x282218,
      roughness: 0.9,
      metalness: 0,
      side: THREE.DoubleSide,
    })
    const BACK_HALF_W = (6.2 + 0.16) / 2
    const backHalfH = () => (11.95 + screenExt + 0.16) / 2
    const backDetails = createBackDetails(
      device,
      backPanel,
      { bodyW: 6.2, bodyH: 11.95, corner: deviceCfg.corner, seamZ: -0.72, bodyCx: wx(585) },
      { metal: matMetal, seam: matSeam, recess: matBackRecess, shell: matBack },
      '#7c7870',
    )
    backDetails.place(BACK_HALF_W, backHalfH(), backFaceLocalZ)
    backDetails.rebuildSeam(screenExt, wy(1130) + screenExt / 2)

    // Exposed guts for the transparent "Clear" skin: a packed PCB, copper coil, battery, ribbon and
    // glyph light strips sitting between the two shells. Built once and hidden; applyTheme reveals it
    // when a clear skin is on. Rides the body center so it tracks the screen-stretch like the body does.
    // Full guts (incl. the top-frame band) only in showcase contexts; the live game screen can grow up
    // into that band, so a played clear skin keeps just the always-safe bottom + side internals.
    const fullInternals = debug || customize || exportMode
    const internals = createInternals(device, '#e5322b', fullInternals)
    internals.group.position.set(wx(585), wy(1130) + screenExt / 2, 0)

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

    // Maker's mark below the back logo, seated once the rear face z is known (see makeLabel section).
    let backMarkPlane: THREE.Mesh | null = null

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
      // Maker's mark rides just proud of the rear face (faced toward -z, so this sits behind it).
      if (backMarkPlane) backMarkPlane.position.z = backFaceLocalZ - 0.01
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
      // the rear face moved (the no-bevel logo cut changes min.z), so re-seat the back dress with it
      backDetails.place(BACK_HALF_W, backHalfH(), backFaceLocalZ)
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

    // /export: paint a game-screen snapshot onto the mesh as an emissive map, so it glows like a powered
    // display regardless of scene lighting and spins with the body. The bare-device shot leaves it null
    // (matte off-screen). Disposes the prior texture so the ~1s snapshot refresh never leaks GPU memory.
    let screenTex: THREE.Texture | null = null
    let screenTexGen = 0 // supersedes in-flight async loads, so a later clear/snapshot always wins the race
    const screenTexLoader = new THREE.TextureLoader()
    const applyScreenTexture = (url?: string | null) => {
      const gen = ++screenTexGen
      if (!url) {
        matScreen.emissiveMap = null
        matScreen.emissive.setHex(0x000000)
        matScreen.needsUpdate = true
        screenTex?.dispose()
        screenTex = null
        dirty = true
        return
      }
      screenTexLoader.load(url, (tex) => {
        if (gen !== screenTexGen) {
          tex.dispose() // a newer apply (or a clear) landed while this decoded; drop this one
          return
        }
        tex.colorSpace = THREE.SRGBColorSpace
        tex.anisotropy = MAXANISO
        screenTex?.dispose()
        screenTex = tex
        matScreen.emissive.setHex(0xffffff)
        matScreen.emissiveMap = tex
        matScreen.emissiveIntensity = 1
        matScreen.needsUpdate = true
        screenMesh.visible = true
        dirty = true
      })
    }
    applyScreenTextureRef.current = applyScreenTexture
    applyScreenTexture(screenTexRef.current)

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
    // Customize + export both spin the device, so the overlays occlude properly instead of bleeding
    // through the body/knob from the side. Play view keeps them depth-test-free (front-on, no spin).
    const spinView = customize || exportMode
    const { dispose: disposeActionScreens, glow: actionGlow } =
      createActionScreens(device, bm, ACTION_IDX, buttons, BTN_PX, wx, wy, spinView)

    // The binding's color lights the screen (LONG → green, SHORT → red, …); a plain secondary cap
    // (PREV/NEXT/HOW TO/HISTORY, color 'neutral' or unset) lights at the theme's own action tone, so it
    // reads as a powered, themed screen instead of a dead grey one, matching the Customize preview.
    // The loop adds the press flash onto baseEmissive. Only the loud semantic states (win/loss/buy) get a
    // fixed hue here; everything else falls through to actionThemeColor below.
    // Pure-ish hues so the screen's own emissive glow keeps the color true instead of washing toward
    // white (a red with green/blue in it goes pink once it self-lights).
    const SCREEN_COLORS: Record<string, string> = {
      up: '#15db6e',
      down: '#ff2a20',
      amber: '#f7b417',
    }
    let actionThemeColor = '#3568c9'
    // What color a cap lights up in: the loud semantic states (win/loss/buy) get a fixed hue, a plain
    // secondary cap (or unset) idles at the theme's action tone. Token screens stay black.
    function actionHex(
      color: ButtonColor | undefined,
      display: ActionDisplay | undefined,
    ): string {
      if (display?.mode === 'token') return '#000000'
      return (color && SCREEN_COLORS[color]) || actionThemeColor
    }
    // Ink for the cap's label: near-black on a bright/light screen (amber, mint, Sui blue, greens),
    // white on a saturated/dark one, so PREV / HOW TO / CASH OUT stay legible whatever the theme paints
    // the cap. Perceived luminance; the emissive glow lifts mid tones, so the threshold leans bright.
    function actionInk(hex: string): string {
      const h = hex.replace('#', '')
      if (h.length !== 6) return '#ffffff'
      const r = parseInt(h.slice(0, 2), 16) / 255
      const g = parseInt(h.slice(2, 4), 16) / 255
      const b = parseInt(h.slice(4, 6), 16) / 255
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
      return lum > 0.58 ? '#0b0d12' : '#ffffff'
    }
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
        lbl: { recolor: (c: string) => void },
        color: ButtonColor | undefined,
        available: boolean,
        display: ActionDisplay | undefined,
      ) => {
        const hex = actionHex(color, display)
        if (display?.mode === 'token') {
          lightActionScreen(i, '#000000', 0)
          actionGlow[i].opacity = 0
        } else {
          lightActionScreen(i, hex, available ? 0.62 : 0.14)
        }
        // Flip the label ink for contrast against whatever the cap lit up in.
        lbl.recolor(actionInk(hex))
      }
      one(1, a1Lbl, state.a1Color, state.a1Available, state.a1Display)
      one(2, a2Lbl, state.a2Color, state.a2Available, state.a2Display)
      dirty = true
    }
    // Ambient light-show clock + a scratch color, used by the loop while state.lightShow is on.
    let lightT = 0
    const lightColor = new THREE.Color()
    // Result-blink clock: drives the slow breathing of any action button flagged to pulse.
    let pulseT = 0

    // The main button wears the first glyph of the PIPS wordmark, raised proud of the cap face (built
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
            g.fillStyle = col
            g.textAlign = 'center'
            // A label can ask for two lines with a newline (e.g. a long word like LEADER\nBOARD that
            // reads tiny on one line at the single-line size). Shrink the font so both lines fit the
            // face, stack them centered, and size the plane to the WIDEST line so it scales to the text
            // exactly like a single line does. Single-line labels keep the original path verbatim.
            const lines = text.split('\n')
            if (lines.length > 1) {
              const fs = Math.round(FS * 0.58)
              g.font = `700 ${fs}px -apple-system,"Segoe UI",system-ui,sans-serif`
              g.textBaseline = 'middle'
              const lh = fs * 1.06
              const top = H / 2 - (lh * (lines.length - 1)) / 2
              lines.forEach((ln, i) => g.fillText(ln, W / 2, top + i * lh))
              const widest = Math.max(...lines.map((l) => g.measureText(l).width))
              const tw = Math.min(W, widest + 36)
              tex.repeat.x = tw / W
              tex.offset.x = (1 - tw / W) / 2
              plane.scale.set(worldH * (tw / H), worldH, 1)
            } else {
              g.font = `700 ${FS}px -apple-system,"Segoe UI",system-ui,sans-serif`
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
          }
          tex.needsUpdate = true
        }
        mat.opacity = text ? opacity : 0
      }
      // Repaint the current text in a new ink (same text/opacity), so a lit cap can flip its label
      // to dark/white for contrast without the caller re-passing the text.
      function recolor(color2: string) {
        if (color2 !== curColor) set(cur === '\0' ? '' : cur, mat.opacity, color2)
      }
      set('', 0)
      return { plane, set, mat, recolor }
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

    // Landing attract text, rendered as a real plane on the screen (not a flat HTML overlay) so it
    // tilts + floats WITH the handheld in the hero pose instead of detaching when the device angles.
    // Centered vertically on the screen aperture; the loop blinks it and shows it only on the hero stage.
    const screenCenterY = () => {
      let lo = Infinity,
        hi = -Infinity
      for (const v of screenWorld) {
        if (v.y < lo) lo = v.y
        if (v.y > hi) hi = v.y
      }
      return (lo + hi) / 2
    }
    // CRT attract label: a gold bloom halo, chromatic split, a warm gold phosphor core, and scanlines
    // baked into the texture, plus a soft gold glow plane behind it. A real plane on the device (not
    // HTML), so it tilts + floats with the handheld. The loop blinks + flickers it. It composites over
    // the HTML black screen backing; the recessed 3D screen panel stays hidden so it can't peek while
    // the device floats on the landing.
    const pressStart = (() => {
      const text = 'PRESS START'
      const FS = 150
      const PAD = 130 // room for the bloom halo so the blur never clips at the plane edge
      const c = document.createElement('canvas')
      const g = c.getContext('2d')!
      const font = `800 ${FS}px -apple-system,"Segoe UI",system-ui,sans-serif`
      g.font = font
      const tw = Math.ceil(g.measureText(text).width)
      c.width = tw + PAD * 2
      c.height = FS + PAD * 2
      const X = c.width / 2,
        Y = c.height / 2
      g.font = font
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      // 1) Bloom: a couple of tight blurred gold passes for a restrained halo around the glyphs. No white.
      g.save()
      g.shadowColor = '#ff9d12'
      for (const [blur, alpha] of [
        [26, 0.3],
        [12, 0.6],
        [6, 0.9],
      ] as const) {
        g.shadowBlur = blur
        g.globalAlpha = alpha
        g.fillStyle = '#ffa820'
        g.fillText(text, X, Y)
      }
      g.restore()
      // 2) Chromatic aberration: faint red/cyan ghosts split left/right, added on.
      g.globalCompositeOperation = 'lighter'
      g.globalAlpha = 0.4
      g.fillStyle = '#ff2a00'
      g.fillText(text, X - 4, Y)
      g.fillStyle = '#00a6ff'
      g.fillText(text, X + 4, Y)
      // 3) Solid gold body, then a brighter-gold core (still yellow, no white blow-out).
      g.globalCompositeOperation = 'source-over'
      g.globalAlpha = 1
      g.fillStyle = '#ffa820'
      g.fillText(text, X, Y)
      g.globalCompositeOperation = 'lighter'
      g.globalAlpha = 0.55
      g.fillStyle = '#ffc257'
      g.fillText(text, X, Y)
      // 4) Scanlines, confined to the lit pixels (source-atop only paints over existing content).
      g.globalCompositeOperation = 'source-atop'
      g.globalAlpha = 1
      g.fillStyle = 'rgba(0,0,0,0.32)'
      for (let y = 0; y < c.height; y += 3) g.fillRect(0, y, c.width, 1.5)
      g.globalCompositeOperation = 'source-over'

      const tex = new THREE.CanvasTexture(c)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = MAXANISO
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
      })
      // Core glyph height in world units; the padded canvas pushes the bloom halo out past it.
      const coreWorld = 0.4
      const worldH = (coreWorld * c.height) / FS
      const textW = (worldH * c.width) / c.height
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(textW, worldH), mat)
      plane.position.set(0, screenCenterY(), 0.06)
      plane.renderOrder = 12
      plane.visible = false
      device.add(plane)

      // Soft gold glow behind the text: a radial that bleeds a little bloom over the black screen.
      const GS = 256
      const gc = document.createElement('canvas')
      gc.width = gc.height = GS
      const gg = gc.getContext('2d')!
      const grad = gg.createRadialGradient(GS / 2, GS / 2, 0, GS / 2, GS / 2, GS / 2)
      grad.addColorStop(0, 'rgba(255,158,26,0.55)')
      grad.addColorStop(0.3, 'rgba(255,146,12,0.22)')
      grad.addColorStop(1, 'rgba(255,138,0,0)')
      gg.fillStyle = grad
      gg.fillRect(0, 0, GS, GS)
      const glowTex = new THREE.CanvasTexture(gc)
      glowTex.colorSpace = THREE.SRGBColorSpace
      const glowMat = new THREE.MeshBasicMaterial({
        map: glowTex,
        transparent: true,
        depthWrite: false,
      })
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glowMat)
      glow.scale.set(textW * 1.05, worldH * 1.7, 1)
      glow.position.set(0, screenCenterY(), 0.045)
      glow.renderOrder = 11
      glow.visible = false
      device.add(glow)

      return { plane, mat, glow, glowMat }
    })()
    const pressStartMat = pressStart.mat
    let pressBlinkT = 0

    // Maker's mark on the back panel, centered below the embossed logo. Parented to the panel so it
    // tracks the screen stretch, faced toward -z so it reads when the device is flipped. Tinted to the
    // theme's label color (recolored by applyTheme). placeLogoCarve seats its z on the rear face.
    const backMark = (() => {
      const c = document.createElement('canvas'),
        g = c.getContext('2d')!
      const text = 'By PIVY Inc.'
      drawLabel(c, g, text, '#7c7870')
      const tex = new THREE.CanvasTexture(c)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = MAXANISO
      const worldH = 0.34
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(worldH * (c.width / c.height), worldH),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
      )
      plane.rotation.y = Math.PI // face the rear so it reads when flipped
      plane.position.set(0, -(logoH / 2 + 0.42), backFaceLocalZ - 0.01)
      backPanel.add(plane)
      backMarkPlane = plane
      return {
        recolor: (col: string) => {
          drawLabel(c, g, text, col)
          tex.needsUpdate = true
          dirty = true
        },
      }
    })()

    // Live labels: action1 / action2 on their faces. The main button wears the embossed PIPS glyph
    // instead of a text label (carved once the logo SVG loads, see buildMainGlyph).
    // Sits on the screen face under the acrylic. Kept small so even a 6-char label clears the bezel
    // window (the label draws depth-test-free, so it must not overrun the metal frame).
    // In the spin views the labels occlude properly (depthTest on) instead of bleeding through the
    // body/knob from the side.
    const a1Lbl = makeDynLabel(0.36, '#ffffff', false, spinView)
    a1Lbl.plane.position.set(0, 0, 0.02)
    bm[1].add(a1Lbl.plane)
    const a2Lbl = makeDynLabel(0.36, '#ffffff', false, spinView)
    a2Lbl.plane.position.set(0, 0, 0.02)
    bm[2].add(a2Lbl.plane)

    // Token mode is opt-in per action button. A token-mode screen runs a live low-res coin flip on
    // true black; normal buttons keep the standard colored CRT label treatment.
    const COIN_LORES = 72
    // 4x4 Bayer bias for the dither, normalized to ~[-0.5, 0.5).
    const COIN_BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(
      (v) => (v + 0.5) / 16 - 0.5,
    )

    function createTokenScreen(buttonIndex: 1 | 2) {
      const coinCanvas = document.createElement('canvas')
      coinCanvas.width = coinCanvas.height = COIN_LORES
      const coinCtx = coinCanvas.getContext('2d', {
        willReadFrequently: true,
      })!
      const coinTex = new THREE.CanvasTexture(coinCanvas)
      coinTex.colorSpace = THREE.SRGBColorSpace
      coinTex.magFilter = THREE.NearestFilter
      coinTex.minFilter = THREE.NearestFilter
      coinTex.generateMipmaps = false

      const geo = new THREE.PlaneGeometry(1, 1)
      const mat = new THREE.MeshBasicMaterial({
        map: coinTex,
        transparent: true,
        depthWrite: false,
        depthTest: true,
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.renderOrder = 8
      const fit =
        Math.max(buttons[buttonIndex].w, buttons[buttonIndex].h) +
        buttons[buttonIndex].pad * 2 -
        0.2
      mesh.scale.set(fit, fit, 1)
      mesh.position.set(0, 0, 0.012)
      mesh.visible = false
      bm[buttonIndex].add(mesh)

      let display: Extract<ActionDisplay, { mode: 'token' }> | null = null
      let coinAngle = 0
      let image: HTMLImageElement | null = null
      let loadedLogoSrc: string | undefined

      function setDisplay(next: ActionDisplay | undefined) {
        display = next?.mode === 'token' ? next : null
        mesh.visible = !!display
        if (!display) return

        if (display.logoSrc !== loadedLogoSrc) {
          loadedLogoSrc = display.logoSrc
          image = null
          if (display.logoSrc) {
            const requestedSrc = display.logoSrc
            const nextImage = new Image()
            nextImage.onload = () => {
              if (loadedLogoSrc !== requestedSrc) return
              image = nextImage
              draw(0)
              dirty = true
            }
            nextImage.src = requestedSrc
          }
        }
        draw(0)
      }

      function draw(dtSec: number) {
        if (!display) return
        coinAngle += (dtSec / 4.6) * Math.PI * 2
        const W = COIN_LORES
        const H = COIN_LORES
        const cx = W / 2
        const cy = H / 2
        const diameter = Math.min(W, H) * 0.7
        const radius = diameter / 2

        coinCtx.fillStyle = '#000'
        coinCtx.fillRect(0, 0, W, H)
        const sx = Math.max(Math.abs(Math.cos(coinAngle)), 0.001)
        coinCtx.save()
        coinCtx.translate(cx, cy)
        coinCtx.scale(sx, 1)
        if (image) {
          coinCtx.drawImage(
            image,
            -diameter / 2,
            -diameter / 2,
            diameter,
            diameter,
          )
        } else {
          const gradient = coinCtx.createRadialGradient(
            -radius * 0.3,
            -radius * 0.35,
            radius * 0.08,
            0,
            0,
            radius,
          )
          gradient.addColorStop(0, '#ffd66b')
          gradient.addColorStop(0.55, '#d68a12')
          gradient.addColorStop(1, '#5c3500')
          coinCtx.fillStyle = gradient
          coinCtx.beginPath()
          coinCtx.arc(0, 0, radius, 0, Math.PI * 2)
          coinCtx.fill()
          coinCtx.fillStyle = '#2a1800'
          coinCtx.font = `900 ${Math.round(radius * (display.ticker.length > 3 ? 0.52 : 0.72))}px ui-sans-serif, system-ui, sans-serif`
          coinCtx.textAlign = 'center'
          coinCtx.textBaseline = 'middle'
          coinCtx.fillText(display.ticker, 0, radius * 0.04)
        }
        coinCtx.restore()

        const edge = Math.pow(1 - sx, 2.2)
        if (edge > 0.02) {
          coinCtx.save()
          coinCtx.globalAlpha = Math.min(edge, 1) * 0.9
          coinCtx.fillStyle = '#ffd98a'
          const edgeWidth = Math.max(W * 0.018, 1)
          coinCtx.fillRect(
            cx - edgeWidth / 2,
            cy - diameter / 2,
            edgeWidth,
            diameter,
          )
          coinCtx.restore()
        }

        const buffer = coinCtx.getImageData(0, 0, W, H)
        const pixels = buffer.data
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const pixelIndex = (y * W + x) * 4
            let brightness =
              1 + COIN_BAYER[(y & 3) * 4 + (x & 3)] * 0.3
            if (y % 2 === 1) brightness *= 0.62
            pixels[pixelIndex] = Math.min(
              255,
              pixels[pixelIndex] * brightness,
            )
            pixels[pixelIndex + 1] = Math.min(
              255,
              pixels[pixelIndex + 1] * brightness,
            )
            pixels[pixelIndex + 2] = Math.min(
              255,
              pixels[pixelIndex + 2] * brightness,
            )
          }
        }
        coinCtx.putImageData(buffer, 0, 0)
        coinTex.needsUpdate = true
      }

      return {
        buttonIndex,
        mat,
        mesh,
        setDisplay,
        draw,
        isActive: () => !!display,
        dispose: () => {
          coinTex.dispose()
          mat.dispose()
          geo.dispose()
        },
      }
    }

    const tokenScreens = [
      createTokenScreen(1),
      createTokenScreen(2),
    ] as const

    const NUMBER_LABEL_ANGLE = 1.02
    const NUMBER_LABEL_RADIUS = 0.4
    const MAX_NUMBER_WHEEL_LABELS = 5
    const numberWheelLabels = Array.from(
      { length: MAX_NUMBER_WHEEL_LABELS },
      () => {
        // Keep the digits above the drum instead of depth-fighting into its black surface. In the spin
        // views (customize/export) they opt into real occlusion so they don't bleed through the flipped
        // back panel; the front games view keeps them depth-test-free, exactly as before.
        const label = makeDynLabel(0.46, '#ffffff', true, spinView)
        numberWheelRoll.add(label.plane)
        return { ...label, angle: 0, active: false }
      },
    )
    let numberWheelAngle = 0
    let numberWheelTarget = 0
    let numberWheelInitialized = false
    let debugNumberValue = 1
    const idleStakes = [1, 5, 10, 25, 50, 100]
    // The home wheel shares one persisted stake with the games (same ladder), so the value the user
    // leaves it on stays put across navigation instead of resetting to a sample.
    const STAKE_KEY = 'pips_stake_idx'
    const readStakeIdx = () => {
      try {
        const raw = window.localStorage.getItem(STAKE_KEY)
        const n = raw == null ? 2 : Math.round(JSON.parse(raw))
        return Number.isFinite(n) ? Math.max(0, Math.min(idleStakes.length - 1, n)) : 2
      } catch {
        return 2
      }
    }
    let idleNumberValue = readStakeIdx()
    const debugNumberWheel = {
      min: 0,
      max: 9,
      step: 1,
      value: debugNumberValue,
      label: 'DUSDC',
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
      label: 'DUSDC',
      format: (value: number) => `$${idleStakes[value]}`,
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
      a1Display: undefined as ActionDisplay | undefined,
      a2Display: undefined as ActionDisplay | undefined,
      a1Pulse: false,
      a2Pulse: false,
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
      state.a1Display = a1?.display
      a1Lbl.set(a1?.label ?? '', state.a1Available ? 1 : 0.34)
      state.a2Available = !!a2
      state.a2Color = a2?.color
      state.a2Display = a2?.display
      a2Lbl.set(a2?.label ?? '', state.a2Available ? 1 : 0.34)
      // Restart the blink clock from dim when a pulse first arms, so the win/lose CONTINUE eases up
      // from dark instead of snapping to a random phase.
      const pulsingNow = !!a1?.pulse || !!a2?.pulse
      if (pulsingNow && !state.a1Pulse && !state.a2Pulse) pulseT = 0
      state.a1Pulse = !!a1?.pulse
      state.a2Pulse = !!a2?.pulse
      tokenScreens[0].setDisplay(state.a1Display)
      tokenScreens[1].setDisplay(state.a2Display)
      state.lightShow = !!v?.lightShow
      // When the show ends, relight settles the screens back to their idle / bound color; while it runs
      // the loop owns their color, so this is just the baseline it animates away from.
      relightActionScreens()
      const k = v?.knob ?? null
      state.knob = k
      state.knobAvailable = !!k
      state.numberWheelBound = !!v?.numberWheel
      // Falling back to the home wheel: pick up any stake the game just set, so home shows it too.
      if (!v?.numberWheel && !debug && !customize) idleNumberValue = readStakeIdx()
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
      // Transparent "Clear" skin. FRONT shell is real frosted acrylic via transmission (not a flat alpha
      // film, which just looked like a white overlay): the guts behind read as diffused frosted plastic
      // under a glossy clearcoat skin. The smoke tint rides the attenuation so the transmitted internals
      // keep their color. Non-clear skins reset every prop back to the molded look.
      const clear = !!t.clear
      matBody.transparent = clear
      matBody.transmission = clear ? 1 : 0
      matBody.opacity = 1
      matBody.roughness = clear ? 0.28 : 0.82 // the frost: light enough to still read the guts
      matBody.thickness = clear ? 0.5 : 0
      matBody.ior = clear ? 1.47 : 1.5
      matBody.clearcoat = clear ? 1 : 0
      matBody.clearcoatRoughness = clear ? 0.18 : 0
      matBody.attenuationColor.set(clear ? '#cdd4db' : '#ffffff') // smoke, not milk
      matBody.attenuationDistance = clear ? 1.8 : Infinity
      matBody.needsUpdate = true
      // BACK shell: solid white frosted plastic (the white edition) so the back stays clean and easy to
      // read, and doubles as a bright backplate the guts read against from the front.
      matBack.transmission = 0
      matBack.transparent = false
      matBack.opacity = 1
      matBack.roughness = clear ? 0.55 : 0.88
      matBack.clearcoat = clear ? 0.5 : 0
      matBack.clearcoatRoughness = clear ? 0.25 : 0
      matBack.needsUpdate = true
      internals.group.visible = clear
      // Body color is the flat skin and the pre-load tint; setBodySkin overlays the SVG when present.
      // Clear keeps it near-white so transmission shows the guts true (the tint is the attenuation).
      matBody.color.set(clear ? 0xffffff : t.body)
      pendingSkinUrl = t.skin ?? null
      setBodySkin(t.skin)
      matBack.color.set(t.back ?? t.body)
      matKnob.color.set(t.knob)
      matKnobSlab.color.set(t.knob)
      // Back dress: the seam is a darker shade of the shell, the recesses (grille/vent/screw cups)
      // darker still, so they read as molded-in on every skin. Gunmetal hardware stays fixed.
      matSeam.color.set(t.body).multiplyScalar(0.5)
      matBackRecess.color.set(t.back ?? t.body).multiplyScalar(0.32)
      backDetails.recolorInk(t.label ?? '#7c7870')
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
      backMark.recolor(labelColor)
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
      // the panel grew taller: re-hug the corner screws + strap to the new edges, regrow the seam
      backDetails.place(BACK_HALF_W, backHalfH(), backFaceLocalZ)
      backDetails.rebuildSeam(screenExt, wy(1130) + screenExt / 2)
      internals.group.position.y = wy(1130) + screenExt / 2 // guts ride the body center
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
      const sc = screenCenterY()
      pressStart.plane.position.y = sc
      pressStart.glow.position.y = sc
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
    const clamp01 = (t: number) => Math.max(0, Math.min(1, t))

    // ===== LIVE landing/onboarding arc (customize/debug/export keep their own camera paths) =====
    // resize() captures the resting games pose here so the loop can re-derive it each frame and blend
    // the hero/welcome offsets onto it. At heroT=0/welcomeT=0 the blend reproduces the rest pose
    // bit-for-bit, so the settle from hero lands exactly where the games view sits (seamless).
    const restCamPos = new THREE.Vector3()
    const restLook = new THREE.Vector3()
    let viewW = 0
    let viewH = 0
    // Hero product-shot offset, relative to rest: pulled well back so the device floats smaller, and
    // raised in frame (negative dLookY lifts it) so its controls clear the landing copy band below.
    // A gentle 3/4 tilt gives it the product-shot feel.
    const HERO = { dz: 13, dLookY: -1.6, yaw: -0.11, pitch: -0.05 }
    const HERO_MS = 900
    const WELCOME_IN_MS = 880
    const WELCOME_OUT_MS = 680
    // Entrance flourish while zooming in: the deck turns out and squares back to front-on. The screen
    // is black through the zoom (content reveals only once squared up), so the turn reads on the body
    // and never skews the splash. Yaw is the headline move; a touch of pitch gives it some lift.
    const WELCOME_SPIN = 0.45
    const WELCOME_PITCH = -0.05
    // Fraction of the resting camera distance at the held splash (lower = closer = bigger screen). The
    // games pose already fits the device to the frame, so the welcome has to push PAST it to read as a
    // zoom at all; this dollies in ~30% and recenters on the screen so the splash fills the frame.
    const WELCOME_ZOOM = 0.7
    let liveStage: 'hero' | 'app' | 'welcome' = stage
    let heroT = stage === 'hero' ? 1 : 0
    let welcomeT = 0
    let welcomePhase: 'in' | 'hold' | 'out' | 'idle' = 'idle'
    let welcomeFired = false
    let welcomeArrivedFired = false
    let liveFloatPhase = 0

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
      let lookY: number, camZ: number
      let yaw: number, pitch: number
      if (introFromApp) {
        // Intro starts at the exact games/app pose (same cy/d math as the Done outro target and the
        // resize handler) so it hands off seamlessly from the live device, then eases out to the studio
        // rest pose. Reads as the one handheld zooming back out into the workshop.
        const tanHalf = Math.tan((camera.fov * Math.PI) / 180 / 2)
        const aspect = Math.max(camera.aspect, 0.0001)
        const ext = responsiveScreenExt()
        const appCy = wy(1130) + ext / 2
        const appZ = (ext > 0 ? (6.2 * 0.5) / (tanHalf * aspect) : (11.95 * 0.5) / tanHalf) + DEVICE_Z
        lookY = lerp(appCy, CUST.lookY[1], e)
        camZ = lerp(appZ, CUST.camZ[1] * custCam.zoom, e)
        yaw = lerp(0, CUST.yaw[1], e) + orbitYaw * e
        pitch = lerp(0, CUST.pitch[1], e) + orbitPitch * e
      } else {
        lookY = lerp(CUST.lookY[0], CUST.lookY[1], e)
        camZ = lerp(CUST.camZ[0], CUST.camZ[1], e) * custCam.zoom
        yaw = lerp(CUST.yaw[0], CUST.yaw[1], e) + orbitYaw * e
        pitch = lerp(CUST.pitch[0], CUST.pitch[1], e) + orbitPitch * e
      }
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

    // Export tool: a dead front-on frame at slider zero, with the device pose driven purely by the
    // x/y sliders. No float, no orbit, no intro. x = pitch, y = yaw, applied to the deck pivot so the
    // back panel reads when spun. Camera frames the device full-height like the games view does.
    function placeExportCamera() {
      const tanHalf = Math.tan((camera.fov * Math.PI) / 180 / 2)
      const aspect = Math.max(camera.aspect, 0.0001)
      const ext = responsiveScreenExt()
      const cy = wy(1130) + ext / 2
      // 1.25 pulls the camera back so the device sits smaller in frame with breathing room around it.
      const frontZ =
        (ext > 0
          ? (6.2 * 0.5) / (tanHalf * aspect)
          : (11.95 * 0.5) / tanHalf) * 1.25 + DEVICE_Z
      camera.position.set(0, cy, frontZ)
      camera.lookAt(0, cy, 0)
      device.position.y = 0
      device.rotation.set(0, 0, 0)
      const er = exportRotRef.current
      deck.rotation.set(er?.x ?? 0, er?.y ?? 0, 0)
      // Keep the solid back on so the embossed back panel reads once the device is spun around.
      backPanel.visible = true
    }

    // Project the device's L-shaped screen cutout to CSS px and glue the HTML screen layer onto it.
    // Extracted from resize() so the LIVE arc can re-run it every animating frame (the camera moves).
    // We project the cutout's LIVE world position (device float bob/tilt + deck rotation), not the rest
    // pose, so the screen content stays glued to the device as it drifts on the landing. screenWorld
    // bakes in DEVICE_Z, so strip that back to device-local and re-apply the current world matrix.
    const screenScratch = new THREE.Vector3()
    function projectScreenLayer() {
      const el = screenLayerRef.current
      if (!el || viewW === 0 || viewH === 0) return
      device.updateWorldMatrix(true, false)
      const M = 4
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity
      let notchTopY = Infinity
      screenWorld.forEach((v, i) => {
        const n = screenScratch
          .set(v.x, v.y, v.z - DEVICE_Z)
          .applyMatrix4(device.matrixWorld)
          .project(camera)
        const x = (n.x * 0.5 + 0.5) * viewW
        const y = (-n.y * 0.5 + 0.5) * viewH
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        if ((i === 2 || i === 3) && y < notchTopY) notchTopY = y
      })
      el.style.left = `${minX - M}px`
      el.style.top = `${minY - M}px`
      el.style.width = `${maxX - minX + M * 2}px`
      el.style.height = `${maxY - minY + M * 2}px`
      const scale = (maxX - minX) / (wx(1140) - wx(30))
      el.style.setProperty('--screen-rim', `${Math.max(16, Math.round(M + 0.33 * scale))}px`)
      el.style.setProperty('--screen-notch', `${Math.max(0, Math.round(maxY + M - notchTopY))}px`)
    }

    // The single place the LIVE camera is written: blend the hero offset and the welcome into-screen
    // push onto the captured resting pose, then re-glue the screen layer. heroT=0/welcomeT=0 == rest.
    function placeLiveCamera() {
      const he = easeOutExpo(heroT)
      const we = easeInOutCubic(welcomeT)
      const camZ = restCamPos.z + HERO.dz * he
      const lookY = restLook.y + HERO.dLookY * he
      const yaw = HERO.yaw * he
      const pitch = HERO.pitch * he
      // Welcome splash target: dolly toward the SCREEN (closer than rest + recentered on the screen,
      // not the whole device) so the splash grows to fill the frame, the customize hand-off feel. The
      // games pose already fits the device edge-to-edge, so the zoom has to push past it to read.
      const welcomeZ = (restCamPos.z - DEVICE_Z) * WELCOME_ZOOM + DEVICE_Z
      const welcomeLookY = screenCenterY()
      // Turn flourish, IN only: 0 at the start, peaks mid-zoom, back to 0 as it squares up front-on.
      // Off during the hold/out so the splash sits square and the zoom-out stays aligned. The screen
      // is black through the zoom (content reveals only on arrival), so the turn never skews it.
      const spin = welcomePhase === 'in' ? Math.sin(clamp01(welcomeT) * Math.PI) : 0
      camera.position.set(0, lerp(lookY, welcomeLookY, we), lerp(camZ, welcomeZ, we))
      camera.lookAt(0, lerp(lookY, welcomeLookY, we), 0)
      deck.rotation.set(
        lerp(pitch, 0, we) + spin * WELCOME_PITCH,
        lerp(yaw, 0, we) + spin * WELCOME_SPIN,
        0,
      )
      camera.updateMatrixWorld()
      projectScreenLayer()
    }

    function snapLivePose(s: 'hero' | 'app' | 'welcome') {
      heroT = s === 'hero' ? 1 : 0
      welcomeT = s === 'welcome' ? 1 : 0
      welcomePhase = 'idle'
      device.position.y = 0
      device.rotation.set(0, 0, 0)
      placeLiveCamera()
      dirty = true
    }

    applyStageRef.current = (s: 'hero' | 'app' | 'welcome') => {
      if (customize || exportMode || debug) return // the arc is the LIVE shell only
      liveStage = s
      if (s === 'welcome') {
        // Zoom in (with the turn flourish) and HOLD. No auto-advance: the app dismisses it by
        // switching stage back to 'app', which plays the zoom-out below.
        heroT = 0
        welcomeFired = false
        welcomeArrivedFired = false
        if (reducedMotionRef.current) {
          // Snap straight to the filled splash and report arrival; the return is the same instant snap.
          snapLivePose('welcome')
          welcomePhase = 'hold'
          welcomeArrivedFired = true
          propsRef.current.onWelcomeArrived?.()
        } else {
          welcomePhase = 'in'
          welcomeT = 0
        }
      } else if (
        s === 'app' &&
        (welcomePhase === 'in' || welcomePhase === 'hold' || welcomeT > 0.001)
      ) {
        // Dismissing a showing welcome splash: zoom back out, then report completion (loop, or
        // instantly under reduced motion).
        if (reducedMotionRef.current) {
          welcomePhase = 'idle'
          welcomeT = 0
          snapLivePose('app')
          if (!welcomeFired) {
            welcomeFired = true
            propsRef.current.onWelcomeComplete?.()
          }
        } else {
          welcomePhase = 'out'
        }
      } else {
        // hero / app with no welcome showing: cancel any welcome and ease heroT (or snap if reduced).
        welcomePhase = 'idle'
        welcomeT = 0
        welcomeFired = false
        welcomeArrivedFired = false
        if (reducedMotionRef.current || instantRef.current) snapLivePose(s)
      }
      dirty = true
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

    /* GUI — the full dev tuning panel, only on the /console playground (debug). No end-user surface shows it. */
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
      : null
    applyActiveRef.current = () => {
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
      unlockAudio() // unlock the synth bus (bed/stings) on the same gesture; mobile Safari needs it
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
      if (!obj) {
        // No device control under the tap. The WebGL canvas sits on top of the HTML screen layer and
        // swallows the tap, so a text field on the screen (the onboarding handle) can't be selected and
        // the mobile keyboard never opens. Forward a tap that lands on the screen to its input: doing it
        // here, inside the real gesture, is what lets the keyboard come up. No-op on screens with no field.
        const layer = screenLayerRef.current
        if (layer && !exportMode && !debug) {
          const r = layer.getBoundingClientRect()
          if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
            const field = layer.querySelector<HTMLElement>(
              '[data-visible="true"] input, [data-visible="true"] textarea',
            )
            if (field) {
              // Stop the native mousedown default from moving focus to the (unfocusable) canvas, which
              // would immediately blur the field we just focused.
              e.preventDefault()
              field.focus()
            }
          }
        }
        return
      }
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
      // On the landing the device is a hero shot, not signed in: the MENU/HOME tabs lead nowhere, so
      // they stay fully inert (no press, no sound, no nav). They wake up once you're in the app.
      if ((bi === 3 || bi === 4) && liveStage === 'hero') return
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
            audio.playSfx('roller', 'thumbwheel')
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
                try {
                  window.localStorage.setItem(STAKE_KEY, JSON.stringify(next))
                } catch {
                  // storage blocked, keep the in-memory value
                }
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

    // Keyboard = a physical tap of a button: same press travel, glow, sound, and dispatch as a click.
    // bi 0 = main, 1 = left action, 2 = right action. Self-contained (no pointer capture), it sinks
    // the cap, fires the handler, then schedules the release like a real press.
    function keyTap(bi: number) {
      const btn = bm[bi]
      if (!btn) return
      btn.userData.pressed = true
      btn.userData.pressedAt = performance.now()
      btn.userData.glow = Math.max(btn.userData.glow, 0.001)
      const channel = bi === 0 ? 'main' : bi === 1 ? 'action1' : 'action2'
      audio.playSfx(bi === 0 ? 'mainPress' : 'actionPress', channel)
      dispatch(bi)
      const t = setTimeout(() => {
        audio.playSfx(bi === 0 ? 'mainRelease' : 'actionRelease', channel)
        btn.userData.pressed = false
      }, MIN_PRESS_MS)
      pressTimers.push(t)
      dirty = true
    }

    const onKeyDown = (e: KeyboardEvent) => {
      // Map the keyboard to the physical buttons: Enter = main, ArrowLeft/Right = the two action caps.
      const bi =
        e.key === 'Enter' ? 0 : e.key === 'ArrowLeft' ? 1 : e.key === 'ArrowRight' ? 2 : -1
      // Only on the live games device, only when that button is actually bound, and never on
      // key-repeat (hold shouldn't machine-gun the button).
      if (bi < 0 || e.repeat || customize || debug) return
      if (liveStage !== 'app') return
      const available =
        bi === 0 ? state.mainAvailable : bi === 1 ? state.a1Available : state.a2Available
      if (!available) return
      if (!screenContentVisibleRef.current) return // customize studio owns the device
      // Stay out of the way of real keyboard use: typing, focused controls, or an open drawer/modal
      // (the menu drawer renders role="dialog") that owns the keyboard.
      if (document.querySelector('[role="dialog"]')) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(t.tagName)))
        return
      e.preventDefault()
      keyTap(bi)
    }

    // Mobile keyboard: focus an on-screen text field (the onboarding handle) on touchstart, with
    // preventDefault. The canvas sits over the HTML screen layer, so a tap lands here, not on the field;
    // pointerdown already forwards focus, but on touch the trailing compatibility click re-targets the
    // unfocusable canvas and blurs the field, snapping the just-opened keyboard shut (the "keyboard
    // flashes then hides" bug). Calling preventDefault on touchstart kills that compat click, so focus
    // sticks and the keyboard stays up. Scoped to the field's own padded rect so the knob + PLAY (which
    // fall inside the screen's bounding box but well below the field) keep their normal press flow.
    const onScreenTouchStart = (e: TouchEvent) => {
      if (customize || exportMode || debug) return
      const layer = screenLayerRef.current
      if (!layer) return
      const field = layer.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        '[data-visible="true"] input, [data-visible="true"] textarea',
      )
      if (!field) return
      const t = e.touches[0]
      if (!t) return
      const r = field.getBoundingClientRect()
      const padX = 28,
        padY = 22
      if (
        t.clientX >= r.left - padX &&
        t.clientX <= r.right + padX &&
        t.clientY >= r.top - padY &&
        t.clientY <= r.bottom + padY
      ) {
        e.preventDefault()
        if (document.activeElement !== field) field.focus()
      }
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('touchstart', onScreenTouchStart, { passive: false })
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    window.addEventListener('keydown', onKeyDown)
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
      viewW = w
      viewH = h
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
        // contain-by-height, so the device gaps at the sides but is never cropped. The resting pose is
        // captured (not applied) here; placeLiveCamera() applies it plus any hero/welcome blend.
        const visibleH = 6.2 / camera.aspect // world height when the device width is fit edge to edge
        const ext = Math.max(0, Math.round((visibleH - 11.95) * 100) / 100)
        relayout(ext)
        const cy = wy(1130) + ext / 2 // device center after the top extension
        const d =
          ext > 0
            ? (6.2 * 0.5) / (tanHalf * camera.aspect) // fill width
            : (11.95 * 0.5) / tanHalf // contain by height (wider frame)
        restCamPos.set(0, cy, d + DEVICE_Z)
        restLook.set(0, cy, 0)
      }
      camera.updateProjectionMatrix()

      // Screen content sits behind the device; the body's hole masks it to the L-shape and the beveled
      // rim frames it. The debug playground sets its camera inline (no arc); the live shell applies the
      // resting pose + arc blend via placeLiveCamera(). Both then glue the HTML screen layer onto the
      // projected cutout (placeLiveCamera does it; debug calls projectScreenLayer directly).
      if (debug) {
        camera.updateMatrixWorld()
        projectScreenLayer()
      } else {
        placeLiveCamera()
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
    let coinAccum = 0
    let decorAccum = 0
    const COIN_FRAME = 1 / 30 // chunky pixels don't need 60fps; keeps the idle device cheap
    const DECOR_FRAME = 1 / 30 // ambient light show / result pulse: 30fps is plenty, halves the GPU tax

    function loop() {
      rafId = requestAnimationFrame(loop)
      const dt = Math.min(clock.getDelta(), 0.05)
      let animating = false

      if (customize) {
        if (exportMode) {
          // No float, no orbit. The pose is whatever the sliders say; render every frame so a slider
          // drag updates live and the preserved buffer is always current for capture.
          placeExportCamera()
          renderer.shadowMap.needsUpdate = true
          renderer.render(scene, camera)
          return
        }
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
      } else if (!debug) {
        // LIVE landing/onboarding arc: ease hero<->app, run the welcome push, idle-float at hero.
        // Render-on-demand otherwise (a settled app device paints nothing).
        const reduced = reducedMotionRef.current
        const heroTarget = liveStage === 'hero' ? 1 : 0
        if (!reduced && !instantRef.current && Math.abs(heroT - heroTarget) > 0.0005) {
          const dir = Math.sign(heroTarget - heroT)
          heroT = clamp01(heroT + (dir * (dt * 1000)) / HERO_MS)
          animating = true
        } else {
          heroT = heroTarget
        }
        if (!reduced) {
          if (welcomePhase === 'in') {
            welcomeT = Math.min(1, welcomeT + (dt * 1000) / WELCOME_IN_MS)
            animating = true
            if (welcomeT >= 1) {
              // Squared up + filled: hold here (no timer) and tell the app to reveal the splash.
              welcomePhase = 'hold'
              if (!welcomeArrivedFired) {
                welcomeArrivedFired = true
                propsRef.current.onWelcomeArrived?.()
              }
            }
          } else if (welcomePhase === 'out') {
            welcomeT = Math.max(0, welcomeT - (dt * 1000) / WELCOME_OUT_MS)
            animating = true
            if (welcomeT <= 0) {
              welcomePhase = 'idle'
              if (!welcomeFired) {
                welcomeFired = true
                propsRef.current.onWelcomeComplete?.()
              }
            }
          }
          // 'hold' just waits: the app plays the zoom-out by switching stage back to 'app'.
        }
        // Idle float: alive at hero, fades to nothing at app and during the welcome push.
        const floatFade = reduced ? 0 : heroT * (1 - easeInOutCubic(welcomeT))
        if (floatFade > 0.0001) {
          liveFloatPhase += dt * FLOAT.speed
          device.position.y = Math.sin(liveFloatPhase) * FLOAT.bob * floatFade
          device.rotation.x = Math.sin(liveFloatPhase * 0.8 + 0.6) * FLOAT.tiltX * floatFade
          device.rotation.z = Math.cos(liveFloatPhase * 0.6) * FLOAT.tiltZ * floatFade
          animating = true
        } else if (device.position.y !== 0 || device.rotation.x !== 0 || device.rotation.z !== 0) {
          device.position.y = 0
          device.rotation.set(0, 0, 0)
          animating = true
        }
        // Attract text: visible only while the device floats in the hero (landing) pose. It reads over
        // the HTML black screen backing (the recessed 3D screen panel stays hidden so it can't peek
        // past the body while the device floats). It blinks + flickers, fades with heroT on settle,
        // then hides so the games HTML screen shows through and the GPU goes idle.
        const showPress = liveStage === 'hero' && heroT > 0.001
        if (pressStart.plane.visible !== showPress) {
          pressStart.plane.visible = showPress
          pressStart.glow.visible = showPress
          dirty = true
        }
        if (showPress) {
          let op = heroT
          if (!reduced) {
            pressBlinkT += dt
            const blink = (pressBlinkT % 1.4) / 1.4 < 0.6 ? 1 : 0.25
            const flicker = 0.97 + 0.03 * Math.sin(pressBlinkT * 31.7) * Math.sin(pressBlinkT * 12.3)
            op = blink * flicker * heroT
            animating = true
          }
          pressStartMat.opacity = op
          pressStart.glowMat.opacity = op * 0.35
        }
        if (animating) placeLiveCamera()
      }

      // Only camera/body motion (the idle float, the landing arc, a resize) actually changes the
      // shadows. Capture that here, before the control + decoration sections add their own repaints:
      // a button press, a knob turn, the ambient light show never move the body, so they must not
      // trigger the shadow pass (a near-second full render) on top of a running game.
      const geoMoved = animating || dirty

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

      // Token overlays hide the cap's emissive flash, so dim the coin itself while its button sinks.
      for (const tokenScreen of tokenScreens) {
        if (!tokenScreen.isActive()) continue
        tokenScreen.mat.color.setScalar(
          1 - bm[tokenScreen.buttonIndex].userData.glow * 0.55,
        )
      }

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

      // Control feedback (button glow, knob, wheel) must paint at full fps to feel responsive. The
      // decoration below (light show, result pulse) is throttled to ~30fps, so snapshot the realtime
      // drivers now: anything that animates past this point is pure cosmetics on the side screens.
      const realtime = animating

      // Ambient light show: while a game flags it (a live run), the two unbound action screens drift
      // slowly through the spectrum as decoration. Pure color + glow, no geometry moves, so it never
      // triggers the shadow pass and repaints at the decoration cadence, not the game's.
      if (state.lightShow) {
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
          const tokenMode =
            i === 1
              ? state.a1Display?.mode === 'token'
              : state.a2Display?.mode === 'token'
          if (tokenMode) {
            lightActionScreen(i, '#000000', 0)
            return
          }
          const halo = actionGlow[i]
          if (halo) {
            halo.color.copy(lightColor)
            halo.opacity = 0.34
          }
        })
        animating = true
      }

      // Result blink: a flagged action button (Lucky's win/lose caps) blinks its bound color (green
      // win / red lose) so the outcome reads at a glance. A steep sine pinned near 0 or 1 most of the
      // cycle gives a clean on/off blink (not a gentle breathe) with quick transitions so it never
      // strobes or clicks. ~1s period, calm. The off beat drives BOTH the emissive AND the diffuse to
      // near-black, so the cap goes genuinely dark, not a dim lit color. Color-only like the light
      // show, so it stays a cheap, shadow-free repaint.
      if (state.a1Pulse || state.a2Pulse) {
        pulseT += dt
        const k = Math.max(0, Math.min(1, 0.5 + 3.4 * Math.sin(pulseT * 6.3)))
        const emissive = 1.05 * k // off: 0 (dark); on: a bright lit screen
        const blink = (i: number, on: boolean, color: ButtonColor | undefined) => {
          if (!on) return
          const hex = (color && SCREEN_COLORS[color]) || actionThemeColor
          const mat = bm[i].material as THREE.MeshStandardMaterial
          // Sink the diffuse toward black on the off beat (floor ~0.04) so it reads as off, not green.
          mat.color.set(hex).multiplyScalar(0.04 + 0.96 * k)
          mat.emissive.set(hex)
          bm[i].userData.baseEmissive = emissive
          const halo = actionGlow[i]
          if (halo) halo.opacity = 0.42 * k
        }
        blink(1, state.a1Pulse, state.a1Color)
        blink(2, state.a2Pulse, state.a2Color)
        animating = true
      }

      // Token-mode screens animate only while a game opts in. Normal HOME/Lucky buttons stay idle.
      let tokenDrew = false
      const tokenScreenActive = tokenScreens.some((screen) => screen.isActive())
      if (tokenScreenActive) coinAccum += dt
      if (tokenScreenActive && coinAccum >= COIN_FRAME) {
        for (const tokenScreen of tokenScreens) tokenScreen.draw(coinAccum)
        coinAccum = 0
        animating = true
        tokenDrew = true // the coin texture changed, so this frame must paint
      }

      // Only touch the GPU when something actually changed. An idle device paints nothing; the shadow
      // pass (the heavy bit) runs only when the body actually moved. Pure decoration (the light show,
      // a result pulse) repaints at ~30fps so it never steals a 60fps frame from a running game, while
      // control feedback and real motion stay at full fps.
      let doRender = dirty || animating
      const decorOnly = animating && !dirty && !realtime && !geoMoved && !tokenDrew
      if (decorOnly) {
        decorAccum += dt
        if (decorAccum >= DECOR_FRAME) decorAccum = 0
        else doRender = false
      }
      if (doRender) {
        if (geoMoved) renderer.shadowMap.needsUpdate = true
        renderer.render(scene, camera)
        dirty = false
        if (!decorOnly) decorAccum = 0
      }
    }
    loop()

    return () => {
      cancelAnimationFrame(rafId)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('touchstart', onScreenTouchStart)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
      ro.disconnect()
      pressTimers.forEach(clearTimeout)
      applyViewRef.current = () => {}
      applyThemeRef.current = () => {}
      applyOutroRef.current = () => {}
      applyActiveRef.current = () => {}
      applyStageRef.current = () => {}
      gui?.destroy()
      disposeActionScreens()
      backDetails.dispose()
      internals.dispose()
      matMetal.dispose()
      matSeam.dispose()
      matBackRecess.dispose()
      for (const tokenScreen of tokenScreens) tokenScreen.dispose()
      logoGeo.forEach((g) => g.dispose())
      skinCache.forEach((t) => t.dispose())
      matLogoDark.dispose()
      matLogoWhite.dispose()
      screenTex?.dispose()
      renderer.dispose()
      audio.dispose()
    }
    // Scene is built once per mode; live bindings flow through refs + the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debug, customize, exportMode])

  // Push label/state updates into the scene whenever the registered view changes.
  useEffect(() => {
    applyViewRef.current(view)
  }, [view])

  // Repaint the device whenever the skin changes (no rebuild).
  useEffect(() => {
    applyThemeRef.current(theme)
  }, [theme])

  // Repaint the screen snapshot whenever it refreshes (/export only, no rebuild).
  useEffect(() => {
    applyScreenTextureRef.current(screenTexture)
  }, [screenTexture])

  // Arm / disarm the Done outro.
  useEffect(() => {
    applyOutroRef.current(outro)
  }, [outro])

  // Drive the LIVE landing/onboarding pose (hero / app settle / welcome zoom).
  useEffect(() => {
    applyStageRef.current(stage)
  }, [stage])

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
          ? theme?.clear
            ? 'radial-gradient(circle at 50% 36%, #202227 0%, #0b0c0f 84%)' // dark bench so the clear case + guts pop
            : 'radial-gradient(circle at 50% 38%, #f4ead6 0%, #decdab 82%)'
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
