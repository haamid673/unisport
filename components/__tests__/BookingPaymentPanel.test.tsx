import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PaymentStatusView } from '../BookingPaymentPanel';
import type { CheckoutState, Outcome } from '../../services/bookingCheckout';

const BOOKING = '22222222-2222-4222-8222-222222222222';

const outcome = (over: Partial<Outcome>): CheckoutState => ({
  phase: 'outcome',
  outcome: {
    source: 'payment',
    complete: true,
    paymentId: 'pay_PAID0001',
    bookingStatus: 'confirmed',
    paymentStatus: 'captured',
    providerRefund: 'none',
    result: 'confirmed',
    otherPayments: [],
    checkoutLease: null,
    ...over
  }
});

const render = (state: CheckoutState, flags: { canPay?: boolean; canCheckStatus?: boolean } = {}) =>
  renderToString(
    <PaymentStatusView
      state={state}
      canPay={flags.canPay ?? false}
      canCheckStatus={flags.canCheckStatus ?? false}
      onPay={() => {}}
      onCheckStatus={() => {}}
    />
  );

describe('payment outcome UI', () => {
  it('shows "Booking confirmed" only for result confirmed', () => {
    expect(render(outcome({}))).toContain('Booking confirmed');
    for (const result of ['not_fulfilled', 'payment_failed', 'payment_pending'] as const) {
      expect(render(outcome({ result }))).not.toContain('Booking confirmed<');
    }
  });

  it('distinguishes a booking confirmed by another payment from this payment', () => {
    const html = render(outcome({ result: 'not_fulfilled', bookingStatus: 'confirmed' }));
    expect(html).toContain('Booking not confirmed by this payment');
    expect(html).toContain('confirmed by another payment');
    expect(html).toContain('role="alert"');
  });

  it('flags a refund observed on a confirmed booking', () => {
    const html = render(outcome({ providerRefund: 'full', paymentStatus: 'refunded' }));
    expect(html).toContain('refund observed');
    expect(html).toContain('data-tone="warning"');
  });

  it('offers only the actions the controller allows', () => {
    const pending = render(outcome({ result: 'payment_pending' }), { canCheckStatus: true });
    expect(pending).toContain('Check payment status');
    expect(pending).not.toContain('Pay (test mode)');
    const cleared = render(outcome({ source: 'booking', result: 'no_payment_found', paymentId: null }), { canPay: true });
    expect(cleared).toContain('Pay (test mode)');
    expect(cleared).toContain('No payment found for this booking');
    const notFulfilled = render(outcome({ result: 'not_fulfilled' }));
    expect(notFulfilled).not.toMatch(/<button/);
  });

  it('an unresolved booking offers a status check, not a payment', () => {
    const html = render({ phase: 'unresolved', paymentId: null }, { canCheckStatus: true });
    expect(html).toContain('may be in progress');
    expect(html).toContain('Check payment status');
    expect(html).not.toContain('Pay now');
  });

  it('a server refusal because another session holds the order offers a status check only', () => {
    const html = render(
      { phase: 'order_error', failure: { kind: 'http', status: 409, error: 'checkout_in_progress', reason: null, retryAfterSeconds: 300 } },
      { canCheckStatus: true }
    );
    expect(html).toContain('A payment is already in progress');
    expect(html).toContain('Check payment status');
    expect(html).not.toContain('Pay (test mode)');
  });

  it('no payment found while another session holds the Checkout lease: no Pay button, no "you can pay"', () => {
    const html = render(
      outcome({ source: 'booking', result: 'no_payment_found', complete: true, paymentId: null, paymentStatus: null, providerRefund: null, bookingStatus: 'pending_payment', checkoutLease: 'other' }),
      { canPay: false, canCheckStatus: true }
    );
    expect(html).toContain('A payment window may be open elsewhere');
    expect(html).toContain('No payment was found right now');
    expect(html).toContain('Check payment status');
    expect(html).not.toContain('Pay (test mode)');
    expect(html).not.toContain('Pay now');
    expect(html).not.toMatch(/You can pay/);
  });

  it('a confirmed booking with an additional captured payment shows a warning with that payment', () => {
    const html = render(
      outcome({
        source: 'booking',
        otherPayments: [{ paymentId: 'pay_EXTRA00002', paymentStatus: 'captured', providerRefund: 'none', result: 'not_fulfilled', decision: 'duplicate_capture' }]
      })
    );
    expect(html).toContain('Booking confirmed, additional payment found');
    expect(html).toContain('data-tone="warning"');
    expect(html).toContain('pay_EXTRA00002');
    expect(html).toContain('recorded as a duplicate');
    expect(html).not.toMatch(/has been refunded|was refunded/);
  });

  it('a timed-out request is not busy and offers a status check', () => {
    const html = render({ phase: 'check_error', failure: { kind: 'network' }, retryable: true, paymentId: null }, { canCheckStatus: true });
    expect(html).toContain('aria-busy="false"');
    expect(html).toContain('Check payment status');
    expect(html).not.toContain('Please wait');
  });

  it('shows a waiting state while verifying, with no actions', () => {
    const html = render({ phase: 'verifying', paymentId: 'pay_PAID0001' });
    expect(html).toContain('Checking your payment');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toMatch(/<button/);
  });
});

describe('dashboard wiring', () => {
  const source = readFileSync(fileURLToPath(new URL('../UserDashboard.tsx', import.meta.url)), 'utf8');

  it('gates every payment control behind the test-mode configuration', () => {
    const uses = source.match(/<BookingPaymentPanel/g) ?? [];
    expect(uses.length).toBe(2);
    expect(source).toMatch(/PAYMENTS_AVAILABLE && \(\s*<BookingPaymentPanel/);
    expect(source).toMatch(/PAYMENTS_AVAILABLE && scheduleBookingId && \(/);
    expect(source).toMatch(/PAYMENTS_AVAILABLE && held && scheduleBookingId !== b\.id/);
    // no Pay button while this page knows of an unresolved payment, nor
    // where a Checkout opened from another page (or before a reload)
    // means the server will refuse a new one
    expect(source).toMatch(/!hasUnresolvedPayment\(b\.id\) && !openedElsewhere && \(/);
    expect(source).toMatch(/newCheckoutCertainlyRefused\(b\.id, /);
    // authoritative answers refresh the bookings even after an unmount
    expect(source).toMatch(/onBookingPaymentChange\(\(\) => setBookingsReloadKey/);
  });

  it('pays existing holds only; the payment panel never creates a booking', () => {
    const panel = readFileSync(fileURLToPath(new URL('../BookingPaymentPanel.tsx', import.meta.url)), 'utf8');
    expect(panel).not.toMatch(/\bcreateBooking\b|bookingRepository|create_booking/);
    expect(source).toMatch(/bookingId: created\.bookingId/);
  });
});
