-- ============================================================
-- UniSport — Facility-level booking overlap protection
-- ============================================================
--
-- Product rule: ONE FACILITY = ONE BOOKABLE RESOURCE. Two active
-- bookings at the same facility must never occupy overlapping time.
--
-- bookings_no_overlap is keyed on slot_id, so it only compares
-- bookings of the SAME slot row. If a slot's times are edited after
-- bookings exist (the owner UPDATE policy allows it), bookings of
-- two different slots of one facility can end up overlapping in real
-- time and bookings_no_overlap cannot see it.
--
-- This migration adds the same exclusion keyed on facility_id:
--
--   * interval = the booking's own start_time/end_time SNAPSHOT on
--     booking_date, half-open [start, end), so 18:00-19:00 and
--     19:00-20:00 are allowed;
--   * only pending_payment, confirmed and completed bookings take
--     part (cancelled and expired ones never block anything);
--   * enforced by the index, so it is safe under concurrent inserts.
--
-- bookings_no_overlap is kept unchanged.
--
-- Safety
--
--   * btree_gist is already installed by
--     20261008140917_bookings_payments.sql.
--   * Existing rows are validated first. If any overlap exists the
--     migration aborts with a diagnostic and changes nothing; it
--     never deletes, expires, cancels or edits data.
--   * A pending_payment hold whose expires_at has passed still has
--     status pending_payment until a sweep runs, and would make the
--     constraint fail. The diagnostic says so; running
--     public.expire_pending_bookings() (the scheduled job) and
--     re-running this migration is the intended way out. Nothing
--     here does that automatically.
--   * Supabase applies each migration file in one transaction, so a
--     failed validation or ADD CONSTRAINT leaves no partial state.
--
-- Rollback:
--   ALTER TABLE public.bookings
--     DROP CONSTRAINT bookings_no_facility_overlap;
-- ============================================================


DO $$
DECLARE
  v_count integer;
  v_stale integer;
  v_report text;
BEGIN

  SELECT
    count(*),
    count(*) FILTER (
      WHERE (a.status = 'pending_payment' AND a.expires_at <= now())
         OR (b.status = 'pending_payment' AND b.expires_at <= now())
    ),
    string_agg(
      format(
        'facility %s on %s: booking %s [%s-%s) %s%s overlaps booking %s [%s-%s) %s%s',
        a.facility_id,
        a.booking_date,
        a.id, a.start_time, a.end_time, a.status,
        CASE WHEN a.status = 'pending_payment'
             THEN ' (expires_at ' || coalesce(a.expires_at::text, 'null')
                  || CASE WHEN a.expires_at <= now() THEN ', EXPIRED' ELSE '' END || ')'
             ELSE '' END,
        b.id, b.start_time, b.end_time, b.status,
        CASE WHEN b.status = 'pending_payment'
             THEN ' (expires_at ' || coalesce(b.expires_at::text, 'null')
                  || CASE WHEN b.expires_at <= now() THEN ', EXPIRED' ELSE '' END || ')'
             ELSE '' END
      ),
      E'\n'
      ORDER BY a.facility_id, a.booking_date, a.start_time, a.id, b.id
    )
  INTO v_count, v_stale, v_report
  FROM public.bookings a
  JOIN public.bookings b
    ON b.facility_id = a.facility_id
   AND b.booking_date = a.booking_date
   AND a.id < b.id
   AND a.start_time < b.end_time
   AND b.start_time < a.end_time
  WHERE a.status IN ('pending_payment', 'confirmed', 'completed')
    AND b.status IN ('pending_payment', 'confirmed', 'completed');

  IF v_count > 0 THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '23P01',
        MESSAGE = format(
          'Cannot add bookings_no_facility_overlap: %s overlapping active booking pair(s) exist. Resolve them manually, then re-run this migration.',
          v_count
        ),
        DETAIL = v_report,
        HINT = CASE
          WHEN v_stale > 0 THEN format(
            '%s conflict(s) involve a pending_payment hold already past expires_at. Run "select public.expire_pending_bookings();" and retry; those holds are expired and no longer block.',
            v_stale
          )
          ELSE 'No conflicting hold has expired; the bookings genuinely overlap and need a manual decision.'
        END;
  END IF;

END
$$;


ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_no_facility_overlap
  EXCLUDE USING gist (
    facility_id WITH =,
    tsrange(
      booking_date + start_time,
      booking_date + end_time,
      '[)'
    ) WITH &&
  )
  WHERE (status IN ('pending_payment', 'confirmed', 'completed'));
