import { Slot, SlotAvailabilityStatus } from '../types';
import { effectiveStatus } from './bookingRepository';
import type { UserBooking } from './bookingRepository';
import { isLiveOffer } from './waitlistRepository';

/**
 * What the customer slot list knows about availability for the selected
 * facility and date.
 *
 *   idle     no facility is open
 *   loading  the availability read is in flight
 *   ready    byId holds one status per slot returned by the database
 *   error    the read failed; nothing is assumed about any slot
 */
export type AvailabilityView =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; byId: Record<string, SlotAvailabilityStatus> };

export interface SlotAction {
  /** Text on the slot's button. */
  label: string;
  /** True when the button may start a booking. */
  bookable: boolean;
  /** True when the row is drawn in its muted "taken" style. */
  muted: boolean;
}

/**
 * Decide what a slot row shows. Pure, so the rules are testable.
 *
 * Fail closed: a slot is bookable only when the database reported it
 * "available" for this exact facility and date AND checkout is enabled.
 * While the answer is unknown (loading, error, slot missing from the
 * result) nothing is bookable and nothing is guessed.
 */
export function getSlotAction(
  slot: Slot,
  view: AvailabilityView,
  checkoutEnabled: boolean
): SlotAction {
  if (slot.isActive === false) {
    return { label: 'Unavailable', bookable: false, muted: true };
  }

  if (view.phase === 'loading' || view.phase === 'idle') {
    return { label: 'Checking', bookable: false, muted: false };
  }

  if (view.phase === 'error') {
    return { label: 'Unknown', bookable: false, muted: true };
  }

  switch (view.byId[slot.id]) {
    case 'available':
      return checkoutEnabled
        ? { label: 'Book', bookable: true, muted: false }
        : { label: 'Soon', bookable: false, muted: false };
    case 'booked':
      return { label: 'Full', bookable: false, muted: true };
    case 'offer_held':
      return { label: 'Held', bookable: false, muted: true };
    case 'closed':
      return { label: 'Closed', bookable: false, muted: true };
    case 'inactive':
      return { label: 'Unavailable', bookable: false, muted: true };
    default:
      // Not in the database's answer: unknown, so not bookable.
      return { label: 'Unavailable', bookable: false, muted: true };
  }
}


export interface WaitlistAction {
  /** Whether the slot row offers a waitlist control at all. */
  visible: boolean;
  label: string;
  /** True when the control may start a join request. */
  joinable: boolean;
}

/**
 * True when the signed-in user already holds this slot on this date.
 *
 * Mirrors the rule join_waitlist() enforces: a confirmed or completed
 * booking, or an unpaid hold that has not yet lapsed. The hold is
 * judged by `now`, not by its stored status, so a hold that has just
 * expired stops counting without waiting for a reload. This is a
 * display rule only; the database still refuses a join it should.
 *
 * `bookings` are the user's own rows, already filtered by row-level
 * security, so no user id is compared here.
 */
export function holdsSlot(
  bookings: readonly UserBooking[],
  slotId: string,
  bookingDate: string,
  now: Date = new Date()
): boolean {
  return bookings.some(b => {
    if (b.slotId !== slotId || b.bookingDate !== bookingDate) return false;

    const status = effectiveStatus(b, now);
    return (
      status === 'confirmed' ||
      status === 'completed' ||
      status === 'pending_payment'
    );
  });
}

/**
 * Decide the waitlist control for a slot row. Pure, so it is testable.
 *
 * A waitlist is only meaningful for a slot the database reports as
 * taken: "booked" (an unexpired booking or hold) or "offer_held"
 * (another player's live offer). Everything else, including every
 * unknown or failed read, shows no control. A slot the user already
 * holds shows no control either: the server would refuse the join, and
 * the row says so separately. Whether the database will accept a join
 * is decided by join_waitlist(), not here.
 */
export function getWaitlistAction(
  slot: Slot,
  view: AvailabilityView,
  alreadyListed: boolean,
  ownHold: boolean = false
): WaitlistAction {
  const hidden: WaitlistAction = { visible: false, label: '', joinable: false };

  if (slot.isActive === false) return hidden;
  if (view.phase !== 'ready') return hidden;
  if (ownHold) return hidden;

  const status = view.byId[slot.id];
  if (status !== 'booked' && status !== 'offer_held') return hidden;

  return alreadyListed
    ? { visible: true, label: 'On waitlist', joinable: false }
    : { visible: true, label: 'Join waitlist', joinable: true };
}

/**
 * The slot row's control for a LIVE waitlist offer the signed-in user
 * holds.
 *
 * get_slot_availability() deliberately leaves the offer holder's own
 * offer out of its answer, so for the holder the slot reads "available"
 * and the row would say a generic "Book". The holder's own waitlist
 * entry is the only thing that knows better, so it is read here.
 *
 * Pure. Accepting is NOT implemented here: the caller runs the page's
 * existing accept handler (waitlistRepository.acceptOffer ->
 * accept_waitlist_offer), the same one as the "Your Waitlist" Accept
 * button. The database stays the authority and re-checks the offer.
 *
 *   visible   the user has an offer for this slot and date that the
 *             database issued (status "offered") and whose window has
 *             not passed by `now`
 *
 * Fail closed: nothing is shown while the availability is unknown
 * (loading, error, slot missing from the answer), for an inactive or
 * closed slot, or for an entry whose expiry is missing. Waiting,
 * accepted, cancelled and expired entries are never an offer.
 */
export interface OfferAction<E> {
  visible: boolean;
  entry: E | null;
  label: string;
  /** Accessible name without the clock time (the caller adds it). */
  ariaLabel: string;
  /** When the offer lapses (ISO), for display. */
  expiresAt: string | null;
}

export function getOfferAction<
  E extends {
    id: string;
    slotId: string;
    bookingDate: string;
    status: Parameters<typeof isLiveOffer>[0]['status'];
    offerExpiresAt: string | null;
  }
>(
  slot: Pick<Slot, 'id' | 'time' | 'isActive'>,
  view: AvailabilityView,
  entries: readonly E[],
  bookingDate: string,
  now: Date = new Date()
): OfferAction<E> {
  const hidden: OfferAction<E> = {
    visible: false,
    entry: null,
    label: '',
    ariaLabel: '',
    expiresAt: null
  };

  if (slot.isActive === false) return hidden;
  if (view.phase !== 'ready') return hidden;

  // A stale "booked" snapshot is fine (the entry is newer than it), but
  // a slot the database reports closed, inactive or not at all cannot
  // be taken.
  const status = view.byId[slot.id];
  if (status === undefined || status === 'closed' || status === 'inactive') return hidden;

  const entry =
    entries.find(
      e =>
        e.slotId === slot.id &&
        e.bookingDate === bookingDate &&
        e.offerExpiresAt !== null &&
        isLiveOffer(e, now)
    ) ?? null;

  if (!entry) return hidden;

  return {
    visible: true,
    entry,
    label: 'Accept offer',
    ariaLabel: `${slot.time}: accept your waitlist offer`,
    expiresAt: entry.offerExpiresAt
  };
}

/**
 * Whether the row should say the slot is the user's own reservation.
 *
 * Only when the database also reports the slot as taken: if the
 * snapshot says "available" (for example a hold that has just lapsed),
 * claiming a reservation would be wrong.
 */
export function showsOwnHold(
  slot: Slot,
  view: AvailabilityView,
  ownHold: boolean
): boolean {
  if (!ownHold) return false;
  if (slot.isActive === false) return false;
  if (view.phase !== 'ready') return false;

  const status = view.byId[slot.id];
  return status === 'booked' || status === 'offer_held';
}

/**
 * The control that lets the user leave the waitlist from the slot row
 * itself, so it is reachable while the facility modal covers the
 * "Your waitlist" list.
 *
 * It is not a second implementation of leaving: it only decides
 * whether and how the row shows the control. The action is the page's
 * existing leave handler (waitlistRepository.leaveWaitlist under the
 * waitlist single-flight guard).
 *
 *   visible   the user has a live entry (waiting or offered) for this
 *             slot on this date
 *   disabled  any waitlist action is in flight (one at a time)
 *   busy      THIS entry's leave is the request in flight
 *
 * `pendingTarget` is the in-flight waitlist target ("leave:<entry id>",
 * "join:<slot id>", ...) or null when nothing is running.
 */
export interface LeaveControl<E> {
  visible: boolean;
  entry: E | null;
  label: string;
  ariaLabel: string;
  disabled: boolean;
  busy: boolean;
}

export function getLeaveControl<
  E extends { id: string; slotId: string; bookingDate: string }
>(
  slot: Pick<Slot, 'id' | 'time'>,
  activeEntries: readonly E[],
  bookingDate: string,
  pendingTarget: string | null
): LeaveControl<E> {
  const entry =
    activeEntries.find(e => e.slotId === slot.id && e.bookingDate === bookingDate) ?? null;

  if (!entry) {
    return {
      visible: false,
      entry: null,
      label: '',
      ariaLabel: '',
      disabled: true,
      busy: false
    };
  }

  const busy = pendingTarget === `leave:${entry.id}`;

  return {
    visible: true,
    entry,
    label: busy ? 'Leaving…' : 'Leave waitlist',
    ariaLabel: `Leave the waitlist for ${slot.time}`,
    disabled: pendingTarget !== null,
    busy
  };
}
