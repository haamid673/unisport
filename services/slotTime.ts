/**
 * Start hour (0-23) of a slot time string, or null when it cannot be read.
 *
 * Accepts the formats the app produces and receives:
 *   "06:00 PM - 07:00 PM"   12-hour with meridiem (the display format)
 *   "6 PM", "12:30 am"      hour-only and lower-case meridiem
 *   "18:00:00", "18:00"     24-hour (database time values)
 *
 * Only the start of a range is read. 12 AM is hour 0 and 12 PM is hour
 * 12. A 12-hour value without a valid hour (1-12) is rejected rather
 * than guessed.
 */
export function parseSlotStartHour(time: string | null | undefined): number | null {
  if (typeof time !== 'string') return null;

  const match = /^\s*(\d{1,2})(?::\d{2}){0,2}\s*(?:([ap])\.?\s?m\.?)?(?![\dA-Za-z])/i.exec(time);
  if (!match) return null;

  const hour = Number(match[1]);
  const meridiem = match[2]?.toLowerCase();

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'a') return hour === 12 ? 0 : hour;
    return hour === 12 ? 12 : hour + 12;
  }

  return hour >= 0 && hour <= 23 ? hour : null;
}
