import { Switch as HeroSwitch } from '@heroui/react'
import { cnm } from '@/utils/style'

// Flat wrapper over HeroUI v3's compound Switch (react-aria under the hood, so it stays
// accessible and keyboard driven). Visuals are controlled by `isSelected`: amber gradient track
// when on, per docs/DESIGN.md. Token-only classes, no raw values.
export function Switch({
  isSelected,
  onChange,
  isDisabled,
  label,
}: {
  isSelected: boolean
  onChange: (value: boolean) => void
  isDisabled?: boolean
  label?: string
}) {
  return (
    <HeroSwitch
      aria-label={label}
      isSelected={isSelected}
      onChange={onChange}
      isDisabled={isDisabled}
      className={cnm('inline-flex shrink-0', isDisabled && 'opacity-50')}
    >
      <HeroSwitch.Control
        className={cnm(
          'relative h-7 w-12 rounded-full border transition-colors',
          isSelected
            ? 'border-brand-500/50 bg-gradient-to-b from-brand-400 to-brand-600'
            : 'border-line bg-surface',
        )}
      >
        <HeroSwitch.Thumb
          className={cnm(
            'absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform',
            isSelected && 'translate-x-5',
          )}
        />
      </HeroSwitch.Control>
    </HeroSwitch>
  )
}
