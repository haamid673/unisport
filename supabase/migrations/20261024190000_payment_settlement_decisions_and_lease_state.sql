-- ============================================================
-- UniSport — Payment: durable settlement decisions, lease state in
-- recovery
-- ============================================================
--
-- 1. payments.settlement_decision
--
--    Until now a non-fulfilling decision (late_capture,
--    duplicate_capture, refunded_before_settlement, refund_obligation)
--    was labelled only in payment_events.process_result, which exists
--    only on the WEBHOOK path. A payment settled by explicit
--    verification or booking recovery (no event) kept just
--    decision_recorded_at, so a late capture and a duplicate capture
--    were indistinguishable afterwards.
--
--    The label is written by payment_settle_locked in the same UPDATE
--    that sets decision_recorded_at, under the payment row lock (lock
--    order unchanged: booking -> attempt -> payment). It is write-once:
--
--      * a trigger refuses to change or clear it, and refuses to set it
--        on a payment whose decision was already recorded (so it can
--        never be added later by a path that did not decide);
--      * CHECKs restrict the values and require a recorded decision;
--      * an observation of an already decided payment returns
--        'already_decided' and never reaches the UPDATE, so observing
--        a payment again, or two observations racing, cannot
--        reclassify it (the second waits for the payment row lock and
--        then sees the first one's decision).
--
--    NULL means "no label": the payment is undecided, or its decision
--    was recorded before this migration. The backfill labels only the
--    certain case (the payment that fulfilled its booking). It does
--    NOT guess a label for other pre-existing decisions.
--
--    The label is a record of OUR decision about the captured money. It
--    is not a refund and says nothing about whether one happened: refund
--    state lives in the refunds table (not implemented yet).
--
-- 2. payment_booking_payment_context (same signature and grants) also
--    reports
--      payment_decision   the stored label of p_provider_payment_id
--                         (of THIS booking), or null
--      checkout_lease     the Checkout lease state of the booking's open
--                         attempt: { state: none|active|ended, hash }
--                         or null when there is no open attempt. The
--                         Edge Function compares hash with the SHA-256
--                         of the caller's checkout session to tell
--                         "yours" from "another session". Service role
--                         only; never returned to the browser.
-- ============================================================

ALTER TABLE public.payments
  ADD COLUMN settlement_decision text;

COMMENT ON COLUMN public.payments.settlement_decision IS
  'Our write-once label for the fulfil-or-not decision recorded in decision_recorded_at: fulfilled, late_capture, duplicate_capture, refunded_before_settlement or refund_obligation. NULL: undecided, or decided before labels existed. Not a refund state.';

-- Backfill: only the certain case.
UPDATE public.payments p
SET settlement_decision = 'fulfilled'
FROM public.bookings b
WHERE b.fulfilled_by_payment_id = p.id
  AND p.decision_recorded_at IS NOT NULL
  AND p.settlement_decision IS NULL;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_settlement_decision_values
    CHECK (settlement_decision IS NULL OR settlement_decision IN (
      'fulfilled', 'late_capture', 'duplicate_capture',
      'refunded_before_settlement', 'refund_obligation')),
  ADD CONSTRAINT payments_settlement_decision_requires_decision
    CHECK (settlement_decision IS NULL OR decision_recorded_at IS NOT NULL);

CREATE FUNCTION public.payments_guard_settlement_decision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN

  IF OLD.settlement_decision IS NOT NULL
     AND NEW.settlement_decision IS DISTINCT FROM OLD.settlement_decision THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '23514',
        MESSAGE = 'payments.settlement_decision is write-once and cannot be changed or cleared',
        DETAIL = format('payment %s is labelled %s.', OLD.id, OLD.settlement_decision);
  END IF;

  -- The label may only be set by the update that records the decision.
  IF OLD.settlement_decision IS NULL
     AND NEW.settlement_decision IS NOT NULL
     AND OLD.decision_recorded_at IS NOT NULL THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '23514',
        MESSAGE = 'payments.settlement_decision can only be set together with decision_recorded_at',
        DETAIL = format('payment %s was decided without a label.', OLD.id);
  END IF;

  RETURN NEW;

END;
$$;

REVOKE EXECUTE ON FUNCTION public.payments_guard_settlement_decision()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER payments_guard_settlement_decision
BEFORE UPDATE ON public.payments
FOR EACH ROW
EXECUTE FUNCTION public.payments_guard_settlement_decision();


-- ============================================================
-- payment_settle_locked: record the label with the decision
-- ============================================================
--
-- Identical to 20261019190000 except for the final UPDATE. Same
-- signature; its REVOKE ALL (no role can execute it directly) is kept
-- by CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION public.payment_settle_locked(p_payment_id uuid)
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

  -- The decision and its label are recorded together, once. Observing
  -- the payment again returns 'already_decided' above and never
  -- reaches this statement, so a label is never recomputed.
  UPDATE public.payments p
  SET decision_recorded_at = now(),
      settlement_decision = v_decision
  WHERE p.id = v_payment.id;

  RETURN v_decision;

END;
$$;


-- ============================================================
-- payment_booking_payment_context: decision and lease state
-- ============================================================

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
    'payment_decision', (
      SELECT p.settlement_decision
      FROM public.payments p
      WHERE p.booking_id = p_booking_id
        AND p.provider = 'razorpay'
        AND p.provider_payment_id = p_provider_payment_id),
    'fulfilling_payment', (
      SELECT jsonb_build_object('provider_payment_id', p.provider_payment_id,
                                'provider_order_id', p.provider_order_id)
      FROM public.payments p
      WHERE p.id = v_booking.fulfilled_by_payment_id
        AND p.provider = 'razorpay'),
    'checkout_lease', (
      SELECT jsonb_build_object(
               'state', CASE
                          WHEN a.checkout_lease_until IS NULL THEN 'none'
                          WHEN a.checkout_lease_until <= now() THEN 'ended'
                          ELSE 'active' END,
               'hash', a.checkout_lease_hash)
      FROM public.payment_attempts a
      WHERE a.booking_id = p_booking_id
        AND a.state = 'open'),
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
