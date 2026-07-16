import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import toast from 'react-hot-toast'
import type { UserDTO } from '@/lib/api'
import { MenuScreen, prepareMenuTransition } from '@/components/menu/shared'
import { Switch } from '@/ui/Switch'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { isDemo, resetDemo } from '@/lib/demo'
import { haptic } from '@/lib/haptics'
import { HapticOverlay } from '@/components/HapticOverlay'

// Sound, haptics, reduced motion. No save button: each toggle persists immediately (PATCH
// /settings) with a haptic tick, no confirm. Reduced motion flows back through the auth user, so
// the chart and rolling numbers calm down at once (useReducedMotion reads it).
export const Route = createFileRoute('/_app/menu/settings')({
  component: SettingsScreen,
})

type Settings = UserDTO['settings']
// Only the boolean toggles live here; the skin (settings.theme) is set in the Customize studio.
type Key = 'sound' | 'haptics' | 'reducedMotion'

const ROWS: Array<{ key: Key; label: string; desc: string }> = [
  { key: 'sound', label: 'Sound', desc: 'Beeps and wins' },
  { key: 'haptics', label: 'Haptics', desc: 'Buzz on taps and wins' },
  { key: 'reducedMotion', label: 'Reduced motion', desc: 'Calmer animations' },
]

function SettingsScreen() {
  const { user, refresh } = useAuth()
  const navigate = useNavigate()
  const [local, setLocal] = useState<Settings>(
    user?.settings ?? { sound: true, haptics: true, reducedMotion: false, theme: 'classic' },
  )
  const [busy, setBusy] = useState<Key | null>(null)

  const toggle = async (key: Key, value: boolean) => {
    haptic('selection') // the only feedback, silent otherwise
    setLocal((s) => ({ ...s, [key]: value })) // optimistic
    setBusy(key)
    try {
      await api.patchSettings({ [key]: value })
      await refresh() // propagate to the auth user (drives reduced motion + haptics app-wide)
    } catch {
      setLocal((s) => ({ ...s, [key]: !value })) // roll back
      toast.error('Something hiccuped. Try again.', { id: 'settings-error' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <MenuScreen title="Settings">
      <div className="flex flex-col gap-3">
        {ROWS.map((row) => (
          <div
            key={row.key}
            className="surface-skeuo flex items-center gap-3 rounded-card p-4"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-bold">{row.label}</div>
              <div className="text-sm text-text-3">{row.desc}</div>
            </div>
            <Switch
              label={row.label}
              isSelected={local[row.key]}
              isDisabled={busy === row.key}
              onChange={(v) => void toggle(row.key, v)}
            />
          </div>
        ))}

        <div className="relative">
          <Link
            to="/menu/about"
            viewTransition
            onClick={() => {
              prepareMenuTransition('forward')
              haptic('selection')
            }}
            className="pointer-events-none surface-skeuo flex items-center gap-3 rounded-card p-4 transition-transform active:scale-[0.99]"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-bold">About PIPS</div>
              <div className="mt-0.5 text-sm text-text-3">
                Made by PIVY, powered by DeepBook Predict.
              </div>
            </div>
            <span className="text-lg text-text-3">›</span>
          </Link>
          <HapticOverlay
            className="absolute inset-0 rounded-card"
            preset="selection"
            silent
            onTap={() => {
              prepareMenuTransition('forward')
              void navigate({ to: '/menu/about', viewTransition: true })
            }}
          />
        </div>

        {isDemo() && (
          <div className="surface-skeuo rounded-card p-4">
            <div className="text-[15px] font-bold">Demo mode</div>
            <div className="mt-0.5 text-sm text-text-3">
              Play money, nothing on chain. Reset to restore the starting
              balance and record.
            </div>
            <div className="relative mt-3 inline-block">
              <button
                type="button"
                onClick={() => {
                  haptic('rigid')
                  resetDemo()
                  window.location.reload()
                }}
                className="pointer-events-none rounded-full border border-line bg-surface px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-text-2 active:scale-[0.97]"
              >
                Reset demo data
              </button>
              <HapticOverlay
                className="absolute inset-0 rounded-full"
                preset="rigid"
                silent
                onTap={() => {
                  resetDemo()
                  window.location.reload()
                }}
              />
            </div>
          </div>
        )}
      </div>
    </MenuScreen>
  )
}
