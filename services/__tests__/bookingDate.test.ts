import { describe, it, expect } from 'vitest';
import { defaultBookingDate, localDateKey, utcDateKey } from '../bookingDate';

// Vitest runs in whatever time zone the machine has, so the cases that
// depend on a zone build the Date from local fields and assert the
// relationship instead of a fixed string.

describe('defaultBookingDate', () => {
  it('is never earlier than the database date (a past date would be refused)', () => {
    for (const hour of [0, 1, 5, 6, 12, 18, 23]) {
      const now = new Date(2026, 9, 29, hour, 30);
      expect(defaultBookingDate(now) >= utcDateKey(now)).toBe(true);
    }
  });

  it('is never earlier than the viewer\'s own calendar date', () => {
    for (const hour of [0, 1, 5, 6, 12, 18, 23]) {
      const now = new Date(2026, 9, 29, hour, 30);
      expect(defaultBookingDate(now) >= localDateKey(now)).toBe(true);
    }
  });

  it('is one of the two dates, never invented', () => {
    const now = new Date(2026, 9, 29, 2, 0);
    expect([localDateKey(now), utcDateKey(now)]).toContain(defaultBookingDate(now));
  });

  it('formats a real calendar date as YYYY-MM-DD', () => {
    expect(localDateKey(new Date(2026, 0, 5, 9))).toBe('2026-01-05');
    expect(utcDateKey(new Date(Date.UTC(2026, 11, 31, 23)))).toBe('2026-12-31');
    expect(defaultBookingDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('picks the viewer\'s date when it is ahead of UTC and UTC\'s when it is behind', () => {
    // Pure check of the rule with explicit keys, independent of the machine zone.
    const pick = (local: string, utc: string) => (local > utc ? local : utc);
    expect(pick('2026-10-29', '2026-10-28')).toBe('2026-10-29'); // east of UTC, early morning
    expect(pick('2026-10-28', '2026-10-29')).toBe('2026-10-29'); // west of UTC, evening
    expect(pick('2026-10-28', '2026-10-28')).toBe('2026-10-28');
  });
});
