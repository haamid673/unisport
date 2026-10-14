import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  HoursAction,
  HoursState,
  createHoursState,
  draftProblem,
  hoursReducer,
  isDirty,
  saveDay
} from '../operatingHoursDraft';
import { mapOperatingWeek } from '../ownerFacilityRepository';
import { createSingleFlight } from '../singleFlight';

const MON = 1;
const TUE = 2;
const ROW_MON = '11111111-1111-4111-8111-111111111111';
const ROW_NEW = '22222222-2222-4222-8222-222222222222';

const week = () =>
  mapOperatingWeek([
    { id: ROW_MON, day_of_week: MON, opens_at: '06:00:00', closes_at: '22:00:00', is_closed: false }
  ]);

/** A tiny store that applies actions with the real reducer. */
const harness = () => {
  let state: HoursState = createHoursState(week());
  const dispatch = (a: HoursAction) => {
    state = hoursReducer(state, a);
  };
  const day = (d: number) => state.days.find(x => x.saved.dayOfWeek === d)!;
  const edit = (d: number, patch: Partial<{ isClosed: boolean; opensAt: string; closesAt: string }>) =>
    dispatch({ type: 'edit', day: d, patch });
  return { get state() { return state; }, dispatch, day, edit };
};

/** A persist() whose resolution the test controls. */
const deferred = () => {
  let resolve!: (id: string | null) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<string | null>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const run = (h: ReturnType<typeof harness>, day: number, persist: any, guard = createSingleFlight()) =>
  saveDay({
    state: h.state,
    dayOfWeek: day,
    guard,
    dispatch: h.dispatch,
    persist,
    describeError: e => (e as Error).message
  });

describe('saving one day keeps the other days\' drafts', () => {
  it('retains an unsaved Tuesday draft when Monday is saved', async () => {
    const h = harness();
    h.edit(TUE, { opensAt: '07:30', closesAt: '21:00' });
    h.edit(MON, { closesAt: '20:00' });

    const outcome = await run(h, MON, vi.fn().mockResolvedValue(ROW_MON));

    expect(outcome).toBe('saved');
    expect(h.day(TUE).draft).toEqual({ isClosed: false, opensAt: '07:30', closesAt: '21:00' });
    expect(isDirty(h.day(TUE))).toBe(true);
    // the week was not reloaded: Tuesday is still "not set" at the baseline
    expect(h.day(TUE).saved.configured).toBe(false);
  });

  it('updates only the saved day\'s baseline from the successful save', async () => {
    const h = harness();
    h.edit(MON, { opensAt: '08:00', closesAt: '18:00' });

    await run(h, MON, vi.fn().mockResolvedValue(ROW_MON));

    expect(h.day(MON).saved).toMatchObject({
      isClosed: false, opensAt: '08:00', closesAt: '18:00', configured: true, rowId: ROW_MON
    });
    expect(isDirty(h.day(MON))).toBe(false);
    expect(h.day(0).saved.configured).toBe(false);
  });

  it('takes the new row id after inserting a day, so the next save updates it', async () => {
    const h = harness();
    h.edit(TUE, { opensAt: '07:00', closesAt: '21:00' });
    const persist = vi.fn().mockResolvedValueOnce(ROW_NEW).mockResolvedValueOnce(ROW_NEW);

    await run(h, TUE, persist);
    h.edit(TUE, { closesAt: '22:00' });
    await run(h, TUE, persist);

    expect(persist.mock.calls[0][1]).toBeNull();
    expect(persist.mock.calls[1][1]).toBe(ROW_NEW);
  });

  it('clears a closed day\'s times in the baseline, as the database stores it', async () => {
    const h = harness();
    h.edit(MON, { isClosed: true });

    await run(h, MON, vi.fn().mockResolvedValue(ROW_MON));

    expect(h.day(MON).saved).toMatchObject({ isClosed: true, opensAt: null, closesAt: null });
  });
});

describe('a delayed response does not overwrite newer edits', () => {
  it('keeps an edit made to the same day while its request was in flight', async () => {
    const h = harness();
    const slow = deferred();
    h.edit(MON, { closesAt: '20:00' });

    const pending = run(h, MON, vi.fn().mockReturnValue(slow.promise));
    // the owner keeps typing while the request is pending
    h.edit(MON, { closesAt: '19:00' });
    slow.resolve(ROW_MON);
    await pending;

    // the request carried 20:00; the newer 19:00 draft is untouched
    expect(h.day(MON).saved.closesAt).toBe('20:00');
    expect(h.day(MON).draft.closesAt).toBe('19:00');
    expect(isDirty(h.day(MON))).toBe(true);
  });

  it('sends the draft as it was at the click, not a later edit', async () => {
    const h = harness();
    const slow = deferred();
    h.edit(MON, { closesAt: '20:00' });
    const persist = vi.fn().mockReturnValue(slow.promise);

    const pending = run(h, MON, persist);
    h.edit(MON, { closesAt: '19:00' });
    slow.resolve(ROW_MON);
    await pending;

    expect(persist.mock.calls[0][0]).toMatchObject({ closesAt: '20:00' });
  });

  it('drops a response that arrives after the form moved to another venue', async () => {
    const h = harness();
    const slow = deferred();
    let active = true;
    h.edit(MON, { closesAt: '20:00' });

    const pending = saveDay({
      state: h.state,
      dayOfWeek: MON,
      guard: createSingleFlight(),
      dispatch: h.dispatch,
      persist: () => slow.promise,
      describeError: String,
      isActive: () => active
    });
    active = false;
    slow.resolve(ROW_MON);

    expect(await pending).toBe('stale');
    expect(h.day(MON).saved.closesAt).toBe('22:00');
  });
});

describe('validation feedback', () => {
  it('reports an inverted range on save, sends nothing, and keeps the draft', async () => {
    const h = harness();
    h.edit(MON, { opensAt: '22:00', closesAt: '06:00' });
    const persist = vi.fn();

    const outcome = await run(h, MON, persist);

    expect(outcome).toBe('invalid');
    expect(persist).not.toHaveBeenCalled();
    expect(h.day(MON).error).toBe('Closing time must be after opening time.');
    expect(h.day(MON).draft).toMatchObject({ opensAt: '22:00', closesAt: '06:00' });
    // feedback belongs to that day only
    expect(h.day(TUE).error).toBeNull();
  });

  it('reports missing times, and equal times', async () => {
    const h = harness();
    expect(draftProblem(TUE, { isClosed: false, opensAt: '', closesAt: '' })).toBe(
      'Enter opening and closing times.'
    );
    expect(draftProblem(TUE, { isClosed: false, opensAt: '09:00', closesAt: '09:00' })).toBe(
      'Closing time must be after opening time.'
    );
    h.edit(TUE, { opensAt: '09:00' });
    expect(await run(h, TUE, vi.fn())).toBe('invalid');
    expect(h.day(TUE).error).toBe('Enter opening and closing times.');
  });

  it('shows no error for a valid draft, a closed day, or an untouched form', async () => {
    const h = harness();
    expect(h.state.days.every(d => d.error === null)).toBe(true);

    expect(draftProblem(MON, { isClosed: false, opensAt: '06:00', closesAt: '22:00' })).toBeNull();
    expect(draftProblem(TUE, { isClosed: true, opensAt: '', closesAt: '' })).toBeNull();

    h.edit(MON, { closesAt: '21:00' });
    expect(await run(h, MON, vi.fn().mockResolvedValue(ROW_MON))).toBe('saved');
    expect(h.day(MON).error).toBeNull();
  });

  it('clears the message once the owner edits that day', async () => {
    const h = harness();
    h.edit(MON, { opensAt: '23:00' });
    await run(h, MON, vi.fn());
    expect(h.day(MON).error).not.toBeNull();

    h.edit(MON, { opensAt: '07:00' });

    expect(h.day(MON).error).toBeNull();
  });

  it('uses the same rule as the repository', () => {
    // the repository still refuses these; the form must never be laxer
    for (const [o, c] of [['22:00', '06:00'], ['10:00', '10:00'], ['', '10:00']]) {
      expect(draftProblem(MON, { isClosed: false, opensAt: o, closesAt: c })).not.toBeNull();
    }
  });
});

describe('failed saves', () => {
  it('keep the owner\'s edits, show an error, and release the lock', async () => {
    const h = harness();
    const guard = createSingleFlight();
    h.edit(MON, { closesAt: '20:00' });

    const outcome = await run(h, MON, vi.fn().mockRejectedValue(new Error('Could not save.')), guard);

    expect(outcome).toBe('failed');
    expect(h.day(MON).error).toBe('Could not save.');
    expect(h.day(MON).draft.closesAt).toBe('20:00');
    expect(h.day(MON).saved.closesAt).toBe('22:00');
    expect(h.state.savingDay).toBeNull();
    expect(guard.busy).toBe(false);
  });

  it('keep other days\' drafts too', async () => {
    const h = harness();
    h.edit(TUE, { opensAt: '07:00', closesAt: '20:00' });
    h.edit(MON, { closesAt: '20:00' });

    await run(h, MON, vi.fn().mockRejectedValue(new Error('nope')));

    expect(h.day(TUE).draft).toMatchObject({ opensAt: '07:00', closesAt: '20:00' });
  });

  it('can be retried', async () => {
    const h = harness();
    h.edit(MON, { closesAt: '20:00' });
    const persist = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(ROW_MON);

    await run(h, MON, persist);
    expect(await run(h, MON, persist)).toBe('saved');
    expect(h.day(MON).error).toBeNull();
  });
});

describe('duplicate submissions', () => {
  it('ignores a second save while one is in flight', async () => {
    const h = harness();
    const guard = createSingleFlight();
    const slow = deferred();
    const persist = vi.fn().mockReturnValue(slow.promise);
    h.edit(MON, { closesAt: '20:00' });

    const first = run(h, MON, persist, guard);
    const second = await run(h, MON, persist, guard);
    const otherDay = await run(h, TUE, persist, guard);

    expect(second).toBe('ignored');
    expect(otherDay).toBe('ignored');
    expect(persist).toHaveBeenCalledTimes(1);

    slow.resolve(ROW_MON);
    expect(await first).toBe('saved');
    expect(guard.busy).toBe(false);
  });

  it('marks the saving day while pending', async () => {
    const h = harness();
    const slow = deferred();
    h.edit(MON, { closesAt: '20:00' });

    const pending = run(h, MON, vi.fn().mockReturnValue(slow.promise));
    expect(h.state.savingDay).toBe(MON);

    slow.resolve(ROW_MON);
    await pending;
    expect(h.state.savingDay).toBeNull();
  });
});

describe('OwnerDashboard wiring', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../components/OwnerDashboard.tsx', import.meta.url)),
    'utf8'
  );
  const hours = source.slice(
    source.indexOf('const HoursPanel'),
    source.indexOf('// -- Slots')
  );

  it('no longer reloads the week after a save', () => {
    expect(hours).not.toMatch(/finally\s*\{[^}]*setReloadKey/);
    // the only reload trigger left is Retry after a load error
    expect(hours.match(/setReloadKey\(/g) ?? []).toHaveLength(1);
    expect(hours).toMatch(/onRetry=\{\(\) => setReloadKey/);
  });

  it('keys rows by day only, so saving never remounts them', () => {
    expect(hours).toMatch(/key=\{day\.saved\.dayOfWeek\}/);
    expect(hours).not.toMatch(/key=\{`\$\{day\.dayOfWeek\}/);
  });

  it('shows the message inline, associated with the day, and only on error', () => {
    expect(hours).toMatch(/\{error && \(\s*<p id=\{errorId\} role="alert"/);
    expect(hours).toMatch(/aria-describedby=\{describedBy\}/);
    expect(hours).not.toMatch(/Enter an opening time that is before the closing time/);
  });

  it('leaves Save enabled so an invalid attempt gets feedback, but not while saving', () => {
    expect(hours).toMatch(/disabled=\{busy\}/);
    expect(hours).not.toMatch(/incomplete/);
  });

  it('saves through the single-flight guard and the repository', () => {
    expect(hours).toMatch(/guard: guard\.current/);
    expect(hours).toMatch(/ownerFacilityRepository\.saveOperatingDay\(/);
  });
});
