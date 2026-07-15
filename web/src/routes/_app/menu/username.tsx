import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { MenuScreen, prepareMenuTransition } from '@/components/menu/shared'
import { XBadgeGlyph } from '@/components/menu/BrandGlyphs'
import { ApiError, api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { haptic } from '@/lib/haptics'
import { HapticOverlay } from '@/components/HapticOverlay'

// Change your handle. A plain App-Surface input page in the drawer (reached from the pen on the
// Player Card), not the device screen: type a new handle, Save, and pop back to the menu.
export const Route = createFileRoute('/_app/menu/username')({ component: UsernameScreen })

const HANDLE_RE = /^[a-zA-Z0-9_]{3,20}$/

function UsernameScreen() {
  const navigate = useNavigate()
  const { user, refresh } = useAuth()
  const current = (user?.username ?? '').toLowerCase()
  const [name, setName] = useState(current)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const trimmed = name.trim()
  const valid = HANDLE_RE.test(trimmed)
  const dirty = trimmed !== current

  // Reads off the auth user (server-verified, synced through /auth/link/refresh), never Privy
  // directly: this screen also has to work in dev/demo, where no Privy provider is mounted.
  const twitterHandle = user?.twitter?.username ?? null
  const verified = Boolean(twitterHandle && current === twitterHandle.toLowerCase())

  const save = async () => {
    if (saving || !valid || !dirty) return
    setSaving(true)
    setError(null)
    haptic('medium')
    try {
      await api.setUsername(trimmed)
      await refresh()
      haptic('success')
      prepareMenuTransition('back')
      void navigate({ to: '/menu', viewTransition: true })
    } catch (e) {
      setSaving(false)
      haptic('error')
      setError(
        e instanceof ApiError && e.code === 'USERNAME_TAKEN'
          ? 'That handle is taken'
          : 'Could not save that. Try again.',
      )
    }
  }

  return (
    <MenuScreen title="Username">
      <div className="flex flex-col gap-5">
        <p className="px-1 text-[15px] leading-snug text-text-2">
          This is how you show up across PIPS. 3 to 20 letters, numbers, or underscores.
        </p>

        <div className="card-neo rounded-card p-5">
          <div className="flex items-center gap-1">
            <span className="text-[28px] font-black leading-none text-text-3">@</span>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value.replace(/\s/g, '').toLowerCase())
                if (error) setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save()
              }}
              maxLength={20}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              placeholder="yourname"
              aria-label="Handle"
              className="min-w-0 flex-1 bg-transparent text-[28px] font-extrabold tracking-tight text-text placeholder:text-text-3/40 focus:outline-none"
              style={{ caretColor: 'var(--color-brand-500)' }}
            />
          </div>
          <div className="mt-3 h-px w-full bg-white/[0.08]" />
          <div className="mt-2.5 h-4 text-[13px] font-semibold">
            {error ? (
              <span className="text-down">{error}</span>
            ) : valid && dirty ? (
              <span className="text-up">Looks good</span>
            ) : (
              <span className="text-text-3">Type your username</span>
            )}
          </div>
        </div>

        {twitterHandle && (
          <div className="-mt-2 flex items-center gap-2 px-1">
            {verified ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-up/15 px-2 py-0.5 text-xs font-bold text-up">
                <XBadgeGlyph className="h-3.5 w-3.5" />
                Verified
              </span>
            ) : (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setName(twitterHandle)
                    if (error) setError(null)
                  }}
                  className="pointer-events-none rounded-full bg-white/[0.06] px-3 py-1.5 text-xs font-bold text-text-2 active:scale-95"
                >
                  Use your X username
                </button>
                <HapticOverlay
                  className="absolute inset-0 rounded-full"
                  preset="selection"
                  silent
                  onTap={() => {
                    setName(twitterHandle)
                    if (error) setError(null)
                  }}
                />
              </div>
            )}
          </div>
        )}

        <div className="relative h-12">
          <button
            onClick={save}
            disabled={saving || !valid || !dirty}
            className="btn-primary pointer-events-none flex h-12 w-full items-center justify-center rounded-card text-[15px] font-semibold disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save handle'}
          </button>
          <HapticOverlay
            className="absolute inset-0 rounded-card"
            preset="medium"
            disabled={saving || !valid || !dirty}
            silent
            onTap={() => void save()}
          />
        </div>
      </div>
    </MenuScreen>
  )
}
