// Grant or revoke a specialRole. The ADMIN bootstrap, and script-only forever: you cannot grant yourself
// the first ADMIN through an admin-only UI, and keeping ADMIN out of the API means a compromised admin
// session cannot mint more admins. See bigdev/plans/cont/03-ADMIN-DASHBOARD.md §2.1 rule 3 and §9.1.
//
//   cd backend && bun scripts/grant-role.ts <userIdOrUsername> <ROLE> [--revoke]
//
// Examples:
//   bun scripts/grant-role.ts kelvin ADMIN
//   bun scripts/grant-role.ts kelvin BETA_TESTER --revoke

import '../dotenv.ts';

import { prismaQuery } from '../src/lib/prisma.ts';
import { SPECIAL_ROLES, isSpecialRole } from '../src/config/roles.ts';
import { SUI_NETWORK } from '../src/config/main-config.ts';

const [target, roleArg, ...rest] = process.argv.slice(2);
const revoke = rest.includes('--revoke');

if (!target || !roleArg) {
  console.error('usage: bun scripts/grant-role.ts <userIdOrUsername> <ROLE> [--revoke]');
  console.error(`roles: ${SPECIAL_ROLES.join(', ')}`);
  process.exit(1);
}

const role = roleArg.toUpperCase();
if (!isSpecialRole(role)) {
  console.error(`unknown role "${roleArg}". Valid: ${SPECIAL_ROLES.join(', ')}`);
  process.exit(1);
}

const user = await prismaQuery.user.findFirst({
  where: { OR: [{ id: target }, { username: target }, { address: target }] },
  select: { id: true, username: true, address: true, specialRoles: true },
});

if (!user) {
  console.error(`no user matched "${target}" (tried id, username, address)`);
  process.exit(1);
}

const has = user.specialRoles.includes(role);
if (revoke && !has) {
  console.log(`${user.username ?? user.id} does not have ${role}, nothing to do`);
  process.exit(0);
}
if (!revoke && has) {
  console.log(`${user.username ?? user.id} already has ${role}, nothing to do`);
  process.exit(0);
}

// Lockout guards, same rules the API enforces: the last ADMIN cannot be revoked. This script has no
// actor session, so "cannot revoke your own ADMIN" has no meaning here; the last-ADMIN floor does.
if (revoke && role === 'ADMIN') {
  const admins = await prismaQuery.user.count({ where: { specialRoles: { has: 'ADMIN' } } });
  if (admins <= 1) {
    console.error('refusing to revoke the last ADMIN. Grant another admin first, or you lock everyone out.');
    process.exit(1);
  }
}

const next = revoke ? user.specialRoles.filter((r) => r !== role) : [...user.specialRoles, role];

await prismaQuery.user.update({ where: { id: user.id }, data: { specialRoles: next } });

// Audit trail. Roles are the one thing we always want history on. Written straight to Event here because
// this script ships before track() exists (Addendum A4); the fields are the same server-stamped set.
await prismaQuery.event
  .create({
    data: {
      name: 'admin.role_change',
      userId: user.id,
      sessionId: 'script',
      props: { target: user.username ?? user.id, role, granted: !revoke, actor: 'script:grant-role' },
      platform: 'desktop',
      source: 'backend',
      network: SUI_NETWORK,
    },
  })
  .catch((e) => console.warn('[grant-role] audit event write failed (role change still applied):', e));

console.log(`${revoke ? 'revoked' : 'granted'} ${role} ${revoke ? 'from' : 'to'} ${user.username ?? user.id} (${user.address})`);
console.log(`roles now: [${next.join(', ') || 'none'}]`);
process.exit(0);
