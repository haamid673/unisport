// POST /functions/v1/payments-create-order
//   { "booking_id": "<uuid>", "checkout_session": "<uuid>" }
//
// Creates (or safely re-uses / recovers) the Razorpay order for one of
// the caller's own bookings and returns ONLY what Checkout needs:
//   { attempt_id, order_id, amount_paise, currency, key_id,
//     hold_seconds_remaining }
// hold_seconds_remaining is the database's remaining hold (a relative
// duration, immune to the browser clock), measured when the Checkout
// lease was granted and reduced by the time spent since; the browser
// closes Checkout before it.
//
// Checkout lease (20261023190000): checkout_session is a random id the
// browser generates for its checkout flow and re-sends on retries. The
// order is handed out only together with a lease on the attempt
// (payment_acquire_checkout_lease), so two tabs or devices never get
// the same order for Checkout at the same time:
//   * the first session to ask gets the lease (until the hold ends);
//   * another session gets 409 checkout_in_progress;
//   * the holding session asking again (a retry, or Checkout re-opened)
//     gets the order only when the provider lists NO payment at all on
//     it; any payment, even a failed one, answers 409 payment_may_exist;
//   * an ended lease is never re-granted (409 payment_may_exist): it
//     does not mean no payment was made.
//
// Trust boundary:
//   * the caller is identified from their JWT (GoTrue), never the body;
//   * ownership, eligibility, amount and currency come from the
//     database (payment_prepare_attempt), never from the body;
//   * the attempt is persisted BEFORE the provider call, receipt =
//     attempt id (36 characters, within the 40-character limit);
//   * the provider response is validated (entity, id, amount,
//     currency, receipt, status) before the order id is recorded
//     (write-once, re-validated by payment_record_order).
//
// Payment window (20261020190000): an order is created, re-used or
// handed out only while the booking is pending_payment with at least
// 180 s of hold left; if the hold ends while the provider call is in
// flight, the database records the order but closes the attempt and
// the client gets 409 { error: 'booking_not_payable', reason }.
//
// Ambiguous provider outcomes (timeout, network error, 5xx, 429, an
// unreadable success) leave the attempt 'creating' under its lease. A
// later request then RECOVERS it: it looks the order up by receipt and
// only creates one if none exists; Razorpay itself rejects a second
// order with the same receipt ("duplicate request"), so a recovery can
// never produce two orders for one attempt.

import type { PaymentConfig } from './config.ts';
import { CORS_HEADERS, isRecord, json, BodyTooLarge, readBodyLimited, UUID } from './http.ts';
import type { Logger } from './http.ts';
import type { RazorpayClient } from './razorpay.ts';
import { validateOrder } from './razorpay.ts';
import type { Auth, Database } from './supabase.ts';
import { bearerToken } from './supabase.ts';

export interface CreateOrderDeps {
  config: PaymentConfig;
  db: Database;
  auth: Auth;
  razorpay: RazorpayClient | null;
  log: Logger;
}

interface Attempt {
  attempt_id: string;
  amount_paise: number;
  currency: string;
  receipt: string;
  booking_id: string;
}

const MAX_BODY = 4096;
const RETRY_SECONDS = 15;

// Machine-readable reasons for 409 booking_not_payable (see
// 20261020190000_payment_window_policy.sql).
const NOT_PAYABLE_REASONS = new Set(['hold_expired', 'hold_too_short', 'booking_not_pending', 'attempt_closed']);

function notPayableReason(value: unknown): string {
  return typeof value === 'string' && NOT_PAYABLE_REASONS.has(value) ? value : 'booking_not_pending';
}
const LEASE_RETRY_SECONDS = 60;

function respond(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return json(status, body, { ...CORS_HEADERS, ...extra });
}

const providerUnavailable = () =>
  respond(503, { error: 'payment_provider_unavailable', retry_after_seconds: LEASE_RETRY_SECONDS },
    { 'Retry-After': String(LEASE_RETRY_SECONDS) });
const providerError = () => respond(502, { error: 'payment_provider_error' });
const internalError = () => respond(500, { error: 'internal_error' });

export async function handleCreateOrder(req: Request, deps: CreateOrderDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return respond(405, { error: 'method_not_allowed' });

  // 1. who is calling
  const token = bearerToken(req);
  const userId = token ? await deps.auth.getUserId(token) : null;
  if (!userId) return respond(401, { error: 'unauthorized' });

  // 2. which booking (nothing else from the body is used)
  let bookingId: string;
  let session: string;
  try {
    const raw = await readBodyLimited(req, MAX_BODY);
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (!isRecord(body) || typeof body.booking_id !== 'string' || !UUID.test(body.booking_id) ||
        typeof body.checkout_session !== 'string' || !UUID.test(body.checkout_session)) {
      return respond(400, { error: 'invalid_request' });
    }
    bookingId = body.booking_id;
    session = body.checkout_session.toLowerCase();
  } catch (e) {
    if (e instanceof BodyTooLarge) return respond(413, { error: 'request_too_large' });
    return respond(400, { error: 'invalid_request' });
  }

  // 3. server credentials present? (checked before anything is written)
  const razorpay = deps.razorpay;
  const keyId = deps.config.razorpay?.keyId;
  if (!razorpay || !keyId) {
    deps.log('create_order.not_configured', { booking_id: bookingId });
    return respond(503, { error: 'payments_unavailable' });
  }

  // 4. ownership, eligibility, amount, attempt (database)
  const prep = await deps.db.rpc<Record<string, unknown>>('payment_prepare_attempt', {
    p_booking_id: bookingId,
    p_user_id: userId,
  });
  if (!prep.ok || !isRecord(prep.data)) {
    deps.log('create_order.prepare_failed', { booking_id: bookingId, status: prep.ok ? 200 : prep.status });
    return internalError();
  }
  const p = prep.data;
  const action = p.action;
  const checkout = (attemptId: string) => handOut(deps, razorpay, keyId, bookingId, userId, attemptId, session);

  switch (action) {
    case 'not_found':
      return respond(404, { error: 'booking_not_found' });
    case 'free_booking':
      return respond(409, { error: 'booking_not_payable', reason: 'free_booking' });
    case 'not_payable':
      // Nothing was created or handed out (expired, too little hold
      // left, or not pending).
      return respond(409, { error: 'booking_not_payable', reason: notPayableReason(p.reason) });
    case 'in_progress': {
      const retry = typeof p.retry_after_seconds === 'number' ? p.retry_after_seconds : LEASE_RETRY_SECONDS;
      return respond(409, { error: 'order_creation_in_progress', retry_after_seconds: retry },
        { 'Retry-After': String(retry) });
    }
    case 'reuse':
      if (typeof p.attempt_id === 'string' && typeof p.provider_order_id === 'string' &&
          typeof p.amount_paise === 'number' && typeof p.currency === 'string') {
        return checkout(p.attempt_id);
      }
      return internalError();
    case 'create':
    case 'recover': {
      if (typeof p.attempt_id !== 'string' || typeof p.amount_paise !== 'number' ||
          typeof p.currency !== 'string' || typeof p.receipt !== 'string') {
        return internalError();
      }
      const attempt: Attempt = {
        attempt_id: p.attempt_id,
        amount_paise: p.amount_paise,
        currency: p.currency,
        receipt: p.receipt,
        booking_id: bookingId,
      };
      const flow = new OrderFlow(deps, razorpay, attempt);
      const result = action === 'create' ? await flow.create() : await flow.recover();
      if (result.kind === 'ok') {
        return checkout(attempt.attempt_id);
      }
      if (result.kind === 'not_payable') {
        return respond(409, { error: 'booking_not_payable', reason: result.reason });
      }
      if (result.kind === 'ambiguous') return providerUnavailable();
      if (result.kind === 'internal') return internalError();
      return providerError();
    }
    default:
      return internalError();
  }
}

// Hand the order out for Checkout, under the attempt's Checkout lease.
async function handOut(
  deps: CreateOrderDeps,
  razorpay: RazorpayClient,
  keyId: string,
  bookingId: string,
  userId: string,
  attemptId: string,
  session: string,
): Promise<Response> {
  const acquire = (verified: boolean) =>
    deps.db.rpc<Record<string, unknown>>('payment_acquire_checkout_lease', {
      p_booking_id: bookingId,
      p_user_id: userId,
      p_attempt_id: attemptId,
      p_session: session,
      p_no_payments_verified: verified,
    });
  const unavailable = (error: string) =>
    respond(503, { error, retry_after_seconds: RETRY_SECONDS }, { 'Retry-After': String(RETRY_SECONDS) });

  let r = await acquire(false);
  let acquiredAt = Date.now();
  if (!r.ok || !isRecord(r.data)) {
    // The lease may or may not have been granted: a retry with the same
    // session resolves it (it is then the holder).
    deps.log('create_order.lease_failed', { attempt_id: attemptId, status: r.ok ? 200 : r.status });
    return unavailable('temporarily_unavailable');
  }

  if (r.data.outcome === 'verify_required') {
    // The same session asks again: only continue when the provider shows
    // no payment at all on the order (a failed payment is not final).
    const orderId = r.data.provider_order_id;
    if (typeof orderId !== 'string') return internalError();
    const listed = await razorpay.fetchOrderPayments(orderId);
    if (listed.kind === 'error') {
      deps.log('create_order.lease_check_failed', { attempt_id: attemptId, reason: listed.reason, status: listed.status ?? null });
      return providerUnavailable();
    }
    if (listed.items.length > 0) {
      deps.log('create_order.lease_payment_exists', { attempt_id: attemptId, count: listed.items.length });
      return respond(409, { error: 'payment_may_exist', reason: 'payment_on_order' });
    }
    if (!listed.complete) return unavailable('temporarily_unavailable');
    r = await acquire(true);
    acquiredAt = Date.now();
    if (!r.ok || !isRecord(r.data)) {
      deps.log('create_order.lease_failed', { attempt_id: attemptId, status: r.ok ? 200 : r.status });
      return unavailable('temporarily_unavailable');
    }
  }

  const l = r.data;
  deps.log('create_order.lease', { attempt_id: attemptId, outcome: String(l.outcome), resumed: l.resumed === true ? 1 : 0 });
  switch (l.outcome) {
    case 'granted': {
      if (typeof l.provider_order_id !== 'string' || typeof l.amount_paise !== 'number' || typeof l.currency !== 'string') {
        return internalError();
      }
      const hold = typeof l.hold_seconds_remaining === 'number' && Number.isFinite(l.hold_seconds_remaining)
        ? Math.max(0, Math.floor(l.hold_seconds_remaining) - Math.ceil((Date.now() - acquiredAt) / 1000))
        : null;
      return respond(200, {
        attempt_id: attemptId,
        order_id: l.provider_order_id,
        amount_paise: l.amount_paise,
        currency: l.currency,
        key_id: keyId,
        hold_seconds_remaining: hold,
      });
    }
    case 'held': {
      const retry = typeof l.retry_after_seconds === 'number' ? l.retry_after_seconds : null;
      return respond(409, { error: 'checkout_in_progress', retry_after_seconds: retry });
    }
    case 'ended':
      return respond(409, { error: 'payment_may_exist', reason: 'checkout_session_ended' });
    case 'not_payable':
      return respond(409, { error: 'booking_not_payable', reason: notPayableReason(l.reason) });
    case 'attempt_not_open':
      return respond(409, { error: 'booking_not_payable', reason: 'attempt_closed' });
    case 'not_found':
      return respond(404, { error: 'booking_not_found' });
    default:
      // verify_required twice, or anything unknown: never hand the order out
      return internalError();
  }
}

type FlowResult =
  | { kind: 'ok'; orderId: string }
  | { kind: 'not_payable'; reason: string }
  | { kind: 'ambiguous' }
  | { kind: 'failed' }
  | { kind: 'internal' };

class OrderFlow {
  constructor(
    private readonly deps: CreateOrderDeps,
    private readonly razorpay: RazorpayClient,
    private readonly attempt: Attempt,
  ) {}

  private log(event: string, fields: Record<string, string | number | null> = {}) {
    this.deps.log(event, { attempt_id: this.attempt.attempt_id, ...fields });
  }

  private expected() {
    return { amount: this.attempt.amount_paise, currency: this.attempt.currency, receipt: this.attempt.receipt };
  }

  // Definitive failure: no order exists for this receipt. Close the
  // attempt so the next request starts a fresh one.
  private async close(reason: string): Promise<FlowResult> {
    const r = await this.deps.db.rpc<Record<string, unknown>>('payment_close_attempt', {
      p_attempt_id: this.attempt.attempt_id,
      p_reason: reason,
    });
    this.log('create_order.attempt_closed', { reason, outcome: r.ok && isRecord(r.data) ? String(r.data.outcome) : 'error' });
    return { kind: 'failed' };
  }

  // Record a validated order (write-once; re-validated in SQL).
  private async record(orderId: string, amount: number, currency: string, receipt: string): Promise<FlowResult> {
    const r = await this.deps.db.rpc<Record<string, unknown>>('payment_record_order', {
      p_attempt_id: this.attempt.attempt_id,
      p_provider_order_id: orderId,
      p_amount_paise: amount,
      p_currency: currency,
      p_receipt: receipt,
    });
    if (!r.ok || !isRecord(r.data)) {
      // The order exists at the provider but is not recorded yet. Keep
      // the attempt 'creating': the next request recovers it by receipt.
      this.log('create_order.record_failed', { status: r.ok ? 200 : r.status });
      return { kind: 'ambiguous' };
    }
    const outcome = r.data.outcome;
    this.log('create_order.recorded', { outcome: String(outcome), order_id: orderId });
    if (outcome === 'recorded' || outcome === 'already_recorded') return { kind: 'ok', orderId };
    // The booking stopped being payable while the provider call was in
    // flight: the database recorded the order (so a payment on it is
    // matched and settled as a late capture) and closed the attempt.
    // The order is NOT handed to the client.
    if (outcome === 'booking_not_payable') {
      return { kind: 'not_payable', reason: notPayableReason(r.data.reason) };
    }
    if (outcome === 'attempt_closed') return { kind: 'not_payable', reason: 'attempt_closed' };
    // conflict / mismatch / not_found: an integrity anomaly. The order is
    // NOT handed to the client; a payment on it would be stored unmatched.
    return { kind: 'failed' };
  }

  // Find the order created for this attempt (exact receipt match; the
  // provider's filter is documented as "contains").
  private async lookup(): Promise<{ kind: 'found'; order: unknown } | { kind: 'none' } | { kind: 'error' } | { kind: 'many' }> {
    const r = await this.razorpay.findOrdersByReceipt(this.attempt.receipt);
    if (r.kind !== 'ok') {
      this.log('create_order.lookup_failed', { reason: r.reason, status: r.status ?? null });
      return { kind: 'error' };
    }
    const exact = r.orders.filter((o) => isRecord(o) && o.receipt === this.attempt.receipt);
    if (exact.length === 0) return { kind: 'none' };
    if (exact.length > 1) return { kind: 'many' };
    return { kind: 'found', order: exact[0] };
  }

  private adopt(order: unknown): Promise<FlowResult> {
    const valid = validateOrder(order, this.expected());
    if (!valid) {
      // An order carries our receipt but not our amount/currency: never
      // record or hand it out. Payments on it will stay unmatched.
      this.log('create_order.order_mismatch');
      return this.close('order_response_mismatch');
    }
    return this.record(valid.id, valid.amount, valid.currency, this.attempt.receipt);
  }

  async create(): Promise<FlowResult> {
    const res = await this.razorpay.createOrder({
      amount: this.attempt.amount_paise,
      currency: this.attempt.currency,
      receipt: this.attempt.receipt,
      notes: { attempt_id: this.attempt.attempt_id, booking_id: this.attempt.booking_id },
    });

    switch (res.kind) {
      case 'created':
        return this.adopt(res.order);
      case 'ambiguous':
        this.log('create_order.ambiguous', { reason: res.reason, status: res.status ?? null });
        return { kind: 'ambiguous' };
      case 'duplicate_receipt':
      case 'rejected': {
        // A duplicate means an order with our receipt exists; any other
        // 400 might be an unrecognised duplicate. Look before deciding.
        const found = res.kind === 'duplicate_receipt' || res.status === 400 ? await this.lookup() : { kind: 'none' as const };
        if (found.kind === 'found') return this.adopt(found.order);
        if (found.kind === 'many') {
          this.log('create_order.multiple_orders_for_receipt');
          return { kind: 'failed' };
        }
        if (found.kind === 'error' || res.kind === 'duplicate_receipt') {
          // Exists (or might) but cannot be read right now.
          return { kind: 'ambiguous' };
        }
        this.log('create_order.rejected', { status: res.status });
        return this.close(res.status === 401 ? 'provider_auth_failed' : 'order_create_rejected');
      }
    }
  }

  // The lease of an earlier 'creating' attempt ran out: its provider
  // call may have created an order. Look it up first.
  async recover(): Promise<FlowResult> {
    const found = await this.lookup();
    if (found.kind === 'found') return this.adopt(found.order);
    if (found.kind === 'error') return { kind: 'ambiguous' };
    if (found.kind === 'many') {
      this.log('create_order.multiple_orders_for_receipt');
      return { kind: 'failed' };
    }
    // None visible: create with the SAME receipt. If the earlier call
    // did create one that is not yet listed, the provider rejects this
    // as a duplicate and the lookup is retried.
    return this.create();
  }
}
