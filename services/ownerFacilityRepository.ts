import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from './supabaseClient';
import { formatSlotTime } from './facilityRepository';
import {
  UUID_PATTERN,
  UserBooking,
  BookingRow,
  mapBookingRow
} from './bookingRepository';
import { collapseCity } from './cityFilter';

/**
 * Owner facility management, backed by Supabase.
 *
 * Authorization model (all enforced by the database, never by this
 * module). Sources: supabase/migrations/20261008135914_facilities.sql,
 * 20261008140109_facility_scheduling.sql,
 * 20261010180700_require_pending_status_on_facility_insert.sql,
 * 20261010181100_least_privilege_table_grants.sql and the bookings
 * SELECT policy in 20261008140917_bookings_payments.sql.
 *
 *   - Role: profiles.role = 'owner'. There is no client path to obtain
 *     it; it is assigned by a database administrator.
 *   - facilities INSERT: owner_id = auth.uid() AND role 'owner' AND
 *     status = 'pending' (the column default). Anything else is refused.
 *   - facilities UPDATE: own rows only, and owner_id and status cannot
 *     change. Owners therefore can never approve, suspend, reject or
 *     reassign a facility. Only administrators can.
 *   - facilities DELETE: administrators only. Not offered here.
 *   - facility_operating_hours / facility_slots: INSERT, UPDATE, DELETE
 *     when owns_facility(facility_id). A slot referenced by a booking or
 *     waitlist entry cannot be deleted (ON DELETE RESTRICT), so slots
 *     are deactivated instead. Not deleted here.
 *   - facility_images needs Storage, which does not exist yet. Not
 *     offered here.
 *   - bookings SELECT: own rows, or rows of a facility the caller owns.
 *     Read-only. Owners cannot create, change or cancel bookings.
 *
 * What this module never does:
 *   - send status, or trust an owner id from the UI. The owner id is
 *     read from the authenticated session and is re-checked by RLS;
 *   - write anything the database owns through an RPC;
 *   - fall back to local or demo data.
 */

export type FacilityRecordStatus = 'pending' | 'active' | 'suspended' | 'rejected';

export interface OwnerFacility {
  id: string;
  name: string;
  description: string | null;
  sport: string;
  address: string;
  city: string;
  capacity: number | null;
  basePrice: number;
  status: FacilityRecordStatus;
  createdAt: string;
}

export interface FacilityInput {
  name: string;
  description: string;
  sport: string;
  address: string;
  city: string;
  /** Empty string means "not set". */
  capacity: string;
  basePrice: string;
}

export interface OperatingDay {
  /** 0 = Sunday ... 6 = Saturday, as in the database. */
  dayOfWeek: number;
  isClosed: boolean;
  /** "HH:MM" or null when closed. */
  opensAt: string | null;
  closesAt: string | null;
}

export interface OwnerSlot {
  id: string;
  facilityId: string;
  startTime: string;
  endTime: string;
  timeLabel: string;
  durationMin: number;
  basePrice: number;
  isActive: boolean;
}

export interface SlotInput {
  /** "HH:MM" */
  startTime: string;
  endTime: string;
  basePrice: string;
}

export type OwnerFailureKind =
  | 'unauthenticated'
  /** Not permitted, or the row is not visible to this owner. */
  | 'forbidden'
  | 'invalid'
  | 'duplicate'
  | 'conflict'
  | 'network'
  | 'unknown';

export class OwnerError extends Error {
  readonly kind: OwnerFailureKind;
  /** Per-field messages when kind is "invalid". */
  readonly fields: Record<string, string>;

  constructor(kind: OwnerFailureKind, message: string, fields: Record<string, string> = {}) {
    super(message);
    this.name = 'OwnerError';
    this.kind = kind;
    this.fields = fields;
  }
}

export const OWNER_MESSAGES = {
  unauthenticated: 'Your session has expired. Please sign in again.',
  forbidden:
    'You do not have permission to change that, or it no longer exists.',
  invalid: 'Please check the highlighted details.',
  duplicateSlot: 'A slot with those exact times already exists.',
  duplicateHours: 'Hours for that day already exist. Reload the page and try again.',
  duplicate: 'That already exists. Reload the page and try again.',
  slotOverlap:
    'This slot overlaps another slot at this venue. Choose times that do not overlap an existing slot (a slot may start exactly when another ends).',
  conflict: 'That change conflicts with existing data.',
  network: 'Could not reach the service. Please check your connection and try again.',
  unknown: 'Something went wrong. Please try again.',
  loadFailed: 'Could not load this information. Please try again.'
} as const;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

/** What the failing request was writing; used when no constraint is named. */
export type OwnerOperation = 'slot' | 'hours';

/** Constraints the owner's writes can violate (see the migrations). */
const SLOT_UNIQUE_TIME = 'facility_slots_unique_time';
const SLOT_NO_OVERLAP = 'facility_slots_no_overlap';
const HOURS_UNIQUE_DAY = 'operating_hours_unique_day';

/**
 * The constraint a PostgREST error names, if it names one. Only used to
 * choose a message: the raw text is never shown.
 */
const constraintOf = (e: Record<string, unknown> | null): string | null => {
  for (const field of ['message', 'details']) {
    const text = e?.[field];
    if (typeof text !== 'string') continue;
    const match = /constraint "([^"]+)"/.exec(text);
    if (match) return match[1];
  }
  return null;
};

/**
 * Map a PostgREST/Postgres error to a safe OwnerError.
 *
 * `context` says what was being written. It decides the message only
 * when the error does not name its constraint, so a unique violation is
 * never described as a duplicate slot unless it really was one.
 */
export function toOwnerError(error: unknown, context?: OwnerOperation): OwnerError {
  if (error instanceof OwnerError) return error;

  const e = asRecord(error);
  const code = typeof e?.code === 'string' ? e.code : undefined;

  switch (code) {
    case '28000':
    case 'PGRST301':
    case 'PGRST302':
      return new OwnerError('unauthenticated', OWNER_MESSAGES.unauthenticated);
    case '42501':
      // RLS or privilege refusal. PostgREST uses 42501 for both.
      return new OwnerError('forbidden', OWNER_MESSAGES.forbidden);
    case '23505': {
      const constraint = constraintOf(e);
      if (constraint === SLOT_UNIQUE_TIME || (!constraint && context === 'slot')) {
        return new OwnerError('duplicate', OWNER_MESSAGES.duplicateSlot);
      }
      if (constraint === HOURS_UNIQUE_DAY || (!constraint && context === 'hours')) {
        return new OwnerError('duplicate', OWNER_MESSAGES.duplicateHours);
      }
      return new OwnerError('duplicate', OWNER_MESSAGES.duplicate);
    }
    case '23P01': {
      // Exclusion constraint: two slots of one facility may not overlap.
      const constraint = constraintOf(e);
      if (constraint === SLOT_NO_OVERLAP || (!constraint && context === 'slot')) {
        return new OwnerError('conflict', OWNER_MESSAGES.slotOverlap);
      }
      return new OwnerError('conflict', OWNER_MESSAGES.conflict);
    }
    case '23514':
    case '22P02':
    case '22003':
    case '22007':
    case '22023':
      return new OwnerError('invalid', OWNER_MESSAGES.invalid);
    case '23503':
      return new OwnerError('conflict', OWNER_MESSAGES.conflict);
  }

  const status = typeof e?.status === 'number' ? e.status : undefined;
  const name = typeof e?.name === 'string' ? e.name : '';

  if (
    name === 'AuthRetryableFetchError' ||
    status === 0 ||
    (error instanceof TypeError && /fetch|network/i.test(error.message))
  ) {
    return new OwnerError('network', OWNER_MESSAGES.network);
  }

  return new OwnerError('unknown', OWNER_MESSAGES.unknown);
}

// -- Validation (mirrors the database constraints; advisory only) --------

export const FACILITY_LIMITS = {
  name: { min: 2, max: 150 },
  sport: { min: 2, max: 100 },
  address: { min: 5, max: 500 },
  city: { min: 2, max: 100 },
  description: { max: 5000 },
  maxPrice: 99_999_999.99
} as const;

const PRICE_PATTERN = /^\d{1,8}(\.\d{1,2})?$/;

export interface ValidFacility {
  name: string;
  description: string | null;
  sport: string;
  address: string;
  city: string;
  capacity: number | null;
  basePrice: number;
}

export function validateFacilityInput(
  input: FacilityInput
): { ok: true; value: ValidFacility } | { ok: false; fields: Record<string, string> } {
  const fields: Record<string, string> = {};

  const name = input.name.trim();
  const sport = input.sport.trim();
  const address = input.address.trim();
  // Single-spaced so the same city is always stored the same way.
  const city = collapseCity(input.city);
  const description = input.description.trim();

  const range = (
    key: string,
    label: string,
    value: string,
    limit: { min: number; max: number }
  ) => {
    if (value.length < limit.min || value.length > limit.max) {
      fields[key] = `${label} must be ${limit.min} to ${limit.max} characters.`;
    }
  };

  range('name', 'Name', name, FACILITY_LIMITS.name);
  range('sport', 'Sport', sport, FACILITY_LIMITS.sport);
  range('address', 'Address', address, FACILITY_LIMITS.address);
  range('city', 'City', city, FACILITY_LIMITS.city);

  if (description.length > FACILITY_LIMITS.description.max) {
    fields.description = `Description must be at most ${FACILITY_LIMITS.description.max} characters.`;
  }

  const priceText = input.basePrice.trim();
  let basePrice = 0;
  if (!PRICE_PATTERN.test(priceText)) {
    fields.basePrice = 'Enter a price of 0 or more, with at most two decimals.';
  } else {
    basePrice = Number(priceText);
  }

  const capacityText = input.capacity.trim();
  let capacity: number | null = null;
  if (capacityText !== '') {
    const n = Number(capacityText);
    if (!/^\d+$/.test(capacityText) || !Number.isSafeInteger(n) || n < 1 || n > 1_000_000) {
      fields.capacity = 'Capacity must be a whole number of 1 or more, or left empty.';
    } else {
      capacity = n;
    }
  }

  if (Object.keys(fields).length > 0) return { ok: false, fields };

  return {
    ok: true,
    value: {
      name,
      description: description === '' ? null : description,
      sport,
      address,
      city,
      capacity,
      basePrice
    }
  };
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes since midnight for "HH:MM" (also accepts "HH:MM:SS"), or null. */
export function toMinutes(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function validateSlotInput(
  input: SlotInput,
  existing: Array<Pick<OwnerSlot, 'startTime' | 'endTime'>> = []
):
  | { ok: true; value: { startTime: string; endTime: string; durationMin: number; basePrice: number } }
  | { ok: false; fields: Record<string, string> } {
  const fields: Record<string, string> = {};

  const startOk = TIME_PATTERN.test(input.startTime);
  const endOk = TIME_PATTERN.test(input.endTime);
  const start = toMinutes(input.startTime);
  const end = toMinutes(input.endTime);

  if (!startOk || start === null) fields.startTime = 'Enter a start time.';
  if (!endOk || end === null) fields.endTime = 'Enter an end time.';

  if (start !== null && end !== null && startOk && endOk) {
    if (start >= end) {
      fields.endTime = 'The end time must be after the start time.';
    } else {
      // The database only forbids identical slots. Overlapping slots of
      // one venue are not rejected there and would be bookable twice,
      // so overlap is refused here.
      const clash = existing.some(s => {
        const a = toMinutes(s.startTime);
        const b = toMinutes(s.endTime);
        return a !== null && b !== null && start < b && a < end;
      });
      if (clash) fields.startTime = 'This overlaps an existing slot.';
    }
  }

  const priceText = input.basePrice.trim();
  let basePrice = 0;
  if (!PRICE_PATTERN.test(priceText)) {
    fields.basePrice = 'Enter a price of 0 or more, with at most two decimals.';
  } else {
    basePrice = Number(priceText);
  }

  if (Object.keys(fields).length > 0) return { ok: false, fields };

  return {
    ok: true,
    value: {
      startTime: input.startTime,
      endTime: input.endTime,
      durationMin: (end as number) - (start as number),
      basePrice
    }
  };
}

export function validateOperatingDay(
  day: OperatingDay
): { ok: true } | { ok: false; message: string } {
  if (day.dayOfWeek < 0 || day.dayOfWeek > 6 || !Number.isInteger(day.dayOfWeek)) {
    return { ok: false, message: 'Invalid day.' };
  }
  if (day.isClosed) return { ok: true };

  const open = toMinutes(day.opensAt);
  const close = toMinutes(day.closesAt);

  if (open === null || close === null) {
    return { ok: false, message: 'Enter opening and closing times.' };
  }
  if (open >= close) {
    return { ok: false, message: 'Closing time must be after opening time.' };
  }
  return { ok: true };
}

// -- Status presentation ------------------------------------------------

export const FACILITY_STATUSES: readonly FacilityRecordStatus[] = [
  'pending',
  'active',
  'suspended',
  'rejected'
];

export function describeFacilityStatus(status: FacilityRecordStatus): {
  label: string;
  explanation: string;
} {
  switch (status) {
    case 'pending':
      return {
        label: 'Pending approval',
        explanation:
          'An administrator must approve this venue before players can see or book it. You can keep preparing it meanwhile.'
      };
    case 'active':
      return {
        label: 'Live',
        explanation: 'Approved and visible to players.'
      };
    case 'suspended':
      return {
        label: 'Suspended',
        explanation:
          'Hidden from players by an administrator. Existing data is kept. Contact support to have it reviewed.'
      };
    case 'rejected':
      return {
        label: 'Rejected',
        explanation:
          'An administrator declined this venue. It is not visible to players.'
      };
  }
}

// -- Row mapping --------------------------------------------------------

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

export const OWNER_FACILITY_COLUMNS =
  'id, name, description, sport, address, city, capacity, base_price, status, created_at';

export interface OwnerFacilityRow {
  id: string;
  name: string;
  description: string | null;
  sport: string;
  address: string;
  city: string;
  capacity: number | null;
  base_price: number | string;
  status: string;
  created_at: string;
}

export function mapOwnerFacilityRow(row: OwnerFacilityRow): OwnerFacility {
  const status = row.status as FacilityRecordStatus;
  const price = toNumber(row.base_price);

  if (
    typeof row.id !== 'string' ||
    typeof row.name !== 'string' ||
    price === null ||
    !FACILITY_STATUSES.includes(status)
  ) {
    throw new OwnerError('unknown', OWNER_MESSAGES.loadFailed);
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    sport: row.sport,
    address: row.address,
    city: row.city,
    capacity: row.capacity ?? null,
    basePrice: price,
    status,
    createdAt: row.created_at
  };
}

export const SLOT_COLUMNS_OWNER =
  'id, facility_id, start_time, end_time, duration_min, base_price, is_active';

export interface OwnerSlotRow {
  id: string;
  facility_id: string;
  start_time: string;
  end_time: string;
  duration_min: number;
  base_price: number | string;
  is_active: boolean;
}

export function mapOwnerSlotRow(row: OwnerSlotRow): OwnerSlot {
  const price = toNumber(row.base_price);

  if (
    typeof row.id !== 'string' ||
    typeof row.start_time !== 'string' ||
    typeof row.end_time !== 'string' ||
    price === null ||
    typeof row.is_active !== 'boolean'
  ) {
    throw new OwnerError('unknown', OWNER_MESSAGES.loadFailed);
  }

  return {
    id: row.id,
    facilityId: row.facility_id,
    startTime: row.start_time.slice(0, 5),
    endTime: row.end_time.slice(0, 5),
    timeLabel: formatSlotTime(row.start_time, row.end_time),
    durationMin: row.duration_min,
    basePrice: price,
    isActive: row.is_active
  };
}

interface HoursRow {
  id: string;
  day_of_week: number;
  opens_at: string | null;
  closes_at: string | null;
  is_closed: boolean;
}

export const HOURS_COLUMNS = 'id, day_of_week, opens_at, closes_at, is_closed';

/** Seven days, Sunday first. Days without a row are "not configured". */
export interface OperatingWeek {
  days: Array<OperatingDay & { configured: boolean; rowId: string | null }>;
}

export function mapOperatingWeek(rows: HoursRow[]): OperatingWeek {
  const byDay = new Map<number, HoursRow>();
  for (const row of rows) byDay.set(row.day_of_week, row);

  return {
    days: Array.from({ length: 7 }, (_, dayOfWeek) => {
      const row = byDay.get(dayOfWeek);
      if (!row) {
        return {
          dayOfWeek,
          isClosed: true,
          opensAt: null,
          closesAt: null,
          configured: false,
          rowId: null
        };
      }
      return {
        dayOfWeek,
        isClosed: row.is_closed,
        opensAt: row.opens_at ? row.opens_at.slice(0, 5) : null,
        closesAt: row.closes_at ? row.closes_at.slice(0, 5) : null,
        configured: true,
        rowId: row.id
      };
    })
  };
}

const OWNER_BOOKING_COLUMNS =
  'id, facility_id, slot_id, booking_date, start_time, end_time, amount, status, payment_status, expires_at, created_at';
export const OWNER_BOOKING_LIMIT = 100;

// -- Repository ---------------------------------------------------------

export function createOwnerFacilityRepository(getClient: () => SupabaseClient) {
  async function requireSession(): Promise<{ client: SupabaseClient; userId: string }> {
    let client: SupabaseClient;
    try {
      client = getClient();
    } catch {
      throw new OwnerError('unknown', 'The service is not configured. Please contact support.');
    }

    let userId: string | undefined;
    try {
      const { data, error } = await client.auth.getSession();
      if (!error) userId = data.session?.user?.id;
    } catch {
      userId = undefined;
    }

    if (!userId) throw new OwnerError('unauthenticated', OWNER_MESSAGES.unauthenticated);
    return { client, userId };
  }

  async function settle<T>(
    run: () => PromiseLike<{ data: T; error: unknown }>,
    context?: OwnerOperation
  ): Promise<T> {
    let result: { data: T; error: unknown };
    try {
      result = await run();
    } catch (error) {
      throw toOwnerError(error, context);
    }
    if (result.error) throw toOwnerError(result.error, context);
    return result.data;
  }

  const requireFacilityId = (facilityId: string) => {
    if (!UUID_PATTERN.test(facilityId)) {
      throw new OwnerError('invalid', OWNER_MESSAGES.invalid);
    }
  };

  return {
    /** The signed-in owner's own facilities, newest first, in every status. */
    async loadMyFacilities(): Promise<OwnerFacility[]> {
      const { client, userId } = await requireSession();

      const data = await settle(() =>
        client
          .from('facilities')
          .select(OWNER_FACILITY_COLUMNS)
          .eq('owner_id', userId)
          .order('created_at', { ascending: false })
          .limit(100)
      );

      if (!Array.isArray(data)) throw new OwnerError('unknown', OWNER_MESSAGES.loadFailed);
      return (data as OwnerFacilityRow[]).map(mapOwnerFacilityRow);
    },

    /**
     * Create a facility. The owner id comes from the authenticated
     * session and is re-checked by RLS; the status is deliberately not
     * sent, so the database default ("pending") applies and the policy
     * accepts it. The database is the final judge of every field.
     */
    async createFacility(input: FacilityInput): Promise<OwnerFacility> {
      const checked = validateFacilityInput(input);
      if (checked.ok === false) {
        throw new OwnerError('invalid', OWNER_MESSAGES.invalid, checked.fields);
      }

      const { client, userId } = await requireSession();
      const v = checked.value;

      const data = await settle(() =>
        client
          .from('facilities')
          .insert({
            owner_id: userId,
            name: v.name,
            description: v.description,
            sport: v.sport,
            address: v.address,
            city: v.city,
            capacity: v.capacity,
            base_price: v.basePrice
          })
          .select(OWNER_FACILITY_COLUMNS)
          .single()
      );

      return mapOwnerFacilityRow(data as OwnerFacilityRow);
    },

    /**
     * Edit descriptive fields of a facility. owner_id and status are
     * never sent. Zero matched rows means RLS hid the row (someone
     * else's facility, or it no longer exists), which is reported as
     * "forbidden", never as success.
     */
    async updateFacility(facilityId: string, input: FacilityInput): Promise<OwnerFacility> {
      requireFacilityId(facilityId);

      const checked = validateFacilityInput(input);
      if (checked.ok === false) {
        throw new OwnerError('invalid', OWNER_MESSAGES.invalid, checked.fields);
      }

      const { client } = await requireSession();
      const v = checked.value;

      const data = await settle(() =>
        client
          .from('facilities')
          .update({
            name: v.name,
            description: v.description,
            sport: v.sport,
            address: v.address,
            city: v.city,
            capacity: v.capacity,
            base_price: v.basePrice
          })
          .eq('id', facilityId)
          .select(OWNER_FACILITY_COLUMNS)
          .maybeSingle()
      );

      if (!data) throw new OwnerError('forbidden', OWNER_MESSAGES.forbidden);
      return mapOwnerFacilityRow(data as OwnerFacilityRow);
    },

    async loadOperatingHours(facilityId: string): Promise<OperatingWeek> {
      requireFacilityId(facilityId);
      const { client } = await requireSession();

      const data = await settle(() =>
        client
          .from('facility_operating_hours')
          .select(HOURS_COLUMNS)
          .eq('facility_id', facilityId)
      );

      if (!Array.isArray(data)) throw new OwnerError('unknown', OWNER_MESSAGES.loadFailed);
      return mapOperatingWeek(data as HoursRow[]);
    },

    /**
     * Save one day. A day that already has a row is updated by id;
     * otherwise a row is inserted. The unique (facility, day)
     * constraint and RLS are enforced by the database. Resolves with
     * the saved row's id (null if the response did not carry one).
     */
    async saveOperatingDay(
      facilityId: string,
      day: OperatingDay,
      existingRowId: string | null
    ): Promise<string | null> {
      requireFacilityId(facilityId);

      const checked = validateOperatingDay(day);
      if (checked.ok === false) throw new OwnerError('invalid', checked.message);

      const { client } = await requireSession();

      const values = {
        is_closed: day.isClosed,
        opens_at: day.isClosed ? null : day.opensAt,
        closes_at: day.isClosed ? null : day.closesAt
      };

      if (existingRowId) {
        if (!UUID_PATTERN.test(existingRowId)) {
          throw new OwnerError('invalid', OWNER_MESSAGES.invalid);
        }
        const rows = await settle(() =>
          client
            .from('facility_operating_hours')
            .update(values)
            .eq('id', existingRowId)
            .eq('facility_id', facilityId)
            .select('id'),
          'hours'
        );
        if (!Array.isArray(rows) || rows.length === 0) {
          throw new OwnerError('forbidden', OWNER_MESSAGES.forbidden);
        }
        return existingRowId;
      }

      const inserted = await settle(() =>
        client
          .from('facility_operating_hours')
          .insert({ facility_id: facilityId, day_of_week: day.dayOfWeek, ...values })
          .select('id'),
        'hours'
      );

      // The new row's id, so the caller can update it next time rather
      // than insert a second row for the same day.
      const id = Array.isArray(inserted) ? (inserted[0] as { id?: unknown } | undefined)?.id : null;
      return typeof id === 'string' && UUID_PATTERN.test(id) ? id : null;
    },

    async loadSlots(facilityId: string): Promise<OwnerSlot[]> {
      requireFacilityId(facilityId);
      const { client } = await requireSession();

      const data = await settle(() =>
        client
          .from('facility_slots')
          .select(SLOT_COLUMNS_OWNER)
          .eq('facility_id', facilityId)
          .order('start_time', { ascending: true })
      );

      if (!Array.isArray(data)) throw new OwnerError('unknown', OWNER_MESSAGES.loadFailed);
      return (data as OwnerSlotRow[]).map(mapOwnerSlotRow);
    },

    async createSlot(
      facilityId: string,
      input: SlotInput,
      existing: OwnerSlot[]
    ): Promise<OwnerSlot> {
      requireFacilityId(facilityId);

      const checked = validateSlotInput(input, existing);
      if (checked.ok === false) {
        throw new OwnerError('invalid', OWNER_MESSAGES.invalid, checked.fields);
      }

      const { client } = await requireSession();
      const v = checked.value;

      const data = await settle(() =>
        client
          .from('facility_slots')
          .insert({
            facility_id: facilityId,
            start_time: v.startTime,
            end_time: v.endTime,
            duration_min: v.durationMin,
            base_price: v.basePrice,
            is_active: true
          })
          .select(SLOT_COLUMNS_OWNER)
          .single(),
        'slot'
      );

      return mapOwnerSlotRow(data as OwnerSlotRow);
    },

    /** Switch a slot on or off. Slots are never deleted from the UI. */
    async setSlotActive(slotId: string, isActive: boolean): Promise<OwnerSlot> {
      if (!UUID_PATTERN.test(slotId)) {
        throw new OwnerError('invalid', OWNER_MESSAGES.invalid);
      }

      const { client } = await requireSession();

      const data = await settle(() =>
        client
          .from('facility_slots')
          .update({ is_active: isActive })
          .eq('id', slotId)
          .select(SLOT_COLUMNS_OWNER)
          .maybeSingle(),
        'slot'
      );

      if (!data) throw new OwnerError('forbidden', OWNER_MESSAGES.forbidden);
      return mapOwnerSlotRow(data as OwnerSlotRow);
    },

    /**
     * Bookings for one of the owner's facilities, newest date first.
     * Read-only. The user id of the booker is deliberately not selected.
     */
    async loadFacilityBookings(facilityId: string): Promise<UserBooking[]> {
      requireFacilityId(facilityId);
      const { client } = await requireSession();

      const data = await settle(() =>
        client
          .from('bookings')
          .select(OWNER_BOOKING_COLUMNS)
          .eq('facility_id', facilityId)
          .order('booking_date', { ascending: false })
          .order('start_time', { ascending: true })
          .limit(OWNER_BOOKING_LIMIT)
      );

      if (!Array.isArray(data)) throw new OwnerError('unknown', OWNER_MESSAGES.loadFailed);
      return (data as BookingRow[]).map(mapBookingRow);
    }
  };
}

/** The application's owner repository, bound to the shared client. */
export const ownerFacilityRepository = createOwnerFacilityRepository(getSupabase);
