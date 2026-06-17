import * as THREE from 'three'

export function roundedRect(w: number, h: number, r: number) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2
  r = Math.min(r, w / 2, h / 2)
  s.moveTo(x + r, y)
  s.lineTo(x + w - r, y)
  s.quadraticCurveTo(x + w, y, x + w, y + r)
  s.lineTo(x + w, y + h - r)
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  s.lineTo(x + r, y + h)
  s.quadraticCurveTo(x, y + h, x, y + h - r)
  s.lineTo(x, y + r)
  s.quadraticCurveTo(x, y, x + r, y)
  return s
}

export function roundedPoly(pts: { x: number; y: number }[], r: number) {
  const s = new THREE.Shape(), n = pts.length
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n], cur = pts[i], next = pts[(i + 1) % n]
    let ax = cur.x - prev.x, ay = cur.y - prev.y
    const la = Math.hypot(ax, ay); ax /= la; ay /= la
    let bx = next.x - cur.x, by = next.y - cur.y
    const lb = Math.hypot(bx, by); bx /= lb; by /= lb
    const r1 = Math.min(r, la / 2), r2 = Math.min(r, lb / 2)
    const p1 = { x: cur.x - ax * r1, y: cur.y - ay * r1 }
    const p2 = { x: cur.x + bx * r2, y: cur.y + by * r2 }
    if (i === 0) s.moveTo(p1.x, p1.y)
    else s.lineTo(p1.x, p1.y)
    s.quadraticCurveTo(cur.x, cur.y, p2.x, p2.y)
  }
  s.closePath()
  return s
}

/* extrudes a shape with the front face flush at z=0 */
export function frontZeroed(shape: THREE.Shape, depth: number, bevel: number) {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 12,
    curveSegments: 48,
  })
  geo.computeBoundingBox()
  geo.translate(0, 0, -geo.boundingBox!.max.z)
  geo.computeVertexNormals()
  return geo
}

/* stretches UVs across the bounding box so a notched screen shape maps a texture cleanly */
export function setBoxUVs(geo: THREE.BufferGeometry) {
  geo.computeBoundingBox()
  const bb = geo.boundingBox!, w = bb.max.x - bb.min.x, h = bb.max.y - bb.min.y
  const p = geo.attributes.position, uv = geo.attributes.uv
  for (let i = 0; i < p.count; i++)
    uv.setXY(i, (p.getX(i) - bb.min.x) / w, (p.getY(i) - bb.min.y) / h)
  uv.needsUpdate = true
}
