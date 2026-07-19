// One-off DUSDC airdrop for the devnet -> testnet migration: tops every existing user UP TO a target
// balance (default STARTING_BALANCE) from the treasury reserve, so migrated accounts sitting near zero can
// keep playing. Idempotent: reads each user's live on-chain balance (wallet + AccountWrapper chips) and sends
// only the shortfall, skipping anyone already at/above target, so a re-run never double-funds. DUSDC is not
// mintable on Mysten's Predict (L-008), so this spends the finite, hand-funded treasury: dry-run first.
//   bun scripts/airdrop-dusdc.ts             dry run (report the plan + treasury feasibility, no transfers)
//   bun scripts/airdrop-dusdc.ts write       apply
//   AIRDROP_TARGET=100 bun scripts/airdrop-dusdc.ts write   override the target (defaults to STARTING_BALANCE)
import '../dotenv.ts';
import { prismaQuery } from '../src/lib/prisma.ts';
import { STARTING_BALANCE } from '../src/config/main-config.ts';
import { transferDusdc, getDusdcBalanceRaw } from '../src/lib/sui/dusdc.ts';
import { readUserChipsRaw } from '../src/lib/sui/predict-real.ts';
import { fromDusdcRaw, toDusdcRaw } from '../src/lib/sui/config.ts';
import { treasuryAddress, TREASURY_ENABLED } from '../src/lib/sui/signer.ts';

// Below one cent of shortfall isn't worth a tx (2dp display rounding artifact); treat as already funded.
const DUST_RAW = 10_000n;

async function main() {
  const write = process.argv[2] === 'write';
  const target = Number(process.env.AIRDROP_TARGET) || STARTING_BALANCE;
  const targetRaw = toDusdcRaw(target);

  if (!TREASURY_ENABLED) {
    console.error('No treasury configured (TREASURY_WALLET_PK). DUSDC is not mintable here, so there is nothing to pay from.');
    process.exit(1);
  }

  const users = await prismaQuery.user.findMany({ select: { id: true, address: true, predictWrapperId: true } });
  const treasuryRaw = await getDusdcBalanceRaw(treasuryAddress).catch(() => 0n);

  console.log(`\nAirdrop: top every user up to ${target} DUSDC${write ? '' : '  (dry run, no transfers)'}`);
  console.log(`Treasury ${treasuryAddress.slice(0, 10)}… holds ${fromDusdcRaw(treasuryRaw).toFixed(2)} DUSDC`);
  console.log(`${users.length} user(s) to check\n`);

  let needRaw = 0n;
  let funded = 0;
  let skipped = 0;
  let failed = 0;

  for (const u of users) {
    const [wallet, manager] = await Promise.all([
      getDusdcBalanceRaw(u.address).catch(() => 0n),
      readUserChipsRaw(u.address, u.predictWrapperId).catch(() => 0n),
    ]);
    const currentRaw = wallet + manager;
    const shortfallRaw = targetRaw - currentRaw;

    if (shortfallRaw <= DUST_RAW) {
      skipped++;
      continue;
    }

    const shortfall = fromDusdcRaw(shortfallRaw);
    needRaw += shortfallRaw;

    if (!write) {
      console.log(`  ·  ${u.address.slice(0, 10)}…  has ${fromDusdcRaw(currentRaw).toFixed(2)}  ->  +${shortfall.toFixed(2)}`);
      funded++;
      continue;
    }

    try {
      await transferDusdc(u.address, shortfall);
      await prismaQuery.user.update({ where: { id: u.id }, data: { dusdcFunded: true, lastFundedAt: new Date() } });
      funded++;
      console.log(`  ✓  ${u.address.slice(0, 10)}…  +${shortfall.toFixed(2)}  (now ${target})`);
    } catch (e) {
      failed++;
      console.error(`  ✗  ${u.address.slice(0, 10)}…  ${e instanceof Error ? e.message : e}`);
    }
  }

  const need = fromDusdcRaw(needRaw);
  console.log(`\n${funded} to fund, ${skipped} already at target${write ? `, ${failed} failed` : ''}.`);
  console.log(`Total needed: ${need.toFixed(2)} DUSDC.`);
  if (need > fromDusdcRaw(treasuryRaw)) {
    console.log(`WARNING: treasury holds ${fromDusdcRaw(treasuryRaw).toFixed(2)}, short by ${(need - fromDusdcRaw(treasuryRaw)).toFixed(2)}. Top it up before applying.`);
  }
  if (!write && funded > 0) console.log('Re-run with `write` to apply.\n');

  await prismaQuery.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
