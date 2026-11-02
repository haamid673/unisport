import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Source-shape checks, like the other dashboards: the behaviour that
// matters (the database refusing non-administrators, the last-admin
// rule) is proven by supabase/tests/database/admin_functions*_test.sql.

const source = readFileSync(
  fileURLToPath(new URL('../AdminDashboard.tsx', import.meta.url)),
  'utf8'
);
const app = readFileSync(fileURLToPath(new URL('../../App.tsx', import.meta.url)), 'utf8');

describe('AdminDashboard', () => {
  it('uses only the admin repository, never local data or direct writes', () => {
    expect(source).toContain("from '../services/adminRepository'");
    expect(source).not.toMatch(/localStorage|storageService|facilityService/);
    expect(source).not.toMatch(/\.from\(|\.rpc\(/);
  });

  it('is given the signed-in user by the app', () => {
    expect(app).toContain('<AdminDashboard user={user} />');
  });

  it('runs every mutation under one synchronous single-flight guard', () => {
    expect(source).toMatch(/const guard = useRef\(createSingleFlight\(\)\)/);
    expect(source).toMatch(/if \(guard\.current\.busy\) return;/);
    expect((source.match(/guard\.current\.run\(/g) ?? []).length).toBe(3);
  });

  it('confirms before changing a venue or a role', () => {
    expect(source).toMatch(/setConfirmKey\(key\)/);
    expect(source).toMatch(/setConfirmKey\(roleKey\)/);
    expect(source).toContain('Keep as is');
    expect(source).toMatch(/Yes, \{meta\.button\.toLowerCase\(\)\}/);
    expect(source).toContain('Yes, change role');
  });

  it('reports success only from the awaited answer and re-reads the venues afterwards', () => {
    expect(source).toMatch(/await adminRepository\.setFacilityStatus/);
    expect(source).toMatch(/finally \{\s*setBusyKey\(null\);\s*setReloadKey\(k => k \+ 1\);/);
    expect(source).toMatch(/const stored = await adminRepository\.setUserRole/);
  });

  it('shows a safe error with Retry, and never an invented list', () => {
    expect(source).toMatch(/facilitiesView\.phase === 'error'/);
    expect(source).toContain('Retry');
    expect(source).toMatch(/toAdminError\(err\)\.message/);
  });

  it('offers no role change on the administrator\'s own account', () => {
    expect(source).toMatch(/const isSelf = found\?\.id === user\.id/);
    expect(source).toContain('Ask another administrator to change your role');
  });

  it('looks accounts up by full email only (no listing)', () => {
    expect(source).toContain('Accounts cannot be browsed');
    expect(source).not.toMatch(/loadUsers|listUsers/);
  });

  it('decides communities and events only through the repository, with a confirm step', () => {
    expect(source).toMatch(/await adminRepository\.setGroupStatus/);
    expect(source).toMatch(/await adminRepository\.setEventStatus/);
    expect(source).toContain('Yes, approve');
    expect(source).toContain('Yes, reject');
    expect(source).toContain('No communities or events are waiting for approval.');
  });

  it('says when an event\'s community is not approved yet', () => {
    expect(source).toContain('Its community is not approved yet');
  });
});
