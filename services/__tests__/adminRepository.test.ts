import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createAdminRepository,
  AdminError,
  ADMIN_FACILITY_COLUMNS,
  ADMIN_FACILITY_LIMIT,
  ADMIN_MESSAGES,
  SET_FACILITY_STATUS_RPC,
  FIND_USER_RPC,
  SET_USER_ROLE_RPC,
  parseAdminUser,
  toAdminError
} from '../adminRepository';

// Stand-in client: verifies what this module sends and how it reads
// answers. It cannot prove the database enforces the admin check; the
// pgTAP suite (admin_functions_test.sql) does.

const ID = '44444444-4444-4444-8444-444444444444';
const FAC = '22222222-2222-4222-8222-222222222222';

interface Options {
  session?: { user: { id: string } } | null;
  rpc?: { data?: unknown; error?: unknown } | (() => never);
  select?: { data?: unknown; error?: unknown };
}

function fakeClient(options: Options = {}) {
  const session = 'session' in options ? options.session : { user: { id: ID } };
  const rpc = vi.fn(async (..._a: unknown[]) => {
    if (typeof options.rpc === 'function') return options.rpc();
    return { data: options.rpc?.data ?? null, error: options.rpc?.error ?? null };
  });
  const calls: Array<[string, ...unknown[]]> = [];
  const chain: Record<string, unknown> = {};
  chain.select = (...a: unknown[]) => (calls.push(['select', ...a]), chain);
  chain.order = (...a: unknown[]) => (calls.push(['order', ...a]), chain);
  chain.limit = (...a: unknown[]) => {
    calls.push(['limit', ...a]);
    return Promise.resolve({
      data: options.select && 'data' in options.select ? options.select.data : [],
      error: options.select?.error ?? null
    });
  };
  const from = vi.fn((t: string) => (calls.push(['from', t]), chain));
  const client = {
    auth: { getSession: vi.fn(async () => ({ data: { session }, error: null })) },
    rpc,
    from
  } as unknown as SupabaseClient;
  const repo = createAdminRepository(() => client);
  return { repo, rpc, from, calls };
}

const failure = async (p: Promise<unknown>): Promise<AdminError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof AdminError) return e;
    throw e;
  }
  throw new Error('expected a rejection');
};

const facilityRow = {
  id: FAC, name: 'Court', sport: 'Badminton', address: '1 Road', city: 'Trivandrum',
  base_price: '500.00', status: 'pending', created_at: '2026-10-20T10:00:00Z'
};

describe('loadFacilities', () => {
  it('reads only the displayed columns, newest first, bounded', async () => {
    const { repo, calls } = fakeClient({ select: { data: [facilityRow] } });
    const list = await repo.loadFacilities();
    expect(list).toEqual([
      { id: FAC, name: 'Court', sport: 'Badminton', address: '1 Road', city: 'Trivandrum',
        basePrice: 500, status: 'pending', createdAt: '2026-10-20T10:00:00Z' }
    ]);
    expect(calls).toContainEqual(['from', 'facilities']);
    expect(calls).toContainEqual(['select', ADMIN_FACILITY_COLUMNS]);
    expect(calls).toContainEqual(['order', 'created_at', { ascending: false }]);
    expect(calls).toContainEqual(['limit', ADMIN_FACILITY_LIMIT]);
  });

  it('rejects an unknown status instead of guessing, and a non-array answer', async () => {
    expect((await failure(fakeClient({ select: { data: [{ ...facilityRow, status: 'archived' }] } }).repo.loadFacilities())).message)
      .toBe(ADMIN_MESSAGES.loadFailed);
    expect((await failure(fakeClient({ select: { data: null } }).repo.loadFacilities())).message)
      .toBe(ADMIN_MESSAGES.loadFailed);
  });

  it('reports a safe error and requires a session', async () => {
    const err = await failure(fakeClient({ select: { error: { code: 'XX000', message: 'secret detail' } } }).repo.loadFacilities());
    expect(err.message).toBe(ADMIN_MESSAGES.loadFailed);
    expect((await failure(fakeClient({ session: null }).repo.loadFacilities())).kind).toBe('unauthenticated');
  });
});

describe('setFacilityStatus', () => {
  it('calls the RPC with exact argument names and returns the stored status', async () => {
    const { repo, rpc, from } = fakeClient({ rpc: { data: 'active' } });
    await expect(repo.setFacilityStatus(FAC, 'active')).resolves.toBe('active');
    expect(rpc).toHaveBeenCalledWith(SET_FACILITY_STATUS_RPC, { p_facility_id: FAC, p_status: 'active' });
    expect(from).not.toHaveBeenCalled();
  });

  it('never reports success when the database answered something else', async () => {
    for (const data of [null, 'pending', '', true]) {
      expect((await failure(fakeClient({ rpc: { data } }).repo.setFacilityStatus(FAC, 'active'))).kind).toBe('unknown');
    }
  });

  it('refuses bad input before any request', async () => {
    const { repo, rpc } = fakeClient();
    expect((await failure(repo.setFacilityStatus('x', 'active'))).kind).toBe('invalid');
    expect((await failure(repo.setFacilityStatus(FAC, 'archived' as never))).kind).toBe('invalid');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('maps forbidden, not found and signed out', async () => {
    const run = (code: string) =>
      failure(fakeClient({ rpc: { error: { code, message: 'x' } } }).repo.setFacilityStatus(FAC, 'active'));
    expect((await run('42501')).kind).toBe('forbidden');
    expect((await run('P0002')).message).toBe(ADMIN_MESSAGES.facilityNotFound);
    expect((await run('28000')).kind).toBe('unauthenticated');
  });
});

describe('findUserByEmail', () => {
  const row = { user_id: ID, email: 'a@example.com', full_name: 'A', role: 'owner' };

  it('sends the trimmed email and parses one row', async () => {
    const { repo, rpc } = fakeClient({ rpc: { data: [row] } });
    await expect(repo.findUserByEmail('  a@example.com ')).resolves.toEqual({
      id: ID, email: 'a@example.com', fullName: 'A', role: 'owner'
    });
    expect(rpc).toHaveBeenCalledWith(FIND_USER_RPC, { p_email: 'a@example.com' });
  });

  it('returns null for no match', async () => {
    await expect(fakeClient({ rpc: { data: [] } }).repo.findUserByEmail('x@example.com')).resolves.toBeNull();
  });

  it('refuses a blank or non-email input before any request', async () => {
    const { repo, rpc } = fakeClient();
    expect((await failure(repo.findUserByEmail('  '))).message).toBe(ADMIN_MESSAGES.emailRequired);
    expect((await failure(repo.findUserByEmail('someone'))).kind).toBe('invalid');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects malformed rows', () => {
    expect(() => parseAdminUser(null)).toThrow(AdminError);
    expect(() => parseAdminUser([row, row])).toThrow(AdminError);
    expect(() => parseAdminUser([{ ...row, role: 'root' }])).toThrow(AdminError);
    expect(() => parseAdminUser([{ ...row, user_id: 'nope' }])).toThrow(AdminError);
  });
});

describe('setUserRole', () => {
  it('calls the RPC and returns the stored role', async () => {
    const { repo, rpc } = fakeClient({ rpc: { data: 'owner' } });
    await expect(repo.setUserRole(ID, 'owner')).resolves.toBe('owner');
    expect(rpc).toHaveBeenCalledWith(SET_USER_ROLE_RPC, { p_user_id: ID, p_role: 'owner' });
  });

  it('never reports success for a different answer', async () => {
    expect((await failure(fakeClient({ rpc: { data: 'user' } }).repo.setUserRole(ID, 'owner'))).kind).toBe('unknown');
  });

  it('maps the rule refusals to clear messages', async () => {
    const run = (code: string) =>
      failure(fakeClient({ rpc: { error: { code, message: 'x' } } }).repo.setUserRole(ID, 'user'));
    expect((await run('UB007')).message).toBe(ADMIN_MESSAGES.ownRole);
    expect((await run('UB008')).message).toBe(ADMIN_MESSAGES.lastAdmin);
    expect((await run('P0002')).message).toBe(ADMIN_MESSAGES.userNotFound);
    expect((await run('42501')).kind).toBe('forbidden');
  });

  it('refuses a bad role or id before any request', async () => {
    const { repo, rpc } = fakeClient();
    expect((await failure(repo.setUserRole(ID, 'root' as never))).kind).toBe('invalid');
    expect((await failure(repo.setUserRole('bad', 'user'))).kind).toBe('invalid');
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('toAdminError', () => {
  it('never leaks raw server text and recognises a network failure', () => {
    const odd = toAdminError({ code: 'XX000', message: 'relation "profiles" secret' });
    expect(odd.kind).toBe('unknown');
    expect(odd.message).not.toMatch(/relation|secret/);
    expect(toAdminError(new TypeError('Failed to fetch')).kind).toBe('network');
  });

  it('a thrown network error from the RPC becomes a network AdminError', async () => {
    const { repo } = fakeClient({ rpc: () => { throw new TypeError('Failed to fetch'); } });
    expect((await failure(repo.setFacilityStatus(FAC, 'active'))).kind).toBe('network');
  });
});
