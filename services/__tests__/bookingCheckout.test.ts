import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createBookingCheckout,
  describeCheckout,
  describeOutcome,
  hasUnresolvedPayment,
  newCheckoutCertainlyRefused,
  onBookingPaymentChange,
  resetCheckoutRecordsForTests,
  AUTO_RETRY_ATTEMPTS,
  MAX_MANUAL_CHECKS,
  type CheckoutDeps,
  type Outcome
} from '../bookingCheckout';
import { createPaymentClient } from '../paymentClient';
import type { ApiResult, CheckoutOrder, PaymentClient, RecoveryOutcome, VerifyOutcome } from '../paymentClient';
import type { CheckoutDetails, CheckoutEnd, RazorpayConstructor } from '../razorpayCheckout';

const BOOKING = '22222222-2222-4222-8222-222222222222';
const SESSION = '44444444-4444-4444-8444-444444444444';
const KEY = 'rzp_test_PUBLICKEY01';
const ORDER: CheckoutOrder = {
  attemptId: '33333333-3333-4333-8333-333333333333',
  orderId: 'order_TESTORDER001',
  amountPaise: 50000,
  currency: 'INR',
  keyId: KEY,
  holdSecondsRemaining: 500
};

const verified = (over: Partial<VerifyOutcome> = {}): ApiResult<VerifyOutcome> => ({
  ok: true,
  value: { bookingId: BOOKING, bookingStatus: 'confirmed', paymentStatus: 'captured', providerRefund: 'none', result: 'confirmed', ...over }
});
const recovered = (over: Partial<RecoveryOutcome> = {}): ApiResult<RecoveryOutcome> => ({
  ok: true,
  value: {
    bookingId: BOOKING, bookingStatus: 'pending_payment', complete: true, result: 'no_payment_found',
    paymentId: null, paymentStatus: null, providerRefund: null, otherPayments: [], checkoutLease: 'none', ...over
  }
});
const unavailable = { ok: false as const, failure: { kind: 'http' as const, status: 503, error: 'temporarily_unavailable', reason: null, retryAfterSeconds: 2 } };
const network = { ok: false as const, failure: { kind: 'network' as const } };

function setup(opts: {
  verify?: (n: number) => ApiResult<VerifyOutcome>;
  recover?: (n: number) => ApiResult<RecoveryOutcome>;
  createOrder?: () => ApiResult<CheckoutOrder>;
  end?: CheckoutEnd;
  open?: (details: CheckoutDetails) => Promise<CheckoutEnd>;
  loadCheckout?: () => Promise<RazorpayConstructor>;
  now?: () => number;
  configOk?: boolean;
} = {}) {
  let nv = 0;
  let nr = 0;
  const client: PaymentClient = {
    createOrder: vi.fn(async () => (opts.createOrder ? opts.createOrder() : { ok: true as const, value: ORDER })),
    verify: vi.fn(async () => opts.verify ? opts.verify(++nv) : verified()),
    recover: vi.fn(async () => opts.recover ? opts.recover(++nr) : recovered())
  };
  const openCheckout = vi.fn<CheckoutDeps['openCheckout']>(async (_R, _o, details) =>
    opts.open ? opts.open(details) : opts.end ?? ({ kind: 'completed', paymentId: 'pay_PAID0001' } as CheckoutEnd));
  const deps: CheckoutDeps = {
    client,
    config: opts.configOk === false ? { ok: false, reason: 'Online payment is not configured.' } : { ok: true, keyId: KEY },
    loadCheckout: vi.fn(opts.loadCheckout ?? (async () => function () {} as unknown as RazorpayConstructor)),
    openCheckout,
    sleep: vi.fn(async () => {}),
    now: opts.now ?? (() => 0),
    newSessionId: () => SESSION
  };
  return { checkout: createBookingCheckout(BOOKING, deps), client, openCheckout, deps };
}

const title = (c: { state(): never } | ReturnType<typeof createBookingCheckout>) =>
  describeCheckout((c as ReturnType<typeof createBookingCheckout>).state())?.title;

beforeEach(() => resetCheckoutRecordsForTests());

// What a reload followed by "Check payment" looks like: this page has an unresolved
// record (e.g. from a previous panel) and the user presses "Check payment status".
function markPaymentUnresolvedForTest() {
  const { checkout: seed } = setup({ end: { kind: 'dismissed', lastFailedPaymentId: null } });
  return seed.pay();
}

describe('pay: the booking is checked on the server before any new payment', () => {
  it('checks the booking first, then creates the order, opens Checkout and verifies the payment', async () => {
    const { checkout, client, openCheckout } = setup();
    await checkout.pay();
    expect(client.recover).toHaveBeenCalledWith(BOOKING, SESSION);
    expect(client.createOrder).toHaveBeenCalledWith(BOOKING, SESSION);
    expect(openCheckout).toHaveBeenCalledTimes(1);
    expect(client.verify).toHaveBeenCalledWith(BOOKING, 'pay_PAID0001');
    expect(title(checkout)).toBe('Booking confirmed');
    expect(hasUnresolvedPayment(BOOKING)).toBe(false);
  });

  it('opens Checkout with a timeout that ends before the hold (server-relative)', async () => {
    const { checkout, openCheckout } = setup();
    await checkout.pay();
    expect(openCheckout.mock.calls[0][2]).toMatchObject({ description: 'Court booking', timeoutSeconds: 440 });
  });

  it('refuses to open Checkout when too little hold is left', async () => {
    const { checkout, openCheckout } = setup({ createOrder: () => ({ ok: true, value: { ...ORDER, holdSecondsRemaining: 100 } }) });
    await checkout.pay();
    expect(openCheckout).not.toHaveBeenCalled();
    expect(title(checkout)).toBe('This booking cannot be paid');
  });

  it('never starts a new payment when the booking check finds a pending or captured payment', async () => {
    for (const result of ['payment_pending', 'not_fulfilled', 'confirmed'] as const) {
      resetCheckoutRecordsForTests();
      const { checkout, client, openCheckout } = setup({
        recover: () => recovered({ result, paymentId: 'pay_EARLIER01', paymentStatus: 'captured', providerRefund: 'none' })
      });
      await checkout.pay();
      expect(client.createOrder).not.toHaveBeenCalled();
      expect(openCheckout).not.toHaveBeenCalled();
      expect(checkout.canPay()).toBe(false);
    }
  });

  it('never starts a new payment when the booking check is incomplete or fails', async () => {
    const partial = setup({ recover: () => recovered({ result: 'payment_failed', complete: false, paymentId: 'pay_F1', paymentStatus: 'failed', providerRefund: 'none' }) });
    await partial.checkout.pay();
    expect(partial.client.createOrder).not.toHaveBeenCalled();
    resetCheckoutRecordsForTests();
    const failing = setup({ recover: () => network });
    await failing.checkout.pay();
    expect(failing.client.recover).toHaveBeenCalledTimes(AUTO_RETRY_ATTEMPTS);
    expect(failing.client.createOrder).not.toHaveBeenCalled();
    expect(title(failing.checkout)).toBe('We could not check the payment yet');
  });

  it('P1-1: a COMPLETE check that found only a failed payment never starts a new payment', async () => {
    const { checkout, client, openCheckout } = setup({
      recover: () => recovered({ result: 'payment_failed', paymentId: 'pay_F1', paymentStatus: 'failed', providerRefund: 'none' })
    });
    await checkout.pay();
    expect(client.createOrder).not.toHaveBeenCalled();
    expect(openCheckout).not.toHaveBeenCalled();
    expect(hasUnresolvedPayment(BOOKING)).toBe(true);
    expect(checkout.canPay()).toBe(false);
    expect(checkout.canCheckStatus()).toBe(true);
  });
});

describe('outcomes (explicit payment id after Checkout)', () => {
  it('1. confirms only for the fulfilling payment', async () => {
    const { checkout } = setup();
    await checkout.pay();
    expect(title(checkout)).toBe('Booking confirmed');
    expect(checkout.canPay()).toBe(false);
  });

  it('2. a duplicate capture (booking confirmed by another payment) is never shown as confirmed', async () => {
    const { checkout } = setup({ verify: () => verified({ result: 'not_fulfilled', bookingStatus: 'confirmed' }) });
    await checkout.pay();
    const m = describeCheckout(checkout.state())!;
    expect(m.title).toBe('Booking not confirmed by this payment');
    expect(m.lines.join(' ')).toMatch(/confirmed by another payment\. This payment did not confirm it/);
    expect(checkout.canPay()).toBe(false);
    expect(hasUnresolvedPayment(BOOKING)).toBe(true);
  });

  it('3. a late capture says the payment may have been received, unresolved, and offers no payment', async () => {
    const { checkout } = setup({ verify: () => verified({ result: 'not_fulfilled', bookingStatus: 'expired' }) });
    await checkout.pay();
    const text = describeCheckout(checkout.state())!.lines.join(' ');
    expect(text).toMatch(/may have been received.*Refunds are not yet handled automatically/);
    expect(text).not.toMatch(/refund (is )?(pending|requested|initiated|in progress)/i);
    expect(checkout.canPay()).toBe(false);
  });

  it('4. payment pending offers a bounded booking check, never a new payment', async () => {
    const { checkout, client } = setup({
      verify: () => verified({ result: 'payment_pending', bookingStatus: 'pending_payment', paymentStatus: 'authorized' }),
      recover: n => n === 1 ? recovered() : recovered({ result: 'payment_pending', paymentId: 'pay_PAID0001', paymentStatus: 'authorized', providerRefund: 'none' })
    });
    await checkout.pay();
    expect(title(checkout)).toBe('Payment pending');
    expect(checkout.canPay()).toBe(false);
    let checks = 0;
    while (checkout.canCheckStatus()) {
      await checkout.checkStatus();
      checks++;
    }
    expect(checks).toBe(MAX_MANUAL_CHECKS);
    expect(client.createOrder).toHaveBeenCalledTimes(1);
    expect(checkout.canPay()).toBe(false);
  });

  it('5. a provider-reported failure does not immediately offer another payment', async () => {
    const { checkout, client } = setup({
      verify: () => verified({ result: 'payment_failed', bookingStatus: 'pending_payment', paymentStatus: 'failed' }),
      recover: n => n === 1 ? recovered() : recovered({ result: 'payment_failed', paymentId: 'pay_PAID0001', paymentStatus: 'failed', providerRefund: 'none' })
    });
    await checkout.pay();
    expect(title(checkout)).toBe('Payment reported as failed');
    expect(checkout.canPay()).toBe(false);
    expect(checkout.canCheckStatus()).toBe(true);
    // P1-1: even a COMPLETE booking check showing only that failed payment
    // keeps it unresolved: a failed payment can still be authorized later
    await checkout.checkStatus();
    const m = describeCheckout(checkout.state())!;
    expect(m.title).toBe('A failed payment was found');
    expect(m.lines.join(' ')).toMatch(/can occasionally still go through, so a new payment cannot be started/);
    expect(m.lines.join(' ')).not.toMatch(/try paying again|refund(ed)? (is|was|has been)/i);
    expect(checkout.canPay()).toBe(false);
    expect(hasUnresolvedPayment(BOOKING)).toBe(true);
    expect(checkout.canCheckStatus()).toBe(true);
    expect(client.createOrder).toHaveBeenCalledTimes(1);
  });

  it('6. partial and full provider refunds are flagged, never shown as an uncomplicated success', () => {
    const base: Outcome = { source: 'payment', result: 'confirmed', complete: true, bookingStatus: 'confirmed', paymentId: 'pay_X', paymentStatus: 'captured', providerRefund: 'full', otherPayments: [], checkoutLease: null };
    expect(describeOutcome(base).title).toBe('Booking confirmed, refund observed');
    expect(describeOutcome({ ...base, providerRefund: 'partial' }).lines.join(' ')).toMatch(/part of it refunded/);
    expect(describeOutcome({ ...base, result: 'not_fulfilled', bookingStatus: 'expired', providerRefund: 'partial' }).lines.join(' '))
      .toMatch(/partial refund.*not yet being refunded automatically/);
    expect(describeOutcome({ ...base, result: 'not_fulfilled', bookingStatus: 'expired', providerRefund: 'full' }).lines.join(' '))
      .toMatch(/fully refunded.*does not confirm the money has reached your account/);
  });
});

describe('ambiguity and recovery', () => {
  it('7. a verification timeout after Checkout keeps the payment unresolved and offers a booking check, not a payment', async () => {
    const { checkout, client } = setup({ verify: () => network });
    await checkout.pay();
    expect(client.verify).toHaveBeenCalledTimes(AUTO_RETRY_ATTEMPTS);
    const m = describeCheckout(checkout.state())!;
    expect(m.title).toBe('We could not check the payment yet');
    expect(m.lines.join(' ')).toMatch(/Do not pay again/);
    expect(hasUnresolvedPayment(BOOKING)).toBe(true);
    expect(checkout.canPay()).toBe(false);
    expect(checkout.canCheckStatus()).toBe(true);
  });

  it('7b. the booking check then confirms it without the payment id', async () => {
    const { checkout, client } = setup({
      verify: () => network,
      recover: n => n === 1 ? recovered() : recovered({ result: 'confirmed', bookingStatus: 'confirmed', paymentId: 'pay_PAID0001', paymentStatus: 'captured', providerRefund: 'none' })
    });
    await checkout.pay();
    await checkout.checkStatus();
    expect(client.recover).toHaveBeenLastCalledWith(BOOKING, SESSION);
    expect(title(checkout)).toBe('Booking confirmed');
    expect(hasUnresolvedPayment(BOOKING)).toBe(false);
  });

  it('7c. retries are bounded and never become success', async () => {
    const { checkout, client } = setup({ verify: () => unavailable, recover: n => n === 1 ? recovered() : unavailable });
    await checkout.pay();
    while (checkout.canCheckStatus()) await checkout.checkStatus();
    expect(client.recover).toHaveBeenCalledTimes(1 + MAX_MANUAL_CHECKS * AUTO_RETRY_ATTEMPTS);
    expect(checkout.canPay()).toBe(false);
    expect(hasUnresolvedPayment(BOOKING)).toBe(true);
    expect(title(checkout)).not.toMatch(/confirmed/i);
  });

  it('12a. a dismissed Checkout stays unresolved: booking check offered, no new payment', async () => {
    const { checkout, client } = setup({ end: { kind: 'dismissed', lastFailedPaymentId: null } });
    await checkout.pay();
    const m = describeCheckout(checkout.state())!;
    expect(m.title).toBe('Payment window closed');
    expect(m.lines.join(' ')).toMatch(/does not mean no payment was made/);
    expect(hasUnresolvedPayment(BOOKING)).toBe(true);
    expect(checkout.canPay()).toBe(false);
    expect(checkout.canCheckStatus()).toBe(true);
    expect(client.verify).not.toHaveBeenCalled();
  });

  it('12b. a Checkout that never reports back (watchdog) is treated like a dismissal, never as failure', async () => {
    const { checkout } = setup({ end: { kind: 'dismissed', lastFailedPaymentId: null, watchdog: true } });
    await checkout.pay();
    expect(title(checkout)).toBe('The payment window did not respond');
    expect(hasUnresolvedPayment(BOOKING)).toBe(true);
    expect(checkout.canPay()).toBe(false);
  });

  it('12c. a dismissal after a failed attempt verifies that payment instead of assuming anything', async () => {
    const { checkout, client } = setup({
      end: { kind: 'dismissed', lastFailedPaymentId: 'pay_FAILED001' },
      verify: () => verified({ result: 'payment_failed', bookingStatus: 'pending_payment', paymentStatus: 'failed' })
    });
    await checkout.pay();
    expect(client.verify).toHaveBeenCalledWith(BOOKING, 'pay_FAILED001');
    expect(checkout.canPay()).toBe(false);
  });

  it('12d. a non-retryable verification error does not claim the payment failed', async () => {
    const { checkout } = setup({ verify: () => ({ ok: false, failure: { kind: 'http', status: 502, error: 'verification_failed', reason: null, retryAfterSeconds: null } }) });
    await checkout.pay();
    const m = describeCheckout(checkout.state())!;
    expect(m.title).toBe('The payment could not be verified');
    expect(m.lines.join(' ')).toMatch(/does not mean it failed/);
    expect(checkout.canPay()).toBe(false);
    expect(checkout.canCheckStatus()).toBe(true);
  });
});

describe('UI instances in one page', () => {
  it('9. a double click or a second panel starts one flow only', async () => {
    const a = setup();
    const second = createBookingCheckout(BOOKING, a.deps);
    await Promise.all([a.checkout.pay(), a.checkout.pay(), second.pay()]);
    expect(a.client.createOrder).toHaveBeenCalledTimes(1);
    expect(a.openCheckout).toHaveBeenCalledTimes(1);
  });

  it('11. a second panel cannot start Checkout while another panel has an unresolved payment', async () => {
    const first = setup({ end: { kind: 'dismissed', lastFailedPaymentId: null } });
    await first.checkout.pay();
    const second = createBookingCheckout(BOOKING, first.deps);
    expect(second.state().phase).toBe('unresolved');
    expect(second.canPay()).toBe(false);
    await second.pay();
    expect(first.client.createOrder).toHaveBeenCalledTimes(1);
    expect(first.openCheckout).toHaveBeenCalledTimes(1);
  });

  it('13. a recreated panel recovers the status without the payment id, then allows paying when nothing is live', async () => {
    const first = setup({
      end: { kind: 'dismissed', lastFailedPaymentId: null },
      recover: n => recovered()
    });
    await first.checkout.pay();
    const recreated = createBookingCheckout(BOOKING, first.deps);
    expect(recreated.canPay()).toBe(false);
    await recreated.checkStatus();
    expect(title(recreated)).toBe('No payment found for this booking');
    expect(describeCheckout(recreated.state())!.lines.join(' ')).toMatch(/still being processed can appear later/);
    expect(hasUnresolvedPayment(BOOKING)).toBe(false);
    expect(recreated.canPay()).toBe(true);
  });

  it('announces authoritative answers so the bookings list can refresh after an unmount', async () => {
    const seen: string[] = [];
    const off = onBookingPaymentChange(id => seen.push(id));
    const { checkout } = setup();
    await checkout.pay();
    off();
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([BOOKING]));
  });
});

describe('configuration', () => {
  it('8a. without a test key nothing is requested and Checkout never opens', async () => {
    const { checkout, client, openCheckout } = setup({ configOk: false });
    expect(checkout.state().phase).toBe('unavailable');
    await checkout.pay();
    await checkout.checkStatus();
    expect(client.recover).not.toHaveBeenCalled();
    expect(client.createOrder).not.toHaveBeenCalled();
    expect(openCheckout).not.toHaveBeenCalled();
  });

  it('8b. a server key that is not the configured test key never opens Checkout', async () => {
    const { checkout, openCheckout } = setup({ createOrder: () => ({ ok: true, value: { ...ORDER, keyId: 'rzp_test_SOMEOTHERKEY' } }) });
    await checkout.pay();
    expect(openCheckout).not.toHaveBeenCalled();
    expect(title(checkout)).toBe('Payment unavailable');
    expect(hasUnresolvedPayment(BOOKING)).toBe(false);
  });

  it('a definite order refusal (hold expired) is final', async () => {
    const { checkout, openCheckout } = setup({
      createOrder: () => ({ ok: false, failure: { kind: 'http', status: 409, error: 'booking_not_payable', reason: 'hold_expired', retryAfterSeconds: null } })
    });
    await checkout.pay();
    expect(describeCheckout(checkout.state())!.lines[0]).toMatch(/hold on this slot has expired/);
    expect(checkout.canPay()).toBe(false);
    expect(openCheckout).not.toHaveBeenCalled();
  });
});

describe('server-enforced Checkout lease (P1-2)', () => {
  const refusal = (error: string, reason: string | null = null) => () =>
    ({ ok: false as const, failure: { kind: 'http' as const, status: 409, error, reason, retryAfterSeconds: null } });

  it('another session holding the order: no Checkout, unresolved, only a status check offered', async () => {
    const { checkout, client, openCheckout } = setup({ createOrder: refusal('checkout_in_progress') });
    await checkout.pay();
    expect(openCheckout).not.toHaveBeenCalled();
    const m = describeCheckout(checkout.state())!;
    expect(m.title).toBe('A payment is already in progress');
    expect(m.lines.join(' ')).toMatch(/another window, on another device, or before this page was reloaded/);
    expect(hasUnresolvedPayment(BOOKING)).toBe(true);
    expect(checkout.canPay()).toBe(false);
    expect(checkout.canCheckStatus()).toBe(true);
    expect(client.createOrder).toHaveBeenCalledTimes(1);
  });

  it('a payment that may exist on the order (or an ended lease) blocks a new payment too', async () => {
    for (const reason of ['payment_on_order', 'checkout_session_ended']) {
      resetCheckoutRecordsForTests();
      const { checkout, openCheckout } = setup({ createOrder: refusal('payment_may_exist', reason) });
      await checkout.pay();
      expect(openCheckout).not.toHaveBeenCalled();
      expect(title(checkout)).toBe('A payment may already exist');
      expect(hasUnresolvedPayment(BOOKING)).toBe(true);
      expect(checkout.canPay()).toBe(false);
    }
  });

  it('the same page re-sends the same checkout session (retries and recreated panels)', async () => {
    let n = 0;
    const first = setup({ createOrder: () => (++n === 1 ? network : { ok: true, value: ORDER }) });
    await first.checkout.pay();
    expect(title(first.checkout)).toBe('Could not start the payment');
    const again = createBookingCheckout(BOOKING, { ...first.deps, newSessionId: () => '55555555-5555-4555-8555-555555555555' });
    await again.pay();
    expect(vi.mocked(first.client.createOrder).mock.calls.map(c => c[1])).toEqual([SESSION, SESSION]);
  });
});

describe('Checkout lifecycle safeguards', () => {
  it('watchdog: a Checkout that never reported back stays recoverable (status check, no new payment)', async () => {
    const { checkout } = setup({ end: { kind: 'dismissed', lastFailedPaymentId: null, watchdog: true } });
    await checkout.pay();
    expect(describeCheckout(checkout.state())!.lines.join(' ')).toMatch(/It was closed\. .*does not mean no payment was made/);
    expect(checkout.canCheckStatus()).toBe(true);
    expect(checkout.canPay()).toBe(false);
  });

  it('a late success callback of the current Checkout is verified with the server, never dropped', async () => {
    let late: ((id: string) => void) | undefined;
    const { checkout, client } = setup({
      open: async d => {
        late = d.onLateSuccess;
        return { kind: 'dismissed', lastFailedPaymentId: null, watchdog: true };
      }
    });
    await checkout.pay();
    expect(client.verify).not.toHaveBeenCalled();
    late!('pay_LATE0001');
    await vi.waitFor(() => expect(title(checkout)).toBe('Booking confirmed'));
    expect(client.verify).toHaveBeenCalledWith(BOOKING, 'pay_LATE0001');
    expect(hasUnresolvedPayment(BOOKING)).toBe(false);
  });

  it('a callback from an OBSOLETE Checkout cannot change a newer flow', async () => {
    const lates: ((id: string) => void)[] = [];
    let release: ((e: CheckoutEnd) => void) | undefined;
    let opens = 0;
    const { checkout, client } = setup({
      open: d => {
        lates.push(d.onLateSuccess!);
        if (++opens === 1) return Promise.resolve({ kind: 'dismissed', lastFailedPaymentId: null, watchdog: true } as CheckoutEnd);
        return new Promise<CheckoutEnd>(r => { release = r; });
      }
    });
    await checkout.pay();
    await checkout.checkStatus(); // complete "no payment found": the way is clear
    const second = checkout.pay();
    await vi.waitFor(() => expect(checkout.state().phase).toBe('checkout_open'));
    lates[0]('pay_OLDCHECKOUT1');
    await Promise.resolve();
    expect(checkout.state().phase).toBe('checkout_open');
    expect(client.verify).not.toHaveBeenCalled();
    expect(hasUnresolvedPayment(BOOKING)).toBe(true);
    release!({ kind: 'completed', paymentId: 'pay_NEWER00001' });
    await second;
    expect(vi.mocked(client.verify).mock.calls.map(c => c[1])).toEqual(['pay_NEWER00001']);
    // even once idle, the obsolete Checkout's callback is not verified by it
    lates[0]('pay_OLDCHECKOUT1');
    await Promise.resolve();
    expect(client.verify).toHaveBeenCalledTimes(1);
  });

  it('time spent after the order arrived is subtracted: Checkout cannot outlive the hold', async () => {
    const clock = [0, 400_000]; // order received at 0 s, about to open at 400 s
    const { checkout, openCheckout } = setup({ now: () => clock.shift() ?? 400_000 });
    await checkout.pay();
    expect(openCheckout).not.toHaveBeenCalled();
    expect(title(checkout)).toBe('This booking cannot be paid');
  });

  it('checkout.js is loaded (bounded) BEFORE the order is requested; a failed or slow load takes no order', async () => {
    const { checkout, client, openCheckout } = setup({ loadCheckout: async () => { throw new Error('took too long'); } });
    await checkout.pay();
    expect(client.createOrder).not.toHaveBeenCalled();
    expect(openCheckout).not.toHaveBeenCalled();
    expect(title(checkout)).toBe('Checkout could not be loaded');
    expect(checkout.canPay()).toBe(true);
  });

  it('a missing hold from the server fails closed: Checkout is not opened', async () => {
    const { checkout, openCheckout } = setup({ createOrder: () => ({ ok: true, value: { ...ORDER, holdSecondsRemaining: null } }) });
    await checkout.pay();
    expect(openCheckout).not.toHaveBeenCalled();
    expect(title(checkout)).toBe('Payment could not be started');
    expect(checkout.canPay()).toBe(false);
  });

  it('a hung request ends in a recoverable state (bounded, not busy, status check offered)', async () => {
    const immediate = {
      setTimeout: ((fn: () => void) => { Promise.resolve().then(fn); return 0; }) as unknown as typeof setTimeout,
      clearTimeout: (() => {}) as typeof clearTimeout
    };
    const hung = () => new Promise<never>(() => {});
    const client = createPaymentClient(hung, 30_000, immediate);
    const base = setup();
    const checkout = createBookingCheckout(BOOKING, { ...base.deps, client });
    await checkout.pay();
    expect(checkout.state().phase).toBe('check_error');
    expect(checkout.canCheckStatus()).toBe(true);
    expect(describeCheckout(checkout.state())!.title).toBe('We could not check the payment yet');
    await checkout.checkStatus();
    expect(checkout.state().phase).toBe('check_error');
    expect(base.openCheckout).not.toHaveBeenCalled();
  });
});

const recoveredWith = (over: Partial<RecoveryOutcome>) => () => recovered(over);
const PAY2 = 'pay_EXTRA00002';
const extra = (over: Partial<RecoveryOutcome['otherPayments'][number]> = {}) => ({
  paymentId: PAY2, paymentStatus: 'captured', providerRefund: 'none' as const, result: 'not_fulfilled' as const,
  decision: 'duplicate_capture' as const, ...over
});
const confirmedWith = (over: Partial<RecoveryOutcome> = {}) =>
  recovered({ result: 'confirmed', bookingStatus: 'confirmed', paymentId: 'pay_PAID0001', paymentStatus: 'captured', providerRefund: 'none', ...over });

describe('recovery understands the Checkout lease (Issue 1)', () => {
  it('1. no_payment_found while ANOTHER session holds the lease: unresolved, no payment offered, no order requested', async () => {
    const { checkout, client, openCheckout } = setup({ recover: recoveredWith({ checkoutLease: 'other' }) });
    await checkout.pay();
    expect(client.recover).toHaveBeenCalledTimes(1);
    expect(client.createOrder).not.toHaveBeenCalled();
    expect(openCheckout).not.toHaveBeenCalled();
    const m = describeCheckout(checkout.state())!;
    expect(m.title).toBe('A payment window may be open elsewhere');
    const text = m.lines.join(' ');
    expect(text).not.toMatch(/You can pay/);
    expect(text).toMatch(/No payment was found right now/);
    expect(text).toMatch(/cannot be started for this hold/);
    expect(hasUnresolvedPayment(BOOKING)).toBe(true);
    expect(checkout.canPay()).toBe(false);
    expect(checkout.canCheckStatus()).toBe(true);
  });

  it('1b. no payment is inferred from the lease alone', async () => {
    const { checkout } = setup({ recover: recoveredWith({ checkoutLease: 'other' }) });
    await checkout.pay();
    const o = (checkout.state() as { outcome: { result: string; paymentId: string | null } }).outcome;
    expect([o.result, o.paymentId]).toEqual(['no_payment_found', null]);
    expect(describeCheckout(checkout.state())!.lines.join(' ')).toMatch(/can appear later/);
  });

  it('1c. an ended lease also blocks, and says a payment may still appear', async () => {
    const { checkout, client } = setup({ recover: recoveredWith({ checkoutLease: 'ended' }) });
    await checkout.pay();
    expect(client.createOrder).not.toHaveBeenCalled();
    const m = describeCheckout(checkout.state())!;
    expect(m.title).toBe('An earlier payment window has ended');
    expect(m.lines.join(' ')).toMatch(/payment still being processed can appear later/);
    expect(m.lines.join(' ')).not.toMatch(/You can pay/);
    expect(checkout.canPay()).toBe(false);
  });

  it('1d. only none / yours (nothing held, or held by THIS page) clears the way', async () => {
    for (const lease of ['none', 'yours'] as const) {
      resetCheckoutRecordsForTests();
      const { checkout, client } = setup({ recover: recoveredWith({ checkoutLease: lease }) });
      await checkout.pay();
      expect(client.createOrder).toHaveBeenCalledTimes(1);
    }
  });

  it('1e. a status check that shows another session\'s lease keeps the record and offers no payment', async () => {
    const { checkout } = setup({ end: { kind: 'dismissed', lastFailedPaymentId: null }, recover: n => n === 1 ? recovered() : recovered({ checkoutLease: 'other' }) });
    await checkout.pay(); // own Checkout dismissed
    await checkout.checkStatus();
    expect(hasUnresolvedPayment(BOOKING)).toBe(true);
    expect(checkout.canPay()).toBe(false);
    expect(title(checkout)).toBe('A payment window may be open elsewhere');
  });

  it('1f. a recovery request always carries this page\'s checkout session', async () => {
    const { checkout, client } = setup({ recover: recoveredWith({ checkoutLease: 'other' }) });
    await checkout.pay();
    await checkout.checkStatus();
    expect(vi.mocked(client.recover).mock.calls.map(c => c[1])).toEqual([SESSION, SESSION]);
  });

  it('2. a create-order refusal cannot be unlocked by a later "no payment found / lease none" answer', async () => {
    for (const error of ['checkout_in_progress', 'payment_may_exist']) {
      resetCheckoutRecordsForTests();
      const refusal = () => ({ ok: false as const, failure: { kind: 'http' as const, status: 409, error, reason: null, retryAfterSeconds: null } });
      const { checkout, client, openCheckout, deps } = setup({ createOrder: refusal }); // recovery keeps saying none/none
      await checkout.pay();
      expect(hasUnresolvedPayment(BOOKING)).toBe(true);
      await checkout.checkStatus(); // genuine-looking answer: no payment, lease none
      expect(hasUnresolvedPayment(BOOKING)).toBe(true);
      expect(checkout.canPay()).toBe(false);
      const m = describeCheckout(checkout.state())!;
      expect(m.title).toBe('A payment window may be open elsewhere');
      expect(m.lines.join(' ')).not.toMatch(/You can pay/);
      // a second panel in this page is blocked too, and a click does nothing
      const second = createBookingCheckout(BOOKING, deps);
      expect(second.state().phase).toBe('unresolved');
      await second.pay();
      expect(client.createOrder).toHaveBeenCalledTimes(1);
      expect(openCheckout).not.toHaveBeenCalled();
    }
  });

  it('2b. after a reload the server\'s lease state takes over: no order is even requested', async () => {
    const refusal = () => ({ ok: false as const, failure: { kind: 'http' as const, status: 409, error: 'checkout_in_progress', reason: null, retryAfterSeconds: null } });
    const first = setup({ createOrder: refusal });
    await first.checkout.pay();
    resetCheckoutRecordsForTests(); // a reload: page memory is gone
    const reloaded = setup({ recover: recoveredWith({ checkoutLease: 'other' }) });
    await reloaded.checkout.pay();
    expect(reloaded.client.createOrder).not.toHaveBeenCalled();
    expect(hasUnresolvedPayment(BOOKING)).toBe(true);
    expect(reloaded.checkout.canPay()).toBe(false);
  });

  it('2c. a confirmed answer still ends everything', async () => {
    const refusal = () => ({ ok: false as const, failure: { kind: 'http' as const, status: 409, error: 'checkout_in_progress', reason: null, retryAfterSeconds: null } });
    const { checkout } = setup({ createOrder: refusal, recover: n => (n === 1 ? recovered() : confirmedWith()) });
    await checkout.pay();
    await checkout.checkStatus();
    expect(title(checkout)).toBe('Booking confirmed');
    expect(hasUnresolvedPayment(BOOKING)).toBe(false);
  });

  it('a status that says the booking is no longer waiting for payment never says "you can pay"', () => {
    const o: Outcome = {
      source: 'booking', result: 'no_payment_found', complete: true, bookingStatus: 'expired', paymentId: null,
      paymentStatus: null, providerRefund: null, otherPayments: [], checkoutLease: 'none'
    };
    expect(describeOutcome(o).lines.join(' ')).not.toMatch(/You can pay/);
    expect(describeOutcome({ ...o, bookingStatus: 'pending_payment' }).lines.join(' ')).toMatch(/You can pay/);
  });
});

describe('additional and non-fulfilling captures are surfaced (Issue 2)', () => {
  it('3. recovery after a reload: Booking confirmed + the additional payment, with our decision, and no refund claim', async () => {
    await markPaymentUnresolvedForTest();
    const { checkout } = setup({ recover: () => confirmedWith({ otherPayments: [extra()] }) });
    await checkout.checkStatus();
    const m = describeCheckout(checkout.state())!;
    expect(m.title).toBe('Booking confirmed, additional payment found');
    expect(m.tone).toBe('warning');
    const text = m.lines.join(' ');
    expect(text).toMatch(new RegExp(`Another payment \\(${PAY2}\\)`));
    expect(text).toMatch(/did not confirm it/);
    expect(text).toMatch(/recorded as a duplicate of the payment that confirmed the booking/);
    expect(text).toMatch(/Refunds are not yet handled automatically/);
    expect(text).not.toMatch(/has been refunded|was refunded|refund (is )?(pending|requested|initiated|issued|completed)|will be refunded/i);
    expect(hasUnresolvedPayment(BOOKING)).toBe(false); // the booking is confirmed
  });

  it('3c. the provider\'s refund report is worded as a provider fact, never as money received', () => {
    const base: Outcome = {
      source: 'booking', result: 'confirmed', complete: true, bookingStatus: 'confirmed', paymentId: 'pay_PAID0001',
      paymentStatus: 'captured', providerRefund: 'none', checkoutLease: 'none', otherPayments: []
    };
    const full = describeOutcome({ ...base, otherPayments: [extra({ providerRefund: 'full', paymentStatus: 'refunded' })] }).lines.join(' ');
    expect(full).toMatch(/provider reports it fully refunded; that does not confirm the money has reached your account/);
    const part = describeOutcome({ ...base, otherPayments: [extra({ providerRefund: 'partial' })] }).lines.join(' ');
    expect(part).toMatch(/provider reports part of it refunded; the rest is not being refunded automatically yet/);
    const none = describeOutcome({ ...base, otherPayments: [extra()] }).lines.join(' ');
    expect(none).not.toMatch(/provider reports/);
  });

  it('3d. other pending and failed payments are listed, and pending ones say not to pay again', () => {
    const base: Outcome = {
      source: 'booking', result: 'confirmed', complete: true, bookingStatus: 'confirmed', paymentId: 'pay_PAID0001',
      paymentStatus: 'captured', providerRefund: 'none', checkoutLease: 'none', otherPayments: []
    };
    const m = describeOutcome({
      ...base,
      otherPayments: [extra({ paymentId: 'pay_PEND0001', result: 'payment_pending', paymentStatus: 'authorized', decision: null }), extra({ paymentId: 'pay_FAIL0001', result: 'payment_failed', paymentStatus: 'failed', decision: null })]
    });
    const text = m.lines.join(' ');
    expect(text).toMatch(/pay_PEND0001\) on this booking is still pending.*do not pay again/);
    expect(text).toMatch(/pay_FAIL0001\) on this booking was reported as failed.*not always final/);
    expect(m.title).toBe('Booking confirmed'); // nothing stranded (yet)
  });

  it('4. an incomplete check does not claim there are no additional payments, and can be repeated', async () => {
    await markPaymentUnresolvedForTest();
    const { checkout } = setup({ recover: () => confirmedWith({ complete: false }) });
    await checkout.checkStatus();
    const m = describeCheckout(checkout.state())!;
    expect(m.title).toBe('Booking confirmed');
    expect(m.lines.join(' ')).toMatch(/additional payments cannot be ruled out/);
    expect(checkout.canCheckStatus()).toBe(true);
    expect(checkout.canPay()).toBe(false);
  });

  it('4b. a COMPLETE confirmed answer with nothing else says nothing about extra payments and is final', async () => {
    await markPaymentUnresolvedForTest();
    const { checkout } = setup({ recover: () => confirmedWith() });
    await checkout.checkStatus();
    const m = describeCheckout(checkout.state())!;
    expect(m.lines).toEqual(['This payment confirmed your booking.']);
    expect(checkout.canCheckStatus()).toBe(false);
  });

  it('4c. an incomplete not_fulfilled / pending answer also carries the "cannot be ruled out" line', () => {
    const o: Outcome = {
      source: 'booking', result: 'payment_pending', complete: false, bookingStatus: 'pending_payment', paymentId: 'pay_P1',
      paymentStatus: 'authorized', providerRefund: 'none', checkoutLease: 'other', otherPayments: []
    };
    expect(describeOutcome(o).lines.join(' ')).toMatch(/additional payments cannot be ruled out/);
    expect(describeOutcome({ ...o, result: 'not_fulfilled' }).lines.join(' ')).toMatch(/additional payments cannot be ruled out/);
  });

  it('5. a booking not confirmed but with several captured payments lists the others too', () => {
    const o: Outcome = {
      source: 'booking', result: 'not_fulfilled', complete: true, bookingStatus: 'expired', paymentId: 'pay_P1',
      paymentStatus: 'captured', providerRefund: 'none', checkoutLease: 'ended',
      otherPayments: [extra({ decision: 'late_capture' })]
    };
    const m = describeOutcome(o);
    expect(m.title).toBe('Booking not confirmed by this payment');
    expect(m.lines.join(' ')).toMatch(/recorded as arriving after the booking could no longer be confirmed/);
  });
});

describe('a new payment is offered only for a booking the server reports as pending payment', () => {
  const expectNoCheckout = (s: ReturnType<typeof setup>) => {
    expect(s.client.createOrder).not.toHaveBeenCalled();
    expect(s.deps.loadCheckout).not.toHaveBeenCalled();
    expect(s.openCheckout).not.toHaveBeenCalled();
    expect(s.checkout.canPay()).toBe(false);
  };

  it('expired booking, complete no_payment_found, lease none: no Pay, no order, no Checkout, honest message', async () => {
    const s = setup({ recover: recoveredWith({ bookingStatus: 'expired' }) });
    await s.checkout.pay();
    expect(s.client.recover).toHaveBeenCalledTimes(1);
    expectNoCheckout(s);
    const text = describeCheckout(s.checkout.state())!.lines.join(' ');
    expect(text).toMatch(/no longer waiting for payment/);
    expect(text).not.toMatch(/You can pay/);
    // nothing is live and nothing can be paid: nothing left to check either
    expect(hasUnresolvedPayment(BOOKING)).toBe(false);
    expect(s.checkout.canCheckStatus()).toBe(false);
  });

  it('already-confirmed booking with no payment record (legacy): no Pay, says it is confirmed', async () => {
    const s = setup({ recover: recoveredWith({ bookingStatus: 'confirmed' }) });
    await s.checkout.pay();
    expectNoCheckout(s);
    const text = describeCheckout(s.checkout.state())!.lines.join(' ');
    expect(text).toMatch(/already confirmed/);
    expect(text).not.toMatch(/You can pay/);
    expect(s.checkout.canCheckStatus()).toBe(false);
  });

  it('a confirmed result (payment found) never offers payment either', async () => {
    const s = setup({ recover: () => confirmedWith() });
    await s.checkout.pay();
    expectNoCheckout(s);
    expect(title(s.checkout)).toBe('Booking confirmed');
  });

  it('a missing or unrecognised booking status fails closed (absence of payments is not payability)', async () => {
    for (const bookingStatus of [null, 'cancelled', 'pending', 'PENDING_PAYMENT', '']) {
      resetCheckoutRecordsForTests();
      const s = setup({ recover: recoveredWith({ bookingStatus }) });
      await s.checkout.pay();
      expectNoCheckout(s);
      expect(describeCheckout(s.checkout.state())!.lines.join(' ')).not.toMatch(/You can pay/);
    }
    resetCheckoutRecordsForTests();
    const unknown = setup({ recover: recoveredWith({ bookingStatus: null }) });
    await unknown.checkout.pay();
    expect(describeCheckout(unknown.checkout.state())!.lines.join(' ')).toMatch(/could not tell whether this booking can still be paid/);
  });

  it('pending-payment booking, complete no_payment_found, lease none or yours: the normal flow still runs', async () => {
    for (const checkoutLease of ['none', 'yours'] as const) {
      resetCheckoutRecordsForTests();
      const s = setup({ recover: recoveredWith({ bookingStatus: 'pending_payment', checkoutLease }) });
      expect(s.checkout.canPay()).toBe(true);
      await s.checkout.pay();
      expect(s.client.recover).toHaveBeenCalledWith(BOOKING, SESSION);
      expect(s.client.createOrder).toHaveBeenCalledTimes(1);
      expect(s.openCheckout).toHaveBeenCalledTimes(1);
      expect(s.client.verify).toHaveBeenCalledWith(BOOKING, 'pay_PAID0001');
      expect(title(s.checkout)).toBe('Booking confirmed');
    }
  });

  it('a pending-payment answer keeps Pay available when the order request merely fails to reach the server', async () => {
    const s = setup({ recover: recoveredWith({ bookingStatus: 'pending_payment' }), createOrder: () => network });
    await s.checkout.pay();
    expect(s.client.createOrder).toHaveBeenCalledTimes(1);
    expect(s.openCheckout).not.toHaveBeenCalled();
    expect(s.checkout.state().phase).toBe('order_error');
    expect(s.checkout.canPay()).toBe(true); // retry re-asks the server first
  });

  it('incomplete recovery never authorises a payment, whatever the status', async () => {
    for (const bookingStatus of ['pending_payment', 'expired', 'confirmed']) {
      resetCheckoutRecordsForTests();
      const s = setup({ recover: recoveredWith({ bookingStatus, complete: false }) });
      await s.checkout.pay();
      expectNoCheckout(s);
    }
  });

  it('another session\'s lease or an ended lease never authorises a payment, even when the booking is pending', async () => {
    for (const checkoutLease of ['other', 'ended'] as const) {
      resetCheckoutRecordsForTests();
      const s = setup({ recover: recoveredWith({ bookingStatus: 'pending_payment', checkoutLease }) });
      await s.checkout.pay();
      expectNoCheckout(s);
      expect(hasUnresolvedPayment(BOOKING)).toBe(true);
    }
  });

  it('only pending_payment with lease none/yours reaches the server for an order (full matrix)', async () => {
    const statuses = ['pending_payment', 'confirmed', 'expired', 'cancelled', null];
    const leases = ['none', 'yours', 'other', 'ended'] as const;
    for (const bookingStatus of statuses) {
      for (const checkoutLease of leases) {
        resetCheckoutRecordsForTests();
        const s = setup({ recover: recoveredWith({ bookingStatus, checkoutLease }) });
        await s.checkout.pay();
        const expected = bookingStatus === 'pending_payment' && (checkoutLease === 'none' || checkoutLease === 'yours');
        expect([bookingStatus, checkoutLease, vi.mocked(s.client.createOrder).mock.calls.length]).toEqual([bookingStatus, checkoutLease, expected ? 1 : 0]);
      }
    }
  });

  it('a later status check that finds the booking expired withdraws the Pay offer and the "unresolved" block', async () => {
    const s = setup({
      end: { kind: 'dismissed', lastFailedPaymentId: null },
      recover: n => (n === 1 ? recovered() : recovered({ bookingStatus: 'expired' })),
    });
    await s.checkout.pay(); // own Checkout dismissed: unresolved
    expect(hasUnresolvedPayment(BOOKING)).toBe(true);
    await s.checkout.checkStatus();
    expect(s.checkout.canPay()).toBe(false);
    expect(s.checkout.canCheckStatus()).toBe(false);
    expect(describeCheckout(s.checkout.state())!.lines.join(' ')).toMatch(/no longer waiting for payment/);
    // a second panel in the page cannot pay either
    const second = createBookingCheckout(BOOKING, s.deps);
    await second.pay();
    expect(vi.mocked(s.client.createOrder)).toHaveBeenCalledTimes(1);
  });

  it('the server\'s refusal still wins over a pending-payment, lease-none answer', async () => {
    const refusal = () => ({ ok: false as const, failure: { kind: 'http' as const, status: 409, error: 'checkout_in_progress', reason: null, retryAfterSeconds: null } });
    const s = setup({ createOrder: refusal, recover: recoveredWith({ bookingStatus: 'pending_payment', checkoutLease: 'none' }) });
    await s.checkout.pay();
    await s.checkout.checkStatus();
    expect(s.checkout.canPay()).toBe(false);
    expect(hasUnresolvedPayment(BOOKING)).toBe(true);
  });
});

describe('actions become available as soon as a flow ends (regression: buttons hidden until an unrelated re-render)', () => {
  it('the last notification of a dismissed Checkout already allows checking the status', async () => {
    const { deps } = setup({ end: { kind: 'dismissed', lastFailedPaymentId: null } });
    const seen: { phase: string; canCheck: boolean }[] = [];
    const checkout = createBookingCheckout(BOOKING, deps, state => seen.push({ phase: state.phase, canCheck: checkout.canCheckStatus() }));
    await checkout.pay();
    expect(seen.at(-1)).toEqual({ phase: 'dismissed', canCheck: true });
  });

  it('the last notification of a no-payment status check already allows paying', async () => {
    await markPaymentUnresolvedForTest();
    const { deps } = setup();
    const seen: { phase: string; canPay: boolean }[] = [];
    const checkout = createBookingCheckout(BOOKING, deps, state => seen.push({ phase: state.phase, canPay: checkout.canPay() }));
    await checkout.checkStatus();
    expect(seen.at(-1)).toEqual({ phase: 'outcome', canPay: true });
  });
});

describe('Pay after a reload: a lease opened elsewhere is recognised from readable attempt data', () => {
  const LEASED = [{ checkoutLeaseUntil: '2026-10-17T06:14:39Z' }];
  const NEVER_LEASED = [{ checkoutLeaseUntil: null }];

  it('a page with no checkout session: any leased open attempt means the server will refuse', () => {
    expect(newCheckoutCertainlyRefused(BOOKING, LEASED)).toBe(true);
    expect(newCheckoutCertainlyRefused(BOOKING, [...NEVER_LEASED, ...LEASED])).toBe(true);
  });

  it('nothing is hidden for a never-leased open attempt, no open attempt, or unknown facts', () => {
    expect(newCheckoutCertainlyRefused(BOOKING, NEVER_LEASED)).toBe(false);
    expect(newCheckoutCertainlyRefused(BOOKING, [])).toBe(false);
    expect(newCheckoutCertainlyRefused(BOOKING, undefined)).toBe(false);
  });

  it('once this page holds a session for the booking only the server can tell: nothing is hidden', async () => {
    const { checkout } = setup();
    await checkout.checkStatus(); // a booking check creates this page's session
    expect(newCheckoutCertainlyRefused(BOOKING, LEASED)).toBe(false);
    // another booking without a session is still recognised
    expect(newCheckoutCertainlyRefused('55555555-5555-4555-8555-555555555555', LEASED)).toBe(true);
  });

  it('"Check payment" from a fresh (idle) page runs one booking check and never requests an order', async () => {
    const { checkout, client, openCheckout } = setup({ recover: recoveredWith({ checkoutLease: 'other' }) });
    expect(checkout.state().phase).toBe('idle');
    expect(checkout.canCheckStatus()).toBe(true);
    await checkout.checkStatus();
    expect(client.recover).toHaveBeenCalledTimes(1);
    expect(client.createOrder).not.toHaveBeenCalled();
    expect(openCheckout).not.toHaveBeenCalled();
    expect(title(checkout)).toBe('A payment window may be open elsewhere');
    expect(checkout.canPay()).toBe(false);
    expect(checkout.checksLeft()).toBe(MAX_MANUAL_CHECKS - 1);
  });
});
