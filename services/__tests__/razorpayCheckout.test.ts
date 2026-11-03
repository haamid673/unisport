import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  validatePaymentsConfig,
  loadRazorpayCheckout,
  openRazorpayCheckout,
  resetRazorpayLoaderForTests,
  checkoutTimeoutSeconds,
  CHECKOUT_LOAD_TIMEOUT_MS,
  WATCHDOG_GRACE_SECONDS,
  RAZORPAY_CHECKOUT_SRC,
  type RazorpayConstructor,
  type RazorpayFailedResponse
} from '../razorpayCheckout';
import type { CheckoutOrder } from '../paymentClient';

const ORDER: CheckoutOrder = {
  attemptId: '33333333-3333-4333-8333-333333333333',
  orderId: 'order_TESTORDER001',
  amountPaise: 50000,
  currency: 'INR',
  keyId: 'rzp_test_PUBLICKEY01',
  holdSecondsRemaining: 500
};

describe('payments configuration (test mode only)', () => {
  it('is unavailable when no test key is configured', () => {
    for (const raw of [undefined, '', '   ']) {
      const c = validatePaymentsConfig(raw);
      expect(c.ok).toBe(false);
      expect('reason' in c && c.reason).toMatch(/not configured/);
    }
  });

  it('refuses a live key outright (no live fallback)', () => {
    const c = validatePaymentsConfig('rzp_live_ABCDEFGH');
    expect(c.ok).toBe(false);
    expect('reason' in c && c.reason).toMatch(/live/);
  });

  it('refuses anything that is not a test key id (e.g. a pasted secret)', () => {
    for (const raw of ['secretvalue123', 'rzp_test_', 'rzp_test_has space', 'sk_test_abc']) {
      expect(validatePaymentsConfig(raw).ok).toBe(false);
    }
  });

  it('accepts a test key id', () => {
    expect(validatePaymentsConfig(' rzp_test_ABC123 ')).toEqual({ ok: true, keyId: 'rzp_test_ABC123' });
  });
});

function fakeEnv() {
  const appended: { src: string; onload?: () => void; onerror?: () => void }[] = [];
  const env = {
    window: {} as { Razorpay?: RazorpayConstructor },
    document: {
      head: { appendChild: (el: unknown) => appended.push(el as never) },
      createElement: () => ({ src: '', async: false }) as unknown as HTMLScriptElement,
      querySelector: () => null
    }
  };
  return { env, appended };
}

describe('Checkout loader', () => {
  beforeEach(() => resetRazorpayLoaderForTests());

  it('loads checkout.js once from the official URL', async () => {
    const { env, appended } = fakeEnv();
    const first = loadRazorpayCheckout(env as never);
    const second = loadRazorpayCheckout(env as never);
    expect(appended).toHaveLength(1);
    expect(appended[0].src).toBe(RAZORPAY_CHECKOUT_SRC);
    const Ctor = function () {} as unknown as RazorpayConstructor;
    env.window.Razorpay = Ctor;
    appended[0].onload!();
    expect(await first).toBe(Ctor);
    expect(await second).toBe(Ctor);
  });

  it('gives up a script load that takes too long (bounded), and allows a later retry', async () => {
    const { env, appended } = fakeEnv();
    let fire: (() => void) | null = null;
    let delay = 0;
    const timers = {
      setTimeout: ((fn: () => void, ms: number) => { fire = fn; delay = ms; return 1; }) as unknown as typeof setTimeout,
      clearTimeout: (() => {}) as typeof clearTimeout
    };
    const p = loadRazorpayCheckout(env as never, CHECKOUT_LOAD_TIMEOUT_MS, timers);
    expect(delay).toBe(CHECKOUT_LOAD_TIMEOUT_MS);
    fire!();
    await expect(p).rejects.toThrow(/took too long/);
    loadRazorpayCheckout(env as never).catch(() => {});
    expect(appended).toHaveLength(2);
  });

  it('fails clearly when the script cannot load, and allows a later retry', async () => {
    const { env, appended } = fakeEnv();
    const p = loadRazorpayCheckout(env as never);
    appended[0].onerror!();
    await expect(p).rejects.toThrow(/could not be loaded/);
    loadRazorpayCheckout(env as never).catch(() => {});
    expect(appended).toHaveLength(2);
  });
});

// A scriptable stand-in for window.Razorpay.
function fakeRazorpay() {
  const opened: { options: Record<string, unknown>; failed?: (r: RazorpayFailedResponse) => void; closed: number }[] = [];
  const Ctor = function (this: unknown, options: Record<string, unknown>) {
    const entry: (typeof opened)[number] = { options, closed: 0 };
    opened.push(entry);
    return {
      open() {},
      close() {
        entry.closed++;
      },
      on(_event: string, cb: (r: RazorpayFailedResponse) => void) {
        entry.failed = cb;
      }
    };
  } as unknown as RazorpayConstructor;
  return { Ctor, opened };
}

describe('opening Checkout', () => {
  it('uses only the server-returned order, amount, currency and test key', async () => {
    const { Ctor, opened } = fakeRazorpay();
    const p = openRazorpayCheckout(Ctor, ORDER, { description: 'Court booking', timeoutSeconds: 440 });
    const o = opened[0].options;
    expect([o.key, o.order_id, o.amount, o.currency, o.timeout]).toEqual(['rzp_test_PUBLICKEY01', 'order_TESTORDER001', 50000, 'INR', 440]);
    (o.handler as (r: unknown) => void)({ razorpay_payment_id: 'pay_PAID0001', razorpay_signature: 'x' });
    expect(await p).toEqual({ kind: 'completed', paymentId: 'pay_PAID0001' });
  });

  it('reports a dismissal as dismissed, never as a payment', async () => {
    const { Ctor, opened } = fakeRazorpay();
    const p = openRazorpayCheckout(Ctor, ORDER, { description: 'x', timeoutSeconds: 440 });
    (opened[0].options.modal as { ondismiss: () => void }).ondismiss();
    expect(await p).toEqual({ kind: 'dismissed', lastFailedPaymentId: null });
  });

  it('remembers a failed attempt so the caller can check it after a dismissal', async () => {
    const { Ctor, opened } = fakeRazorpay();
    const p = openRazorpayCheckout(Ctor, ORDER, { description: 'x', timeoutSeconds: 440 });
    opened[0].failed!({ error: { metadata: { payment_id: 'pay_FAILED001' } } });
    (opened[0].options.modal as { ondismiss: () => void }).ondismiss();
    expect(await p).toEqual({ kind: 'dismissed', lastFailedPaymentId: 'pay_FAILED001' });
  });

  it('treats a success callback without a usable payment id as no payment', async () => {
    const { Ctor, opened } = fakeRazorpay();
    const p = openRazorpayCheckout(Ctor, ORDER, { description: 'x', timeoutSeconds: 440 });
    (opened[0].options.handler as (r: unknown) => void)({});
    expect(await p).toEqual({ kind: 'dismissed', lastFailedPaymentId: null });
  });
});

describe('Checkout timeout and watchdog', () => {
  it('ends Checkout a margin before the server-reported hold, bounded', () => {
    expect(checkoutTimeoutSeconds(500)).toBe(440);
    expect(checkoutTimeoutSeconds(5000)).toBe(600);
    expect(checkoutTimeoutSeconds(119)).toBeNull();
    expect(checkoutTimeoutSeconds(120)).toBe(60);
    // fail closed: no (valid) hold, no Checkout
    expect(checkoutTimeoutSeconds(null)).toBeNull();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, '600' as unknown as number]) {
      expect(checkoutTimeoutSeconds(bad)).toBeNull();
    }
  });

  it('releases a Checkout that never reports back as a dismissal (never a failure), and closes it', async () => {
    const { Ctor, opened } = fakeRazorpay();
    let fire: (() => void) | null = null;
    let delay = 0;
    const timers = {
      setTimeout: ((fn: () => void, ms: number) => { fire = fn; delay = ms; return 1; }) as unknown as typeof setTimeout,
      clearTimeout: (() => {}) as typeof clearTimeout
    };
    const p = openRazorpayCheckout(Ctor, ORDER, { description: 'x', timeoutSeconds: 440 }, timers);
    expect(delay).toBe((440 + WATCHDOG_GRACE_SECONDS) * 1000);
    fire!();
    expect(await p).toEqual({ kind: 'dismissed', lastFailedPaymentId: null, watchdog: true });
    expect(opened[0].closed).toBe(1);
  });

  it('a success callback after the watchdog is handed on (never dropped), and only once settled', async () => {
    const { Ctor, opened } = fakeRazorpay();
    let fire: (() => void) | null = null;
    const timers = {
      setTimeout: ((fn: () => void) => { fire = fn; return 1; }) as unknown as typeof setTimeout,
      clearTimeout: (() => {}) as typeof clearTimeout
    };
    const late: string[] = [];
    const p = openRazorpayCheckout(Ctor, ORDER, { description: 'x', timeoutSeconds: 440, onLateSuccess: id => late.push(id) }, timers);
    fire!();
    await p;
    const handler = opened[0].options.handler as (r: unknown) => void;
    handler({ razorpay_payment_id: 'pay_LATE0001' });
    handler({ razorpay_payment_id: 'not-a-payment' });
    expect(late).toEqual(['pay_LATE0001']);
  });

  it('a watchdog on an instance without close() still releases the flow', async () => {
    const Ctor = function () { return { open() {}, on() {} }; } as unknown as RazorpayConstructor;
    let fire: (() => void) | null = null;
    const timers = {
      setTimeout: ((fn: () => void) => { fire = fn; return 1; }) as unknown as typeof setTimeout,
      clearTimeout: (() => {}) as typeof clearTimeout
    };
    const p = openRazorpayCheckout(Ctor, ORDER, { description: 'x', timeoutSeconds: 440 }, timers);
    fire!();
    expect((await p).kind).toBe('dismissed');
  });

  it('a normal end cancels the watchdog', async () => {
    const { Ctor, opened } = fakeRazorpay();
    let cleared = false;
    const timers = {
      setTimeout: (() => 7) as unknown as typeof setTimeout,
      clearTimeout: ((id: unknown) => { cleared = id === 7; }) as typeof clearTimeout
    };
    const p = openRazorpayCheckout(Ctor, ORDER, { description: 'x', timeoutSeconds: 440 }, timers);
    (opened[0].options.handler as (r: unknown) => void)({ razorpay_payment_id: 'pay_PAID0001' });
    await p;
    expect(cleared).toBe(true);
  });
});

// Browsers (unlike Node) throw "Illegal invocation" when setTimeout or
// clearTimeout is called as a method of another object.
function browserStrictTimers() {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  vi.stubGlobal('setTimeout', function (this: unknown, cb: () => void, ms?: number) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return realSet(cb, ms);
  });
  vi.stubGlobal('clearTimeout', function (this: unknown, id?: ReturnType<typeof setTimeout>) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return realClear(id);
  });
  return () => vi.unstubAllGlobals();
}

describe('default timers under browser rules (regression: "Illegal invocation" in a real page)', () => {
  beforeEach(() => resetRazorpayLoaderForTests());

  it('the loader with its default timers loads and settles without throwing', async () => {
    const restore = browserStrictTimers();
    try {
      const { env, appended } = fakeEnv();
      const p = loadRazorpayCheckout(env as never);
      expect(appended).toHaveLength(1);
      appended[0].onerror!();
      await expect(p).rejects.toThrow(/could not be loaded/);
    } finally {
      restore();
    }
  });

  it('opening Checkout with its default timers arms and clears the watchdog without throwing', async () => {
    const restore = browserStrictTimers();
    try {
      const { Ctor, opened } = fakeRazorpay();
      const p = openRazorpayCheckout(Ctor, ORDER, { description: 'x', timeoutSeconds: 440 });
      (opened[0].options.handler as (r: unknown) => void)({ razorpay_payment_id: 'pay_PAID0001' });
      expect(await p).toEqual({ kind: 'completed', paymentId: 'pay_PAID0001' });
    } finally {
      restore();
    }
  });
});
