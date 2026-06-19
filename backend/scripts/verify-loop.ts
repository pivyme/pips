// Phase 7 gate: prove the real LUCKY chain loop end to end in DEV mode against the live
// localnet, without needing the cron workers or a browser. It is deterministic and reusable,
// so the same script doubles as a server-side doctor before turning the operator workers on.
//
// What it proves (LUCKY.md §14 Group 2):
//   1. A fresh oracle ladder stands up for all three assets (BTC/SUI/ETH) and passes the 30s
//      freshness gate right after a price push.
//   2. The §5 tier -> strike solver queries the live Predict preview (get_trade_amounts
//      devInspect) and returns a real, mintable grid strike per tier, with the reported
//      multiplier read straight off the chain (never a nominal).
//   3. A full round trip: place a real Lucky play (mint digest) -> live mark climbs ->
//      CASH OUT (redeem); a second play held to settle as a WIN; then a forced LOSS. The USDC
//      balance moves correctly each time and STREAK updates.
//
// Run from backend/:  bun run scripts/verify-loop.ts
//
// It uses the SAME service + wrapper code the API and workers use (resolveLucky, the solver,
// buildMint/buildRedeem, settleDuePlays), so a green run here is a green real loop. The real
// 30s worker ladder (oracle-roll + price-pusher at the production cadence) is proven separately
// by booting the backend; here the working oracles are longer lived and re-pushed before each
// use, so the slow one-shot remote setup never races the 30s expiry while we scan strikes.

import '../dotenv.ts';

import { Transaction } from '@mysten/sui/transactions';

import { suiClient, explorerTxUrl } from '../src/lib/sui/client.ts';
import { operatorAddress } from '../src/lib/sui/signer.ts';
import { getDusdcBalance, mintDusdc } from '../src/lib/sui/dusdc.ts';
import {
  PREDICT_ID,
  ORACLE_CAP_IDS,
  ORACLE_STRIKE_GRID_TICKS,
  gridForSpot,
  usd1e9,
} from '../src/lib/sui/config.ts';
import { AUTH_MODE, EXPIRY_SAFETY_MS } from '../src/config/main-config.ts';
import { fetchSpot } from '../src/lib/pyth.ts';
import {
  buildCreateOracle,
  buildActivateOracle,
  buildCreateManager,
  appendPriceUpdate,
  readOracle,
  previewMint,
  type Side,
} from '../src/lib/sui/predict.ts';
import { executeAsOperator } from '../src/lib/sui/execute.ts';
import { allMarkets, removeMarket, upsertMarket, getMarket, liveByAsset } from '../src/lib/sui/markets.ts';
import { solveStrike } from '../src/lib/sui/solver.ts';
import { ensureUser } from '../src/services/auth.ts';
import { createPlay, cashoutPlay, getLiveMarkRaw, settleDuePlays } from '../src/services/plays.ts';
import { prismaQuery } from '../src/lib/prisma.ts';
import { toDusdcRaw } from '../src/lib/sui/math.ts';

const ASSETS = ['BTC', 'SUI', 'ETH'] as const;
const LONG_MS = 180_000; // working-oracle life: survives the slow sequential remote setup
const SHORT_MS = 28_000; // settle-test oracle: room for the solve+mint, then settles in seconds
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const dp = (asset: string): number => (asset === 'SUI' ? 4 : 2);

let failed = false;
const pass = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failed = true;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`);
};
const info = (label: string, detail = ''): void => console.log(`  ${label}${detail ? `  ${detail}` : ''}`);

const findCreatedOracle = (changes: Array<{ type: string; objectId?: string; objectType?: string }>): string => {
  const c = changes.find((x) => x.type === 'created' && x.objectType?.endsWith('::oracle::OracleSVI'));
  if (!c?.objectId) throw new Error('create_oracle returned no OracleSVI object');
  return c.objectId;
};

// Stand up one live oracle for an asset at the given expiry (mirrors oracle-roll), seed the
// in-process market cache, and return its id. The cap is the bootstrapped operator cap.
async function standUpOracle(asset: string, spot: number, expiryMs: number): Promise<string> {
  const capId = ORACLE_CAP_IDS[0];
  if (!capId) throw new Error('no oracle cap in config; run the bootstrap first');
  const { minStrike, tickSize } = gridForSpot(asset, spot);

  const createTx = new Transaction();
  buildCreateOracle(createTx, capId, asset, expiryMs, minStrike, tickSize);
  const oracleId = findCreatedOracle((await executeAsOperator(createTx, `create ${asset} oracle`)).objectChanges);

  const liveTx = new Transaction();
  buildActivateOracle(liveTx, oracleId, capId, spot); // includes the first price push
  await executeAsOperator(liveTx, `activate ${asset} oracle`);

  upsertMarket({
    oracleId,
    capId,
    underlying: asset,
    expiryMs,
    minStrike: String(minStrike),
    tickSize: String(tickSize),
    settled: false,
    spot1e9: String(usd1e9(spot)),
    lastPushAt: Date.now(),
  });
  return oracleId;
}

// Push a chosen price onto an oracle (operator). Pre-expiry this is a live tick that also
// resets the 30s staleness clock; at/after expiry it freezes the settlement price
// (oracle.move update_prices), which is how we force a deterministic WIN or LOSS at settle.
async function pushPrice(oracleId: string, priceUsd: number): Promise<string> {
  const tx = new Transaction();
  appendPriceUpdate(tx, oracleId, ORACLE_CAP_IDS[0], priceUsd);
  const digest = (await executeAsOperator(tx, `price-push ${oracleId.slice(0, 8)}`)).digest;
  const m = getMarket(oracleId);
  if (m) {
    m.spot1e9 = String(usd1e9(priceUsd));
    m.lastPushAt = Date.now();
  }
  return digest;
}

// Re-push the current Pyth spot onto an asset's working oracle so it is fresh (< 30s) right
// before we scan strikes or place a play, exactly as the price-pusher does every ~2s in prod.
async function refresh(oracleId: string, asset: string): Promise<void> {
  await pushPrice(oracleId, await fetchSpot(asset));
}

// Guard against a stale PredictManager id: if the DB row points at a manager that does not
// exist on this deployment (e.g. the row predates a redeploy), create a fresh one and persist
// it. Returns the id that is actually live on chain.
async function ensureManagerOnChain(userId: string, storedId: string | null): Promise<string> {
  if (storedId) {
    const obj = await suiClient.getObject({ id: storedId, options: {} });
    if (obj.data) return storedId;
    info('manager', `stored ${storedId.slice(0, 10)} not on this chain, creating a fresh PredictManager`);
  }
  const tx = new Transaction();
  buildCreateManager(tx);
  const created = (await executeAsOperator(tx, 'create_manager')).objectChanges.find(
    (c) => c.type === 'created' && c.objectType?.includes('::predict_manager::PredictManager'),
  );
  if (!created?.objectId) throw new Error('create_manager returned no PredictManager id');
  await prismaQuery.user.update({ where: { id: userId }, data: { predictManagerId: created.objectId } });
  return created.objectId;
}

async function vaultBalance(): Promise<number> {
  const obj = await suiClient.getObject({ id: PREDICT_ID, options: { showContent: true } });
  const c = obj.data?.content as { dataType?: string; fields?: { vault?: { fields?: { balance?: string } } } } | undefined;
  const raw = c?.dataType === 'moveObject' ? c.fields?.vault?.fields?.balance : undefined;
  return raw ? Number(raw) / 1_000_000 : 0;
}

const money = (raw: bigint): string => `$${(Number(raw) / 1_000_000).toFixed(2)}`;

async function gasSui(): Promise<number> {
  const b = await suiClient.getBalance({ owner: operatorAddress, coinType: '0x2::sui::SUI' });
  return Number(b.totalBalance) / 1e9;
}

async function main(): Promise<void> {
  console.log(`\nPips LUCKY loop verification (network=localnet, AUTH_MODE=${AUTH_MODE})\n`);
  if (AUTH_MODE !== 'dev') throw new Error('verify-loop expects AUTH_MODE=dev (operator-signed plays)');

  // --- Funds + onboarding ---
  console.log('Funds + operator');
  const gas = await gasSui();
  pass('operator gas healthy (>= 5 SUI)', gas >= 5, `${gas.toFixed(2)} SUI`);
  const vault = await vaultBalance();
  pass('vault has liquidity (>= $500)', vault >= 500, `${vault.toFixed(2)} DUSDC`);

  // The operator is the dev-mode user. ensureUser is idempotent: guarantees the row, stats,
  // and the PredictManager. Top the wallet up so test stakes always have chips.
  let user = await ensureUser({ address: operatorAddress, provider: 'dev' });
  const managerId = await ensureManagerOnChain(user.id, user.predictManagerId);
  if (managerId !== user.predictManagerId) user = await prismaQuery.user.findUniqueOrThrow({ where: { id: user.id } });
  if ((await getDusdcBalance(operatorAddress)) < 200) await mintDusdc(operatorAddress, 500);
  info('operator user', `${user.id} manager ${managerId.slice(0, 10)} chips $${(await getDusdcBalance(operatorAddress)).toFixed(2)}`);

  // Drop any stale cache entries (the bootstrap seed oracle is long expired) so routing only
  // ever sees the oracles this run stands up.
  for (const m of allMarkets()) removeMarket(m.oracleId);

  // === 1. Fresh oracle ladder for all three assets + 30s freshness gate ===
  console.log('\n1) Oracle ladder (BTC/SUI/ETH) + 30s freshness gate');
  const ladder: Record<string, string> = {};
  for (const asset of ASSETS) {
    const spot = await fetchSpot(asset);
    const oracleId = await standUpOracle(asset, spot, Date.now() + LONG_MS);
    ladder[asset] = oracleId;
    const st = await readOracle(oracleId);
    const ageMs = st ? Date.now() - st.timestampMs : Infinity;
    const fresh = !!st && st.active && !st.settled && ageMs < 30_000 && st.spot1e9 > 0n;
    pass(`${asset} oracle live + fresh (< 30s)`, fresh, st ? `spot $${(Number(st.spot1e9) / 1e9).toFixed(dp(asset))}, age ${(ageMs / 1000).toFixed(1)}s, ${oracleId.slice(0, 10)}` : 'no oracle');
  }
  pass('all three assets tradeable', ASSETS.every((a) => liveByAsset(a, Date.now(), EXPIRY_SAFETY_MS).length > 0));
  info('note', 'production cadence is a 30s ladder refreshed every ~2s (ORACLE_LIFETIME_MS); proven live with the real workers separately. These working oracles are longer lived so the one-shot setup does not race expiry.');

  // === 2. Tier -> strike solver against the LIVE Predict preview ===
  console.log('\n2) Tier -> strike solver vs live preview (a couple tiers per asset)');
  const probeTiers = [2, 5];
  const betRaw = toDusdcRaw(25);
  for (const asset of ASSETS) {
    const oracleId = ladder[asset];
    await refresh(oracleId, asset); // keep it inside the 30s gate before the scan
    const m = getMarket(oracleId)!;
    const tick = BigInt(m.tickSize);
    const min = BigInt(m.minStrike);
    const grid = { tick, min, max: min + tick * (ORACLE_STRIKE_GRID_TICKS - 1n) };
    for (const tier of probeTiers) {
      const side: Side = 'up';
      try {
        const sol = await solveStrike({
          grid,
          side,
          tierMultiplier: tier,
          betRaw,
          preview: (strike1e9, quantity) => previewMint({ oracleId, expiryMs: m.expiryMs, strike1e9, side, quantity }),
        });
        // Honest + mintable is the bar: a real grid strike, cost within the bet, a finite
        // multiple read off the live preview. Clamping to the nearest achievable tier is a
        // valid outcome, not a failure (LUCKY.md §5).
        const ok = sol.entryCost > 0n && sol.entryCost <= betRaw && Number.isFinite(sol.multiplier) && sol.multiplier > 1;
        pass(
          `${asset} ${tier}x -> solved ${sol.multiplier.toFixed(2)}x`,
          ok,
          `strike $${(Number(sol.strike1e9) / 1e9).toFixed(dp(asset))}, cost ${money(sol.entryCost)} of ${money(betRaw)}${sol.clamped ? ' [clamped to nearest achievable]' : ''}`,
        );
      } catch (e) {
        pass(`${asset} ${tier}x solvable`, false, e instanceof Error ? e.message : String(e));
      }
    }
  }

  // === 3a. Round trip: real mint -> live mark climbs -> CASH OUT (redeem) ===
  // Route to a single fresh oracle stood up right before the play, so the solver scan + mint
  // both land well inside the 30s staleness window (the multi-asset refresh loop above can let
  // the dealt oracle age out before the mint executes on a slow remote node).
  console.log('\n3a) Cash-out round trip (mint -> mark climbs -> redeem)');
  for (const m of allMarkets()) removeMarket(m.oracleId);
  await standUpOracle('BTC', await fetchSpot('BTC'), Date.now() + LONG_MS);
  const before3a = await getDusdcBalance(operatorAddress);
  const created = await createPlay(user, { game: 'lucky', stake: 25 });
  if (created.mode !== 'dev') throw new Error('expected dev-mode play');
  const dto = created.play;
  const side = ('side' in dto.params ? dto.params.side : 'up') ?? 'up';
  const strike = Number(dto.market.strike ?? '0');
  info('minted', `${dto.multiplier.toFixed(2)}x ${dto.market.asset} ${String(side).toUpperCase()} strike $${strike}, entry $${dto.entryValue}`);
  pass('mint tx on chain', Boolean(dto.txMint), dto.txMint ? explorerTxUrl(dto.txMint) : '');

  const playRow = await prismaQuery.play.findUniqueOrThrow({ where: { id: dto.id } });
  const mark0 = await getLiveMarkRaw(playRow);
  // Push a tick decisively past the strike in the play's favour (~2%), like the price-pusher
  // feeding a real move, so the live mark climbs into the green before cash out.
  const favorable = side === 'down' ? strike * 0.98 : strike * 1.02;
  await pushPrice(playRow.oracleId, favorable);
  await sleep(1200);
  const mark1 = await getLiveMarkRaw(playRow);
  pass('live mark climbed on a favorable move', mark1 > mark0, `${money(mark0)} -> ${money(mark1)}`);

  const cash = await cashoutPlay(user, dto.id);
  if (cash.mode !== 'dev') throw new Error('expected dev-mode cashout');
  pass('redeem tx on chain', Boolean(cash.play.txRedeem), cash.play.txRedeem ? explorerTxUrl(cash.play.txRedeem) : '');
  info('cashed out', `payout $${cash.play.payout ?? '0'}, pnl $${cash.play.pnl}`);
  const after3a = await getDusdcBalance(operatorAddress);
  pass('USDC balance moved (real position)', after3a !== before3a, `$${before3a.toFixed(2)} -> $${after3a.toFixed(2)}`);

  // === 3b + 3c. Held to settle: a forced WIN, then a forced LOSS, with STREAK ===
  // Route these to a short-lived oracle so settlement lands in seconds. Clear the cache so the
  // play picks the short oracle, then force the settlement price ITM (win) or OTM (loss).
  const runSettle = async (outcome: 'win' | 'lose'): Promise<void> => {
    for (const m of allMarkets()) removeMarket(m.oracleId);
    const asset = 'BTC';
    const spot = await fetchSpot(asset);
    const oracleId = await standUpOracle(asset, spot, Date.now() + SHORT_MS);

    const statsBefore = await prismaQuery.userStats.findUniqueOrThrow({ where: { userId: user.id } });
    const balBefore = await getDusdcBalance(operatorAddress);
    const res = await createPlay(user, { game: 'lucky', stake: 25 });
    if (res.mode !== 'dev') throw new Error('expected dev-mode play');
    const p = await prismaQuery.play.findUniqueOrThrow({ where: { id: res.play.id } });
    const key = JSON.parse(p.marketKey) as { side: Side; strike1e9: string };
    const strikeUsd = Number(BigInt(key.strike1e9)) / 1e9;
    info(`${outcome} play`, `${res.play.multiplier.toFixed(2)}x ${p.asset} ${key.side.toUpperCase()} strike $${strikeUsd.toFixed(2)}, entry $${res.play.entryValue}`);

    // Settlement that lands the play ITM (win) or OTM (lose) for its side. up wins above the
    // strike, down wins below it; nudge just past the strike either way.
    const winSide = key.side === 'up' ? strikeUsd * 1.004 : strikeUsd * 0.996;
    const loseSide = key.side === 'up' ? strikeUsd * 0.996 : strikeUsd * 1.004;
    const settlePrice = outcome === 'win' ? winSide : loseSide;

    // Wait out the expiry, then freeze settlement at the chosen price and run the settle path.
    while (Date.now() <= Number(p.expiry)) await sleep(500);
    const setDigest = await pushPrice(oracleId, settlePrice); // freezes settlement (post-expiry)
    const st = await readOracle(oracleId);
    info('settled oracle', `settlement $${st?.settlementPrice1e9 ? (Number(st.settlementPrice1e9) / 1e9).toFixed(2) : '?'}, ${explorerTxUrl(setDigest)}`);
    await settleDuePlays();

    const settled = await prismaQuery.play.findUniqueOrThrow({ where: { id: p.id } });
    const statsAfter = await prismaQuery.userStats.findUniqueOrThrow({ where: { userId: user.id } });
    const balAfter = await getDusdcBalance(operatorAddress);
    if (outcome === 'win') {
      pass('play settled WON', settled.status === 'won', `payout ${settled.payout != null ? money(settled.payout) : 'n/a'}, pnl ${settled.pnl != null ? money(settled.pnl) : 'n/a'}`);
      pass('STREAK advanced on win', statsAfter.currentStreak > statsBefore.currentStreak, `${statsBefore.currentStreak} -> ${statsAfter.currentStreak} (max ${statsAfter.maxStreak})`);
      pass('balance up after win', balAfter > balBefore, `$${balBefore.toFixed(2)} -> $${balAfter.toFixed(2)}`);
      if (settled.txRedeem) info('win redeem tx', explorerTxUrl(settled.txRedeem));
    } else {
      pass('play settled LOST', settled.status === 'lost', `payout ${settled.payout != null ? money(settled.payout) : 'n/a'}, pnl ${settled.pnl != null ? money(settled.pnl) : 'n/a'}`);
      pass('STREAK reset on loss', statsAfter.currentStreak < statsBefore.currentStreak && statsAfter.currentStreak <= 0, `${statsBefore.currentStreak} -> ${statsAfter.currentStreak}`);
      pass('balance down after loss (stake lost)', balAfter < balBefore, `$${balBefore.toFixed(2)} -> $${balAfter.toFixed(2)}`);
    }
  };

  console.log('\n3b) Held to settle: forced WIN');
  await runSettle('win');
  console.log('\n3c) Held to settle: forced LOSS');
  await runSettle('lose');

  console.log(
    `\n${failed ? 'LOOP VERIFICATION HAD FAILURES, see above.' : 'LOOP VERIFICATION GREEN: 3-asset ladder fresh, solver honest off live preview, real mint/redeem + settle, balance + STREAK move.'}\n`,
  );
  console.log('note: explorer links use suiscan/localnet; our private node is not publicly indexed, so the digests are real on-chain but the links resolve only against a node-aware explorer.\n');
}

main()
  .then(() => prismaQuery.$disconnect())
  .then(() => process.exit(failed ? 1 : 0))
  .catch(async (e) => {
    console.error('\nverify-loop error:', e instanceof Error ? e.stack || e.message : e);
    await prismaQuery.$disconnect();
    process.exit(1);
  });
