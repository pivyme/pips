import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { createConsoleGui } from './consoleGui'
import { roundedRect, roundedPoly, frontZeroed, setBoxUVs, roundedRectPath, roundedPolyPath } from './consoleGeo'
import { createAudio } from './consoleAudio'
import { createScreen } from './consoleScreen'

export default function ConsoleCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hintRef = useRef<HTMLDivElement>(null)

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

    function buildBodyShape() {
      const s = roundedRect(6.2, 11.95, deviceCfg.corner)
      BTN_PX.forEach((p, i) => {
        // hole center in body-local space (body mesh sits at wx(585), wy(1130))
        const lx = wx(p.x) + buttons[i].dx - wx(585)
        const ly = wy(p.y) + buttons[i].dy - wy(1130)
        const pad = buttons[i].pad
        const hw = buttons[i].w + pad * 2
        const hh = buttons[i].h + pad * 2
        // r + pad keeps the hole perfectly concentric with the button shape
        s.holes.push(roundedRectPath(lx, ly, hw, hh, Math.min(buttons[i].r + pad, hw / 2, hh / 2)))
      })
      // knob pocket — rectangular hole (cylinder lies on X-axis so front face is w×h)
      const klx = wx(knobPocket.px) - wx(585)
      const kly = wy(knobPocket.py) - wy(1130)
      const kw = knobPocket.w + knobPocket.pad * 2
      const kh = knobPocket.h + knobPocket.pad * 2
      s.holes.push(roundedRectPath(klx, kly, kw, kh, Math.min(knobPocket.r + knobPocket.pad, kw / 2, kh / 2)))
      // screen cutout — same L-shape as the screen mesh, in body-local coords
      s.holes.push(roundedPolyPath(
        SCREEN_PX.map(p => ({ x: wx(p.x) - wx(585), y: wy(p.y) + SCREEN_MESH_Y_OFFSET - wy(1130) })),
        0.25,
      ))
      return s
    }

    /* audio + screen */
    const audio = createAudio()
    const matScreen = new THREE.MeshStandardMaterial({
      color: 0x000000, roughness: 0.5, metalness: 0.6,
      emissive: 0xffffff, emissiveIntensity: 5.0,
      transparent: true, opacity: 0.05,
    })
    const screen = createScreen(MAXANISO, audio)
    matScreen.emissiveMap = screen.tex
    matScreen.needsUpdate = true

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
    screenMesh.position.y = 0.13
    screenMesh.receiveShadow = true
    screenMesh.visible = true
    deck.add(screenMesh)

    /* buttons */
    const interactive: THREE.Mesh[] = []

    function makeButton(
      cx: number, cy: number, w: number, h: number, cornerR: number,
      baseZ: number, pressedZ: number, depth: number, color: number, glow: number,
      onPress: () => void,
    ) {
      const mat = new THREE.MeshStandardMaterial({
        color, roughness: 0.5, metalness: 0,
        emissive: new THREE.Color(glow), emissiveIntensity: 0,
      })
      const mesh = new THREE.Mesh(frontZeroed(roundedRect(w, h, cornerR), depth, 0.06), mat)
      mesh.position.set(cx, cy, baseZ)
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.userData = { kind: 'button', baseZ, pressedZ, depth, pressed: false, glow: 0, hover: 0, onPress }
      deck.add(mesh)
      interactive.push(mesh)
      return mesh
    }

    const bm = [
      makeButton(wx(965), wy(1490), buttons[0].w, buttons[0].h, buttons[0].r, buttons[0].baseZ, buttons[0].pressedZ, buttons[0].depth, RED, 0xff5a3c, () => screen.select()),
      makeButton(wx(200), wy(1860), buttons[1].w, buttons[1].h, buttons[1].r, buttons[1].baseZ, buttons[1].pressedZ, buttons[1].depth, BLUE, 0x5e9bff, () => screen.moveSel(-1)),
      makeButton(wx(589), wy(1860), buttons[2].w, buttons[2].h, buttons[2].r, buttons[2].baseZ, buttons[2].pressedZ, buttons[2].depth, BLUE, 0x5e9bff, () => screen.moveSel(+1)),
      makeButton(wx(150), wy(2150), buttons[3].w, buttons[3].h, buttons[3].r, buttons[3].baseZ, buttons[3].pressedZ, buttons[3].depth, CREAM, 0xff7a1a, () => screen.switchTab('MENU')),
      makeButton(wx(425), wy(2150), buttons[4].w, buttons[4].h, buttons[4].r, buttons[4].baseZ, buttons[4].pressedZ, buttons[4].depth, CREAM, 0xff7a1a, () => screen.switchTab('GAMES')),
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

    function makeLabel(text: string, cx: number, cy: number, worldH: number, color: string) {
      const c = document.createElement('canvas'), g = c.getContext('2d')!
      const fs = 64
      g.font = `600 ${fs}px -apple-system,"Segoe UI",system-ui,sans-serif`
      const tw = Math.ceil(g.measureText(text).width)
      c.width = tw + 24
      c.height = fs + 24
      g.font = `600 ${fs}px -apple-system,"Segoe UI",system-ui,sans-serif`
      g.fillStyle = color
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(text, c.width / 2, c.height / 2)
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

    const LABEL_DY = -0.45
    const lblMenu = makeLabel('MENU', bm[3].position.x, bm[3].position.y + LABEL_DY, 0.26, '#7c7870')
    const lblGames = makeLabel('GAMES', bm[4].position.x, bm[4].position.y + LABEL_DY, 0.26, '#7c7870')

    function rebuildBtnGeo(i: number) {
      const m = bm[i], c = buttons[i]
      m.geometry.dispose()
      m.geometry = frontZeroed(roundedRect(c.w, c.h, c.r), c.depth, 0.06)
      m.position.x = bmOrigin[i].x + c.dx
      m.position.y = bmOrigin[i].y + c.dy
      m.userData.depth = c.depth
      if (i === 3) { lblMenu.position.x = m.position.x; lblMenu.position.y = m.position.y + LABEL_DY }
      if (i === 4) { lblGames.position.x = m.position.x; lblGames.position.y = m.position.y + LABEL_DY }
      rebuildBodyGeo()
    }

    /* knob */
    const kp = {
      ridgeWidth: 120, grooveWidth: 50, bumpScale: 45, ridgeRepeat: 20,
      cornerCurve: 0.2,
      radius: 1.25, height: 0.95,
      dragSensitivity: 0.5, pxPerStep: 40, ridgePhase: 0,
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
    }

    /* dev GUI */
    const gui = createConsoleGui({
      kp, buttons, knobPocket, deviceCfg, bm, knobSlab, matKnobSlab, knobBump, matScreen, deck,
      lights: { key, fill, hemi, ambient },
      onRedrawBump: redrawBump,
      onRebuildBodyGeo: rebuildBodyGeo,
      onRebuildBtnGeo: rebuildBtnGeo,
    })

    /* pointer handling */
    const raycaster = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const MIN_PRESS_MS = 120
    const pressTimers: ReturnType<typeof setTimeout>[] = []
    let hovered: THREE.Mesh | null = null, active: THREE.Mesh | null = null
    let knobDrag = false, knobStartY = 0, knobBase = 0, knobLastStep = 0, knobLastRidge = 0

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

    function onPointerDown(e: PointerEvent) {
      audio.resumeAudio()
      hint.style.opacity = '0'
      toNDC(e)
      const obj = pick()
      if (!obj) return
      canvas.setPointerCapture(e.pointerId)
      if (obj.userData.kind === 'knob') {
        knobDrag = true
        knobStartY = e.clientY
        knobBase = knobOffset
        knobLastStep = 0
        knobLastRidge = Math.round(knobOffset / kp.snapInterval)
      } else {
        obj.userData.pressed = true
        obj.userData.pressedAt = performance.now()
        obj.userData.glow = Math.max(obj.userData.glow, 0.001)
        active = obj
        const bi = bm.indexOf(obj)
        if (bi === 0) audio.playSfx('mainPress')
        else if (bi === 1 || bi === 2) audio.playSfx('actionPress')
        else if (bi === 3 || bi === 4) audio.playSfx('pillPress')
        obj.userData.onPress()
      }
    }

    function onPointerMove(e: PointerEvent) {
      toNDC(e)
      if (knobDrag) {
        const dy = e.clientY - knobStartY
        knobOffset = knobBase + dy * kp.dragSensitivity
        const detent = Math.round(knobOffset / kp.snapInterval)
        if (detent !== knobLastRidge) {
          knobLastRidge = detent
          audio.playSfx('knob')
        }
        const step = Math.round(dy / kp.pxPerStep)
        if (step !== knobLastStep) {
          screen.moveSel(step > knobLastStep ? 1 : -1, true)
          knobLastStep = step
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

    /* resize */
    function resize() {
      const w = window.innerWidth, h = window.innerHeight
      renderer.setSize(w, h)
      camera.aspect = w / h
      const fov = (camera.fov * Math.PI) / 180
      const fitH = (11.95 * 0.5 * 1.06) / Math.tan(fov / 2)
      const fitW = (6.2 * 0.5 * 1.06) / (Math.tan(fov / 2) * camera.aspect)
      camera.position.set(0, 0, Math.max(fitH, fitW))
      camera.lookAt(0, 0, 0)
      camera.updateProjectionMatrix()
    }
    window.addEventListener('resize', resize)
    resize()

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

      screen.tick(dt)

      renderer.render(scene, camera)
    }
    loop()

    return () => {
      cancelAnimationFrame(rafId)
      canvas.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      window.removeEventListener('resize', resize)
      pressTimers.forEach(clearTimeout)
      gui.destroy()
      renderer.dispose()
      audio.dispose()
    }
  }, [])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        touchAction: 'none',
        overflow: 'hidden',
        zIndex: 10,
      }}
    >
      <canvas ref={canvasRef} style={{ display: 'block' }} />
      <div
        ref={hintRef}
        style={{
          position: 'fixed',
          bottom: 22,
          left: 0,
          width: '100%',
          textAlign: 'center',
          color: '#8a7657',
          fontSize: 12,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          opacity: 0.65,
          transition: 'opacity 0.8s ease',
          pointerEvents: 'none',
          userSelect: 'none',
          fontFamily: '-apple-system, "Segoe UI", system-ui, sans-serif',
        }}
      />
    </div>
  )
}
