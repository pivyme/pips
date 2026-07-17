import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { haptic } from '@/lib/haptics'
import { cnm } from '@/utils/style'
import { CoinLogo } from './CoinLogo'

// The two dropdowns that drive the whole drawer. They never disable: picking a pair is how the player
// discovers what is possible, so an unsupported combination resolves to a labelled reason instead of a
// control they cannot touch.

export interface PickerOption {
  value: string
  label: string
  sub?: string
  logo?: string | null
}

export function AssetPicker({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: PickerOption[]
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const selected = options.find((o) => o.value === value)

  // Close on an outside tap or Escape, the same as any native picker.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (next: string) => {
    haptic('selection')
    onChange(next)
    setOpen(false)
  }

  return (
    <div ref={ref} className="relative min-w-0 flex-1">
      <span className="px-1 text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">{label}</span>
      <button
        onClick={() => {
          haptic('selection')
          setOpen((v) => !v)
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="surface-skeuo mt-1.5 flex h-14 w-full items-center gap-2.5 rounded-card px-3.5 text-left transition-transform active:scale-[0.99]"
      >
        {selected && <CoinLogo src={selected.logo} name={selected.label} size={26} />}
        <span className="min-w-0 flex-1 truncate text-[15px] font-bold text-text">{selected?.label ?? '—'}</span>
        <ChevronDown
          className={cnm('h-[18px] w-[18px] shrink-0 text-text-3 transition-transform', open && 'rotate-180')}
          strokeWidth={2.6}
        />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-full z-40 mt-2 overflow-hidden rounded-card border border-white/[0.09] bg-[#141414] shadow-[0_24px_48px_-12px_rgba(0,0,0,0.9)]"
        >
          {options.map((o) => (
            <button
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              onClick={() => pick(o.value)}
              className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors active:bg-white/[0.06]"
            >
              <CoinLogo src={o.logo} name={o.label} size={30} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-bold text-text">{o.label}</span>
                {o.sub && <span className="block truncate text-[12px] text-text-3">{o.sub}</span>}
              </span>
              {o.value === value && <Check className="h-[18px] w-[18px] shrink-0 text-up" strokeWidth={2.8} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
