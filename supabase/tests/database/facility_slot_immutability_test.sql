begin;

select plan(24);


-- ============================================================
-- facility_slots.facility_id is immutable
-- (trigger facility_slots_facility_id_immutable)
--
-- Fixture (rolled back):
--   Users     f1100000-...-0N  01 owner of both facilities, 02 customer,
--                              03 ADMIN (profile role admin)
--   Facilities f1200000-...-0N 01 and 02, both owned by user 01
--   Slots      f1300000-...-0N
--                01  F1 08:00-09:00  unreferenced
--                02  F1 10:00-11:00  has a booking
--                03  F1 12:00-13:00  has a waitlist entry
--                04  F2 18:00-19:00  free target facility content
--
-- The admin profile is created by replacing the auto-created row
-- (data only); no trigger is disabled.
-- ============================================================

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
select
  ('f1100000-0000-0000-0000-00000000000' || n)::uuid,
  'fsi2-user' || n || '@example.com', '', now(), '{}'::jsonb
from generate_series(1, 3) n;

delete from public.profiles where id = 'f1100000-0000-0000-0000-000000000003';
insert into public.profiles (id, full_name, role)
values ('f1100000-0000-0000-0000-000000000003', 'FSI Admin', 'admin');

insert into public.facilities (id, owner_id, name, sport, address, city, status, base_price)
values
  ('f1200000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001',
   'FSI2 One', 'Badminton', 'Test Address One', 'Test City', 'active', 500),
  ('f1200000-0000-0000-0000-000000000002', 'f1100000-0000-0000-0000-000000000001',
   'FSI2 Two', 'Badminton', 'Test Address Two', 'Test City', 'active', 500);

insert into public.facility_slots (id, facility_id, start_time, end_time, duration_min, base_price)
values
  ('f1300000-0000-0000-0000-000000000001', 'f1200000-0000-0000-0000-000000000001', '08:00', '09:00', 60, 500),
  ('f1300000-0000-0000-0000-000000000002', 'f1200000-0000-0000-0000-000000000001', '10:00', '11:00', 60, 500),
  ('f1300000-0000-0000-0000-000000000003', 'f1200000-0000-0000-0000-000000000001', '12:00', '13:00', 60, 500),
  ('f1300000-0000-0000-0000-000000000004', 'f1200000-0000-0000-0000-000000000002', '18:00', '19:00', 60, 500);

insert into public.bookings (user_id, facility_id, slot_id, booking_date, start_time, end_time, amount, status, payment_status)
values ('f1100000-0000-0000-0000-000000000002', 'f1200000-0000-0000-0000-000000000001',
        'f1300000-0000-0000-0000-000000000002', current_date + 5, '10:00', '11:00', 500, 'confirmed', 'paid');

insert into public.waitlist_entries (user_id, facility_id, slot_id, booking_date)
values ('f1100000-0000-0000-0000-000000000002', 'f1200000-0000-0000-0000-000000000001',
        'f1300000-0000-0000-0000-000000000003', current_date + 5);


-- ============================================================
-- Trigger and function shape
-- ============================================================

select ok(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.facility_slots'::regclass
      and tgname = 'facility_slots_facility_id_immutable'
      and tgenabled = 'O'
      and not tgisinternal
      and tgfoid = 'public.prevent_slot_facility_change()'::regprocedure
  ),
  'the trigger exists, is enabled and calls prevent_slot_facility_change()'
);

select ok(
  (select (tgtype & 2) = 2 and (tgtype & 16) = 16 and (tgtype & 1) = 1
   from pg_trigger
   where tgrelid = 'public.facility_slots'::regclass
     and tgname = 'facility_slots_facility_id_immutable'),
  'it is a BEFORE UPDATE row-level trigger'
);

select ok(
  (select pg_get_triggerdef(oid) ~ 'UPDATE OF facility_id'
      and pg_get_triggerdef(oid) ~ 'WHEN'
   from pg_trigger
   where tgname = 'facility_slots_facility_id_immutable'),
  'it is limited to the facility_id column and has a WHEN clause'
);

select ok(
  (select not p.prosecdef
      and array_to_string(p.proconfig, ',') = 'search_path=""'
   from pg_proc p
   where p.oid = 'public.prevent_slot_facility_change()'::regprocedure),
  'the function is SECURITY INVOKER with an empty search_path'
);

select ok(
  not has_function_privilege('anon', 'public.prevent_slot_facility_change()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.prevent_slot_facility_change()', 'EXECUTE'),
  'clients cannot execute the trigger function directly'
);

select ok(
  (select coalesce(proacl::text, '') !~ '(^\{|,)=X'
   from pg_proc
   where oid = 'public.prevent_slot_facility_change()'::regprocedure),
  'PUBLIC has no EXECUTE on the trigger function'
);


-- ============================================================
-- Owner
-- ============================================================

set local role authenticated;
set local request.jwt.claim.sub = 'f1100000-0000-0000-0000-000000000001';

select throws_ok(
  $$ update public.facility_slots
     set facility_id = 'f1200000-0000-0000-0000-000000000002'
     where id = 'f1300000-0000-0000-0000-000000000001' $$,
  '23514',
  NULL,
  'owner: an unreferenced slot cannot change facility'
);

select throws_ok(
  $$ update public.facility_slots
     set facility_id = 'f1200000-0000-0000-0000-000000000002'
     where id = 'f1300000-0000-0000-0000-000000000002' $$,
  '23514',
  NULL,
  'owner: a slot with a booking cannot change facility'
);

select throws_ok(
  $$ update public.facility_slots
     set facility_id = 'f1200000-0000-0000-0000-000000000002'
     where id = 'f1300000-0000-0000-0000-000000000003' $$,
  '23514',
  NULL,
  'owner: a slot with a waitlist entry cannot change facility'
);

select throws_ok(
  $$ update public.facility_slots
     set facility_id = 'f1200000-0000-0000-0000-000000000002'
     where id = 'f1300000-0000-0000-0000-000000000001' $$,
  '23514',
  'facility_slots.facility_id cannot be changed after the slot is created',
  'the message is the documented one'
);

select lives_ok(
  $$ update public.facility_slots
     set base_price = 650, duration_min = 60, is_active = false
     where id = 'f1300000-0000-0000-0000-000000000002' $$,
  'owner: other columns of a referenced slot remain editable'
);

select throws_ok(
  $$ update public.facility_slots
     set start_time = '10:30', end_time = '11:30'
     where id = 'f1300000-0000-0000-0000-000000000002' $$,
  '23514',
  NULL,
  'owner: the times of a slot with a live future booking are frozen (facility_slots_time_freeze)'
);

select lives_ok(
  $$ update public.facility_slots
     set start_time = '08:30', end_time = '09:30'
     where id = 'f1300000-0000-0000-0000-000000000001' $$,
  'owner: the times of an unreferenced slot remain editable'
);

select lives_ok(
  $$ update public.facility_slots
     set facility_id = facility_id
     where id = 'f1300000-0000-0000-0000-000000000001' $$,
  'owner: a no-op facility_id assignment is allowed'
);

select lives_ok(
  $$ update public.facility_slots
     set facility_id = facility_id, base_price = 700
     where id = 'f1300000-0000-0000-0000-000000000001' $$,
  'owner: a no-op facility_id plus another column change is allowed'
);

reset role;

select is(
  (select base_price::text from public.facility_slots
   where id = 'f1300000-0000-0000-0000-000000000001'),
  '700.00',
  'the allowed update was applied'
);

select is(
  (select facility_id::text from public.facility_slots
   where id = 'f1300000-0000-0000-0000-000000000001'),
  'f1200000-0000-0000-0000-000000000001',
  'the facility is unchanged after the rejected updates'
);


-- ============================================================
-- Administrator (is_admin() passes the UPDATE policy)
-- ============================================================

set local role authenticated;
set local request.jwt.claim.sub = 'f1100000-0000-0000-0000-000000000003';

select throws_ok(
  $$ update public.facility_slots
     set facility_id = 'f1200000-0000-0000-0000-000000000002'
     where id = 'f1300000-0000-0000-0000-000000000001' $$,
  '23514',
  NULL,
  'admin: facility_id cannot be changed either (no exemption)'
);

select lives_ok(
  $$ update public.facility_slots
     set base_price = 710
     where id = 'f1300000-0000-0000-0000-000000000001' $$,
  'admin: other columns remain editable (proves the policy lets the admin through)'
);

reset role;


-- ============================================================
-- service_role (bypasses RLS, not triggers) and the table owner
-- ============================================================

set local role service_role;

select throws_ok(
  $$ update public.facility_slots
     set facility_id = 'f1200000-0000-0000-0000-000000000002'
     where id = 'f1300000-0000-0000-0000-000000000002' $$,
  '23514',
  NULL,
  'service_role: facility_id cannot be changed'
);

reset role;

select throws_ok(
  $$ update public.facility_slots
     set facility_id = 'f1200000-0000-0000-0000-000000000002'
     where id = 'f1300000-0000-0000-0000-000000000003' $$,
  '23514',
  NULL,
  'postgres (table owner): facility_id cannot be changed'
);

select throws_ok(
  $$ update public.facility_slots
     set facility_id = 'f1200000-0000-0000-0000-000000000002', base_price = 1
     where id = 'f1300000-0000-0000-0000-000000000001' $$,
  '23514',
  NULL,
  'a facility change bundled with other edits is rejected as a whole'
);


-- ============================================================
-- Unrelated behaviour is unchanged
-- ============================================================

select lives_ok(
  $$ insert into public.facility_slots (facility_id, start_time, end_time, duration_min, base_price)
     values ('f1200000-0000-0000-0000-000000000002', '20:00', '21:00', 60, 500) $$,
  'INSERT is unaffected'
);

select is(
  (select count(*)::integer from pg_constraint
   where conrelid = 'public.facility_slots'::regclass
     and conname in ('facility_slots_no_overlap', 'facility_slots_unique_time')),
  2,
  'the overlap and uniqueness constraints are still installed'
);

select * from finish();

rollback;
