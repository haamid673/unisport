-- ============================================================
-- UniSport — Payment: hold time remaining for Checkout
-- ============================================================
--
-- Replaces payment_prepare_attempt from 20261020190000 with the SAME
-- signature (its service_role-only EXECUTE grant is kept) and the SAME
-- behaviour, adding one output field to the reuse, recover and create
-- answers:
--
--   hold_seconds_remaining  whole seconds until the booking's hold
--                           expires, computed by the database clock
--                           under the booking row lock (>= 180 whenever
--                           an order may be handed out, by the payment
--                           window rule)
--
-- Why: the browser must close Razorpay Checkout before the hold ends
-- (a payment completed after expiry is a late capture that is not
-- fulfilled). A relative duration from the server is immune to the
-- customer's clock being wrong; an absolute expires_at compared with
-- the browser clock is not. payments-create-order passes the value
-- through, and the frontend sets Checkout's documented `timeout` option
-- from it with a safety margin.
--
-- No table, constraint, trigger, grant or other function changes.
-- ============================================================

CREATE OR REPLACE FUNCTION public.payment_prepare_attempt(
  p_booking_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c_lease constant interval := interval '60 seconds';
  c_min_window constant interval := interval '180 seconds';
  v_booking record;
  v_attempt record;
  v_amount_paise bigint;
  v_attempt_id uuid;
BEGIN

  IF p_booking_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'booking id and user id are required';
  END IF;

  -- L5: the booking row
  SELECT b.id, b.user_id, b.status, b.expires_at, b.amount
  INTO v_booking
  FROM public.bookings b
  WHERE b.id = p_booking_id
  FOR UPDATE;

  IF NOT FOUND OR v_booking.user_id IS DISTINCT FROM p_user_id THEN
    RETURN jsonb_build_object('action', 'not_found');
  END IF;

  IF v_booking.amount = 0 THEN
    RETURN jsonb_build_object('action', 'free_booking', 'reason', 'free_booking');
  END IF;

  IF v_booking.status = 'expired'
     OR (v_booking.status = 'pending_payment'
         AND (v_booking.expires_at IS NULL OR v_booking.expires_at <= now())) THEN
    RETURN jsonb_build_object('action', 'not_payable', 'reason', 'hold_expired',
                              'booking_status', v_booking.status::text);
  END IF;

  IF v_booking.status <> 'pending_payment' THEN
    RETURN jsonb_build_object('action', 'not_payable', 'reason', 'booking_not_pending',
                              'booking_status', v_booking.status::text);
  END IF;

  -- Policy 2: enough hold left for the provider calls AND checkout.
  -- Applies to every path that leads to an order being handed out.
  IF v_booking.expires_at < now() + c_min_window THEN
    RETURN jsonb_build_object(
      'action', 'not_payable',
      'reason', 'hold_too_short',
      'booking_status', v_booking.status::text,
      'hold_seconds_remaining', greatest(0, floor(extract(epoch FROM v_booking.expires_at - now()))::integer)
    );
  END IF;

  v_amount_paise := round(v_booking.amount * 100)::bigint;

  -- L6: the live attempt, if any (at most one: slice 1a index)
  SELECT a.id, a.state, a.provider_order_id, a.order_lease_until, a.amount_paise, a.currency
  INTO v_attempt
  FROM public.payment_attempts a
  WHERE a.booking_id = p_booking_id
    AND a.state IN ('creating', 'open')
  FOR UPDATE;

  IF FOUND THEN

    IF v_attempt.state = 'open' THEN
      RETURN jsonb_build_object(
        'action', 'reuse',
        'attempt_id', v_attempt.id,
        'provider_order_id', v_attempt.provider_order_id,
        'amount_paise', v_attempt.amount_paise,
        'currency', v_attempt.currency,
        'hold_seconds_remaining', greatest(0, floor(extract(epoch FROM v_booking.expires_at - now()))::integer)
      );
    END IF;

    IF v_attempt.order_lease_until IS NOT NULL AND v_attempt.order_lease_until > now() THEN
      RETURN jsonb_build_object(
        'action', 'in_progress',
        'attempt_id', v_attempt.id,
        'retry_after_seconds', greatest(1, ceil(extract(epoch FROM v_attempt.order_lease_until - now()))::integer)
      );
    END IF;

    UPDATE public.payment_attempts a
    SET order_lease_until = now() + c_lease
    WHERE a.id = v_attempt.id;

    RETURN jsonb_build_object(
      'action', 'recover',
      'attempt_id', v_attempt.id,
      'amount_paise', v_attempt.amount_paise,
      'currency', v_attempt.currency,
      'receipt', v_attempt.id::text,
      'hold_seconds_remaining', greatest(0, floor(extract(epoch FROM v_booking.expires_at - now()))::integer)
    );

  END IF;

  -- Persist the intent BEFORE any provider call. The slice 1a guard
  -- trigger re-checks the amount against the booking.
  INSERT INTO public.payment_attempts (booking_id, amount_paise, currency, state, order_lease_until)
  VALUES (p_booking_id, v_amount_paise, 'INR', 'creating', now() + c_lease)
  RETURNING id INTO v_attempt_id;

  RETURN jsonb_build_object(
    'action', 'create',
    'attempt_id', v_attempt_id,
    'amount_paise', v_amount_paise,
    'currency', 'INR',
    'receipt', v_attempt_id::text,
    'hold_seconds_remaining', greatest(0, floor(extract(epoch FROM v_booking.expires_at - now()))::integer)
  );

END;
$$;
