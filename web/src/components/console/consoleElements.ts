import * as THREE from 'three'
import { roundedRect, roundedRectPath, frontZeroed } from './consoleGeo'

// Pure geometry/mesh factories for the handheld's physical controls. Each builds its meshes, parents
// them to the `device` group, registers raycast targets in `interactive`, and hands back only the
// handles the canvas still needs (for the render loop, theming, geometry rebuilds, and the dev GUI).
// ConsoleCanvas owns placement, the scene, the loop, and all interaction; this file owns the shapes.

export interface ButtonCfg {
  w: number; h: number; r: number; depth: number
  dx: number; dy: number; baseZ: number; pressedZ: number; pad: number
}

// knob + number-wheel pockets share one shape: pixel center, footprint, corner radius, rim pad.
export interface PocketCfg {
  px: number; py: number; w: number; h: number; r: number; pad: number
}

// Only the fields the knob geometry reads; the canvas keeps the full `kp` (drag/snap tuning live here too).
export interface KnobParams {
  ridgeWidth: number; grooveWidth: number; bumpScale: number; ridgeRepeat: number
  cornerCurve: number; radius: number; height: number; edgeCurve: number; ridgeLength: number
}

type Px = (n: number) => number

function makeButton(
  device: THREE.Group, interactive: THREE.Mesh[],
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

// The five face buttons (main, the two action pills, the two nav pills) plus their dark pocket floors.
// Returns the meshes in BTN_PX order so the canvas can index them as bm[0..4].
export function createButtons(
  device: THREE.Group, interactive: THREE.Mesh[], matPocket: THREE.Material,
  buttons: ButtonCfg[], BTN_PX: { x: number; y: number }[],
  colors: { color: number; glow: number }[], wx: Px, wy: Px,
): THREE.Mesh[] {
  const bm = BTN_PX.map((p, i) =>
    makeButton(
      device, interactive, wx(p.x), wy(p.y),
      buttons[i].w, buttons[i].h, buttons[i].r,
      buttons[i].baseZ, buttons[i].pressedZ, buttons[i].depth,
      colors[i].color, colors[i].glow,
    ),
  )

  // pocket floors — dark inset plane visible in the gap between button edge and chamfered rim
  bm.forEach((btn, i) => {
    const c = buttons[i]
    const pad = c.pad
    const fw = c.w + pad * 2 - 0.04
    const fh = c.h + pad * 2 - 0.04
    const fr = Math.min(c.r + pad, fw / 2, fh / 2)
    const floor = new THREE.Mesh(new THREE.ShapeGeometry(roundedRect(fw, fh, fr), 48), matPocket)
    floor.position.set(btn.position.x, btn.position.y, -0.04)
    floor.receiveShadow = true
    device.add(floor)
  })

  return bm
}

// Lathe knob: pocket floor, a chamfered bevel ring sloping into the recess, the ridged drag texture,
// and the slab itself. Returns the slab/texture/material plus the rebuild closures the GUI drives.
export function createKnob(
  device: THREE.Group, interactive: THREE.Mesh[], matPocket: THREE.Material,
  matKnob: THREE.MeshStandardMaterial, kp: KnobParams, knobPocket: PocketCfg,
  wx: Px, wy: Px, bodyZ: number,
) {
  /* pocket floor */
  const kfw = knobPocket.w + knobPocket.pad * 2 - 0.04
  const kfh = knobPocket.h + knobPocket.pad * 2 - 0.04
  const knobFloor = new THREE.Mesh(
    new THREE.ShapeGeometry(roundedRect(kfw, kfh, Math.min(knobPocket.r + knobPocket.pad, kfw / 2, kfh / 2)), 48),
    matPocket,
  )
  knobFloor.position.set(wx(knobPocket.px), wy(knobPocket.py), bodyZ - 0.04)
  knobFloor.receiveShadow = true
  device.add(knobFloor)

  // pocket bevel — chamfered ring sloping from the body front face inward into the pocket, so the rim
  // reads as a real machined recess. Outer ring matches the body hole (pocket pad), inner ring sits at
  // the pocket edge one `pad` deep (45° slope).
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

  /* ridge bump texture */
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

  return { knobSlab, knobBump, matKnobSlab, redrawBump, knobProfile }
}

// Compact number drum: pocket floor, a black beveled housing, and a curved drum on a horizontal axle
// whose values wrap around the face like a mechanical counter. The canvas hangs the digit labels off
// `numberWheelRoll` and spins it in the loop.
export function createNumberWheel(
  device: THREE.Group, interactive: THREE.Mesh[], matPocket: THREE.Material,
  numberWheelPocket: PocketCfg, wx: Px, wy: Px, bodyZ: number,
) {
  const nfw = numberWheelPocket.w + numberWheelPocket.pad * 2 - 0.04
  const nfh = numberWheelPocket.h + numberWheelPocket.pad * 2 - 0.04
  const numberWheelFloor = new THREE.Mesh(
    new THREE.ShapeGeometry(
      roundedRect(nfw, nfh, Math.min(numberWheelPocket.r + numberWheelPocket.pad, nfw / 2, nfh / 2)),
      48,
    ),
    matPocket,
  )
  numberWheelFloor.position.set(wx(numberWheelPocket.px), wy(numberWheelPocket.py), bodyZ - 0.04)
  numberWheelFloor.receiveShadow = true
  device.add(numberWheelFloor)

  const numberWheelHousingShape = roundedRect(numberWheelPocket.w, numberWheelPocket.h, numberWheelPocket.r)
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

  const numberWheelDrum = new THREE.Mesh(
    new THREE.CylinderGeometry(0.37, 0.37, 0.76, 64, 1, false),
    new THREE.MeshStandardMaterial({ color: 0x171717, roughness: 0.42, metalness: 0.18 }),
  )
  numberWheelDrum.rotation.z = Math.PI / 2
  numberWheelDrum.castShadow = true
  numberWheelDrum.receiveShadow = true
  numberWheelDrum.userData = { kind: 'numberWheel' }
  numberWheelRoll.add(numberWheelDrum)
  interactive.push(numberWheelDrum)

  return { numberWheelHousing, numberWheelRoll, numberWheelDrum }
}

// Turns the two flat action caps into framed mini-screens: a machined metal bezel mounted on the body
// (with corner screws), the cap recessed inside it as the lit LCD, and a glossy domed acrylic window
// over it. The bezel stays put; the cap + acrylic press together (the acrylic is parented to the cap).
// The cap itself is still bm[i], so it stays the raycast target and the canvas drives its screen color.
export function createActionScreens(
  device: THREE.Group, bm: THREE.Mesh[], indices: number[],
  buttons: ButtonCfg[], BTN_PX: { x: number; y: number }[], wx: Px, wy: Px,
  // The screen overlays (scanlines, sheen, bloom) draw depth-test-free so the label stays crisp over
  // the glossy acrylic. That makes them bleed through the body/knob when the device is spun. The export
  // tool spins it, so it opts into real occlusion to keep the side views clean.
  occlude = false,
): { dispose(): void; glow: Record<number, THREE.MeshBasicMaterial> } {
  const trash: { dispose(): void }[] = []
  // Shared so both screens read as the same part. No envMap in the scene, so metalness stays moderate
  // and the beveled edges do the light-catching; a fully metallic frame would just go black.
  const bezelMat = new THREE.MeshStandardMaterial({ color: 0x44474e, metalness: 0.82, roughness: 0.34 })
  const screwMat = new THREE.MeshStandardMaterial({ color: 0x767a83, metalness: 0.9, roughness: 0.28 })
  const screwGeo = new THREE.CylinderGeometry(0.032, 0.038, 0.04, 16)
  screwGeo.rotateX(Math.PI / 2) // axis Y → faces the camera (+z)
  trash.push(bezelMat, screwMat, screwGeo)

  const FRAME = 0.1 // metal rim thickness: just enough to read as a machined bezel, screen takes the rest

  // Faint glass glint: just a hint of acrylic catching the upper-left key light. Kept low so it reads
  // as a sheen on the cover, not a glare blowing out the screen.
  const sheenCanvas = document.createElement('canvas')
  sheenCanvas.width = sheenCanvas.height = 256
  const sg = sheenCanvas.getContext('2d')!
  const grad = sg.createRadialGradient(74, 56, 4, 110, 120, 150)
  grad.addColorStop(0, 'rgba(255,255,255,0.5)')
  grad.addColorStop(0.5, 'rgba(255,255,255,0.1)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  sg.fillStyle = grad
  sg.fillRect(0, 0, 256, 256)
  const sheenTex = new THREE.CanvasTexture(sheenCanvas)
  sheenTex.colorSpace = THREE.SRGBColorSpace
  const sheenMat = new THREE.MeshBasicMaterial({
    map: sheenTex, transparent: true, opacity: 0.16, depthWrite: false, depthTest: occlude,
    blending: THREE.AdditiveBlending,
  })
  const sheenGeo = new THREE.PlaneGeometry(1, 1)
  trash.push(sheenTex, sheenMat, sheenGeo)

  // CRT face: fine horizontal scanlines plus an edge vignette, baked once and overlaid on every screen.
  // Darkening the lit color in bands and at the rim is what makes it read as a real display behind glass.
  const crtCanvas = document.createElement('canvas')
  crtCanvas.width = crtCanvas.height = 256
  const cg = crtCanvas.getContext('2d')!
  cg.clearRect(0, 0, 256, 256)
  cg.fillStyle = 'rgba(0,0,0,0.5)'
  for (let y = 0; y < 256; y += 8) cg.fillRect(0, y, 256, 3) // ~32 scanlines (3px line, 5px gap)
  const vig = cg.createRadialGradient(128, 120, 56, 128, 128, 178)
  vig.addColorStop(0, 'rgba(0,0,0,0)')
  vig.addColorStop(1, 'rgba(0,0,0,0.5)')
  cg.fillStyle = vig
  cg.fillRect(0, 0, 256, 256)
  const crtTex = new THREE.CanvasTexture(crtCanvas)
  crtTex.colorSpace = THREE.SRGBColorSpace
  const crtMat = new THREE.MeshBasicMaterial({ map: crtTex, transparent: true, opacity: 0.6, depthWrite: false, depthTest: occlude })
  const crtGeo = new THREE.PlaneGeometry(1, 1)
  trash.push(crtTex, crtMat, crtGeo)

  // Bloom: a soft glow that bleeds the screen color past the window onto the frame, the light spill a
  // lit display gives off. One per screen so the canvas can tint it live (a dark neutral screen tints
  // it near-black, so it barely glows; green/red glow strongly, for free).
  const haloCanvas = document.createElement('canvas')
  haloCanvas.width = haloCanvas.height = 128
  const hg = haloCanvas.getContext('2d')!
  const hgrad = hg.createRadialGradient(64, 64, 6, 64, 64, 64)
  hgrad.addColorStop(0, 'rgba(255,255,255,1)')
  hgrad.addColorStop(0.5, 'rgba(255,255,255,0.45)')
  hgrad.addColorStop(1, 'rgba(255,255,255,0)')
  hg.fillStyle = hgrad
  hg.fillRect(0, 0, 128, 128)
  const haloTex = new THREE.CanvasTexture(haloCanvas)
  const haloGeo = new THREE.PlaneGeometry(1, 1)
  trash.push(haloTex, haloGeo)
  const glow: Record<number, THREE.MeshBasicMaterial> = {}

  for (const i of indices) {
    const c = buttons[i]
    const cx = wx(BTN_PX[i].x), cy = wy(BTN_PX[i].y)
    const frontZ = c.baseZ + 0.18 // bezel face stands proud; the cap (at baseZ) reads as recessed glass

    const outerW = c.w + c.pad * 2 - 0.06, outerH = c.h + c.pad * 2 - 0.06 // fills the body hole
    const innerW = outerW - FRAME * 2, innerH = outerH - FRAME * 2 // slim rim; window still overlaps the cap
    const frame = roundedRect(outerW, outerH, 0.18)
    frame.holes.push(roundedRectPath(0, 0, innerW, innerH, 0.13))
    const bezelGeo = frontZeroed(frame, 0.22, 0.025)
    const bezel = new THREE.Mesh(bezelGeo, bezelMat)
    bezel.position.set(cx, cy, frontZ)
    bezel.castShadow = true
    bezel.receiveShadow = true
    device.add(bezel)
    trash.push(bezelGeo)

    // Four corner screws, the machined detail the references lean on. Tiny and low so they read as
    // hardware, not buttons. Seated on the diagonal midline of the frame corner so they sit centered,
    // not crowding the inner window edge.
    const sx = outerW / 2 - 0.095, sy = outerH / 2 - 0.095
    for (const [dx, dy] of [[-sx, sy], [sx, sy], [-sx, -sy], [sx, -sy]]) {
      const screw = new THREE.Mesh(screwGeo, screwMat)
      screw.position.set(cx + dx, cy + dy, frontZ + 0.01)
      screw.castShadow = true
      device.add(screw)
    }

    // Domed acrylic window: a thin slab with a bevel wider than its depth so the top pillows and a
    // single specular streak rolls across it (sells the gloss without an envMap). Clear, so the lit
    // screen color reads straight through; parented to the cap so it sinks on press.
    const acrGeo = frontZeroed(roundedRect(innerW - 0.04, innerH - 0.04, 0.16), 0.05, 0.07)
    const acrMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false,
      roughness: 0.05, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04, ior: 1.45,
    })
    const acrylic = new THREE.Mesh(acrGeo, acrMat)
    acrylic.position.z = frontZ - 0.05 - c.baseZ // local to the cap; front sits just under the bezel face
    acrylic.renderOrder = 5
    bm[i].add(acrylic)
    trash.push(acrGeo, acrMat)

    // CRT scanlines + vignette, on the screen face under the glass. The label (depth-test-free, drawn
    // later) stays crisp over the lines.
    const crt = new THREE.Mesh(crtGeo, crtMat)
    crt.scale.set(innerW - 0.02, innerH - 0.02, 1)
    crt.position.z = acrylic.position.z - 0.02
    crt.renderOrder = 4
    bm[i].add(crt)

    // Bloom halo, wider than the window so the glow spills onto the frame and a touch of the body.
    const haloMat = new THREE.MeshBasicMaterial({
      map: haloTex, transparent: true, opacity: 0.36, depthWrite: false, depthTest: occlude,
      blending: THREE.AdditiveBlending,
    })
    const halo = new THREE.Mesh(haloGeo, haloMat)
    halo.scale.set(outerW + 0.22, outerH + 0.22, 1)
    halo.position.z = acrylic.position.z - 0.03
    halo.renderOrder = 3
    bm[i].add(halo)
    glow[i] = haloMat
    trash.push(haloMat)

    // The faint glass glint, on top of the scanlines.
    const sheen = new THREE.Mesh(sheenGeo, sheenMat)
    sheen.scale.set(innerW - 0.06, innerH - 0.06, 1)
    sheen.position.z = acrylic.position.z - 0.01
    sheen.renderOrder = 6
    bm[i].add(sheen)
  }

  return { dispose: () => trash.forEach((t) => t.dispose()), glow }
}
