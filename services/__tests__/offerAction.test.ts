import { describe, it, expect } from 'vitest';
import { getOfferAction, getSlotAction, getWaitlistAction, AvailabilityView } from '../slotAvailability';
import type { Slot } from '../../types';

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

const DATE = '2026-10-17';
const NOW = new Date('2026-10-17T09:45:00.000Z');
const LATER = new Date('2026-10-17T09:53:01.000Z');

type Entry = Parameters<typeof getOfferAction>[2][number];

const entry = (overrides: Partial<Entry> = {}): Entry => ({
  id: 'e1',
  slotId: 's1',
  bookingDate: DATE,
  status: 'offered',
  offerExpiresAt: '2026-10-17T09:53:00.000Z',
  ...overrides
});

describe('getOfferAction: a user holding a live offer', () => {
  it('sees "Accept offer" (not a generic Book) when the database calls the slot available', () => {
    // get_slot_availability omits the holder's own offer, so for the
    // holder the slot reads "available" and getSlotAction says "Book".
    expect(getSlotAction(slot(), ready('available'), true).label).toBe('Book');

    const offer = getOfferAction(slot(), ready('available'), [entry()], DATE, NOW);
    expect(offer.visible).toBe(true);
    expect(offer.label).toBe('Accept offer');
    expect(offer.entry?.id).toBe('e1');
    expect(offer.expiresAt).toBe('2026-10-17T09:53:00.000Z');
    expect(offer.ariaLabel).toBe('06:00 PM - 07:00 PM: accept your waitlist offer');
  });

  it('still sees it on a stale "booked" snapshot (the entry is newer than the snapshot)', () => {
    expect(getOfferAction(slot(), ready('booked'), [entry()], DATE, NOW).visible).toBe(true);
  });

  it('picks the live offer when older, finished entries exist for the same slot and date', () => {
    const entries = [
      entry({ id: 'old', status: 'expired', offerExpiresAt: '2026-10-17T08:00:00.000Z' }),
      entry({ id: 'live' }),
      entry({ id: 'gone', status: 'cancelled', offerExpiresAt: null })
    ];
    expect(getOfferAction(slot(), ready('available'), entries, DATE, NOW).entry?.id).toBe('live');
  });
});

describe('getOfferAction: entries that are not a live offer', () => {
  it('a user merely waiting shows no offer, and keeps the "On waitlist" state', () => {
    const waiting = entry({ status: 'waiting', offerExpiresAt: null });
    expect(getOfferAction(slot(), ready('booked'), [waiting], DATE, NOW).visible).toBe(false);
    expect(getWaitlistAction(slot(), ready('booked'), true)).toEqual({
      visible: true,
      label: 'On waitlist',
      joinable: false
    });
  });

  it('an offer whose window has passed is not an offer, even if the row still says "offered"', () => {
    const lapsed = entry({ offerExpiresAt: '2026-10-17T09:44:59.000Z' });
    expect(getOfferAction(slot(), ready('available'), [lapsed], DATE, NOW).visible).toBe(false);
    // the boundary: expiry at exactly "now" is already over
    const exact = entry({ offerExpiresAt: NOW.toISOString() });
    expect(getOfferAction(slot(), ready('available'), [exact], DATE, NOW).visible).toBe(false);
  });

  it('accepted, cancelled and expired entries are never an offer', () => {
    for (const status of ['accepted', 'cancelled', 'expired', 'waiting']) {
      const e = entry({ status: status as Entry['status'] });
      expect(getOfferAction(slot(), ready('available'), [e], DATE, NOW).visible, status).toBe(false);
    }
  });

  it('an offered row with no expiry is not trusted', () => {
    expect(getOfferAction(slot(), ready('available'), [entry({ offerExpiresAt: null })], DATE, NOW).visible).toBe(false);
  });

  it('an offer for another slot or another date does not appear on this row', () => {
    expect(getOfferAction(slot(), ready('available'), [entry({ slotId: 's2' })], DATE, NOW).visible).toBe(false);
    expect(getOfferAction(slot(), ready('available'), [entry({ bookingDate: '2026-10-18' })], DATE, NOW).visible).toBe(false);
  });
});

describe('getOfferAction: an ordinary available slot', () => {
  it('with no waitlist entries, the row is the plain "Book" and no offer', () => {
    const view = ready('available');
    expect(getOfferAction(slot(), view, [], DATE, NOW).visible).toBe(false);
    expect(getSlotAction(slot(), view, true)).toEqual({ label: 'Book', bookable: true, muted: false });
  });
});

describe('getOfferAction: an offer that lapses while the page stays open', () => {
  it('is shown before the expiry and gone after it, with the same inputs and only the clock moving', () => {
    const entries = [entry()];
    expect(getOfferAction(slot(), ready('available'), entries, DATE, NOW).visible).toBe(true);
    expect(getOfferAction(slot(), ready('available'), entries, DATE, LATER).visible).toBe(false);
    // and the row falls back to the availability-based label
    expect(getSlotAction(slot(), ready('available'), true).label).toBe('Book');
  });
});

describe('getOfferAction: fails closed', () => {
  it('shows nothing while the availability is unknown', () => {
    const e = [entry()];
    for (const view of [
      { phase: 'idle' },
      { phase: 'loading' },
      { phase: 'error', message: 'x' }
    ] as AvailabilityView[]) {
      expect(getOfferAction(slot(), view, e, DATE, NOW).visible).toBe(false);
    }
  });

  it('shows nothing for a slot the database reports closed or inactive, or omits', () => {
    const e = [entry()];
    expect(getOfferAction(slot(), ready('closed'), e, DATE, NOW).visible).toBe(false);
    expect(getOfferAction(slot(), ready('inactive'), e, DATE, NOW).visible).toBe(false);
    expect(getOfferAction(slot(), { phase: 'ready', byId: {} }, e, DATE, NOW).visible).toBe(false);
    expect(getOfferAction(slot({ isActive: false }), ready('available'), e, DATE, NOW).visible).toBe(false);
  });
});
