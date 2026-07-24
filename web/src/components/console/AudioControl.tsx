import { useState } from 'react'
import { Music, Volume1, Volume2 } from 'lucide-react'
import { Modal, useOverlayState } from '@/ui/Modal'
import { Hw3DFader } from '@/ui/Hardware3D'
import { haptic } from '@/lib/haptics'

// Bezel-mounted audio cluster: a molded press button + the Game Boy volume fader. Renders inline
// (parked in the design system as the kit's showcase); here the fader is standalone/display-only and
// the button opens a placeholder modal. The wired fader + music player live in the sounds drawer.

const AMBER = '#f5a623'
const AMBER_HI = '#ffd25e'

export function AudioControl() {
  const modal = useOverlayState()
  const [vol, setVol] = useState(0.72)
  const [hover, setHover] = useState(false)
  const [pressed, setPressed] = useState(false)

  const openModal = () => {
    haptic('selection')
    modal.open()
  }

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

        {/* Volume fader: the kit's canonical Game Boy fader, flanked by level glyphs. */}
        <div className="flex flex-col items-stretch gap-1">
          <div className="flex items-center gap-2">
            <Volume1 size={13} color="rgba(255,255,255,0.4)" strokeWidth={2.4} />
            <Hw3DFader value={vol} onChange={setVol} label="Volume" className="w-32" />
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
