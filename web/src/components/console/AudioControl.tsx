import { useRef, useState } from 'react'
import { Music, Volume1, Volume2 } from 'lucide-react'
import { Modal, useOverlayState } from '@/ui/Modal'
import { haptic } from '@/lib/haptics'

// Bezel-mounted audio cluster: a molded press button + a Game Boy style volume fader.
// Renders inline (parked in the design system for now); the slider is display-only and
// the button just opens a placeholder modal. Meant to eventually sit on the 3D bezel.

const AMBER = '#f5a623'
const AMBER_HI = '#ffd25e'
const THUMB_W = 22 // fader cap width in px, the travel is inset by half this on each end

export function AudioControl() {
  const modal = useOverlayState()
  const [vol, setVol] = useState(72)
  const [hover, setHover] = useState(false)
  const [pressed, setPressed] = useState(false)
  const [dragging, setDragging] = useState(false)
  const trackRef = useRef<HTMLDivElement>(null)

  const setFromClientX = (clientX: number) => {
    const el = trackRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const usable = r.width - THUMB_W
    const pct = Math.round(((clientX - r.left - THUMB_W / 2) / usable) * 100)
    setVol(Math.max(0, Math.min(100, pct)))
  }

  const openModal = () => {
    haptic('selection')
    modal.open()
  }

  // Thumb center + fill both stop at the same point: half a cap in from each rim.
  const travel = `calc(${THUMB_W / 2}px + (100% - ${THUMB_W}px) * ${vol / 100})`

  return (
    <>
      <div
        className="inline-flex select-none items-center gap-3.5 rounded-[18px] px-3.5 py-2.5"
        style={{
          background: 'linear-gradient(180deg, #3b3e44 0%, #26282c 52%, #191b1e 100%)',
          border: '1px solid rgba(0,0,0,0.45)',
          boxShadow:
            'inset 0 1px 0 rgba(255,255,255,0.14), inset 0 -1px 0 rgba(0,0,0,0.55), 0 12px 26px -10px rgba(0,0,0,0.6)',
        }}
      >
        {/* Press button: a domed cap sunk into a dark socket. */}
        <div
          style={{
            padding: 3,
            borderRadius: '50%',
            background: 'radial-gradient(120% 120% at 50% 30%, #16171a 0%, #0c0d0f 100%)',
            boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.8), inset 0 -1px 0 rgba(255,255,255,0.05)',
          }}
        >
          <button
            type="button"
            aria-label="Audio settings"
            onPointerEnter={() => setHover(true)}
            onPointerLeave={() => {
              setHover(false)
              setPressed(false)
            }}
            onPointerDown={() => setPressed(true)}
            onPointerUp={() => setPressed(false)}
            onClick={openModal}
            className="grid place-items-center outline-none"
            style={{
              width: 44,
              height: 44,
              borderRadius: '50%',
              cursor: 'pointer',
              border: 'none',
              background: pressed
                ? 'radial-gradient(120% 120% at 50% 70%, #34373d 0%, #202226 60%, #17181b 100%)'
                : 'radial-gradient(120% 120% at 50% 26%, #565b63 0%, #34373d 46%, #1c1e21 100%)',
              boxShadow: pressed
                ? 'inset 0 2px 5px rgba(0,0,0,0.7), 0 1px 2px rgba(0,0,0,0.4)'
                : `inset 0 1px 1px rgba(255,255,255,0.28), inset 0 -3px 6px rgba(0,0,0,0.55), 0 4px 9px -2px rgba(0,0,0,0.6)${hover ? `, 0 0 0 1px ${AMBER}55, 0 0 14px ${AMBER}44` : ''}`,
              transform: pressed ? 'translateY(1.5px)' : hover ? 'translateY(-0.5px)' : 'none',
              transition: 'transform 120ms cubic-bezier(0.2,0.7,0.2,1), box-shadow 160ms ease, background 160ms ease',
            }}
          >
            <Music
              size={19}
              strokeWidth={2.4}
              color={hover ? AMBER_HI : AMBER}
              style={{ filter: `drop-shadow(0 1px 1px rgba(0,0,0,0.6)) drop-shadow(0 0 5px ${AMBER}${hover ? '66' : '33'})`, transition: 'color 160ms ease' }}
            />
          </button>
        </div>

        {/* Volume fader: recessed notched groove + a proud ridged cap. */}
        <div className="flex flex-col items-stretch gap-1">
          <div className="flex items-center gap-2">
            <Volume1 size={13} color="rgba(255,255,255,0.4)" strokeWidth={2.4} />
            <div
              ref={trackRef}
              role="slider"
              tabIndex={0}
              aria-label="Volume"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={vol}
              onPointerDown={(e) => {
                setDragging(true)
                e.currentTarget.setPointerCapture(e.pointerId)
                haptic('selection')
                setFromClientX(e.clientX)
              }}
              onPointerMove={(e) => dragging && setFromClientX(e.clientX)}
              onPointerUp={() => setDragging(false)}
              onPointerCancel={() => setDragging(false)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                  setVol((v) => Math.min(100, v + 2))
                  haptic('tick')
                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                  setVol((v) => Math.max(0, v - 2))
                  haptic('tick')
                }
              }}
              className="relative outline-none"
              style={{
                width: 128,
                height: 22,
                borderRadius: 11,
                cursor: dragging ? 'grabbing' : 'pointer',
                touchAction: 'none',
                background: 'linear-gradient(180deg, #121316 0%, #1d1f22 100%)',
                boxShadow: 'inset 0 2px 5px rgba(0,0,0,0.75), inset 0 -1px 0 rgba(255,255,255,0.05)',
              }}
            >
              {/* amber level fill */}
              <div
                className="pointer-events-none absolute left-0 top-0 h-full"
                style={{
                  width: travel,
                  borderRadius: '11px 4px 4px 11px',
                  background: `linear-gradient(180deg, ${AMBER_HI} 0%, ${AMBER} 55%, #d98a12 100%)`,
                  boxShadow: `inset 0 1px 0 rgba(255,255,255,0.45), 0 0 10px ${AMBER}55`,
                }}
              />
              {/* etched scale ticks across the groove */}
              <div
                className="pointer-events-none absolute inset-y-[6px] left-0 right-0"
                style={{
                  backgroundImage:
                    'repeating-linear-gradient(90deg, rgba(0,0,0,0.35) 0 1px, transparent 1px, transparent 10%)',
                  opacity: 0.55,
                  mixBlendMode: 'overlay',
                }}
              />
              {/* the fader cap */}
              <div
                className="pointer-events-none absolute top-1/2"
                style={{
                  left: travel,
                  width: THUMB_W,
                  height: 30,
                  transform: `translate(-50%, -50%) ${dragging ? 'scale(1.04)' : 'scale(1)'}`,
                  borderRadius: 5,
                  background: 'linear-gradient(180deg, #5a5f66 0%, #3d4046 48%, #2a2c30 100%)',
                  boxShadow: `inset 0 1px 0 rgba(255,255,255,0.4), inset 0 -2px 3px rgba(0,0,0,0.5), 0 4px 8px -1px rgba(0,0,0,0.65)${dragging ? `, 0 0 0 1px ${AMBER}55` : ''}`,
                  transition: 'transform 120ms cubic-bezier(0.2,0.7,0.2,1), box-shadow 160ms ease',
                }}
              >
                {/* grip ridges + a center index line */}
                <div
                  className="absolute inset-x-[3px] top-1/2 -translate-y-1/2"
                  style={{
                    height: 16,
                    backgroundImage:
                      'repeating-linear-gradient(0deg, rgba(255,255,255,0.16) 0 1px, transparent 1px, transparent 3px)',
                    borderRadius: 2,
                  }}
                />
                <div
                  className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
                  style={{ width: 2, height: 20, borderRadius: 1, background: AMBER, boxShadow: `0 0 6px ${AMBER}` }}
                />
              </div>
            </div>
            <Volume2 size={15} color="rgba(255,255,255,0.55)" strokeWidth={2.4} />
          </div>
          <span
            className="text-center font-mono uppercase"
            style={{ fontSize: 8, letterSpacing: '0.22em', color: 'rgba(255,255,255,0.32)' }}
          >
            Volume
          </span>
        </div>
      </div>

      <Modal
        isOpen={modal.isOpen}
        onOpenChange={modal.setOpen}
        title="Audio Modal"
        description="Placeholder. Sound and music controls land here."
        size="sm"
      />
    </>
  )
}
