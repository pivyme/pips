import { createFileRoute, Link } from '@tanstack/react-router'
import { motion } from 'motion/react'
import type { ReactNode } from 'react'
import {
  ArrowDown,
  Brain,
  Dice5,
  Gauge,
  Hand,
  LineChart,
  Snowflake,
  Sparkles,
  Users,
} from 'lucide-react'

// A focused pitch deck for Pips: hook, problem, solution. Standalone full-bleed scroll surface,
// outside the console shell. Classic brand yellow (#FFC016) carries the attention; black is the
// base. The "act break" slides flip to full yellow so problem and solution land like punches.
export const Route = createFileRoute('/pitch')({ component: Pitch })

const YELLOW = '#FFC016'

function Pitch() {
  return (
    <main className="bg-black text-text">
      <Hook />
      <ProblemBreak />
      <ProblemDetail />
      <SolutionBreak />
      <SolutionDetail />
      <Closing />
    </main>
  )
}

// ── Reusable reveal: rises into place once, on scroll. ──────────────────
function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode
  delay?: number
  className?: string
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.4 }}
      transition={{ duration: 0.7, delay, ease: [0.16, 1, 0.3, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

// Slide 1 — the hook. Giant wordmark on black, one tagline, a scroll cue.
function Hook() {
  return (
    <section className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-6 text-center">
      {/* a warm bloom so the black is not flat */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 h-[120vmin] w-[120vmin] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-[0.13] blur-[120px]"
        style={{ background: `radial-gradient(circle, ${YELLOW} 0%, transparent 60%)` }}
      />
      <motion.img
        src="/assets/logos/pips-yellow-badge.svg"
        alt="Pips"
        className="relative w-[min(78vw,440px)] drop-shadow-[0_24px_60px_rgba(255,192,22,0.25)]"
        initial={{ opacity: 0, scale: 0.92, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
      />
      <motion.p
        className="relative mt-9 text-2xl font-bold tracking-tight sm:text-3xl"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, delay: 0.25, ease: [0.16, 1, 0.3, 1] }}
      >
        Trading, but a game.
      </motion.p>
      <motion.p
        className="relative mt-3 max-w-md text-base text-text-2 sm:text-lg"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.8, delay: 0.45 }}
      >
        No charts to read. No jargon. Just plays.
      </motion.p>

      <motion.div
        className="absolute bottom-8 flex flex-col items-center gap-2 text-text-3"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.1 }}
      >
        <span className="text-xs font-semibold uppercase tracking-[0.2em]">Scroll</span>
        <motion.span
          animate={{ y: [0, 7, 0] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
        >
          <ArrowDown size={18} />
        </motion.span>
      </motion.div>
    </section>
  )
}

// Slide 2 — the problem, stated big. Full yellow act break.
function ProblemBreak() {
  return (
    <section
      className="flex min-h-dvh flex-col justify-center px-6 py-24 sm:px-16"
      style={{ background: YELLOW, color: '#1a1200' }}
    >
      <Reveal>
        <span className="text-sm font-extrabold uppercase tracking-[0.28em] opacity-60">
          The problem
        </span>
      </Reveal>
      <Reveal delay={0.1}>
        <h2 className="mt-6 max-w-5xl text-5xl font-extrabold leading-[0.98] tracking-tight sm:text-7xl lg:text-8xl">
          Trading wasn&apos;t
          <br />
          built for you.
        </h2>
      </Reveal>
      <Reveal delay={0.25}>
        <p className="mt-9 max-w-2xl text-lg font-medium leading-relaxed sm:text-2xl">
          Every terminal is a wall of candles, order books, and ten-digit numbers. It demands a 180
          IQ just to place your first trade. So most people never start, and the few who do get bored
          and leave.
        </p>
      </Reveal>
    </section>
  )
}

const PAINS = [
  {
    icon: Brain,
    title: 'Intimidating',
    body: 'Charts, jargon, order books, leverage. You need a finance degree just to read the screen, let alone press buy.',
  },
  {
    icon: Snowflake,
    title: 'Boring',
    body: 'Every terminal is the same grey grid of numbers. Nothing about it makes you want to come back tomorrow.',
  },
  {
    icon: Users,
    title: 'Lonely',
    body: 'Trading is a solo spreadsheet. No play, no people, no moment worth sharing. All work, no fun.',
  },
]

// Slide 3 — the three pains, on black, as cards.
function ProblemDetail() {
  return (
    <section className="flex min-h-dvh flex-col justify-center px-6 py-24 sm:px-16">
      <Reveal>
        <h3 className="max-w-3xl text-3xl font-extrabold tracking-tight sm:text-5xl">
          Three reasons traders bounce.
        </h3>
      </Reveal>
      <div className="mt-14 grid gap-5 sm:grid-cols-3">
        {PAINS.map((p, i) => (
          <Reveal key={p.title} delay={0.12 * i}>
            <div className="card-neo flex h-full flex-col gap-4 p-7">
              <span
                className="flex h-12 w-12 items-center justify-center rounded-2xl"
                style={{ background: 'rgba(255,192,22,0.12)', color: YELLOW }}
              >
                <p.icon size={24} />
              </span>
              <span className="text-2xl font-bold">{p.title}</span>
              <p className="text-base leading-relaxed text-text-2">{p.body}</p>
            </div>
          </Reveal>
        ))}
      </div>
      <Reveal delay={0.3}>
        <p className="mt-12 flex items-center gap-3 text-lg font-semibold text-text-3">
          <LineChart size={20} />
          The terminal hasn&apos;t changed in 20 years. The trader changed.
        </p>
      </Reveal>
    </section>
  )
}

// Slide 4 — the solution, stated big. Full yellow act break.
function SolutionBreak() {
  return (
    <section
      className="flex min-h-dvh flex-col justify-center px-6 py-24 sm:px-16"
      style={{ background: YELLOW, color: '#1a1200' }}
    >
      <Reveal>
        <span className="text-sm font-extrabold uppercase tracking-[0.28em] opacity-60">
          The solution
        </span>
      </Reveal>
      <Reveal delay={0.1}>
        <h2 className="mt-6 max-w-5xl text-5xl font-extrabold leading-[0.98] tracking-tight sm:text-7xl lg:text-8xl">
          So we made
          <br />
          trading a game.
        </h2>
      </Reveal>
      <Reveal delay={0.25}>
        <p className="mt-9 max-w-2xl text-lg font-medium leading-relaxed sm:text-2xl">
          Pips is a handheld console you actually want to hold. A tactile device with a screen, a
          knob, and buttons. Pick a game, make a play, cash out. Fast, social, addictive.
        </p>
      </Reveal>
    </section>
  )
}

const GAMES = [
  { icon: Dice5, title: 'I Feel Lucky', sub: 'Spin. Ride it. Cash out.' },
  { icon: Gauge, title: 'Range', sub: 'Call the zone. Tighter pays more.' },
  { icon: Hand, title: 'Tap', sub: 'Tap the chart. Catch the move.' },
]

// Slide 5 — how the solution works + the games. On black.
function SolutionDetail() {
  return (
    <section className="flex min-h-dvh flex-col justify-center px-6 py-24 sm:px-16">
      <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
        <div>
          <Reveal>
            <span
              className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-[0.1em]"
              style={{ background: 'rgba(255,192,22,0.12)', color: YELLOW }}
            >
              <Sparkles size={14} /> The product is the device
            </span>
          </Reveal>
          <Reveal delay={0.1}>
            <h3 className="mt-6 text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl">
              The fun is the front.
              <br />
              <span style={{ color: YELLOW }}>Real trading is the engine.</span>
            </h3>
          </Reveal>
          <Reveal delay={0.2}>
            <p className="mt-7 max-w-xl text-lg leading-relaxed text-text-2">
              Every play looks like a game, but underneath it is a real on-chain trade on Sui, settled
              by DeepBook Predict. No seed phrases, no gas, no spreadsheet. Sign in with Google and
              you are holding a console in seconds.
            </p>
          </Reveal>
        </div>

        <div className="flex flex-col gap-4">
          {GAMES.map((g, i) => (
            <Reveal key={g.title} delay={0.12 * i}>
              <div className="card-neo flex items-center gap-4 p-5">
                <span
                  className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl"
                  style={{ background: 'rgba(255,192,22,0.12)', color: YELLOW }}
                >
                  <g.icon size={26} />
                </span>
                <div>
                  <div className="text-xl font-bold">{g.title}</div>
                  <div className="text-base text-text-2">{g.sub}</div>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}

// Slide 6 — closing. Full yellow, one line, a way in.
function Closing() {
  return (
    <section
      className="flex min-h-dvh flex-col items-center justify-center px-6 text-center"
      style={{ background: YELLOW, color: '#1a1200' }}
    >
      <Reveal>
        <img
          src="/assets/logos/pips-horizontal-black.svg"
          alt="Pips"
          className="w-[min(70vw,360px)]"
        />
      </Reveal>
      <Reveal delay={0.15}>
        <p className="mt-10 max-w-xl text-3xl font-extrabold leading-tight tracking-tight sm:text-5xl">
          The simplest, most fun way to trade.
        </p>
      </Reveal>
      <Reveal delay={0.3}>
        <Link
          to="/"
          className="mt-10 inline-flex h-14 items-center justify-center rounded-full bg-black px-10 text-base font-bold text-white transition-transform active:scale-95"
        >
          Enter Pips
        </Link>
      </Reveal>
      <Reveal delay={0.4}>
        <p className="mt-8 text-sm font-semibold uppercase tracking-[0.2em] opacity-50">
          Built on Sui · DeepBook Predict
        </p>
      </Reveal>
    </section>
  )
}
