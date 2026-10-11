import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createFacilityRepository,
  AvailabilityLoadError,
  AVAILABILITY_RPC,
  parseSlotAvailability,
  toAvailabilityMessage
} from '../facilityRepository';
import { getSlotAction, AvailabilityView } from '../slotAvailability';
import type { Slot } from '../../types';

const FACILITY = 'd0000000-0000-4000-8000-000000000001';
const SLOT_A = 'd1000000-0000-4000-8000-000000000101';
const SLOT_B = 'd1000000-0000-4000-8000-000000000102';

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

/** Fake client whose rpc() records the call and returns a canned result. */
function fakeClient(result: { data: unknown; error: unknown } | (() => never)) {
  const calls: RpcCall[] = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (typeof result === 'function') return result();
      return result;
    },
    // Any table read here would mean availability was not taken from the
    // database function.
    from: () => {
      throw new Error('availability must not read tables');
    }
  } as unknown as SupabaseClient;

  return { client, calls };
}

const slot = (overrides: Partial<Slot> = {}): Slot => ({
  id: SLOT_A,
  facilityId: FACILITY,
  time: '06:00 PM - 07:00 PM',
  price: 1100,
  isActive: true,
  ...overrides
});

describe('parseSlotAvailability', () => {
  it('maps rows to a slot id -> status record', () => {
    expect(
      parseSlotAvailability([
        { slot_id: SLOT_A, status: 'available' },
        { slot_id: SLOT_B, status: 'offer_held' }
      ])
    ).toEqual({ [SLOT_A]: 'available', [SLOT_B]: 'offer_held' });
  });

  it('accepts every documented status', () => {
    const statuses = ['available', 'booked', 'offer_held', 'inactive', 'closed'];
    const rows = statuses.map((status, i) => ({ slot_id: `s${i}`, status }));
    const parsed = parseSlotAvailability(rows);
    expect(Object.values(parsed)).toEqual(statuses);
  });

  it('returns an empty record for an empty result', () => {
    expect(parseSlotAvailability([])).toEqual({});
  });

  it('rejects an unrecognised status instead of guessing', () => {
    expect(() =>
      parseSlotAvailability([{ slot_id: SLOT_A, status: 'maybe' }])
    ).toThrow(AvailabilityLoadError);
  });

  it('rejects malformed rows and non-array data', () => {
    expect(() => parseSlotAvailability(null)).toThrow(AvailabilityLoadError);
    expect(() => parseSlotAvailability({})).toThrow(AvailabilityLoadError);
    expect(() => parseSlotAvailability([{ status: 'available' }])).toThrow(
      AvailabilityLoadError
    );
    expect(() => parseSlotAvailability([{ slot_id: SLOT_A }])).toThrow(
      AvailabilityLoadError
    );
  });
});

describe('toAvailabilityMessage', () => {
  it('translates the database error codes', () => {
    expect(toAvailabilityMessage({ code: '22007' })).toMatch(/date/i);
    expect(toAvailabilityMessage({ code: 'P0002' })).toMatch(/no longer available/i);
    expect(toAvailabilityMessage({ code: 'P0001' })).toMatch(/not currently open/i);
    expect(toAvailabilityMessage({ code: '28000' })).toMatch(/sign in/i);
  });

  it('never surfaces raw database messages', () => {
    const msg = toAvailabilityMessage({
      code: 'XX000',
      message: 'relation "public.bookings" does not exist'
    });
    expect(msg).not.toMatch(/bookings|relation/);
    expect(msg).toMatch(/try again/i);
  });
});

describe('loadSlotAvailability', () => {
  it('calls the database function with exactly the facility and date', async () => {
    const { client, calls } = fakeClient({
      data: [{ slot_id: SLOT_A, status: 'available' }],
      error: null
    });

    const result = await createFacilityRepository(() => client).loadSlotAvailability(
      FACILITY,
      '2026-10-13'
    );

    expect(result).toEqual({ [SLOT_A]: 'available' });
    expect(calls).toEqual([
      {
        fn: AVAILABILITY_RPC,
        args: { p_facility_id: FACILITY, p_booking_date: '2026-10-13' }
      }
    ]);
    expect(AVAILABILITY_RPC).toBe('get_slot_availability');
  });

  it('returns an empty record when the facility has no slots', async () => {
    const { client } = fakeClient({ data: [], error: null });
    await expect(
      createFacilityRepository(() => client).loadSlotAvailability(FACILITY, '2026-10-13')
    ).resolves.toEqual({});
  });

  it('turns a Supabase error into AvailabilityLoadError with a safe message', async () => {
    const { client } = fakeClient({
      data: null,
      error: { code: '22007', message: 'Booking date cannot be in the past' }
    });

    const err = await createFacilityRepository(() => client)
      .loadSlotAvailability(FACILITY, '2020-01-01')
      .catch(e => e);

    expect(err).toBeInstanceOf(AvailabilityLoadError);
    expect(err.message).toMatch(/date/i);
  });

  it('turns a thrown network failure into AvailabilityLoadError', async () => {
    const { client } = fakeClient(() => {
      throw new TypeError('Failed to fetch');
    });

    await expect(
      createFacilityRepository(() => client).loadSlotAvailability(FACILITY, '2026-10-13')
    ).rejects.toBeInstanceOf(AvailabilityLoadError);
  });

  it('fails when Supabase is not configured instead of assuming availability', async () => {
    const repo = createFacilityRepository(() => {
      throw new Error('Supabase is not configured');
    });

    await expect(
      repo.loadSlotAvailability(FACILITY, '2026-10-13')
    ).rejects.toBeInstanceOf(AvailabilityLoadError);
  });

  it('rejects a malformed date or missing facility before any request', async () => {
    const { client, calls } = fakeClient({ data: [], error: null });
    const repo = createFacilityRepository(() => client);

    await expect(repo.loadSlotAvailability(FACILITY, '13/10/2026')).rejects.toBeInstanceOf(
      AvailabilityLoadError
    );
    await expect(repo.loadSlotAvailability(FACILITY, '')).rejects.toBeInstanceOf(
      AvailabilityLoadError
    );
    await expect(repo.loadSlotAvailability('', '2026-10-13')).rejects.toBeInstanceOf(
      AvailabilityLoadError
    );
    expect(calls).toEqual([]);
  });

  it('does not touch localStorage or read bookings from the mock service', async () => {
    const touched: string[] = [];
    const trap = (name: string) => () => {
      touched.push(name);
      return null;
    };
    (globalThis as any).localStorage = {
      getItem: trap('getItem'),
      setItem: trap('setItem'),
      removeItem: trap('removeItem'),
      clear: trap('clear')
    };

    const ok = fakeClient({ data: [], error: null });
    await createFacilityRepository(() => ok.client).loadSlotAvailability(
      FACILITY,
      '2026-10-13'
    );

    const bad = fakeClient({ data: null, error: { message: 'down' } });
    await createFacilityRepository(() => bad.client)
      .loadSlotAvailability(FACILITY, '2026-10-13')
      .catch(() => undefined);

    expect(touched).toEqual([]);

    const source = readFileSync(
      fileURLToPath(new URL('../facilityRepository.ts', import.meta.url)),
      'utf8'
    );
    const imports = source.split('\n').filter(l => /^\s*import\b/.test(l)).join('\n');
    expect(imports).not.toMatch(/bookingService|storageService|facilityService/);
  });
});

describe('getSlotAction', () => {
  const ready = (byId: Record<string, any>): AvailabilityView => ({
    phase: 'ready',
    byId
  });

  it('allows booking only for an available slot with checkout enabled', () => {
    expect(getSlotAction(slot(), ready({ [SLOT_A]: 'available' }), true)).toEqual({
      label: 'Book',
      bookable: true,
      muted: false
    });
  });

  it('keeps an available slot unbookable while checkout is gated', () => {
    expect(getSlotAction(slot(), ready({ [SLOT_A]: 'available' }), false)).toEqual({
      label: 'Soon',
      bookable: false,
      muted: false
    });
  });

  it.each([
    ['booked', 'Full'],
    ['offer_held', 'Held'],
    ['closed', 'Closed'],
    ['inactive', 'Unavailable']
  ])('never allows booking a %s slot', (status, label) => {
    const action = getSlotAction(slot(), ready({ [SLOT_A]: status }), true);
    expect(action).toEqual({ label, bookable: false, muted: true });
  });

  it('is not bookable while loading, with no answer assumed', () => {
    const action = getSlotAction(slot(), { phase: 'loading' }, true);
    expect(action.bookable).toBe(false);
    expect(action.label).toBe('Checking');
  });

  it('is not bookable after a failed read', () => {
    const action = getSlotAction(
      slot(),
      { phase: 'error', message: 'Could not check slot availability.' },
      true
    );
    expect(action.bookable).toBe(false);
    expect(action.label).toBe('Unknown');
  });

  it('treats a slot missing from the answer as unavailable', () => {
    const action = getSlotAction(slot(), ready({ [SLOT_B]: 'available' }), true);
    expect(action.bookable).toBe(false);
  });

  it('never books a slot the catalog marks inactive, whatever the answer', () => {
    const action = getSlotAction(
      slot({ isActive: false }),
      ready({ [SLOT_A]: 'available' }),
      true
    );
    expect(action.bookable).toBe(false);
  });
});
