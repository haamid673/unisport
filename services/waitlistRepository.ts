import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from './supabaseClient';
import { formatSlotTime } from './facilityRepository';
import { UUID_PATTERN, isCalendarDate, toAmount } from './bookingRepository';

/**
 * Customer waitlist, backed by Supabase.
 *
 * Contract (supabase/migrations/20261010180900_per_user_booking_limits.sql
 * and 20261010180200_waitlist_functions.sql):
 *
 *   join_waitlist(p_facility_id uuid, p_slot_id uuid, p_booking_date date)
 *     returns table (entry_id uuid, entries_ahead integer)   -- one row
 *   leave_waitlist(p_entry_id uuid)
 *     returns waitlist_status                                -- scalar
 *   accept_waitlist_offer(p_entry_id uuid)
 *     returns table (booking_id uuid, booking_amount numeric(10,2),
 *                    booking_expires_at timestamptz)         -- one row
 *
 *   All three are SECURITY DEFINER with EXECUTE granted to
 *   authenticated only. The table has SELECT for authenticated and
 *   nothing else; its RLS policy is user_id = auth.uid().
 *
 * State machine (owned by the database, never by this module):
 *
 *   waiting --offer issued by process_waitlist()--> offered
 *   offered --accept (creates a pending_payment booking)--> accepted
 *   offered --offer window passes--> expired
 *   waiting|offered --leave--> cancelled
 *
 * Rules this module follows:
 *
 *  - Every state change goes through those RPCs. There is no direct
 *    INSERT, UPDATE or DELETE.
 *  - An offer is only an offer when the database says status
 *    "offered" and its window has not passed. Accepting an offer
 *    creates a normal 10-minute UNPAID hold; it is never presented as
 *    paid.
 *  - The caller's own entries are read with an explicit user_id
 *    filter. RLS already restricts rows to the caller, so the filter
 *    is a product rule, not the security boundary.
 *  - Success is reported only for a well-formed database answer.
 *  - No raw Postgres or PostgREST text reaches the UI.
 *  - No localStorage or mock fallback.
 */

export const JOIN_WAITLIST_RPC = 'join_waitlist';
export const LEAVE_WAITLIST_RPC = 'leave_waitlist';
export const ACCEPT_WAITLIST_RPC = 'accept_waitlist_offer';

export const WAITLIST_HISTORY_LIMIT = 100;

export type WaitlistFailureKind =
  | 'unauthenticated'
  /** The slot is free: book it instead of waiting. */
  | 'available'
  /** The caller is already queued (or already holds a booking). */
  | 'duplicate'
  /** The per-user cap on active waitlists was reached. */
  | 'limit'
  /** The offer window passed or the offer is no longer valid. */
  | 'expired'
  /** The slot was taken, or the entry changed, while acting. */
  | 'conflict'
  /** The entry, venue or slot no longer exists. */
  | 'not_found'
  /** The slot or venue cannot be waitlisted right now. */
  | 'unavailable'
  /** The request itself was invalid. */
  | 'invalid'
  | 'network'
  | 'unknown';

export class WaitlistError extends Error {
  readonly kind: WaitlistFailureKind;

  constructor(kind: WaitlistFailureKind, message: string) {
    super(message);
    this.name = 'WaitlistError';
    this.kind = kind;
  }
}

export type WaitlistRecordStatus =
  | 'waiting'
  | 'offered'
  | 'accepted'
  | 'expired'
  | 'cancelled';

export interface WaitlistRequest {
  facilityId: string;
  slotId: string;
  /** YYYY-MM-DD */
  bookingDate: string;
}

export interface JoinedWaitlist {
  entryId: string;
  /** Active entries queued before this one (a snapshot). */
  entriesAhead: number;
}

export interface AcceptedOffer {
  bookingId: string;
  amount: number;
  /** When the resulting unpaid hold lapses. */
  expiresAt: string;
}

export interface WaitlistEntry {
  id: string;
  facilityId: string;
  slotId: string;
  bookingDate: string;
  status: WaitlistRecordStatus;
  offeredAt: string | null;
  offerExpiresAt: string | null;
  bookingId: string | null;
  createdAt: string;
  facilityName: string | null;
  facilityLocation: string | null;
  sport: string | null;
  /** "06:00 PM - 07:00 PM", or null if the slot is no longer visible. */
  timeLabel: string | null;
}

export const WAITLIST_MESSAGES = {
  unauthenticated: 'Your session has expired. Please sign in again.',
  available: 'This slot is available now. Book it directly instead.',
  alreadyListed: 'You are already on the waitlist for this slot.',
  alreadyBooked: 'You already hold a booking for this slot.',
  limit:
    'You are already on the maximum number of waitlists. Leave one to join another.',
  offerExpired: 'This offer has expired.',
  offerInvalid: 'This offer is no longer valid.',
  slotTaken: 'That slot was just taken. You are still on the waitlist if it frees up again.',
  entryGone: 'That waitlist entry no longer exists.',
  alreadyAccepted: 'That offer was already accepted. Check Your Schedule.',
  unavailable: 'This slot cannot be waitlisted right now.',
  acceptUnavailable: 'This offer cannot be accepted right now.',
  notFound: 'That venue or slot is no longer available.',
  pastDate: 'That date has passed.',
  tooFar: 'That date is too far ahead.',
  invalid: 'Those details are not valid. Please reselect the slot.',
  network:
    'Could not reach the waitlist service. Your waitlist below shows the current state.',
  unknown: 'We could not complete that. Please check your waitlist and try again.',
  loadFailed: 'Could not load your waitlist. Please try again.'
} as const;

export type WaitlistOperation = 'join' | 'leave' | 'accept';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

/** Map a PostgREST/Postgres error to a safe WaitlistError. */
export function toWaitlistError(
  error: unknown,
  operation: WaitlistOperation
): WaitlistError {
  if (error instanceof WaitlistError) return error;

  const e = asRecord(error);
  const code = typeof e?.code === 'string' ? e.code : undefined;
  const raw = typeof e?.message === 'string' ? e.message : '';

  switch (code) {
    case '28000':
    case '42501':
    case 'PGRST301':
    case 'PGRST302':
      return new WaitlistError('unauthenticated', WAITLIST_MESSAGES.unauthenticated);
    case '23505':
      return new WaitlistError('duplicate', WAITLIST_MESSAGES.alreadyListed);
    case 'UB002':
    case 'UB001':
      return new WaitlistError('limit', WAITLIST_MESSAGES.limit);
    case '23P01':
      return new WaitlistError('conflict', WAITLIST_MESSAGES.slotTaken);
    case '22007':
      return new WaitlistError('invalid', WAITLIST_MESSAGES.pastDate);
    case '22008':
      return new WaitlistError('invalid', WAITLIST_MESSAGES.tooFar);
    case '22023':
      return new WaitlistError('invalid', WAITLIST_MESSAGES.invalid);
    case 'P0002':
      return operation === 'join'
        ? new WaitlistError('not_found', WAITLIST_MESSAGES.notFound)
        : new WaitlistError('not_found', WAITLIST_MESSAGES.entryGone);
    case 'P0001': {
      if (/already accepted/i.test(raw)) {
        return new WaitlistError('conflict', WAITLIST_MESSAGES.alreadyAccepted);
      }
      if (/has expired/i.test(raw)) {
        return new WaitlistError('expired', WAITLIST_MESSAGES.offerExpired);
      }
      if (/no longer valid/i.test(raw)) {
        return new WaitlistError('expired', WAITLIST_MESSAGES.offerInvalid);
      }
      // "Selected slot is currently available; book it directly" only.
      // ("Facility is not currently available for booking" is different.)
      if (/book it directly/i.test(raw)) {
        return new WaitlistError('available', WAITLIST_MESSAGES.available);
      }
      if (/already have a booking/i.test(raw)) {
        return new WaitlistError('duplicate', WAITLIST_MESSAGES.alreadyBooked);
      }
      return new WaitlistError(
        'unavailable',
        operation === 'accept'
          ? WAITLIST_MESSAGES.acceptUnavailable
          : WAITLIST_MESSAGES.unavailable
      );
    }
  }

  const status = typeof e?.status === 'number' ? e.status : undefined;
  const name = typeof e?.name === 'string' ? e.name : '';

  if (
    name === 'AuthRetryableFetchError' ||
    status === 0 ||
    (error instanceof TypeError && /fetch|network/i.test(error.message))
  ) {
    return new WaitlistError('network', WAITLIST_MESSAGES.network);
  }

  return new WaitlistError('unknown', WAITLIST_MESSAGES.unknown);
}

// -- Parsing ------------------------------------------------------------

const oneRow = (data: unknown): Record<string, unknown> | null =>
  asRecord(Array.isArray(data) ? (data.length === 1 ? data[0] : null) : data);

export function parseJoined(data: unknown): JoinedWaitlist {
  const r = oneRow(data);
  const entryId = r?.entry_id;
  const ahead = r?.entries_ahead;

  if (
    typeof entryId !== 'string' ||
    !UUID_PATTERN.test(entryId) ||
    typeof ahead !== 'number' ||
    !Number.isInteger(ahead) ||
    ahead < 0
  ) {
    throw new WaitlistError('unknown', WAITLIST_MESSAGES.unknown);
  }

  return { entryId, entriesAhead: ahead };
}

export function parseAccepted(data: unknown): AcceptedOffer {
  const r = oneRow(data);
  const bookingId = r?.booking_id;
  const amount = toAmount(r?.booking_amount);
  const expiresAt = r?.booking_expires_at;

  if (
    typeof bookingId !== 'string' ||
    !UUID_PATTERN.test(bookingId) ||
    amount === null ||
    typeof expiresAt !== 'string' ||
    Number.isNaN(Date.parse(expiresAt))
  ) {
    throw new WaitlistError('unknown', WAITLIST_MESSAGES.unknown);
  }

  return { bookingId, amount, expiresAt };
}

const STATUSES: readonly WaitlistRecordStatus[] = [
  'waiting',
  'offered',
  'accepted',
  'expired',
  'cancelled'
];

export const WAITLIST_COLUMNS =
  'id, facility_id, slot_id, booking_date, status, offered_at, offer_expires_at, booking_id, created_at, facilities(name, sport, address, city), facility_slots(start_time, end_time)';

export interface WaitlistRow {
  id: string;
  facility_id: string;
  slot_id: string;
  booking_date: string;
  status: string;
  offered_at: string | null;
  offer_expires_at: string | null;
  booking_id: string | null;
  created_at: string;
  facilities?:
    | { name: string; sport: string; address: string; city: string }
    | Array<{ name: string; sport: string; address: string; city: string }>
    | null;
  facility_slots?:
    | { start_time: string; end_time: string }
    | Array<{ start_time: string; end_time: string }>
    | null;
}

const first = <T>(value: T | T[] | null | undefined): T | undefined =>
  Array.isArray(value) ? value[0] : (value ?? undefined);

export function mapWaitlistRow(row: WaitlistRow): WaitlistEntry {
  const status = row.status as WaitlistRecordStatus;

  if (
    typeof row.id !== 'string' ||
    typeof row.facility_id !== 'string' ||
    typeof row.slot_id !== 'string' ||
    typeof row.booking_date !== 'string' ||
    !STATUSES.includes(status)
  ) {
    throw new WaitlistError('unknown', WAITLIST_MESSAGES.loadFailed);
  }

  const facility = first(row.facilities);
  const slot = first(row.facility_slots);

  return {
    id: row.id,
    facilityId: row.facility_id,
    slotId: row.slot_id,
    bookingDate: row.booking_date,
    status,
    offeredAt: row.offered_at ?? null,
    offerExpiresAt: row.offer_expires_at ?? null,
    bookingId: row.booking_id ?? null,
    createdAt: row.created_at,
    facilityName: facility?.name ?? null,
    facilityLocation: facility ? `${facility.address}, ${facility.city}` : null,
    sport: facility?.sport ?? null,
    timeLabel: slot ? formatSlotTime(slot.start_time, slot.end_time) : null
  };
}

/**
 * The status to DISPLAY. An offer whose window has passed is expired by
 * the clock even if the scheduled sweep has not updated the row, and a
 * waiting entry for a date that has passed can no longer be served.
 * Mirrors how the database itself reads these rows.
 */
export function effectiveWaitlistStatus(
  entry: Pick<WaitlistEntry, 'status' | 'offerExpiresAt' | 'bookingDate'>,
  now: Date = new Date()
): WaitlistRecordStatus {
  if (
    entry.status === 'offered' &&
    entry.offerExpiresAt !== null &&
    Date.parse(entry.offerExpiresAt) <= now.getTime()
  ) {
    return 'expired';
  }

  if (
    entry.status === 'waiting' &&
    entry.bookingDate < now.toISOString().split('T')[0]
  ) {
    return 'expired';
  }

  return entry.status;
}

/** True only for an offer the database issued and that is still open. */
export function isLiveOffer(
  entry: Pick<WaitlistEntry, 'status' | 'offerExpiresAt' | 'bookingDate'>,
  now: Date = new Date()
): boolean {
  return effectiveWaitlistStatus(entry, now) === 'offered';
}

// -- Repository ---------------------------------------------------------

export function createWaitlistRepository(getClient: () => SupabaseClient) {
  async function requireUserId(): Promise<{ client: SupabaseClient; userId: string }> {
    let client: SupabaseClient;
    try {
      client = getClient();
    } catch {
      throw new WaitlistError(
        'unknown',
        'The waitlist service is not configured. Please contact support.'
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
      throw new WaitlistError('unauthenticated', WAITLIST_MESSAGES.unauthenticated);
    }

    return { client, userId };
  }

  async function callRpc(
    client: SupabaseClient,
    name: string,
    args: Record<string, unknown>,
    operation: WaitlistOperation
  ): Promise<unknown> {
    let result: { data: unknown; error: unknown };
    try {
      result = await client.rpc(name, args);
    } catch (error) {
      throw toWaitlistError(error, operation);
    }

    if (result.error) throw toWaitlistError(result.error, operation);
    return result.data;
  }

  return {
    /** Join the waitlist through join_waitlist(). */
    async joinWaitlist(request: WaitlistRequest): Promise<JoinedWaitlist> {
      if (
        !UUID_PATTERN.test(request.facilityId) ||
        !UUID_PATTERN.test(request.slotId) ||
        !isCalendarDate(request.bookingDate)
      ) {
        throw new WaitlistError('invalid', WAITLIST_MESSAGES.invalid);
      }

      const { client } = await requireUserId();

      const data = await callRpc(
        client,
        JOIN_WAITLIST_RPC,
        {
          p_facility_id: request.facilityId,
          p_slot_id: request.slotId,
          p_booking_date: request.bookingDate
        },
        'join'
      );

      return parseJoined(data);
    },

    /** Leave through leave_waitlist(). Resolves with the entry's final status. */
    async leaveWaitlist(entryId: string): Promise<'cancelled' | 'expired'> {
      if (!UUID_PATTERN.test(entryId)) {
        throw new WaitlistError('invalid', WAITLIST_MESSAGES.invalid);
      }

      const { client } = await requireUserId();

      const data = await callRpc(
        client,
        LEAVE_WAITLIST_RPC,
        { p_entry_id: entryId },
        'leave'
      );

      if (data !== 'cancelled' && data !== 'expired') {
        throw new WaitlistError('unknown', WAITLIST_MESSAGES.unknown);
      }

      return data;
    },

    /**
     * Accept a live offer through accept_waitlist_offer(). The result is
     * a NEW unpaid hold (pending_payment), not a paid booking.
     */
    async acceptOffer(entryId: string): Promise<AcceptedOffer> {
      if (!UUID_PATTERN.test(entryId)) {
        throw new WaitlistError('invalid', WAITLIST_MESSAGES.invalid);
      }

      const { client } = await requireUserId();

      const data = await callRpc(
        client,
        ACCEPT_WAITLIST_RPC,
        { p_entry_id: entryId },
        'accept'
      );

      return parseAccepted(data);
    },

    /** The signed-in user's own waitlist entries. */
    async loadMyWaitlist(): Promise<WaitlistEntry[]> {
      const { client, userId } = await requireUserId();

      let result: { data: unknown; error: unknown };
      try {
        result = await client
          .from('waitlist_entries')
          .select(WAITLIST_COLUMNS)
          .eq('user_id', userId)
          .order('booking_date', { ascending: true })
          .order('created_at', { ascending: false })
          .limit(WAITLIST_HISTORY_LIMIT);
      } catch (error) {
        throw toWaitlistError(error, 'join');
      }

      if (result.error) {
        const mapped = toWaitlistError(result.error, 'join');
        throw mapped.kind === 'unknown' || mapped.kind === 'unavailable'
          ? new WaitlistError('unknown', WAITLIST_MESSAGES.loadFailed)
          : mapped;
      }

      if (!Array.isArray(result.data)) {
        throw new WaitlistError('unknown', WAITLIST_MESSAGES.loadFailed);
      }

      return (result.data as WaitlistRow[]).map(mapWaitlistRow);
    }
  };
}

/** The application's waitlist repository, bound to the shared client. */
export const waitlistRepository = createWaitlistRepository(getSupabase);
