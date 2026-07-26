// Live proof of rule 1: analytics is NEVER on the critical path. The unit test (lib/capture.test.ts) makes
// the same claim against a mocked prisma and a hand-rolled commit; this one makes it where it matters, with
// the real database, the real settings table, the real play bus, and the REAL commitPlay seam out of
// services/plays.ts. It also proves the one thing a unit test structurally cannot: PIPS_ANALYTICS_OFF is
// read once at import, so the only honest way to test it is a fresh process booted with the flag set.
//
//   cd backend && bun scripts/verify-analytics-offpath.ts
//
// The chain is not touched. Each probe replays the exact sequence services/plays.ts runs when a mint fails
// (capture, track, then commit the row to 'error') and when one lands (commit to 'open'), which is where a
// broken analytics write would take a play down with it.
//
// The three kill paths, and what each one actually covers:
//   1. PIPS_ANALYTICS_OFF=1  break-glass, kills everything: no error groups, no samples, no events.
//   2. analytics.enabled=false  the product switch: silences track(). Error capture is deliberately NOT
//      gated by it (errors have their own table, their own budget, and their own client_errors.enabled
//      switch), so this probe asserts events stop and errors keep flowing, which is the designed behaviour.
//   3. writes forced to reject  the Event/ErrorGroup/ErrorEvent tables locked or gone.
//
// In all three: the play commits, the returned row is correct, the SSE bus fires, nothing throws, and no
// unhandled rejection is left behind. It creates one throwaway user and one play, and deletes both.

import '../dotenv.ts';

import { getSetting, setSetting } from '../src/config/admin-settings.ts';
import { ANALYTICS_OFF, captureError, flushCaptures, track } from '../src/lib/analytics.ts';
import { onPlay } from '../src/lib/play-bus.ts';
import { prismaQuery } from '../src/lib/prisma.ts';
import { commitPlay } from '../src/services/plays.ts';

type Mode = 'off' | 'disabled' | 'failing';

const MODE = (process.argv[2] as Mode | undefined) ?? null;
const STAMP = Date.now();
const FINGERPRINT = `probe.offpath_${STAMP}`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// Reject only the analytics models. Play and AppConfig writes stay real, or the probe would be measuring
// a broken database rather than a broken analytics table.
const ANALYTICS_MODELS = ['event', 'errorGroup', 'errorEvent'] as const;
type Patchable = Record<string, (...args: unknown[]) => unknown>;

function breakAnalyticsWrites(): { restore: () => void; rejected: () => number } {
  const saved: Array<[Patchable, string, unknown]> = [];
  let rejected = 0;
  for (const model of ANALYTICS_MODELS) {
    const delegate = prismaQuery[model] as unknown as Patchable;
    for (const method of ['create', 'createMany', 'upsert', 'update', 'findUnique', 'findMany', 'count', 'deleteMany']) {
      saved.push([delegate, method, delegate[method]]);
      delegate[method] = () => {
        rejected++;
        return Promise.reject(new Error(`analytics table locked (probe): ${model}.${method}`));
      };
    }
  }
  return {
    restore: () => {
      for (const [delegate, method, fn] of saved) delegate[method] = fn as (...args: unknown[]) => unknown;
    },
    rejected: () => rejected,
  };
}

async function makeFixture(): Promise<{ userId: string; playId: string }> {
  const user = await prismaQuery.user.create({
    data: { address: `0xoffpath_${MODE}_${STAMP}`, provider: 'dev', displayName: 'Offpath Probe' },
    select: { id: true },
  });
  const play = await prismaQuery.play.create({
    data: {
      userId: user.id,
      game: 'lucky',
      status: 'pending',
      asset: 'BTC',
      oracleId: `probe_${STAMP}`,
      marketKey: '',
      durationSec: 30,
      expiry: BigInt(STAMP + 30_000),
      stake: 1_000_000n,
    },
    select: { id: true },
  });
  return { userId: user.id, playId: play.id };
}

async function cleanup(userId: string, playId: string): Promise<void> {
  await prismaQuery.play.deleteMany({ where: { id: playId } }).catch(() => {});
  await prismaQuery.event.deleteMany({ where: { userId } }).catch(() => {});
  await prismaQuery.errorEvent.deleteMany({ where: { fingerprint: FINGERPRINT } }).catch(() => {});
  await prismaQuery.errorGroup.deleteMany({ where: { fingerprint: FINGERPRINT } }).catch(() => {});
  await prismaQuery.user.deleteMany({ where: { id: userId } }).catch(() => {});
}

// The sequence out of services/plays.ts, verbatim in shape: capture the failure, track it, commit the row.
// If analytics can hurt a play, this is where it happens.
async function runProbe(mode: Mode): Promise<void> {
  const { userId, playId } = await makeFixture();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  const broken = mode === 'failing' ? breakAnalyticsWrites() : null;
  const published: string[] = [];
  const unsubscribe = onPlay(playId, () => published.push('fired'));

  try {
    const before = Date.now();
    captureError(new Error(`offpath probe ${mode}`), {
      kind: 'chain',
      playId,
      userId,
      fingerprint: FINGERPRINT,
      title: 'Off-path probe',
      context: { stage: 'mint' },
    });
    track(userId, 'game.play_error', { props: { game: 'lucky', code: 'PROBE' } });
    const captureMs = Date.now() - before;

    // captureError/track return void synchronously: a call that blocked would show up here as latency the
    // player pays for, which is the failure this rule exists to prevent.
    assert(captureMs < 50, `${mode}: capture blocked the caller for ${captureMs}ms`);

    const errored = await commitPlay(playId, { status: 'error' });
    assert(errored.status === 'error', `${mode}: play committed as ${errored.status}, expected error`);

    const opened = await commitPlay(playId, { status: 'open', openedAt: new Date(), entryCost: 1_000_000n, multiplier: 2.5 });
    assert(opened.status === 'open', `${mode}: play committed as ${opened.status}, expected open`);
    assert(opened.multiplier === 2.5, `${mode}: play row lost its committed fields`);
    assert(published.length === 2, `${mode}: the play bus fired ${published.length} times, expected 2`);

    const stored = await prismaQuery.play.findUnique({ where: { id: playId }, select: { status: true } });
    assert(stored?.status === 'open', `${mode}: the stored row reads ${stored?.status}, expected open`);

    await flushCaptures();
    await new Promise((r) => setTimeout(r, 50)); // let any stray rejection surface before we judge it
    assert(!unhandled.length, `${mode}: left ${unhandled.length} unhandled rejection(s) behind`);

    if (broken) {
      broken.restore();
      assert(broken.rejected() > 0, 'failing: the analytics writes were never even attempted');
    }

    // What each kill actually killed.
    const groups = await prismaQuery.errorGroup.count({ where: { fingerprint: FINGERPRINT } });
    const events = await prismaQuery.event.count({ where: { userId } });

    if (mode === 'off') {
      assert(ANALYTICS_OFF, 'off: PIPS_ANALYTICS_OFF=1 did not reach the module');
      assert(groups === 0, `off: recorded ${groups} error group(s) with the break-glass flag set`);
      assert(events === 0, `off: recorded ${events} event(s) with the break-glass flag set`);
      console.log(`  off      play committed, 0 groups, 0 events, capture returned in ${captureMs}ms`);
    } else if (mode === 'disabled') {
      assert(events === 0, `disabled: recorded ${events} event(s) with analytics.enabled false`);
      assert(groups === 1, `disabled: recorded ${groups} error group(s), expected 1 (errors are not gated by analytics.enabled)`);
      console.log(`  disabled play committed, 0 events, errors still captured by design, capture returned in ${captureMs}ms`);
    } else {
      assert(groups === 0, `failing: recorded ${groups} error group(s) while every write rejected`);
      assert(events === 0, `failing: recorded ${events} event(s) while every write rejected`);
      console.log(`  failing  play committed, ${broken?.rejected()} rejected write(s) swallowed, capture returned in ${captureMs}ms`);
    }
  } finally {
    unsubscribe();
    broken?.restore();
    process.off('unhandledRejection', onUnhandled);
    await cleanup(userId, playId);
  }
}

// A child booted with PIPS_ANALYTICS_OFF=1 runs one probe and exits. Only reachable via the parent below.
if (MODE) {
  await runProbe(MODE);
  process.exit(0);
}

console.log('verify-analytics-offpath: a play must commit with analytics off, disabled, and failing');

// 1. Break glass. Needs its own process, because the flag is read at import.
const child = Bun.spawn(['bun', import.meta.path, 'off'], {
  env: { ...process.env, PIPS_ANALYTICS_OFF: '1' },
  stdout: 'inherit',
  stderr: 'inherit',
});
const code = await child.exited;
assert(code === 0, `the PIPS_ANALYTICS_OFF=1 probe exited ${code}`);
assert(!ANALYTICS_OFF, 'the parent must run with the flag UNSET, or modes 2 and 3 prove nothing');

// 2. The product switch, applied through the real setter and read back through the real getter.
const previous = await getSetting('analytics.enabled');
const applied = await setSetting('analytics.enabled', false);
assert(applied.ok, `could not turn analytics.enabled off: ${applied.ok ? '' : applied.reason}`);
assert((await getSetting('analytics.enabled')) === false, 'analytics.enabled did not read back as false');
try {
  await runProbe('disabled');
} finally {
  await setSetting('analytics.enabled', previous);
}
assert((await getSetting('analytics.enabled')) === previous, 'analytics.enabled was not restored');

// 3. The tables locked.
await runProbe('failing');

console.log('verify-analytics-offpath passed: 3 kill paths, the play commits on all 3, nothing surfaced');
process.exit(0);
