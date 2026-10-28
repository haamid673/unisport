// POST /functions/v1/payments-verify
//   { "booking_id": "<uuid>", "razorpay_payment_id": "pay_..." }
//
// Lets the signed-in customer ask the server to check a payment for
// one of their own bookings right after Checkout, instead of waiting
// for the webhook. It is a TRIGGER for the normal trusted path, not a
// way to assert anything:
//
//   1. the caller is identified from their JWT (GoTrue);
//   2. booking ownership and the booking's provider orders come from
//      the database (payment_booking_payment_context); someone else's
//      booking is indistinguishable from a missing one (404);
//   3. the payment is FETCHED from the provider API with the server
//      key. Nothing the browser sends (success flag, Checkout
//      signature, order id, amount, status) is used as a fact; only
//      the two ids above are read from the body;
//   4. the fetched payment must belong to one of THIS booking's orders
//      and carry exactly that attempt's amount and currency. Otherwise
//      nothing is applied (fail closed): a payment of another booking
//      or of an unknown order is never attached here, and is left to
//      the signed webhook path, which stores unknown payments
//      unmatched;
//   5. the facts go through payment_apply_observation, the single
//      settlement path (READ COMMITTED, booking -> attempt -> payment
//      locks, late-capture and closed-attempt policy);
//   6. the answer describes only the resulting state.
//
// Response 200 (the API contract; see supabase/functions/README.md):
//   { booking_id, booking_status, payment_status, provider_refund, result }
//
//   result            the ONLY field that says whether THIS payment
//                     fulfilled the booking:
//     confirmed       the booking's durable fulfilment pointer is this
//                     payment (read back from the database after the
//                     observation was applied)
//     not_fulfilled   the provider reports this payment captured (or
//                     refunded), but it is NOT the payment that fulfilled
//                     the booking: hold expired, attempt closed, booking
//                     already fulfilled by another payment, refunded
//                     before settlement, a refund obligation, or an
//                     anomaly. Never a confirmation of this payment.
//     payment_failed  the provider reports the payment failed (not
//                     final: a later capture is still applied)
//     payment_pending created or authorized: not captured (yet)
//   booking_status    the booking's current status. "confirmed" here does
//                     NOT mean this payment confirmed it.
//   payment_status    the provider's status of this payment, as fetched.
//                     A capture does NOT mean this payment fulfilled the
//                     booking.
//   provider_refund   none | partial | full: what the provider reports as
//                     refunded for this payment (amount_refunded, fetched
//                     just now). It reports provider facts only: "none"
//                     with not_fulfilled means the captured money is
//                     unresolved; this system has not created a refund
//                     (refund processing is not implemented yet). "full"
//                     means the provider has refunds totalling the amount;
//                     it does not prove the money reached the customer.
//
// Errors: 401 unauthorized, 400 invalid_request, 413, 404
// booking_not_found (also for someone else's booking), 409
// payment_not_for_booking (the payment does not belong to this booking's
// orders, has no order, or the provider does not know it: one answer, so
// the endpoint is not an oracle for other payments), 409 payment_mismatch
// (one of this booking's orders, with a different amount/currency), 503
// payment_provider_unavailable / payments_unavailable /
// temporarily_unavailable (retry), 502 verification_failed.
//
// Repeated calls are idempotent: the observation merge and settlement
// are idempotent, so a second call returns the same state.
//
// ------------------------------------------------------------------
// Recovery mode:  { "booking_id": "<uuid>" }   (no payment id)
// ------------------------------------------------------------------
// For a client that no longer knows the payment id (reload, another
// tab or device, an ambiguous verification). After the same JWT and
// ownership checks, the server inspects the payments of THIS booking's
// own recorded orders (trusted, write-once state; never an order or
// payment id from the client) with GET /v1/orders/{id}/payments, bounded
// to the newest MAX_RECOVERY_ORDERS orders and MAX_PROVIDER_CALLS
// provider calls. When the booking is already fulfilled, its fulfilling
// payment (from the database) is always fetched and reported, even when
// it belongs to an older order outside that bound (one call is reserved
// for it). Every payment must be a valid payment entity of exactly
// that order with the attempt's amount and currency, else it is not
// applied. Valid ones go through payment_apply_observation, the same
// single path as above.
//
// Optional recovery field: checkout_session (the browser's checkout
// session id, the same one create-order receives). It is used ONLY to tell
// the caller's own Checkout lease from another session's; it is compared
// by SHA-256 and never stored, returned or logged.
//
// Response 200:
//   { booking_id, booking_status, mode: "recovery", complete,
//     result, razorpay_payment_id, payment_status, provider_refund,
//     other_payments: [ { razorpay_payment_id, payment_status,
//                         provider_refund, result, decision } ],
//     checkout_lease }
//
//   result               describes ONE payment (razorpay_payment_id), the
//                        most significant one found:
//     confirmed          that payment is the booking's durable fulfilment
//     not_fulfilled      a captured/refunded payment that did not fulfil
//     payment_pending    created/authorized
//     payment_failed     only failed payments were found
//     no_payment_found   no payment exists for the booking's orders, and
//                        the inspection was complete. It does NOT prove a
//                        payment cannot still be made on an open order.
//   complete             every relevant provider record was inspected AND
//                        reported. false: more orders/payments may exist
//                        (an older order was not listed, a list may be cut
//                        short, a record was unreadable or not this
//                        booking's, or more than MAX_OTHER_PAYMENTS others
//                        exist): the result is a partial view. It never
//                        claims that no additional payment exists.
//   razorpay_payment_id, payment_status, provider_refund are null for
//   no_payment_found.
//   other_payments       EVERY other valid payment found on the booking's
//                        orders (each already applied through the single
//                        settlement path), at most MAX_OTHER_PAYMENTS,
//                        most significant first. `result` is that payment's
//                        own outcome (a captured payment that did not
//                        fulfil the booking is not_fulfilled), `decision`
//                        is OUR stored, write-once settlement label for it
//                        (late_capture, duplicate_capture, ...) or null.
//                        provider_refund is a provider fact; nothing here
//                        says a refund was created or completed.
//   checkout_lease       the booking's Checkout lease as seen by THIS
//                        caller: none (no order handed out; create-order
//                        would grant one), yours (this session holds it),
//                        other (another session, or an order handed out
//                        before leases existed, holds it; also when no
//                        session was sent) or ended (a lease ended: never
//                        re-granted). It says nothing about whether any
//                        payment exists: no_payment_found with
//                        checkout_lease other/ended means create-order
//                        will refuse, not that a payment was made.
//
// 503 recovery_incomplete (retry) when nothing was found but the
// inspection was not complete; 503 payment_provider_unavailable on any
// provider failure (a failed fetch never means "no payment").

import type { PaymentConfig } from './config.ts';
import { BodyTooLarge, CORS_HEADERS, isRecord, json, readBodyLimited, UUID } from './http.ts';
import type { Logger } from './http.ts';
import { applyObservation } from './observation.ts';
import type { RazorpayClient, RazorpayPaymentFacts } from './razorpay.ts';
import { parsePayment, PAYMENT_ID } from './razorpay.ts';
import type { Auth, Database } from './supabase.ts';
import { sha256Hex } from './signature.ts';
import { bearerToken, isDeterministicDbError } from './supabase.ts';

export interface VerifyDeps {
  config: PaymentConfig;
  db: Database;
  auth: Auth;
  razorpay: RazorpayClient | null;
  log: Logger;
}

const MAX_BODY = 4096;
const RETRY_SECONDS = 15;

interface OrderRef {
  provider_order_id: string;
  amount_paise: number;
  currency: string;
}

function respond(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return json(status, body, { ...CORS_HEADERS, ...extra });
}

const retry = (error: string) =>
  respond(503, { error, retry_after_seconds: RETRY_SECONDS }, { 'Retry-After': String(RETRY_SECONDS) });

type Result = 'confirmed' | 'not_fulfilled' | 'payment_failed' | 'payment_pending';

function resultOf(facts: RazorpayPaymentFacts, fulfils: boolean): Result {
  if (fulfils) return 'confirmed';
  if (facts.status === 'captured' || facts.status === 'refunded') return 'not_fulfilled';
  if (facts.status === 'failed') return 'payment_failed';
  return 'payment_pending';
}

// Provider facts only (fetched just now); never inferred from `result`.
function refundOf(facts: RazorpayPaymentFacts): 'none' | 'partial' | 'full' {
  if (facts.status === 'refunded' || facts.amount_refunded >= facts.amount) return 'full';
  return facts.amount_refunded > 0 ? 'partial' : 'none';
}

function ordersOf(context: Record<string, unknown>): OrderRef[] {
  if (!Array.isArray(context.orders)) return [];
  return context.orders.filter((o): o is OrderRef =>
    isRecord(o) && typeof o.provider_order_id === 'string' &&
    typeof o.amount_paise === 'number' && typeof o.currency === 'string'
  );
}

export async function handleVerify(req: Request, deps: VerifyDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return respond(405, { error: 'method_not_allowed' });

  // 1. caller
  const token = bearerToken(req);
  const userId = token ? await deps.auth.getUserId(token) : null;
  if (!userId) return respond(401, { error: 'unauthorized' });

  // only the two identifiers are read; the payment id is optional
  // (absent: recovery mode)
  let bookingId: string;
  let paymentId: string | null;
  let checkoutSession: string | null = null;
  try {
    const raw = await readBodyLimited(req, MAX_BODY);
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (!isRecord(body) || typeof body.booking_id !== 'string' || !UUID.test(body.booking_id)) {
      return respond(400, { error: 'invalid_request' });
    }
    const given = body.razorpay_payment_id;
    if (given !== undefined && given !== null &&
        (typeof given !== 'string' || !PAYMENT_ID.test(given))) {
      return respond(400, { error: 'invalid_request' });
    }
    const session = body.checkout_session;
    if (session !== undefined && session !== null &&
        (typeof session !== 'string' || !UUID.test(session.toLowerCase()))) {
      return respond(400, { error: 'invalid_request' });
    }
    bookingId = body.booking_id;
    paymentId = typeof given === 'string' ? given : null;
    checkoutSession = typeof session === 'string' ? session.toLowerCase() : null;
  } catch (e) {
    if (e instanceof BodyTooLarge) return respond(413, { error: 'request_too_large' });
    return respond(400, { error: 'invalid_request' });
  }

  if (!deps.razorpay) {
    deps.log('verify.not_configured', { booking_id: bookingId });
    return respond(503, { error: 'payments_unavailable' });
  }

  // 2. ownership and the booking's own orders (trusted state)
  const context = async (pid: string | null = paymentId) => {
    const r = await deps.db.rpc<Record<string, unknown>>('payment_booking_payment_context', {
      p_booking_id: bookingId,
      p_user_id: userId,
      p_provider_payment_id: pid,
    });
    return r.ok && isRecord(r.data) ? r.data : null;
  };
  const before = await context();
  if (!before) return retry('temporarily_unavailable');
  if (before.found !== true) return respond(404, { error: 'booking_not_found' });

  if (paymentId === null) {
    return recover(deps, deps.razorpay, bookingId, before, context, checkoutSession);
  }

  const orders = ordersOf(before);
  if (orders.length === 0) {
    // no order was ever created for this booking: nothing can match
    return respond(409, { error: 'payment_not_for_booking' });
  }

  // 3. trusted facts from the provider
  const fetched = await deps.razorpay.fetchPayment(paymentId);
  if (fetched.kind === 'not_found') {
    // Same answer as a payment of another order: the caller learns
    // nothing about payments that are not this booking's.
    deps.log('verify.payment_not_for_booking', { booking_id: bookingId, payment_id: paymentId, reason: 'unknown_to_provider' });
    return respond(409, { error: 'payment_not_for_booking' });
  }
  if (fetched.kind === 'error') {
    deps.log('verify.fetch_failed', { booking_id: bookingId, reason: fetched.reason, status: fetched.status ?? null });
    return retry('payment_provider_unavailable');
  }
  const facts = parsePayment(fetched.payment, paymentId);
  if (!facts) {
    deps.log('verify.invalid_provider_response', { booking_id: bookingId });
    return respond(502, { error: 'verification_failed' });
  }

  // 4. identity: one of THIS booking's orders, with its amount/currency
  const order = facts.order_id === null ? undefined : orders.find((o) => o.provider_order_id === facts.order_id);
  if (!order) {
    deps.log('verify.payment_not_for_booking', {
      booking_id: bookingId,
      payment_id: paymentId,
      reason: facts.order_id === null ? 'no_order' : 'other_order',
    });
    return respond(409, { error: 'payment_not_for_booking' });
  }
  if (facts.amount !== order.amount_paise || facts.currency !== order.currency) {
    deps.log('verify.payment_mismatch', { booking_id: bookingId, payment_id: paymentId });
    return respond(409, { error: 'payment_mismatch' });
  }

  // 5. the single settlement path
  const applied = await applyObservation(deps.db, null, facts);
  if (!applied.ok || !isRecord(applied.data)) {
    const deterministic = !applied.ok && isDeterministicDbError(applied);
    deps.log('verify.apply_failed', {
      booking_id: bookingId,
      status: applied.ok ? 200 : applied.status,
      code: applied.ok ? null : applied.code,
    });
    return deterministic ? respond(502, { error: 'verification_failed' }) : retry('temporarily_unavailable');
  }

  // 6. the resulting state only
  const after = await context();
  if (!after || after.found !== true) return retry('temporarily_unavailable');

  const result = resultOf(facts, after.payment_fulfils_booking === true);
  const providerRefund = refundOf(facts);

  deps.log('verify.done', {
    booking_id: bookingId,
    payment_id: paymentId,
    result,
    provider_refund: providerRefund,
    settlement: typeof applied.data.settlement === 'string' ? applied.data.settlement : null,
    decision: typeof after.payment_decision === 'string' ? after.payment_decision : null,
  });
  return respond(200, {
    booking_id: bookingId,
    booking_status: typeof after.booking_status === 'string' ? after.booking_status : null,
    payment_status: facts.status,
    provider_refund: providerRefund,
    result,
  });
}

// ------------------------------------------------------------------
// Recovery mode
// ------------------------------------------------------------------

export const MAX_RECOVERY_ORDERS = 3;
export const MAX_PROVIDER_CALLS = 6;
export const MAX_OTHER_PAYMENTS = 10;

export type CheckoutLease = 'none' | 'yours' | 'other' | 'ended';

// The Checkout lease as seen by this caller. Fail closed: anything not
// understood (a missing field, an unknown state) is `other`.
async function leaseOf(ctx: Record<string, unknown>, session: string | null): Promise<CheckoutLease> {
  if (!('checkout_lease' in ctx)) return 'other';
  const l = ctx.checkout_lease;
  if (l === null) return 'none'; // no open attempt: nothing was handed out
  if (!isRecord(l)) return 'other';
  if (l.state === 'none') return 'none';
  if (l.state === 'ended') return 'ended';
  if (l.state === 'active') {
    return session !== null && typeof l.hash === 'string' && l.hash === await sha256Hex(session) ? 'yours' : 'other';
  }
  return 'other';
}

// Higher wins when choosing the one payment the answer describes.
const SIGNIFICANCE: Record<Result, number> = {
  confirmed: 4,
  not_fulfilled: 3,
  payment_pending: 2,
  payment_failed: 1,
};

type Context = (pid?: string | null) => Promise<Record<string, unknown> | null>;

async function recover(
  deps: VerifyDeps,
  razorpay: RazorpayClient,
  bookingId: string,
  before: Record<string, unknown>,
  context: Context,
  checkoutSession: string | null,
): Promise<Response> {
  const all = ordersOf(before);
  // newest orders first (the context lists them oldest first)
  const orders = all.slice(-MAX_RECOVERY_ORDERS).reverse();
  let complete = all.length <= MAX_RECOVERY_ORDERS;
  let calls = 0;

  // The booking's durable fulfilment (database), if any: always reported.
  const fp = isRecord(before.fulfilling_payment) ? before.fulfilling_payment : null;
  const fulfilling = fp && typeof fp.provider_payment_id === 'string' && PAYMENT_ID.test(fp.provider_payment_id) &&
      typeof fp.provider_order_id === 'string'
    ? { id: fp.provider_payment_id, orderId: fp.provider_order_id }
    : null;
  const budget = fulfilling ? MAX_PROVIDER_CALLS - 1 : MAX_PROVIDER_CALLS;

  // 1. discover candidate payments of THIS booking's orders
  const candidates: { facts: RazorpayPaymentFacts; order: OrderRef }[] = [];
  const seen = new Set<string>();
  for (const order of orders) {
    if (calls >= budget) {
      complete = false;
      break;
    }
    calls++;
    const listed = await razorpay.fetchOrderPayments(order.provider_order_id);
    if (listed.kind === 'error') {
      deps.log('verify.recovery_fetch_failed', { booking_id: bookingId, reason: listed.reason, status: listed.status ?? null });
      return retry('payment_provider_unavailable');
    }
    if (!listed.complete) complete = false;

    for (const item of listed.items) {
      const id = isRecord(item) && typeof item.id === 'string' && PAYMENT_ID.test(item.id) ? item.id : null;
      if (!id) {
        complete = false; // an item we cannot even identify
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);

      // Use the listed facts when they form a valid payment entity;
      // otherwise fetch the payment itself (bounded).
      let facts = parsePayment(item, id);
      if (!facts) {
        if (calls >= budget) {
          complete = false;
          continue;
        }
        calls++;
        const fetched = await razorpay.fetchPayment(id);
        if (fetched.kind === 'error') {
          deps.log('verify.recovery_fetch_failed', { booking_id: bookingId, reason: fetched.reason, status: fetched.status ?? null });
          return retry('payment_provider_unavailable');
        }
        facts = fetched.kind === 'ok' ? parsePayment(fetched.payment, id) : null;
        if (!facts) {
          complete = false;
          continue;
        }
      }

      // identity: exactly this order, with the attempt's amount/currency
      if (facts.order_id !== order.provider_order_id ||
          facts.amount !== order.amount_paise || facts.currency !== order.currency) {
        deps.log('verify.recovery_payment_mismatch', { booking_id: bookingId, payment_id: id });
        // Never applied here (the signed webhook path stores it
        // unmatched). But money may have moved on this booking's order,
        // so the answer must never be "no payment found".
        complete = false;
        continue;
      }
      candidates.push({ facts, order });
    }
  }

  // 1b. the fulfilling payment, when the listing did not include it
  //     (an older order outside the bound, or a truncated list)
  if (fulfilling && !candidates.some((c) => c.facts.id === fulfilling.id)) {
    const order = all.find((o) => o.provider_order_id === fulfilling.orderId);
    calls++;
    const fetched = order ? await razorpay.fetchPayment(fulfilling.id) : null;
    if (fetched?.kind === 'error') {
      deps.log('verify.recovery_fetch_failed', { booking_id: bookingId, reason: fetched.reason, status: fetched.status ?? null });
      return retry('payment_provider_unavailable');
    }
    const facts = order && fetched?.kind === 'ok' ? parsePayment(fetched.payment, fulfilling.id) : null;
    if (order && facts && facts.order_id === order.provider_order_id &&
        facts.amount === order.amount_paise && facts.currency === order.currency) {
      candidates.push({ facts, order });
    } else {
      deps.log('verify.recovery_fulfilling_unreadable', { booking_id: bookingId, payment_id: fulfilling.id });
      complete = false;
    }
  }

  // 2. apply each through the single observation/settlement path
  let best: { facts: RazorpayPaymentFacts; result: Result } | null = null;
  const found: { facts: RazorpayPaymentFacts; result: Result; decision: string | null }[] = [];
  for (const { facts } of candidates) {
    const applied = await applyObservation(deps.db, null, facts);
    if (!applied.ok || !isRecord(applied.data)) {
      const deterministic = !applied.ok && isDeterministicDbError(applied);
      deps.log('verify.recovery_apply_failed', {
        booking_id: bookingId,
        payment_id: facts.id,
        code: applied.ok ? null : applied.code,
      });
      return deterministic ? respond(502, { error: 'verification_failed' }) : retry('temporarily_unavailable');
    }
    let fulfils = false;
    let decision: string | null = null;
    if (facts.status === 'captured' || facts.status === 'refunded') {
      const ctx = await context(facts.id);
      if (!ctx || ctx.found !== true) return retry('temporarily_unavailable');
      fulfils = ctx.payment_fulfils_booking === true;
      decision = typeof ctx.payment_decision === 'string' ? ctx.payment_decision : null;
    }
    const result = resultOf(facts, fulfils);
    found.push({ facts, result, decision });
    if (!best || SIGNIFICANCE[result] > SIGNIFICANCE[best.result]) best = { facts, result };
  }

  // The other payments, most significant first (then by id, so the answer
  // is stable). Bounded: a longer list is reported as incomplete.
  const others = found
    .filter((f) => f.facts.id !== best?.facts.id)
    .sort((a, b) => SIGNIFICANCE[b.result] - SIGNIFICANCE[a.result] || (a.facts.id < b.facts.id ? -1 : 1));
  if (others.length > MAX_OTHER_PAYMENTS) complete = false;
  const otherPayments = others.slice(0, MAX_OTHER_PAYMENTS).map((o) => ({
    razorpay_payment_id: o.facts.id,
    payment_status: o.facts.status,
    provider_refund: refundOf(o.facts),
    result: o.result,
    decision: o.decision,
  }));

  // 3. the resulting state only
  const after = await context(null);
  if (!after || after.found !== true) return retry('temporarily_unavailable');
  const bookingStatus = typeof after.booking_status === 'string' ? after.booking_status : null;
  const checkoutLease = await leaseOf(after, checkoutSession);

  if (!best) {
    if (!complete) {
      deps.log('verify.recovery_incomplete', { booking_id: bookingId, calls });
      return retry('recovery_incomplete');
    }
    deps.log('verify.recovery_done', { booking_id: bookingId, result: 'no_payment_found', calls });
    return respond(200, {
      booking_id: bookingId,
      booking_status: bookingStatus,
      mode: 'recovery',
      complete: true,
      result: 'no_payment_found',
      razorpay_payment_id: null,
      payment_status: null,
      provider_refund: null,
      other_payments: [],
      checkout_lease: checkoutLease,
    });
  }

  deps.log('verify.recovery_done', { booking_id: bookingId, result: best.result, complete, calls });
  return respond(200, {
    booking_id: bookingId,
    booking_status: bookingStatus,
    mode: 'recovery',
    complete,
    result: best.result,
    razorpay_payment_id: best.facts.id,
    payment_status: best.facts.status,
    provider_refund: refundOf(best.facts),
    other_payments: otherPayments,
    checkout_lease: checkoutLease,
  });
}
