import { describe, it, expect, vi, beforeEach } from 'vitest';

// A fake query builder: records the query and answers as configured.
const query = { table: '', select: '', inIds: [] as string[], eq: [] as unknown[] };
let answer: { data: unknown; error: unknown } | Error = { data: [], error: null };
vi.mock('../supabaseClient', () => ({
  getSupabase: () => ({
    from(table: string) {
      query.table = table;
      const builder = {
        select(cols: string) { query.select = cols; return builder; },
        in(_col: string, ids: string[]) { query.inIds = ids; return builder; },
        eq(col: string, value: unknown) {
          query.eq = [col, value];
          if (answer instanceof Error) return Promise.reject(answer);
          return Promise.resolve(answer);
        },
      };
      return builder;
    },
  }),
}));

import { fetchOpenAttemptLeases, leaseFactsByBooking } from '../paymentClient';

const B1 = '22222222-2222-4222-8222-222222222222';
const B2 = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  answer = { data: [], error: null };
  query.table = '';
});

describe('leaseFactsByBooking: strict, or nothing', () => {
  it('groups open attempts per booking', () => {
    const m = leaseFactsByBooking([
      { booking_id: B1, state: 'open', checkout_lease_until: '2026-10-17T06:14:39+00:00' },
      { booking_id: B2, state: 'open', checkout_lease_until: null },
    ]);
    expect(m?.get(B1)).toEqual([{ checkoutLeaseUntil: '2026-10-17T06:14:39+00:00' }]);
    expect(m?.get(B2)).toEqual([{ checkoutLeaseUntil: null }]);
  });

  it('anything unexpected yields null (the caller then changes nothing)', () => {
    for (const rows of [
      null, {}, 'x', [null], [{ booking_id: 'nope', state: 'open', checkout_lease_until: null }],
      [{ booking_id: B1, state: 'closed', checkout_lease_until: null }],
      [{ booking_id: B1, state: 'open', checkout_lease_until: 5 }],
      [{ booking_id: B1, state: 'open' }],
    ]) {
      expect(leaseFactsByBooking(rows)).toBeNull();
    }
  });
});

describe('fetchOpenAttemptLeases: reads only the open attempts of the given bookings', () => {
  it('queries payment_attempts for open attempts of exactly those bookings', async () => {
    answer = { data: [{ booking_id: B1, state: 'open', checkout_lease_until: null }], error: null };
    const m = await fetchOpenAttemptLeases([B1, B2]);
    expect([query.table, query.select, query.inIds, query.eq]).toEqual([
      'payment_attempts', 'booking_id, state, checkout_lease_until', [B1, B2], ['state', 'open'],
    ]);
    expect(m?.get(B1)).toEqual([{ checkoutLeaseUntil: null }]);
  });

  it('no bookings: no query at all', async () => {
    expect(await fetchOpenAttemptLeases([])).toEqual(new Map());
    expect(query.table).toBe('');
  });

  it('an invalid id, a database error or a thrown error yields null', async () => {
    expect(await fetchOpenAttemptLeases(['not-a-uuid'])).toBeNull();
    expect(query.table).toBe('');
    answer = { data: null, error: { message: 'permission denied' } };
    expect(await fetchOpenAttemptLeases([B1])).toBeNull();
    answer = new Error('network');
    expect(await fetchOpenAttemptLeases([B1])).toBeNull();
  });
});
