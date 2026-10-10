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
import { CUSTOMER_CHECKOUT_ENABLED } from '../../services/bookingService';

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

describe('checkout gate', () => {
  it('is disabled while checkout is still mock-backed', () => {
    expect(CUSTOMER_CHECKOUT_ENABLED).toBe(false);
  });

  it('stops handleBook before payment can start, and refuses inactive slots', () => {
    const body = activeSource.slice(
      activeSource.indexOf('const handleBook = (slot: Slot) => {')
    );
    const gate = body.indexOf('if (!CUSTOMER_CHECKOUT_ENABLED) return;');
    const inactive = body.indexOf('if (slot.isActive === false) return;');
    const start = body.indexOf('onStartPayment({');

    expect(gate).toBeGreaterThan(-1);
    expect(inactive).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(gate);
    expect(start).toBeGreaterThan(inactive);
  });

  it('disables the Book button unless the slot is bookable', () => {
    expect(activeSource).toMatch(/disabled=\{!canBook\}/);
    expect(activeSource).toMatch(/const canBook = action\.bookable;/);
  });

  it('re-checks availability inside handleBook before payment can start', () => {
    const body = activeSource.slice(
      activeSource.indexOf('const handleBook = (slot: Slot) => {')
    );
    const check = body.indexOf('getSlotAction(slot, availability, CUSTOMER_CHECKOUT_ENABLED).bookable');
    const start = body.indexOf('onStartPayment({');

    expect(check).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(check);
  });
});

describe('slot availability integration', () => {
  it('reads availability from the repository, not from mock bookings', () => {
    expect(activeSource).toMatch(/facilityRepository\s*\.loadSlotAvailability\(/);
    expect(activeSource).not.toMatch(/checkSlotAvailability|isSlotAvailable/);
  });

  it('re-reads on facility, date and Retry, and cancels stale responses', () => {
    expect(activeSource).toMatch(
      /\[user\.id, selectedFacility\?\.id, selectedDate, availabilityReloadKey\]/
    );
    expect(activeSource).toMatch(/setAvailabilityReloadKey\(k => k \+ 1\)/);

    const effect = activeSource.slice(
      activeSource.indexOf('.loadSlotAvailability('),
      activeSource.indexOf('availabilityReloadKey]);')
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
      activeSource.indexOf('availabilityReloadKey]);')
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
