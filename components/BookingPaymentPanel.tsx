import React, { useEffect, useMemo, useState } from 'react';
import {
  createBookingCheckout,
  describeCheckout,
  onBookingPaymentChange,
  type CheckoutDeps,
  type CheckoutState
} from '../services/bookingCheckout';
import { createPaymentClient } from '../services/paymentClient';
import {
  loadRazorpayCheckout,
  openRazorpayCheckout,
  paymentsConfig
} from '../services/razorpayCheckout';

/**
 * Online payment (Razorpay TEST mode) for one existing, unpaid hold.
 *
 * It never creates a booking and never reports success on its own: the
 * "Booking confirmed" message appears only when the server's
 * payments-verify answer says result === "confirmed" for this payment.
 * See services/bookingCheckout.ts for the flow and its guarantees.
 */

const defaultDeps: CheckoutDeps = {
  client: createPaymentClient(),
  config: paymentsConfig,
  loadCheckout: () => loadRazorpayCheckout(),
  openCheckout: openRazorpayCheckout,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  description: 'Court booking'
};

const TONE_CLASSES: Record<string, string> = {
  neutral: 'bg-neutral-50 border-neutral-200 text-neutral-700',
  success: 'bg-emerald-50 border-emerald-200 text-emerald-800',
  warning: 'bg-amber-50 border-amber-300 text-amber-900',
  error: 'bg-red-50 border-red-200 text-red-800'
};

const BUSY_PHASES = new Set<CheckoutState['phase']>(['checking', 'creating_order', 'checkout_open', 'verifying']);

interface ViewProps {
  state: CheckoutState;
  canPay: boolean;
  canCheckStatus: boolean;
  onPay: () => void;
  onCheckStatus: () => void;
  onClose?: () => void;
}

/** Presentational: what the customer sees for a checkout state. */
export const PaymentStatusView: React.FC<ViewProps> = ({
  state,
  canPay,
  canCheckStatus,
  onPay,
  onCheckStatus,
  onClose
}) => {
  const message = describeCheckout(state);
  const busy = BUSY_PHASES.has(state.phase);
  const payLabel =
    state.phase === 'idle' ? 'Pay now (test mode)' : 'Pay (test mode)';

  return (
    <div className="mt-3 space-y-2" aria-live="polite" aria-busy={busy}>
      {message && (
        <div
          role={message.tone === 'error' ? 'alert' : 'status'}
          data-tone={message.tone}
          className={`p-3 border ${TONE_CLASSES[message.tone]}`}
        >
          <p className="text-[11px] font-black uppercase tracking-wide">{message.title}</p>
          {message.lines.map(line => (
            <p key={line} className="text-[10px] font-bold mt-1">
              {line}
            </p>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        {canPay && (
          <button
            type="button"
            onClick={onPay}
            className="px-4 py-2 bg-black text-white text-[10px] font-black uppercase tracking-widest rounded-md hover:bg-orange-600 transition-all"
          >
            {payLabel}
          </button>
        )}
        {canCheckStatus && (
          <button
            type="button"
            onClick={onCheckStatus}
            className="px-4 py-2 bg-white border border-neutral-300 text-[10px] font-black uppercase tracking-widest rounded-md hover:border-black transition-all"
          >
            Check payment status
          </button>
        )}
        {onClose && !busy && (
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-[10px] font-black uppercase tracking-widest text-neutral-500 hover:text-black transition-all"
          >
            Close
          </button>
        )}
        {busy && (
          <span className="px-2 py-2 text-[10px] font-bold uppercase tracking-wide text-neutral-500">
            Please wait…
          </span>
        )}
      </div>
    </div>
  );
};

interface PanelProps {
  bookingId: string;
  /** Called after the server answered a verification, to re-read bookings. */
  onSettled?: () => void;
  /**
   * Start as soon as the panel opens: 'pay' (the customer clicked Pay;
   * the booking's payments are checked first) or 'check' (the customer
   * clicked Check payment). Never re-runs on its own.
   */
  autoStart?: 'pay' | 'check';
  onClose?: () => void;
  deps?: CheckoutDeps;
}

const BookingPaymentPanel: React.FC<PanelProps> = ({
  bookingId,
  onSettled,
  autoStart,
  onClose,
  deps = defaultDeps
}) => {
  const [state, setState] = useState<CheckoutState>({ phase: 'idle' });
  // Re-render when another panel changes this booking's shared record
  // (so a Pay button disappears while a payment is unresolved).
  const [, setTick] = useState(0);
  const checkout = useMemo(
    () => createBookingCheckout(bookingId, deps, setState),
    [bookingId, deps]
  );

  useEffect(() => {
    setState(checkout.state());
    // The flow lock and the unresolved record make a second start (e.g.
    // a re-mount, or another panel) a no-op.
    if (autoStart === 'pay' && checkout.canPay()) void checkout.pay();
    else if (autoStart === 'check' && checkout.canCheckStatus()) void checkout.checkStatus();
    else if (autoStart === 'pay' && checkout.canCheckStatus()) void checkout.checkStatus();
  }, [checkout, autoStart]);

  useEffect(
    () => onBookingPaymentChange(id => {
      if (id === bookingId) setTick(t => t + 1);
    }),
    [bookingId]
  );

  useEffect(() => {
    if (state.phase === 'outcome') onSettled?.();
    // only when a server answer arrives
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <PaymentStatusView
      state={state}
      canPay={checkout.canPay()}
      canCheckStatus={checkout.canCheckStatus()}
      onPay={() => {
        if (checkout.canPay()) void checkout.pay();
      }}
      onCheckStatus={() => {
        if (checkout.canCheckStatus()) void checkout.checkStatus();
      }}
      onClose={onClose}
    />
  );
};

export default BookingPaymentPanel;
