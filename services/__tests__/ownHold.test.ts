import { describe, it, expect } from 'vitest';
import {
  getWaitlistAction,
  holdsSlot,
  showsOwnHold,
  AvailabilityView
} from '../slotAvailability';
import type { UserBooking } from '../bookingRepository';
import type { Slot } from '../../types';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const FUTURE = '2026-10-13T12:05:00.000Z';
const PAST = '2026-10-13T11:59:00.000Z';

const booking = (overrides: Partial<UserBooking> = {}): UserBooking => ({
  id: 'b1',
  facilityId: 'f1',
  slotId: 's1',
  bookingDate: '2026-10-13',
  startTime: '18:00:00',
  endTime: '19:00:00',
  timeLabel: '06:00 PM - 07:00 PM',
  amount: 500,
  status: 'pending_payment',
  paymentStatus: 'pending',
  expiresAt: FUTURE,
  createdAt: '2026-10-13T11:55:00.000Z',
  ...overrides
} as UserBooking);

const slot = (overrides: Partial<Slot> = {}): Slot => ({
  id: 's1',
  facilityId: 'f1',
  time: '06:00 PM - 07:00 PM',
  price: 500,
  isActive: true,
  ...overrides
});

const ready = (status: string, id = 's1'): AvailabilityView => ({
  phase: 'ready',
  byId: { [id]: status as never }
});

describe('holdsSlot', () => {
  it('is true for a live unpaid hold on this slot and date', () => {
    expect(holdsSlot([booking()], 's1', '2026-10-13', NOW)).toBe(true);
  });

  it('is true for confirmed and completed bookings, as the server treats them', () => {
    for (const status of ['confirmed', 'completed'] as const) {
      expect(
        holdsSlot([booking({ status, expiresAt: null })], 's1', '2026-10-13', NOW)
      ).toBe(true);
    }
  });

  it('is false once the hold has lapsed, judged by the clock', () => {
    // stored status is still pending_payment; the clock decides
    const lapsed = booking({ expiresAt: PAST });

    expect(lapsed.status).toBe('pending_payment');
    expect(holdsSlot([lapsed], 's1', '2026-10-13', NOW)).toBe(false);
  });

  it('is true up to the expiry instant and false from it', () => {
    const b = booking({ expiresAt: NOW.toISOString() });

    expect(holdsSlot([b], 's1', '2026-10-13', new Date(NOW.getTime() - 1))).toBe(true);
    expect(holdsSlot([b], 's1', '2026-10-13', NOW)).toBe(false);
  });

  it('turns false as time passes without any new data', () => {
    const b = booking({ expiresAt: FUTURE });

    expect(holdsSlot([b], 's1', '2026-10-13', NOW)).toBe(true);
    expect(holdsSlot([b], 's1', '2026-10-13', new Date('2026-10-13T12:06:00.000Z'))).toBe(false);
  });

  it('ignores cancelled and expired bookings', () => {
    for (const status of ['cancelled', 'expired'] as const) {
      expect(holdsSlot([booking({ status })], 's1', '2026-10-13', NOW)).toBe(false);
    }
  });

  it('ignores other slots and other dates', () => {
    expect(holdsSlot([booking({ slotId: 's2' })], 's1', '2026-10-13', NOW)).toBe(false);
    expect(holdsSlot([booking({ bookingDate: '2026-10-14' })], 's1', '2026-10-13', NOW)).toBe(false);
  });

  it('is false with no bookings', () => {
    expect(holdsSlot([], 's1', '2026-10-13', NOW)).toBe(false);
  });

  it('finds the matching booking among several', () => {
    const list = [
      booking({ id: 'x', slotId: 's9' }),
      booking({ id: 'y', status: 'expired' }),
      booking({ id: 'z' })
    ];

    expect(holdsSlot(list, 's1', '2026-10-13', NOW)).toBe(true);
  });
});

describe('getWaitlistAction with the user own hold', () => {
  it('hides the control for a slot the user holds, even though it is booked', () => {
    expect(getWaitlistAction(slot(), ready('booked'), false, true)).toEqual({
      visible: false,
      label: '',
      joinable: false
    });
  });

  it('hides it for a held slot even if the user is also listed', () => {
    expect(getWaitlistAction(slot(), ready('booked'), true, true).visible).toBe(false);
  });

  it('still offers the waitlist for other taken slots', () => {
    expect(getWaitlistAction(slot(), ready('booked'), false, false)).toEqual({
      visible: true,
      label: 'Join waitlist',
      joinable: true
    });
  });

  it('defaults to the previous behaviour when the hold is not supplied', () => {
    expect(getWaitlistAction(slot(), ready('booked'), false).joinable).toBe(true);
  });

  it('returns the waitlist once the hold has lapsed and availability says taken', () => {
    // a different player took the slot after this user's hold lapsed
    const lapsed = holdsSlot([booking({ expiresAt: PAST })], 's1', '2026-10-13', NOW);

    expect(getWaitlistAction(slot(), ready('booked'), false, lapsed).joinable).toBe(true);
  });

  it('offers nothing once the hold lapsed and the slot is free again', () => {
    const lapsed = holdsSlot([booking({ expiresAt: PAST })], 's1', '2026-10-13', NOW);

    expect(getWaitlistAction(slot(), ready('available'), false, lapsed).visible).toBe(false);
  });
});

describe('showsOwnHold', () => {
  it('labels the row only when the database also reports the slot as taken', () => {
    expect(showsOwnHold(slot(), ready('booked'), true)).toBe(true);
  });

  it('does not claim a reservation the database reports as available', () => {
    expect(showsOwnHold(slot(), ready('available'), true)).toBe(false);
  });

  it('says nothing without a hold, while loading, or for an inactive slot', () => {
    expect(showsOwnHold(slot(), ready('booked'), false)).toBe(false);
    expect(showsOwnHold(slot(), { phase: 'loading' }, true)).toBe(false);
    expect(showsOwnHold(slot(), { phase: 'error', message: 'x' }, true)).toBe(false);
    expect(showsOwnHold(slot({ isActive: false }), ready('booked'), true)).toBe(false);
  });
});
