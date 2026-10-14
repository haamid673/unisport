import { describe, it, expect } from 'vitest';
import { clearFinishedFlow, createActionSequence } from '../actionNotice';

type BookingFlow =
  | { phase: 'idle' }
  | { phase: 'submitting'; slotId: string }
  | { phase: 'success'; facilityName: string }
  | { phase: 'error'; message: string };

type WaitlistFlow =
  | { phase: 'idle' }
  | { phase: 'submitting'; target: string }
  | { phase: 'success'; message: string }
  | { phase: 'error'; message: string };

const IDLE = { phase: 'idle' } as const;

describe('clearFinishedFlow', () => {
  it('clears a finished error so it cannot sit beside a later success', () => {
    const stale: BookingFlow = { phase: 'error', message: 'That slot was just taken.' };

    expect(clearFinishedFlow<BookingFlow>(stale, IDLE)).toEqual({ phase: 'idle' });
  });

  it('clears a finished success', () => {
    const done: WaitlistFlow = { phase: 'success', message: "You're on the waitlist." };

    expect(clearFinishedFlow<WaitlistFlow>(done, IDLE)).toEqual({ phase: 'idle' });
  });

  it('never touches a request that is still in flight', () => {
    const inFlight: BookingFlow = { phase: 'submitting', slotId: 's1' };

    expect(clearFinishedFlow<BookingFlow>(inFlight, IDLE)).toBe(inFlight);
  });

  it('leaves an idle flow idle', () => {
    expect(clearFinishedFlow<WaitlistFlow>(IDLE, IDLE)).toEqual({ phase: 'idle' });
  });

  it('models the reported scenario: booking error, then a waitlist success', () => {
    // 1. a reservation fails
    let booking: BookingFlow = { phase: 'error', message: 'That slot was just taken.' };
    let waitlist: WaitlistFlow = { phase: 'idle' };

    // 2. the user starts a waitlist action: the old booking notice is obsolete
    booking = clearFinishedFlow<BookingFlow>(booking, IDLE);
    waitlist = { phase: 'submitting', target: 'join:s1' };
    waitlist = { phase: 'success', message: "You're on the waitlist." };

    const visible = [booking, waitlist].filter(
      f => f.phase === 'success' || f.phase === 'error'
    );

    expect(visible).toHaveLength(1);
    expect(visible[0].phase).toBe('success');
  });

  it('models the reverse: waitlist error, then a reservation', () => {
    let booking: BookingFlow = { phase: 'idle' };
    let waitlist: WaitlistFlow = { phase: 'error', message: 'You already hold a booking.' };

    waitlist = clearFinishedFlow<WaitlistFlow>(waitlist, IDLE);
    booking = { phase: 'submitting', slotId: 's2' };
    booking = { phase: 'success', facilityName: 'Arena' };

    const visible = [booking, waitlist].filter(
      f => f.phase === 'success' || f.phase === 'error'
    );

    expect(visible).toHaveLength(1);
    expect(visible[0].phase).toBe('success');
  });
});

describe('createActionSequence (owner portal: latest action wins)', () => {
  type Notice = { type: 'success' | 'error'; text: string } | null;

  // The portal keeps a result notice (set when an action FINISHES) and the
  // form keeps its own error. Both are visible at once, which is how a
  // stale success used to sit beside a new failure.
  const makePortal = () => {
    const seq = createActionSequence();
    const state = { portal: null as Notice, formError: null as string | null };

    const visible = () =>
      [
        state.portal ? state.portal.type : null,
        state.formError ? 'error' : null
      ].filter(Boolean);

    const run = async (request: Promise<void>, successText: string) => {
      const token = seq.begin();
      state.portal = null;       // the previous finished notice is obsolete
      state.formError = null;

      try {
        await request;
        if (seq.isCurrent(token)) state.portal = { type: 'success', text: successText };
      } catch (err) {
        state.formError = (err as Error).message;
      }
    };

    return { seq, state, visible, run };
  };

  it('hands out increasing tokens and only the newest is current', () => {
    const seq = createActionSequence();
    const first = seq.begin();
    expect(seq.isCurrent(first)).toBe(true);

    const second = seq.begin();
    expect(second).toBeGreaterThan(first);
    expect(seq.isCurrent(first)).toBe(false);
    expect(seq.isCurrent(second)).toBe(true);
  });

  it('a new action clears an old completed success notice', async () => {
    const portal = makePortal();

    await portal.run(Promise.resolve(), 'Venue details saved.');
    expect(portal.state.portal).toEqual({ type: 'success', text: 'Venue details saved.' });

    // the next action starts: the old notice must go immediately
    const pending = new Promise<void>(() => {});
    void portal.run(pending, 'Venue details saved.');
    expect(portal.state.portal).toBeNull();
  });

  it('a failure is shown alone, never beside the previous success', async () => {
    const portal = makePortal();

    await portal.run(Promise.resolve(), 'Venue details saved.');
    expect(portal.visible()).toEqual(['success']);

    await portal.run(Promise.reject(new Error('Could not reach the service.')), 'Venue details saved.');
    expect(portal.visible()).toEqual(['error']);
    expect(portal.state.portal).toBeNull();
    expect(portal.state.formError).toBe('Could not reach the service.');
  });

  it('shows the latest success after an earlier failure', async () => {
    const portal = makePortal();

    await portal.run(Promise.reject(new Error('boom')), 'saved');
    expect(portal.visible()).toEqual(['error']);

    await portal.run(Promise.resolve(), 'saved');
    expect(portal.visible()).toEqual(['success']);
  });

  it('an older slow request cannot overwrite the notice of a newer action', async () => {
    const portal = makePortal();

    let finishSlow!: () => void;
    const slow = new Promise<void>(resolve => {
      finishSlow = resolve;
    });

    const first = portal.run(slow, 'first result');
    const second = portal.run(Promise.resolve(), 'second result');
    await second;
    expect(portal.state.portal).toEqual({ type: 'success', text: 'second result' });

    finishSlow();
    await first;
    // the late answer of the first request is not published
    expect(portal.state.portal).toEqual({ type: 'success', text: 'second result' });
  });

  it('does not touch a request that is still in flight (it has no notice yet)', () => {
    const portal = makePortal();
    const never = new Promise<void>(() => {});
    void portal.run(never, 'saved');

    // nothing finished, so nothing is shown and nothing was cleared wrongly;
    // the token of the running action is still the current one
    expect(portal.visible()).toEqual([]);
    expect(portal.seq.isCurrent(1)).toBe(true);
  });
});
