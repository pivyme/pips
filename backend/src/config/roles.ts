// Single source of truth for User.specialRoles. `web` keeps a typed twin and `bun run check:admin`
// fails the gate if the two drift. See bigdev/plans/cont/03-ADMIN-DASHBOARD.md §2.1.
//
// Hard rule: no user-facing route may ever write specialRoles. Every user write in src/ uses an explicit
// field allowlist and nothing spreads a request body into a `data:` object. That property must hold forever.
// ADMIN is granted by scripts/grant-role.ts only, so a compromised admin session cannot mint more admins.

export const SPECIAL_ROLES = ['ADMIN', 'KOL', 'BETA_TESTER'] as const;
export type SpecialRole = (typeof SPECIAL_ROLES)[number];

// Roles safe to expose on OTHER users (badges). Everything else is private, so ADMIN and BETA_TESTER
// are never observable from a leaderboard row or a public profile.
export const PUBLIC_ROLES: SpecialRole[] = ['KOL'];

export function isSpecialRole(value: string): value is SpecialRole {
  return (SPECIAL_ROLES as readonly string[]).includes(value);
}

// Filter another user's roles down to what may leave the server.
export function publicRoles(roles: string[]): SpecialRole[] {
  return roles.filter((r): r is SpecialRole => (PUBLIC_ROLES as string[]).includes(r));
}

export function isAdmin(roles: string[] | undefined | null): boolean {
  return !!roles?.includes('ADMIN');
}
