import { describe, it, expect } from 'vitest';
import { getWaitlistAction, getLeaveControl, AvailabilityView } from '../slotAvailability';
import type { Slot } from '../../types';

const slot = (overrides: Partial<Slot> = {}): Slot => ({
  id: 's1',
  facilityId: 'f1',
  time: '06:00 PM - 07:00 PM',
  price: 500,
  isActive: true,
  ...overrides
});

const ready = (status: string): AvailabilityView => ({
  phase: 'ready',
  byId: { s1: status as never }
});

describe('getWaitlistAction', () => {
  it('offers the waitlist for slots the database reports as taken', () => {
    for (const status of ['booked', 'offer_held']) {
      expect(getWaitlistAction(slot(), ready(status), false)).toEqual({
        visible: true,
        label: 'Join waitlist',
        joinable: true
      });
    }
  });

  it('shows a disabled "On waitlist" when the user is already queued', () => {
    expect(getWaitlistAction(slot(), ready('booked'), true)).toEqual({
      visible: true,
      label: 'On waitlist',
      joinable: false
    });
  });

  it('offers nothing for slots that are available, closed or inactive', () => {
    for (const status of ['available', 'closed', 'inactive']) {
      expect(getWaitlistAction(slot(), ready(status), false).visible).toBe(false);
    }
  });

  it('fails closed while availability is unknown', () => {
    for (const view of [
      { phase: 'idle' },
      { phase: 'loading' },
      { phase: 'error', message: 'x' }
    ] as AvailabilityView[]) {
      expect(getWaitlistAction(slot(), view, false).visible).toBe(false);
    }
  });

  it('offers nothing for a slot missing from the answer or switched off', () => {
    expect(
      getWaitlistAction(slot({ id: 'other' }), ready('booked'), false).visible
    ).toBe(false);
    expect(
      getWaitlistAction(slot({ isActive: false }), ready('booked'), false).visible
    ).toBe(false);
  });
});

describe('getLeaveControl (leave from the open slot modal)', () => {
  const entry = (overrides: Partial<{ id: string; slotId: string; bookingDate: string }> = {}) => ({
    id: 'e1',
    slotId: 's1',
    bookingDate: '2026-10-14',
    ...overrides
  });

  it('is visible for a live entry on this slot and date, with an accessible name', () => {
    const control = getLeaveControl(slot(), [entry()], '2026-10-14', null);

    expect(control.visible).toBe(true);
    expect(control.entry?.id).toBe('e1');
    expect(control.label).toBe('Leave waitlist');
    expect(control.ariaLabel).toBe('Leave the waitlist for 06:00 PM - 07:00 PM');
    expect(control.disabled).toBe(false);
    expect(control.busy).toBe(false);
  });

  it('is hidden without an entry for this slot and date', () => {
    expect(getLeaveControl(slot(), [], '2026-10-14', null).visible).toBe(false);
    expect(getLeaveControl(slot(), [entry({ slotId: 's2' })], '2026-10-14', null).visible).toBe(false);
    expect(getLeaveControl(slot(), [entry({ bookingDate: '2026-10-15' })], '2026-10-14', null).visible).toBe(false);
  });

  it('picks the entry of this slot among several', () => {
    const control = getLeaveControl(
      slot(),
      [entry({ id: 'other', slotId: 's9' }), entry({ id: 'mine' })],
      '2026-10-14',
      null
    );

    expect(control.entry?.id).toBe('mine');
  });

  it('is disabled while any waitlist action is in flight (no duplicate submissions)', () => {
    for (const pending of ['leave:e1', 'join:s2', 'accept:e9', 'leave:other']) {
      expect(getLeaveControl(slot(), [entry()], '2026-10-14', pending).disabled).toBe(true);
    }
  });

  it('shows the busy label only for this entry\'s own leave request', () => {
    const own = getLeaveControl(slot(), [entry()], '2026-10-14', 'leave:e1');
    expect(own.busy).toBe(true);
    expect(own.label).toBe('Leaving…');

    for (const pending of ['join:s1', 'leave:other', 'accept:e1']) {
      const control = getLeaveControl(slot(), [entry()], '2026-10-14', pending);
      expect(control.busy).toBe(false);
      expect(control.label).toBe('Leave waitlist');
    }
  });

  it('does not depend on the availability snapshot', () => {
    // visibility comes from the user's own live entry; the slot may already
    // be reported free while the entry has not been offered yet
    expect(getLeaveControl(slot(), [entry()], '2026-10-14', null).visible).toBe(true);
  });
});
