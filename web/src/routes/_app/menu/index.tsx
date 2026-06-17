import { createFileRoute, Link } from '@tanstack/react-router'
import { Illo } from '@/ui/Illo'
import { haptic } from '@/lib/haptics'

// The menu hub. Renders inside the device screen, neumorphic rows linking to each sub-screen.
export const Route = createFileRoute('/_app/menu/')({ component: MenuHub })

const ITEMS = [
  { to: '/menu/stats', illo: 'trophy', title: 'Stats', sub: 'Your record' },
  { to: '/menu/achievements', illo: 'medal', title: 'Achievements', sub: "What you've unlocked" },
  { to: '/menu/customize', illo: 'gem', title: 'Customize', sub: 'Make it yours' },
  { to: '/menu/settings', illo: 'gear', title: 'Settings', sub: 'Sound, haptics, motion' },
] as const

function MenuHub() {
  return (
    <div className="flex flex-col gap-3 p-4">
      <h1 className="px-1 pt-2 text-2xl font-extrabold tracking-tight">Menu</h1>
      {ITEMS.map((item) => (
        <Link key={item.to} to={item.to} onClick={() => haptic('selection')}>
          <div className="card-neo flex items-center gap-3 p-3 transition-transform active:scale-[0.99]">
            <Illo name={item.illo} size={56} />
            <div className="min-w-0 flex-1">
              <span className="text-[17px] font-bold">{item.title}</span>
              <div className="text-sm text-text-2">{item.sub}</div>
            </div>
            <span className="text-lg text-text-3">›</span>
          </div>
        </Link>
      ))}
    </div>
  )
}
