import { createFileRoute } from '@tanstack/react-router'
import { MenuScreen } from '@/components/menu/shared'
import { Illo } from '@/ui/Illo'

// The one authorized "Coming soon" screen (08-DEMO-FLOW.md). Skins and finishes for the device
// land later; this keeps the slot honest and on-brand instead of a dead link.
export const Route = createFileRoute('/_app/menu/customize')({ component: CustomizeScreen })

function CustomizeScreen() {
  return (
    <MenuScreen title="Customize">
      <div className="flex flex-col items-center justify-center gap-4 py-12 text-center">
        <Illo name="gem" glow="violet" size={88} />
        <div>
          <div className="text-lg font-extrabold">Skins and colors</div>
          <div className="mt-1 text-sm text-text-2">Make the device yours. Coming soon.</div>
        </div>
      </div>
    </MenuScreen>
  )
}
