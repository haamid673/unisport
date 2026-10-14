import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createBookingRepository,
  BookingError,
  CREATE_BOOKING_RPC,
  BOOKING_COLUMNS,
  BOOKING_HISTORY_LIMIT,
  MESSAGES,
  effectiveStatus,
  isCalendarDate,
  parseCreatedBooking,
  toBookingError
} from '../bookingRepository';

// These tests exercise the repository against a stand-in client. They
// verify what this module sends and how it interprets answers; they do
// not (and cannot) prove the hosted database behaves the same way.

const USER_ID = '11111111-1111-4111-8111-111111111111';
const FACILITY_ID = '22222222-2222-4222-8222-222222222222';
const SLOT_ID = '33333333-3333-4333-8333-333333333333';
const BOOKING_ID = '44444444-4444-4444-8444-444444444444';
const DATE = '2026-10-20';

interface FakeOptions {
  session?: { user: { id: string } } | null;
  sessionError?: boolean;
  rpc?: { data?: unknown; error?: unknown } | (() => never);
  select?: { data?: unknown; error?: unknown };
}

function fakeClient(options: FakeOptions = {}) {
  const hasSession = 'session' in options;
  const session = hasSession ? options.session : { user: { id: USER_ID } };

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
  chain.select = record('select');
  chain.eq = record('eq');
  chain.order = record('order');
  chain.insert = record('insert');
  chain.update = record('update');
  chain.delete = record('delete');
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
    auth: {
      getSession: vi.fn(async () =>
        options.sessionError
          ? { data: { session: null }, error: { message: 'x' } }
          : { data: { session }, error: null }
      )
    },
    rpc,
    from
  } as unknown as SupabaseClient;

  return { client, rpc, from, calls };
}

const repoFor = (options?: FakeOptions) => {
  const f = fakeClient(options);
  return { ...f, repo: createBookingRepository(() => f.client) };
};

/** Await a call that must fail, and return its BookingError. */
const failure = async (promise: Promise<unknown>): Promise<BookingError> => {
  try {
    await promise;
  } catch (e) {
    if (e instanceof BookingError) return e;
    throw e;
  }
  throw new Error('expected the call to be rejected');
};

const request = { facilityId: FACILITY_ID, slotId: SLOT_ID, bookingDate: DATE };

describe('createBooking: success', () => {
  it('calls create_booking with the exact argument names and values', async () => {
    const { repo, rpc } = repoFor({
      rpc: {
        data: [{ booking_id: BOOKING_ID, booking_amount: '1200.00', expires_at: '2026-10-20T10:10:00+00:00' }]
      }
    });

    const created = await repo.createBooking(request);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(CREATE_BOOKING_RPC, {
      p_facility_id: FACILITY_ID,
      p_slot_id: SLOT_ID,
      p_booking_date: DATE
    });
    expect(CREATE_BOOKING_RPC).toBe('create_booking');

    // the amount and hold window come from the database response
    expect(created).toEqual({
      bookingId: BOOKING_ID,
      amount: 1200,
      expiresAt: '2026-10-20T10:10:00+00:00'
    });
  });

  it('never inserts into bookings and never sends a price', async () => {
    const { repo, rpc, calls } = repoFor({
      rpc: {
        data: [{ booking_id: BOOKING_ID, booking_amount: 500, expires_at: '2026-10-20T10:10:00Z' }]
      }
    });

    await repo.createBooking(request);

    expect(calls.filter(c => ['insert', 'update', 'delete'].includes(c[0]))).toEqual([]);
    expect(Object.keys(rpc.mock.calls[0][1] as object).sort()).toEqual([
      'p_booking_date',
      'p_facility_id',
      'p_slot_id'
    ]);
  });
});

describe('createBooking: conflicts and rejections', () => {
  const rejected = async (error: unknown) => {
    const { repo } = repoFor({ rpc: { error } });
    return repo.createBooking(request).then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: unknown) => e as BookingError
    );
  };

  it('maps an exclusion conflict (slot taken) to "unavailable"', async () => {
    const err = await rejected({ code: '23P01', message: 'The selected slot is no longer available' });
    expect(err).toBeInstanceOf(BookingError);
    expect(err.kind).toBe('unavailable');
    expect(err.message).toBe(MESSAGES.slotTaken);
  });

  it('maps a slot held for a waitlist offer to "unavailable"', async () => {
    const err = await rejected({
      code: 'P0001',
      message: 'The selected slot is currently held for a waitlist offer'
    });
    expect(err.kind).toBe('unavailable');
    expect(err.message).toBe(MESSAGES.slotHeld);
  });

  it('maps closed / inactive / not-bookable rejections to "unavailable"', async () => {
    for (const message of [
      'Facility is closed on the selected date',
      'Selected slot is not active',
      'Selected slot falls outside facility operating hours'
    ]) {
      const err = await rejected({ code: 'P0001', message });
      expect(err.kind).toBe('unavailable');
      expect(err.message).toBe(MESSAGES.slotUnavailable);
    }
  });

  it('maps not-found, limits and date errors', async () => {
    expect((await rejected({ code: 'P0002', message: 'Facility slot not found' })).kind).toBe('unavailable');
    expect((await rejected({ code: 'UB001', message: 'x' })).kind).toBe('limit');
    expect((await rejected({ code: '22007', message: 'x' })).message).toBe(MESSAGES.pastDate);
    expect((await rejected({ code: '22008', message: 'x' })).message).toBe(MESSAGES.tooFar);
    expect((await rejected({ code: '22023', message: 'x' })).kind).toBe('invalid');
  });

  it('maps an auth failure from the database to "unauthenticated"', async () => {
    for (const code of ['28000', '42501', 'PGRST301']) {
      const err = await rejected({ code, message: 'JWT expired' });
      expect(err.kind).toBe('unauthenticated');
      expect(err.message).toBe(MESSAGES.unauthenticated);
    }
  });

  it('does not leak raw server text for unexpected errors', async () => {
    const err = await rejected({
      code: 'XX000',
      message: 'relation "secret_internal_table" does not exist',
      details: 'schema internals',
      hint: 'run as superuser'
    });
    expect(err.kind).toBe('unknown');
    expect(err.message).toBe(MESSAGES.unknown);
    expect(err.message).not.toMatch(/secret_internal_table|superuser|internals/);
  });

  it('treats a network failure as an unknown outcome and says to check the schedule', async () => {
    const { repo } = repoFor({
      rpc: () => {
        throw new TypeError('Failed to fetch');
      }
    });
    const err = await failure(repo.createBooking(request));
    expect(err.kind).toBe('network');
    expect(err.message).toBe(MESSAGES.network);
    expect(err.message).toMatch(/Your Schedule/);
  });
});

describe('createBooking: session and input checks', () => {
  it('fails closed without a session and never calls the RPC', async () => {
    const { repo, rpc } = repoFor({ session: null });
    const err = await failure(repo.createBooking(request));

    expect(err).toBeInstanceOf(BookingError);
    expect(err.kind).toBe('unauthenticated');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('fails closed when the session cannot be read', async () => {
    const { repo, rpc } = repoFor({ sessionError: true });
    const err = await failure(repo.createBooking(request));

    expect(err.kind).toBe('unauthenticated');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects malformed ids and dates before any request', async () => {
    const { repo, rpc } = repoFor();

    for (const bad of [
      { ...request, facilityId: 'f1' },
      { ...request, slotId: 's58' },
      { ...request, bookingDate: '2026-02-30' },
      { ...request, bookingDate: '20/10/2026' },
      { ...request, bookingDate: '' }
    ]) {
      const err = await failure(repo.createBooking(bad));
      expect(err.kind).toBe('invalid');
    }

    expect(rpc).not.toHaveBeenCalled();
  });

  it('never reports success for a malformed or empty response', async () => {
    const responses: unknown[] = [
      null,
      [],
      [{}],
      [{ booking_id: 'not-a-uuid', booking_amount: 10, expires_at: '2026-10-20T10:10:00Z' }],
      [{ booking_id: BOOKING_ID, booking_amount: -5, expires_at: '2026-10-20T10:10:00Z' }],
      [{ booking_id: BOOKING_ID, booking_amount: 10, expires_at: 'soon' }],
      [
        { booking_id: BOOKING_ID, booking_amount: 10, expires_at: '2026-10-20T10:10:00Z' },
        { booking_id: BOOKING_ID, booking_amount: 10, expires_at: '2026-10-20T10:10:00Z' }
      ]
    ];

    for (const data of responses) {
      const { repo } = repoFor({ rpc: { data } });
      const err = await failure(repo.createBooking(request));
      expect(err, JSON.stringify(data)).toBeInstanceOf(BookingError);
      expect(err.kind).toBe('unknown');
    }
  });
});

describe('loadMyBookings', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: BOOKING_ID,
    facility_id: FACILITY_ID,
    slot_id: SLOT_ID,
    booking_date: DATE,
    start_time: '18:00:00',
    end_time: '19:00:00',
    amount: '1200.00',
    status: 'pending_payment',
    payment_status: 'pending',
    expires_at: '2099-01-01T00:00:00Z',
    created_at: '2026-10-20T10:00:00Z',
    facilities: { name: 'Marina Turf', sport: 'Football', address: 'Kowdiar', city: 'Trivandrum' },
    ...overrides
  });

  it('reads only the signed-in user\'s rows from bookings', async () => {
    const { repo, calls, from } = repoFor({ select: { data: [row()] } });

    const bookings = await repo.loadMyBookings();

    expect(from).toHaveBeenCalledWith('bookings');
    expect(calls).toContainEqual(['select', BOOKING_COLUMNS]);
    // explicit ownership filter: the SELECT policy also exposes other
    // players' bookings to venue owners and administrators
    expect(calls).toContainEqual(['eq', 'user_id', USER_ID]);
    expect(calls).toContainEqual(['limit', BOOKING_HISTORY_LIMIT]);
    expect(calls.filter(c => ['insert', 'update', 'delete'].includes(c[0]))).toEqual([]);

    expect(bookings).toHaveLength(1);
    expect(bookings[0]).toMatchObject({
      id: BOOKING_ID,
      bookingDate: DATE,
      timeLabel: '06:00 PM - 07:00 PM',
      amount: 1200,
      status: 'pending_payment',
      facilityName: 'Marina Turf',
      facilityLocation: 'Kowdiar, Trivandrum',
      sport: 'Football'
    });
  });

  it('returns an empty list when the user has no bookings', async () => {
    const { repo } = repoFor({ select: { data: [] } });
    await expect(repo.loadMyBookings()).resolves.toEqual([]);
  });

  it('tolerates a venue that is no longer visible', async () => {
    const { repo } = repoFor({ select: { data: [row({ facilities: null })] } });
    const [booking] = await repo.loadMyBookings();
    expect(booking.facilityName).toBeNull();
    expect(booking.facilityLocation).toBeNull();
  });

  it('reports a safe error and never falls back to local data', async () => {
    const { repo } = repoFor({
      select: { error: { code: 'XX000', message: 'permission denied for table payments' } }
    });
    const err = await failure(repo.loadMyBookings());
    expect(err).toBeInstanceOf(BookingError);
    expect(err.message).toBe(MESSAGES.loadFailed);
    expect(err.message).not.toMatch(/payments/);
  });

  it('rejects rows with an unknown status instead of guessing', async () => {
    const { repo } = repoFor({ select: { data: [row({ status: 'mystery' })] } });
    await expect(repo.loadMyBookings()).rejects.toBeInstanceOf(BookingError);
  });

  it('requires a session', async () => {
    const { repo, from } = repoFor({ session: null });
    const err = await failure(repo.loadMyBookings());
    expect(err.kind).toBe('unauthenticated');
    expect(from).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('effectiveStatus expires an unpaid hold by the clock', () => {
    const now = new Date('2026-10-20T10:00:00Z');
    expect(
      effectiveStatus({ status: 'pending_payment', expiresAt: '2026-10-20T09:59:59Z' }, now)
    ).toBe('expired');
    expect(
      effectiveStatus({ status: 'pending_payment', expiresAt: '2026-10-20T10:00:00Z' }, now)
    ).toBe('expired');
    expect(
      effectiveStatus({ status: 'pending_payment', expiresAt: '2026-10-20T10:05:00Z' }, now)
    ).toBe('pending_payment');
    expect(effectiveStatus({ status: 'confirmed', expiresAt: null }, now)).toBe('confirmed');
  });

  it('isCalendarDate accepts only real YYYY-MM-DD dates', () => {
    expect(isCalendarDate('2026-02-28')).toBe(true);
    expect(isCalendarDate('2024-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('2026-1-1')).toBe(false);
  });

  it('parseCreatedBooking accepts a single object as well as a one-row array', () => {
    const one = { booking_id: BOOKING_ID, booking_amount: 10, expires_at: '2026-10-20T10:10:00Z' };
    expect(parseCreatedBooking(one).bookingId).toBe(BOOKING_ID);
    expect(parseCreatedBooking([one]).bookingId).toBe(BOOKING_ID);
  });

  it('toBookingError is idempotent for BookingError', () => {
    const e = new BookingError('limit', 'x');
    expect(toBookingError(e)).toBe(e);
  });
});
