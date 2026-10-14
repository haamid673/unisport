import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createOwnerFacilityRepository,
  OwnerError,
  OWNER_FACILITY_COLUMNS,
  OWNER_MESSAGES,
  describeFacilityStatus,
  mapOperatingWeek,
  toMinutes,
  toOwnerError,
  validateFacilityInput,
  validateOperatingDay,
  validateSlotInput,
  FACILITY_STATUSES
} from '../ownerFacilityRepository';

// Service-boundary tests with a stand-in client. They show what this
// module sends and how it reads answers. They do NOT prove database
// authorization: that is enforced by RLS and is covered by the pgTAP
// suite (facility_status_insert_test and friends).

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const FACILITY_ID = '22222222-2222-4222-8222-222222222222';
const SLOT_ID = '33333333-3333-4333-8333-333333333333';
const ROW_ID = '44444444-4444-4444-8444-444444444444';

type Result = { data?: unknown; error?: unknown };

interface Fake {
  session?: { user: { id: string } } | null;
  /** Answer per `${table}:${operation}` where operation is select|insert|update|delete. */
  results?: Record<string, Result>;
}

function fakeClient(options: Fake = {}) {
  const session = 'session' in options ? options.session : { user: { id: OWNER_ID } };
  const log: Array<{ table: string; operation: string; payload?: unknown; calls: Array<[string, ...unknown[]]> }> = [];

  const from = vi.fn((table: string) => {
    const entry = { table, operation: 'select', payload: undefined as unknown, calls: [] as Array<[string, ...unknown[]]> };
    log.push(entry);

    const builder: Record<string, unknown> = {};
    const mutate = (op: string) => (payload: unknown) => {
      entry.operation = op;
      entry.payload = payload;
      return builder;
    };
    builder.insert = mutate('insert');
    builder.update = mutate('update');
    builder.delete = mutate('delete');
    builder.upsert = mutate('upsert');
    for (const name of ['select', 'eq', 'in', 'order', 'limit', 'single', 'maybeSingle']) {
      builder[name] = (...args: unknown[]) => {
        entry.calls.push([name, ...args]);
        return builder;
      };
    }
    builder.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
      const r = options.results?.[`${table}:${entry.operation}`] ?? { data: [], error: null };
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null }).then(resolve, reject);
    };
    return builder;
  });

  const client = {
    auth: { getSession: vi.fn(async () => ({ data: { session }, error: null })) },
    from,
    rpc: vi.fn()
  } as unknown as SupabaseClient;

  return { client, from, log };
}

const repoFor = (options?: Fake) => {
  const f = fakeClient(options);
  return { ...f, repo: createOwnerFacilityRepository(() => f.client) };
};

const failure = async (promise: Promise<unknown>): Promise<OwnerError> => {
  try {
    await promise;
  } catch (e) {
    if (e instanceof OwnerError) return e;
    throw e;
  }
  throw new Error('expected the call to be rejected');
};

const facilityRow = (overrides: Record<string, unknown> = {}) => ({
  id: FACILITY_ID,
  name: 'Marina Turf',
  description: null,
  sport: 'Football',
  address: 'Kowdiar Road',
  city: 'Trivandrum',
  capacity: 22,
  base_price: '1500.00',
  status: 'pending',
  created_at: '2026-10-20T10:00:00Z',
  ...overrides
});

const validInput = {
  name: 'Marina Turf',
  description: '',
  sport: 'Football',
  address: 'Kowdiar Road',
  city: 'Trivandrum',
  capacity: '22',
  basePrice: '1500'
};

describe('listing the owner\'s facilities', () => {
  it('reads only facilities owned by the signed-in user, in every status', async () => {
    const { repo, log } = repoFor({
      results: {
        'facilities:select': {
          data: FACILITY_STATUSES.map((status, i) => facilityRow({ id: `${i}`.padStart(8, '0') + '-2222-4222-8222-222222222222', status }))
        }
      }
    });

    const facilities = await repo.loadMyFacilities();

    expect(log).toHaveLength(1);
    expect(log[0].table).toBe('facilities');
    expect(log[0].operation).toBe('select');
    expect(log[0].calls).toContainEqual(['select', OWNER_FACILITY_COLUMNS]);
    expect(log[0].calls).toContainEqual(['eq', 'owner_id', OWNER_ID]);

    // statuses are the database's own, never remapped
    expect(facilities.map(f => f.status)).toEqual(['pending', 'active', 'suspended', 'rejected']);
    expect(facilities[0].basePrice).toBe(1500);
  });

  it('returns an empty list for an owner with no venues', async () => {
    const { repo } = repoFor({ results: { 'facilities:select': { data: [] } } });
    await expect(repo.loadMyFacilities()).resolves.toEqual([]);
  });

  it('fails closed when signed out and never queries', async () => {
    const { repo, from } = repoFor({ session: null });
    expect((await failure(repo.loadMyFacilities())).kind).toBe('unauthenticated');
    expect(from).not.toHaveBeenCalled();
  });

  it('rejects an unknown status instead of guessing', async () => {
    const { repo } = repoFor({
      results: { 'facilities:select': { data: [facilityRow({ status: 'approved' })] } }
    });
    await expect(repo.loadMyFacilities()).rejects.toBeInstanceOf(OwnerError);
  });

  it('reports a safe error for database failures', async () => {
    const { repo } = repoFor({
      results: { 'facilities:select': { error: { code: 'XX000', message: 'relation "x" is broken' } } }
    });
    const err = await failure(repo.loadMyFacilities());
    expect(err.message).toBe(OWNER_MESSAGES.unknown);
    expect(err.message).not.toMatch(/relation/);
  });
});

describe('createFacility', () => {
  it('inserts with the session owner id and never sends a status', async () => {
    const { repo, log } = repoFor({
      results: { 'facilities:insert': { data: facilityRow() } }
    });

    const created = await repo.createFacility(validInput);

    const insert = log.find(l => l.operation === 'insert')!;
    expect(insert.table).toBe('facilities');
    expect(insert.payload).toEqual({
      owner_id: OWNER_ID,
      name: 'Marina Turf',
      description: null,
      sport: 'Football',
      address: 'Kowdiar Road',
      city: 'Trivandrum',
      capacity: 22,
      base_price: 1500
    });
    expect(Object.keys(insert.payload as object)).not.toContain('status');
    expect(created.status).toBe('pending');
  });

  it('stores a city exactly once spelled: whitespace is collapsed, casing kept', async () => {
    const { repo, log } = repoFor({
      results: { 'facilities:insert': { data: facilityRow({ city: 'New Delhi' }) } }
    });

    await repo.createFacility({ ...validInput, city: '  New   Delhi  ' });

    const insert = log.find(l => l.operation === 'insert')!;
    expect((insert.payload as { city: string }).city).toBe('New Delhi');
  });

  it('accepts a city that is not in the customer\'s old hardcoded list', async () => {
    const { repo, log } = repoFor({
      results: { 'facilities:insert': { data: facilityRow({ city: 'Kochi' }) } }
    });

    const created = await repo.createFacility({ ...validInput, city: 'Kochi' });

    expect((log.find(l => l.operation === 'insert')!.payload as { city: string }).city).toBe('Kochi');
    expect(created.city).toBe('Kochi');
  });

  it('validates before any request and returns field errors', async () => {
    const { repo, from } = repoFor();
    const err = await failure(
      repo.createFacility({ ...validInput, name: 'A', basePrice: '-5', capacity: '0', address: 'abc' })
    );

    expect(err.kind).toBe('invalid');
    expect(Object.keys(err.fields).sort()).toEqual(['address', 'basePrice', 'capacity', 'name']);
    expect(from).not.toHaveBeenCalled();
  });

  it('maps a database refusal (not an owner, or a constraint) to safe messages', async () => {
    let r = repoFor({ results: { 'facilities:insert': { error: { code: '42501', message: 'new row violates row-level security policy' } } } });
    let err = await failure(r.repo.createFacility(validInput));
    expect(err.kind).toBe('forbidden');
    expect(err.message).toBe(OWNER_MESSAGES.forbidden);
    expect(err.message).not.toMatch(/row-level/);

    r = repoFor({ results: { 'facilities:insert': { error: { code: '23514', message: 'violates check constraint "facilities_name_length"' } } } });
    err = await failure(r.repo.createFacility(validInput));
    expect(err.kind).toBe('invalid');
    expect(err.message).not.toMatch(/facilities_name_length/);
  });

  it('requires a session', async () => {
    const { repo, from } = repoFor({ session: null });
    expect((await failure(repo.createFacility(validInput))).kind).toBe('unauthenticated');
    expect(from).not.toHaveBeenCalled();
  });
});

describe('updateFacility', () => {
  it('sends only editable fields, never owner_id or status', async () => {
    const { repo, log } = repoFor({
      results: { 'facilities:update': { data: facilityRow({ name: 'Renamed Turf' }) } }
    });

    const updated = await repo.updateFacility(FACILITY_ID, { ...validInput, name: 'Renamed Turf' });

    const update = log.find(l => l.operation === 'update')!;
    expect(Object.keys(update.payload as object).sort()).toEqual([
      'address', 'base_price', 'capacity', 'city', 'description', 'name', 'sport'
    ]);
    expect(update.calls).toContainEqual(['eq', 'id', FACILITY_ID]);
    expect(updated.name).toBe('Renamed Turf');
  });

  it('treats zero matched rows (another owner\'s venue) as forbidden, never success', async () => {
    const { repo } = repoFor({ results: { 'facilities:update': { data: null } } });
    const err = await failure(repo.updateFacility(FACILITY_ID, validInput));
    expect(err.kind).toBe('forbidden');
  });

  it('maps a database refusal and validates first', async () => {
    const r = repoFor({ results: { 'facilities:update': { error: { code: '42501', message: 'denied' } } } });
    expect((await failure(r.repo.updateFacility(FACILITY_ID, validInput))).kind).toBe('forbidden');

    const bad = repoFor();
    expect((await failure(bad.repo.updateFacility('f1', validInput))).kind).toBe('invalid');
    expect((await failure(bad.repo.updateFacility(FACILITY_ID, { ...validInput, sport: '' }))).kind).toBe('invalid');
    expect(bad.from).not.toHaveBeenCalled();
  });
});

describe('operating hours', () => {
  it('maps a sparse week to seven days and marks unset days', () => {
    const week = mapOperatingWeek([
      { id: ROW_ID, day_of_week: 1, opens_at: '06:00:00', closes_at: '22:00:00', is_closed: false },
      { id: SLOT_ID, day_of_week: 0, opens_at: null, closes_at: null, is_closed: true }
    ]);

    expect(week.days).toHaveLength(7);
    expect(week.days[1]).toMatchObject({ configured: true, opensAt: '06:00', closesAt: '22:00', isClosed: false, rowId: ROW_ID });
    expect(week.days[0]).toMatchObject({ configured: true, isClosed: true });
    expect(week.days[3]).toMatchObject({ configured: false, rowId: null });
  });

  it('inserts a new day and updates an existing one by id', async () => {
    const insert = repoFor();
    await insert.repo.saveOperatingDay(
      FACILITY_ID,
      { dayOfWeek: 2, isClosed: false, opensAt: '06:00', closesAt: '22:00' },
      null
    );
    const ins = insert.log.find(l => l.operation === 'insert')!;
    expect(ins.table).toBe('facility_operating_hours');
    expect(ins.payload).toEqual({
      facility_id: FACILITY_ID, day_of_week: 2, is_closed: false, opens_at: '06:00', closes_at: '22:00'
    });

    const update = repoFor({ results: { 'facility_operating_hours:update': { data: [{ id: ROW_ID }] } } });
    await update.repo.saveOperatingDay(
      FACILITY_ID,
      { dayOfWeek: 2, isClosed: true, opensAt: '06:00', closesAt: '22:00' },
      ROW_ID
    );
    const upd = update.log.find(l => l.operation === 'update')!;
    // a closed day carries no times (matches the table's check constraint)
    expect(upd.payload).toEqual({ is_closed: true, opens_at: null, closes_at: null });
  });

  it('resolves with the saved row id so the caller can update it next time', async () => {
    const insert = repoFor({
      results: { 'facility_operating_hours:insert': { data: [{ id: ROW_ID }] } }
    });
    await expect(
      insert.repo.saveOperatingDay(
        FACILITY_ID,
        { dayOfWeek: 2, isClosed: false, opensAt: '06:00', closesAt: '22:00' },
        null
      )
    ).resolves.toBe(ROW_ID);

    const update = repoFor({ results: { 'facility_operating_hours:update': { data: [{ id: ROW_ID }] } } });
    await expect(
      update.repo.saveOperatingDay(
        FACILITY_ID,
        { dayOfWeek: 2, isClosed: false, opensAt: '06:00', closesAt: '22:00' },
        ROW_ID
      )
    ).resolves.toBe(ROW_ID);
  });

  it('refuses opens >= closes before any request, and zero updated rows', async () => {
    const bad = repoFor();
    const err = await failure(
      bad.repo.saveOperatingDay(FACILITY_ID, { dayOfWeek: 1, isClosed: false, opensAt: '22:00', closesAt: '06:00' }, null)
    );
    expect(err.kind).toBe('invalid');
    expect(bad.from).not.toHaveBeenCalled();

    const none = repoFor({ results: { 'facility_operating_hours:update': { data: [] } } });
    const denied = await failure(
      none.repo.saveOperatingDay(FACILITY_ID, { dayOfWeek: 1, isClosed: false, opensAt: '06:00', closesAt: '22:00' }, ROW_ID)
    );
    expect(denied.kind).toBe('forbidden');
  });

  it('validateOperatingDay covers closed, open and bad days', () => {
    expect(validateOperatingDay({ dayOfWeek: 0, isClosed: true, opensAt: null, closesAt: null })).toEqual({ ok: true });
    expect(validateOperatingDay({ dayOfWeek: 9, isClosed: true, opensAt: null, closesAt: null }).ok).toBe(false);
    expect(validateOperatingDay({ dayOfWeek: 1, isClosed: false, opensAt: null, closesAt: '10:00' }).ok).toBe(false);
  });
});

describe('slots', () => {
  const slotRow = (overrides: Record<string, unknown> = {}) => ({
    id: SLOT_ID, facility_id: FACILITY_ID, start_time: '18:00:00', end_time: '19:00:00',
    duration_min: 60, base_price: '500.00', is_active: true, ...overrides
  });

  it('creates a slot with a computed duration and no status or owner fields', async () => {
    const { repo, log } = repoFor({ results: { 'facility_slots:insert': { data: slotRow() } } });

    const slot = await repo.createSlot(
      FACILITY_ID,
      { startTime: '18:00', endTime: '19:00', basePrice: '500' },
      []
    );

    const insert = log.find(l => l.operation === 'insert')!;
    expect(insert.table).toBe('facility_slots');
    expect(insert.payload).toEqual({
      facility_id: FACILITY_ID, start_time: '18:00', end_time: '19:00',
      duration_min: 60, base_price: 500, is_active: true
    });
    expect(slot.timeLabel).toBe('06:00 PM - 07:00 PM');
  });

  it('refuses invalid and overlapping slots before any request', async () => {
    const existing = [{ startTime: '18:00', endTime: '19:00' }];
    const { repo, from } = repoFor();

    const overlap = await failure(
      repo.createSlot(FACILITY_ID, { startTime: '18:30', endTime: '19:30', basePrice: '500' }, existing as never)
    );
    expect(overlap.fields.startTime).toMatch(/overlaps/);

    const backwards = await failure(
      repo.createSlot(FACILITY_ID, { startTime: '19:00', endTime: '18:00', basePrice: '500' }, [])
    );
    expect(backwards.fields.endTime).toBeTruthy();

    expect(from).not.toHaveBeenCalled();
  });

  it('allows back-to-back slots', () => {
    const r = validateSlotInput(
      { startTime: '19:00', endTime: '20:00', basePrice: '500' },
      [{ startTime: '18:00', endTime: '19:00' }]
    );
    expect(r.ok).toBe(true);
  });

  it('maps a duplicate slot', async () => {
    const { repo } = repoFor({
      results: { 'facility_slots:insert': { error: { code: '23505', message: 'duplicate key value violates unique constraint' } } }
    });
    const err = await failure(
      repo.createSlot(FACILITY_ID, { startTime: '18:00', endTime: '19:00', basePrice: '500' }, [])
    );
    expect(err.kind).toBe('duplicate');
    expect(err.message).toBe(OWNER_MESSAGES.duplicateSlot);
  });

  it('explains an overlapping slot (23P01) with an actionable message', async () => {
    const named = repoFor({
      results: { 'facility_slots:insert': { error: { code: '23P01', message: 'conflicting key value violates exclusion constraint "facility_slots_no_overlap"' } } }
    });
    const err = await failure(
      named.repo.createSlot(FACILITY_ID, { startTime: '18:30', endTime: '19:30', basePrice: '500' }, [])
    );
    expect(err.kind).toBe('conflict');
    expect(err.message).toBe(OWNER_MESSAGES.slotOverlap);
    expect(err.message).toMatch(/overlaps another slot/i);
    expect(err.message).not.toMatch(/exclusion|constraint|facility_slots_no_overlap/);

    // no constraint name in the response: the write itself says it is a slot
    const unnamed = repoFor({
      results: { 'facility_slots:insert': { error: { code: '23P01', message: 'conflicting key value violates exclusion constraint' } } }
    });
    const err2 = await failure(
      unnamed.repo.createSlot(FACILITY_ID, { startTime: '18:30', endTime: '19:30', basePrice: '500' }, [])
    );
    expect(err2.message).toBe(OWNER_MESSAGES.slotOverlap);
  });

  it('does not call a different exclusion constraint a slot overlap', () => {
    const err = toOwnerError({
      code: '23P01',
      message: 'conflicting key value violates exclusion constraint "bookings_no_facility_overlap"'
    });
    expect(err.kind).toBe('conflict');
    expect(err.message).toBe(OWNER_MESSAGES.conflict);
    expect(err.message).not.toBe(OWNER_MESSAGES.slotOverlap);
  });

  it('describes a unique violation by what was written, not always as a slot', async () => {
    // operating hours: one row per facility and weekday
    const hours = repoFor({
      results: { 'facility_operating_hours:insert': { error: { code: '23505', message: 'duplicate key value violates unique constraint "operating_hours_unique_day"' } } }
    });
    const h = await failure(
      hours.repo.saveOperatingDay(
        FACILITY_ID,
        { dayOfWeek: 2, isClosed: false, opensAt: '06:00', closesAt: '22:00' },
        null
      )
    );
    expect(h.kind).toBe('duplicate');
    expect(h.message).toBe(OWNER_MESSAGES.duplicateHours);
    expect(h.message).not.toBe(OWNER_MESSAGES.duplicateSlot);

    // same, when the response does not name the constraint
    const unnamed = repoFor({
      results: { 'facility_operating_hours:insert': { error: { code: '23505', message: 'duplicate key value violates unique constraint' } } }
    });
    const h2 = await failure(
      unnamed.repo.saveOperatingDay(
        FACILITY_ID,
        { dayOfWeek: 2, isClosed: false, opensAt: '06:00', closesAt: '22:00' },
        null
      )
    );
    expect(h2.message).toBe(OWNER_MESSAGES.duplicateHours);

    // a named slot constraint is a slot even without operation context
    expect(
      toOwnerError({ code: '23505', message: 'duplicate key value violates unique constraint "facility_slots_unique_time"' }).message
    ).toBe(OWNER_MESSAGES.duplicateSlot);

    // anything else: a neutral message, never the slot wording
    for (const err of [
      toOwnerError({ code: '23505', message: 'duplicate key value violates unique constraint' }),
      toOwnerError({ code: '23505', message: 'duplicate key value violates unique constraint "something_else"' }, 'slot')
    ]) {
      expect(err.kind).toBe('duplicate');
      expect(err.message).toBe(OWNER_MESSAGES.duplicate);
      expect(err.message).not.toBe(OWNER_MESSAGES.duplicateSlot);
    }
  });

  it('keeps the existing mapping for unrelated errors', () => {
    expect(toOwnerError({ code: '42501', message: 'x' }).kind).toBe('forbidden');
    expect(toOwnerError({ code: '23514', message: 'x' }, 'slot').kind).toBe('invalid');
    expect(toOwnerError({ code: '23503', message: 'x' }).kind).toBe('conflict');
    expect(toOwnerError({ code: '28000', message: 'x' }).kind).toBe('unauthenticated');
    expect(toOwnerError({ code: '99999', message: 'secret' }, 'slot').message).toBe(OWNER_MESSAGES.unknown);
    expect(toOwnerError(new TypeError('Failed to fetch')).kind).toBe('network');
  });

  it('toggles active state with an UPDATE of is_active only', async () => {
    const { repo, log } = repoFor({
      results: { 'facility_slots:update': { data: slotRow({ is_active: false }) } }
    });

    const slot = await repo.setSlotActive(SLOT_ID, false);

    const update = log.find(l => l.operation === 'update')!;
    expect(update.payload).toEqual({ is_active: false });
    expect(slot.isActive).toBe(false);
    expect(log.some(l => l.operation === 'delete')).toBe(false);
  });

  it('reports another owner\'s slot (no row matched) as forbidden', async () => {
    const { repo } = repoFor({ results: { 'facility_slots:update': { data: null } } });
    expect((await failure(repo.setSlotActive(SLOT_ID, true))).kind).toBe('forbidden');
  });
});

describe('facility bookings', () => {
  it('reads bookings of one facility, read-only, without the player id', async () => {
    const { repo, log } = repoFor({
      results: {
        'bookings:select': {
          data: [{
            id: ROW_ID, facility_id: FACILITY_ID, slot_id: SLOT_ID, booking_date: '2026-10-21',
            start_time: '18:00:00', end_time: '19:00:00', amount: '500.00',
            status: 'pending_payment', payment_status: 'pending',
            expires_at: '2099-01-01T00:00:00Z', created_at: '2026-10-20T10:00:00Z'
          }]
        }
      }
    });

    const bookings = await repo.loadFacilityBookings(FACILITY_ID);

    const entry = log[0];
    expect(entry.table).toBe('bookings');
    expect(entry.operation).toBe('select');
    expect(entry.calls).toContainEqual(['eq', 'facility_id', FACILITY_ID]);
    const selected = entry.calls.find(c => c[0] === 'select')![1] as string;
    expect(selected).not.toMatch(/user_id/);
    expect(bookings[0]).toMatchObject({ amount: 500, status: 'pending_payment', timeLabel: '06:00 PM - 07:00 PM' });
  });

  it('surfaces errors safely and requires a valid facility id', async () => {
    const { repo } = repoFor({ results: { 'bookings:select': { error: { code: '42501', message: 'x' } } } });
    expect((await failure(repo.loadFacilityBookings(FACILITY_ID))).kind).toBe('forbidden');
    expect((await failure(repo.loadFacilityBookings('nope'))).kind).toBe('invalid');
  });
});

describe('validation and presentation helpers', () => {
  it('validateFacilityInput trims and normalises', () => {
    const r = validateFacilityInput({ ...validInput, name: '  Marina Turf  ', description: '  ', capacity: '' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe('Marina Turf');
      expect(r.value.description).toBeNull();
      expect(r.value.capacity).toBeNull();
    }
  });

  it('rejects prices the column cannot store', () => {
    for (const price of ['', 'free', '-1', '10.123', '123456789']) {
      expect(validateFacilityInput({ ...validInput, basePrice: price }).ok, price).toBe(false);
    }
    expect(validateFacilityInput({ ...validInput, basePrice: '0' }).ok).toBe(true);
    expect(validateFacilityInput({ ...validInput, basePrice: '99.5' }).ok).toBe(true);
  });

  it('toMinutes reads HH:MM and HH:MM:SS', () => {
    expect(toMinutes('06:30')).toBe(390);
    expect(toMinutes('18:00:00')).toBe(1080);
    expect(toMinutes('24:00')).toBeNull();
    expect(toMinutes('6:30')).toBeNull();
  });

  it('describes every real status and explains pending approval', () => {
    for (const status of FACILITY_STATUSES) {
      const d = describeFacilityStatus(status);
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.explanation.length).toBeGreaterThan(0);
    }
    expect(describeFacilityStatus('pending').explanation).toMatch(/administrator must approve/i);
    expect(FACILITY_STATUSES).toEqual(['pending', 'active', 'suspended', 'rejected']);
  });

  it('toOwnerError is idempotent and never leaks raw text', () => {
    const e = new OwnerError('forbidden', 'x');
    expect(toOwnerError(e)).toBe(e);
    expect(toOwnerError({ code: '99999', message: 'secret detail' }).message).toBe(OWNER_MESSAGES.unknown);
  });
});

describe('source guarantees', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../ownerFacilityRepository.ts', import.meta.url)),
    'utf8'
  )
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  it('never deletes, never calls RPCs, never persists locally', () => {
    expect(source).not.toMatch(/\.delete\(|\.upsert\(|\.rpc\(/);
    expect(source).not.toMatch(/localStorage|sessionStorage|storageService|facilityService|eventService/);
  });

  it('never writes a status or an owner other than the session user', () => {
    // Inspect only the payload objects handed to .insert() / .update().
    const payloads = source.match(/\.(insert|update)\(\{[\s\S]*?\}\)/g) ?? [];
    expect(payloads.length).toBeGreaterThanOrEqual(5);

    for (const payload of payloads) {
      expect(payload, payload).not.toMatch(/\bstatus\b/);
    }

    const owners = payloads.filter(p => /owner_id/.test(p));
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatch(/owner_id: userId/);
    expect(owners[0]).toMatch(/^\.insert\(/);
  });
});
