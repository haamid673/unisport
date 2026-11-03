-- ============================================================
-- UniSport — Payment architecture, slice 1b: order creation and
-- settlement foundation (database side)
-- ============================================================
--
-- Builds on 20261018190000 (slice 1a) WITHOUT changing it. Adds
-- only functions; no table, column, constraint or grant on a table
-- changes.
--
-- Division of labour
--
--   Edge Functions (supabase/functions) authenticate the caller,
--   talk to Razorpay with the server-only credentials and validate
--   what the provider returned. They never write tables directly.
--
--   These functions are the ONLY writers of payment state. They
--   enforce ownership, eligibility, write-once identity, monotonic
--   observation merges and the fulfilment transition, atomically,
--   under the documented lock order. Every one is SECURITY DEFINER
--   with an empty search_path and is executable by service_role
--   only (the Edge Functions' credential). Clients cannot call them.
--
-- Lock order (from slice 1a; every function here follows it):
--
--   booking row -> attempt row -> payment row -> refund-key advisory
--   -> refund row
--
--   In particular a MATCHED payment is only inserted or attached
--   after its booking row is locked, so the foreign-key KEY SHARE
--   locks it takes on the booking and attempt never wait for a
--   fulfilment that already holds the booking (the slice 1a review,
--   L1). Unmatched payments take no booking or attempt lock at all.
--
-- What "settled" means here
--
--   A created order is not a payment. An authorized payment is not
--   a captured one. A webhook is not proof. payment_apply_observation
--   is called by the Edge Function with facts it has just FETCHED
--   from the provider's API (GET /v1/payments/{id}) with the server
--   credential; it merges them monotonically and, only for a
--   captured, correctly matched payment, runs the settlement
--   decision under locks. The settlement step is not callable on
--   its own, so it can never run on stale stored facts.
--
-- Settlement decisions (payments.decision_recorded_at records that
-- one was made; slice 1a comment: "the fulfil-or-refund decision")
--
--   fulfilled                 booking pending_payment -> confirmed,
--                             pointer set, live attempts closed
--   late_capture              booking no longer payable (expired by
--                             status or clock, cancelled, ...) or the
--                             attempt was closed: NOT fulfilled
--   duplicate_capture         the booking is already fulfilled by a
--                             different payment
--   refunded_before_settlement the provider reports a refund already
--   refund_obligation         a non-failed refund row already exists
--
--   Every decision other than "fulfilled" means: this captured money
--   is not consumed by a booking and must be refunded by the refund
--   lifecycle of a later slice. Nothing here creates a refund or
--   calls the provider to refund. The durable work list for that
--   slice is:
--
--     payments p
--     WHERE p.attempt_id IS NOT NULL
--       AND p.decision_recorded_at IS NOT NULL
--       AND p.provider_status IN ('captured', 'refunded')
--       AND NOT EXISTS (SELECT 1 FROM bookings b
--                       WHERE b.fulfilled_by_payment_id = p.id)
--
--   Unmatched captured payments (attempt_id NULL) never get a
--   decision and are never refunded automatically; they are the
--   operator list payments_unmatched_captured_idx (slice 1a).
--
-- Anomalies (identity conflicts, unknown orders, amount mismatches)
-- are durable in two places: the payment row itself (unmatched, or
-- matched but undecided) and payment_events.process_result /
-- last_error of the event that carried the observation.
--
-- Error convention: functions RETURN an outcome code for expected
-- business situations (not found, not payable, conflict, ...) so the
-- Edge Function can answer without parsing exception text, and
-- RAISE only for invalid input (22023) or isolation (UB004).
-- ============================================================


-- ============================================================
-- 1. Order creation: prepare an attempt
-- ============================================================
--
-- Called with the user id the Edge Function verified from the
-- caller's JWT. Locks the booking row, so concurrent requests for
-- one booking are serialised, and returns what to do next:
--
--   not_found      no such booking for this user (deliberately the
--                  same answer for "exists but belongs to someone
--                  else", so ids cannot be probed)
--   not_payable    status is not pending_payment, or the hold has
--                  expired by the clock
--   free_booking   amount is 0: never payable (slice 1a decision)
--   reuse          a live attempt with a provider order exists:
--                  return it, do NOT create another order
--   in_progress    a live attempt is being created by another
--                  request (its lease has not run out): retry later
--   recover        a live attempt is still 'creating' and its lease
--                  ran out: an earlier provider call may or may not
--                  have created an order. The caller now holds a
--                  fresh lease and MUST look the order up by receipt
--                  (= attempt id) before creating one
--   create         a new attempt was persisted (BEFORE any provider
--                  call); the caller holds the lease and creates
--                  the order with receipt = attempt id
--
-- The lease (order_lease_until) is longer than the Edge Function's
-- provider timeout, so a timed-out request that may still be in
-- flight at the provider is never raced by a second creator.

CREATE FUNCTION public.payment_prepare_attempt(
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
    RETURN jsonb_build_object('action', 'free_booking');
  END IF;

  IF v_booking.status <> 'pending_payment'
     OR v_booking.expires_at IS NULL
     OR v_booking.expires_at <= now() THEN
    RETURN jsonb_build_object('action', 'not_payable', 'booking_status', v_booking.status::text);
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
-- 2. Order creation: record the provider order (write-once)
-- ============================================================
--
-- Called after the Edge Function created or found the order and
-- validated the provider response. Everything is re-validated here
-- against the stored attempt; the provider order id is written once
-- (slice 1a guard) and the attempt becomes open.
--
--   recorded          creating -> open with this order id
--   already_recorded  the same order id was recorded before (retry)
--   attempt_closed    the attempt was closed meanwhile (e.g. the
--                     booking stopped being payable). The order id
--                     is still recorded, so a payment on that order
--                     is matched later, but the attempt stays closed
--                     and the order must not be handed to a client
--   conflict          the attempt already has a different order id,
--                     or the order id belongs to another attempt
--   mismatch          amount, currency or receipt disagree
--   not_found         no such attempt

CREATE FUNCTION public.payment_record_order(
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
  v_attempt record;
BEGIN

  IF p_attempt_id IS NULL
     OR p_provider_order_id IS NULL
     OR p_provider_order_id !~ '^order_[A-Za-z0-9]{1,40}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'a valid attempt id and provider order id are required';
  END IF;

  -- L6 (no booking lock is needed: nothing here reads or waits for
  -- the booking, so this cannot invert the booking -> attempt order)
  SELECT a.id, a.state, a.provider_order_id, a.amount_paise, a.currency
  INTO v_attempt
  FROM public.payment_attempts a
  WHERE a.id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  IF p_amount_paise IS DISTINCT FROM v_attempt.amount_paise
     OR p_currency IS DISTINCT FROM v_attempt.currency
     OR p_receipt IS DISTINCT FROM v_attempt.id::text THEN
    RETURN jsonb_build_object('outcome', 'mismatch');
  END IF;

  IF v_attempt.provider_order_id IS NOT NULL THEN
    IF v_attempt.provider_order_id = p_provider_order_id THEN
      RETURN jsonb_build_object('outcome', 'already_recorded', 'state', v_attempt.state::text);
    END IF;
    RETURN jsonb_build_object('outcome', 'conflict');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.payment_attempts o
    WHERE o.provider_order_id = p_provider_order_id
      AND o.id <> p_attempt_id
  ) THEN
    RETURN jsonb_build_object('outcome', 'conflict');
  END IF;

  IF v_attempt.state = 'closed' THEN
    UPDATE public.payment_attempts a
    SET provider_order_id = p_provider_order_id,
        order_lease_until = NULL
    WHERE a.id = p_attempt_id;
    RETURN jsonb_build_object('outcome', 'attempt_closed');
  END IF;

  UPDATE public.payment_attempts a
  SET provider_order_id = p_provider_order_id,
      state = 'open',
      order_lease_until = NULL
  WHERE a.id = p_attempt_id;

  RETURN jsonb_build_object('outcome', 'recorded');

END;
$$;


-- ============================================================
-- 3. Order creation: close an attempt after a DEFINITIVE failure
-- ============================================================
--
-- Only for an attempt that is still 'creating' and has NO order id:
-- the provider definitively rejected the creation, or answered with
-- an order that did not match what we asked for (that order is then
-- never recorded, so any payment on it stays unmatched). An
-- AMBIGUOUS outcome (timeout, network error, 5xx) must NOT call
-- this: the attempt stays 'creating' and is recovered by receipt.
--
--   closed | not_closable | not_found

CREATE FUNCTION public.payment_close_attempt(
  p_attempt_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_attempt record;
BEGIN

  IF p_attempt_id IS NULL OR p_reason IS NULL OR p_reason !~ '^[a-z][a-z0-9_]{0,99}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'an attempt id and a reason code ([a-z][a-z0-9_]*) are required';
  END IF;

  SELECT a.id, a.state, a.provider_order_id
  INTO v_attempt
  FROM public.payment_attempts a
  WHERE a.id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  IF v_attempt.state <> 'creating' OR v_attempt.provider_order_id IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'not_closable', 'state', v_attempt.state::text);
  END IF;

  UPDATE public.payment_attempts a
  SET state = 'closed',
      closed_at = now(),
      closed_reason = p_reason,
      order_lease_until = NULL
  WHERE a.id = p_attempt_id;

  RETURN jsonb_build_object('outcome', 'closed');

END;
$$;


-- ============================================================
-- 4. Webhook inbox
-- ============================================================
--
-- The Edge Function calls this only AFTER verifying the signature
-- over the raw body. Deliveries are at-least-once: the provider
-- event id (x-razorpay-event-id) is the dedupe key. The payload
-- stored is the minimised allow-list the Edge Function builds (no
-- customer contact data, no raw body).
--
--   { event_id, inserted, processed }

CREATE FUNCTION public.payment_ingest_event(
  p_provider_event_id text,
  p_event_type text,
  p_provider_payment_id text,
  p_provider_order_id text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  v_processed timestamptz;
  v_inserted boolean := false;
BEGIN

  IF p_provider_event_id IS NULL
     OR char_length(p_provider_event_id) NOT BETWEEN 1 AND 255
     OR p_event_type IS NULL
     OR char_length(p_event_type) NOT BETWEEN 1 AND 100
     OR p_payload IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'event id, event type and payload are required';
  END IF;

  INSERT INTO public.payment_events
    (provider, provider_event_id, source, event_type, provider_payment_id, provider_order_id, payload)
  VALUES
    ('razorpay', p_provider_event_id, 'webhook', p_event_type,
     left(p_provider_payment_id, 255), left(p_provider_order_id, 255), p_payload)
  ON CONFLICT (provider, provider_event_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    v_inserted := true;
  END IF;

  SELECT e.id, e.processed_at
  INTO v_id, v_processed
  FROM public.payment_events e
  WHERE e.provider = 'razorpay'
    AND e.provider_event_id = p_provider_event_id;

  RETURN jsonb_build_object(
    'event_id', v_id,
    'inserted', v_inserted,
    'processed', v_processed IS NOT NULL
  );

END;
$$;


-- Event bookkeeping without an observation: an event type this slice
-- does not act on (processed, with a result), or a transient failure
-- (NOT processed; attempts and last_error recorded, so a redelivery
-- or a later reconciliation picks it up).
--
--   ignored | failure_recorded | already_processed | not_found

CREATE FUNCTION public.payment_mark_event(
  p_event_id uuid,
  p_result text,
  p_error text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_processed timestamptz;
BEGIN

  IF p_event_id IS NULL OR p_result IS NULL OR p_result !~ '^[a-z][a-z0-9_:]{0,99}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'an event id and a result code are required';
  END IF;

  SELECT e.processed_at INTO v_processed
  FROM public.payment_events e
  WHERE e.id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  IF v_processed IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'already_processed');
  END IF;

  IF p_error IS NULL THEN
    UPDATE public.payment_events e
    SET processed_at = now(),
        process_result = p_result,
        attempts = e.attempts + 1
    WHERE e.id = p_event_id;
    RETURN jsonb_build_object('outcome', 'ignored');
  END IF;

  UPDATE public.payment_events e
  SET attempts = e.attempts + 1,
      process_result = p_result,
      last_error = left(p_error, 2000)
  WHERE e.id = p_event_id;

  RETURN jsonb_build_object('outcome', 'failure_recorded');

END;
$$;


-- ============================================================
-- 5. Settlement (internal; reachable only through section 6)
-- ============================================================
--
-- Runs under locks taken in the documented order and decides once.
-- Re-validates everything it relies on after the locks are held.
-- Not executable by any client role or by service_role: it must only
-- run on facts that payment_apply_observation has just merged.

CREATE FUNCTION public.payment_settle_locked(p_payment_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_booking_id uuid;
  v_booking record;
  v_attempt record;
  v_payment record;
  v_decision text;
BEGIN

  SELECT p.booking_id INTO v_booking_id
  FROM public.payments p
  WHERE p.id = p_payment_id;

  IF v_booking_id IS NULL THEN
    RETURN 'unmatched';
  END IF;

  -- L5: booking (the caller may already hold it; re-entrant)
  SELECT b.id, b.status, b.expires_at, b.amount, b.fulfilled_by_payment_id
  INTO v_booking
  FROM public.bookings b
  WHERE b.id = v_booking_id
  FOR UPDATE;

  -- L6: every live attempt of the booking (closed on fulfilment) and
  -- the payment's own attempt, in id order
  PERFORM 1
  FROM public.payment_attempts a
  WHERE a.booking_id = v_booking_id
    AND (a.state IN ('creating', 'open')
         OR a.id = (SELECT p.attempt_id FROM public.payments p WHERE p.id = p_payment_id))
  ORDER BY a.id
  FOR UPDATE;

  -- L7: the payment, re-read under its lock
  SELECT p.id, p.attempt_id, p.booking_id, p.provider_status, p.amount_paise, p.currency,
         p.provider_amount_refunded_paise, p.decision_recorded_at
  INTO v_payment
  FROM public.payments p
  WHERE p.id = p_payment_id
  FOR UPDATE;

  IF v_payment.attempt_id IS NULL OR v_payment.booking_id IS DISTINCT FROM v_booking_id THEN
    RETURN 'association_changed';
  END IF;

  SELECT a.id, a.state, a.amount_paise, a.currency
  INTO v_attempt
  FROM public.payment_attempts a
  WHERE a.id = v_payment.attempt_id;

  IF v_payment.provider_status NOT IN ('captured', 'refunded') THEN
    RETURN 'not_captured';
  END IF;

  IF v_booking.fulfilled_by_payment_id = v_payment.id THEN
    RETURN 'already_fulfilled';
  END IF;

  IF v_payment.decision_recorded_at IS NOT NULL THEN
    RETURN 'already_decided';
  END IF;

  -- Integrity: cannot happen through the composite foreign key and
  -- the immutable booking amount, but never fulfil (or decide) on it.
  IF v_payment.currency <> 'INR'
     OR v_payment.amount_paise <> round(v_booking.amount * 100)::bigint
     OR v_payment.amount_paise <> v_attempt.amount_paise THEN
    RETURN 'amount_mismatch';
  END IF;

  IF v_payment.provider_status = 'refunded' OR v_payment.provider_amount_refunded_paise <> 0 THEN
    v_decision := 'refunded_before_settlement';
  ELSIF v_booking.fulfilled_by_payment_id IS NOT NULL THEN
    v_decision := 'duplicate_capture';
  ELSIF v_booking.status <> 'pending_payment'
        OR v_booking.expires_at IS NULL
        OR v_booking.expires_at <= now()
        OR v_attempt.state = 'closed' THEN
    v_decision := 'late_capture';
  ELSIF EXISTS (
    SELECT 1 FROM public.refunds r
    WHERE r.payment_id = v_payment.id AND r.state <> 'failed'
  ) THEN
    v_decision := 'refund_obligation';
  ELSE
    v_decision := 'fulfilled';
  END IF;

  IF v_decision = 'fulfilled' THEN

    -- The approved transition, in ONE update; the slice 1a triggers
    -- re-check eligibility under their own payment-row lock.
    UPDATE public.bookings b
    SET status = 'confirmed',
        payment_status = 'paid',
        confirmed_at = now(),
        fulfilled_by_payment_id = v_payment.id
    WHERE b.id = v_booking_id;

    UPDATE public.payment_attempts a
    SET state = 'closed',
        closed_at = now(),
        closed_reason = 'fulfilled',
        order_lease_until = NULL
    WHERE a.booking_id = v_booking_id
      AND a.state IN ('creating', 'open');

  ELSIF v_decision = 'late_capture' AND v_booking.status <> 'pending_payment' THEN

    -- The booking will never be payable again: stop offering its
    -- live attempts. (A hold that expired only by the clock is left
    -- to the expiry sweep, which owns the booking status.)
    UPDATE public.payment_attempts a
    SET state = 'closed',
        closed_at = now(),
        closed_reason = 'booking_' || v_booking.status::text,
        order_lease_until = NULL
    WHERE a.booking_id = v_booking_id
      AND a.state IN ('creating', 'open');

  END IF;

  UPDATE public.payments p
  SET decision_recorded_at = now()
  WHERE p.id = v_payment.id;

  RETURN v_decision;

END;
$$;


-- ============================================================
-- 6. Observation (+ settlement), the trusted entry point
-- ============================================================
--
-- p_* are facts the Edge Function just fetched from the provider API
-- with the server credential (never the webhook body, never client
-- input). The function:
--
--   1. rejects every isolation level but READ COMMITTED (UB004);
--   2. finds the attempt that owns the payment's order id, if any,
--      and checks the payment against it (amount, currency);
--   3. locks the booking FIRST when the payment is, or may become,
--      matched (lock order);
--   4. inserts the payment, or MERGES into the stored row: identity
--      facts are never overwritten (a disagreement is an anomaly and
--      changes nothing), status only moves forward on the
--      captured/refunded side, the refunded total only grows,
--      write-once markers are filled once;
--   5. associates the payment with the attempt only when every check
--      passed; otherwise it stays unmatched (booking and attempt
--      NULL) and is counted as a resolution attempt;
--   6. settles a captured, matched payment (section 5);
--   7. marks the carrying event processed with the outcome, in the
--      same transaction (p_event_id may be NULL for an API-only
--      observation).
--
-- Outcome: { payment_id, matched, observation, settlement }
--
--   observation:  inserted | merged | unchanged | identity_conflict |
--                 order_conflict | association_conflict
--   match reason when unmatched: unknown_order | no_order |
--                 amount_mismatch | currency_mismatch | dispositioned

CREATE FUNCTION public.payment_apply_observation(
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
    v_unmatched_reason := 'association_conflict';
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
      -- associated concurrently with a booking we do not hold: do not
      -- touch it in this transaction (a retry takes the right lock)
      v_observation := 'association_conflict';
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

    IF v_observation IN ('association_conflict', 'identity_conflict', 'order_conflict') THEN
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
-- 7. Privileges
-- ============================================================
--
-- Supabase's default privileges grant EXECUTE on new public
-- functions to anon, authenticated and service_role, and PostgreSQL
-- grants it to PUBLIC. Remove all of it; give the Edge Functions'
-- credential (service_role) exactly the entry points. The internal
-- settlement step is executable by nobody but its owner.

REVOKE ALL ON FUNCTION public.payment_prepare_attempt(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.payment_record_order(uuid, text, bigint, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.payment_close_attempt(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.payment_ingest_event(text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.payment_mark_event(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.payment_settle_locked(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.payment_apply_observation(uuid, text, text, text, bigint, text, bigint, timestamptz, text, text) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.payment_prepare_attempt(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.payment_record_order(uuid, text, bigint, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.payment_close_attempt(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.payment_ingest_event(text, text, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.payment_mark_event(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.payment_apply_observation(uuid, text, text, text, bigint, text, bigint, timestamptz, text, text) TO service_role;
