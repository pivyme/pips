import { createFileRoute } from '@tanstack/react-router'
import toast from 'react-hot-toast'
import { Illo } from '@/ui/Illo'

// The menu is App Surface, not the device: black canvas, neumorphic cards,
// 3D illustrations (placeholders for now). Each item gets built out later.
export const Route = createFileRoute('/_app/menu/')({ component: MenuHub })

const ITEMS = [
  { illo: 'gear', title: 'Customize', sub: 'Make the device yours. Colors, finishes.' },
  { illo: 'medal', title: 'Achievements', sub: 'Unlock the set. One sticker each.' },
  { illo: 'trophy', title: 'Stats', sub: 'Win rate, streaks, volume. Shareable.' },
  { illo: 'vault', title: 'Settings', sub: 'Sound, haptics, account.' },
] as const

function MenuHub() {
  return (
    <div className="flex flex-col gap-3 p-4">
      <h1 className="px-1 pt-2 text-2xl font-extrabold tracking-tight">Menu</h1>
      {ITEMS.map((item) => (
        <button
          key={item.title}
          type="button"
          onClick={() => toast(`${item.title} · coming soon`)}
          className="card-neo flex items-center gap-3 p-3 text-left transition-transform active:scale-[0.99]"
        >
          <Illo name={item.illo} size={56} />
          <div className="min-w-0 flex-1">
            <div className="text-[17px] font-bold">{item.title}</div>
            <div className="text-sm text-text-2">{item.sub}</div>
          </div>
          <span className="text-lg text-text-3">›</span>
        </button>
      ))}
    </div>
  )
}
