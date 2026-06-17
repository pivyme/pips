import { explorerTxUrl } from '@/lib/sui/config'
import { cnm } from '@/utils/style'

// Shared in-screen pieces for the games: the win/loss result moment and the markets
// empty/error message. Copy stays game-specific (passed in); the chrome is shared.

export function ResultOverlay({
  title,
  tone,
  digest,
  onDismiss,
}: {
  title: string
  tone: 'up' | 'down'
  digest?: string
  onDismiss: () => void
}) {
  return (
    <button
      type="button"
      onClick={onDismiss}
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/80 backdrop-blur-sm"
    >
      <div className={cnm('text-3xl font-extrabold', tone === 'up' ? 'text-up' : 'text-down')}>{title}</div>
      {digest && (
        <a
          href={explorerTxUrl(digest)}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-xs font-semibold text-text-3 underline underline-offset-4 transition-colors hover:text-text-2"
        >
          View on explorer
        </a>
      )}
      <span className="text-[11px] uppercase tracking-[0.1em] text-text-3">Tap to continue</span>
    </button>
  )
}

export function ScreenMessage({
  title,
  action,
  onAction,
}: {
  title: string
  action: string
  onAction: () => void
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="h-1.5 w-1.5 rounded-full bg-down" />
      <p className="text-sm text-text-2">{title}</p>
      <button
        type="button"
        onClick={onAction}
        className="card-neo rounded-full px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-text-2"
      >
        {action}
      </button>
    </div>
  )
}
