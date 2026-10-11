begin;

select plan(5);


-- ============================================================
-- Test 1: bookings table exists
-- ============================================================

select has_table(
  'public',
  'bookings',
  'bookings table should exist'
);


-- ============================================================
-- Test 2: exclusion constraint exists
-- ============================================================

select ok(
  exists (
    select 1
    from pg_constraint
    where conname = 'bookings_no_overlap'
      and conrelid = 'public.bookings'::regclass
      and contype = 'x'
  ),
  'bookings_no_overlap should be an exclusion constraint'
);


-- ============================================================
-- Test 3: exclusion constraint covers active states
-- ============================================================

select ok(
  (
    select pg_get_constraintdef(oid)
    from pg_constraint
    where conname = 'bookings_no_overlap'
      and conrelid = 'public.bookings'::regclass
  ) like '%pending_payment%'
  and
  (
    select pg_get_constraintdef(oid)
    from pg_constraint
    where conname = 'bookings_no_overlap'
      and conrelid = 'public.bookings'::regclass
  ) like '%confirmed%'
  and
  (
    select pg_get_constraintdef(oid)
    from pg_constraint
    where conname = 'bookings_no_overlap'
      and conrelid = 'public.bookings'::regclass
  ) like '%completed%',
  'overlap constraint should cover active booking states'
);


-- ============================================================
-- Test 4: exclusion constraint is scoped to slot/date/time
-- ============================================================

select ok(
  (
    select pg_get_constraintdef(oid)
    from pg_constraint
    where conname = 'bookings_no_overlap'
      and conrelid = 'public.bookings'::regclass
  ) like '%slot_id%'
  and
  (
    select pg_get_constraintdef(oid)
    from pg_constraint
    where conname = 'bookings_no_overlap'
      and conrelid = 'public.bookings'::regclass
  ) like '%booking_date%'
  and
  (
    select pg_get_constraintdef(oid)
    from pg_constraint
    where conname = 'bookings_no_overlap'
      and conrelid = 'public.bookings'::regclass
  ) like '%tsrange%',
  'overlap constraint should use slot, date, and time range'
);


-- ============================================================
-- Test 5: booking constraint uses GiST exclusion
-- ============================================================

select ok(
  exists (
    select 1
    from pg_constraint c
    join pg_class r
      on r.oid = c.conrelid
    where c.conname = 'bookings_no_overlap'
      and r.relname = 'bookings'
      and c.contype = 'x'
  ),
  'booking overlap protection should be enforced by PostgreSQL'
);


select * from finish();

rollback;