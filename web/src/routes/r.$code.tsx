import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { stashRef } from '@/lib/referral'
import { LoadingIcon } from '@/ui/LoadingIcon'

// Referral capture (anonymous format): playpips.fun/r/a7k2qx. Same top-level placement + client-side
// stash-then-navigate pattern as @{$handle}.tsx, see .claude/REFERRALS.md.
export const Route = createFileRoute('/r/$code')({ component: CaptureCode })

function CaptureCode() {
  const { code } = Route.useParams()
  const navigate = useNavigate()

  useEffect(() => {
    stashRef(code)
    void navigate({ to: '/', replace: true })
  }, [code, navigate])

  return (
    <div className="app-loading-screen">
      <LoadingIcon size={72} />
    </div>
  )
}
