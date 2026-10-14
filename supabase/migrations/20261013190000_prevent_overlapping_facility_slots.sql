-- ============================================================
-- UniSport — Prevent overlapping facility slot definitions
-- ============================================================
--
-- Product rule: ONE FACILITY = ONE BOOKABLE RESOURCE.
--
-- facility_slots rows are recurring daily time-of-day intervals.
-- Until now the only database rule was UNIQUE (facility_id,
-- start_time, end_time), which rejects identical intervals but
-- accepts partial overlap and containment. bookings_no_overlap is
-- keyed on slot_id, so two overlapping slot rows of one facility
-- could both be booked for the same date.
--
-- This migration makes the invariant a database constraint:
--
--   * intervals are half-open [start_time, end_time), so
--     18:00-19:00 and 19:00-20:00 are allowed;
--   * every slot counts, active or inactive;
--   * facilities are independent of each other.
--
-- The check also covers UPDATE (changing times or facility_id).
--
-- Safety
--
--   * btree_gist is already installed by
--     20261008140917_bookings_payments.sql and is required for
--     "facility_id WITH =" in a GiST index.
--   * Existing rows are validated first. If any overlap exists the
--     migration aborts with a diagnostic and changes nothing; it
--     never deletes, deactivates or edits data.
--   * Supabase applies each migration file in one transaction, so a
--     failed validation or a failed ADD CONSTRAINT leaves no partial
--     state.
--
-- Unchanged on purpose: facility_slots_unique_time, bookings and
-- bookings_no_overlap, all functions, RLS, grants and triggers.
--
-- Rollback:
--   ALTER TABLE public.facility_slots
--     DROP CONSTRAINT facility_slots_no_overlap;
-- ============================================================


DO $$
DECLARE
  v_count integer;
  v_report text;
BEGIN

  SELECT
    count(*),
    string_agg(
      format(
        'facility %s: slot %s [%s-%s) overlaps slot %s [%s-%s)',
        a.facility_id,
        a.id, a.start_time, a.end_time,
        b.id, b.start_time, b.end_time
      ),
      E'\n'
      ORDER BY a.facility_id, a.start_time, a.id, b.id
    )
  INTO v_count, v_report
  FROM public.facility_slots a
  JOIN public.facility_slots b
    ON b.facility_id = a.facility_id
   AND a.id < b.id
   AND a.start_time < b.end_time
   AND b.start_time < a.end_time;

  IF v_count > 0 THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '23P01',
        MESSAGE = format(
          'Cannot add facility_slots_no_overlap: %s overlapping slot pair(s) exist. Resolve them manually, then re-run this migration.',
          v_count
        ),
        DETAIL = v_report;
  END IF;

END
$$;


ALTER TABLE public.facility_slots
  ADD CONSTRAINT facility_slots_no_overlap
  EXCLUDE USING gist (
    facility_id WITH =,
    tsrange(
      date '2000-01-01' + start_time,
      date '2000-01-01' + end_time,
      '[)'
    ) WITH &&
  );
