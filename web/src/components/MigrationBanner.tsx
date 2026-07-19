import { useState } from 'react'
import { X } from 'lucide-react'

// Temporary: devnet -> testnet migration notice. Remove once the cutover is done.
export function MigrationBanner() {
  const [hidden, setHidden] = useState(false)
  if (hidden) return null

  return (
    <div
      className="fixed inset-x-0 top-0 z-[9999] flex items-center justify-center gap-3 bg-yellow-400 px-4 py-2 text-center text-[13px] font-semibold leading-snug text-black shadow-[0_1px_8px_rgba(0,0,0,0.3)]"
      style={{ paddingTop: 'calc(0.5rem + env(safe-area-inset-top))' }}
    >
      <span>
        We're migrating from Devnet to Testnet and pushing some huge updates. Should
        be done in a few hours, so expect a few hiccups meanwhile. Come back soon hehe.
      </span>
      <button
        onClick={() => setHidden(true)}
        aria-label="Dismiss"
        className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-1 text-black/70 transition hover:bg-black/10 hover:text-black"
      >
        <X size={16} />
      </button>
    </div>
  )
}
