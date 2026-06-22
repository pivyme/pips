// One-off email backfill for users created before we read the email server-side. The client only knew
// the email for the email login method (Google sign-in keeps it under the google_oauth account), so
// most rows landed with email = null. This walks every privy user missing an email and pulls it from
// Privy by user id. Idempotent and safe to re-run; rows still without a Privy-side email are left null.
//   bun scripts/backfill-emails.ts        dry run (report only, no writes)
//   bun scripts/backfill-emails.ts write  apply the updates
import '../dotenv.ts';
import { prismaQuery } from '../src/lib/prisma.ts';
import { fetchPrivyEmail } from '../src/lib/sui/privy.ts';

async function main() {
  const write = process.argv[2] === 'write';
  const users = await prismaQuery.user.findMany({
    where: { provider: 'privy', email: null, privyUserId: { not: null } },
    select: { id: true, address: true, privyUserId: true },
  });

  console.log(`\n${users.length} privy user(s) missing an email${write ? '' : ' (dry run, no writes)'}\n`);
  let filled = 0;
  let missing = 0;
  for (const u of users) {
    const email = await fetchPrivyEmail(u.privyUserId as string);
    if (!email) {
      missing++;
      console.log(`  -  ${u.address.slice(0, 10)}…  no email on Privy`);
      continue;
    }
    if (write) await prismaQuery.user.update({ where: { id: u.id }, data: { email } });
    filled++;
    console.log(`  ${write ? '✓' : '·'}  ${u.address.slice(0, 10)}…  ${email}`);
  }

  console.log(`\n${filled} ${write ? 'updated' : 'resolvable'}, ${missing} with no Privy email.`);
  if (!write && filled > 0) console.log('Re-run with `write` to apply.\n');
  await prismaQuery.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
