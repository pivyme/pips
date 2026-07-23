import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { stashRef } from '@/lib/referral'
import { LoadingIcon } from '@/ui/LoadingIcon'

// Referral capture (playpips.fun/@kelvin), a standalone root route outside _app's phase machine so the click
// can't bounce away first (REFERRALS.md #2). A component, not a beforeLoad redirect, since beforeLoad runs server-side and would skip the client-only write (#3).
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
