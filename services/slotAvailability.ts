import { Slot, SlotAvailabilityStatus } from '../types';

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
