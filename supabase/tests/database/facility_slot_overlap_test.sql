begin;

select plan(22);

-- ============================================================
-- Fixture (isolated ids, rolled back at the end)
--
-- Users (f1000000-0000-0000-0000-00000000000N):
--   01 OWNER   (profile created by the auth trigger; the owner
--              role is not needed because rows are inserted by the
--              table owner, which bypasses RLS)
--
-- Facilities (f2000000-0000-0000-0000-00000000000N), owned by OWNER:
--   01 and 02
--
-- Slots on facility 01 (f3000000-...):
--   01  18:00-19:00 active
--   02  20:00-21:00 active
--   03  10:00-11:00 INACTIVE
-- Slots on facility 02:
--   04  10:30-11:30 active
-- ============================================================

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
values ('f1000000-0000-0000-0000-000000000001', 'fso-owner@example.com', '', now(), '{"full_name":"FSO Owner"}');

insert into public.facilities (id, owner_id, name, sport, address, city, status, base_price)
values
  ('f2000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001',
   'FSO One', 'Badminton', 'Test Address One', 'Test City', 'active', 500),
  ('f2000000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000001',
   'FSO Two', 'Badminton', 'Test Address Two', 'Test City', 'active', 500);

insert into public.facility_slots
  (id, facility_id, start_time, end_time, duration_min, base_price, is_active)
values
  ('f3000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', '18:00', '19:00', 60, 500, true),
  ('f3000000-0000-0000-0000-000000000002', 'f2000000-0000-0000-0000-000000000001', '20:00', '21:00', 60, 500, true),
  ('f3000000-0000-0000-0000-000000000003', 'f2000000-0000-0000-0000-000000000001', '10:00', '11:00', 60, 500, false),
  ('f3000000-0000-0000-0000-000000000004', 'f2000000-0000-0000-0000-000000000002', '10:30', '11:30', 60, 500, true);


-- ============================================================
-- Constraint shape
-- ============================================================

select is(
  (select contype::text from pg_constraint
   where conrelid = 'public.facility_slots'::regclass
     and conname = 'facility_slots_no_overlap'),
  'x',
  'facility_slots_no_overlap is an exclusion constraint'
);

select ok(
  (select pg_get_constraintdef(oid) from pg_constraint
   where conrelid = 'public.facility_slots'::regclass
     and conname = 'facility_slots_no_overlap')
  ~ 'facility_id WITH =.*tsrange.*WITH &&',
  'it keys on facility_id and a tsrange overlap'
);

select ok(
  (select pg_get_constraintdef(oid) from pg_constraint
   where conrelid = 'public.facility_slots'::regclass
     and conname = 'facility_slots_no_overlap')
  !~ 'WHERE',
  'it is not partial: inactive slots participate'
);

select is(
  (select count(*)::integer from pg_constraint
   where conrelid = 'public.facility_slots'::regclass
     and conname = 'facility_slots_unique_time'),
  1,
  'facility_slots_unique_time is preserved'
);

select is(
  (select count(*)::integer from pg_constraint
   where conrelid = 'public.bookings'::regclass
     and conname = 'bookings_no_overlap'),
  1,
  'bookings_no_overlap is preserved'
);


-- ============================================================
-- INSERT: rejected overlaps (23P01, the exclusion violation)
-- ============================================================

-- Identical interval: the older unique constraint answers first (23505).
select throws_ok(
  $$ insert into public.facility_slots (facility_id, start_time, end_time, duration_min, base_price)
     values ('f2000000-0000-0000-0000-000000000001', '18:00', '19:00', 60, 500) $$,
  '23505',
  NULL,
  'identical interval at the same facility is rejected'
);

select throws_ok(
  $$ insert into public.facility_slots (facility_id, start_time, end_time, duration_min, base_price)
     values ('f2000000-0000-0000-0000-000000000001', '18:30', '19:30', 60, 500) $$,
  '23P01',
  NULL,
  'partial overlap (later) is rejected'
);

select throws_ok(
  $$ insert into public.facility_slots (facility_id, start_time, end_time, duration_min, base_price)
     values ('f2000000-0000-0000-0000-000000000001', '17:30', '18:30', 60, 500) $$,
  '23P01',
  NULL,
  'partial overlap (earlier) is rejected'
);

select throws_ok(
  $$ insert into public.facility_slots (facility_id, start_time, end_time, duration_min, base_price)
     values ('f2000000-0000-0000-0000-000000000001', '18:15', '18:45', 30, 500) $$,
  '23P01',
  NULL,
  'an interval contained in an existing one is rejected'
);

select throws_ok(
  $$ insert into public.facility_slots (facility_id, start_time, end_time, duration_min, base_price)
     values ('f2000000-0000-0000-0000-000000000001', '17:00', '20:00', 180, 500) $$,
  '23P01',
  NULL,
  'an interval containing existing ones is rejected'
);

-- Different times but the same facility and an inactive blocker.
select throws_ok(
  $$ insert into public.facility_slots (facility_id, start_time, end_time, duration_min, base_price)
     values ('f2000000-0000-0000-0000-000000000001', '10:30', '11:30', 60, 500) $$,
  '23P01',
  NULL,
  'an INACTIVE slot still blocks an overlapping slot'
);

select throws_ok(
  $$ insert into public.facility_slots (facility_id, start_time, end_time, duration_min, base_price, is_active)
     values ('f2000000-0000-0000-0000-000000000001', '10:30', '11:30', 60, 500, false) $$,
  '23P01',
  NULL,
  'an inactive new slot is checked as well'
);


-- ============================================================
-- INSERT: accepted
-- ============================================================

select lives_ok(
  $$ insert into public.facility_slots (id, facility_id, start_time, end_time, duration_min, base_price)
     values ('f3000000-0000-0000-0000-000000000011', 'f2000000-0000-0000-0000-000000000001', '19:00', '20:00', 60, 500) $$,
  'adjacent interval (between two existing slots) is accepted'
);

select lives_ok(
  $$ insert into public.facility_slots (id, facility_id, start_time, end_time, duration_min, base_price)
     values ('f3000000-0000-0000-0000-000000000012', 'f2000000-0000-0000-0000-000000000001', '17:00', '18:00', 60, 500) $$,
  'adjacent interval before an existing slot is accepted'
);

select lives_ok(
  $$ insert into public.facility_slots (id, facility_id, start_time, end_time, duration_min, base_price)
     values ('f3000000-0000-0000-0000-000000000013', 'f2000000-0000-0000-0000-000000000002', '18:00', '19:00', 60, 500) $$,
  'identical interval at a different facility is accepted'
);


-- ============================================================
-- UPDATE
-- ============================================================

select throws_ok(
  $$ update public.facility_slots
     set start_time = '18:30', end_time = '19:30'
     where id = 'f3000000-0000-0000-0000-000000000002' $$,
  '23P01',
  NULL,
  'an UPDATE that introduces an overlap is rejected'
);

select throws_ok(
  $$ update public.facility_slots
     set facility_id = 'f2000000-0000-0000-0000-000000000002'
     where id = 'f3000000-0000-0000-0000-000000000003' $$,
  '23514',
  NULL,
  'moving a slot into another facility is rejected (facility_id is immutable; the trigger answers before the overlap constraint)'
);

select lives_ok(
  $$ update public.facility_slots
     set start_time = '21:00', end_time = '22:00'
     where id = 'f3000000-0000-0000-0000-000000000002' $$,
  'an UPDATE to a non-overlapping interval succeeds'
);

select lives_ok(
  $$ update public.facility_slots
     set is_active = false
     where id = 'f3000000-0000-0000-0000-000000000001' $$,
  'deactivating a slot (no time change) succeeds'
);

select lives_ok(
  $$ update public.facility_slots
     set is_active = true
     where id = 'f3000000-0000-0000-0000-000000000003' $$,
  'reactivating a slot that overlaps nothing succeeds'
);


-- ============================================================
-- Existing behaviour is intact
-- ============================================================

select throws_ok(
  $$ insert into public.facility_slots (facility_id, start_time, end_time, duration_min, base_price)
     values ('f2000000-0000-0000-0000-0000000000ff', '05:00', '06:00', 60, 500) $$,
  '23503',
  NULL,
  'a slot for a missing facility is still a foreign-key violation'
);

select throws_ok(
  $$ insert into public.facility_slots (facility_id, start_time, end_time, duration_min, base_price)
     values ('f2000000-0000-0000-0000-000000000002', '06:00', '06:00', 60, 500) $$,
  '23514',
  NULL,
  'start_time < end_time is still enforced'
);

select * from finish();

rollback;
