import { useEffect, useRef, useState } from 'react'

import { Chart, type ChartOverlays } from '@/components/game/Chart'
import { haptic } from '@/lib/haptics'
import { slotLock } from '@/lib/sound'
import { cnm } from '@/utils/style'

const priceLabel = (p: number): string =>
  `$${p.toLocaleString('en-US', {
    maximumFractionDigits: p >= 1000 ? 0 : p >= 1 ? 2 : 4,
  })}`

export function Reel({
  index,
  label,
  pool,
  target,
  cycling,
  landing,
  stopAt,
  accent,
  last = false,
}: {
  index: number
  label: string
  pool: string[]
  target?: string
  cycling: boolean
  landing: boolean
  stopAt: number
  accent?: 'amber' | 'up' | 'down'
  last?: boolean
}) {
  const [shown, setShown] = useState<string>('?')
  const poolRef = useRef(pool)
  poolRef.current = pool

  useEffect(() => {
    if (!cycling) {
      setShown(target ?? '?')
      return
    }
    let stopped = false
    let i = index % poolRef.current.length
    const iv = setInterval(() => {
      if (!stopped) {
        const nextPool = poolRef.current
        i = (i + 1) % nextPool.length
        setShown(nextPool[i])
      }
    }, 60)
    const timeout =
      landing && target
        ? setTimeout(() => {
            stopped = true
            clearInterval(iv)
            setShown(target)
            haptic('rigid')
            slotLock(index, last)
          }, stopAt)
        : undefined
    return () => {
      clearInterval(iv)
      if (timeout) clearTimeout(timeout)
    }
  }, [cycling, index, landing, last, stopAt, target])

  const palette =
    accent === 'amber'
      ? {
          text: 'text-brand-500',
          bar: 'bg-brand-500',
          wash: 'bg-brand-500/10',
          glow: 'var(--color-brand-500)',
        }
      : accent === 'up'
        ? {
            text: 'text-up',
            bar: 'bg-up',
            wash: 'bg-up/10',
            glow: 'var(--color-up)',
          }
        : accent === 'down'
          ? {
              text: 'text-down',
              bar: 'bg-down',
              wash: 'bg-down/10',
              glow: 'var(--color-down)',
            }
          : {
              text: 'text-text',
              bar: 'bg-text-3',
              wash: '',
              glow: 'var(--color-text)',
            }
  const locked = !cycling && shown !== '?'

  return (
    <div
      className={cnm(
        'relative flex flex-1 flex-col items-center justify-center gap-2 overflow-hidden border-l border-line-strong bg-black px-2 py-4 first:border-l-0',
        locked && palette.wash,
      )}
    >
      <span className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-text-3">
        {label}
      </span>
      <span
        className={cnm(
          'tnum text-[28px] font-extrabold leading-none transition-colors duration-200',
          cycling ? 'text-text-2' : palette.text,
        )}
        style={locked ? { textShadow: `0 0 16px ${palette.glow}` } : undefined}
      >
        {shown}
      </span>
      <span
        className={cnm(
          'absolute inset-x-0 bottom-0 h-[3px] transition-opacity duration-200',
          palette.bar,
          locked ? 'opacity-100' : 'opacity-25',
        )}
      />
    </div>
  )
}

export function LuckyCharts({
  assets,
  focusAsset,
  selectedAsset,
  expanded,
  selecting,
  highlightAsset,
  overlays,
  livePriceRef,
  initialPrices,
  onPrice,
}: {
  assets: Array<string>
  focusAsset: string
  selectedAsset: string | null
  expanded: boolean
  selecting: boolean
  highlightAsset: string | null
  overlays: ChartOverlays | undefined
  livePriceRef: { current: number }
  initialPrices: Record<string, number>
  onPrice: (asset: string, price: number) => void
}) {
  const locking = selectedAsset != null && !expanded

  return (
    <div className="absolute inset-0 flex flex-col">
      {assets.map((asset, index) => {
        const isSelected = asset === selectedAsset
        const grow = !expanded ? 1 : isSelected ? 1 : 0
        const lit = !expanded && selecting && asset === highlightAsset
        const winner = locking && isSelected

        return (
          <div
            key={asset}
            style={{ flexGrow: grow }}
            className={cnm(
              'relative min-h-0 basis-0 overflow-hidden transition-[flex-grow] duration-[600ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
              index > 0 && !expanded && 'border-t border-line-strong',
            )}
          >
            <ChartRow
              asset={asset}
              showLabel={selectedAsset == null}
              reveal={isSelected}
              lit={lit}
              winner={winner}
              dimmed={(selecting && !lit) || (locking && !isSelected)}
              overlays={isSelected ? overlays : undefined}
              livePriceRef={asset === focusAsset ? livePriceRef : undefined}
              initialPrice={initialPrices[asset]}
              onPrice={onPrice}
            />
          </div>
        )
      })}
    </div>
  )
}

function ChartRow({
  asset,
  showLabel,
  reveal,
  lit,
  winner,
  dimmed,
  overlays,
  livePriceRef,
  initialPrice,
  onPrice,
}: {
  asset: string
  showLabel: boolean
  reveal: boolean
  lit: boolean
  winner: boolean
  dimmed: boolean
  overlays?: ChartOverlays
  livePriceRef?: { current: number }
  initialPrice?: number
  onPrice: (asset: string, price: number) => void
}) {
  const [price, setPrice] = useState<number | null>(null)

  return (
    <div className="relative h-full w-full">
      <Chart
        asset={asset}
        overlays={overlays}
        livePriceRef={livePriceRef}
        initialPrice={initialPrice}
        showPriceTag={reveal}
        onPrice={(value) => {
          setPrice(value)
          onPrice(asset, value)
        }}
        className="absolute inset-0"
      />
      <div
        className={cnm(
          'pointer-events-none absolute inset-0 bg-black transition-opacity duration-150',
          dimmed ? 'opacity-[0.55]' : 'opacity-0',
        )}
      />
      <div
        className={cnm(
          'pointer-events-none absolute inset-0 border border-brand-500 bg-brand-500/[0.06] transition-opacity duration-150',
          lit ? 'opacity-100' : 'opacity-0',
        )}
      />
      <div
        className={cnm(
          'pointer-events-none absolute inset-0 border-2 border-brand-500 bg-brand-500/[0.14] transition-opacity duration-200',
          winner ? 'opacity-100 lucky-lock' : 'opacity-0',
        )}
      />
      {showLabel && (
        <div className="pointer-events-none absolute left-[var(--screen-rim,24px)] top-2.5 flex items-baseline gap-2">
          <span className="font-mono text-[13px] font-bold uppercase tracking-[0.16em] text-text-2">
            {asset}
          </span>
          <span className="tnum text-[15px] font-bold leading-none text-text">
            {price != null ? priceLabel(price) : '—'}
          </span>
        </div>
      )}
    </div>
  )
}
