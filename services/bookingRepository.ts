import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from './supabaseClient';
import { formatSlotTime } from './facilityRepository';

/**
 * Customer bookings, backed by Supabase.
 *
 * Contract (supabase/migrations/20261010180900_per_user_booking_limits.sql):
 *
 *   create_booking(p_facility_id uuid, p_slot_id uuid, p_booking_date date)
 *     returns table (booking_id uuid, booking_amount numeric(10,2),
 *                    expires_at timestamptz)          -- exactly one row
 *     SECURITY DEFINER, EXECUTE granted to authenticated only.
 *
 * Rules this module follows:
 *
 *  - Bookings are created ONLY through that RPC. There is no direct
 *    INSERT, and the client never supplies a price: the amount, the
 *    hold window and the status come from the database.
 *  - A booking created here is a 10-minute unpaid hold
 *    (status "pending_payment"). Nothing in this module confirms,
 *    pays for or cancels a booking.
 *  - The database is authoritative. Success is reported only when the
 *    RPC returned a well-formed row; any other outcome, including a
 *    malformed response, is a failure.
 *  - Availability checked in the UI is advisory. The exclusion
 *    constraint and advisory locks in the database decide conflicts,
 *    and a conflict surfaces here as kind "unavailable".
 *  - No fallback to mock or localStorage data, ever.
 */

export const CREATE_BOOKING_RPC = 'create_booking';

/** Whether the customer UI may create reservations through the RPC. */
export const RESERVATIONS_ENABLED = true;

/** Upper bound of rows read for the signed-in user's history. */
export const BOOKING_HISTORY_LIMIT = 100;

export type BookingFailureKind =
  /** No usable session. Sign in again. */
  | 'unauthenticated'
  /** The slot, facility or date cannot be booked right now. */
  | 'unavailable'
  /** The per-user cap on unpaid holds was reached. */
  | 'limit'
  /** The request itself was invalid (date outside the booking window). */
  | 'invalid'
  /** Could not reach the service. The outcome is unknown. */
  | 'network'
  /** Anything else. The outcome may be unknown. */
  | 'unknown';

/** Raised for every failed booking operation. `message` is safe to show. */
export class BookingError extends Error {
  readonly kind: BookingFailureKind;

  constructor(kind: BookingFailureKind, message: string) {
    super(message);
    this.name = 'BookingError';
    this.kind = kind;
  }
}

export interface BookingRequest {
  facilityId: string;
  slotId: string;
  /** YYYY-MM-DD, the date the slot is booked for. */
  bookingDate: string;
}

export interface CreatedBooking {
  bookingId: string;
  /** Amount charged for the slot, from the database. */
  amount: number;
  /** ISO timestamp at which the unpaid hold lapses. */
  expiresAt: string;
}

/** Database booking_status values. */
export type BookingRecordStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'completed'
  | 'cancelled'
  | 'expired';

export interface UserBooking {
  id: string;
  facilityId: string;
  slotId: string;
  bookingDate: string;
  startTime: string;
  endTime: string;
  /** "06:00 PM - 07:00 PM" */
  timeLabel: string;
  amount: number;
  status: BookingRecordStatus;
  paymentStatus: string;
  expiresAt: string | null;
  createdAt: string;
  /** Null when the venue is no longer visible to the user. */
  facilityName: string | null;
  facilityLocation: string | null;
  sport: string | null;
}

// -- Safe messages ------------------------------------------------------

export const MESSAGES = {
  unauthenticated: 'Your session has expired. Please sign in again.',
  slotTaken: 'That slot was just taken. Please choose another time.',
  slotHeld: 'That slot is being held for another player. Please choose another time.',
  slotUnavailable: 'That slot cannot be booked right now. Please choose another one.',
  notFound: 'That venue or slot is no longer available.',
  pastDate: 'That date can no longer be booked. Choose today or a later date.',
  tooFar: 'That date is too far ahead to book. Choose an earlier date.',
  invalid: 'Those booking details are not valid. Please reselect the slot.',
  limit:
    'You already hold the maximum number of unpaid reservations. Wait for one to expire before reserving another.',
  network:
    'Could not reach the booking service. Check Your Schedule before trying again, in case the reservation went through.',
  unknown:
    'We could not complete your reservation. Check Your Schedule before trying again.',
  loadFailed: 'Could not load your bookings. Please try again.'
} as const;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

/** Map a PostgREST/Postgres error to a safe BookingError. Never leaks raw text. */
export function toBookingError(error: unknown): BookingError {
  if (error instanceof BookingError) return error;

  const e = asRecord(error);
  const code = typeof e?.code === 'string' ? e.code : undefined;
  const raw = typeof e?.message === 'string' ? e.message : '';

  switch (code) {
    case '28000':
    case '42501':
    case 'PGRST301':
    case 'PGRST302':
      return new BookingError('unauthenticated', MESSAGES.unauthenticated);
    case '23P01':
      return new BookingError('unavailable', MESSAGES.slotTaken);
    case 'P0002':
      return new BookingError('unavailable', MESSAGES.notFound);
    case 'P0001':
      return new BookingError(
        'unavailable',
        /waitlist offer/i.test(raw) ? MESSAGES.slotHeld : MESSAGES.slotUnavailable
      );
    case 'UB001':
      return new BookingError('limit', MESSAGES.limit);
    case '22007':
      return new BookingError('invalid', MESSAGES.pastDate);
    case '22008':
      return new BookingError('invalid', MESSAGES.tooFar);
    case '22023':
      return new BookingError('invalid', MESSAGES.invalid);
  }

  const status = typeof e?.status === 'number' ? e.status : undefined;
  const name = typeof e?.name === 'string' ? e.name : '';

  if (
    name === 'AuthRetryableFetchError' ||
    status === 0 ||
    (error instanceof TypeError && /fetch|network/i.test(error.message))
  ) {
    return new BookingError('network', MESSAGES.network);
  }

  return new BookingError('unknown', MESSAGES.unknown);
}

// -- Validation and parsing ---------------------------------------------

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_INPUT = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written YYYY-MM-DD. */
export function isCalendarDate(value: string): boolean {
  if (!DATE_INPUT.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

export const toAmount = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
};

/**
 * Turn the RPC's response into a CreatedBooking. The function returns a
 * one-row table, which PostgREST delivers as an array. Anything that is
 * not exactly that shape is rejected: success is never assumed.
 */
export function parseCreatedBooking(data: unknown): CreatedBooking {
  const row = Array.isArray(data) ? (data.length === 1 ? data[0] : null) : data;
  const r = asRecord(row);

  const bookingId = r?.booking_id;
  const amount = toAmount(r?.booking_amount);
  const expiresAt = r?.expires_at;

  if (
    typeof bookingId !== 'string' ||
    !UUID_PATTERN.test(bookingId) ||
    amount === null ||
    typeof expiresAt !== 'string' ||
    Number.isNaN(Date.parse(expiresAt))
  ) {
    throw new BookingError('unknown', MESSAGES.unknown);
  }

  return { bookingId, amount, expiresAt };
}

const BOOKING_STATUSES: readonly BookingRecordStatus[] = [
  'pending_payment',
  'confirmed',
  'completed',
  'cancelled',
  'expired'
];

/** Columns read for history. Exactly what the UI displays. */
export const BOOKING_COLUMNS =
  'id, facility_id, slot_id, booking_date, start_time, end_time, amount, status, payment_status, expires_at, created_at, facilities(name, sport, address, city)';

export interface BookingRow {
  id: string;
  facility_id: string;
  slot_id: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  amount: number | string;
  status: string;
  payment_status: string;
  expires_at: string | null;
  created_at: string;
  facilities?:
    | { name: string; sport: string; address: string; city: string }
    | Array<{ name: string; sport: string; address: string; city: string }>
    | null;
}

export function mapBookingRow(row: BookingRow): UserBooking {
  const status = row.status as BookingRecordStatus;
  const amount = toAmount(row.amount);

  if (
    typeof row.id !== 'string' ||
    typeof row.facility_id !== 'string' ||
    typeof row.slot_id !== 'string' ||
    typeof row.booking_date !== 'string' ||
    typeof row.start_time !== 'string' ||
    typeof row.end_time !== 'string' ||
    amount === null ||
    !BOOKING_STATUSES.includes(status)
  ) {
    throw new BookingError('unknown', MESSAGES.loadFailed);
  }

  const joined = Array.isArray(row.facilities) ? row.facilities[0] : row.facilities;

  return {
    id: row.id,
    facilityId: row.facility_id,
    slotId: row.slot_id,
    bookingDate: row.booking_date,
    startTime: row.start_time,
    endTime: row.end_time,
    timeLabel: formatSlotTime(row.start_time, row.end_time),
    amount,
    status,
    paymentStatus: row.payment_status,
    expiresAt: row.expires_at ?? null,
    createdAt: row.created_at,
    facilityName: joined?.name ?? null,
    facilityLocation: joined ? `${joined.address}, ${joined.city}` : null,
    sport: joined?.sport ?? null
  };
}

/**
 * The status to DISPLAY. An unpaid hold whose window has passed is
 * expired by the clock even if the scheduled sweep has not updated the
 * row yet, mirroring how the database itself treats it.
 */
export function effectiveStatus(
  booking: Pick<UserBooking, 'status' | 'expiresAt'>,
  now: Date = new Date()
): BookingRecordStatus {
  if (
    booking.status === 'pending_payment' &&
    booking.expiresAt !== null &&
    Date.parse(booking.expiresAt) <= now.getTime()
  ) {
    return 'expired';
  }
  return booking.status;
}

// -- Repository ---------------------------------------------------------

export function createBookingRepository(getClient: () => SupabaseClient) {
  async function requireUserId(): Promise<{ client: SupabaseClient; userId: string }> {
    let client: SupabaseClient;
    try {
      client = getClient();
    } catch {
      throw new BookingError(
        'unknown',
        'The booking service is not configured. Please contact support.'
      );
    }

    let userId: string | undefined;
    try {
      const { data, error } = await client.auth.getSession();
      if (!error) userId = data.session?.user?.id;
    } catch {
      userId = undefined;
    }

    if (!userId) {
      throw new BookingError('unauthenticated', MESSAGES.unauthenticated);
    }

    return { client, userId };
  }

  return {
    /**
     * Reserve a slot through create_booking(). Resolves only when the
     * database returned a well-formed booking; otherwise throws a
     * BookingError. Never inserts into bookings directly.
     */
    async createBooking(request: BookingRequest): Promise<CreatedBooking> {
      if (
        !UUID_PATTERN.test(request.facilityId) ||
        !UUID_PATTERN.test(request.slotId) ||
        !isCalendarDate(request.bookingDate)
      ) {
        throw new BookingError('invalid', MESSAGES.invalid);
      }

      const { client } = await requireUserId();

      let result: { data: unknown; error: unknown };
      try {
        result = await client.rpc(CREATE_BOOKING_RPC, {
          p_facility_id: request.facilityId,
          p_slot_id: request.slotId,
          p_booking_date: request.bookingDate
        });
      } catch (error) {
        throw toBookingError(error);
      }

      if (result.error) throw toBookingError(result.error);

      return parseCreatedBooking(result.data);
    },

    /**
     * The signed-in user's own bookings, newest date first.
     *
     * The SELECT policy also lets venue owners and administrators read
     * other people's bookings, so the query is explicitly scoped to the
     * caller's id; that filter is a product rule, RLS stays the
     * security boundary.
     */
    async loadMyBookings(): Promise<UserBooking[]> {
      const { client, userId } = await requireUserId();

      let result: { data: unknown; error: unknown };
      try {
        result = await client
          .from('bookings')
          .select(BOOKING_COLUMNS)
          .eq('user_id', userId)
          .order('booking_date', { ascending: false })
          .order('start_time', { ascending: true })
          .limit(BOOKING_HISTORY_LIMIT);
      } catch (error) {
        throw toBookingError(error);
      }

      if (result.error) {
        const mapped = toBookingError(result.error);
        throw mapped.kind === 'unknown'
          ? new BookingError('unknown', MESSAGES.loadFailed)
          : mapped;
      }

      if (!Array.isArray(result.data)) {
        throw new BookingError('unknown', MESSAGES.loadFailed);
      }

      return (result.data as BookingRow[]).map(mapBookingRow);
    }
  };
}

/** The application's booking repository, bound to the shared client. */
export const bookingRepository = createBookingRepository(getSupabase);
