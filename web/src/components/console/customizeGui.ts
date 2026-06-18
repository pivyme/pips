import GUI from 'lil-gui'

interface CustomizeGuiParams {
  // carved back-logo tuning, shared live with ConsoleCanvas
  carve: { z: number; eyeZ: number; depth: number }
  onPlaceLogo: () => void   // reposition only (z / eyeZ changed)
  onRebuildLogo: () => void // re-extrude letters (depth changed)
  // studio camera distance (1 = default rest pose, lower = pulled closer)
  cam: { zoom: number }
  onCam: () => void
}

// The studio-only tuning panel. Dials the carved back logo and how close the device sits; add knobs
// here as the customize surface grows.
export function createCustomizeGui(p: CustomizeGuiParams): GUI {
  const gui = new GUI({ title: 'Customize', width: 260 })

  const gCam = gui.addFolder('Camera')
  gCam.add(p.cam, 'zoom', 0.45, 1.4, 0.01).name('distance').onChange(p.onCam)

  const gLogo = gui.addFolder('Back logo carve')
  gLogo.add(p.carve, 'z', 0, 0.3, 0.005).name('letters recess').onChange(p.onPlaceLogo)
  gLogo.add(p.carve, 'eyeZ', -0.15, 0.3, 0.005).name('eyes z (- = pop out)').onChange(p.onPlaceLogo)
  gLogo.add(p.carve, 'depth', 0.005, 0.2, 0.005).name('depth').onChange(p.onRebuildLogo)

  return gui
}
