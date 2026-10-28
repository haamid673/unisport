/**
 * Dates in the slot picker.
 *
 * The database decides what "today" is for bookings: its own
 * current_date, which runs in UTC (docs/MVP_BACKLOG.md, D9). A date
 * before it is rejected as in the past.
 *
 * The picker used to default to the UTC date. For someone east of UTC
 * that is yesterday on their own calendar for part of every morning
 * (in India, 00:00 to 05:30), so it opened on a day they consider past.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** The viewer's own calendar date, YYYY-MM-DD. */
export const localDateKey = (now: Date): string =>
  `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

/** The database's date (UTC), YYYY-MM-DD. */
export const utcDateKey = (now: Date): string => now.toISOString().split('T')[0];

/**
 * The date the picker opens on: the viewer's local date, but never
 * earlier than the database's today, which would be refused. Both are
 * YYYY-MM-DD, so the later one is the greater string.
 */
export const defaultBookingDate = (now: Date = new Date()): string => {
  const local = localDateKey(now);
  const utc = utcDateKey(now);
  return local > utc ? local : utc;
};
