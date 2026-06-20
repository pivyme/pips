import * as THREE from 'three'
import { roundedRect, roundedRectPath, circlePath, frontZeroed, setBoxUVs } from './consoleGeo'

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

// Back-of-device dress: a parting seam that wraps the whole side at the front/back shell joint, four
// gunmetal corner screws, a drilled speaker grille, a louvered vent, a printed spec label, and a strap
// eyelet. Everything is low-relief on the rear face (dark decals + raised hardware) so the panel never
// needs a real cavity cut, and it all parents to the back panel (the seam to the device, since it lives
// on the side) so it tracks the screen stretch and the flip. The canvas owns the colors (recolored per
// theme) and re-seats the corner-anchored pieces via place() when the panel grows on a tall frame.
const BD_FONT = '-apple-system,"Segoe UI",system-ui,sans-serif'

export function createBackDetails(
  device: THREE.Group,
  backPanel: THREE.Mesh,
  dims: { bodyW: number; bodyH: number; corner: number; seamZ: number; bodyCx: number },
  mats: {
    metal: THREE.MeshStandardMaterial
    seam: THREE.MeshStandardMaterial
    recess: THREE.MeshStandardMaterial
    shell: THREE.MeshStandardMaterial
  },
  inkColor: string,
) {
  const { bodyW, bodyH, corner, seamZ, bodyCx } = dims
  const trash: { dispose(): void }[] = []
  const tmp = new THREE.Matrix4()

  const WALL = (bodyW + 0.16) / 2 // the side wall sits ~here; features crown here to read without poking

  /* side grip — a ribbed patch down the flat back-shell wall on each side: short vertical ribs whose
     crown sits right at the wall surface, so they read as a grip texture from any side angle while the
     crown never passes the front silhouette (the front stays untouched). Lives on `device` and rides the
     body center; re-seated with the seam when it grows. */
  const gripGroup = new THREE.Group()
  device.add(gripGroup)
  const ribR = 0.03
  const grooveGeo = new THREE.CapsuleGeometry(ribR, 1.6, 4, 12) // capsule axis is Y → a vertical rib
  trash.push(grooveGeo)
  const GRIP_X = WALL - ribR // crown flush with the wall
  for (const side of [-1, 1])
    for (const gz of [-0.82, -1.04, -1.26, -1.48, -1.7]) {
      const rib = new THREE.Mesh(grooveGeo, mats.recess)
      rib.position.set(side * GRIP_X, 0, gz)
      gripGroup.add(rib)
    }

  /* parting seam — a recessed line on the body outline, its crown at the side-wall surface so it reads
     as a crisp parting groove, yet still tucked under the front silhouette. Follows the rounded-rect
     perimeter; rebuilt when the height grows. Lives on `device`, not the back panel, so it shows on the
     side through the whole spin, not only when flipped. */
  let seam: THREE.Mesh | null = null
  const SEAM_R = 0.032
  function buildSeamGeo(ext: number) {
    const grow = (WALL - SEAM_R) * 2 - bodyW // outline so the tube crown lands on the wall
    const outline = roundedRect(bodyW + grow, bodyH + ext + grow, corner + grow / 2).getPoints(48)
    const pts = outline.map((p) => new THREE.Vector3(p.x, p.y, 0))
    return new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0),
      280,
      SEAM_R,
      8,
      true,
    )
  }
  function rebuildSeam(ext: number, cy: number) {
    if (!seam) {
      seam = new THREE.Mesh(buildSeamGeo(ext), mats.seam)
      device.add(seam)
    } else {
      seam.geometry.dispose()
      seam.geometry = buildSeamGeo(ext)
    }
    seam.position.set(bodyCx, cy, seamZ)
    gripGroup.position.set(bodyCx, cy, 0) // grip patch rides the body center as it stretches
  }

  // Shared geometry for the four corner screws: a dark countersink cup, a gunmetal head, a cross slot.
  const csGeo = new THREE.CircleGeometry(0.17, 24)
  const headGeo = new THREE.CylinderGeometry(0.105, 0.125, 0.05, 22)
  headGeo.rotateX(Math.PI / 2) // axis Y → faces ±z; the wider base ends up toward the viewer when flipped
  const slotGeo = new THREE.BoxGeometry(0.16, 0.034, 0.02)
  trash.push(csGeo, headGeo, slotGeo)
  const screwGroups: THREE.Group[] = []
  for (let i = 0; i < 4; i++) {
    const g = new THREE.Group()
    const cs = new THREE.Mesh(csGeo, mats.recess)
    const head = new THREE.Mesh(headGeo, mats.metal)
    head.position.z = -0.026
    head.castShadow = true
    const slot1 = new THREE.Mesh(slotGeo, mats.recess)
    slot1.position.z = -0.05
    const slot2 = new THREE.Mesh(slotGeo, mats.recess)
    slot2.position.z = -0.05
    slot2.rotation.z = Math.PI / 2
    g.add(cs, head, slot1, slot2)
    backPanel.add(g)
    screwGroups.push(g)
  }

  /* speaker grille — a thin shell-tone boss that stands proud of the back with a cluster of real
     punched holes (true extrude openings, chamfered so the rims catch light), over a dark backing the
     holes reveal. The depth is genuine: you look down each hole onto the dark cavity floor. */
  const grilleGroup = new THREE.Group()
  backPanel.add(grilleGroup)
  const padW = 1.9
  const padH = 0.92
  // dark cavity floor the holes look down onto, just proud of the rear face
  const backing = new THREE.Mesh(
    new THREE.ShapeGeometry(roundedRect(padW - 0.06, padH - 0.06, 0.17), 24),
    mats.recess,
  )
  backing.position.z = -0.01
  grilleGroup.add(backing)
  trash.push(backing.geometry)
  // the drilled boss: a rounded plate with the hole grid cut clean through, trimmed to a rounded cluster
  const boss = roundedRect(padW, padH, 0.2)
  const cols = 9
  const rows = 4
  const dotPitch = 0.19
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x = (c - (cols - 1) / 2) * dotPitch
      const y = (r - (rows - 1) / 2) * dotPitch
      if ((x / (padW / 2 - 0.18)) ** 2 + (y / (padH / 2 - 0.14)) ** 2 > 1) continue
      boss.holes.push(circlePath(x, y, 0.046))
    }
  const bossGeo = frontZeroed(boss, 0.075, 0.009)
  const bossMesh = new THREE.Mesh(bossGeo, mats.shell)
  bossMesh.rotation.y = Math.PI // drilled face toward the viewer when the device is flipped
  bossMesh.position.z = -0.072 // stands proud; the holes reveal the dark backing behind
  bossMesh.castShadow = true
  bossMesh.receiveShadow = true
  grilleGroup.add(bossMesh)
  trash.push(bossGeo)

  /* vent — a short centered run of dark louver slots near the bottom edge. */
  const ventGroup = new THREE.Group()
  backPanel.add(ventGroup)
  const ventGeo = new THREE.ShapeGeometry(roundedRect(0.045, 0.46, 0.022), 4)
  trash.push(ventGeo)
  const ventN = 7
  const ventPitch = 0.13
  const vents = new THREE.InstancedMesh(ventGeo, mats.recess, ventN)
  for (let i = 0; i < ventN; i++) {
    tmp.makeTranslation((i - (ventN - 1) / 2) * ventPitch, 0, -0.004)
    vents.setMatrixAt(i, tmp)
  }
  vents.instanceMatrix.needsUpdate = true
  ventGroup.add(vents)
  trash.push(vents)

  /* spec label — printed silkscreen block (model no + a fine line + a regulatory row), faced toward
     the rear so it reads when the device is flipped. Recolored to the theme's label ink. */
  const labelGroup = new THREE.Group()
  backPanel.add(labelGroup)
  const lc = document.createElement('canvas')
  lc.width = 512
  lc.height = 256
  const lg = lc.getContext('2d')!
  function drawLabel(color: string) {
    lg.clearRect(0, 0, 512, 256)
    lg.fillStyle = color
    lg.textAlign = 'center'
    lg.font = `700 66px ${BD_FONT}`
    lg.fillText('PIPS-01', 256, 76)
    lg.globalAlpha = 0.72
    lg.font = `500 30px ${BD_FONT}`
    lg.fillText('DEEPBOOK PREDICT INSIDE', 256, 142)
    lg.globalAlpha = 0.5
    lg.font = `500 26px ${BD_FONT}`
    lg.fillText('CE · FCC · RoHS', 256, 196)
    lg.globalAlpha = 1
  }
  drawLabel(inkColor)
  const ltex = new THREE.CanvasTexture(lc)
  ltex.colorSpace = THREE.SRGBColorSpace
  const lplaneGeo = new THREE.PlaneGeometry(1.6, 0.8)
  const lmat = new THREE.MeshBasicMaterial({ map: ltex, transparent: true })
  const lplane = new THREE.Mesh(lplaneGeo, lmat)
  lplane.rotation.y = Math.PI // mirror so the print reads correctly once the panel is flipped to camera
  labelGroup.add(lplane)
  trash.push(ltex, lplaneGeo, lmat)

  // Re-seat the corner/edge-anchored pieces against the current panel half-extents, and float every
  // decal just proud of the rear face (faceZ is the most-negative panel z, so proud is faceZ - eps).
  function place(halfW: number, halfH: number, faceZ: number) {
    const inset = 0.5
    const sx = halfW - inset
    const sy = halfH - inset
    const sc: [number, number][] = [
      [-sx, sy],
      [sx, sy],
      [-sx, -sy],
      [sx, -sy],
    ]
    screwGroups.forEach((g, i) => g.position.set(sc[i][0], sc[i][1], faceZ - 0.004))
    grilleGroup.position.set(0, 2.55, faceZ - 0.003)
    ventGroup.position.set(0, -(halfH - 1.2), faceZ - 0.004)
    labelGroup.position.set(0, -2.75, faceZ - 0.012)
  }

  function recolorInk(color: string) {
    drawLabel(color)
    ltex.needsUpdate = true
  }

  function dispose() {
    if (seam) seam.geometry.dispose()
    trash.forEach((t) => t.dispose())
  }

  return { place, rebuildSeam, recolorInk, dispose }
}

// The guts. Built once, parented to `device`, hidden until a transparent (Nothing-style) skin is on.
// Sits in a thin slab between the two shells (z ~ -0.62..-0.28) so it reads as packed inside the case
// once the body goes to frosted acrylic. Coordinates are body-local (origin at the body center). The
// screen L-cutout only ever grows UPWARD in Y (never in X), so the bottom deck (below the screen) and
// the two side frames (beside it in X) are always safe to fill without occluding the live HTML screen.
// It frames the screen on three sides with black PCB and stacks real mechanical parts, battery, RF
// shield cans, copper coil, electrolytic caps, a vibration motor, ribbon and glyph light strips, for
// parallax and weight through the frost.
export function createInternals(device: THREE.Group, accent: string, full: boolean) {
  const group = new THREE.Group()
  group.visible = false
  device.add(group)
  const trash: { dispose(): void }[] = []
  const G = <T extends THREE.BufferGeometry>(g: T): T => (trash.push(g), g) // register + return a geometry
  const M = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat)
    m.position.set(x, y, z)
    group.add(m)
    return m
  }

  // z layers, front-to-back inside the case (more negative = deeper toward the back shell)
  const PCB_Z = -0.62
  const LOW = -0.5 // low SMD parts sit just proud of the board
  const TALL = -0.34 // tall masses (battery, shield cans, caps) crown nearer the frosted front
  const LED_Z = -0.52

  // --- black solder-mask PCB texture: dark substrate, copper traces, gold pads, white silk, vias ---
  const pc = document.createElement('canvas')
  pc.width = pc.height = 1024
  const g2 = pc.getContext('2d')!
  g2.fillStyle = '#0a0c0e'
  g2.fillRect(0, 0, 1024, 1024)
  for (let i = 0; i < 1600; i++) {
    const x = (i * 137.5) % 1024
    const y = (i * 311.7) % 1024
    g2.fillStyle = i % 2 ? 'rgba(120,150,140,0.045)' : 'rgba(0,0,0,0.16)'
    g2.fillRect(x, y, 3, 3)
  }
  g2.strokeStyle = '#b3742f' // copper on black
  g2.lineCap = 'round'
  g2.lineJoin = 'round'
  const trace = (pts: number[][], w: number) => {
    g2.lineWidth = w
    g2.beginPath()
    g2.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length; i++) g2.lineTo(pts[i][0], pts[i][1])
    g2.stroke()
  }
  // a dense routed fabric: horizontal buses with rounded jogs, vertical risers, a couple of diagonals
  for (let r = 0; r < 12; r++) {
    const y = 56 + r * 80
    trace([[24, y], [300, y], [372, y + 56], [660, y + 56], [732, y], [1000, y]], 3.5)
  }
  for (let c = 0; c < 10; c++) {
    const x = 70 + c * 100
    trace([[x, 30], [x, 300], [x + 46, 360], [x + 46, 994]], 3)
  }
  trace([[40, 980], [980, 60]], 6)
  trace([[40, 60], [980, 980]], 6)
  // gold pads + dark vias on a grid
  for (let r = 0; r < 12; r++)
    for (let c = 0; c < 10; c++) {
      const x = 70 + c * 100
      const y = 56 + r * 80
      g2.fillStyle = '#cBA24a'
      g2.beginPath(); g2.arc(x, y, 5.5, 0, Math.PI * 2); g2.fill()
      g2.fillStyle = '#05070a'
      g2.beginPath(); g2.arc(x, y, 2.4, 0, Math.PI * 2); g2.fill()
    }
  // white-silk component footprints + a QFP pad ring
  g2.strokeStyle = 'rgba(220,228,224,0.7)'
  g2.lineWidth = 2.5
  g2.strokeRect(340, 320, 300, 300)
  g2.strokeRect(120, 700, 200, 150)
  g2.strokeRect(720, 700, 160, 200)
  for (let i = 0; i < 14; i++) { // QFP pads down two sides of the big footprint
    g2.fillStyle = '#cBA24a'
    g2.fillRect(330, 340 + i * 20, 18, 9)
    g2.fillRect(632, 340 + i * 20, 18, 9)
  }
  g2.fillStyle = 'rgba(224,230,226,0.82)'
  g2.font = '700 44px -apple-system,"Segoe UI",system-ui,sans-serif'
  g2.fillText('PIPS-01', 360, 375)
  g2.font = '500 24px -apple-system,"Segoe UI",system-ui,sans-serif'
  g2.fillText('DEEPBOOK · DBX', 352, 600)
  g2.fillText('REV C', 132, 738)
  g2.fillText('SUI', 760, 690)
  const pcbTex = new THREE.CanvasTexture(pc)
  pcbTex.colorSpace = THREE.SRGBColorSpace
  pcbTex.anisotropy = 8
  trash.push(pcbTex)

  const matPcb = new THREE.MeshStandardMaterial({ map: pcbTex, roughness: 0.66, metalness: 0.2 })
  const matCopper = new THREE.MeshStandardMaterial({ color: 0xc8803a, metalness: 0.85, roughness: 0.32 })
  const matGold = new THREE.MeshStandardMaterial({ color: 0xd9b24a, metalness: 0.9, roughness: 0.28 })
  const matIc = new THREE.MeshStandardMaterial({ color: 0x0a0a0d, metalness: 0.25, roughness: 0.48 })
  const matCell = new THREE.MeshStandardMaterial({ color: 0x121317, metalness: 0.55, roughness: 0.38 })
  const matShield = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.82, roughness: 0.42 }) // brushed RF can
  const matRibbon = new THREE.MeshStandardMaterial({ color: 0xd9892b, metalness: 0.2, roughness: 0.55 })
  const matMetal = new THREE.MeshStandardMaterial({ color: 0x8b9099, metalness: 0.9, roughness: 0.3 })
  const matCap = new THREE.MeshStandardMaterial({ color: 0x1a2233, metalness: 0.45, roughness: 0.44 }) // electrolytic can
  const matAccent = new THREE.MeshStandardMaterial({ color: new THREE.Color(accent), metalness: 0.1, roughness: 0.5 })
  const matLed = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.35, roughness: 0.4 }) // glyph glow
  trash.push(matPcb, matCopper, matGold, matIc, matCell, matShield, matRibbon, matMetal, matCap, matAccent, matLed)

  // HARD screen clearance. The L-cutout in body-local is x[-2.775,2.775]; its left column drops to
  // y -2.75, its right column only to y -0.975 (the notch below it is body). The screen only grows in
  // Y, never X, so the side frames are always safe. NOTHING may enter the cutout, so every part is kept
  // clear of these with real margin (the rounded rim overlaps the live HTML screen):
  //   deck parts keep their TOP <= -3.05 ; notch parts keep their TOP <= -1.2 ; side parts center on
  //   |x| = FRAME_X with width <= ~0.18 so their inner edge stays ~0.13 off the screen sides.
  const FRAME_X = 3.0

  // --- the boards: bottom deck + notch (behind the play button) + two side strips framing the screen ---
  const boardPlane = (w: number, h: number, r: number, x: number, y: number) => {
    const g = G(new THREE.ShapeGeometry(roundedRect(w, h, r), 16))
    setBoxUVs(g)
    M(g, matPcb, x, y, PCB_Z)
  }
  boardPlane(6.0, 2.9, 0.12, 0, -4.5) // bottom deck (top -3.05)
  boardPlane(1.66, 1.42, 0.1, 1.82, -1.97) // notch (top -1.26)
  boardPlane(0.2, 8.0, 0.06, -FRAME_X, 1.1) // left frame strip
  boardPlane(0.2, 6.0, 0.06, FRAME_X, 2.1) // right frame strip

  // --- battery cell: the dominant mass, lower-left of the deck, with a printed band + gold terminals ---
  M(G(frontZeroed(roundedRect(2.25, 2.3, 0.1), 0.24, 0.02)), matCell, -1.5, -4.55, TALL) // top -3.4
  M(G(new THREE.PlaneGeometry(2.0, 0.18)), matAccent, -1.5, -3.95, TALL + 0.13)
  const termGeo = G(new THREE.BoxGeometry(0.22, 0.16, 0.06))
  M(termGeo, matGold, -2.35, -3.55, TALL + 0.1)
  M(termGeo, matGold, -0.65, -3.55, TALL + 0.1)

  // --- copper wireless-charging coil: concentric flat rings (the signature Nothing detail) ---
  const coil = new THREE.Group()
  coil.position.set(1.55, -4.5, LOW)
  group.add(coil)
  for (let i = 0; i < 10; i++)
    coil.add(new THREE.Mesh(G(new THREE.TorusGeometry(0.32 + i * 0.07, 0.024, 8, 56)), matCopper))

  // --- RF shield cans: brushed-metal lids, the most mechanical detail, low on the deck (clear of screen) ---
  M(G(frontZeroed(roundedRect(1.1, 0.62, 0.06), 0.16, 0.02)), matShield, -0.05, -3.74, TALL + 0.02) // top -3.43
  M(G(new THREE.PlaneGeometry(0.86, 0.34)), matIc, -0.05, -3.74, TALL + 0.19) // etched lid recess

  // --- ICs (notch + side strips), gold pin strips on the bigger ones ---
  const chipBig = G(frontZeroed(roundedRect(0.58, 0.42, 0.04), 0.07, 0.012))
  const pinGeo = G(new THREE.BoxGeometry(0.58, 0.05, 0.03))

  // densely dress each side frame strip: a running column of small ICs + chip passives + connectors,
  // all width-capped and pinned to the frame edge so nothing creeps onto the screen.
  const smdIc = G(frontZeroed(roundedRect(0.16, 0.13, 0.025), 0.045, 0.008))
  const r04 = G(new THREE.BoxGeometry(0.1, 0.06, 0.04)) // 0402-style chip resistor/cap
  const sideConn = G(frontZeroed(roundedRect(0.16, 0.13, 0.03), 0.06, 0.008))
  const dressStrip = (x: number, yBot: number, yTop: number) => {
    let i = 0
    for (let y = yBot; y < yTop; y += 0.28, i++) {
      const ox = ((i % 3) - 1) * 0.02 // tiny jitter, stays inside the strip
      if (i % 4 === 0) M(smdIc, matIc, x + ox, y, LOW + 0.03)
      else M(r04, i % 2 ? matCap : matMetal, x + ox, y, LOW + 0.02)
    }
    M(sideConn, matAccent, x, yBot + 0.5, LOW + 0.05)
    M(sideConn, matGold, x, yTop - 0.7, LOW + 0.05)
  }
  dressStrip(-FRAME_X, -2.6, 5.2) // left frame
  dressStrip(FRAME_X, -0.5, 5.1) // right frame

  // --- electrolytic capacitors: standing cans along the bottom edge (axis toward the viewer) ---
  const capBody = G(new THREE.CylinderGeometry(0.1, 0.1, 0.26, 18))
  capBody.rotateX(Math.PI / 2) // stand it up toward +z
  const capTop = G(new THREE.CircleGeometry(0.1, 18))
  const cap = (cx: number, cy: number) => {
    M(capBody, matCap, cx, cy, TALL + 0.05)
    M(capTop, matMetal, cx, cy, TALL + 0.18) // metal vent top
  }
  for (const [cx, cy] of [[-2.55, -5.55], [0.05, -5.6], [0.95, -5.55]] as [number, number][]) cap(cx, cy)

  // --- vibration coin motor: a flat metal puck with a hub ---
  M(G(new THREE.CylinderGeometry(0.22, 0.22, 0.1, 28).rotateX(Math.PI / 2)), matMetal, 2.45, -5.45, TALL + 0.02)
  M(G(new THREE.CircleGeometry(0.07, 16)), matIc, 2.45, -5.45, TALL + 0.08)

  // --- FPC ribbons + their red connectors, both pinned to the frame edge (clear of the screen) ---
  M(G(new THREE.BoxGeometry(0.12, 4.4, 0.035)), matRibbon, FRAME_X, 1.7, LOW + 0.04)
  M(G(new THREE.BoxGeometry(0.12, 2.0, 0.035)), matRibbon, -FRAME_X, -0.4, LOW + 0.04)

  // --- the notch (behind the play button): mezzanine fingers + a shield + an IC and caps, packed ---
  const fingerGeo = G(new THREE.BoxGeometry(0.07, 0.32, 0.03))
  for (let i = 0; i < 8; i++) {
    M(fingerGeo, matGold, 1.3 + i * 0.1, -2.35, LOW + 0.02) // top -2.19
    M(fingerGeo, matGold, 1.3 + i * 0.1, -1.7, LOW + 0.02) // top -1.54
  }
  M(G(frontZeroed(roundedRect(0.58, 0.44, 0.05), 0.12, 0.02)), matShield, 1.5, -2.55, TALL) // top -2.33
  M(chipBig, matIc, 2.32, -1.95, LOW + 0.04) // top -1.74
  M(pinGeo, matGold, 2.32, -1.74, LOW + 0.02)
  M(pinGeo, matGold, 2.32, -2.16, LOW + 0.02)
  cap(2.5, -1.5) // top -1.4
  cap(1.15, -1.55) // top -1.45

  // --- top frame: a slim board with the selfie-camera module, sensor, earpiece bar + SMD row + glyph.
  // Gated to showcase contexts; the live screen can grow up into this band, so a played skin skips it. ---
  if (full) {
    const topBoard = G(new THREE.ShapeGeometry(roundedRect(5.4, 0.28, 0.07), 12))
    setBoxUVs(topBoard)
    M(topBoard, matPcb, 0, 5.82, PCB_Z) // bottom 5.68 (screen top ~5.63)
    // camera module: black housing + glassy lens + a metal trim ring
    M(G(frontZeroed(roundedRect(0.36, 0.22, 0.04), 0.1, 0.01)), matIc, -0.25, 5.82, TALL)
    M(G(new THREE.CylinderGeometry(0.075, 0.075, 0.07, 24).rotateX(Math.PI / 2)), matCap, -0.25, 5.82, TALL + 0.1)
    M(G(new THREE.TorusGeometry(0.075, 0.015, 8, 24)), matMetal, -0.25, 5.82, TALL + 0.12)
    // proximity sensor, a brushed earpiece bar, an SMD row and a side connector
    M(G(new THREE.CylinderGeometry(0.04, 0.04, 0.05, 16).rotateX(Math.PI / 2)), matCap, 0.0, 5.82, TALL + 0.05)
    M(G(new THREE.BoxGeometry(0.9, 0.045, 0.03)), matMetal, 0.85, 5.85, LOW + 0.04)
    for (let i = 0; i < 6; i++) M(r04, i % 2 ? matCap : matMetal, -2.1 + i * 0.24, 5.79, LOW + 0.02)
    M(G(frontZeroed(roundedRect(0.28, 0.14, 0.03), 0.06, 0.008)), matAccent, 2.3, 5.82, LOW + 0.05)
  }

  // --- glyph lighting: the signature Nothing light. Brighter emissive runs down both frames, a ring
  // around the charging coil and a bar along the bottom edge. All clear of the screen. ---
  const led = (w: number, h: number, x: number, y: number) =>
    M(G(frontZeroed(roundedRect(w, h, Math.min(w, h) / 2), 0.04, 0.01)), matLed, x, y, LED_Z)
  led(0.1, 7.4, -FRAME_X, 1.1) // left frame glyph
  led(0.1, 5.4, FRAME_X, 2.1) // right frame glyph
  led(2.4, 0.1, -0.2, -5.88) // bottom-edge glyph bar
  M(G(new THREE.TorusGeometry(1.07, 0.035, 10, 80)), matLed, 1.55, -4.5, LED_Z) // glyph ring around the coil
  if (full) led(2.8, 0.09, 0, 5.7) // a glyph run along the top, in showcase

  // --- hardware screws dotted around every board (all clear of the screen) ---
  const screwGeo = G(new THREE.CylinderGeometry(0.07, 0.085, 0.05, 16).rotateX(Math.PI / 2))
  for (const [sx, sy] of [
    [-2.95, -3.2], [2.95, -5.75], [-2.95, -5.75], [2.6, -1.35], [1.2, -2.5],
    [-FRAME_X, 5.0], [-FRAME_X, -2.9], [FRAME_X, 4.9], [FRAME_X, -0.8],
  ] as [number, number][])
    M(screwGeo, matMetal, sx, sy, LOW + 0.04)

  function dispose() {
    trash.forEach((t) => t.dispose())
    device.remove(group)
  }

  return { group, dispose }
}
