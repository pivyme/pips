// iOS Safari gates DeviceOrientation behind a tap-gestured permission popup (must be called
// synchronously from a click handler); every other browser streams it with no ask at all.
export async function requestDeviceTiltPermission(): Promise<boolean> {
  const DOE = window.DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<'granted' | 'denied'>
  }
  if (typeof DOE?.requestPermission !== 'function') return true
  try {
    return (await DOE.requestPermission()) === 'granted'
  } catch {
    return false
  }
}
