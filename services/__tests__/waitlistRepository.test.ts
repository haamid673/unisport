import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createWaitlistRepository,
  WaitlistError,
  JOIN_WAITLIST_RPC,
  LEAVE_WAITLIST_RPC,
  ACCEPT_WAITLIST_RPC,
  WAITLIST_COLUMNS,
  WAITLIST_HISTORY_LIMIT,
  WAITLIST_MESSAGES,
  effectiveWaitlistStatus,
  isLiveOffer,
  toWaitlistError
} from '../waitlistRepository';

// Stand-in client at the service boundary. These tests verify what the
// repository sends and how it interprets answers; they do not prove the
// hosted database behaves the same way.

const USER_ID = '11111111-1111-4111-8111-111111111111';
const FACILITY_ID = '22222222-2222-4222-8222-222222222222';
const SLOT_ID = '33333333-3333-4333-8333-333333333333';
const ENTRY_ID = '44444444-4444-4444-8444-444444444444';
const BOOKING_ID = '55555555-5555-4555-8555-555555555555';
const DATE = '2026-10-20';

interface FakeOptions {
  session?: { user: { id: string } } | null;
  rpc?: { data?: unknown; error?: unknown } | (() => never);
  select?: { data?: unknown; error?: unknown };
}

function fakeClient(options: FakeOptions = {}) {
  const session = 'session' in options ? options.session : { user: { id: USER_ID } };

  const rpc = vi.fn(async (..._args: unknown[]) => {
    if (typeof options.rpc === 'function') return options.rpc();
    return { data: options.rpc?.data ?? null, error: options.rpc?.error ?? null };
  });

  const calls: Array<[string, ...unknown[]]> = [];
  const chain: Record<string, unknown> = {};
  const record = (name: string) => (...args: unknown[]) => {
    calls.push([name, ...args]);
    return chain;
  };
  for (const name of ['select', 'eq', 'order', 'insert', 'update', 'delete', 'upsert']) {
    chain[name] = record(name);
  }
  chain.limit = (...args: unknown[]) => {
    calls.push(['limit', ...args]);
    return Promise.resolve({
      data: options.select?.data ?? [],
      error: options.select?.error ?? null
    });
  };

  const from = vi.fn((table: string) => {
    calls.push(['from', table]);
    return chain;
  });

  const client = {
    auth: { getSession: vi.fn(async () => ({ data: { session }, error: null })) },
    rpc,
    from
  } as unknown as SupabaseClient;

  return { client, rpc, from, calls };
}

const repoFor = (options?: FakeOptions) => {
  const f = fakeClient(options);
  return { ...f, repo: createWaitlistRepository(() => f.client) };
};

const failure = async (promise: Promise<unknown>): Promise<WaitlistError> => {
  try {
    await promise;
  } catch (e) {
    if (e instanceof WaitlistError) return e;
    throw e;
  }
  throw new Error('expected the call to be rejected');
};

const request = { facilityId: FACILITY_ID, slotId: SLOT_ID, bookingDate: DATE };
const mutations = (calls: Array<[string, ...unknown[]]>) =>
  calls.filter(c => ['insert', 'update', 'delete', 'upsert'].includes(c[0]));

describe('joinWaitlist', () => {
  it('calls join_waitlist with the exact argument names and returns the queue size', async () => {
    const { repo, rpc, calls } = repoFor({
      rpc: { data: [{ entry_id: ENTRY_ID, entries_ahead: 2 }] }
    });

    const joined = await repo.joinWaitlist(request);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(JOIN_WAITLIST_RPC, {
      p_facility_id: FACILITY_ID,
      p_slot_id: SLOT_ID,
      p_booking_date: DATE
    });
    expect(JOIN_WAITLIST_RPC).toBe('join_waitlist');
    expect(joined).toEqual({ entryId: ENTRY_ID, entriesAhead: 2 });
    expect(mutations(calls)).toEqual([]);
  });

  it('maps an already-queued request (23505) to "duplicate"', async () => {
    const { repo } = repoFor({
      rpc: { error: { code: '23505', message: 'You are already on the waitlist for this slot and date' } }
    });
    const err = await failure(repo.joinWaitlist(request));
    expect(err.kind).toBe('duplicate');
    expect(err.message).toBe(WAITLIST_MESSAGES.alreadyListed);
  });

  it('maps "slot is available, book directly" to "available"', async () => {
    const { repo } = repoFor({
      rpc: { error: { code: 'P0001', message: 'Selected slot is currently available; book it directly' } }
    });
    expect((await failure(repo.joinWaitlist(request))).kind).toBe('available');
  });

  it('maps an existing booking, the cap and unavailable slots', async () => {
    const cases: Array<[unknown, string]> = [
      [{ code: 'P0001', message: 'You already have a booking for this slot and date' }, 'duplicate'],
      [{ code: 'UB002', message: 'x' }, 'limit'],
      [{ code: 'P0001', message: 'Selected slot is not bookable on the selected date' }, 'unavailable'],
      [{ code: 'P0001', message: 'Facility is not currently available for booking' }, 'unavailable'],
      [{ code: 'P0002', message: 'Facility not found' }, 'not_found'],
      [{ code: '22007', message: 'x' }, 'invalid'],
      [{ code: '22023', message: 'x' }, 'invalid']
    ];

    for (const [error, kind] of cases) {
      const { repo } = repoFor({ rpc: { error } });
      expect((await failure(repo.joinWaitlist(request))).kind).toBe(kind);
    }
  });

  it('fails closed without a session and never calls the RPC', async () => {
    const { repo, rpc } = repoFor({ session: null });
    const err = await failure(repo.joinWaitlist(request));
    expect(err.kind).toBe('unauthenticated');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('maps database auth failures to "unauthenticated"', async () => {
    for (const code of ['28000', '42501', 'PGRST301']) {
      const { repo } = repoFor({ rpc: { error: { code, message: 'JWT expired' } } });
      expect((await failure(repo.joinWaitlist(request))).kind).toBe('unauthenticated');
    }
  });

  it('rejects malformed ids and dates before any request', async () => {
    const { repo, rpc } = repoFor();
    for (const bad of [
      { ...request, facilityId: 'f1' },
      { ...request, slotId: 's58' },
      { ...request, bookingDate: '2026-02-30' }
    ]) {
      expect((await failure(repo.joinWaitlist(bad))).kind).toBe('invalid');
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it('never reports success for a malformed answer', async () => {
    for (const data of [
      null,
      [],
      [{}],
      [{ entry_id: 'nope', entries_ahead: 0 }],
      [{ entry_id: ENTRY_ID, entries_ahead: -1 }],
      [{ entry_id: ENTRY_ID, entries_ahead: 'many' }]
    ]) {
      const { repo } = repoFor({ rpc: { data } });
      const err = await failure(repo.joinWaitlist(request));
      expect(err.kind, JSON.stringify(data)).toBe('unknown');
    }
  });

  it('does not leak raw server text', async () => {
    const { repo } = repoFor({
      rpc: { error: { code: 'XX000', message: 'relation "internal_secret" does not exist', hint: 'superuser' } }
    });
    const err = await failure(repo.joinWaitlist(request));
    expect(err.message).toBe(WAITLIST_MESSAGES.unknown);
    expect(err.message).not.toMatch(/internal_secret|superuser/);
  });

  it('treats a network failure as an unknown outcome', async () => {
    const { repo } = repoFor({
      rpc: () => {
        throw new TypeError('Failed to fetch');
      }
    });
    expect((await failure(repo.joinWaitlist(request))).kind).toBe('network');
  });
});

describe('leaveWaitlist', () => {
  it('calls leave_waitlist with p_entry_id and returns the final status', async () => {
    const { repo, rpc, calls } = repoFor({ rpc: { data: 'cancelled' } });

    await expect(repo.leaveWaitlist(ENTRY_ID)).resolves.toBe('cancelled');
    expect(rpc).toHaveBeenCalledWith(LEAVE_WAITLIST_RPC, { p_entry_id: ENTRY_ID });
    expect(LEAVE_WAITLIST_RPC).toBe('leave_waitlist');
    expect(mutations(calls)).toEqual([]);
  });

  it('accepts the database answering "expired" for an already-lapsed entry', async () => {
    const { repo } = repoFor({ rpc: { data: 'expired' } });
    await expect(repo.leaveWaitlist(ENTRY_ID)).resolves.toBe('expired');
  });

  it('refuses an unexpected answer instead of reporting success', async () => {
    for (const data of [null, 'waiting', 'accepted', { status: 'cancelled' }, 7]) {
      const { repo } = repoFor({ rpc: { data } });
      expect((await failure(repo.leaveWaitlist(ENTRY_ID))).kind).toBe('unknown');
    }
  });

  it('maps a missing entry and an already-accepted offer', async () => {
    let r = repoFor({ rpc: { error: { code: 'P0002', message: 'Waitlist entry not found' } } });
    let err = await failure(r.repo.leaveWaitlist(ENTRY_ID));
    expect(err.kind).toBe('not_found');
    expect(err.message).toBe(WAITLIST_MESSAGES.entryGone);

    r = repoFor({
      rpc: { error: { code: 'P0001', message: 'Offer already accepted; cancel the booking instead' } }
    });
    err = await failure(r.repo.leaveWaitlist(ENTRY_ID));
    expect(err.kind).toBe('conflict');
    expect(err.message).toBe(WAITLIST_MESSAGES.alreadyAccepted);
  });

  it('requires a session and a valid id', async () => {
    const noSession = repoFor({ session: null });
    expect((await failure(noSession.repo.leaveWaitlist(ENTRY_ID))).kind).toBe('unauthenticated');
    expect(noSession.rpc).not.toHaveBeenCalled();

    const bad = repoFor();
    expect((await failure(bad.repo.leaveWaitlist('e1'))).kind).toBe('invalid');
    expect(bad.rpc).not.toHaveBeenCalled();
  });
});

describe('acceptOffer', () => {
  it('calls accept_waitlist_offer and returns the new unpaid hold', async () => {
    const { repo, rpc, calls } = repoFor({
      rpc: {
        data: [{ booking_id: BOOKING_ID, booking_amount: '800.00', booking_expires_at: '2026-10-20T10:10:00Z' }]
      }
    });

    const accepted = await repo.acceptOffer(ENTRY_ID);

    expect(rpc).toHaveBeenCalledWith(ACCEPT_WAITLIST_RPC, { p_entry_id: ENTRY_ID });
    expect(ACCEPT_WAITLIST_RPC).toBe('accept_waitlist_offer');
    expect(accepted).toEqual({
      bookingId: BOOKING_ID,
      amount: 800,
      expiresAt: '2026-10-20T10:10:00Z'
    });
    expect(mutations(calls)).toEqual([]);
  });

  it('maps an expired or invalid offer', async () => {
    let r = repoFor({ rpc: { error: { code: 'P0001', message: 'Waitlist offer has expired' } } });
    let err = await failure(r.repo.acceptOffer(ENTRY_ID));
    expect(err.kind).toBe('expired');
    expect(err.message).toBe(WAITLIST_MESSAGES.offerExpired);

    r = repoFor({ rpc: { error: { code: 'P0001', message: 'Waitlist offer is no longer valid' } } });
    err = await failure(r.repo.acceptOffer(ENTRY_ID));
    expect(err.kind).toBe('expired');
    expect(err.message).toBe(WAITLIST_MESSAGES.offerInvalid);
  });

  it('maps a slot conflict, the booking cap and booking-time rejections', async () => {
    const cases: Array<[unknown, string]> = [
      [{ code: '23P01', message: 'The selected slot is no longer available' }, 'conflict'],
      [{ code: 'UB001', message: 'x' }, 'limit'],
      [{ code: 'P0001', message: 'Selected slot is not active' }, 'unavailable'],
      [{ code: 'P0002', message: 'Waitlist entry not found' }, 'not_found'],
      [{ code: '28000', message: 'Authentication required' }, 'unauthenticated']
    ];

    for (const [error, kind] of cases) {
      const { repo } = repoFor({ rpc: { error } });
      expect((await failure(repo.acceptOffer(ENTRY_ID))).kind).toBe(kind);
    }
  });

  it('never claims success for a malformed or unlinked result', async () => {
    for (const data of [
      null,
      [],
      [{ booking_id: BOOKING_ID }],
      [{ booking_id: 'x', booking_amount: 1, booking_expires_at: '2026-10-20T10:10:00Z' }],
      [{ booking_id: BOOKING_ID, booking_amount: 1, booking_expires_at: 'soon' }]
    ]) {
      const { repo } = repoFor({ rpc: { data } });
      expect((await failure(repo.acceptOffer(ENTRY_ID))).kind).toBe('unknown');
    }
  });

  it('uses an accept-specific message for generic rejections', () => {
    const err = toWaitlistError({ code: 'P0001', message: 'whatever' }, 'accept');
    expect(err.message).toBe(WAITLIST_MESSAGES.acceptUnavailable);
  });
});

describe('loadMyWaitlist', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: ENTRY_ID,
    facility_id: FACILITY_ID,
    slot_id: SLOT_ID,
    booking_date: DATE,
    status: 'waiting',
    offered_at: null,
    offer_expires_at: null,
    booking_id: null,
    created_at: '2026-10-19T10:00:00Z',
    facilities: { name: 'Marina Turf', sport: 'Football', address: 'Kowdiar', city: 'Trivandrum' },
    facility_slots: { start_time: '18:00:00', end_time: '19:00:00' },
    ...overrides
  });

  it('reads only the signed-in user\'s rows, with no write', async () => {
    const { repo, calls, from } = repoFor({ select: { data: [row()] } });

    const entries = await repo.loadMyWaitlist();

    expect(from).toHaveBeenCalledWith('waitlist_entries');
    expect(calls).toContainEqual(['select', WAITLIST_COLUMNS]);
    expect(calls).toContainEqual(['eq', 'user_id', USER_ID]);
    expect(calls).toContainEqual(['limit', WAITLIST_HISTORY_LIMIT]);
    expect(mutations(calls)).toEqual([]);

    expect(entries[0]).toMatchObject({
      id: ENTRY_ID,
      status: 'waiting',
      facilityName: 'Marina Turf',
      facilityLocation: 'Kowdiar, Trivandrum',
      timeLabel: '06:00 PM - 07:00 PM'
    });
  });

  it('returns an empty list', async () => {
    const { repo } = repoFor({ select: { data: [] } });
    await expect(repo.loadMyWaitlist()).resolves.toEqual([]);
  });

  it('tolerates a venue or slot that is no longer visible', async () => {
    const { repo } = repoFor({
      select: { data: [row({ facilities: null, facility_slots: null })] }
    });
    const [entry] = await repo.loadMyWaitlist();
    expect(entry.facilityName).toBeNull();
    expect(entry.timeLabel).toBeNull();
  });

  it('shows an offer only as the database reported it', async () => {
    const { repo } = repoFor({
      select: {
        data: [
          row({
            status: 'offered',
            offered_at: '2026-10-20T09:00:00Z',
            offer_expires_at: '2026-10-20T09:15:00Z'
          })
        ]
      }
    });
    const [entry] = await repo.loadMyWaitlist();
    expect(entry.status).toBe('offered');
    expect(entry.offerExpiresAt).toBe('2026-10-20T09:15:00Z');
  });

  it('reports a safe error and requires a session', async () => {
    const failing = repoFor({
      select: { error: { code: 'XX000', message: 'permission denied for table payments' } }
    });
    const err = await failure(failing.repo.loadMyWaitlist());
    expect(err.message).toBe(WAITLIST_MESSAGES.loadFailed);

    const anon = repoFor({ session: null });
    expect((await failure(anon.repo.loadMyWaitlist())).kind).toBe('unauthenticated');
    expect(anon.from).not.toHaveBeenCalled();
  });

  it('rejects rows with an unknown status', async () => {
    const { repo } = repoFor({ select: { data: [row({ status: 'mystery' })] } });
    await expect(repo.loadMyWaitlist()).rejects.toBeInstanceOf(WaitlistError);
  });
});

describe('offer expiry by the clock', () => {
  const now = new Date('2026-10-20T10:00:00Z');

  it('treats a lapsed offer as expired even if the row is still "offered"', () => {
    const lapsed = { status: 'offered' as const, offerExpiresAt: '2026-10-20T09:59:59Z', bookingDate: '2026-10-20' };
    const open = { status: 'offered' as const, offerExpiresAt: '2026-10-20T10:05:00Z', bookingDate: '2026-10-20' };

    expect(effectiveWaitlistStatus(lapsed, now)).toBe('expired');
    expect(isLiveOffer(lapsed, now)).toBe(false);
    expect(effectiveWaitlistStatus(open, now)).toBe('offered');
    expect(isLiveOffer(open, now)).toBe(true);
  });

  it('expires a waiting entry for a date that has passed', () => {
    expect(
      effectiveWaitlistStatus(
        { status: 'waiting', offerExpiresAt: null, bookingDate: '2026-10-19' },
        now
      )
    ).toBe('expired');
    expect(
      effectiveWaitlistStatus(
        { status: 'waiting', offerExpiresAt: null, bookingDate: '2026-10-20' },
        now
      )
    ).toBe('waiting');
  });

  it('never invents an offer', () => {
    expect(
      isLiveOffer({ status: 'waiting', offerExpiresAt: '2099-01-01T00:00:00Z', bookingDate: '2099-01-01' }, now)
    ).toBe(false);
  });
});

describe('source guarantees', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../waitlistRepository.ts', import.meta.url)),
    'utf8'
  )
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  it('has no direct table writes and no local persistence', () => {
    expect(source).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
    expect(source).not.toMatch(/localStorage|sessionStorage|storageService|facilityService|eventService/);
  });

  it('mutates only through the three RPCs', () => {
    expect(source).toMatch(/JOIN_WAITLIST_RPC/);
    expect(source).toMatch(/LEAVE_WAITLIST_RPC/);
    expect(source).toMatch(/ACCEPT_WAITLIST_RPC/);
    expect(source).toMatch(/\.from\('waitlist_entries'\)\s*\.select\(/);
  });
});
