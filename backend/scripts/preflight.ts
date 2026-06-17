// Day-of preflight + golden-path rehearsal. Read-only by default: checks the deployed ids,
// operator gas, the demo wallet's chips, and the Predict vault balance, so a bad state is
// caught before recording. With --play it also stands up a live oracle (if none is tradeable)
// and runs one real I Feel Lucky round end to end (mint -> live mark -> cash out) against our
// own Predict instance, pushing a favorable tick to show the mark climb, then prints the
// explorer links. Mirrors bigdev/claude/preflight.md. Run: `bun run scripts/preflight.ts [--play]`.

import '../dotenv.ts';

import { Transaction } from '@mysten/sui/transactions';

import { suiClient, explorerTxUrl } from '../src/lib/sui/client.ts';
import { operatorAddress } from '../src/lib/sui/signer.ts';
import { getDusdcBalance } from '../src/lib/sui/dusdc.ts';
import { PACKAGE_ID, PREDICT_ID, REGISTRY_ID, ADMIN_CAP_ID, ORACLE_CAP_IDS, gridForSpot } from '../src/lib/sui/config.ts';
import { AUTH_MODE, ORACLE_ASSETS, ORACLE_LIFETIME_MS } from '../src/config/main-config.ts';
import { fetchSpot } from '../src/lib/pyth.ts';
import { buildCreateOracle, buildActivateOracle, appendPriceUpdate } from '../src/lib/sui/predict.ts';
import { executeAsOperator } from '../src/lib/sui/execute.ts';
import { liveByAsset, upsertMarket } from '../src/lib/sui/markets.ts';
import { createPlay, cashoutPlay, getLiveMarkRaw } from '../src/services/plays.ts';
import { prismaQuery } from '../src/lib/prisma.ts';

const ASSET = ORACLE_ASSETS[0] ?? 'BTC';
const MIN_GAS_SUI = 0.3; // a demo session needs gas for oracle rolls + price pushes + redeems
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failed = false;
const check = (label: string, pass: boolean, detail = ''): void => {
  if (!pass) failed = true;
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`);
};
const warn = (label: string, detail = ''): void => console.log(`  [WARN] ${label}${detail ? `  ${detail}` : ''}`);

// Quote (DUSDC) balance sitting in the shared Predict vault, display units.
async function vaultBalance(): Promise<number> {
  const obj = await suiClient.getObject({ id: PREDICT_ID, options: { showContent: true } });
  const c = obj.data?.content as { dataType?: string; fields?: { vault?: { fields?: { balance?: string } } } } | undefined;
  const raw = c?.dataType === 'moveObject' ? c.fields?.vault?.fields?.balance : undefined;
  return raw ? Number(raw) / 1_000_000 : 0;
}

// Stand up one live oracle for ASSET if the in-process cache has none tradeable, returning its
// cap so the favorable push can reuse it. Mirrors oracle-roll's create + activate sequence.
async function ensureLiveOracle(): Promise<{ oracleId: string; capId: string }> {
  const existing = liveByAsset(ASSET, Date.now(), 90_000)[0];
  if (existing) return { oracleId: existing.oracleId, capId: existing.capId };

  const capId = ORACLE_CAP_IDS[0];
  if (!capId) throw new Error('no oracle cap in config; run the bootstrap first');
  const spot = await fetchSpot(ASSET);
  const { minStrike, tickSize } = gridForSpot(ASSET, spot);
  const expiryMs = Date.now() + ORACLE_LIFETIME_MS;

  const createTx = new Transaction();
  buildCreateOracle(createTx, capId, ASSET, expiryMs, minStrike, tickSize);
  const created = (await executeAsOperator(createTx, `create_oracle ${ASSET}`)).objectChanges.find(
    (c) => c.type === 'created' && c.objectType?.endsWith('::oracle::OracleSVI'),
  );
  if (!created?.objectId) throw new Error('create_oracle returned no OracleSVI');
  const oracleId = created.objectId;

  const liveTx = new Transaction();
  buildActivateOracle(liveTx, oracleId, capId, spot);
  await executeAsOperator(liveTx, `activate ${ASSET} oracle`);

  upsertMarket({ oracleId, capId, underlying: ASSET, expiryMs, minStrike: String(minStrike), tickSize: String(tickSize), settled: false, lastPushAt: Date.now() });
  console.log(`  rolled live ${ASSET} oracle ${oracleId} (spot $${spot.toFixed(2)})`);
  return { oracleId, capId };
}

async function main(): Promise<void> {
  const doPlay = process.argv.includes('--play');
  console.log(`\nPips preflight (network=testnet, AUTH_MODE=${AUTH_MODE}, asset=${ASSET})\n`);

  // --- Static config + funds (read-only) ---
  console.log('Config + funds');
  check('Predict ids present', Boolean(PACKAGE_ID && PREDICT_ID && REGISTRY_ID && ADMIN_CAP_ID && ORACLE_CAP_IDS[0]));
  const sui = await suiClient.getBalance({ owner: operatorAddress, coinType: '0x2::sui::SUI' });
  const gas = Number(sui.totalBalance) / 1e9;
  check(`Operator gas >= ${MIN_GAS_SUI} SUI`, gas >= MIN_GAS_SUI, `${gas.toFixed(4)} SUI`);

  const user = await prismaQuery.user.findUnique({ where: { address: operatorAddress } });
  check('Demo user + PredictManager exist', Boolean(user?.predictManagerId), user?.predictManagerId ? '' : 'run seed + sign in once');
  const chips = await getDusdcBalance(operatorAddress);
  check('Demo wallet has chips (>= $50)', chips >= 50, `$${chips.toFixed(2)} DUSDC`);
  const vault = await vaultBalance();
  check('Vault has liquidity (>= $200)', vault >= 200, `$${vault.toFixed(2)} DUSDC`);

  if (!doPlay) {
    console.log(`\n${failed ? 'PREFLIGHT FAILED, fix the above before recording.' : 'Read-only checks passed. Run with --play to rehearse a live round.'}\n`);
    return;
  }
  if (!user?.predictManagerId) throw new Error('cannot --play without a demo user + manager');

  // --- Live golden-path round trip ---
  console.log('\nGolden path (real mint -> live mark -> cash out)');
  const { oracleId, capId } = await ensureLiveOracle();

  const before = await getDusdcBalance(operatorAddress);
  const res = await createPlay(user, { game: 'lucky', stake: 25 });
  if (res.mode !== 'dev') throw new Error('expected dev-mode play (server-signed)');
  const dto = res.play;
  const side = 'side' in dto.params ? (dto.params.side ?? 'up') : 'up';
  const strike = Number(dto.market.strike ?? '0');
  console.log(`  minted: ${dto.multiplier}x ${dto.market.asset} ${String(side).toUpperCase()}, strike $${strike}, entry $${dto.entryValue}`);
  check('mint tx on chain', Boolean(dto.txMint), dto.txMint ? explorerTxUrl(dto.txMint) : '');

  const playRow = await prismaQuery.play.findUniqueOrThrow({ where: { id: dto.id } });
  const mark0 = await getLiveMarkRaw(playRow);

  // Push a tick decisively past the strike in the play's direction (~2%), exactly as the
  // price-pusher feeds real Pyth moves during the demo, so the live mark climbs into the green
  // before cash out. A fresh oracle has time value, so a small nudge only reaches break-even.
  if (strike > 0) {
    const target = side === 'down' ? strike * 0.98 : strike * 1.02;
    const tx = new Transaction();
    appendPriceUpdate(tx, oracleId, capId, target);
    await executeAsOperator(tx, 'favorable price push');
    await sleep(1500);
  }
  const mark1 = await getLiveMarkRaw(playRow);
  console.log(`  live mark: $${(Number(mark0) / 1e6).toFixed(2)} -> $${(Number(mark1) / 1e6).toFixed(2)} (climbed: ${mark1 > mark0})`);

  const cash = await cashoutPlay(user, dto.id);
  if (cash.mode !== 'dev') throw new Error('expected dev-mode cashout');
  const settled = cash.play;
  check('redeem tx on chain', Boolean(settled.txRedeem), settled.txRedeem ? explorerTxUrl(settled.txRedeem) : '');
  console.log(`  cashed out: payout $${settled.payout ?? '0'}, pnl $${settled.pnl}`);
  if (cash.unlocked.length) console.log(`  achievements unlocked: ${cash.unlocked.join(', ')}`);

  const after = await getDusdcBalance(operatorAddress);
  check('DUSDC moved (real position)', after !== before, `$${before.toFixed(2)} -> $${after.toFixed(2)}`);

  console.log(`\n${failed ? 'GOLDEN PATH HAD FAILURES, see above.' : 'GOLDEN PATH GREEN: real mint + redeem, explorer links resolve, chips moved.'}\n`);
}

main()
  .then(() => prismaQuery.$disconnect())
  .then(() => process.exit(failed ? 1 : 0))
  .catch(async (e) => {
    console.error('\npreflight error:', e instanceof Error ? e.message : e);
    await prismaQuery.$disconnect();
    process.exit(1);
  });
