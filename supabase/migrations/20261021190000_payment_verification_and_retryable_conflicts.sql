-- ============================================================
-- UniSport — Payment slice 1b.2: authenticated verification support
-- and retryable association races
-- ============================================================
--
-- Builds on 20261019190000 (slice 1b) and 20261020190000 (slice 1b.1)
-- WITHOUT editing them. No table, column, constraint, trigger or
-- table grant changes.
--
-- 1. payment_apply_observation (same signature, so its EXECUTE grant,
--    service_role only, is kept) now distinguishes two kinds of
--    "conflict" that slice 1b reported under one name:
--
--      transient   the stored payment was associated CONCURRENTLY with
--                  a booking whose row lock this transaction does not
--                  hold (our first read was unlocked and saw no
--                  association). Slice 1b returned association_conflict
--                  and marked the carrying event PROCESSED, so the
--                  observation was lost (the webhook answered 200).
--                  Now: RAISE SQLSTATE 40001 (serialization_failure).
--                  The transaction rolls back, the event stays
--                  unprocessed, the webhook answers 503 and a
--                  redelivery (or the next verification) re-reads the
--                  association and takes the right lock first.
--
--      permanent   identity_conflict (amount/currency differ from the
--                  stored payment), order_conflict (a different order
--                  id is stored), and the unmatched reason
--                  attempt_booking_mismatch (renamed from
--                  association_conflict: the stored booking and the
--                  booking of the attempt that owns the order differ).
--                  These are durable anomalies: recorded, the event
--                  marked processed, never retried forever. Unchanged.
--
--    Nothing else in the function changes (merge rules, matching,
--    settlement, READ COMMITTED check, lock order).
--
-- 2. payment_booking_payment_context(booking, user, provider_payment_id)
--    a read-only lookup for the verification Edge Function: ownership
--    (not_found for someone else's booking, so ids cannot be probed),
--    the booking's status and the provider orders of ITS attempts
--    (trusted, write-once server state), and whether a given provider
--    payment is the one fulfilling the booking. service_role only.
-- ============================================================


-- ============================================================
-- 1. payment_apply_observation: transient vs permanent conflicts
-- ============================================================

CREATE OR REPLACE FUNCTION public.payment_apply_observation(
  p_event_id uuid,
  p_provider_payment_id text,
  p_provider_order_id text,
  p_status text,
  p_amount_paise bigint,
  p_currency text,
  p_amount_refunded_paise bigint,
  p_provider_created_at timestamptz,
  p_error_code text,
  p_error_description text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status public.provider_payment_status;
  v_attempt_id uuid;
  v_attempt_booking uuid;
  v_attempt_amount bigint;
  v_attempt_currency text;
  v_attempt_found boolean := false;
  v_match_ok boolean := false;
  v_unmatched_reason text;
  v_existing record;
  v_existing_found boolean;
  v_lock_booking uuid;
  v_payment_id uuid;
  v_observation text;
  v_settlement text := 'none';
  v_matched boolean;
  v_new_status public.provider_payment_status;
  v_rank_old integer;
  v_rank_new integer;
  v_result text;
BEGIN

  -- 1. isolation (the settlement step reads across tables after locks)
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION
      USING
        ERRCODE = 'UB004',
        MESSAGE = format(
          'payment observation and settlement require READ COMMITTED isolation (this transaction is %s)',
          current_setting('transaction_isolation')
        );
  END IF;

  -- input validation (the Edge Function validates first; this is the
  -- authoritative check)
  IF p_provider_payment_id IS NULL OR p_provider_payment_id !~ '^pay_[A-Za-z0-9]{1,40}$'
     OR (p_provider_order_id IS NOT NULL AND p_provider_order_id !~ '^order_[A-Za-z0-9]{1,40}$')
     OR p_status IS NULL
     OR p_status NOT IN ('created', 'authorized', 'captured', 'failed', 'refunded')
     OR p_amount_paise IS NULL OR p_amount_paise <= 0
     OR p_currency IS NULL OR p_currency !~ '^[A-Z]{3}$'
     OR p_amount_refunded_paise IS NULL OR p_amount_refunded_paise < 0
     OR p_amount_refunded_paise > p_amount_paise THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid provider payment facts';
  END IF;

  v_status := p_status::public.provider_payment_status;

  -- 2. the attempt that owns this order id (immutable facts; no lock)
  IF p_provider_order_id IS NOT NULL THEN
    SELECT a.id, a.booking_id, a.amount_paise, a.currency
    INTO v_attempt_id, v_attempt_booking, v_attempt_amount, v_attempt_currency
    FROM public.payment_attempts a
    WHERE a.provider_order_id = p_provider_order_id;
    v_attempt_found := FOUND;
  END IF;

  IF NOT v_attempt_found THEN
    v_unmatched_reason := CASE WHEN p_provider_order_id IS NULL THEN 'no_order' ELSE 'unknown_order' END;
  ELSIF v_attempt_amount <> p_amount_paise THEN
    v_unmatched_reason := 'amount_mismatch';
  ELSIF v_attempt_currency <> p_currency THEN
    v_unmatched_reason := 'currency_mismatch';
  ELSE
    v_match_ok := true;
  END IF;

  -- the stored row, if any (read without a lock to learn its booking)
  SELECT p.id, p.booking_id
  INTO v_existing
  FROM public.payments p
  WHERE p.provider = 'razorpay' AND p.provider_payment_id = p_provider_payment_id;
  v_existing_found := FOUND;

  -- 3. lock the booking first when the payment is or may become matched
  IF v_existing_found AND v_existing.booking_id IS NOT NULL THEN
    v_lock_booking := v_existing.booking_id;
  ELSIF v_match_ok THEN
    v_lock_booking := v_attempt_booking;
  END IF;

  IF v_lock_booking IS NOT NULL THEN
    -- L5, then L6 (all attempts of the booking, id order) BEFORE the
    -- payment row: the settlement step below locks the same attempts
    -- and then the payment, so the order is booking -> attempt ->
    -- payment throughout this transaction.
    PERFORM 1 FROM public.bookings b WHERE b.id = v_lock_booking FOR UPDATE;
    PERFORM 1 FROM public.payment_attempts a
    WHERE a.booking_id = v_lock_booking
    ORDER BY a.id
    FOR UPDATE;
  END IF;

  -- a stored association with another booking than the one the order
  -- maps to is a conflict; nothing is attached or settled then
  IF v_existing_found AND v_existing.booking_id IS NOT NULL
     AND v_match_ok AND v_attempt_booking <> v_existing.booking_id THEN
    v_match_ok := false;
    v_unmatched_reason := 'attempt_booking_mismatch';
  END IF;

  -- 4. insert or merge (L7)
  IF NOT v_existing_found THEN

    INSERT INTO public.payments
      (provider, provider_payment_id, provider_order_id, provider_status, amount_paise, currency,
       provider_amount_refunded_paise, provider_created_at, error_code, error_description,
       captured_observed_at, attempt_id, booking_id,
       resolution_attempts, last_resolution_at)
    VALUES
      ('razorpay', p_provider_payment_id, p_provider_order_id, v_status, p_amount_paise, p_currency,
       p_amount_refunded_paise, p_provider_created_at, left(p_error_code, 255), left(p_error_description, 1000),
       CASE WHEN v_status = 'captured' THEN now() END,
       CASE WHEN v_match_ok THEN v_attempt_id END,
       CASE WHEN v_match_ok THEN v_attempt_booking END,
       CASE WHEN v_match_ok THEN 0 ELSE 1 END,
       CASE WHEN v_match_ok THEN NULL ELSE now() END)
    ON CONFLICT (provider, provider_payment_id) DO NOTHING
    RETURNING id INTO v_payment_id;

    IF v_payment_id IS NOT NULL THEN
      v_observation := 'inserted';
    END IF;

  END IF;

  IF v_payment_id IS NULL THEN

    -- merge into the stored row (it existed, or a concurrent
    -- observation inserted it a moment ago)
    SELECT p.id, p.attempt_id, p.booking_id, p.provider_order_id, p.provider_status,
           p.amount_paise, p.currency, p.provider_amount_refunded_paise,
           p.provider_created_at, p.captured_observed_at, p.unmatched_disposition
    INTO v_existing
    FROM public.payments p
    WHERE p.provider = 'razorpay' AND p.provider_payment_id = p_provider_payment_id
    FOR UPDATE;

    v_payment_id := v_existing.id;

    IF v_existing.booking_id IS NOT NULL
       AND v_existing.booking_id IS DISTINCT FROM v_lock_booking THEN
      -- Associated CONCURRENTLY with a booking whose lock this
      -- transaction does not hold (our first, unlocked read saw no
      -- association). Nothing may be written under the wrong lock, and
      -- marking the event processed would lose this observation. Fail
      -- the whole transaction with a RETRYABLE error: it rolls back
      -- (the event stays unprocessed) and a retry reads the current
      -- association and takes the right booking lock first.
      RAISE EXCEPTION
        USING
          ERRCODE = '40001',
          MESSAGE = 'the payment was associated concurrently; retry the observation',
          DETAIL = format('payment %s', p_provider_payment_id);
    ELSIF v_existing.amount_paise <> p_amount_paise OR v_existing.currency <> p_currency THEN
      v_observation := 'identity_conflict';
    ELSIF v_existing.provider_order_id IS NOT NULL
          AND p_provider_order_id IS DISTINCT FROM v_existing.provider_order_id THEN
      v_observation := 'order_conflict';
    ELSE

      -- status: only the captured/refunded side is ordered
      v_rank_old := CASE v_existing.provider_status
        WHEN 'created' THEN 0 WHEN 'authorized' THEN 1 WHEN 'failed' THEN 1
        WHEN 'captured' THEN 2 ELSE 3 END;
      v_rank_new := CASE v_status
        WHEN 'created' THEN 0 WHEN 'authorized' THEN 1 WHEN 'failed' THEN 1
        WHEN 'captured' THEN 2 ELSE 3 END;

      IF v_rank_new > v_rank_old OR (v_rank_new = v_rank_old AND v_rank_old < 2) THEN
        v_new_status := v_status;
      ELSE
        v_new_status := v_existing.provider_status;
      END IF;

      IF v_existing.attempt_id IS NULL AND v_match_ok AND v_existing.unmatched_disposition IS NOT NULL THEN
        v_match_ok := false;
        v_unmatched_reason := 'dispositioned';
      END IF;

      UPDATE public.payments p
      SET provider_status = v_new_status,
          provider_order_id = coalesce(p.provider_order_id, p_provider_order_id),
          provider_amount_refunded_paise = greatest(p.provider_amount_refunded_paise, p_amount_refunded_paise),
          provider_created_at = coalesce(p.provider_created_at, p_provider_created_at),
          captured_observed_at = coalesce(
            p.captured_observed_at,
            CASE WHEN v_new_status = 'captured' THEN now() END),
          error_code = coalesce(left(p_error_code, 255), p.error_code),
          error_description = coalesce(left(p_error_description, 1000), p.error_description),
          last_seen_at = greatest(p.last_seen_at, now()),
          attempt_id = CASE WHEN p.attempt_id IS NULL AND v_match_ok THEN v_attempt_id ELSE p.attempt_id END,
          booking_id = CASE WHEN p.attempt_id IS NULL AND v_match_ok THEN v_attempt_booking ELSE p.booking_id END,
          resolution_attempts = CASE WHEN p.attempt_id IS NULL AND NOT v_match_ok
                                     THEN p.resolution_attempts + 1 ELSE p.resolution_attempts END,
          last_resolution_at = CASE WHEN p.attempt_id IS NULL AND NOT v_match_ok
                                    THEN now() ELSE p.last_resolution_at END
      WHERE p.id = v_payment_id;

      v_observation := 'merged';

    END IF;

    IF v_observation IN ('identity_conflict', 'order_conflict') THEN
      UPDATE public.payments p
      SET last_seen_at = greatest(p.last_seen_at, now())
      WHERE p.id = v_payment_id;
    END IF;

  END IF;

  SELECT p.attempt_id IS NOT NULL INTO v_matched
  FROM public.payments p WHERE p.id = v_payment_id;

  -- 6. settle a captured, matched payment (only when nothing conflicted)
  IF v_matched AND v_observation IN ('inserted', 'merged') THEN
    v_settlement := public.payment_settle_locked(v_payment_id);
  END IF;

  v_result := v_observation
    || CASE WHEN NOT v_matched THEN ':unmatched:' || coalesce(v_unmatched_reason, 'unknown') ELSE '' END
    || ':' || v_settlement;

  -- 7. the carrying event, in the same transaction
  IF p_event_id IS NOT NULL THEN
    UPDATE public.payment_events e
    SET processed_at = coalesce(e.processed_at, now()),
        process_result = left(v_result, 100),
        attempts = e.attempts + 1,
        last_error = NULL
    WHERE e.id = p_event_id;
  END IF;

  RETURN jsonb_build_object(
    'payment_id', v_payment_id,
    'matched', v_matched,
    'observation', v_observation,
    'unmatched_reason', CASE WHEN v_matched THEN NULL ELSE coalesce(v_unmatched_reason, 'unknown') END,
    'settlement', v_settlement
  );

END;
$$;


-- ============================================================
-- 2. payment_booking_payment_context (read-only)
-- ============================================================
--
--   { found: false }                       not this user's booking
--   { found: true,
--     booking_status,
--     fulfilled: <the booking has a fulfilling payment>,
--     payment_fulfils_booking: <p_provider_payment_id is it>,
--     orders: [ { attempt_id, provider_order_id, amount_paise,
--                 currency, attempt_state } ... ] }  attempts with an
--                                                     order, oldest first
--
-- No lock is taken: the Edge Function only uses this to decide whether
-- a payment may be applied at all and to describe the result. The
-- authoritative checks are repeated under locks by
-- payment_apply_observation.

CREATE FUNCTION public.payment_booking_payment_context(
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

REVOKE ALL ON FUNCTION public.payment_booking_payment_context(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.payment_booking_payment_context(uuid, uuid, text) TO service_role;
