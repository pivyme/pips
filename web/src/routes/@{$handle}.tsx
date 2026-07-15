import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { stashRef } from '@/lib/referral'
import { LoadingIcon } from '@/ui/LoadingIcon'

// Referral capture (username format): playpips.fun/@kelvin. Top level, sibling of pitch.tsx, so it
// never mounts inside _app's phase machine (that would bounce the click straight to / or /games
// before the stash effect below ever runs, see .claude/REFERRALS.md gotcha #2). Renders a component
// (not a beforeLoad redirect, gotcha #3): beforeLoad runs server-side on a cold link click, so the
// client-only localStorage write would never happen if we redirected there instead.
export const Route = createFileRoute('/@{$handle}')({ component: CaptureHandle })

function CaptureHandle() {
  const { handle } = Route.useParams()
  const navigate = useNavigate()

  useEffect(() => {
    stashRef(`@${handle}`)
    void navigate({ to: '/', replace: true })
  }, [handle, navigate])

  return (
    <div className="app-loading-screen">
      <LoadingIcon size={72} />
    </div>
  )
}
