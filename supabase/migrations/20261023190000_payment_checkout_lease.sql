-- ============================================================
-- UniSport — Payment: one Checkout session per attempt (lease)
-- ============================================================
--
-- Problem: an open attempt's order was handed to every request that
-- asked for it (payment_prepare_attempt 'reuse'). Two tabs or devices
-- could therefore open Razorpay Checkout on the same order at the same
-- time and both pay it (a duplicate capture whose money stays
-- unresolved). A browser-side guard cannot prevent that.
--
-- Change:
--
--   payment_attempts gains a CHECKOUT LEASE:
--     checkout_lease_hash   SHA-256 (hex) of the browser's checkout
--                           session id (a random UUID it generates and
--                           re-sends on retries). The id itself is
--                           never stored or returned.
--     checkout_lease_until  when the lease ends: the booking's hold end
--                           at grant time (holds are never extended).
--
--   payment_acquire_checkout_lease(...) is the ONLY way an order is
--   handed out for Checkout (payments-create-order calls it after
--   prepare/record and before answering).
--
-- Lease state machine (per open attempt):
--
--   never leased   (until IS NULL)
--       any session          -> GRANTED (lease := session, hold end).
--                               The order was never handed out, so no
--                               Checkout and no payment can exist.
--   active         (until > now())
--       the holding session  -> VERIFY_REQUIRED; the Edge Function lists
--                               the order's payments at the provider and
--                               calls again with p_no_payments_verified
--                               only when the complete list is EMPTY ->
--                               GRANTED (resumed, lease unchanged). Any
--                               payment, even a failed one, keeps it
--                               closed: a failed payment is not final.
--       any other session,
--       or held by nobody    -> HELD (no provider call).
--   ended          (until <= now())
--       any session          -> ENDED. An ended lease never implies that
--                               no payment was made, so nothing is
--                               re-granted. (In practice the hold has
--                               ended too and the booking is not
--                               payable.)
--
--   There is no release and no override: a stale browser cannot end or
--   take over a newer session. The lease is irrelevant once the attempt
--   is closed (fulfilment, or creation failure).
--
-- Pre-existing open attempts were handed out without a lease. They are
-- backfilled as "held by nobody until the hold ends": no new session is
-- granted on an order that may already have one.
--
-- Lock order: booking row (L5) -> attempt row (L6), as every payment
-- function. Concurrent acquisitions queue on the booking row lock, so at
-- most one lease is ever granted per attempt.
--
-- payment_booking_payment_context (same signature, grants kept) also
-- reports the booking's fulfilling payment, so recovery can report it
-- even when it belongs to an older order.
-- ============================================================

ALTER TABLE public.payment_attempts
  ADD COLUMN checkout_lease_hash text,
  ADD COLUMN checkout_lease_until timestamptz;

ALTER TABLE public.payment_attempts
  ADD CONSTRAINT payment_attempts_checkout_lease_hash_format
    CHECK (checkout_lease_hash IS NULL OR checkout_lease_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT payment_attempts_checkout_lease_hash_has_until
    CHECK (checkout_lease_hash IS NULL OR checkout_lease_until IS NOT NULL);

COMMENT ON COLUMN public.payment_attempts.checkout_lease_hash IS
  'SHA-256 (hex) of the checkout session id holding this attempt''s Checkout lease. NULL with a lease end set: held by an unknown (pre-lease) session.';
COMMENT ON COLUMN public.payment_attempts.checkout_lease_until IS
  'End of the Checkout lease (the hold end at grant time). NULL: the order was never handed out for Checkout. An ended lease does not mean no payment was made.';

-- Backfill: orders already handed out without a lease.
UPDATE public.payment_attempts a
SET checkout_lease_until = coalesce(b.expires_at, now())
FROM public.bookings b
WHERE b.id = a.booking_id
  AND a.state = 'open'
  AND a.checkout_lease_until IS NULL;


-- ============================================================
-- payment_acquire_checkout_lease
-- ============================================================
--
--   { outcome: 'not_found' }                 not this user's booking/attempt
--   { outcome: 'not_payable', reason, hold_seconds_remaining? }
--   { outcome: 'attempt_not_open', state }
--   { outcome: 'held', retry_after_seconds } another session holds it
--   { outcome: 'ended' }                     the lease ended; payment may exist
--   { outcome: 'verify_required', provider_order_id }
--   { outcome: 'granted', resumed, provider_order_id, amount_paise,
--     currency, hold_seconds_remaining }

CREATE FUNCTION public.payment_acquire_checkout_lease(
  p_booking_id uuid,
  p_user_id uuid,
  p_attempt_id uuid,
  p_session text,
  p_no_payments_verified boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- Checkout needs at least 60 s, and closes 60 s before the hold.
  c_min_checkout constant interval := interval '120 seconds';
  v_booking record;
  v_attempt record;
  v_hash text;
  v_hold integer;
BEGIN

  IF p_booking_id IS NULL OR p_user_id IS NULL OR p_attempt_id IS NULL
     OR p_session IS NULL
     OR p_session !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'booking id, user id, attempt id and a lower-case UUID checkout session are required';
  END IF;

  v_hash := encode(sha256(convert_to(p_session, 'UTF8')), 'hex');

  -- L5: the booking row
  SELECT b.id, b.user_id, b.status, b.expires_at
  INTO v_booking
  FROM public.bookings b
  WHERE b.id = p_booking_id
  FOR UPDATE;

  IF NOT FOUND OR v_booking.user_id IS DISTINCT FROM p_user_id THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  IF v_booking.status = 'expired'
     OR (v_booking.status = 'pending_payment'
         AND (v_booking.expires_at IS NULL OR v_booking.expires_at <= now())) THEN
    RETURN jsonb_build_object('outcome', 'not_payable', 'reason', 'hold_expired');
  END IF;

  IF v_booking.status <> 'pending_payment' THEN
    RETURN jsonb_build_object('outcome', 'not_payable', 'reason', 'booking_not_pending');
  END IF;

  v_hold := greatest(0, floor(extract(epoch FROM v_booking.expires_at - now()))::integer);

  IF v_booking.expires_at < now() + c_min_checkout THEN
    RETURN jsonb_build_object('outcome', 'not_payable', 'reason', 'hold_too_short',
                              'hold_seconds_remaining', v_hold);
  END IF;

  -- L6: the attempt
  SELECT a.id, a.state, a.provider_order_id, a.amount_paise, a.currency,
         a.checkout_lease_hash, a.checkout_lease_until
  INTO v_attempt
  FROM public.payment_attempts a
  WHERE a.id = p_attempt_id
    AND a.booking_id = p_booking_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  IF v_attempt.state <> 'open' THEN
    RETURN jsonb_build_object('outcome', 'attempt_not_open', 'state', v_attempt.state::text);
  END IF;

  IF v_attempt.checkout_lease_until IS NULL THEN
    -- never handed out: no Checkout, no payment can exist yet
    UPDATE public.payment_attempts a
    SET checkout_lease_hash = v_hash,
        checkout_lease_until = v_booking.expires_at
    WHERE a.id = v_attempt.id;

    RETURN jsonb_build_object(
      'outcome', 'granted',
      'resumed', false,
      'provider_order_id', v_attempt.provider_order_id,
      'amount_paise', v_attempt.amount_paise,
      'currency', v_attempt.currency,
      'hold_seconds_remaining', v_hold
    );
  END IF;

  IF v_attempt.checkout_lease_until <= now() THEN
    RETURN jsonb_build_object('outcome', 'ended');
  END IF;

  IF v_attempt.checkout_lease_hash IS DISTINCT FROM v_hash THEN
    RETURN jsonb_build_object(
      'outcome', 'held',
      'retry_after_seconds',
      greatest(1, ceil(extract(epoch FROM v_attempt.checkout_lease_until - now()))::integer)
    );
  END IF;

  -- The holding session again (a retry, or Checkout re-opened after it
  -- was closed). Only when the provider shows no payment at all on the
  -- order may it continue.
  IF NOT coalesce(p_no_payments_verified, false) THEN
    RETURN jsonb_build_object('outcome', 'verify_required',
                              'provider_order_id', v_attempt.provider_order_id);
  END IF;

  RETURN jsonb_build_object(
    'outcome', 'granted',
    'resumed', true,
    'provider_order_id', v_attempt.provider_order_id,
    'amount_paise', v_attempt.amount_paise,
    'currency', v_attempt.currency,
    'hold_seconds_remaining', v_hold
  );

END;
$$;

REVOKE ALL ON FUNCTION public.payment_acquire_checkout_lease(uuid, uuid, uuid, text, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.payment_acquire_checkout_lease(uuid, uuid, uuid, text, boolean) TO service_role;


-- ============================================================
-- payment_booking_payment_context: also report the fulfilling payment
-- ============================================================
--
-- Same signature, same grants (CREATE OR REPLACE keeps them), same
-- fields; adds
--   fulfilling_payment: { provider_payment_id, provider_order_id } | null

CREATE OR REPLACE FUNCTION public.payment_booking_payment_context(
  p_booking_id uuid,
  p_user_id uuid,
  p_provider_payment_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_booking record;
BEGIN

  IF p_booking_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'booking id and user id are required';
  END IF;

  SELECT b.id, b.user_id, b.status, b.fulfilled_by_payment_id
  INTO v_booking
  FROM public.bookings b
  WHERE b.id = p_booking_id;

  IF NOT FOUND OR v_booking.user_id IS DISTINCT FROM p_user_id THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'booking_status', v_booking.status::text,
    'fulfilled', v_booking.fulfilled_by_payment_id IS NOT NULL,
    'payment_fulfils_booking', p_provider_payment_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.payments p
      WHERE p.id = v_booking.fulfilled_by_payment_id
        AND p.provider = 'razorpay'
        AND p.provider_payment_id = p_provider_payment_id),
    'fulfilling_payment', (
      SELECT jsonb_build_object('provider_payment_id', p.provider_payment_id,
                                'provider_order_id', p.provider_order_id)
      FROM public.payments p
      WHERE p.id = v_booking.fulfilled_by_payment_id
        AND p.provider = 'razorpay'),
    'orders', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'attempt_id', a.id,
               'provider_order_id', a.provider_order_id,
               'amount_paise', a.amount_paise,
               'currency', a.currency,
               'attempt_state', a.state::text)
             ORDER BY a.created_at, a.id)
      FROM public.payment_attempts a
      WHERE a.booking_id = p_booking_id
        AND a.provider_order_id IS NOT NULL), '[]'::jsonb)
  );

END;
$$;
