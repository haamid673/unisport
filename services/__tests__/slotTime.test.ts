import { describe, it, expect } from 'vitest';
import { parseSlotStartHour } from '../slotTime';
import { aiEngine } from '../aiEngine';

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

describe('aiEngine.analyzeSlotDemand peak-hour detection', () => {
  const slot = (id: string, time: string) => ({ id, time, basePrice: 1000 });

  it('flags evening PM slots as high demand and morning slots as low', async () => {
    const result = await aiEngine.analyzeSlotDemand(
      'Venue',
      'Padel',
      [
        slot('evening', '06:00 PM - 07:00 PM'),
        slot('morning', '06:00 AM - 07:00 AM'),
        slot('noon', '12:00 PM - 01:00 PM'),
        slot('late', '10:00 PM - 11:00 PM')
      ],
      []
    );

    const byId = Object.fromEntries(result.map(r => [r.slotId, r]));

    expect(byId.evening.demandLevel).toBe('High');
    expect(byId.evening.isSurge).toBe(true);
    // 06:00 AM used to be read as 6 and 06:00 PM as 6 too; only the
    // evening one is prime time.
    expect(byId.morning.demandLevel).toBe('Low');
    expect(byId.noon.demandLevel).toBe('Low');
    expect(byId.late.demandLevel).toBe('Low');
  });

  it('does not treat an unreadable time as prime time', async () => {
    const [prediction] = await aiEngine.analyzeSlotDemand(
      'Venue',
      'Padel',
      [slot('x', 'sometime')],
      []
    );
    expect(prediction.demandLevel).toBe('Low');
  });

  it('still rises with booking history and uses valid level names', async () => {
    const history = [{ slotId: 'm' }, { slotId: 'm' }];
    const [medium] = await aiEngine.analyzeSlotDemand(
      'Venue',
      'Padel',
      [slot('m', '06:00 AM - 07:00 AM')],
      history
    );
    expect(medium.demandLevel).toBe('Medium');
    expect(typeof medium.confidence).toBe('number');
    expect(typeof medium.surgePercent).toBe('number');
  });
});
