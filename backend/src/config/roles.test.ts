import { describe, expect, it } from 'bun:test';

import { PUBLIC_ROLES, SPECIAL_ROLES, isAdmin, isSpecialRole, publicRoles } from './roles.ts';

describe('special roles', () => {
  it('never lets ADMIN or BETA_TESTER out through the public filter', () => {
    expect(publicRoles(['ADMIN', 'KOL', 'BETA_TESTER'])).toEqual(['KOL']);
    expect(publicRoles(['ADMIN'])).toEqual([]);
    expect(publicRoles([])).toEqual([]);
  });

  it('keeps PUBLIC_ROLES a subset of SPECIAL_ROLES', () => {
    for (const r of PUBLIC_ROLES) expect(SPECIAL_ROLES).toContain(r);
  });

  it('rejects an unknown role name', () => {
    expect(isSpecialRole('SUPERADMIN')).toBe(false);
    expect(isSpecialRole('admin')).toBe(false); // case sensitive on purpose
    expect(isSpecialRole('ADMIN')).toBe(true);
  });

  it('isAdmin tolerates a missing roles array', () => {
    expect(isAdmin(undefined)).toBe(false);
    expect(isAdmin(null)).toBe(false);
    expect(isAdmin([])).toBe(false);
    expect(isAdmin(['KOL'])).toBe(false);
    expect(isAdmin(['KOL', 'ADMIN'])).toBe(true);
  });
});
