import NumberFlow from '@number-flow/react'
import { useThrottledValue } from '@/hooks/useThrottledValue'
import { priceDecimals } from '@/utils/format'

const UPDATE_MS = 1000

// The top-bar live price readout (Lucky/Range/Moonshot header, NOT the on-chart price). The raw feed
// can tick several times a second, which reads as jittery at this size, so the displayed value only
// advances once a second (trailing-edge throttle) and NumberFlow eases the digits between reads
// instead of hard-swapping the text. Inherits type styling from its wrapping element.
export function LivePrice({ price }: { price: number | null }) {
  const throttled = useThrottledValue(price, UPDATE_MS)
  if (throttled == null) return <>—</>
  return <NumberFlow value={throttled} prefix="$" format={{ maximumFractionDigits: priceDecimals(throttled) }} />
}
