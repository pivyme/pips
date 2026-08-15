import { Link, createFileRoute } from '@tanstack/react-router'
import type { LinkProps } from '@tanstack/react-router'
import { ArrowUpRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { cnm } from '@/utils/style'

// The concept index for the games lab: every idea from docs/games-ideation/CONCEPTS.md with its honest
// status, its floor cost, its four-bar score, and the reason it was killed where it was. Killed cards
// carry their ledger reason on purpose, so the page teaches why rather than just listing survivors.
//
// Source of truth for the designs is docs/games-ideation/. Update this when a verdict changes there.
export const Route = createFileRoute('/dev/games')({ component: GamesLab })

type Status = 'idea' | 'building' | 'playable' | 'promoted' | 'killed'

// Score dimensions, in order, from README §6: surprise · no dead time · spatial · escalation.
const DIMENSIONS = ['surprise', 'no dead time', 'spatial', 'escalation']

type Concept = {
  n: number
  name: string
  hook: string
  /** Four bars, in DIMENSIONS order. */
  score: [boolean, boolean, boolean, boolean]
  mints: string
  floor: string
  status: Status
  /** Console route, set once the game actually exists. Typed against the route tree so a stale link fails the gate. */
  to?: LinkProps['to']
  /** Why it survived, or the ledger reason it did not. */
  note: string
}

const Y = true
const N = false

const CONCEPTS: Concept[] = [
  {
    n: 3,
    name: 'Pin',
    hook: 'Name the exact price. Closest call on the board wins the hour.',
    score: [Y, N, Y, Y],
    mints: '1',
    floor: '$1.50',
    status: 'playable',
    to: '/games/pin',
    note: 'The knob scrubs a real price, the most intuitive binding on the device. Miss distance gives a score on a loss, and the closest-call board is a real story.',
  },
  {
    n: 6,
    name: 'Snipe',
    hook: 'One button. The wall drifts toward you. Press when it is close.',
    score: [Y, Y, Y, N],
    mints: '1',
    floor: '$1.50',
    status: 'playable',
    to: '/games/snipe',
    note: 'GAP is exact by construction, which dodges the unreadable-ask problem entirely. Shortest teach in the product: press when the number looks good.',
  },
  {
    n: 4,
    name: 'Press',
    hook: 'Your band is winning. Tighten it mid round, or fold.',
    score: [Y, Y, Y, Y],
    mints: '1 to 4',
    floor: '$1.50 per press',
    status: 'playable',
    to: '/games/press',
    note: 'Range plus a decision loop. Escalation is not scripted, it falls out of real time decay in the pricing. Every box nests strictly inside the last, so the innermost pays all of them.',
  },
  {
    n: 11,
    name: 'Rush',
    hook: 'The machine deals you a band. Take it in three seconds, or it is gone.',
    score: [Y, Y, Y, Y],
    mints: '1 per take',
    floor: '$1.50 per take',
    status: 'building',
    note: "Fuses Lucky's dealt-to pleasure with Range's stacking engine, and fills ledger #7: round 1 was all deliberate decision games.",
  },
  {
    n: 2,
    name: 'Breakout',
    hook: 'Bet that something happens. Flat kills you.',
    score: [Y, Y, Y, N],
    mints: '2, atomic',
    floor: '$3.00',
    status: 'building',
    note: "Inverts the product's emotional polarity: a boring market becomes the enemy. Weakest of the five, gated behind an atomic two-mint spike, and may be cut.",
  },
  {
    n: 1,
    name: 'Echo',
    hook: 'One press, three clocks, three payouts unrolling over an hour.',
    score: [Y, Y, Y, Y],
    mints: '2 to 3',
    floor: '$3.00',
    status: 'killed',
    note: 'Ledger #1. Dead time is the design: the 5m and 1h legs pay out after the device is back in a pocket. A game must pay out inside the session it was played in.',
  },
  {
    n: 5,
    name: 'Climb',
    hook: 'Buy a staircase. Every rung the price clears lights up and pays.',
    score: [Y, Y, Y, Y],
    mints: '3 to 4',
    floor: '$4.50',
    status: 'killed',
    note: 'Ledger #2. The rungs are perfectly correlated, so four premiums buy one graded bet. Correlated legs are not multiplay.',
  },
  {
    n: 7,
    name: 'The Run',
    hook: 'Draw a path through the next four minutes. Every leg rolls forward.',
    score: [Y, Y, Y, Y],
    mints: '1 at a time',
    floor: '$1.50',
    status: 'killed',
    note: 'Ledger #3. The hook sits downstream of a settle-to-remint pipeline that does not exist. A late roll does not feel exciting, it feels broken.',
  },
  {
    n: 8,
    name: 'Blackout',
    hook: 'A bingo card of price tiles you fill across a whole session.',
    score: [Y, Y, Y, Y],
    mints: '1',
    floor: '$1.50',
    status: 'killed',
    note: 'Ledger #4. Blocked on the house rake, which is off. With no pool it is Range with a sticker album.',
  },
  {
    n: 9,
    name: 'Crowd',
    hook: 'See every live band in the room. Join the pile or fade it.',
    score: [Y, Y, Y, Y],
    mints: '1',
    floor: '$1.50',
    status: 'killed',
    note: 'Ledger #5. Fails at N=1. Concurrency may make a game better, never make it exist. The ghost-band layer is still worth harvesting into Range.',
  },
  {
    n: 10,
    name: 'Duel',
    hook: 'Sixty seconds, one opponent, opposite calls.',
    score: [Y, Y, N, Y],
    mints: '1',
    floor: '$1.50',
    status: 'killed',
    note: 'Ledger #6. Needs a simultaneous opponent, and the PvP framing is fiction over two unrelated bets against the vault.',
  },
]

const STATUS_STYLE: Record<Status, string> = {
  idea: 'border-line-strong text-text-3',
  building: 'border-brand-500/60 text-brand-500',
  playable: 'border-up/60 text-up',
  promoted: 'border-premium-500/60 text-premium-500',
  killed: 'border-down/50 text-down',
}

function GamesLab() {
  const live = CONCEPTS.filter((c) => c.status !== 'killed')
  const killed = CONCEPTS.filter((c) => c.status === 'killed')

  return (
    <div className="min-h-dvh bg-canvas px-5 py-10 text-text sm:px-8">
      <div className="mx-auto max-w-4xl">
        <header className="flex items-end justify-between gap-4 border-b border-line-strong pb-5">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-wider text-text-3">Internal</p>
            <h1 className="mt-1 text-2xl font-extrabold tracking-tight">Games Lab</h1>
            <p className="mt-1 text-[13px] text-text-2">
              Every concept, its verdict, and the reason. Playable ones open on the real console and are ADMIN only.
            </p>
          </div>
          <Link
            to="/dev"
            className="shrink-0 border border-line-strong px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-text-2 transition hover:text-text"
          >
            Dev hub
          </Link>
        </header>

        <Section title="In the lab" hint={`${live.length} concepts`}>
          {live.map((c) => (
            <ConceptCard key={c.name} concept={c} />
          ))}
        </Section>

        <Section title="Killed" hint="reasons kept so they do not come back">
          {killed.map((c) => (
            <ConceptCard key={c.name} concept={c} />
          ))}
        </Section>

        <p className="mt-8 font-mono text-[11px] uppercase tracking-wider text-text-3">
          Score, in order: {DIMENSIONS.join(' · ')}
        </p>
      </div>
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <div className="flex items-baseline justify-between gap-3 font-mono text-[11px] uppercase tracking-wider">
        <span className="text-text-2">{title}</span>
        <span className="text-text-3">{hint}</span>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">{children}</div>
    </section>
  )
}

function ConceptCard({ concept }: { concept: Concept }) {
  const { name, hook, score, mints, floor, status, to, note, n } = concept
  const dead = status === 'killed'

  return (
    <div className={cnm('flex flex-col border p-4', dead ? 'border-line' : 'border-line-strong')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className={cnm('text-base font-bold tracking-tight', dead && 'text-text-2')}>
            <span className="font-mono text-[11px] text-text-3">{String(n).padStart(2, '0')} </span>
            {name}
          </h2>
          <p className={cnm('mt-1 text-[13px] leading-snug', dead ? 'text-text-3' : 'text-text-2')}>{hook}</p>
        </div>
        <span className={cnm('shrink-0 border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider', STATUS_STYLE[status])}>{status}</span>
      </div>

      <div className="mt-3 flex items-center gap-2">
        {score.map((on, i) => (
          <span
            key={DIMENSIONS[i]}
            title={DIMENSIONS[i]}
            className={cnm('h-1.5 w-6', on ? (dead ? 'bg-text-3' : 'bg-brand-500') : 'bg-line-strong')}
          />
        ))}
      </div>

      <p className={cnm('mt-3 flex-1 text-[12px] leading-snug', dead ? 'text-text-3' : 'text-text-2')}>{note}</p>

      <div className="mt-3 flex items-center justify-between gap-2 font-mono text-[11px] text-text-3">
        <span>
          {mints} mint{mints === '1' ? '' : 's'} · floor {floor}
        </span>
        {to && (
          <Link to={to} className="inline-flex items-center gap-1 text-brand-500 transition hover:text-brand-400">
            Play
            <ArrowUpRight size={12} />
          </Link>
        )}
      </div>
    </div>
  )
}
