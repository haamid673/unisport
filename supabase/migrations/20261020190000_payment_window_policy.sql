-- ============================================================
-- UniSport — Payment slice 1b.1: payment-window correctness
-- ============================================================
--
-- Replaces payment_prepare_attempt and payment_record_order from
-- 20261019190000 with the SAME signatures (so their EXECUTE grants,
-- service_role only, are kept by CREATE OR REPLACE). No table,
-- constraint, trigger, grant or other function changes.
--
-- Problem
--
--   A booking hold lasts 10 minutes (create_booking). The order flow
--   checked the hold only when the attempt was prepared, then spent up
--   to ~45 s on provider calls before recording the order. A hold that
--   expired in between still produced an OPEN attempt whose order was
--   handed to the client, who could then pay for a booking that can no
--   longer be fulfilled (a late capture that must be refunded).
--
-- Policy (no hold extension, no automatic refunds; the late-capture
-- rule of payment_settle_locked is unchanged)
--
--   1. An order is created, re-used or handed to the client only while
--      the booking is pending_payment and its hold is valid.
--   2. Minimum remaining hold before a request may start (create,
--      recover or re-use): 180 seconds. Why 180 s:
--        * the server's worst-case path from prepare to hand-out is
--          about 55 s (recovery lookup 10 s + create 10 s + duplicate
--          lookup 10 s + record RPC 15 s, plus GoTrue/prepare);
--        * that leaves at least ~2 minutes for the customer to complete
--          Checkout before the hold ends, in the worst case;
--        * with a 10-minute hold a customer still has 7 minutes in
--          which to start paying.
--      Below it the answer is not_payable / hold_too_short, and nothing
--      is created or handed out.
--   3. When the order is recorded the booking is re-checked UNDER ITS
--      ROW LOCK (booking -> attempt, the documented order). If it is no
--      longer payable (status or clock), the order id is still recorded
--      on the attempt (write-once, so a payment on that order is MATCHED
--      later and settled as a late capture, never lost or unmatched),
--      the attempt is closed with reason 'booking_not_payable', and the
--      order is NOT handed out (outcome booking_not_payable). This is a
--      known provider order on an unpayable booking, not a provider
--      failure; ambiguous provider outcomes still never close anything.
--   4. Because recording now holds the booking row, the expiry sweep
--      (FOR UPDATE SKIP LOCKED) and create_booking's stale-hold sweep
--      (FOR UPDATE) cannot expire the booking between the check and the
--      commit: an order is only handed out if the hold was valid when
--      the attempt became open.
--
-- Machine-readable reasons (both functions return them; the Edge
-- Function passes them through as { error: 'booking_not_payable',
-- reason }):
--
--   hold_expired         status expired, or pending_payment with
--                        expires_at <= now()
--   hold_too_short       pending_payment, but less than 180 s remain
--   booking_not_pending  any other status (confirmed, completed,
--                        cancelled)
--   free_booking         amount 0 (action free_booking, unchanged)
-- ============================================================


-- ============================================================
-- 1. payment_prepare_attempt
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
        'currency', v_attempt.currency
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
      'receipt', v_attempt.id::text
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
    'receipt', v_attempt_id::text
  );

END;
$$;


-- ============================================================
-- 2. payment_record_order
-- ============================================================
--
--   recorded             creating -> open; the booking is payable
--   already_recorded     the same order id was recorded before and the
--                        attempt is open on a payable booking (retry)
--   booking_not_payable  the booking stopped being payable (policy 3):
--                        the order id is recorded, the attempt closed
--                        ('booking_not_payable'), the order NOT handed
--                        out; carries 'reason'
--   attempt_closed       the attempt was closed for another reason; the
--                        order id is recorded if it had none
--   conflict             a different order id is recorded, or the order
--                        id belongs to another attempt
--   mismatch             amount, currency or receipt disagree
--   not_found            no such attempt

CREATE OR REPLACE FUNCTION public.payment_record_order(
  p_attempt_id uuid,
  p_provider_order_id text,
  p_amount_paise bigint,
  p_currency text,
  p_receipt text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_booking_id uuid;
  v_booking record;
  v_attempt record;
  v_reason text;
BEGIN

  IF p_attempt_id IS NULL
     OR p_provider_order_id IS NULL
     OR p_provider_order_id !~ '^order_[A-Za-z0-9]{1,40}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'a valid attempt id and provider order id are required';
  END IF;

  -- The attempt's booking is immutable (slice 1a guard), so it can be
  -- read without a lock and then locked in the documented order.
  SELECT a.booking_id INTO v_booking_id
  FROM public.payment_attempts a
  WHERE a.id = p_attempt_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  -- L5: the booking row, then L6: the attempt
  SELECT b.id, b.status, b.expires_at
  INTO v_booking
  FROM public.bookings b
  WHERE b.id = v_booking_id
  FOR UPDATE;

  SELECT a.id, a.state, a.provider_order_id, a.amount_paise, a.currency
  INTO v_attempt
  FROM public.payment_attempts a
  WHERE a.id = p_attempt_id
  FOR UPDATE;

  IF p_amount_paise IS DISTINCT FROM v_attempt.amount_paise
     OR p_currency IS DISTINCT FROM v_attempt.currency
     OR p_receipt IS DISTINCT FROM v_attempt.id::text THEN
    RETURN jsonb_build_object('outcome', 'mismatch');
  END IF;

  IF v_attempt.provider_order_id IS NOT NULL
     AND v_attempt.provider_order_id <> p_provider_order_id THEN
    RETURN jsonb_build_object('outcome', 'conflict');
  END IF;

  IF v_attempt.provider_order_id IS NULL AND EXISTS (
    SELECT 1 FROM public.payment_attempts o
    WHERE o.provider_order_id = p_provider_order_id
      AND o.id <> p_attempt_id
  ) THEN
    RETURN jsonb_build_object('outcome', 'conflict');
  END IF;

  -- Is the booking still payable, now, under its lock?
  IF v_booking.status = 'expired'
     OR (v_booking.status = 'pending_payment'
         AND (v_booking.expires_at IS NULL OR v_booking.expires_at <= now())) THEN
    v_reason := 'hold_expired';
  ELSIF v_booking.status <> 'pending_payment' THEN
    v_reason := 'booking_not_pending';
  END IF;

  IF v_attempt.state = 'closed' THEN
    -- Keep the provider order durable for later matching.
    IF v_attempt.provider_order_id IS NULL THEN
      UPDATE public.payment_attempts a
      SET provider_order_id = p_provider_order_id,
          order_lease_until = NULL
      WHERE a.id = p_attempt_id;
    END IF;
    RETURN jsonb_build_object('outcome', 'attempt_closed');
  END IF;

  IF v_reason IS NOT NULL THEN
    -- Policy 3: record the order (write-once; a payment on it will be
    -- matched and settled as a late capture), close the attempt, and
    -- do not hand the order out.
    UPDATE public.payment_attempts a
    SET provider_order_id = coalesce(a.provider_order_id, p_provider_order_id),
        state = 'closed',
        closed_at = now(),
        closed_reason = 'booking_not_payable',
        order_lease_until = NULL
    WHERE a.id = p_attempt_id;
    RETURN jsonb_build_object('outcome', 'booking_not_payable', 'reason', v_reason);
  END IF;

  IF v_attempt.provider_order_id IS NOT NULL THEN
    -- the same order id, on an open attempt of a payable booking
    RETURN jsonb_build_object('outcome', 'already_recorded', 'state', v_attempt.state::text);
  END IF;

  UPDATE public.payment_attempts a
  SET provider_order_id = p_provider_order_id,
      state = 'open',
      order_lease_until = NULL
  WHERE a.id = p_attempt_id;

  RETURN jsonb_build_object('outcome', 'recorded');

END;
$$;
