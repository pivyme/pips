// The bezel audio button opens this: a bottom sheet music player. Two volume faders (SFX + background
// music) plus a Now Playing transport. Music volume is the same value the 3D bezel fader drives, so
// the two stay in sync. Styled as App Surface (rounded cards), amber accent to match the console.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Music, Pause, Play, SkipBack, SkipForward, Volume2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import {
  next,
  prev,
  setMusicVolume,
  setSfxVolume,
  togglePlay,
  useAudioState,
} from '@/lib/audio'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { Hw3DFader, Hw3DIconButton } from '@/ui/Hardware3D'

const AMBER = '#f5a623'

export function SoundsDrawer({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const reduced = useReducedMotion()
  const [render, setRender] = useState(false)
  const sheetRef = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const drag = useRef({ active: false, startY: 0, dy: 0, moved: false })
  const state = useAudioState()

  // Slide the sheet the rest of the way down, then unmount. Reduced motion drops straight out.
  const closeAnim = useCallback(() => {
    const el = sheetRef.current
    const sc = scrimRef.current
    if (reduced || !el) {
      setRender(false)
      return
    }
    el.style.transition = 'transform 300ms cubic-bezier(0.32,0.72,0,1)'
    el.style.transform = `translateY(${el.offsetHeight + 48}px)`
    if (sc) {
      sc.style.transition = 'opacity 260ms ease'
      sc.style.opacity = '0'
    }
    window.setTimeout(() => setRender(false), 300)
  }, [reduced])

  useEffect(() => {
    if (isOpen) setRender(true)
    else if (render) closeAnim()
    // render is intentionally read, not depended on: the close only runs on an open->closed flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, closeAnim])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  const onGrabDown = (e: ReactPointerEvent) => {
    drag.current = { active: true, startY: e.clientY, dy: 0, moved: false }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // capture is best-effort
    }
    if (sheetRef.current) sheetRef.current.style.transition = 'none'
  }
  const onGrabMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d.active) return
    let dy = e.clientY - d.startY
    if (dy < 0) dy *= 0.25 // rubber-band the upward overshoot, this sheet only closes downward
    d.dy = dy
    if (Math.abs(dy) > 6) d.moved = true
    if (sheetRef.current) sheetRef.current.style.transform = `translateY(${Math.max(0, dy)}px)`
  }
  const onGrabUp = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d.active) return
    d.active = false
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // already released
    }
    const h = sheetRef.current?.offsetHeight || 400
    if (!d.moved) {
      onClose()
      return
    }
    if (d.dy > h * 0.28) {
      onClose()
    } else if (sheetRef.current) {
      sheetRef.current.style.transition = 'transform 300ms cubic-bezier(0.22,1,0.36,1)'
      sheetRef.current.style.transform = 'translateY(0)'
    }
  }

  if (!render) return null

  return (
    <div className="absolute inset-0 z-50">
      <div
        ref={scrimRef}
        className="drawer-scrim absolute inset-0 bg-black/45 backdrop-blur-[10px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Sounds"
        className="drawer-sheet absolute inset-x-0 bottom-0 max-h-[90%] overflow-y-auto rounded-t-[28px] border-x border-t border-line bg-[#0b0b0b] px-5 pb-9 shadow-[0_-24px_64px_-24px_rgba(0,0,0,0.95)]"
      >
        {/* Grabber: drag down to dismiss, or tap. */}
        <button
          type="button"
          onPointerDown={onGrabDown}
          onPointerMove={onGrabMove}
          onPointerUp={onGrabUp}
          onPointerCancel={onGrabUp}
          aria-label="Close sounds"
          className="flex h-8 w-full shrink-0 touch-none cursor-grab items-center justify-center active:cursor-grabbing"
        >
          <span className="h-1.5 w-10 rounded-full bg-text-3/60" />
        </button>

        <h2 className="mb-7 mt-1 text-center text-[26px] font-black uppercase tracking-[0.04em] text-text">
          Sounds
        </h2>

        <Section label="Sound Effects">
          <FaderRow icon={Volume2} value={state.sfxVolume} onChange={setSfxVolume} label="Sound effects volume" />
        </Section>

        <Section label="Background Music">
          <FaderRow icon={Music} value={state.musicVolume} onChange={setMusicVolume} label="Background music volume" />
        </Section>

        <Section label="Now Playing">
          <div className="surface-skeuo rounded-card px-4 py-6">
            <div className="truncate text-center text-[15px] text-text-2">{state.track.title}</div>
            <div className="mt-6 flex items-center justify-center gap-6">
              <Hw3DIconButton icon={SkipBack} label="Previous track" size={48} onPress={prev} />
              <Hw3DIconButton
                icon={state.playing ? Pause : Play}
                label={state.playing ? 'Pause' : 'Play'}
                size={64}
                onPress={togglePlay}
              />
              <Hw3DIconButton icon={SkipForward} label="Next track" size={48} onPress={next} />
            </div>
          </div>
        </Section>
      </div>
    </div>
  )
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-2">
      <div className="mb-3 mt-5 text-[17px] font-medium text-text">{label}</div>
      {children}
    </div>
  )
}

// A level glyph + the Game Boy hardware fader (the kit's canonical control). Each row picks its own icon.
function FaderRow({
  icon: Icon,
  value,
  onChange,
  label,
}: {
  icon: LucideIcon
  value: number
  onChange: (v: number) => void
  label: string
}) {
  return (
    <div className="surface-skeuo flex items-center gap-4 rounded-card px-4 py-5">
      <Icon size={22} strokeWidth={2.2} color={AMBER} className="shrink-0" />
      <Hw3DFader value={value} onChange={onChange} label={label} className="flex-1" />
    </div>
  )
}
