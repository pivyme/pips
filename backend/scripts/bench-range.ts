// Real-mode RANGE entry benchmark, self-contained (no running server needed). It drives the TRUE app
// entry path against Mysten's live testnet Predict and times what the player actually feels:
//
//   PRE-ENTRY   the click-time on-chain BTC spot the band is solved off (readBtcSpot), the same feed
//               load_live_pricer marks and settles the round against.
//   ENTRY       createPlay returns the instant the deal is dealt (status 'pending') -> the reel snaps.
//               This is the only thing the player waits on before the animation plays.
//   MINT LAND   the background mint (wrapper resolve + balance reads + build + Privy sign + sponsored
//               submit) flips the play 'open' ON CHAIN. Tight-polled so we time it precisely.
//   POSITION    the real minted band, multiplier, admitted leverage, cost, on-chain order id, and tx.
//
// Then a per-hop breakdown so we can see WHERE the entry seconds go (the thing we want to speed up).
//
//   cd backend && bun scripts/bench-range.ts [count] [stake] [widthPct]
//     count    number of plays          (default 3)
//     stake    DUSDC per play           (default 2, must sit in [MIN_STAKE, MAX_STAKE])
//     widthPct FULL band width, percent (default 0.10, the app's testnet default = +/-0.05%)
//
// Entry ONLY: it never cashes out and never settles, so it never touches the operator key and is safe
// to run anytime, even while the deployed operator is live. The opened positions ride to expiry and are
// settled later by the deployed operator (win/loss), the same as a real player who just holds.
//
// It signs as a provisioned Privy user (their own embedded wallet + gas sponsorship), the exact path the
// app signs a real play with, so the numbers are the real product's, not a shortcut.

import '../dotenv.ts';
import { Transaction } from '@mysten/sui/transactions';

import { EXPIRY_SAFETY_MS, MIN_STAKE, MAX_STAKE, PLAY_RATE_LIMIT_MS, PLAY_GAS_BUDGET, IS_REAL_PREDICT } from '../src/config/main-config.ts';
import { fromDusdcRaw } from '../src/lib/sui/config.ts';
import { suiClient, explorerTxUrl } from '../src/lib/sui/client.ts';
import { REAL_BTC_ASSET } from '../src/lib/sui/config-real.ts';
import { allMarkets, liveByAsset, removeMarket, upsertMarket } from '../src/lib/sui/markets.ts';
import { getDusdcBalanceRaw } from '../src/lib/sui/dusdc.ts';
import { signSuiTxWithPrivy } from '../src/lib/sui/privy.ts';
import { SPONSOR_ENABLED, applySponsorGas } from '../src/lib/sui/sponsor.ts';
import {
  buildMintPlay,
  decodeOrderId,
  isMinuteExpiry,
  readActiveMarketIds,
  readBtcSpot,
  readMarketCoarse,
  readMarketEconomics,
  readWrapper,
  readWrapperBalanceRaw,
  resolveWrapper,
} from '../src/lib/sui/predict-real.ts';
import { prismaQuery } from '../src/lib/prisma.ts';
import { createPlay } from '../src/services/plays.ts';
import { parseStake, resolveReal } from '../src/services/games.ts';
import type { User } from '../prisma/generated/client.js';

const COUNT = Number(process.argv[2]) || 3;
const STAKE = Number(process.argv[3]) || 2;
const WIDTH_PCT = Number(process.argv[4]) || 0.1;
const ASSET = 'BTC'; // real testnet Predict has one underlying (propbook id 1); every game routes to it

const now = () => performance.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usd = (raw: bigint | null | undefined) => (raw == null ? '?' : fromDusdcRaw(raw).toFixed(2));
const px = (v: string | null | undefined) => (v == null ? '?' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

if (!IS_REAL_PREDICT) {
  console.error('bench-range targets real testnet Predict (SUI_NETWORK=testnet). Current mode is the fork; nothing to benchmark here.');
  process.exit(1);
}
if (STAKE < MIN_STAKE || STAKE > MAX_STAKE) {
  console.error(`Stake $${STAKE} is outside the allowed range [$${MIN_STAKE}, $${MAX_STAKE}]. Pick another.`);
  process.exit(1);
}

// Discover the live BTC market(s) straight from chain, exactly like the market-sync worker's real path
// (readActiveMarketIds -> per-market coarse + economics). Standalone, so the bench needs no running
// server; called before each play so a mid-run expiry never starves the market pick.
async function discoverRealMarkets(): Promise<void> {
  const t = Date.now();
  const underlyingId = REAL_BTC_ASSET?.propbookUnderlyingId ?? 1;
  const spot = await readBtcSpot();
  const ids = await readActiveMarketIds();
  await Promise.all(
    ids.map(async (marketId) => {
      try {
        const c = await readMarketCoarse(marketId);
        if (!c || c.settled || c.mintPaused) return;
        if (c.underlyingId !== underlyingId || !isMinuteExpiry(c.expiryMs)) return;
        if (c.expiryMs - t <= EXPIRY_SAFETY_MS) return;
        const e = await readMarketEconomics(marketId);
        upsertMarket({
          oracleId: marketId,
          capId: '',
          underlying: ASSET,
          expiryMs: c.expiryMs,
          minStrike: '0',
          tickSize: e.tickSizeRaw.toString(),
          settled: false,
          spot1e9: spot ? spot.spot1e9.toString() : undefined,
          lastPushAt: spot ? t : undefined,
          admissionTickSizeRaw: e.admissionTickSizeRaw.toString(),
          maxLeverage1e9: e.maxLeverage1e9.toString(),
          liquidationLtv1e9: e.liquidationLtv1e9.toString(),
        });
      } catch {
        // one bad/gone market, skip it
      }
    }),
  );
  for (const m of allMarkets()) if (m.settled || m.expiryMs <= t) removeMarket(m.oracleId);
}

// Real spendable chips = wallet DUSDC + the wrapper's internal balance, computed the way mintPendingReal
// does (the fork's playableBalanceRaw reads a manager, which is meaningless on testnet). Doubles as a
// wrapper warm-up so the first play doesn't eat a cold derive.
async function realChips(user: User): Promise<{ total: bigint; wallet: bigint; wrapper: bigint; wrapperId: string; wrapperExists: boolean }> {
  const w = await resolveWrapper(user.address, user.predictWrapperId);
  const [wallet, wrapper] = await Promise.all([
    getDusdcBalanceRaw(user.address),
    w.exists ? readWrapperBalanceRaw(w.wrapperId, user.address).catch(() => 0n) : Promise.resolve(0n),
  ]);
  return { total: wallet + wrapper, wallet, wrapper, wrapperId: w.wrapperId, wrapperExists: w.exists };
}

function stats(ms: number[]): { min: number; p50: number; p90: number; max: number; avg: number } {
  const s = [...ms].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { min: s[0], p50: at(0.5), p90: at(0.9), max: s[s.length - 1], avg: s.reduce((a, b) => a + b, 0) / s.length };
}
// Median of a small sample for the per-hop breakdown.
async function timeHop(n: number, fn: () => Promise<unknown>): Promise<{ med: number; err?: string }> {
  const ts: number[] = [];
  let err: string | undefined;
  for (let i = 0; i < n; i++) {
    const s = now();
    try {
      await fn();
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    ts.push(now() - s);
  }
  ts.sort((a, b) => a - b);
  return { med: ts[Math.floor(ts.length / 2)], err };
}

// --- pick a real player: a provisioned Privy user with a real wrapper and enough chips ---
console.log(`\nPIPS RANGE entry benchmark  (real testnet Predict)`);
console.log(`config: ${COUNT} play(s), $${STAKE} stake, band +/-${(WIDTH_PCT / 2).toFixed(3)}% (widthPct ${WIDTH_PCT})  sponsor=${SPONSOR_ENABLED ? 'on' : 'off'}\n`);

await discoverRealMarkets();
if (liveByAsset(ASSET, Date.now(), EXPIRY_SAFETY_MS).length === 0) {
  console.error('No live BTC market on chain right now (mid-roll gap). Try again in a few seconds.');
  process.exit(1);
}

const candidates = await prismaQuery.user.findMany({
  where: { provider: 'privy', privyWalletId: { not: null }, suiPublicKey: { not: null } },
  orderBy: { createdAt: 'desc' },
});
let user: User | null = null;
let chips = { total: 0n, wallet: 0n, wrapper: 0n, wrapperId: '', wrapperExists: false };
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

const affordable = Math.min(COUNT, Number(chips.total / parseStake(STAKE)));
console.log(`player  ${user.address.slice(0, 14)}...  wallet $${usd(chips.wallet)} + wrapper $${usd(chips.wrapper)} = chips $${usd(chips.total)}`);
console.log(`wrapper ${chips.wrapperId.slice(0, 14)}...  ${chips.wrapperExists ? 'exists' : 'FIRST PLAY (create folded into the mint)'}`);
if (affordable < COUNT) console.log(`(chips cover ${affordable} of ${COUNT} plays; running ${affordable})`);
console.log('');

// === Section A: end-to-end entry, the real app path ===
const entryMs: number[] = []; // tap -> reel snap (createPlay returns)
const mintMs: number[] = []; // reel snap -> on-chain OPEN (background mint)
const totalMs: number[] = []; // tap -> position live on chain (entry + mint), the headline number
let landed = 0;
let lastCreateAt = 0;

for (let i = 0; i < affordable; i++) {
  // Respect the real per-user play rate limit (a real player can't spam faster either).
  const since = Date.now() - lastCreateAt;
  if (lastCreateAt && since < PLAY_RATE_LIMIT_MS) await sleep(PLAY_RATE_LIMIT_MS - since + 100);
  await discoverRealMarkets(); // keep the market pool fresh (mirrors the market-sync worker)

  const s = now();
  lastCreateAt = Date.now();
  let dealt;
  try {
    dealt = (await createPlay(user, { game: 'range', stake: STAKE, asset: ASSET, widthPct: WIDTH_PCT })).play;
  } catch (e) {
    console.log(`#${i + 1}  ENTRY FAILED  ${e instanceof Error ? e.message : String(e)}`);
    continue;
  }
  const entry = now() - s;
  entryMs.push(entry);

  const rp = dealt.params as { lower: string; upper: string; widthPct: number };

  // MINT LAND: tight-poll the DB row until the background mint flips it off 'pending'.
  const ms = now();
  let row = await prismaQuery.play.findUnique({ where: { id: dealt.id } });
  for (let w = 0; w < 200 && row?.status === 'pending'; w++) {
    await sleep(120);
    row = await prismaQuery.play.findUnique({ where: { id: dealt.id } });
  }
  const mint = now() - ms;

  if (row?.status === 'open' && row.marketKey) {
    const total = entry + mint; // tap -> position live on chain
    mintMs.push(mint);
    totalMs.push(total);
    landed++;
    const decoded = decodeOrderId(BigInt(row.marketKey));
    console.log(`#${i + 1}  $${STAKE} range   band $${px(rp.lower)} .. $${px(rp.upper)}   btc $${px(dealt.entrySpot)}`);
    console.log(`    tap -> reel snap      ${entry.toFixed(0).padStart(5)} ms`);
    console.log(`    tap -> live on chain  ${total.toFixed(0).padStart(5)} ms   x${(row.multiplier ?? 0).toFixed(2)}  lev ${(row.leverage ?? 0).toFixed(2)}  cost $${usd(row.entryCost)}  qty $${usd(decoded.quantityRaw)}`);
    if (row.txMint) console.log(`    ${explorerTxUrl(row.txMint)}`);
  } else {
    console.log(`#${i + 1}  $${STAKE} range   tap -> reel snap ${entry.toFixed(0)}ms, but mint did NOT open (status ${row?.status ?? 'gone'}; chips safe)`);
  }
  console.log('');
}

// === Section B: per-hop breakdown (where the entry seconds go) ===
// Read-only: it resolves a fresh deal and times each remote round trip the mint makes, and signs the
// built bytes with Privy WITHOUT submitting, so it never places a position. The submit+confirm cost is
// the remainder of MINT LAND above (it's the only hop we can't measure without actually minting).
console.log('--- per-hop latency (why an entry costs what it does; read-only, no submit) ---');
await discoverRealMarkets();
try {
  const stakeRaw = parseStake(STAKE);
  const resolved = await resolveReal({ game: 'range', stake: STAKE, asset: ASSET, widthPct: WIDTH_PCT }, stakeRaw, stakeRaw);

  const btc = await timeHop(4, () => readBtcSpot());
  const wrapperCold = await timeHop(3, () => readWrapper(user.address));
  const wbal = await timeHop(4, () => readWrapperBalanceRaw(chips.wrapperId, user.address));
  const dusdc = await timeHop(4, () => getDusdcBalanceRaw(user.address));

  const gasPrice = BigInt((await suiClient.getReferenceGasPrice()).referenceGasPrice);
  const depositRaw = resolved.depositCeilRaw > chips.wrapper ? resolved.depositCeilRaw - chips.wrapper : 0n;
  const freshMintTx = (): Transaction => {
    const tx = new Transaction();
    buildMintPlay(tx, {
      marketId: resolved.marketId,
      wrapperId: chips.wrapperId,
      wrapperExists: chips.wrapperExists,
      depositRaw,
      amountRaw: resolved.amountRaw,
      minQuantityRaw: resolved.minQuantityRaw,
      leverage1e9: resolved.leverage1e9,
      lowerTick: resolved.lowerTick,
      higherTick: resolved.higherTick,
      rakeRaw: 0n,
    });
    tx.setSender(user.address);
    if (SPONSOR_ENABLED) applySponsorGas(tx);
    tx.setGasPrice(gasPrice);
    tx.setGasBudget(PLAY_GAS_BUDGET);
    return tx;
  };

  const build = await timeHop(3, async () => {
    await freshMintTx().build({ client: suiClient });
  });

  let sign: { med: number; err?: string } = { med: 0 };
  if (user.privyWalletId && user.suiPublicKey && !build.err) {
    const txBytes = await freshMintTx().build({ client: suiClient });
    sign = await timeHop(3, () => signSuiTxWithPrivy({ walletId: user!.privyWalletId!, publicKey: user!.suiPublicKey!, txBytes }));
  }

  const hop = (label: string, r: { med: number; err?: string }) =>
    console.log(`${label.padEnd(34)} med ${r.med.toFixed(0).padStart(5)} ms${r.err ? `   x ${r.err.slice(0, 60)}` : ''}`);
  hop('readBtcSpot (pre-entry price)', btc);
  hop('resolveWrapper cold (1st play)', wrapperCold);
  console.log(`${'resolveWrapper cached (hot path)'.padEnd(34)} med     0 ms   (app reuses User.predictWrapperId, no RPC)`);
  hop('readWrapperBalanceRaw', wbal);
  hop('getDusdcBalanceRaw', dusdc);
  hop('tx.build (sponsored, pinned gas)', build);
  hop('signSuiTxWithPrivy (Privy SaaS)', sign);

  if (mintMs.length) {
    const mintP50 = stats(mintMs).p50;
    const measured = wbal.med + dusdc.med + build.med + sign.med; // the hot-path mint hops we can time
    const residual = Math.max(0, mintP50 - measured);
    console.log(`${'submit+confirm (residual of MINT)'.padEnd(34)} ~   ${residual.toFixed(0).padStart(5)} ms   (MINT p50 ${mintP50.toFixed(0)} minus the timed hops)`);
  }
} catch (e) {
  console.log(`per-hop breakdown skipped: ${e instanceof Error ? e.message : String(e)}`);
}

// === The answer: how long from tapping the button to the position being live on chain ===
console.log('');
if (!totalMs.length) {
  console.log('No entries landed on chain (see errors above).');
  process.exit(1);
}
const snap = stats(entryMs);
const total = stats(totalMs);
const bar = '='.repeat(56);
console.log(bar);
console.log(`  RANGE ENTRY SPEED   (median of ${landed} play${landed > 1 ? 's' : ''}, $${STAKE} each)`);
console.log('');
console.log(`  tap -> reel snap        ${snap.p50.toFixed(0).padStart(5)} ms    what the player feels (instant)`);
console.log(`  tap -> LIVE ON CHAIN    ${total.p50.toFixed(0).padStart(5)} ms    position fully placed & confirmed`);
if (landed > 1) console.log(`  (on-chain range: ${total.min.toFixed(0)}-${total.max.toFixed(0)} ms)`);
console.log(bar);
process.exit(0);
