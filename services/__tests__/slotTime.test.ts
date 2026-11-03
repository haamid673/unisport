import { describe, it, expect } from 'vitest';
import { parseSlotStartHour } from '../slotTime';

describe('parseSlotStartHour', () => {
  it('reads 12-hour display ranges with the meridiem', () => {
    expect(parseSlotStartHour('06:00 AM - 07:00 AM')).toBe(6);
    expect(parseSlotStartHour('06:00 PM - 07:00 PM')).toBe(18);
    expect(parseSlotStartHour('09:30 PM - 10:30 PM')).toBe(21);
  });

  it('treats 12 AM as midnight and 12 PM as noon', () => {
    expect(parseSlotStartHour('12:00 AM - 01:00 AM')).toBe(0);
    expect(parseSlotStartHour('12:30 PM - 01:30 PM')).toBe(12);
    expect(parseSlotStartHour('11:00 AM - 12:00 PM')).toBe(11);
  });

  it('accepts lower-case, hour-only and dotted meridiems', () => {
    expect(parseSlotStartHour('6 pm')).toBe(18);
    expect(parseSlotStartHour('6 PM')).toBe(18);
    expect(parseSlotStartHour('7:15 a.m.')).toBe(7);
  });

  it('reads 24-hour database times', () => {
    expect(parseSlotStartHour('18:00:00')).toBe(18);
    expect(parseSlotStartHour('06:00')).toBe(6);
    expect(parseSlotStartHour('00:00:00')).toBe(0);
    expect(parseSlotStartHour('23:30 - 00:30')).toBe(23);
  });

  it('returns null rather than guessing for unreadable input', () => {
    expect(parseSlotStartHour('')).toBeNull();
    expect(parseSlotStartHour('evening')).toBeNull();
    expect(parseSlotStartHour('25:00')).toBeNull();
    expect(parseSlotStartHour('13:00 PM')).toBeNull();
    expect(parseSlotStartHour('0 AM')).toBeNull();
    expect(parseSlotStartHour('1800')).toBeNull();
    expect(parseSlotStartHour(undefined)).toBeNull();
    expect(parseSlotStartHour(null)).toBeNull();
  });
});
