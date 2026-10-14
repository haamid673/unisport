import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { loadMyBookings, createBooking } = vi.hoisted(() => ({
  loadMyBookings: vi.fn(() => new Promise(() => {})),
  createBooking: vi.fn()
}));

vi.mock('../../services/bookingRepository', async () => {
  const actual = await vi.importActual<any>('../../services/bookingRepository');
  return { ...actual, bookingRepository: { loadMyBookings, createBooking } };
});

import UserProfile from '../UserProfile';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const profileSource = read('../UserProfile.tsx');
const appSource = read('../../App.tsx');

const user = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'player@example.com',
  role: 'user' as const,
  city: 'Trivandrum'
};

describe('profile booking history', () => {
  it('starts in a loading state and shows no local or demo bookings', () => {
    const html = renderToString(<UserProfile user={user} onUpdate={() => {}} />);

    expect(html).toContain('Booking History');
    expect(html).toContain('Loading your bookings');
    expect(html).not.toContain('No bookings found');
    expect(html).not.toContain('Cancel Booking');
  });

  it('reads history only through the repository', () => {
    expect(profileSource).toMatch(/bookingRepository\s*\.loadMyBookings\(\)/);
    expect(profileSource).not.toMatch(
      /bookingService|getEnrichedUserBookings|cancelBooking|localStorage|storageService/
    );
  });

  it('has error (with Retry) and empty states', () => {
    expect(profileSource).toMatch(/bookingsView\.phase === 'error'/);
    expect(profileSource).toContain('Retry');
    expect(profileSource).toContain('You have no bookings yet.');
  });

  it('does not offer a cancel action the database does not support', () => {
    expect(profileSource).not.toMatch(/Cancel Booking/);
  });
});

describe('payment flow stays unreachable', () => {
  it('App does not hand the dashboard a payment callback', () => {
    expect(appSource).not.toMatch(/onStartPayment/);
    expect(appSource).not.toMatch(/setActiveTab\('payment'\)/);
  });
});
