import { OperatingDay, OperatingWeek, validateOperatingDay } from './ownerFacilityRepository';
import { SingleFlight } from './singleFlight';

/**
 * Draft state for the owner's weekly operating-hours form.
 *
 * Each day keeps two things apart:
 *  - `saved`: what the database holds (the baseline), and
 *  - `draft`: what the owner is typing.
 *
 * A save only ever moves the saved day's baseline. It never rewrites a
 * draft, so edits to other days, and edits to the same day made while
 * its request was in flight, survive the response. Nothing here reloads
 * the week.
 *
 * Pure and framework-free so the rules are testable.
 */

export type SavedDay = OperatingWeek['days'][number];

export interface HoursDraft {
  isClosed: boolean;
  /** "HH:MM", or "" while empty. */
  opensAt: string;
  closesAt: string;
}

export interface DayState {
  saved: SavedDay;
  draft: HoursDraft;
  /** Inline feedback for this day: a validation or save failure. */
  error: string | null;
}

export interface HoursState {
  days: DayState[];
  /** The day whose request is in flight, if any. */
  savingDay: number | null;
}

export function draftFromSaved(day: SavedDay): HoursDraft {
  return {
    isClosed: day.configured ? day.isClosed : false,
    opensAt: day.opensAt ?? '',
    closesAt: day.closesAt ?? ''
  };
}

export function createHoursState(week: OperatingWeek): HoursState {
  return {
    days: week.days.map(saved => ({ saved, draft: draftFromSaved(saved), error: null })),
    savingDay: null
  };
}

/** The message to show for this draft, or null when it can be saved. */
export function draftProblem(dayOfWeek: number, draft: HoursDraft): string | null {
  const checked = validateOperatingDay({
    dayOfWeek,
    isClosed: draft.isClosed,
    opensAt: draft.isClosed ? null : draft.opensAt || null,
    closesAt: draft.isClosed ? null : draft.closesAt || null
  });
  return checked.ok === false ? checked.message : null;
}

/** True when the draft differs from what is saved. */
export function isDirty(day: DayState): boolean {
  const baseline = draftFromSaved(day.saved);
  return (
    day.draft.isClosed !== baseline.isClosed ||
    (!day.draft.isClosed &&
      (day.draft.opensAt !== baseline.opensAt || day.draft.closesAt !== baseline.closesAt))
  );
}

export type HoursAction =
  | { type: 'loaded'; week: OperatingWeek }
  | { type: 'edit'; day: number; patch: Partial<HoursDraft> }
  | { type: 'invalid'; day: number; message: string }
  | { type: 'saveStarted'; day: number }
  | { type: 'saved'; day: number; submitted: HoursDraft; rowId: string | null }
  | { type: 'failed'; day: number; message: string };

const mapDay = (
  state: HoursState,
  dayOfWeek: number,
  change: (day: DayState) => DayState
): HoursState => ({
  ...state,
  days: state.days.map(d => (d.saved.dayOfWeek === dayOfWeek ? change(d) : d))
});

export function hoursReducer(state: HoursState, action: HoursAction): HoursState {
  switch (action.type) {
    case 'loaded':
      return createHoursState(action.week);

    case 'edit':
      // Editing clears that day's old feedback; validation runs again
      // on the next save.
      return mapDay(state, action.day, d => ({
        ...d,
        draft: { ...d.draft, ...action.patch },
        error: null
      }));

    case 'invalid':
      return mapDay(state, action.day, d => ({ ...d, error: action.message }));

    case 'saveStarted':
      return mapDay({ ...state, savingDay: action.day }, action.day, d => ({
        ...d,
        error: null
      }));

    case 'saved': {
      const { submitted } = action;
      // Only the baseline moves, to what was submitted and accepted.
      // The draft is left exactly as the owner has it now.
      return mapDay({ ...state, savingDay: null }, action.day, d => ({
        ...d,
        saved: {
          ...d.saved,
          isClosed: submitted.isClosed,
          opensAt: submitted.isClosed ? null : submitted.opensAt,
          closesAt: submitted.isClosed ? null : submitted.closesAt,
          configured: true,
          rowId: action.rowId ?? d.saved.rowId
        },
        error: null
      }));
    }

    case 'failed':
      return mapDay({ ...state, savingDay: null }, action.day, d => ({
        ...d,
        error: action.message
      }));
  }
}

export type SaveDayOutcome = 'ignored' | 'invalid' | 'saved' | 'failed' | 'stale';

/**
 * One day's save, end to end.
 *
 * `state` is what the owner sees at the click. The request carries a
 * snapshot of that draft; edits made while it is in flight stay drafts.
 * Nothing is sent for an invalid draft (the message is shown inline
 * instead), and a second save is ignored while one is in flight.
 * `isActive` lets the caller drop a response that arrives after the
 * form has moved to another venue.
 */
export async function saveDay(args: {
  state: HoursState;
  dayOfWeek: number;
  guard: SingleFlight;
  dispatch: (action: HoursAction) => void;
  persist: (day: OperatingDay, existingRowId: string | null) => Promise<string | null>;
  describeError: (error: unknown) => string;
  isActive?: () => boolean;
  onStarted?: () => void;
  onSaved?: () => void;
}): Promise<SaveDayOutcome> {
  const { state, dayOfWeek, guard, dispatch } = args;
  const day = state.days.find(d => d.saved.dayOfWeek === dayOfWeek);
  if (!day || guard.busy) return 'ignored';

  const submitted = { ...day.draft };

  const problem = draftProblem(dayOfWeek, submitted);
  if (problem) {
    dispatch({ type: 'invalid', day: dayOfWeek, message: problem });
    return 'invalid';
  }

  const result = await guard.run(async (): Promise<SaveDayOutcome> => {
    dispatch({ type: 'saveStarted', day: dayOfWeek });
    args.onStarted?.();

    try {
      const rowId = await args.persist(
        {
          dayOfWeek,
          isClosed: submitted.isClosed,
          opensAt: submitted.isClosed ? null : submitted.opensAt,
          closesAt: submitted.isClosed ? null : submitted.closesAt
        },
        day.saved.rowId
      );
      if (args.isActive && !args.isActive()) return 'stale';
      dispatch({ type: 'saved', day: dayOfWeek, submitted, rowId });
      args.onSaved?.();
      return 'saved';
    } catch (error) {
      if (args.isActive && !args.isActive()) return 'stale';
      dispatch({ type: 'failed', day: dayOfWeek, message: args.describeError(error) });
      return 'failed';
    }
  });

  return result.started ? result.value : 'ignored';
}
