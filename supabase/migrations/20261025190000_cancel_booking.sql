-- ============================================================
-- UniSport — cancel_booking(): a customer cancels their own UNPAID hold
-- ============================================================
--
-- Scope (deliberately small)
--
--   * Only a pending_payment hold that is still running can be cancelled.
--   * A hold that has lapsed by the clock is reported as expired; nothing
--     is written (the expiry sweep owns that transition).
--   * A confirmed or completed booking cannot be cancelled here: that
--     needs a refund decision, which does not exist yet. Refused with
--     UB005.
--   * A hold with a payment attempt that is still creating or open is
--     refused with UB006: a payment may be in flight, and cancelling the
--     booking under it would strand the money as a late capture.
--
-- What it does
--
--   1. Authenticates (28000). Another user's booking is
--      indistinguishable from a missing one (P0002).
--   2. Takes the caller's user lock, then the booking row lock. This is
--      the documented order everywhere: user lock -> slot lock -> row.
--   3. cancelled and expired are idempotent: the stored status is
--      returned and nothing is written.
--   4. pending_payment and still running: status = 'cancelled' and
--      cancelled_at = now(); the slot is free for everyone from this
--      commit on.
--   5. Offers the freed slot to the next waiting entry, exactly as
--      leave_waitlist() does when an offer is released. That call is a
--      try-lock and never waits: if another session is deciding for the
--      same slot and date, the per-minute job offers it shortly after.
--
-- Concurrency
--
--   The booking row is locked FOR UPDATE. The expiry sweep uses
--   SKIP LOCKED, so it never waits for a cancel and a cancel never
--   waits for the sweep; whichever commits first wins and the other
--   sees a finished row. payment_prepare_attempt locks the booking row
--   before it creates an attempt (documented payment lock order:
--   booking -> attempt -> payment), so an attempt cannot start between
--   the check below and the update.
--
-- Security
--
--   SECURITY DEFINER with an empty search_path; EXECUTE for
--   authenticated and service_role only (never PUBLIC or anon).
-- ============================================================

CREATE FUNCTION public.cancel_booking(p_booking_id uuid)
RETURNS public.booking_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_booking public.bookings%ROWTYPE;
BEGIN

  v_user_id := (SELECT auth.uid());

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '28000',
        MESSAGE = 'Authentication required';
  END IF;

  IF p_booking_id IS NULL THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '22023',
        MESSAGE = 'Booking id is required';
  END IF;

  -- Lock order: user lock -> (slot lock, taken by the offer call below)
  -- -> rows. The same key create_booking() and join_waitlist() use.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('user-actions:' || v_user_id::text, 0)
  );

  -- Another user's booking is indistinguishable from a missing one.
  SELECT b.*
  INTO v_booking
  FROM public.bookings b
  WHERE b.id = p_booking_id
    AND b.user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      USING
        ERRCODE = 'P0002',
        MESSAGE = 'Booking not found';
  END IF;

  -- Finished already: idempotent, nothing is written.
  IF v_booking.status IN ('cancelled', 'expired') THEN
    RETURN v_booking.status;
  END IF;

  IF v_booking.status <> 'pending_payment' THEN
    RAISE EXCEPTION
      USING
        ERRCODE = 'UB005',
        MESSAGE = 'Only an unpaid hold can be cancelled';
  END IF;

  -- The hold has run out by the clock: it is expired, whatever the
  -- stored status says until the sweep reaches it.
  IF v_booking.expires_at <= now() THEN
    RETURN 'expired';
  END IF;

  -- A payment may be in flight for this hold.
  IF EXISTS (
    SELECT 1
    FROM public.payment_attempts a
    WHERE a.booking_id = v_booking.id
      AND a.state IN ('creating', 'open')
  ) THEN
    RAISE EXCEPTION
      USING
        ERRCODE = 'UB006',
        MESSAGE = 'A payment may be in progress for this booking; it cannot be cancelled now';
  END IF;

  UPDATE public.bookings b
  SET
    status = 'cancelled',
    cancelled_at = now()
  WHERE b.id = v_booking.id;

  -- The slot is free: offer it to the next waiting entry. A try-lock
  -- that never waits; the per-minute job covers a missed offer.
  PERFORM public.offer_next_waitlist_entry(
    v_booking.slot_id,
    v_booking.booking_date
  );

  RETURN 'cancelled';

END;
$$;

REVOKE ALL ON FUNCTION public.cancel_booking(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_booking(uuid) TO authenticated, service_role;
