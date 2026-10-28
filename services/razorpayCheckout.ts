/**
 * Razorpay Checkout (TEST mode only) for the browser.
 *
 * Configuration: VITE_RAZORPAY_TEST_KEY_ID, the PUBLIC test key id
 * (rzp_test_...). It only switches online payment on; the key actually
 * used to open Checkout is the one the server returns with the order,
 * and both must be the same test key. A live key (rzp_live_...) or any
 * other value is refused, and there is no fallback: without a valid
 * test key, online payment is simply unavailable.
 *
 * The Razorpay key SECRET never belongs in the browser or in any VITE_*
 * variable; it lives only in the Edge Functions' server environment.
 *
 * Checkout's own success callback is NOT proof of payment. It only
 * hands back the payment id, which the caller then gives to the
 * server's payments-verify function. The Checkout signature is not used.
 */

import type { CheckoutOrder } from './paymentClient';

export const RAZORPAY_CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

const TEST_KEY_ID = /^rzp_test_[A-Za-z0-9]{1,64}$/;

export type PaymentsConfig = { ok: true; keyId: string } | { ok: false; reason: string };

export function validatePaymentsConfig(raw: unknown): PaymentsConfig {
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key) return { ok: false, reason: 'Online payment is not configured (VITE_RAZORPAY_TEST_KEY_ID is not set).' };
  if (key.startsWith('rzp_live_')) {
    return { ok: false, reason: 'Online payment is disabled: a live Razorpay key was configured; only test keys are allowed.' };
  }
  if (!TEST_KEY_ID.test(key)) {
    return { ok: false, reason: 'Online payment is disabled: VITE_RAZORPAY_TEST_KEY_ID is not a Razorpay test key id.' };
  }
  return { ok: true, keyId: key };
}

export const paymentsConfig: PaymentsConfig = validatePaymentsConfig(
  (import.meta as { env?: Record<string, unknown> }).env?.VITE_RAZORPAY_TEST_KEY_ID,
);

/** Whether the customer UI offers online (test-mode) payment at all. */
export const PAYMENTS_AVAILABLE = paymentsConfig.ok;

// ------------------------------------------------------------------
// Checkout.js loader
// ------------------------------------------------------------------

export interface RazorpayHandlerResponse {
  razorpay_payment_id?: string;
  razorpay_order_id?: string;
  razorpay_signature?: string;
}

export interface RazorpayFailedResponse {
  error?: { metadata?: { payment_id?: string; order_id?: string } };
}

export interface RazorpayInstance {
  open(): void;
  /** Documented by Razorpay (rzp.close()); treated as optional. */
  close?(): void;
  on(event: 'payment.failed', cb: (r: RazorpayFailedResponse) => void): void;
}

export type RazorpayConstructor = new (options: Record<string, unknown>) => RazorpayInstance;

interface LoaderEnv {
  document: Pick<Document, 'createElement' | 'head'> & { querySelector(sel: string): Element | null };
  window: { Razorpay?: RazorpayConstructor };
}

let loading: Promise<RazorpayConstructor> | null = null;

/** How long loading checkout.js may take before the attempt is given up. */
export const CHECKOUT_LOAD_TIMEOUT_MS = 15_000;

type Timers = { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };

// The platform timers, called unqualified. Browsers throw "Illegal
// invocation" when setTimeout is called as a method of another object
// (timers.setTimeout(...) with timers = { setTimeout }); Node does not.
const platformTimers: Timers = {
  setTimeout: ((cb: () => void, ms?: number) => setTimeout(cb, ms)) as Timers['setTimeout'],
  clearTimeout: ((id?: ReturnType<typeof setTimeout>) => clearTimeout(id)) as Timers['clearTimeout'],
};

/**
 * Loads checkout.js once. Rejects (and allows a later retry) when it
 * cannot be loaded, or does not load within CHECKOUT_LOAD_TIMEOUT_MS.
 */
export function loadRazorpayCheckout(
  env: LoaderEnv = { document, window: window as LoaderEnv['window'] },
  timeoutMs: number = CHECKOUT_LOAD_TIMEOUT_MS,
  timers: Timers = platformTimers,
): Promise<RazorpayConstructor> {
  if (env.window.Razorpay) return Promise.resolve(env.window.Razorpay);
  if (loading) return loading;
  loading = new Promise<RazorpayConstructor>((resolve, reject) => {
    const timer = timers.setTimeout(
      () => reject(new Error('Razorpay Checkout took too long to load.')),
      timeoutMs,
    );
    const script = env.document.createElement('script');
    script.src = RAZORPAY_CHECKOUT_SRC;
    script.async = true;
    script.onload = () => {
      timers.clearTimeout(timer);
      if (env.window.Razorpay) resolve(env.window.Razorpay);
      else reject(new Error('Razorpay Checkout did not initialise.'));
    };
    script.onerror = () => {
      timers.clearTimeout(timer);
      reject(new Error('Razorpay Checkout could not be loaded.'));
    };
    env.document.head.appendChild(script);
  }).catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

/** Test hook: forget a previous load attempt. */
export function resetRazorpayLoaderForTests(): void {
  loading = null;
}

// ------------------------------------------------------------------
// Opening Checkout
// ------------------------------------------------------------------

export type CheckoutEnd =
  // Checkout reports a completed payment. NOT proof: verify it.
  | { kind: 'completed'; paymentId: string }
  // The customer closed Checkout, Checkout timed out, or it never
  // reported back (watchdog). A payment may still have happened (e.g. a
  // failed attempt, or one that completes later): never a failure.
  | { kind: 'dismissed'; lastFailedPaymentId: string | null; watchdog?: boolean };

/** Safety margin between Checkout closing and the hold ending. */
export const CHECKOUT_HOLD_MARGIN_SECONDS = 60;
/** Shortest Checkout window worth opening. */
export const MIN_CHECKOUT_SECONDS = 60;
/** Upper bound (the hold itself is 10 minutes). */
export const MAX_CHECKOUT_SECONDS = 600;
/** Grace after the Checkout timeout before the watchdog releases the flow. */
export const WATCHDOG_GRACE_SECONDS = 120;

/**
 * Seconds Checkout may stay open: the remaining hold (server-reported,
 * minus any time already spent in the browser) minus a margin, or null
 * when there is not enough time left to pay. Fail-closed: a missing or
 * invalid hold is null too (Checkout is never opened without knowing
 * that it ends before the hold).
 */
export function checkoutTimeoutSeconds(holdSecondsRemaining: number | null): number | null {
  if (typeof holdSecondsRemaining !== 'number' || !Number.isFinite(holdSecondsRemaining) || holdSecondsRemaining < 0) {
    return null;
  }
  const t = Math.min(Math.floor(holdSecondsRemaining) - CHECKOUT_HOLD_MARGIN_SECONDS, MAX_CHECKOUT_SECONDS);
  return t >= MIN_CHECKOUT_SECONDS ? t : null;
}

const PAYMENT_ID = /^pay_[A-Za-z0-9]{1,40}$/;

export interface CheckoutDetails {
  description: string;
  timeoutSeconds: number;
  /**
   * A success callback that arrives after this Checkout already ended
   * (e.g. after the watchdog released it). The payment id is handed on so
   * the caller can check it with the server; it is never dropped, and it
   * is never treated as proof.
   */
  onLateSuccess?: (paymentId: string) => void;
}

export function openRazorpayCheckout(
  Razorpay: RazorpayConstructor,
  order: CheckoutOrder,
  details: CheckoutDetails,
  timers: Timers = platformTimers,
): Promise<CheckoutEnd> {
  return new Promise<CheckoutEnd>((resolve) => {
    let lastFailed: string | null = null;
    let settled = false;
    let rzp: RazorpayInstance | null = null;
    // If Checkout never reports back, close it where supported and
    // release the flow (as "dismissed": still unresolved, never "failed").
    const watchdog = timers.setTimeout(() => {
      try {
        rzp?.close?.();
      } catch {
        // closing is best effort; the flow is released either way
      }
      finish({ kind: 'dismissed', lastFailedPaymentId: lastFailed, watchdog: true });
    }, (details.timeoutSeconds + WATCHDOG_GRACE_SECONDS) * 1000);
    const finish = (end: CheckoutEnd) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(watchdog);
      resolve(end);
    };
    rzp = new Razorpay({
      key: order.keyId,
      order_id: order.orderId,
      amount: order.amountPaise,
      currency: order.currency,
      name: 'UniSport',
      description: details.description,
      // Documented Checkout option: seconds after which the customer
      // can no longer use this Checkout. Ends before the hold does.
      timeout: details.timeoutSeconds,
      handler: (response: RazorpayHandlerResponse) => {
        const id = response?.razorpay_payment_id;
        const valid = typeof id === 'string' && PAYMENT_ID.test(id);
        if (settled) {
          // This Checkout already ended: never drop the payment id.
          if (valid) details.onLateSuccess?.(id);
          return;
        }
        if (valid) finish({ kind: 'completed', paymentId: id });
        else finish({ kind: 'dismissed', lastFailedPaymentId: lastFailed });
      },
      modal: {
        ondismiss: () => finish({ kind: 'dismissed', lastFailedPaymentId: lastFailed }),
      },
    });
    rzp.on('payment.failed', (r) => {
      const id = r?.error?.metadata?.payment_id;
      if (typeof id === 'string' && PAYMENT_ID.test(id)) lastFailed = id;
    });
    rzp.open();
  });
}
