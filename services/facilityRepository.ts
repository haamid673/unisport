import type { SupabaseClient } from '@supabase/supabase-js';
import { Facility, FacilityStatus, Slot, SlotAvailabilityStatus } from '../types';
import { getSupabase } from './supabaseClient';
import { getSportImage } from './sportImages';

/**
 * Customer-facing reads of facilities and slots from Supabase.
 *
 * Rules this module follows:
 *
 *  - Reads run with the signed-in user's JWT. Row Level Security is the
 *    authorization boundary; the filters below are product filters, not
 *    security.
 *  - Only the columns the customer UI needs are selected. In particular
 *    owner_id is NOT selected.
 *  - There is deliberately no fallback. A failed read throws
 *    FacilityLoadError; it is never turned into an empty list and never
 *    replaced with mock or localStorage data. This module must not import
 *    facilityService or storageService.
 */

/** Raised for any failure to load the catalog. `message` is safe to show. */
export class FacilityLoadError extends Error {
  constructor(message = 'Could not load facilities. Please try again.') {
    super(message);
    this.name = 'FacilityLoadError';
  }
}

/** Raised when slot availability cannot be read. `message` is safe to show. */
export class AvailabilityLoadError extends Error {
  constructor(message = 'Could not check slot availability. Please try again.') {
    super(message);
    this.name = 'AvailabilityLoadError';
  }
}

export interface SlotRow {
  id: string;
  facility_id: string;
  start_time: string;
  end_time: string;
  base_price: number | string;
  is_active: boolean;
}

export interface FacilityRow {
  id: string;
  name: string;
  sport: string;
  address: string;
  city: string;
  latitude: number | string | null;
  longitude: number | string | null;
  base_price: number | string;
  status: string;
  facility_slots?: SlotRow[] | null;
}

export interface CustomerCatalog {
  facilities: Facility[];
  slots: Slot[];
}

/** Exactly the columns the customer UI uses. No owner_id. */
export const FACILITY_COLUMNS =
  'id, name, sport, address, city, latitude, longitude, base_price, status';
export const SLOT_COLUMNS =
  'id, facility_id, start_time, end_time, base_price, is_active';

// -- Pure mapping helpers ----------------------------------------------

const toNumber = (value: number | string | null | undefined): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * "18:00:00" -> "06:00 PM", matching the existing mock display
 * ("06:00 PM - 07:00 PM"). Returns the input unchanged if it is not a
 * recognisable time, rather than inventing one.
 */
export function formatTime(value: string): string {
  const match = /^(\d{1,2}):(\d{2})/.exec(value ?? '');
  if (!match) return value;

  const hours24 = Number(match[1]);
  const minutes = match[2];
  if (hours24 > 23) return value;

  const period = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;

  return `${String(hours12).padStart(2, '0')}:${minutes} ${period}`;
}

export function formatSlotTime(start: string, end: string): string {
  return `${formatTime(start)} - ${formatTime(end)}`;
}

/**
 * Database facility_status -> the UI's FacilityStatus.
 * Unknown values map to 'pending' so they can never appear approved.
 */
export function mapFacilityStatus(status: string): FacilityStatus {
  switch (status) {
    case 'active':
      return 'approved';
    case 'rejected':
    case 'suspended':
      return 'rejected';
    case 'pending':
    default:
      return 'pending';
  }
}

export function mapSlotRow(row: SlotRow): Slot {
  return {
    id: row.id,
    facilityId: row.facility_id,
    time: formatSlotTime(row.start_time, row.end_time),
    price: toNumber(row.base_price) ?? 0,
    isActive: row.is_active
  };
}

export function mapFacilityRow(row: FacilityRow): Facility {
  return {
    id: row.id,
    name: row.name,
    sport: row.sport,
    // The UI filters and displays "Area, City"; keep that single field.
    location: `${row.address}, ${row.city}`,
    address: row.address,
    city: row.city,
    basePrice: toNumber(row.base_price) ?? 0,
    // owner_id is intentionally not read by the customer query.
    ownerId: '',
    imageUrl: getSportImage(row.sport),
    status: mapFacilityStatus(row.status),
    latitude: toNumber(row.latitude),
    longitude: toNumber(row.longitude)
  };
}

// -- Availability -------------------------------------------------------

/** Name of the database function; the only source of availability. */
export const AVAILABILITY_RPC = 'get_slot_availability';

const AVAILABILITY_STATUSES: readonly SlotAvailabilityStatus[] = [
  'available',
  'booked',
  'offer_held',
  'inactive',
  'closed'
];

const DATE_INPUT = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Turn the database's rows into a slot id -> status map. Anything that
 * is not exactly the documented shape is an error: an unrecognised
 * status is never guessed at.
 */
export function parseSlotAvailability(
  data: unknown
): Record<string, SlotAvailabilityStatus> {
  if (!Array.isArray(data)) {
    throw new AvailabilityLoadError();
  }

  const byId: Record<string, SlotAvailabilityStatus> = {};

  for (const row of data as Array<Record<string, unknown>>) {
    const slotId = row?.slot_id;
    const status = row?.status;

    if (
      typeof slotId !== 'string' ||
      typeof status !== 'string' ||
      !(AVAILABILITY_STATUSES as readonly string[]).includes(status)
    ) {
      throw new AvailabilityLoadError();
    }

    byId[slotId] = status as SlotAvailabilityStatus;
  }

  return byId;
}

/** Map a PostgREST/Postgres error to a safe, user-facing message. */
export function toAvailabilityMessage(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;

  switch (code) {
    case '22007':
      return 'That date can no longer be booked. Choose today or a later date.';
    case '22023':
      return 'Choose a valid date.';
    case 'P0002':
      return 'This facility is no longer available.';
    case 'P0001':
      return 'This facility is not currently open for booking.';
    case '28000':
    case '42501':
      return 'Your session has expired. Please sign in again.';
    default:
      return 'Could not check slot availability. Please try again.';
  }
}

// -- Repository ---------------------------------------------------------

export function createFacilityRepository(getClient: () => SupabaseClient) {
  return {
    /**
     * Active facilities with their active slots, ordered by facility
     * name and then slot start time. Throws FacilityLoadError on any
     * failure; an empty catalog is returned only when the database
     * genuinely returns no rows.
     */
    async loadCustomerCatalog(): Promise<CustomerCatalog> {
      let client: SupabaseClient;
      try {
        client = getClient();
      } catch {
        throw new FacilityLoadError(
          'The data service is not configured. Please contact support.'
        );
      }

      const { data, error } = await client
        .from('facilities')
        .select(`${FACILITY_COLUMNS}, facility_slots(${SLOT_COLUMNS})`)
        .eq('status', 'active')
        .eq('facility_slots.is_active', true)
        .order('name', { ascending: true })
        .order('start_time', { referencedTable: 'facility_slots', ascending: true });

      if (error || !Array.isArray(data)) {
        throw new FacilityLoadError();
      }

      const facilities: Facility[] = [];
      const slots: Slot[] = [];

      for (const row of data as unknown as FacilityRow[]) {
        facilities.push(mapFacilityRow(row));

        for (const slotRow of row.facility_slots ?? []) {
          // Defence in depth: never surface an inactive slot even if the
          // embedded filter were ever ignored.
          if (slotRow.is_active === false) continue;
          slots.push(mapSlotRow(slotRow));
        }
      }

      return { facilities, slots };
    },

    /**
     * Availability of every slot of one facility on one date
     * (YYYY-MM-DD), as decided by the database. The answer is a
     * snapshot: create_booking() remains the authority when a booking
     * is actually attempted.
     *
     * Throws AvailabilityLoadError on any failure. There is no
     * fallback: not mock bookings, not LocalStorage, not "assume
     * available".
     */
    async loadSlotAvailability(
      facilityId: string,
      bookingDate: string
    ): Promise<Record<string, SlotAvailabilityStatus>> {
      if (!facilityId || !DATE_INPUT.test(bookingDate)) {
        throw new AvailabilityLoadError('Choose a valid date.');
      }

      let client: SupabaseClient;
      try {
        client = getClient();
      } catch {
        throw new AvailabilityLoadError(
          'The data service is not configured. Please contact support.'
        );
      }

      let result: { data: unknown; error: unknown };
      try {
        result = await client.rpc(AVAILABILITY_RPC, {
          p_facility_id: facilityId,
          p_booking_date: bookingDate
        });
      } catch {
        throw new AvailabilityLoadError();
      }

      if (result.error) {
        throw new AvailabilityLoadError(toAvailabilityMessage(result.error));
      }

      return parseSlotAvailability(result.data);
    }
  };
}

/** The application's repository, bound to the shared Supabase client. */
export const facilityRepository = createFacilityRepository(getSupabase);
