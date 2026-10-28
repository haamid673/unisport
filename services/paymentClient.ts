import { FunctionsHttpError } from '@supabase/supabase-js';
import { getSupabase } from './supabaseClient';

/**
 * Client for the payment Edge Functions (Razorpay TEST mode).
 *
 *   payments-create-order  { booking_id, checkout_session }     -> order
 *                          (checkout_session: a random id for this
 *                          page's checkout flow, re-sent on retries; the
 *                          server hands the order out only under a lease
 *                          held by that session)
 *   payments-verify        { booking_id, razorpay_payment_id }  -> outcome
 *   payments-verify        { booking_id, checkout_session }     -> recovery
 *                          (the server inspects the payments of the
 *                          booking's own orders; no payment id needed.
 *                          checkout_session only lets the server say
 *                          whether the Checkout lease is THIS page's)
 *
 * Rules this module follows:
 *
 *  - Calls go through the shared Supabase client, which attaches the
 *    signed-in user's session token. No user id is ever sent: the
 *    functions derive the user from the token.
 *  - Only identifiers are sent. The order id, amount, currency and the
 *    public key id come back from the server and are treated as
 *    authoritative; the browser never computes or submits a price.
 *  - Responses are parsed strictly. Anything unexpected is a failure,
 *    never a success.
 *  - Nothing secret is handled here: the only key is the server-returned
 *    PUBLIC key id, and it must be a Razorpay test key.
 *  - Every request is bounded (REQUEST_TIMEOUT_MS). A request that does
 *    not answer in time is reported as a network failure: retryable, and
 *    NOT evidence that the server or the provider did nothing.
 *
 * Contract: supabase/functions/README.md.
 */

export const CREATE_ORDER_FUNCTION = 'payments-create-order';
export const VERIFY_FUNCTION = 'payments-verify';

const TEST_KEY_ID = /^rzp_test_[A-Za-z0-9]{1,64}$/;
const ORDER_ID = /^order_[A-Za-z0-9]{1,40}$/;
const PAYMENT_ID = /^pay_[A-Za-z0-9]{1,40}$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Upper bound for one payment request (the server's own work is bounded below it). */
export const REQUEST_TIMEOUT_MS = 30_000;

export interface CheckoutOrder {
  attemptId: string;
  orderId: string;
  amountPaise: number;
  currency: string;
  keyId: string;
  /** Seconds of hold left, by the database clock; null if not reported. */
  holdSecondsRemaining: number | null;
}

export type VerifyResult = 'confirmed' | 'not_fulfilled' | 'payment_failed' | 'payment_pending';
export type ProviderRefund = 'none' | 'partial' | 'full';

export interface VerifyOutcome {
  bookingId: string;
  bookingStatus: string | null;
  paymentStatus: string;
  providerRefund: ProviderRefund;
  result: VerifyResult;
}

/** Our write-once label for a decision about captured money (not a refund state). */
export type SettlementDecision =
  | 'fulfilled'
  | 'late_capture'
  | 'duplicate_capture'
  | 'refunded_before_settlement'
  | 'refund_obligation';

/** Another payment found on the booking's orders besides the one `result` describes. */
export interface OtherPayment {
  paymentId: string;
  paymentStatus: string;
  /** What the provider reports as refunded: a provider fact, not proof that money reached anyone. */
  providerRefund: ProviderRefund;
  result: VerifyResult;
  decision: SettlementDecision | null;
}

/**
 * The booking's Checkout lease as seen by this page's session:
 *  none  no order was handed out; create-order would grant one
 *  yours this page's session holds it
 *  other another session (tab, device, an earlier page load) holds it
 *  ended a lease ended: it is never re-granted
 * It says nothing about whether any payment exists.
 */
export type CheckoutLease = 'none' | 'yours' | 'other' | 'ended';

/** Why a call did not produce a usable answer. */
/** Booking-level answer of payments-verify without a payment id. */
export interface RecoveryOutcome {
  bookingId: string;
  bookingStatus: string | null;
  /**
   * Every relevant provider record was inspected and reported. False: more
   * orders or payments may exist, so additional payments cannot be ruled out.
   */
  complete: boolean;
  result: VerifyResult | 'no_payment_found';
  paymentId: string | null;
  paymentStatus: string | null;
  providerRefund: ProviderRefund | null;
  /** Every OTHER payment found (already applied by the server); empty for no_payment_found. */
  otherPayments: OtherPayment[];
  checkoutLease: CheckoutLease;
}

export type ApiFailure =
  | { kind: 'network' }
  | { kind: 'http'; status: number; error: string | null; reason: string | null; retryAfterSeconds: number | null }
  | { kind: 'malformed' };

export type ApiResult<T> = { ok: true; value: T } | { ok: false; failure: ApiFailure };

/** Raw transport: the status (null when the request never got an answer) and the JSON body. */
export interface RawResponse {
  status: number | null;
  body: unknown;
  retryAfter: string | null;
}

export type InvokeFn = (name: string, body: Record<string, string>) => Promise<RawResponse>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The default transport: supabase.functions.invoke with the user's session. */
export const invokeEdgeFunction: InvokeFn = async (name, body) => {
  try {
    const { data, error } = await getSupabase().functions.invoke(name, { body, timeout: REQUEST_TIMEOUT_MS });
    if (!error) return { status: 200, body: data, retryAfter: null };
    if (error instanceof FunctionsHttpError && error.context instanceof Response) {
      const res = error.context;
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }
      return { status: res.status, body: parsed, retryAfter: res.headers.get('retry-after') };
    }
    // FunctionsFetchError / FunctionsRelayError: no answer from the function
    return { status: null, body: null, retryAfter: null };
  } catch {
    return { status: null, body: null, retryAfter: null };
  }
};

type Timers = { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };

// The platform timers, called unqualified. Browsers throw "Illegal
// invocation" when setTimeout is called as a method of another object
// (timers.setTimeout(...) with timers = { setTimeout }); Node does not.
const platformTimers: Timers = {
  setTimeout: ((cb: () => void, ms?: number) => setTimeout(cb, ms)) as Timers['setTimeout'],
  clearTimeout: ((id?: ReturnType<typeof setTimeout>) => clearTimeout(id)) as Timers['clearTimeout'],
};

/**
 * Bound a transport call. Belt and braces on top of the invoke timeout:
 * whatever the transport does, the caller gets an answer in time. A
 * timeout is "no answer" (status null), never a business result.
 */
export function withTimeout(invoke: InvokeFn, ms: number, timers: Timers = platformTimers): InvokeFn {
  return (name, body) =>
    new Promise<RawResponse>(resolve => {
      let done = false;
      const timer = timers.setTimeout(() => {
        if (done) return;
        done = true;
        resolve({ status: null, body: null, retryAfter: null });
      }, ms);
      invoke(name, body).then(
        r => {
          if (done) return;
          done = true;
          timers.clearTimeout(timer);
          resolve(r);
        },
        () => {
          if (done) return;
          done = true;
          timers.clearTimeout(timer);
          resolve({ status: null, body: null, retryAfter: null });
        }
      );
    });
}

function failureOf(raw: RawResponse): ApiFailure {
  if (raw.status === null) return { kind: 'network' };
  const body = isRecord(raw.body) ? raw.body : {};
  const headerSeconds = raw.retryAfter !== null ? Number(raw.retryAfter) : NaN;
  const bodySeconds = typeof body.retry_after_seconds === 'number' ? body.retry_after_seconds : NaN;
  const retry = Number.isFinite(headerSeconds) ? headerSeconds : Number.isFinite(bodySeconds) ? bodySeconds : null;
  return {
    kind: 'http',
    status: raw.status,
    error: typeof body.error === 'string' ? body.error : null,
    reason: typeof body.reason === 'string' ? body.reason : null,
    retryAfterSeconds: retry === null ? null : Math.max(0, Math.min(retry, 120)),
  };
}

/**
 * Whether trying the SAME request again later can succeed. Only
 * transport failures, 503 (the functions' "temporarily unavailable"),
 * 429, and a creation already in progress qualify. A business answer
 * (not payable, not this booking's payment, mismatch, another checkout
 * session holding the order, a payment that may exist, 4xx) is final.
 */
export function isRetryable(failure: ApiFailure): boolean {
  if (failure.kind === 'network') return true;
  if (failure.kind === 'malformed') return false;
  if (failure.status === 503 || failure.status === 429) return true;
  return failure.status === 409 && failure.error === 'order_creation_in_progress';
}

function parseOrder(body: unknown): CheckoutOrder | null {
  if (!isRecord(body)) return null;
  const { attempt_id, order_id, amount_paise, currency, key_id } = body;
  if (typeof attempt_id !== 'string' || typeof order_id !== 'string' || !ORDER_ID.test(order_id)) return null;
  if (typeof amount_paise !== 'number' || !Number.isSafeInteger(amount_paise) || amount_paise <= 0) return null;
  if (currency !== 'INR') return null;
  if (typeof key_id !== 'string' || !TEST_KEY_ID.test(key_id)) return null;
  const hold = body.hold_seconds_remaining;
  const holdSecondsRemaining =
    typeof hold === 'number' && Number.isFinite(hold) && hold >= 0 ? Math.floor(hold) : null;
  return { attemptId: attempt_id, orderId: order_id, amountPaise: amount_paise, currency: 'INR', keyId: key_id, holdSecondsRemaining };
}

const RESULTS = new Set<VerifyResult>(['confirmed', 'not_fulfilled', 'payment_failed', 'payment_pending']);
const REFUNDS = new Set<ProviderRefund>(['none', 'partial', 'full']);

function parseOutcome(body: unknown, bookingId: string): VerifyOutcome | null {
  if (!isRecord(body)) return null;
  const { booking_id, booking_status, payment_status, provider_refund, result } = body;
  if (booking_id !== bookingId) return null;
  if (typeof result !== 'string' || !RESULTS.has(result as VerifyResult)) return null;
  if (typeof provider_refund !== 'string' || !REFUNDS.has(provider_refund as ProviderRefund)) return null;
  if (typeof payment_status !== 'string') return null;
  if (booking_status !== null && typeof booking_status !== 'string') return null;
  return {
    bookingId,
    bookingStatus: typeof booking_status === 'string' ? booking_status : null,
    paymentStatus: payment_status,
    providerRefund: provider_refund as ProviderRefund,
    result: result as VerifyResult,
  };
}

const RECOVERY_RESULTS = new Set(['confirmed', 'not_fulfilled', 'payment_failed', 'payment_pending', 'no_payment_found']);
const LEASES = new Set<CheckoutLease>(['none', 'yours', 'other', 'ended']);
const DECISIONS = new Set<SettlementDecision>([
  'fulfilled', 'late_capture', 'duplicate_capture', 'refunded_before_settlement', 'refund_obligation',
]);
/** Mirrors the server's report bound; a longer list is malformed. */
export const MAX_OTHER_PAYMENTS = 10;

function parseOtherPayments(value: unknown, primaryId: string | null): OtherPayment[] | null {
  if (!Array.isArray(value) || value.length > MAX_OTHER_PAYMENTS) return null;
  const seen = new Set<string>(primaryId ? [primaryId] : []);
  const out: OtherPayment[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const { razorpay_payment_id, payment_status, provider_refund, result, decision } = item;
    if (typeof razorpay_payment_id !== 'string' || !PAYMENT_ID.test(razorpay_payment_id) || seen.has(razorpay_payment_id)) return null;
    if (typeof payment_status !== 'string') return null;
    if (typeof provider_refund !== 'string' || !REFUNDS.has(provider_refund as ProviderRefund)) return null;
    if (typeof result !== 'string' || !RESULTS.has(result as VerifyResult)) return null;
    if (decision !== null && (typeof decision !== 'string' || !DECISIONS.has(decision as SettlementDecision))) return null;
    seen.add(razorpay_payment_id);
    out.push({
      paymentId: razorpay_payment_id,
      paymentStatus: payment_status,
      providerRefund: provider_refund as ProviderRefund,
      result: result as VerifyResult,
      decision: decision as SettlementDecision | null,
    });
  }
  return out;
}

function parseRecovery(body: unknown, bookingId: string): RecoveryOutcome | null {
  if (!isRecord(body) || body.mode !== 'recovery' || body.booking_id !== bookingId) return null;
  const { booking_status, complete, result, razorpay_payment_id, payment_status, provider_refund } = body;
  if (typeof complete !== 'boolean') return null;
  if (typeof result !== 'string' || !RECOVERY_RESULTS.has(result)) return null;
  if (booking_status !== null && typeof booking_status !== 'string') return null;
  const lease = body.checkout_lease;
  if (typeof lease !== 'string' || !LEASES.has(lease as CheckoutLease)) return null;
  if (result === 'no_payment_found') {
    // only a complete inspection that found nothing at all may say so
    if (!complete || razorpay_payment_id !== null) return null;
    if (!Array.isArray(body.other_payments) || body.other_payments.length !== 0) return null;
    return {
      bookingId,
      bookingStatus: typeof booking_status === 'string' ? booking_status : null,
      complete: true,
      result: 'no_payment_found',
      paymentId: null,
      paymentStatus: null,
      providerRefund: null,
      otherPayments: [],
      checkoutLease: lease as CheckoutLease,
    };
  }
  if (typeof razorpay_payment_id !== 'string' || !PAYMENT_ID.test(razorpay_payment_id)) return null;
  if (typeof payment_status !== 'string') return null;
  if (typeof provider_refund !== 'string' || !REFUNDS.has(provider_refund as ProviderRefund)) return null;
  const others = parseOtherPayments(body.other_payments, razorpay_payment_id);
  if (others === null) return null;
  return {
    bookingId,
    bookingStatus: typeof booking_status === 'string' ? booking_status : null,
    complete,
    result: result as VerifyResult,
    paymentId: razorpay_payment_id,
    paymentStatus: payment_status,
    providerRefund: provider_refund as ProviderRefund,
    otherPayments: others,
    checkoutLease: lease as CheckoutLease,
  };
}

/**
 * Answers to create-order that mean a payment may already be under way
 * for this booking elsewhere (another tab or device, an earlier page
 * load, or an earlier payment on the order). Never retried and never a
 * reason to start another payment.
 */
export function isPaymentElsewhere(failure: ApiFailure): boolean {
  return failure.kind === 'http' && failure.status === 409 &&
    (failure.error === 'checkout_in_progress' || failure.error === 'payment_may_exist');
}

export interface PaymentClient {
  createOrder(bookingId: string, checkoutSession: string): Promise<ApiResult<CheckoutOrder>>;
  verify(bookingId: string, paymentId: string): Promise<ApiResult<VerifyOutcome>>;
  recover(bookingId: string, checkoutSession: string): Promise<ApiResult<RecoveryOutcome>>;
}

export function createPaymentClient(
  transport: InvokeFn = invokeEdgeFunction,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
  timers?: Timers
): PaymentClient {
  const invoke = withTimeout(transport, timeoutMs, timers);
  return {
    async createOrder(bookingId, checkoutSession) {
      if (!SESSION_ID.test(checkoutSession)) return { ok: false, failure: { kind: 'malformed' } };
      const raw = await invoke(CREATE_ORDER_FUNCTION, { booking_id: bookingId, checkout_session: checkoutSession });
      if (raw.status !== 200) return { ok: false, failure: failureOf(raw) };
      const order = parseOrder(raw.body);
      return order ? { ok: true, value: order } : { ok: false, failure: { kind: 'malformed' } };
    },

    async verify(bookingId, paymentId) {
      if (!PAYMENT_ID.test(paymentId)) return { ok: false, failure: { kind: 'malformed' } };
      const raw = await invoke(VERIFY_FUNCTION, { booking_id: bookingId, razorpay_payment_id: paymentId });
      if (raw.status !== 200) return { ok: false, failure: failureOf(raw) };
      const outcome = parseOutcome(raw.body, bookingId);
      return outcome ? { ok: true, value: outcome } : { ok: false, failure: { kind: 'malformed' } };
    },

    async recover(bookingId, checkoutSession) {
      if (!SESSION_ID.test(checkoutSession)) return { ok: false, failure: { kind: 'malformed' } };
      const raw = await invoke(VERIFY_FUNCTION, { booking_id: bookingId, checkout_session: checkoutSession });
      if (raw.status !== 200) return { ok: false, failure: failureOf(raw) };
      const outcome = parseRecovery(raw.body, bookingId);
      return outcome ? { ok: true, value: outcome } : { ok: false, failure: { kind: 'malformed' } };
    },
  };
}

// ------------------------------------------------------------------
// Checkout-lease facts the customer can already read
// ------------------------------------------------------------------

/**
 * One OPEN payment attempt of a booking, as the signed-in customer may
 * read it (RLS "Users can view their own payment attempts"): whether a
 * Checkout lease was ever set on it. Display hint only; the server decides.
 */
export interface AttemptLeaseFacts {
  checkoutLeaseUntil: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Open attempts per booking, or null when the rows are not exactly as expected. */
export function leaseFactsByBooking(rows: unknown): Map<string, AttemptLeaseFacts[]> | null {
  if (!Array.isArray(rows)) return null;
  const out = new Map<string, AttemptLeaseFacts[]>();
  for (const row of rows) {
    if (!isRecord(row)) return null;
    const { booking_id, state, checkout_lease_until } = row;
    if (typeof booking_id !== 'string' || !UUID.test(booking_id) || state !== 'open') return null;
    const until = checkout_lease_until === null ? null : typeof checkout_lease_until === 'string' ? checkout_lease_until : undefined;
    if (until === undefined) return null;
    const list = out.get(booking_id) ?? [];
    list.push({ checkoutLeaseUntil: until });
    out.set(booking_id, list);
  }
  return out;
}

/**
 * The open attempts of these bookings (the caller's own, by RLS). Null on
 * any failure: the caller then shows what it showed before (the server
 * still refuses a Checkout it would not grant).
 */
export async function fetchOpenAttemptLeases(bookingIds: readonly string[]): Promise<Map<string, AttemptLeaseFacts[]> | null> {
  if (bookingIds.length === 0) return new Map();
  if (bookingIds.some(id => !UUID.test(id))) return null;
  try {
    const { data, error } = await getSupabase()
      .from('payment_attempts')
      .select('booking_id, state, checkout_lease_until')
      .in('booking_id', [...bookingIds])
      .eq('state', 'open');
    return error ? null : leaseFactsByBooking(data);
  } catch {
    return null;
  }
}
