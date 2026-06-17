import { Switch as HeroSwitch } from '@heroui/react'
import { cnm } from '@/utils/style'

// Flat wrapper over HeroUI v3's compound Switch (react-aria under the hood, so it stays
// accessible and keyboard driven). The material recipe lives in styles.css so previews and
// production settings stay visually identical.
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
      className={cnm('inline-flex shrink-0', isDisabled && 'opacity-60')}
    >
      <HeroSwitch.Control
        className={cnm(
          'pips-switch-control',
          isSelected && 'pips-switch-control-on',
        )}
      >
        <HeroSwitch.Thumb
          className={cnm(
            'pips-switch-thumb',
            isSelected && 'pips-switch-thumb-on',
          )}
        />
      </HeroSwitch.Control>
    </HeroSwitch>
  )
}
