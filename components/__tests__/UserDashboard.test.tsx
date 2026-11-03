import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The repository is the only data source the dashboard may use. Stub it
// so no network is attempted; a never-resolving promise keeps the
// component in its initial "loading" state.
const { loadCustomerCatalog, loadSlotAvailability } = vi.hoisted(() => ({
  loadCustomerCatalog: vi.fn(() => new Promise(() => {})),
  loadSlotAvailability: vi.fn(() => new Promise(() => {}))
}));

vi.mock('../../services/facilityRepository', async () => {
  const actual = await vi.importActual<any>('../../services/facilityRepository');
  return {
    ...actual,
    facilityRepository: { loadCustomerCatalog, loadSlotAvailability }
  };
});

import UserDashboard from '../UserDashboard';

const source = readFileSync(
  fileURLToPath(new URL('../UserDashboard.tsx', import.meta.url)),
  'utf8'
);

/** The live component source, without the commented-out legacy copy. */
const activeSource = source
  .split('\n')
  .filter(line => !/^\s*\/\//.test(line))
  .join('\n');

const user = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'player@example.com',
  role: 'user' as const,
  city: 'Trivandrum'
};

describe('UserDashboard repository integration', () => {
  it('starts in a loading state and asks the repository for data', () => {
    const html = renderToString(
      <MemoryRouter>
        <UserDashboard user={user} />
      </MemoryRouter>
    );

    expect(html).toContain('Loading facilities');
    // no facility cards, mock or otherwise, before the read completes
    expect(html).not.toContain('Book Now');
    expect(html).not.toMatch(/Kowdiar|Smashers|Marina Turf/);
  });

  it('does not import the mock facilityService or storageService', () => {
    // whole import statements, including multi-line ones
    const imports = (
      activeSource.match(/^import[\s\S]*?from\s+['"][^'"]+['"];?/gm) ?? []
    ).join('\n');

    expect(imports).not.toMatch(/facilityService/);
    expect(imports).not.toMatch(/storageService/);
    expect(imports).toMatch(/facilityRepository/);
    expect(activeSource).not.toMatch(/facilityService\./);
  });

  it('offers a Retry action wired to a reload, with error and empty states', () => {
    expect(activeSource).toMatch(/catalogStatus === 'error'/);
    expect(activeSource).toMatch(/setReloadKey\(k => k \+ 1\)/);
    expect(activeSource).toContain('Retry');
    expect(activeSource).toMatch(/No facilities/);
  });

  it('never substitutes mock data on failure', () => {
    // the catch branch clears the lists rather than reading a fallback
    const catchBlock = activeSource.slice(
      activeSource.indexOf('.catch(err =>'),
      activeSource.indexOf('}, [user.id, reloadKey]);')
    );
    expect(catchBlock).toContain('setFacilities([])');
    expect(catchBlock).toContain('setAllSlots([])');
    expect(catchBlock).not.toMatch(/facilityService|storageService|initial/i);
  });
});

describe('reservation flow', () => {
  it('keeps the mock checkout disabled and unreachable', () => {
    expect(activeSource).not.toMatch(
      /onStartPayment|createBookingTransactional|CUSTOMER_CHECKOUT_ENABLED|paymentService|PaymentPage/
    );
  });

  it('creates bookings only through the repository RPC wrapper', () => {
    expect(activeSource).toMatch(/bookingRepository\s*\.createBooking\(/);
    expect(activeSource).not.toMatch(/\.insert\(|\.from\(\s*['"]bookings['"]/);
    expect(activeSource).not.toMatch(
      /localStorage|storageService|getAllBookings|getBookingsByUser|initiateBooking/
    );
  });

  it('refuses before calling the database: busy, inactive, not available', () => {
    const body = activeSource.slice(
      activeSource.indexOf('const handleBook = async (slot: Slot) => {')
    );
    const busy = body.indexOf('if (reservationGuard.current.busy) return;');
    const inactive = body.indexOf('if (slot.isActive === false) return;');
    const available = body.indexOf(
      'getSlotAction(slot, availability, RESERVATIONS_ENABLED).bookable'
    );
    const create = body.indexOf('bookingRepository.createBooking(');

    expect(busy).toBeGreaterThan(-1);
    expect(inactive).toBeGreaterThan(busy);
    expect(available).toBeGreaterThan(inactive);
    expect(create).toBeGreaterThan(available);
  });

  it('runs the request inside the single-flight guard', () => {
    const body = activeSource.slice(
      activeSource.indexOf('const handleBook = async (slot: Slot) => {')
    );
    expect(body.indexOf('reservationGuard.current.run(')).toBeGreaterThan(-1);
    expect(body.indexOf('reservationGuard.current.run(')).toBeLessThan(
      body.indexOf('bookingRepository.createBooking(')
    );
  });

  it('reports success only after the database answered, and re-reads state', () => {
    const body = activeSource.slice(
      activeSource.indexOf('const handleBook = async (slot: Slot) => {'),
      activeSource.indexOf('const getSlotPrediction')
    );
    const call = body.indexOf('await bookingRepository.createBooking(');
    const success = body.indexOf("phase: 'success'");
    const failure = body.indexOf("phase: 'error'");

    expect(call).toBeGreaterThan(-1);
    expect(success).toBeGreaterThan(call);
    expect(failure).toBeGreaterThan(success);
    // the success amount and expiry come from the response
    expect(body).toContain('created.amount');
    expect(body).toContain('created.expiresAt');
    // the server's answer is re-read after every attempt
    expect(body).toMatch(/finally\s*{[\s\S]*setAvailabilityReloadKey[\s\S]*setBookingsReloadKey/);
  });

  it('disables the button unless the slot is bookable and nothing is pending', () => {
    // a plain slot: disabled unless bookable (a live offer has its own rule, tested below)
    expect(activeSource).toMatch(/disabled=\{offerAction\.visible \? !canAcceptOffer : !canBook\}/);
    expect(activeSource).toMatch(
      /const canBook = action\.bookable && !isSubmitting;/
    );
    expect(activeSource).toContain("'Reserving…'");
  });

  it('announces outcomes and states the hold is unpaid', () => {
    expect(activeSource).toContain('role="status"');
    expect(activeSource).toContain('role="alert"');
    expect(activeSource).toMatch(/payment is not available yet/i);
    expect(activeSource).toMatch(/expires automatically/i);
  });

  it('loads the schedule from the database with loading, empty and error states', () => {
    expect(activeSource).toMatch(/bookingRepository\s*\.loadMyBookings\(\)/);
    expect(activeSource).toContain('Loading your bookings');
    expect(activeSource).toContain('No upcoming bookings');
    expect(activeSource).toMatch(/setBookingsReloadKey\(k => k \+ 1\)/);
    expect(activeSource).toMatch(/bookingsView\.phase === 'error'/);
  });

  it('does not render a confirmed state for unpaid holds', () => {
    // "Confirmed" is shown only for non-held bookings (confirmed status).
    expect(activeSource).toMatch(/effectiveStatus\(b\) === 'pending_payment'/);
  });
});

describe('slot availability integration', () => {
  it('reads availability from the repository, not from mock bookings', () => {
    expect(activeSource).toMatch(/facilityRepository\s*\.loadSlotAvailability\(/);
    expect(activeSource).not.toMatch(/checkSlotAvailability|isSlotAvailable/);
  });

  it('re-reads on facility, date and Retry, and cancels stale responses', () => {
    expect(activeSource).toMatch(
      /\[user\.id, selectedFacility\?\.id, selectedDate, availabilityReloadKey, availabilityRefreshTick\]/
    );
    expect(activeSource).toMatch(/setAvailabilityReloadKey\(k => k \+ 1\)/);

    const effect = activeSource.slice(
      activeSource.indexOf('.loadSlotAvailability('),
      activeSource.indexOf('availabilityRefreshTick]);')
    );
    expect(effect).toContain('if (cancelled) return;');
  });

  it('never shows one date\'s answer for another (answer is keyed)', () => {
    // The stored answer is only used when its key matches the current
    // facility, date and retry counter; otherwise the view is "loading".
    expect(activeSource).toMatch(
      /const availabilityKey = selectedFacility\s*\? `\$\{selectedFacility\.id\}\|\$\{selectedDate\}\|\$\{availabilityReloadKey\}`/
    );
    expect(activeSource).toMatch(
      /availabilityState\.key === availabilityKey\s*\? availabilityState\.view\s*: \{ phase: 'loading' \}/
    );

    // and a result is stored under the key it was requested for
    expect(activeSource).toMatch(/setAvailabilityState\(\{ key, view: \{ phase: 'ready', byId \} \}\)/);
  });

  it('shows an error with Retry and never assumes availability on failure', () => {
    expect(activeSource).toMatch(/availability\.phase === 'error'/);

    const from = activeSource.indexOf('.loadSlotAvailability(');
    const catchBlock = activeSource.slice(
      activeSource.indexOf('.catch(err =>', from),
      activeSource.indexOf('availabilityRefreshTick]);')
    );
    expect(catchBlock).toContain("phase: 'error'");
    expect(catchBlock).not.toMatch(/available|byId|getAllBookings|storageService/);
  });

  it('does not decide slot status from the mock bookings list', () => {
    // getAllBookings() is still used for demand history and the legacy
    // profile list, but never inside the slot row or its action.
    const row = activeSource.slice(
      activeSource.indexOf('const action = getSlotAction('),
      activeSource.indexOf('{action.label}')
    );
    expect(row).not.toMatch(/getAllBookings|myBookings|checkSlotAvailability/);
  });
});

describe('waitlist flow', () => {
  const body = activeSource.slice(
    activeSource.indexOf('const runWaitlistAction = async')
  );

  it('uses the repository RPC wrappers and nothing local', () => {
    expect(activeSource).toMatch(/waitlistRepository\s*\.joinWaitlist\(/);
    expect(activeSource).toMatch(/waitlistRepository\s*\.leaveWaitlist\(/);
    expect(activeSource).toMatch(/waitlistRepository\s*\.acceptOffer\(/);
    expect(activeSource).toMatch(/waitlistRepository\s*\.loadMyWaitlist\(\)/);
    expect(activeSource).not.toMatch(/waitlist_entries|\.rpc\(|\.insert\(|localStorage|storageService/);
  });

  it('runs every mutation under one synchronous single-flight guard', () => {
    expect(activeSource).toMatch(/const waitlistGuard = useRef\(createSingleFlight\(\)\)/);
    expect(body.indexOf('if (waitlistGuard.current.busy) return;')).toBeGreaterThan(-1);
    expect(body.indexOf('waitlistGuard.current.run(')).toBeGreaterThan(-1);
  });

  it('reports success only from the awaited result and re-reads state in finally', () => {
    const run = activeSource.slice(
      activeSource.indexOf('const runWaitlistAction = async'),
      activeSource.indexOf('const handleJoinWaitlist')
    );
    const call = run.indexOf('await action()');
    const success = run.indexOf("phase: 'success'");
    const failure = run.indexOf("phase: 'error'");

    expect(call).toBeGreaterThan(-1);
    expect(success).toBeGreaterThan(call);
    expect(failure).toBeGreaterThan(success);
    expect(run).toMatch(/finally\s*{[\s\S]*setWaitlistReloadKey[\s\S]*setAvailabilityReloadKey[\s\S]*setBookingsReloadKey/);
  });

  it('joins only when the slot is taken per the database and not already queued', () => {
    const join = activeSource.slice(
      activeSource.indexOf('const handleJoinWaitlist'),
      activeSource.indexOf('const handleLeaveWaitlist')
    );
    expect(join).toContain('getWaitlistAction(slot, availability, false).joinable');
    expect(join.indexOf('getWaitlistAction')).toBeLessThan(
      join.indexOf('waitlistRepository.joinWaitlist(')
    );
  });

  it('shows an Accept control only for a live, database-issued offer', () => {
    expect(activeSource).toMatch(
      /effectiveWaitlistStatus\(entry, new Date\(clock\)\) === 'offered'/
    );
    expect(activeSource).toMatch(/\{offered && \(\s*<button\s+onClick=\{\(\) => handleAcceptOffer\(entry\)\}/);
  });

  it('never presents an accepted offer as paid', () => {
    expect(activeSource).toMatch(/Payment is not available yet/);
    expect(activeSource).not.toMatch(/Payment (successful|complete)|paid in full/i);
  });

  it('has loading, empty and retry states for the waitlist', () => {
    expect(activeSource).toContain('Loading your waitlist');
    expect(activeSource).toContain('You are not on any waitlist');
    expect(activeSource).toMatch(/setWaitlistReloadKey\(k => k \+ 1\)/);
    expect(activeSource).toMatch(/waitlistView\.phase === 'error'/);
  });
});


describe('slot row: the holder of a live waitlist offer', () => {
  const row = activeSource.slice(
    activeSource.indexOf('const action = getSlotAction('),
    activeSource.indexOf('{waitlistAction.visible')
  );

  it('reads its own LIVE offer from its waitlist entries, judged by the clock', () => {
    expect(row).toMatch(
      /getOfferAction\(\s*s,\s*availability,\s*activeWaitlist,\s*selectedDate,\s*new Date\(clock\)\s*\)/
    );
    // activeWaitlist only keeps waiting/offered entries by the clock
    expect(activeSource).toMatch(
      /const activeWaitlist: WaitlistEntry\[\][\s\S]*?effectiveWaitlistStatus\(e, new Date\(clock\)\)/
    );
  });

  it('takes the offer through the existing accept handler, not a second booking path', () => {
    expect(row).toMatch(/if \(offerAction\.visible && offerEntry\) handleAcceptOffer\(offerEntry\);\s*else handleBook\(s\);/);
    // the only callers of the accept RPC wrapper are the shared handler
    expect((activeSource.match(/waitlistRepository\s*\.acceptOffer\(/g) ?? []).length).toBe(1);
    expect((activeSource.match(/bookingRepository\.createBooking\(/g) ?? []).length).toBe(1);
  });

  it('says "Accept offer" with the offer expiry, accessibly, and is disabled while another action runs', () => {
    expect(row).toMatch(/offerAction\.label/);
    expect(row).toMatch(/Offer until \{offerUntil\}/);
    expect(row).toMatch(/offerAction\.ariaLabel/);
    expect(row).toMatch(/open until \$\{offerUntil\}/);
    expect(row).toMatch(/canAcceptOffer = offerAction\.visible && !isSubmitting && !waitlistBusy/);
    expect(row).toMatch(/disabled=\{offerAction\.visible \? !canAcceptOffer : !canBook\}/);
    // the class choice is parenthesised (a bare ternary chain would yield a boolean)
    expect(row).toMatch(/\(offerAction\.visible \? canAcceptOffer : canBook\)\s*\?/);
  });

  it('does not draw a disabled "On waitlist" next to an Accept offer', () => {
    expect(activeSource).toMatch(/\{waitlistAction\.visible && !offerAction\.visible && \(/);
  });

  it('re-reads the waitlist and availability once when a live offer drops, without polling', () => {
    expect(activeSource).toMatch(/isLiveOffer\(e, new Date\(clock\)\)/);
    expect(activeSource).toMatch(/liveOfferCount < offerScope\.current\.count/);
    const effect = activeSource.slice(
      activeSource.indexOf('const offerScope = useRef'),
      activeSource.indexOf('// A finished notice belongs to the context')
    );
    expect(effect).toMatch(/setWaitlistReloadKey\(k => k \+ 1\)/);
    expect(effect).toMatch(/setAvailabilityReloadKey\(k => k \+ 1\)/);
    expect(effect).not.toMatch(/setInterval|setTimeout/);
    // the existing cadence is unchanged: a 60 s waitlist poll and a 15 s clock tick
    expect(activeSource).toMatch(/setInterval\(\(\) => setWaitlistReloadKey\(k => k \+ 1\), 60_000\)/);
    expect(activeSource).toMatch(/setInterval\(\(\) => setClock\(Date\.now\(\)\), 15_000\)/);
  });
});

describe('cancelling an unpaid hold from Your Schedule', () => {
  const handler = activeSource.slice(
    activeSource.indexOf('const handleCancelHold'),
    activeSource.indexOf('// Entries the user can still act on')
  );

  it('cancels only through the repository RPC wrapper, never by writing the table', () => {
    expect(handler).toContain('bookingRepository.cancelBooking(booking.id)');
    expect(activeSource).not.toMatch(/from\('bookings'\)\s*\.(update|delete)/);
  });

  it('runs under its own synchronous single-flight guard', () => {
    expect(activeSource).toMatch(/const cancelGuard = useRef\(createSingleFlight\(\)\)/);
    expect(handler).toMatch(/if \(cancelGuard\.current\.busy\) return;/);
    expect(handler).toMatch(/cancelGuard\.current\.run\(/);
  });

  it('reports success only from the awaited answer, and tells an already-lapsed hold apart', () => {
    const afterAwait = handler.slice(handler.indexOf('await bookingRepository.cancelBooking'));
    expect(afterAwait.indexOf("phase: 'success'")).toBeGreaterThan(-1);
    expect(handler).toMatch(/outcome === 'cancelled'/);
    expect(handler).toContain('had already expired');
  });

  it('shows the safe error message and never raw server text', () => {
    expect(handler).toMatch(/toCancelError\(err\)\.message/);
  });

  it('re-reads bookings, availability and the waitlist whatever the outcome', () => {
    const fin = handler.slice(handler.indexOf('finally'));
    expect(fin).toContain('setBookingsReloadKey');
    expect(fin).toContain('setAvailabilityReloadKey');
    expect(fin).toContain('setWaitlistReloadKey');
  });

  it('asks for confirmation before cancelling and can be backed out of', () => {
    expect(activeSource).toContain('Cancel this reservation?');
    expect(activeSource).toContain('Yes, cancel');
    expect(activeSource).toContain('Keep it');
    // the first button only opens the confirm step
    expect(activeSource).toMatch(/setCancelConfirmId\(b\.id\)/);
    expect(activeSource).toMatch(/onClick=\{\(\) => handleCancelHold\(b\)\}/);
  });

  it('is offered only for an unpaid hold, and not while a payment is being handled', () => {
    expect(activeSource).toMatch(/const canCancel =\s*held &&/);
    expect(activeSource).toMatch(/scheduleBookingId !== b\.id/);
    expect(activeSource).toMatch(/hasUnresolvedPayment\(b\.id\) \|\| openedElsewhere/);
  });

  it('disables the control while a cancellation is in flight', () => {
    expect(activeSource).toMatch(/disabled=\{cancelFlow\.phase === 'submitting'\}/);
  });
});

describe('slot picker: bounded availability refresh', () => {
  const effect = activeSource.slice(
    activeSource.indexOf('const hasOpenFacility'),
    activeSource.indexOf('// Real bookings, read through the repository.')
  );

  it('re-reads about once a minute, and only while a venue is open', () => {
    expect(effect).toMatch(/if \(!hasOpenFacility\) return;/);
    expect(effect).toMatch(/setInterval\(refresh, 60_000\)/);
    expect(effect).toMatch(/clearInterval\(timer\)/);
  });

  it('skips hidden tabs and never re-reads on focus sooner than 15 s after the last read', () => {
    expect(effect).toMatch(/visibilityState === 'hidden'\) return/);
    expect(effect).toMatch(/Date\.now\(\) - last >= 15_000/);
    expect(effect).toMatch(/removeEventListener\('focus'/);
    expect(effect).toMatch(/removeEventListener\('visibilitychange'/);
  });

  it('refreshes quietly: not part of the key, so rows do not flash loading, and a failure keeps the last answer', () => {
    const keyDef = activeSource.slice(
      activeSource.indexOf('const availabilityKey'),
      activeSource.indexOf('const availability: AvailabilityView')
    );
    expect(keyDef).not.toContain('availabilityRefreshTick');
    expect(activeSource).toMatch(/availabilityReloadKey, availabilityRefreshTick\]/);
    expect(activeSource).toMatch(/if \(quiet\) return;/);
  });
});

describe('truthful schedule labels', () => {
  it('never labels an unpaid hold "Confirmed", even without an expiry time', () => {
    expect(activeSource).toMatch(/: 'Unpaid hold'\s*\n\s*: 'Confirmed'/);
  });
});

describe('default booking date', () => {
  it('opens on a date the database accepts and the viewer does not consider past', () => {
    expect(activeSource).toMatch(/useState<string>\(\(\) => defaultBookingDate\(\)\)/);
    expect(activeSource).toContain("from '../services/bookingDate'");
  });
});
