import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Never-resolving reads keep the dashboard in its initial loading state.
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
import { mapSlotRow } from '../../services/facilityRepository';

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

describe('facility discovery wiring', () => {
  it('no longer filters by substring on the display location', () => {
    expect(activeSource).not.toMatch(/location\.includes\(/);
  });

  it('has no hardcoded city list', () => {
    expect(activeSource).not.toMatch(/const cities\s*=\s*\[/);
    expect(activeSource).not.toMatch(/'Chennai'.*'Mumbai'.*'Delhi'/s);
  });

  it('builds selector options from the loaded catalog and filters on the city field', () => {
    expect(activeSource).toMatch(/deriveCityOptions\(facilities,\s*selectedCityName\)/);
    expect(activeSource).toMatch(/filterByCity<Facility>\(facilities,\s*selectedCity\)/);
    expect(activeSource).toMatch(/inCity\(f,\s*selectedCity\)/);
  });

  it('does not claim a country the data does not have', () => {
    expect(activeSource).not.toMatch(/\{option\.label\},\s*IN/);
    expect(activeSource).not.toMatch(/\}, IN</);
  });

  it('renders the selector with an accessible name and the default city, no mock data', () => {
    const html = renderToString(
      <MemoryRouter>
        <UserDashboard user={user} />
      </MemoryRouter>
    );

    expect(html).toContain('aria-label="City"');
    // only the current selection exists before the catalog is read, shown
    // with its display name rather than the lowercase comparison key
    expect(html).toContain('>Trivandrum</option>');
    expect(html).not.toContain('>trivandrum</option>');
    expect(html).not.toMatch(/Chennai|Mumbai|Kolkata|Jaipur|Bangalore|Hyderabad/);
  });
});

describe('waitlist action on the user\'s own hold wiring', () => {
  it('derives the hold from the user\'s real bookings and the clock', () => {
    expect(activeSource).toMatch(
      /holdsSlot\(bookingsView\.bookings,\s*s\.id,\s*selectedDate,\s*new Date\(clock\)\)/
    );
  });

  it('passes the hold to the waitlist rule and hides it while bookings load', () => {
    expect(activeSource).toMatch(
      /ownHold \|\| bookingsView\.phase === 'loading'/
    );
  });

  it('replaces the control with a non-interactive label', () => {
    expect(activeSource).toContain('Your reservation');
    expect(activeSource).toMatch(/showsOwnHold\(s,\s*availability,\s*ownHold\)/);
  });

  it('keeps the last bookings while they refresh so the row does not flicker', () => {
    expect(activeSource).toMatch(
      /setBookingsView\(prev => \(prev\.phase === 'ready' \? prev : \{ phase: 'loading' \}\)\)/
    );
  });

  it('re-reads availability when a hold lapses', () => {
    expect(activeSource).toMatch(/liveHoldCount < holdScope\.current\.count/);
  });

  it('leaves the server rule alone: join still goes through the repository', () => {
    expect(activeSource).toMatch(/waitlistRepository\.joinWaitlist\(/);
  });
});

describe('stale notice wiring', () => {
  it('starting a reservation clears a finished waitlist notice', () => {
    const handleBook = activeSource.slice(
      activeSource.indexOf('const handleBook'),
      activeSource.indexOf('const runWaitlistAction')
    );

    expect(handleBook).toMatch(
      /setWaitlistFlow\(prev => clearFinishedFlow\(prev,\s*\{ phase: 'idle' \}\)\)/
    );
  });

  it('starting a waitlist action clears a finished booking notice', () => {
    const run = activeSource.slice(
      activeSource.indexOf('const runWaitlistAction'),
      activeSource.indexOf('const handleJoinWaitlist')
    );

    expect(run).toMatch(
      /setBookingFlow\(prev => clearFinishedFlow\(prev,\s*\{ phase: 'idle' \}\)\)/
    );
  });

  it('clears finished notices when the facility, date or picker changes', () => {
    expect(activeSource).toMatch(/const clearFinishedNotices = \(\) =>/);
    // facility open, date change, backdrop close and close button
    expect(activeSource.match(/clearFinishedNotices\(\)/g)?.length).toBeGreaterThanOrEqual(4);
    expect(activeSource).not.toMatch(
      /if \(!reservationGuard\.current\.busy\) setBookingFlow\(\{ phase: 'idle' \}\)/
    );
  });

  it('keeps live regions mounted so replacements are still announced', () => {
    // containers are not conditional; only their contents are
    expect(activeSource).toMatch(/<div aria-live="polite">\s*\{bookingFlow\.phase === 'success'/);
    expect(activeSource).toMatch(/const waitlistNotice = \(\s*<div aria-live="polite">/);
    expect(activeSource).toMatch(/role="status"/);
    expect(activeSource).toMatch(/role="alert"/);
  });

  it('does not touch availability or list-load errors, which are independent', () => {
    expect(activeSource).toMatch(/availability\.phase === 'error' &&/);
    expect(activeSource).toMatch(/bookingsView\.phase === 'error'/);
  });
});

describe('unsupported surge / demand claims are gone', () => {
  it('renders no HOT / SURGE / demand-analysis wording from the live source', () => {
    for (const pattern of [
      /\bSurge\b/i,
      />\s*Hot\s*</,
      /Demand Analysis/i,
      /predictive intelligence/i,
      /High demand detected/i,
      /Normal demand/i,
      /Surge Rates|Normal Rates/i,
      /booking density/i,
      /Analyzing market data/i
    ]) {
      expect(activeSource).not.toMatch(pattern);
    }
  });

  it('no longer asks the demand heuristic for anything', () => {
    expect(activeSource).not.toMatch(/aiEngine|analyzeSlotDemand/);
    expect(activeSource).not.toMatch(/slotPredictions|selectedSlotInsight|loadingPrediction/);
    expect(activeSource).not.toMatch(/isSurge|demandLevel|pred\??\.reasoning/);
  });

  it('shows the database slot price and no computed or suggested price', () => {
    expect(activeSource).toMatch(/₹\{s\.price\}/);
    expect(activeSource).not.toMatch(/suggestedPrice|multiplier|surgePercent/i);
  });

  it('the displayed slot price is the stored base price, unchanged', () => {
    expect(mapSlotRow({
      id: 's1', facility_id: 'f1', start_time: '18:00:00', end_time: '19:00:00',
      base_price: '500.00', is_active: true
    }).price).toBe(500);

    expect(mapSlotRow({
      id: 's2', facility_id: 'f1', start_time: '19:00:00', end_time: '20:00:00',
      base_price: 650.5, is_active: true
    }).price).toBe(650.5);
  });

  it('the initial render contains none of the removed indicators', () => {
    const html = renderToString(
      <MemoryRouter>
        <UserDashboard user={user} />
      </MemoryRouter>
    );

    expect(html).not.toMatch(/Surge|Demand Analysis|predictive intelligence/i);
  });

  it('keeps the honest hold notice that payment is not available', () => {
    expect(activeSource).toMatch(/Online payment is not\s+available yet/);
  });
});

describe('leave the waitlist from the open slot modal', () => {
  it('derives the control from the user\'s live entries via the shared rule', () => {
    expect(activeSource).toMatch(/getLeaveControl\(\s*s,\s*activeWaitlist,\s*selectedDate,/);
    expect(activeSource).toMatch(/waitlistFlow\.phase === 'submitting' \? waitlistFlow\.target : null/);
  });

  it('reuses the existing leave handler; there is exactly one leave implementation', () => {
    expect(activeSource).toMatch(/handleLeaveWaitlist\(leaveControl\.entry\)/);
    // the repository call lives only in handleLeaveWaitlist
    expect(activeSource.match(/waitlistRepository\.leaveWaitlist\(/g)).toHaveLength(1);
    // and that handler runs under the single-flight waitlist guard
    expect(activeSource).toMatch(
      /runWaitlistAction\(`leave:\$\{entry\.id\}`,\s*'leave'/
    );
  });

  it('is a keyboard-reachable button with an accessible name and busy state', () => {
    expect(activeSource).toMatch(/type="button"[\s\S]{0,700}aria-label=\{leaveControl\.ariaLabel\}/);
    expect(activeSource).toMatch(/disabled=\{leaveControl\.disabled\}/);
    expect(activeSource).toMatch(/aria-busy=\{leaveControl\.busy\}/);
  });

  it('does not let the click fall through to anything else in the row', () => {
    expect(activeSource).toMatch(/e\.stopPropagation\(\);\s*if \(leaveControl\.entry\) handleLeaveWaitlist/);
  });

  it('refreshes waitlist, availability and bookings after any waitlist action', () => {
    expect(activeSource).toMatch(
      /finally \{\s*setWaitlistReloadKey\(k => k \+ 1\);\s*setAvailabilityReloadKey\(k => k \+ 1\);\s*setBookingsReloadKey\(k => k \+ 1\);/
    );
  });

  it('shows the outcome inside the open modal (success and error)', () => {
    // the modal renders the same waitlist notice the list uses
    expect(activeSource).toMatch(/\{waitlistNotice\}/);
    expect(activeSource).toMatch(/You have left the waitlist\./);
  });
});
