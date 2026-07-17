// Real-mode RANGE entry benchmark, END TO END over the wire. This drives the EXACT path a player's
// browser takes, so the numbers are the ones the player actually feels, not a backend-internal slice:
//
//   1. POST /games/range/play  (Bearer JWT)  ->  the create returns 'pending' the instant the deal is
//      dealt. This is the ONLY thing the player waits on before the reels snap.  = tap -> reel snap.
//   2. Subscribe to GET /stream/plays/:id  (the SAME SSE the frontend opens after the create). The
//      client learns the position went live only when this stream reports status 'open'. That stream is
//      now EVENT-DRIVEN: the background mint's 'open' commit fires the in-process play-bus, so the frame
//      is pushed one RTT after the row flips, not on a poll interval (TRADE_REALTIME.md).  = tap ->
//      PLAYER SEES LIVE.
//   3. In parallel we tight-poll the Play row straight from Postgres (an instrument, NOT part of the
//      app) to catch the TRUE on-chain landing the moment the background mint flips the row 'open'.
//      = tap -> mint on chain.
//
// The gap between (2) and (3) is the detection lag: how long after the mint landed the client learned.
// With the event-driven SSE this should collapse to ~one RTT; a big number here means the emit isn't
// reaching this box (a split API/operator topology, TRADE_REALTIME.md §6) or the socket stalled.
//
//   cd backend && bun scripts/bench-range.ts [count] [stake] [widthPct]
//     count    number of plays          (default 3)
//     stake    DUSDC per play           (default 2, must sit in [MIN_STAKE, MAX_STAKE])
//     widthPct FULL band width, percent (default 0.10, the app's testnet default = +/-0.05%)
//
//   PIPS_BENCH_API_URL   which backend to hit (default http://localhost:3780, the frontend's
//                        VITE_API_URL). Point it at https://api.playpips.fun to time the deployed box,
//                        which also carries the operator-worker RPC contention a local follower never has.
//
// It signs as a real provisioned Privy user by minting THEIR session JWT (mintToken), the exact token
// the client holds after login, then lets the SERVER do the signing/mint under gas sponsorship, the
// real product path. Entry ONLY: it never cashes out and never settles, so it never touches the
// operator key. The opened positions ride to expiry and are settled later, same as a player who holds.
//
// Requires the target backend to be RUNNING (that is the whole point, it is the real path). The DB
// tight-poll assumes this script's DATABASE_URL is the same DB the target backend writes to (the
// standard shared-DB topology); if it isn't, the on-chain column just reads n/a and the felt number
// still stands.

import '../dotenv.ts';

import { MIN_STAKE, MAX_STAKE, PLAY_RATE_LIMIT_MS, PLAY_STREAM_INTERVAL_MS } from '../src/config/main-config.ts';
import { fromDusdcRaw } from '../src/lib/sui/config.ts';
import { explorerTxUrl } from '../src/lib/sui/client.ts';
import { getDusdcBalanceRaw } from '../src/lib/sui/dusdc.ts';
import { decodeOrderId, readWrapperBalanceRaw, resolveWrapper } from '../src/lib/sui/predict-real.ts';
import { prismaQuery } from '../src/lib/prisma.ts';
import { parseStake } from '../src/services/games.ts';
import { mintToken } from '../src/services/auth.ts';
import type { Play, User } from '../prisma/generated/client.js';

const COUNT = Number(process.argv[2]) || 3;
const STAKE = Number(process.argv[3]) || 2;
const WIDTH_PCT = Number(process.argv[4]) || 0.1;
const ASSET = 'BTC'; // real testnet Predict has one underlying (propbook id 1); every game routes to it
const API_BASE = (process.env.PIPS_BENCH_API_URL || 'http://localhost:3780').replace(/\/$/, '');
const WATCH_TIMEOUT_MS = 60_000; // a mint's worst case is well under this; past it the play errored/hung

const now = (): number => performance.now();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const usd = (raw: bigint | null | undefined): string => (raw == null ? '?' : fromDusdcRaw(raw).toFixed(2));
const px = (v: string | null | undefined): string =>
  v == null ? '?' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The public testnet fullnode rate-limits the chip-read setup (RESOURCE_EXHAUSTED / "Too Many
// Requests"). Retry those transient blips with backoff so picking a funded player never crashes the run.
const isRateLimited = (e: unknown): boolean => /too many requests|resource_exhausted|429|rate limit/i.test(e instanceof Error ? e.message : String(e));
async function withRetry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isRateLimited(e) || i === tries - 1) throw e;
      await sleep(500 * (i + 1));
    }
  }
  throw last;
}

function stats(ms: number[]): { min: number; p50: number; p90: number; max: number } {
  const s = [...ms].sort((a, b) => a - b);
  const at = (p: number): number => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { min: s[0], p50: at(0.5), p90: at(0.9), max: s[s.length - 1] };
}
const med = (ms: number[]): number => (ms.length ? stats(ms).p50 : 0);

// Real spendable chips = wallet DUSDC + the wrapper's internal balance (the way the real mint funds a
// play; a manager read is meaningless on testnet). Doubles as a wrapper warm-up for the picked player.
async function realChips(u: User): Promise<{ total: bigint; wallet: bigint; wrapper: bigint }> {
  const w = await withRetry(() => resolveWrapper(u.address, u.predictWrapperId));
  const [wallet, wrapper] = await Promise.all([
    withRetry(() => getDusdcBalanceRaw(u.address)),
    w.exists ? withRetry(() => readWrapperBalanceRaw(w.wrapperId, u.address)).catch(() => 0n) : Promise.resolve(0n),
  ]);
  return { total: wallet + wrapper, wallet, wrapper };
}

// --- the three timed hops of one real entry ---

// (1) The real create call the browser makes. Returns the pending play the instant the deal is dealt.
type DealtPlay = { id: string; entrySpot?: string; params: { lower?: string; upper?: string } };
async function createRangeOverHttp(jwt: string): Promise<DealtPlay> {
  const res = await fetch(`${API_BASE}/games/range/play`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ stake: STAKE, asset: ASSET, widthPct: WIDTH_PCT }),
  });
  const j = (await res.json()) as { success?: boolean; data?: { play: DealtPlay }; error?: { message?: string } };
  if (!res.ok || !j.success || !j.data) throw new Error(j.error?.message || `HTTP ${res.status}`);
  return j.data.play;
}

// (2) The SAME SSE the frontend subscribes to. Resolve the instant a frame reports a non-'pending'
// status, which is exactly when range.tsx flips `entered` and the locked band appears to the player.
async function watchSseLive(jwt: string, playId: string): Promise<{ at: number; status: string } | null> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), WATCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/stream/plays/${playId}?t=${encodeURIComponent(jwt)}`, {
      headers: { accept: 'text/event-stream' },
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const data = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!data) continue; // the `retry:` preamble / heartbeat, no payload
        try {
          const ev = JSON.parse(data.slice(data.indexOf(':') + 1).trim()) as { status?: string };
          if (ev.status && ev.status !== 'pending') return { at: now(), status: ev.status };
        } catch {
          // partial or non-JSON line, keep buffering
        }
      }
    }
  } catch {
    return null; // aborted (timeout) or the socket dropped
  } finally {
    clearTimeout(to);
    ctrl.abort();
  }
}

// (3) Instrument only: tight-poll Postgres to catch the TRUE on-chain landing the moment the background
// mint flips the row off 'pending'. This is decoupled from the SSE cadence, so SSE-minus-DB = the tax.
async function watchDbLive(playId: string): Promise<{ at: number; row: Play } | null> {
  const deadline = Date.now() + WATCH_TIMEOUT_MS;
  for (;;) {
    const row = await prismaQuery.play.findUnique({ where: { id: playId } });
    if (row && row.status !== 'pending') return { at: now(), row };
    if (Date.now() > deadline) return null;
    await sleep(120);
  }
}

// === setup ===
console.log(`\nPIPS RANGE entry benchmark  (real testnet Predict, END TO END over the wire)`);
console.log(`target  ${API_BASE}`);
console.log(`config  ${COUNT} play(s), $${STAKE} stake, band +/-${(WIDTH_PCT / 2).toFixed(3)}% (widthPct ${WIDTH_PCT})  SSE cadence ${PLAY_STREAM_INTERVAL_MS}ms\n`);

if (STAKE < MIN_STAKE || STAKE > MAX_STAKE) {
  console.error(`Stake $${STAKE} is outside the allowed range [$${MIN_STAKE}, $${MAX_STAKE}]. Pick another.`);
  process.exit(1);
}

// The target backend MUST be up, this is the real path. Fail loud and early if it isn't.
const reachable = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(5000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!reachable) {
  console.error(`Cannot reach ${API_BASE}/health. Start the backend (cd backend && bun dev) or set PIPS_BENCH_API_URL to a running box.`);
  process.exit(1);
}

// Pick a real player: a provisioned Privy user with a real wrapper and enough chips, and mint their JWT.
const candidates = await prismaQuery.user.findMany({
  where: { provider: 'privy', privyWalletId: { not: null }, suiPublicKey: { not: null } },
  orderBy: { createdAt: 'desc' },
});
let user: User | null = null;
let chips = { total: 0n, wallet: 0n, wrapper: 0n };
for (const u of candidates) {
  const c = await realChips(u).catch(() => null);
  if (c && c.total >= parseStake(STAKE)) {
    user = u;
    chips = c;
    break;
  }
}
if (!user) {
  console.error('No provisioned Privy user has enough chips for the stake. Fund one (or lower the stake) and retry.');
  console.error('Note: the dev/testing wallet cannot sign in privy mode (no embedded wallet), so it is not usable here.');
  process.exit(1);
}
const jwt = mintToken(user);
const affordable = Math.min(COUNT, Number(chips.total / parseStake(STAKE)));
console.log(`player  ${user.address.slice(0, 14)}...  wallet $${usd(chips.wallet)} + wrapper $${usd(chips.wrapper)} = chips $${usd(chips.total)}`);
if (affordable < COUNT) console.log(`(chips cover ${affordable} of ${COUNT} plays; running ${affordable})`);
console.log('');

// === per-play, end to end ===
const reelMs: number[] = []; // tap -> POST returns (reels snap)
const chainMs: number[] = []; // tap -> mint truly live on chain (DB flip)
const feltMs: number[] = []; // tap -> player SEES it live (SSE 'open')
const lagMs: number[] = []; // feltMs - chainMs, the detection tax
let landed = 0;
let lastCreateAt = 0;

for (let i = 0; i < affordable; i++) {
  // Respect the real per-user play rate limit (the server enforces it too; a real player can't spam).
  const since = Date.now() - lastCreateAt;
  if (lastCreateAt && since < PLAY_RATE_LIMIT_MS) await sleep(PLAY_RATE_LIMIT_MS - since + 100);

  const tap = now();
  lastCreateAt = Date.now();
  let dealt: DealtPlay;
  try {
    dealt = await createRangeOverHttp(jwt);
  } catch (e) {
    console.log(`#${i + 1}  ENTRY FAILED  ${e instanceof Error ? e.message : String(e)}`);
    continue;
  }
  const reel = now() - tap;
  reelMs.push(reel);

  // From here the frontend opens the SSE; we open it AND tight-poll the DB, both timed from the tap.
  const [sse, db] = await Promise.all([watchSseLive(jwt, dealt.id), watchDbLive(dealt.id)]);

  const felt = sse ? sse.at - tap : null;
  const chain = db ? db.at - tap : null;
  const status = sse?.status ?? db?.row.status ?? 'unknown';

  if (status !== 'open') {
    console.log(`#${i + 1}  $${STAKE} range   tap -> reel snap ${reel.toFixed(0)}ms, but the mint did NOT open (status ${status}; chips safe)\n`);
    continue;
  }
  landed++;
  if (felt != null) feltMs.push(felt);
  if (chain != null) chainMs.push(chain);
  if (felt != null && chain != null) lagMs.push(Math.max(0, felt - chain));

  const row = db?.row;
  const qty = row?.marketKey ? decodeOrderId(BigInt(row.marketKey)).quantityRaw : undefined;
  console.log(`#${i + 1}  $${STAKE} range   band $${px(dealt.params.lower)} .. $${px(dealt.params.upper)}   btc $${px(dealt.entrySpot)}`);
  console.log(`    tap -> reel snap (POST)   ${reel.toFixed(0).padStart(5)} ms`);
  console.log(`    tap -> mint on chain      ${chain == null ? '  n/a' : chain.toFixed(0).padStart(5)} ms${row ? `   x${(row.multiplier ?? 0).toFixed(2)}  lev ${(row.leverage ?? 0).toFixed(2)}  cost $${usd(row.entryCost)}  qty $${usd(qty)}` : ''}`);
  console.log(`    tap -> PLAYER SEES LIVE   ${felt == null ? '  n/a' : felt.toFixed(0).padStart(5)} ms   (SSE)`);
  if (felt != null && chain != null) console.log(`    detection lag             ${Math.max(0, felt - chain).toFixed(0).padStart(5)} ms   (mint landed, client had not polled yet)`);
  if (row?.txMint) console.log(`    ${explorerTxUrl(row.txMint)}`);
  console.log('');
}

// === the answer: what the player waits for, and where those seconds actually go ===
console.log('');
if (!feltMs.length) {
  console.log('No entries landed on chain (see errors above).');
  process.exit(1);
}
const felt = stats(feltMs);
const bar = '='.repeat(64);
console.log(bar);
console.log(`  RANGE ENTRY SPEED   (median of ${landed} play${landed > 1 ? 's' : ''}, $${STAKE} each)   ${API_BASE}`);
console.log('');
console.log(`  tap -> reel snap        ${med(reelMs).toFixed(0).padStart(5)} ms   POST returns, reels snap (what gates the animation)`);
if (chainMs.length) console.log(`  tap -> mint on chain    ${med(chainMs).toFixed(0).padStart(5)} ms   position truly live on chain (background mint)`);
console.log(`  tap -> PLAYER SEES LIVE ${felt.p50.toFixed(0).padStart(5)} ms   what the player actually waits for  <-- the real number`);
if (lagMs.length) console.log(`  detection lag           ${med(lagMs).toFixed(0).padStart(5)} ms   SSE poll granularity + connect (mint had landed already)`);
if (landed > 1) console.log(`  (player-felt range: ${felt.min.toFixed(0)}-${felt.max.toFixed(0)} ms)`);
console.log(bar);
console.log(`\nNote: this is the data-availability moment (SSE reports 'open'). The visible reveal is`);
console.log(`max(this, the reel spin animation). The SSE is now event-driven, so a healthy detection lag`);
console.log(`is ~one RTT; the mark cadence (PIPS_PLAY_STREAM_INTERVAL_MS, ${PLAY_STREAM_INTERVAL_MS}ms) no longer gates the entry.`);
console.log(`A detection lag still near that cadence means the mint's 'open' emit isn't reaching this box`);
console.log(`(split API/operator process, TRADE_REALTIME.md §6) or the SSE socket stalled.`);
process.exit(0);
