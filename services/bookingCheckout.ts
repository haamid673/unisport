/**
 * Checkout flow for ONE existing booking (an unpaid hold), Razorpay TEST
 * mode. Framework-free so it can be tested without a browser.
 *
 *   pay()          check the booking's payments first, then create (or
 *                  re-use) the server order, open Checkout and verify the
 *                  payment id Checkout hands back
 *   checkStatus()  booking-based recovery: ask the server about every
 *                  payment of this booking's own orders. Never creates an
 *                  order. Works without knowing any payment id (after a
 *                  reload, in another tab, after an ambiguous check).
 *
 * Guarantees:
 *
 *  - Never creates a booking. It only pays for the booking it was given.
 *  - Success is reported ONLY from a server answer whose result is
 *    "confirmed". Checkout's own callback, a confirmed booking, or a
 *    captured payment are never treated as success.
 *  - Before any new payment the server is asked about the booking's
 *    payments (recovery). A new payment is started only when that check
 *    was COMPLETE, found NO payment AND reported that no other session
 *    holds the booking's Checkout lease (none / yours). Any payment blocks
 *    it, a failed one included: the provider can still authorize or
 *    capture a payment it reported as failed, and nothing in this system
 *    can rule that out yet. An incomplete check, a lease held by another
 *    session or an ended lease, or any error blocks it too. The lease
 *    says nothing about whether a payment exists; it only says the server
 *    will refuse a new Checkout.
 *  - A create-order refusal (checkout_in_progress, payment_may_exist) is
 *    remembered for the booking in page memory and overrides later
 *    recovery answers: it keeps the unresolved record and never offers a
 *    payment again in this page. After a reload the server's lease state
 *    (reported by recovery) takes over.
 *  - The server enforces the same rule: it hands the order out only under
 *    a Checkout lease held by this page's checkout session (one random id
 *    per booking per page, re-sent on retries), refuses another session
 *    while the lease lasts (the rest of the hold), and lets the holder in
 *    again only when the provider lists no payment on the order. So two
 *    tabs, devices or page loads never open Checkout on the same order.
 *  - Within this page, a shared per-booking "unresolved" record is set
 *    as soon as Checkout opens. While it exists no panel offers or
 *    starts a payment for that booking; they offer "Check payment
 *    status" instead. It is cleared only by an authoritative answer: a
 *    confirmed fulfilment, or a complete recovery that found no live
 *    payment. Dismissal, timeouts, errors and exhausted retries never
 *    clear it. It is page memory: NOT durable and NOT a cross-tab
 *    boundary (the recovery check above is).
 *  - One request flow per booking at a time in this page.
 *  - Retries are bounded: transient failures are retried automatically a
 *    few times with a delay, then only by the user, a limited number of
 *    times. Every request has a timeout (paymentClient), and a timeout is
 *    never read as "nothing happened".
 *  - Checkout opens only with a timeout that ends before the hold: the
 *    server-reported hold minus the time spent since the order arrived,
 *    minus a margin. checkout.js is loaded (bounded) before the order is
 *    requested. A Checkout that never reports back is closed by a
 *    watchdog and treated as "closed", never as a failure; a success
 *    callback arriving after that is still checked with the server.
 *  - Every authoritative answer is announced (onBookingPaymentChange),
 *    so the bookings list can refresh even if the panel was unmounted.
 */

import type {
  ApiFailure,
  AttemptLeaseFacts,
  CheckoutLease,
  CheckoutOrder,
  OtherPayment,
  PaymentClient,
  ProviderRefund,
  RecoveryOutcome,
  VerifyOutcome,
  VerifyResult
} from './paymentClient';
import { isPaymentElsewhere, isRetryable } from './paymentClient';
import type { CheckoutDetails, CheckoutEnd, PaymentsConfig, RazorpayConstructor } from './razorpayCheckout';
import { checkoutTimeoutSeconds } from './razorpayCheckout';

export const AUTO_RETRY_ATTEMPTS = 3;
export const MAX_MANUAL_CHECKS = 5;
const DEFAULT_RETRY_MS = [1000, 3000];
const MAX_RETRY_MS = 10_000;

/** What the server said, from either verification mode. */
export interface Outcome {
  source: 'payment' | 'booking';
  result: VerifyResult | 'no_payment_found';
  /** Booking source only: every payment record was inspected and reported. */
  complete: boolean;
  bookingStatus: string | null;
  paymentId: string | null;
  paymentStatus: string | null;
  providerRefund: ProviderRefund | null;
  /** Booking source only: other payments found on the booking's orders. */
  otherPayments: OtherPayment[];
  /** Booking source only: whose Checkout lease the booking has (null: not reported). */
  checkoutLease: CheckoutLease | null;
}

type OrderFailure =
  | ApiFailure
  | { kind: 'config' }
  | { kind: 'checkout_unavailable' }
  | { kind: 'hold_too_short' }
  | { kind: 'hold_unknown' };

export type CheckoutState =
  | { phase: 'idle' }
  | { phase: 'unavailable'; reason: string }
  | { phase: 'unresolved'; paymentId: string | null }
  | { phase: 'checking' }
  | { phase: 'creating_order' }
  | { phase: 'checkout_open' }
  | { phase: 'verifying'; paymentId: string }
  | { phase: 'outcome'; outcome: Outcome }
  | { phase: 'dismissed'; watchdog: boolean }
  | { phase: 'order_error'; failure: OrderFailure }
  | { phase: 'check_error'; failure: ApiFailure; retryable: boolean; paymentId: string | null };

export interface CheckoutDeps {
  client: PaymentClient;
  config: PaymentsConfig;
  loadCheckout(): Promise<RazorpayConstructor>;
  openCheckout(Razorpay: RazorpayConstructor, order: CheckoutOrder, details: CheckoutDetails): Promise<CheckoutEnd>;
  sleep(ms: number): Promise<void>;
  description?: string;
  /** Milliseconds, monotonic where available (default: performance.now / Date.now). */
  now?: () => number;
  /** A new random checkout session id (default: crypto.randomUUID). */
  newSessionId?: () => string;
}

export interface BookingCheckout {
  state(): CheckoutState;
  pay(): Promise<void>;
  checkStatus(): Promise<void>;
  canPay(): boolean;
  canCheckStatus(): boolean;
  checksLeft(): number;
}

// ------------------------------------------------------------------
// Shared page-level records (per booking)
// ------------------------------------------------------------------

interface Unresolved {
  paymentId: string | null;
}

const activeFlows = new Set<string>();
const unresolved = new Map<string, Unresolved>();
const listeners = new Set<(bookingId: string) => void>();
// This page's checkout session per booking (re-sent on every order
// request so the server recognises a retry of the same flow). Page
// memory only: a reload is a different session.
const sessions = new Map<string, string>();
// Bookings for which the server refused a new Checkout (another session
// holds the order, or a payment may exist). Page memory; it overrides
// recovery answers that would otherwise offer a payment.
const refused = new Set<string>();
// Bumped each time Checkout opens for a booking, so a callback from an
// older Checkout can be told apart from the current one.
const checkoutEpochs = new Map<string, number>();

/**
 * Called whenever the payment situation of a booking changes in this
 * page: an authoritative server answer arrived, or an unresolved record
 * was set or cleared. Returns an unsubscribe function.
 */
export function onBookingPaymentChange(listener: (bookingId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function announce(bookingId: string) {
  for (const l of [...listeners]) l(bookingId);
}

export function hasUnresolvedPayment(bookingId: string): boolean {
  return unresolved.has(bookingId);
}

function markUnresolved(bookingId: string, paymentId: string | null) {
  const prev = unresolved.get(bookingId);
  unresolved.set(bookingId, { paymentId: paymentId ?? prev?.paymentId ?? null });
  announce(bookingId);
}

function clearUnresolved(bookingId: string) {
  if (unresolved.delete(bookingId)) announce(bookingId);
}

/** Test hook. */
export function resetCheckoutRecordsForTests(): void {
  activeFlows.clear();
  unresolved.clear();
  listeners.clear();
  sessions.clear();
  checkoutEpochs.clear();
  refused.clear();
}

const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const defaultSessionId = (): string => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // randomUUID needs a secure context; getRandomValues does not
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/**
 * Whether the server will certainly refuse a new Checkout from THIS page
 * (a display hint; the server still decides). payment_acquire_checkout_lease
 * grants an open attempt only when no lease was ever set on it, or resumes
 * the lease of the SAME checkout session. A page that holds no session for
 * the booking (e.g. after a reload) gets a fresh random one, which can never
 * match a stored lease, so any open attempt whose lease was set means a
 * refusal ("held" or "ended"). Once this page has a session, only the server
 * can tell; then nothing is hidden. Unknown facts hide nothing.
 */
export function newCheckoutCertainlyRefused(
  bookingId: string,
  openAttempts: readonly AttemptLeaseFacts[] | undefined,
): boolean {
  if (!openAttempts || sessions.has(bookingId)) return false;
  return openAttempts.some(a => a.checkoutLeaseUntil !== null);
}

function sessionFor(bookingId: string, deps: CheckoutDeps): string {
  let id = sessions.get(bookingId);
  if (!id) {
    id = (deps.newSessionId ?? defaultSessionId)().toLowerCase();
    sessions.set(bookingId, id);
  }
  return id;
}

function fromPayment(o: VerifyOutcome, paymentId: string): Outcome {
  return {
    source: 'payment',
    result: o.result,
    complete: true,
    bookingStatus: o.bookingStatus,
    paymentId,
    paymentStatus: o.paymentStatus,
    providerRefund: o.providerRefund,
    otherPayments: [],
    checkoutLease: null,
  };
}

function fromBooking(o: RecoveryOutcome): Outcome {
  return {
    source: 'booking',
    result: o.result,
    complete: o.complete,
    bookingStatus: o.bookingStatus,
    paymentId: o.paymentId,
    paymentStatus: o.paymentStatus,
    providerRefund: o.providerRefund,
    otherPayments: o.otherPayments,
    checkoutLease: o.checkoutLease,
  };
}

/**
 * A complete booking-level answer that found no payment at all and no
 * Checkout lease held by anyone else (none, or this page's own). A failed
 * payment does not qualify: the provider can still authorize or capture
 * it. A lease held by another session, or an ended one, does not either:
 * the lease is no evidence about payments. This says nothing about
 * whether the booking can still be paid; see clearsTheWay.
 */
function nothingLive(o: Outcome): boolean {
  return o.source === 'booking' && o.complete && o.result === 'no_payment_found' &&
    (o.checkoutLease === 'none' || o.checkoutLease === 'yours');
}

/**
 * Whether a new payment may be offered: nothing is live AND the server
 * itself reports the booking as still waiting for payment. The status is
 * the server's (it comes from the booking row); a missing or any other
 * status (confirmed, expired, cancelled, unknown) fails closed. Absence of
 * payments never implies payability. A hold that ran out but was not yet
 * swept still reads "pending_payment" here; create-order refuses it with
 * a final booking_not_payable (the recovery answer carries no hold clock).
 */
function clearsTheWay(o: Outcome): boolean {
  return nothingLive(o) && o.bookingStatus === 'pending_payment';
}

/** Order refusals after which paying again cannot help. */
function orderFailureIsFinal(f: OrderFailure): boolean {
  if (f.kind === 'config' || f.kind === 'hold_too_short' || f.kind === 'hold_unknown') return true;
  if (f.kind === 'checkout_unavailable' || f.kind === 'network' || f.kind === 'malformed') return false;
  return !isRetryable(f);
}

type Attempt<T> = { ok: true; value: T } | { ok: false; failure: ApiFailure };

async function withRetries<T>(deps: CheckoutDeps, call: () => Promise<Attempt<T>>): Promise<Attempt<T>> {
  let last: ApiFailure = { kind: 'network' };
  for (let attempt = 1; attempt <= AUTO_RETRY_ATTEMPTS; attempt++) {
    const r = await call();
    if ('value' in r) return r;
    last = r.failure;
    if (!isRetryable(last) || attempt === AUTO_RETRY_ATTEMPTS) break;
    const hinted = last.kind === 'http' && last.retryAfterSeconds !== null ? last.retryAfterSeconds * 1000 : null;
    await deps.sleep(Math.min(hinted ?? DEFAULT_RETRY_MS[Math.min(attempt - 1, DEFAULT_RETRY_MS.length - 1)], MAX_RETRY_MS));
  }
  return { ok: false, failure: last };
}

export function createBookingCheckout(
  bookingId: string,
  deps: CheckoutDeps,
  onChange: (state: CheckoutState) => void = () => {},
): BookingCheckout {
  const initial = (): CheckoutState => {
    if ('reason' in deps.config) return { phase: 'unavailable', reason: deps.config.reason };
    const record = unresolved.get(bookingId);
    return record ? { phase: 'unresolved', paymentId: record.paymentId } : { phase: 'idle' };
  };

  let state: CheckoutState = initial();
  let manualChecks = MAX_MANUAL_CHECKS;
  const now = deps.now ?? defaultNow;

  const set = (next: CheckoutState) => {
    state = next;
    onChange(state);
  };

  const exclusive = async (work: () => Promise<void>) => {
    if (activeFlows.has(bookingId)) return;
    activeFlows.add(bookingId);
    try {
      await work();
    } finally {
      activeFlows.delete(bookingId);
      // The last state was rendered while this flow still held the lock,
      // so its actions were hidden; render once more now it is released.
      set({ ...state });
    }
  };

  // Record an authoritative answer and what it means for the record.
  const settle = (answer: Outcome) => {
    // The server's own refusal is newer evidence than a recovery answer
    // that still shows our lease as available: never offer a payment it
    // has refused.
    const outcome: Outcome =
      refused.has(bookingId) && answer.source === 'booking' &&
      (answer.checkoutLease === 'none' || answer.checkoutLease === 'yours')
        ? { ...answer, checkoutLease: 'other' }
        : answer;
    if (outcome.result === 'confirmed') {
      refused.delete(bookingId);
      clearUnresolved(bookingId);
    } else if (nothingLive(outcome)) clearUnresolved(bookingId);
    else markUnresolved(bookingId, outcome.paymentId);
    set({ phase: 'outcome', outcome });
    announce(bookingId);
  };

  /** Booking-based recovery. Returns the outcome, or null after an error state was set. */
  const recoverOnce = async (): Promise<Outcome | null> => {
    set({ phase: 'checking' });
    const r = await withRetries(deps, () => deps.client.recover(bookingId, sessionFor(bookingId, deps)));
    if ('failure' in r) {
      set({
        phase: 'check_error',
        failure: r.failure,
        retryable: isRetryable(r.failure),
        paymentId: unresolved.get(bookingId)?.paymentId ?? null,
      });
      return null;
    }
    const outcome = fromBooking(r.value);
    settle(outcome);
    return outcome;
  };

  const verifyPayment = async (paymentId: string) => {
    set({ phase: 'verifying', paymentId });
    const r = await withRetries(deps, () => deps.client.verify(bookingId, paymentId));
    if ('failure' in r) {
      // Ambiguous: stays unresolved; the customer can run a booking check.
      set({ phase: 'check_error', failure: r.failure, retryable: isRetryable(r.failure), paymentId });
      return;
    }
    settle(fromPayment(r.value, paymentId));
  };

  // A success callback from a Checkout that already ended (watchdog).
  // It only ever ADDS information: the payment id joins the unresolved
  // record; it is verified only while this Checkout is still the latest
  // one for the booking and no other flow is running, so it can never
  // overwrite a newer flow's state.
  const lateSuccess = (paymentId: string, epoch: number) => {
    markUnresolved(bookingId, paymentId);
    if (checkoutEpochs.get(bookingId) !== epoch || activeFlows.has(bookingId)) return;
    void exclusive(async () => {
      if (checkoutEpochs.get(bookingId) !== epoch) return;
      await verifyPayment(paymentId);
    });
  };

  // The state alone (ignoring a running flow) allows starting a payment.
  const payAllowed = (): boolean => {
    if (!deps.config.ok || unresolved.has(bookingId)) return false;
    switch (state.phase) {
      case 'idle':
        return true;
      case 'order_error':
        // a definite refusal (e.g. the hold expired) is final
        return !orderFailureIsFinal(state.failure);
      case 'outcome':
        // only after a complete booking check found nothing live
        return clearsTheWay(state.outcome);
      default:
        return false;
    }
  };

  const checkAllowed = (): boolean => {
    if (!deps.config.ok || manualChecks <= 0) return false;
    switch (state.phase) {
      // idle: e.g. a fresh page after a reload, where a payment may have
      // been started in the page that was lost; a booking check is the
      // same read-only recovery that Pay runs first anyway
      case 'idle':
      case 'unresolved':
      case 'dismissed':
        return true;
      case 'check_error':
        // a definite answer (e.g. a payment that is not this booking's)
        // is final for that payment; the booking itself can be checked
        return true;
      case 'order_error':
        // the server says a payment may be under way elsewhere
        return state.failure.kind === 'http' && isPaymentElsewhere(state.failure);
      case 'outcome':
        // a confirmed answer that could not rule out additional payments
        // can be re-checked; any other confirmed answer is final
        return (state.outcome.result !== 'confirmed' || !state.outcome.complete) &&
          !nothingLive(state.outcome);
      default:
        return false;
    }
  };

  return {
    state: () => state,
    canPay: () => !activeFlows.has(bookingId) && payAllowed(),
    canCheckStatus: () => !activeFlows.has(bookingId) && checkAllowed(),
    checksLeft: () => manualChecks,

    pay: () =>
      exclusive(async () => {
        if (!payAllowed() || !deps.config.ok) return;

        // 1. Server-side truth first: is there already a payment for this
        //    booking? (No provider call when no order was ever created.)
        const before = await recoverOnce();
        if (!before || !clearsTheWay(before)) return; // found something, or could not tell

        // 2. Load checkout.js first (bounded), so no time passes between
        //    receiving the order and opening Checkout.
        set({ phase: 'creating_order' });
        let Razorpay: RazorpayConstructor;
        try {
          Razorpay = await deps.loadCheckout();
        } catch {
          set({ phase: 'order_error', failure: { kind: 'checkout_unavailable' } });
          return;
        }

        // 3. Create or re-use the server order, under this page's lease.
        const created = await deps.client.createOrder(bookingId, sessionFor(bookingId, deps));
        const receivedAt = now();
        if ('failure' in created) {
          // Another tab, device or earlier page load may be paying.
          if (isPaymentElsewhere(created.failure)) {
            refused.add(bookingId);
            markUnresolved(bookingId, null);
          }
          set({ phase: 'order_error', failure: created.failure });
          return;
        }
        const order = created.value;
        if (!('keyId' in deps.config) || order.keyId !== deps.config.keyId) {
          set({ phase: 'order_error', failure: { kind: 'config' } });
          return;
        }
        if (order.holdSecondsRemaining === null) {
          // fail closed: never open Checkout without knowing it ends in time
          set({ phase: 'order_error', failure: { kind: 'hold_unknown' } });
          return;
        }
        const elapsed = Math.ceil(Math.max(0, now() - receivedAt) / 1000);
        const timeoutSeconds = checkoutTimeoutSeconds(order.holdSecondsRemaining - elapsed);
        if (timeoutSeconds === null) {
          set({ phase: 'order_error', failure: { kind: 'hold_too_short' } });
          return;
        }

        // 4. From here a payment may exist: unresolved until proven otherwise.
        markUnresolved(bookingId, null);
        const epoch = (checkoutEpochs.get(bookingId) ?? 0) + 1;
        checkoutEpochs.set(bookingId, epoch);
        set({ phase: 'checkout_open' });
        const end = await deps.openCheckout(Razorpay, order, {
          description: deps.description ?? 'Court booking',
          timeoutSeconds,
          onLateSuccess: paymentId => lateSuccess(paymentId, epoch),
        });

        if (end.kind === 'completed') {
          markUnresolved(bookingId, end.paymentId);
          await verifyPayment(end.paymentId);
        } else if (end.lastFailedPaymentId) {
          // Closed after a failed attempt: ask about that payment.
          markUnresolved(bookingId, end.lastFailedPaymentId);
          await verifyPayment(end.lastFailedPaymentId);
        } else {
          set({ phase: 'dismissed', watchdog: end.watchdog === true });
        }
      }),

    checkStatus: () =>
      exclusive(async () => {
        if (!checkAllowed()) return;
        manualChecks -= 1;
        await recoverOnce();
      }),
  };
}

// ------------------------------------------------------------------
// What to tell the customer (pure; rendered by BookingPaymentPanel)
// ------------------------------------------------------------------

export type Tone = 'neutral' | 'success' | 'warning' | 'error';

export interface CheckoutMessage {
  tone: Tone;
  title: string;
  lines: string[];
}

function orderErrorMessage(failure: OrderFailure): CheckoutMessage {
  if (failure.kind === 'config') {
    return { tone: 'error', title: 'Payment unavailable', lines: ['The payment configuration does not match. No payment was started.'] };
  }
  if (failure.kind === 'checkout_unavailable') {
    return { tone: 'error', title: 'Checkout could not be loaded', lines: ['No payment was started. Check your connection and try again.'] };
  }
  if (failure.kind === 'hold_too_short') {
    return { tone: 'error', title: 'This booking cannot be paid', lines: ['Too little time is left on this hold to complete a payment.'] };
  }
  if (failure.kind === 'hold_unknown') {
    return {
      tone: 'error',
      title: 'Payment could not be started',
      lines: ['The time left on this hold could not be confirmed, so the payment window was not opened. No payment was started.'],
    };
  }
  if (failure.kind === 'network' || failure.kind === 'malformed') {
    return { tone: 'error', title: 'Could not start the payment', lines: ['No payment was started. Try again.'] };
  }
  if (failure.status === 401) {
    return { tone: 'error', title: 'Please sign in again', lines: ['Your session has expired. No payment was started.'] };
  }
  if (failure.error === 'checkout_in_progress') {
    return {
      tone: 'warning',
      title: 'A payment is already in progress',
      lines: [
        'A payment for this booking was started in another window, on another device, or before this page was reloaded.',
        'To avoid paying twice, a new payment cannot be started for this hold. Check the payment status instead.',
      ],
    };
  }
  if (failure.error === 'payment_may_exist') {
    return {
      tone: 'warning',
      title: 'A payment may already exist',
      lines: [
        'The payment provider has a payment attempt for this booking, or an earlier payment window has ended.',
        'To avoid paying twice, a new payment cannot be started for this hold. Check the payment status instead.',
      ],
    };
  }
  if (failure.error === 'order_creation_in_progress') {
    return { tone: 'neutral', title: 'Payment is being prepared', lines: ['Try again in a moment.'] };
  }
  if (failure.error === 'booking_not_payable') {
    const why: Record<string, string> = {
      hold_expired: 'The hold on this slot has expired.',
      hold_too_short: 'Too little time is left on this hold to complete a payment.',
      booking_not_pending: 'This booking is no longer waiting for payment.',
      attempt_closed: 'This payment can no longer be completed.',
      free_booking: 'This booking does not need a payment.',
    };
    return { tone: 'error', title: 'This booking cannot be paid', lines: [why[failure.reason ?? ''] ?? 'This booking cannot be paid now.'] };
  }
  if (failure.error === 'booking_not_found') {
    return { tone: 'error', title: 'Booking not found', lines: ['No payment was started.'] };
  }
  if (failure.status === 503 || failure.status === 429) {
    return { tone: 'error', title: 'Payment is temporarily unavailable', lines: ['No payment was started. Try again in a moment.'] };
  }
  return { tone: 'error', title: 'Could not start the payment', lines: ['No payment was started.'] };
}

const UNRESOLVED_LINE = 'Do not pay again until the payment status has been checked.';
const PARTIAL_LINE = 'Not every payment record could be checked, so additional payments cannot be ruled out. Check again later.';

/** What we recorded about an additional payment (our decision, never a refund). */
const DECISION_NOTE: Record<string, string> = {
  duplicate_capture: ' It was recorded as a duplicate of the payment that confirmed the booking.',
  late_capture: ' It was recorded as arriving after the booking could no longer be confirmed.',
  refunded_before_settlement: ' It was recorded as already refunded by the provider before it could be applied.',
  refund_obligation: ' It was recorded against an existing refund request.',
};

function otherPaymentLines(others: readonly OtherPayment[]): string[] {
  return others.map(p => {
    if (p.result === 'payment_pending') {
      return `Another payment (${p.paymentId}) on this booking is still pending at the provider. Check again shortly; do not pay again.`;
    }
    if (p.result === 'payment_failed') {
      return `Another payment (${p.paymentId}) on this booking was reported as failed. A failed payment is not always final.`;
    }
    const refund =
      p.providerRefund === 'full'
        ? ' The provider reports it fully refunded; that does not confirm the money has reached your account.'
        : p.providerRefund === 'partial'
          ? ' The provider reports part of it refunded; the rest is not being refunded automatically yet.'
          : ' Refunds are not yet handled automatically.';
    return `Another payment (${p.paymentId}) on this booking was also received by the provider but did not confirm it.${
      p.decision ? (DECISION_NOTE[p.decision] ?? '') : ''
    }${refund} Contact support.`;
  });
}

const hasStrandedMoney = (others: readonly OtherPayment[]) => others.some(p => p.result === 'not_fulfilled');

/**
 * The customer-facing message for a state. Only result === "confirmed"
 * produces a "Booking confirmed" title.
 */
export function describeCheckout(state: CheckoutState): CheckoutMessage | null {
  switch (state.phase) {
    case 'idle':
      return null;
    case 'unavailable':
      return { tone: 'neutral', title: 'Online payment unavailable', lines: [state.reason] };
    case 'unresolved':
      return {
        tone: 'warning',
        title: 'A payment for this booking may be in progress',
        lines: ['Check the payment status before paying again.'],
      };
    case 'checking':
      return { tone: 'neutral', title: 'Checking payments for this booking…', lines: [] };
    case 'creating_order':
      return { tone: 'neutral', title: 'Preparing payment…', lines: [] };
    case 'checkout_open':
      return { tone: 'neutral', title: 'Complete the payment in the Razorpay window (test mode)', lines: [] };
    case 'verifying':
      return { tone: 'neutral', title: 'Checking your payment…', lines: ['Do not pay again while we check.'] };
    case 'dismissed':
      return {
        tone: 'warning',
        title: state.watchdog ? 'The payment window did not respond' : 'Payment window closed',
        lines: [
          state.watchdog
            ? 'It was closed. No payment confirmation was received. That does not mean no payment was made.'
            : 'No payment confirmation was received. That does not mean no payment was made.',
          'Check the payment status before paying again.',
        ],
      };
    case 'order_error':
      return orderErrorMessage(state.failure);
    case 'check_error': {
      const f = state.failure;
      if (state.retryable || f.kind === 'malformed') {
        return {
          tone: 'warning',
          title: 'We could not check the payment yet',
          lines: ['A payment may still be applied. Check again in a moment.', UNRESOLVED_LINE],
        };
      }
      if (f.kind === 'http' && f.status === 401) {
        return { tone: 'warning', title: 'Please sign in again to check the payment', lines: [UNRESOLVED_LINE] };
      }
      if (f.kind === 'http' && f.error === 'payment_not_for_booking') {
        return { tone: 'warning', title: 'That payment was not found for this booking', lines: ['It did not confirm this booking.', UNRESOLVED_LINE] };
      }
      if (f.kind === 'http' && f.error === 'payment_mismatch') {
        return { tone: 'error', title: 'That payment does not match this booking', lines: ['It did not confirm this booking. Contact support.'] };
      }
      return {
        tone: 'warning',
        title: 'The payment could not be verified',
        lines: ['This does not mean it failed. A payment may still be applied.', UNRESOLVED_LINE],
      };
    }
    case 'outcome':
      return describeOutcome(state.outcome);
  }
}

export function describeOutcome(o: Outcome | VerifyOutcome): CheckoutMessage {
  const complete = 'complete' in o ? o.complete : true;
  const fromBookingCheck = 'source' in o && o.source === 'booking';
  const others = 'otherPayments' in o ? o.otherPayments : [];
  const lease = 'checkoutLease' in o ? o.checkoutLease : null;
  const partial = complete ? [] : [PARTIAL_LINE];
  const extra = otherPaymentLines(others);
  switch (o.result) {
    case 'no_payment_found': {
      if (lease === 'other') {
        return {
          tone: 'warning',
          title: 'A payment window may be open elsewhere',
          lines: [
            'No payment was found right now.',
            'A payment window for this booking was opened elsewhere (another tab or device, or before this page was reloaded) and is still reserved, so a new payment cannot be started for this hold.',
            'A payment made there can appear later. Check again in a while.',
          ],
        };
      }
      if (lease === 'ended') {
        return {
          tone: 'warning',
          title: 'An earlier payment window has ended',
          lines: [
            'No payment was found right now, but a payment window for this booking was opened earlier and has ended. A payment still being processed can appear later.',
            'To avoid paying twice, a new payment cannot be started for this hold. Check again later.',
          ],
        };
      }
      // Only the server's own status says the booking can still be paid;
      // a missing status is not read as payable.
      const verdict =
        o.bookingStatus === 'pending_payment'
          ? 'You can pay while the hold lasts.'
          : o.bookingStatus === 'confirmed'
            ? 'This booking is already confirmed. No payment is needed.'
            : o.bookingStatus === null
              ? 'We could not tell whether this booking can still be paid.'
              : 'This booking is no longer waiting for payment.';
      return {
        tone: 'neutral',
        title: 'No payment found for this booking',
        lines: [
          'No payment was found right now. A payment still being processed can appear later.',
          verdict,
        ],
      };
    }
    case 'confirmed': {
      if (o.providerRefund === 'none' || o.providerRefund === null) {
        if (hasStrandedMoney(others)) {
          return {
            tone: 'warning',
            title: 'Booking confirmed, additional payment found',
            lines: ['One payment confirmed your booking.', ...extra, ...partial],
          };
        }
        return {
          tone: 'success',
          title: 'Booking confirmed',
          lines: ['This payment confirmed your booking.', ...extra, ...partial],
        };
      }
      return {
        tone: 'warning',
        title: 'Booking confirmed, refund observed',
        lines: [
          o.providerRefund === 'full'
            ? 'This payment confirmed your booking, but the provider now reports it fully refunded.'
            : 'This payment confirmed your booking, but the provider now reports part of it refunded.',
          'This booking needs attention. Contact support.',
          ...extra,
          ...partial,
        ],
      };
    }
    case 'not_fulfilled': {
      const lines: string[] = [];
      lines.push(
        o.bookingStatus === 'confirmed'
          ? 'Your booking is confirmed by another payment. This payment did not confirm it.'
          : 'This payment did not confirm your booking.',
      );
      if (o.providerRefund === 'partial') {
        lines.push('The provider reports a partial refund of this payment. The remaining amount is not yet being refunded automatically; contact support.');
      } else if (o.providerRefund === 'full') {
        lines.push('The provider reports this payment fully refunded. That does not confirm the money has reached your account.');
      } else {
        lines.push('The payment may have been received, but it was not applied to a booking. Refunds are not yet handled automatically; contact support.');
      }
      return { tone: 'error', title: 'Booking not confirmed by this payment', lines: [...lines, ...extra, ...partial] };
    }
    case 'payment_failed':
      return {
        tone: 'warning',
        title: fromBookingCheck ? 'A failed payment was found' : 'Payment reported as failed',
        lines: [
          'The provider currently reports this payment as failed. A failed payment can occasionally still go through, so a new payment cannot be started for this booking now.',
          'Check the payment status again in a while. If the hold ends first the booking expires; a payment that still goes through is recorded, but refunds are not yet handled automatically, so contact support.',
          ...extra,
          ...partial,
        ],
      };
    case 'payment_pending':
      return {
        tone: 'neutral',
        title: 'Payment pending',
        lines: ['The provider has not captured this payment yet. Check again shortly; do not pay again.', ...extra, ...partial],
      };
  }
}
