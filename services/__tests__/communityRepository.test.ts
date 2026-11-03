import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createCommunityRepository,
  CommunityError,
  COMMUNITY_MESSAGES,
  hasPlace,
  mapEventRow,
  mapGroupRow,
  toCommunityError
} from '../communityRepository';

// Stand-in client: verifies what this module sends and how it reads
// answers. The rules themselves are proven by community_test.sql and
// community_concurrency_test.sql.

const G = '11111111-1111-4111-8111-111111111111';
const E = '22222222-2222-4222-8222-222222222222';
const F = '33333333-3333-4333-8333-333333333333';

function fakeClient(options: { session?: { user: { id: string } } | null; rpc?: { data?: unknown; error?: unknown } | (() => never) } = {}) {
  const session = 'session' in options ? options.session : { user: { id: 'u' } };
  const rpc = vi.fn(async (..._a: unknown[]) => {
    if (typeof options.rpc === 'function') return options.rpc();
    return { data: options.rpc && 'data' in options.rpc ? options.rpc.data : null, error: options.rpc?.error ?? null };
  });
  const from = vi.fn();
  const client = {
    auth: { getSession: vi.fn(async () => ({ data: { session }, error: null })) },
    rpc,
    from
  } as unknown as SupabaseClient;
  return { repo: createCommunityRepository(() => client), rpc, from };
}

const failure = async (p: Promise<unknown>): Promise<CommunityError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof CommunityError) return e;
    throw e;
  }
  throw new Error('expected a rejection');
};

const groupRow = {
  id: G, name: 'Smashers', sport: 'Badminton', city: 'Trivandrum', description: null,
  status: 'approved', created_by: 'u', member_count: 3, is_member: true, created_at: '2026-10-20T10:00:00Z'
};
const eventRow = {
  id: E, group_id: G, group_name: 'Smashers', title: 'Sunday doubles', event_date: '2026-11-01',
  event_time: '18:30:00', facility_id: F, facility_name: 'Court', city: 'Trivandrum', capacity: 4,
  status: 'approved', created_by: 'u', participant_count: 2, is_participant: false, created_at: '2026-10-20T10:00:00Z'
};

describe('reads', () => {
  it('maps groups and events from the functions, never from tables', async () => {
    const g = fakeClient({ rpc: { data: [groupRow] } });
    expect(await g.repo.loadGroups()).toEqual([
      { id: G, name: 'Smashers', sport: 'Badminton', city: 'Trivandrum', description: null, status: 'approved',
        createdBy: 'u', memberCount: 3, isMember: true, createdAt: '2026-10-20T10:00:00Z' }
    ]);
    expect(g.rpc).toHaveBeenCalledWith('get_community_groups', {});
    expect(g.from).not.toHaveBeenCalled();

    const e = fakeClient({ rpc: { data: [eventRow] } });
    const [ev] = await e.repo.loadEvents({ groupId: G });
    expect(ev).toMatchObject({ id: E, time: '18:30', date: '2026-11-01', capacity: 4, participantCount: 2, facilityName: 'Court' });
    expect(e.rpc).toHaveBeenCalledWith('get_community_events', { p_group_id: G, p_only_mine: false });
  });

  it('asks for only my events when told to', async () => {
    const { repo, rpc } = fakeClient({ rpc: { data: [] } });
    expect(await repo.loadEvents({ onlyMine: true })).toEqual([]);
    expect(rpc).toHaveBeenCalledWith('get_community_events', { p_group_id: null, p_only_mine: true });
  });

  it('accepts an event without a capacity and rejects malformed rows', () => {
    expect(mapEventRow({ ...eventRow, capacity: null }).capacity).toBeNull();
    expect(() => mapEventRow({ ...eventRow, status: 'archived' })).toThrow(CommunityError);
    expect(() => mapEventRow({ ...eventRow, participant_count: -1 })).toThrow(CommunityError);
    expect(() => mapGroupRow({ ...groupRow, member_count: '3' })).toThrow(CommunityError);
    expect(() => mapGroupRow(null)).toThrow(CommunityError);
  });

  it('fails safely: a non-array answer, a database error, and no session', async () => {
    expect((await failure(fakeClient({ rpc: { data: null } }).repo.loadGroups())).message).toBe(COMMUNITY_MESSAGES.loadFailed);
    const odd = await failure(fakeClient({ rpc: { error: { code: 'XX000', message: 'secret relation' } } }).repo.loadGroups());
    expect(odd.message).toBe(COMMUNITY_MESSAGES.loadFailed);
    expect((await failure(fakeClient({ session: null }).repo.loadGroups())).kind).toBe('unauthenticated');
  });

  it('refuses a malformed group id before any request', async () => {
    const { repo, rpc } = fakeClient();
    expect((await failure(repo.loadEvents({ groupId: 'x' }))).kind).toBe('invalid');
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('writes', () => {
  it('createGroup trims, sends the exact arguments and returns the id', async () => {
    const { repo, rpc } = fakeClient({ rpc: { data: G } });
    await expect(repo.createGroup({ name: '  Smashers ', sport: 'Badminton', city: 'Trivandrum', description: '  hi ' })).resolves.toBe(G);
    expect(rpc).toHaveBeenCalledWith('create_group', { p_name: 'Smashers', p_sport: 'Badminton', p_city: 'Trivandrum', p_description: 'hi' });
  });

  it('createGroup sends a blank description as null and refuses bad input before any request', async () => {
    const { repo, rpc } = fakeClient({ rpc: { data: G } });
    await repo.createGroup({ name: 'Smashers', sport: 'Badminton', city: 'Trivandrum', description: '  ' });
    expect(rpc).toHaveBeenLastCalledWith('create_group', expect.objectContaining({ p_description: null }));
    expect((await failure(repo.createGroup({ name: ' a ', sport: 'Badminton', city: 'Trivandrum' }))).kind).toBe('invalid');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('createEvent sends exact arguments and validates date, time, ids and capacity first', async () => {
    const { repo, rpc } = fakeClient({ rpc: { data: E } });
    const ok = { groupId: G, title: ' Doubles ', date: '2026-11-01', time: '18:30', facilityId: F, capacity: 6 };
    await expect(repo.createEvent(ok)).resolves.toBe(E);
    expect(rpc).toHaveBeenCalledWith('create_event', {
      p_group_id: G, p_title: 'Doubles', p_event_date: '2026-11-01', p_event_time: '18:30', p_facility_id: F, p_capacity: 6
    });
    for (const bad of [
      { ...ok, date: '2026-02-30' }, { ...ok, time: '25:00' }, { ...ok, title: 'x' },
      { ...ok, capacity: 0 }, { ...ok, capacity: 2.5 }, { ...ok, groupId: 'x' }, { ...ok, facilityId: 'x' }
    ]) {
      expect((await failure(repo.createEvent(bad))).kind).toBe('invalid');
    }
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('createEvent without a capacity sends null', async () => {
    const { repo, rpc } = fakeClient({ rpc: { data: E } });
    await repo.createEvent({ groupId: G, title: 'Doubles', date: '2026-11-01', time: '18:30', facilityId: F });
    expect(rpc).toHaveBeenCalledWith('create_event', expect.objectContaining({ p_capacity: null }));
  });

  it('join and leave return what the database answered, and reject anything else', async () => {
    expect(await fakeClient({ rpc: { data: true } }).repo.joinGroup(G)).toBe(true);
    expect(await fakeClient({ rpc: { data: false } }).repo.leaveGroup(G)).toBe(false);
    expect(await fakeClient({ rpc: { data: true } }).repo.joinEvent(E)).toBe(true);
    expect(await fakeClient({ rpc: { data: false } }).repo.leaveEvent(E)).toBe(false);
    for (const data of [null, 'true', 1, undefined]) {
      expect((await failure(fakeClient({ rpc: { data } }).repo.joinEvent(E))).kind).toBe('unknown');
    }
  });

  it('writes need a session and a well-formed id', async () => {
    const none = fakeClient({ session: null });
    expect((await failure(none.repo.joinGroup(G))).kind).toBe('unauthenticated');
    expect(none.rpc).not.toHaveBeenCalled();
    expect((await failure(fakeClient().repo.joinEvent('nope'))).kind).toBe('invalid');
  });

  it('an unexpected id in the answer is a failure, not a success', async () => {
    expect((await failure(fakeClient({ rpc: { data: 'abc' } }).repo.createGroup({ name: 'Smashers', sport: 'Badminton', city: 'Trivandrum' }))).kind).toBe('unknown');
  });
});

describe('errors', () => {
  const kind = (code: string, message = 'x') => toCommunityError({ code, message }).kind;

  it('maps every database code to a kind', () => {
    expect(kind('28000')).toBe('unauthenticated');
    expect(kind('P0002')).toBe('not_found');
    expect(kind('UC001')).toBe('not_member');
    expect(kind('UC002')).toBe('full');
    expect(kind('UC003')).toBe('closed');
    expect(kind('UC004')).toBe('limit');
    expect(kind('UC005')).toBe('duplicate');
    expect(kind('22007')).toBe('invalid');
    expect(kind('22023')).toBe('invalid');
  });

  it('tells the two "not open" and two "limit" cases apart', () => {
    expect(toCommunityError({ code: 'UC003', message: 'The group is not approved yet' }).message).toBe(COMMUNITY_MESSAGES.notApprovedGroup);
    expect(toCommunityError({ code: 'UC003', message: 'This event is not open for joining' }).message).toBe(COMMUNITY_MESSAGES.closed);
    expect(toCommunityError({ code: 'UC004', message: 'Too many events are already waiting' }).message).toBe(COMMUNITY_MESSAGES.limitEvent);
    expect(toCommunityError({ code: 'UC004', message: 'Too many groups are already waiting' }).message).toBe(COMMUNITY_MESSAGES.limitGroup);
  });

  it('never leaks raw server text, and spots a network failure', () => {
    const odd = toCommunityError({ code: 'XX000', message: 'relation "group_members" secret' });
    expect(odd.kind).toBe('unknown');
    expect(odd.message).not.toMatch(/relation|secret/);
    expect(toCommunityError(new TypeError('Failed to fetch')).kind).toBe('network');
  });

  it('hasPlace is true without a capacity and while below it', () => {
    expect(hasPlace({ capacity: null, participantCount: 99 })).toBe(true);
    expect(hasPlace({ capacity: 4, participantCount: 3 })).toBe(true);
    expect(hasPlace({ capacity: 4, participantCount: 4 })).toBe(false);
  });
});
