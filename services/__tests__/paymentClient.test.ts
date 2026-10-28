import { describe, it, expect, vi } from 'vitest';
import {
  createPaymentClient,
  isPaymentElsewhere,
  isRetryable,
  withTimeout,
  CREATE_ORDER_FUNCTION,
  VERIFY_FUNCTION,
  type InvokeFn,
  type RawResponse
} from '../paymentClient';

const BOOKING = '22222222-2222-4222-8222-222222222222';
const PAY = 'pay_TESTPAY00001';
const SESSION = '44444444-4444-4444-8444-444444444444';

const ok = (body: unknown): RawResponse => ({ status: 200, body, retryAfter: null });
const http = (status: number, body: unknown, retryAfter: string | null = null): RawResponse => ({ status, body, retryAfter });

const ORDER = {
  attempt_id: '33333333-3333-4333-8333-333333333333',
  order_id: 'order_TESTORDER001',
  amount_paise: 50000,
  currency: 'INR',
  key_id: 'rzp_test_PUBLICKEY01',
  hold_seconds_remaining: 420
};

const OUTCOME = {
  booking_id: BOOKING,
  booking_status: 'confirmed',
  payment_status: 'captured',
  provider_refund: 'none',
  result: 'confirmed'
};

describe('paymentClient: requests carry identifiers only', () => {
  it('sends only the booking id and the checkout session to create-order and returns the server order', async () => {
    const invoke = vi.fn<InvokeFn>(async () => ok(ORDER));
    const r = await createPaymentClient(invoke).createOrder(BOOKING, SESSION);
    expect(invoke).toHaveBeenCalledWith(CREATE_ORDER_FUNCTION, { booking_id: BOOKING, checkout_session: SESSION });
    expect(r).toEqual({
      ok: true,
      value: { attemptId: ORDER.attempt_id, orderId: ORDER.order_id, amountPaise: 50000, currency: 'INR', keyId: ORDER.key_id, holdSecondsRemaining: 420 }
    });
  });

  it('sends only the booking id and payment id to verify (no user id, amount or signature)', async () => {
    const invoke = vi.fn<InvokeFn>(async () => ok(OUTCOME));
    await createPaymentClient(invoke).verify(BOOKING, PAY);
    expect(invoke).toHaveBeenCalledWith(VERIFY_FUNCTION, { booking_id: BOOKING, razorpay_payment_id: PAY });
  });

  it('never sends a malformed checkout session', async () => {
    const invoke = vi.fn<InvokeFn>(async () => ok(ORDER));
    expect(await createPaymentClient(invoke).createOrder(BOOKING, 'not-a-session')).toEqual({ ok: false, failure: { kind: 'malformed' } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('never sends a malformed payment id', async () => {
    const invoke = vi.fn<InvokeFn>(async () => ok(OUTCOME));
    const r = await createPaymentClient(invoke).verify(BOOKING, 'https://evil.example');
    expect(r.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('paymentClient: strict parsing (anything unexpected is a failure)', () => {
  it.each([
    ['a live key', { ...ORDER, key_id: 'rzp_live_ABCDEF' }],
    ['a non-INR currency', { ...ORDER, currency: 'USD' }],
    ['a zero amount', { ...ORDER, amount_paise: 0 }],
    ['a non-order id', { ...ORDER, order_id: 'pay_X' }],
    ['no body', null]
  ])('rejects an order with %s', async (_label, body) => {
    const r = await createPaymentClient(async () => ok(body)).createOrder(BOOKING, SESSION);
    expect(r).toEqual({ ok: false, failure: { kind: 'malformed' } });
  });

  it.each([
    ['an unknown result', { ...OUTCOME, result: 'success' }],
    ['a missing provider_refund', { ...OUTCOME, provider_refund: undefined }],
    ['another booking id', { ...OUTCOME, booking_id: '99999999-9999-4999-8999-999999999999' }]
  ])('rejects a verification answer with %s', async (_label, body) => {
    const r = await createPaymentClient(async () => ok(body)).verify(BOOKING, PAY);
    expect(r).toEqual({ ok: false, failure: { kind: 'malformed' } });
  });

  it('parses every contract result value', async () => {
    for (const result of ['confirmed', 'not_fulfilled', 'payment_failed', 'payment_pending']) {
      const r = await createPaymentClient(async () => ok({ ...OUTCOME, result })).verify(BOOKING, PAY);
      expect(r.ok && r.value.result).toBe(result);
    }
  });
});

describe('paymentClient: failures and retryability', () => {
  it('maps a missing answer to a retryable network failure', async () => {
    const r = await createPaymentClient(async () => ({ status: null, body: null, retryAfter: null })).verify(BOOKING, PAY);
    expect(r).toEqual({ ok: false, failure: { kind: 'network' } });
    expect(isRetryable({ kind: 'network' })).toBe(true);
  });

  it('keeps status, error, reason and a bounded Retry-After', async () => {
    const r = await createPaymentClient(async () =>
      http(503, { error: 'temporarily_unavailable', retry_after_seconds: 15 }, '9999')
    ).verify(BOOKING, PAY);
    expect(r).toEqual({
      ok: false,
      failure: { kind: 'http', status: 503, error: 'temporarily_unavailable', reason: null, retryAfterSeconds: 120 }
    });
  });

  it('treats 503, 429 and an order in progress as retryable, business answers as final', () => {
    const f = (status: number, error: string | null = null) =>
      ({ kind: 'http', status, error, reason: null, retryAfterSeconds: null }) as const;
    expect(isRetryable(f(503))).toBe(true);
    expect(isRetryable(f(429))).toBe(true);
    expect(isRetryable(f(409, 'order_creation_in_progress'))).toBe(true);
    expect(isRetryable(f(409, 'booking_not_payable'))).toBe(false);
    expect(isRetryable(f(409, 'payment_not_for_booking'))).toBe(false);
    expect(isRetryable(f(404, 'booking_not_found'))).toBe(false);
    expect(isRetryable(f(502, 'verification_failed'))).toBe(false);
    expect(isRetryable(f(401, 'unauthorized'))).toBe(false);
    expect(isRetryable({ kind: 'malformed' })).toBe(false);
  });
});

const RECOVERY = {
  booking_id: BOOKING,
  booking_status: 'pending_payment',
  mode: 'recovery',
  complete: true,
  result: 'payment_pending',
  razorpay_payment_id: PAY,
  payment_status: 'authorized',
  provider_refund: 'none',
  other_payments: [],
  checkout_lease: 'none'
};

describe('paymentClient: booking-based recovery', () => {
  it('sends only the booking id and the checkout session (no payment id) and parses the recovery answer', async () => {
    const invoke = vi.fn<InvokeFn>(async () => ok(RECOVERY));
    const r = await createPaymentClient(invoke).recover(BOOKING, SESSION);
    expect(invoke).toHaveBeenCalledWith(VERIFY_FUNCTION, { booking_id: BOOKING, checkout_session: SESSION });
    expect(r).toEqual({
      ok: true,
      value: {
        bookingId: BOOKING, bookingStatus: 'pending_payment', complete: true, result: 'payment_pending', paymentId: PAY,
        paymentStatus: 'authorized', providerRefund: 'none', otherPayments: [], checkoutLease: 'none'
      }
    });
  });

  it('accepts no_payment_found only from a complete inspection', async () => {
    const none = { ...RECOVERY, result: 'no_payment_found', razorpay_payment_id: null, payment_status: null, provider_refund: null };
    expect((await createPaymentClient(async () => ok(none)).recover(BOOKING, SESSION)).ok).toBe(true);
    const incomplete = { ...none, complete: false };
    expect(await createPaymentClient(async () => ok(incomplete)).recover(BOOKING, SESSION)).toEqual({ ok: false, failure: { kind: 'malformed' } });
  });

  it.each([
    ['an explicit-mode answer', { ...RECOVERY, mode: undefined }],
    ['another booking', { ...RECOVERY, booking_id: '99999999-9999-4999-8999-999999999999' }],
    ['no complete flag', { ...RECOVERY, complete: undefined }],
    ['a bad payment id', { ...RECOVERY, razorpay_payment_id: 'x' }]
  ])('rejects a recovery answer with %s', async (_l, body) => {
    expect(await createPaymentClient(async () => ok(body)).recover(BOOKING, SESSION)).toEqual({ ok: false, failure: { kind: 'malformed' } });
  });

  it('reports a missing or invalid hold as null (no invented value; the caller fails closed)', async () => {
    for (const hold of ['600', -5, Number.POSITIVE_INFINITY, null]) {
      const r = await createPaymentClient(async () => ok({ ...ORDER, hold_seconds_remaining: hold })).createOrder(BOOKING, SESSION);
      expect(r.ok && r.value.holdSecondsRemaining).toBe(null);
    }
  });

  it('keeps an order without a reported hold parseable, with null', async () => {
    const r = await createPaymentClient(async () => ok({ ...ORDER, hold_seconds_remaining: undefined })).createOrder(BOOKING, SESSION);
    expect(r.ok && r.value.holdSecondsRemaining).toBe(null);
  });
});

describe('paymentClient: bounded requests and lease refusals', () => {
  const fakeTimers = () => {
    const pending: (() => void)[] = [];
    let cleared = 0;
    return {
      fire: () => pending.splice(0).forEach(f => f()),
      cleared: () => cleared,
      timers: {
        setTimeout: ((fn: () => void) => { pending.push(fn); return pending.length; }) as unknown as typeof setTimeout,
        clearTimeout: (() => { cleared++; }) as typeof clearTimeout
      }
    };
  };

  it('a request that never answers becomes a retryable network failure after the timeout', async () => {
    const t = fakeTimers();
    const client = createPaymentClient(() => new Promise<never>(() => {}), 30_000, t.timers);
    const p = client.recover(BOOKING, SESSION);
    t.fire();
    const r = await p;
    expect(r).toEqual({ ok: false, failure: { kind: 'network' } });
    expect(isRetryable({ kind: 'network' })).toBe(true);
  });

  it('a timely answer cancels the timer, and a late answer after a timeout is ignored', async () => {
    const t = fakeTimers();
    let answer: ((r: RawResponse) => void) | undefined;
    const bounded = withTimeout(() => new Promise<RawResponse>(r => { answer = r; }), 1000, t.timers);
    const p = bounded(VERIFY_FUNCTION, { booking_id: BOOKING });
    t.fire();
    answer!(ok({}));
    expect(await p).toEqual({ status: null, body: null, retryAfter: null });
    const quick = withTimeout(async () => ok({ a: 1 }), 1000, t.timers);
    expect(await quick(VERIFY_FUNCTION, {})).toEqual(ok({ a: 1 }));
    expect(t.cleared()).toBe(1);
  });

  it('a transport that throws is "no answer", not a result', async () => {
    const r = await createPaymentClient(async () => { throw new Error('boom'); }).verify(BOOKING, PAY);
    expect(r).toEqual({ ok: false, failure: { kind: 'network' } });
  });

  it('checkout_in_progress and payment_may_exist are final and mean "a payment may be elsewhere"', async () => {
    for (const error of ['checkout_in_progress', 'payment_may_exist']) {
      const r = await createPaymentClient(async () => http(409, { error, retry_after_seconds: 300 })).createOrder(BOOKING, SESSION);
      expect(r.ok).toBe(false);
      const f = (r as { failure: Parameters<typeof isRetryable>[0] }).failure;
      expect(isRetryable(f)).toBe(false);
      expect(isPaymentElsewhere(f)).toBe(true);
    }
    expect(isPaymentElsewhere({ kind: 'http', status: 409, error: 'booking_not_payable', reason: 'hold_expired', retryAfterSeconds: null })).toBe(false);
    expect(isPaymentElsewhere({ kind: 'network' })).toBe(false);
  });
});

describe('paymentClient: recovery lease state and additional payments', () => {
  const none = { ...RECOVERY, result: 'no_payment_found', razorpay_payment_id: null, payment_status: null, provider_refund: null };
  const OTHER = {
    razorpay_payment_id: 'pay_TESTPAY00002',
    payment_status: 'captured',
    provider_refund: 'none',
    result: 'not_fulfilled',
    decision: 'duplicate_capture'
  };
  const recover = (body: unknown) => createPaymentClient(async () => ok(body)).recover(BOOKING, SESSION);

  it.each(['none', 'yours', 'other', 'ended'])('parses checkout_lease %s', async lease => {
    const r = await recover({ ...none, checkout_lease: lease });
    expect(r.ok && r.value.checkoutLease).toBe(lease);
  });

  it.each([['an unknown value', 'mine'], ['a missing value', undefined], ['a non-string', 1]])(
    'rejects %s for checkout_lease (fail closed)',
    async (_l, lease) => {
      expect(await recover({ ...none, checkout_lease: lease })).toEqual({ ok: false, failure: { kind: 'malformed' } });
    }
  );

  it('parses the additional payments with our stored decision', async () => {
    const r = await recover({ ...RECOVERY, result: 'confirmed', payment_status: 'captured', other_payments: [OTHER] });
    expect(r.ok && r.value.otherPayments).toEqual([
      { paymentId: 'pay_TESTPAY00002', paymentStatus: 'captured', providerRefund: 'none', result: 'not_fulfilled', decision: 'duplicate_capture' }
    ]);
  });

  it('accepts a payment without a decision label (pending, failed, or decided before labels existed)', async () => {
    const r = await recover({ ...RECOVERY, other_payments: [{ ...OTHER, result: 'payment_failed', payment_status: 'failed', decision: null }] });
    expect(r.ok && r.value.otherPayments[0].decision).toBe(null);
  });

  it.each([
    ['not an array', 'x'],
    ['missing', undefined],
    ['over the report bound', Array.from({ length: 11 }, (_, i) => ({ ...OTHER, razorpay_payment_id: `pay_X${i}` }))],
    ['the primary payment again', [{ ...OTHER, razorpay_payment_id: PAY }]],
    ['the same payment twice', [OTHER, OTHER]],
    ['a bad id', [{ ...OTHER, razorpay_payment_id: 'x' }]],
    ['a bad result', [{ ...OTHER, result: 'refunded' }]],
    ['a bad refund value', [{ ...OTHER, provider_refund: 'completed' }]],
    ['an unknown decision', [{ ...OTHER, decision: 'refunded' }]],
    ['an entry that is not an object', ['pay_X']]
  ])('rejects other_payments that are %s', async (_l, others) => {
    expect(await recover({ ...RECOVERY, other_payments: others })).toEqual({ ok: false, failure: { kind: 'malformed' } });
  });

  it('no_payment_found with any other payment listed is contradictory (malformed)', async () => {
    expect(await recover({ ...none, other_payments: [OTHER] })).toEqual({ ok: false, failure: { kind: 'malformed' } });
  });

  it('never sends a malformed checkout session with a recovery request', async () => {
    const invoke = vi.fn<InvokeFn>(async () => ok(none));
    expect(await createPaymentClient(invoke).recover(BOOKING, 'nope')).toEqual({ ok: false, failure: { kind: 'malformed' } });
    expect(invoke).not.toHaveBeenCalled();
  });
});

// Browsers (unlike Node) throw "Illegal invocation" when setTimeout or
// clearTimeout is called as a method of another object. These stubs
// enforce that rule, so the default timers are exercised as in a page.
function browserStrictTimers() {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const strictSet = function (this: unknown, cb: () => void, ms?: number) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return realSet(cb, ms);
  };
  const strictClear = function (this: unknown, id?: ReturnType<typeof setTimeout>) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return realClear(id);
  };
  vi.stubGlobal('setTimeout', strictSet);
  vi.stubGlobal('clearTimeout', strictClear);
  return () => vi.unstubAllGlobals();
}

describe('default timers under browser rules (regression: "Illegal invocation" in a real page)', () => {
  it('withTimeout with its default timers answers, and times out, without throwing', async () => {
    const restore = browserStrictTimers();
    try {
      const quick = withTimeout(async () => ({ status: 200, body: { a: 1 }, retryAfter: null }), 1000);
      await expect(quick('fn', {})).resolves.toEqual({ status: 200, body: { a: 1 }, retryAfter: null });
      const hanging = withTimeout(() => new Promise<RawResponse>(() => {}), 5);
      await expect(hanging('fn', {})).resolves.toEqual({ status: null, body: null, retryAfter: null });
    } finally {
      restore();
    }
  });

  it('the default payment client makes its call under browser rules', async () => {
    const restore = browserStrictTimers();
    try {
      const invoke = vi.fn<InvokeFn>(async () => ({ status: 503, body: { error: 'temporarily_unavailable' }, retryAfter: null }));
      const r = await createPaymentClient(invoke).recover(BOOKING, '44444444-4444-4444-8444-444444444444');
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(r.ok).toBe(false);
    } finally {
      restore();
    }
  });
});
