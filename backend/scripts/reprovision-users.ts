// Re-arm every user for re-provision after a localnet chain reset.
//
// A chain reset wipes each user's on-chain PredictManager, their starting DUSDC chips, and any
// SUI gas they held. Onboarding (src/services/auth.ts -> provisionUser) re-creates all of that
// lazily, but only when the corresponding flag is clear. So we clear the flags here and the very
// next login re-provisions the user: fresh manager, fresh chips, fresh gas. No funds move (free
// localnet DUSDC), and User rows / usernames / logins are untouched.
//
// Run from backend/:  bun scripts/reprovision-users.ts
import { prismaQuery } from '../src/lib/prisma.ts';

const r = await prismaQuery.user.updateMany({
  data: { predictManagerId: null, dusdcFunded: false, suiGasFunded: false },
});

console.log(`re-armed ${r.count} users for re-provision (manager + chips + gas re-issued on next login)`);
process.exit(0);
