begin;

select plan(22);


-- ============================================================
-- Test fixture
--
-- All dates are relative to current_date so this file does not
-- go stale. Fixture bookings use a different booking_date each,
-- so the overlap exclusion constraint is never involved.
-- ============================================================

insert into auth.users (
  id,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_user_meta_data
)
values
  (
    '11111111-1111-1111-1111-111111111111',
    'expiry-user@example.com',
    '',
    now(),
    '{"full_name":"Expiry Test User"}'
  ),
  (
    '22222222-2222-2222-2222-222222222222',
    'expiry-owner@example.com',
    '',
    now(),
    '{"full_name":"Expiry Test Owner"}'
  );

alter table public.profiles
disable trigger profiles_prevent_role_escalation;

update public.profiles
set role = 'owner'
where id = '22222222-2222-2222-2222-222222222222';

alter table public.profiles
enable trigger profiles_prevent_role_escalation;


insert into public.facilities (
  id,
  owner_id,
  name,
  description,
  sport,
  address,
  city,
  status,
  base_price
)
values (
  '33333333-3333-3333-3333-333333333333',
  '22222222-2222-2222-2222-222222222222',
  'Expiry Test Facility',
  'Temporary database test facility',
  'Football',
  'Test Address',
  'Test City',
  'active',
  500
);

insert into public.facility_slots (
  id,
  facility_id,
  start_time,
  end_time,
  duration_min,
  base_price,
  is_active
)
values (
  '44444444-4444-4444-4444-444444444444',
  '33333333-3333-3333-3333-333333333333',
  '18:00',
  '19:00',
  60,
  500,
  true
);


-- ------------------------------------------------------------
-- Fixture bookings.
--
-- updated_at is pinned to 2020 so we can tell, afterwards,
-- which rows the function wrote to. (now() is constant inside
-- a test transaction, so "updated_at = now()" is the signal.)
--
--  +1  pending,   expired 5 minutes ago   -> must expire
--  +2  pending,   expires exactly now()   -> must expire (<=)
--  +3  pending,   expires in 5 minutes    -> must stay pending
--  +4  confirmed, expires_at in the past  -> must stay confirmed
--  +5  completed                          -> untouched
--  +6  cancelled                          -> untouched
--  +7  expired,   expires_at in the past  -> untouched
-- ------------------------------------------------------------

insert into public.bookings (
  id,
  user_id,
  facility_id,
  slot_id,
  booking_date,
  start_time,
  end_time,
  amount,
  status,
  payment_status,
  expires_at,
  cancelled_at,
  updated_at
)
values
  (
    'aaaaaaaa-0000-0000-0000-000000000001',
    '11111111-1111-1111-1111-111111111111',
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
    current_date + 1, '18:00', '19:00', 500,
    'pending_payment', 'pending',
    now() - interval '5 minutes', null, '2020-01-01'
  ),
  (
    'aaaaaaaa-0000-0000-0000-000000000002',
    '11111111-1111-1111-1111-111111111111',
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
    current_date + 2, '18:00', '19:00', 500,
    'pending_payment', 'pending',
    now(), null, '2020-01-01'
  ),
  (
    'aaaaaaaa-0000-0000-0000-000000000003',
    '11111111-1111-1111-1111-111111111111',
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
    current_date + 3, '18:00', '19:00', 500,
    'pending_payment', 'pending',
    now() + interval '5 minutes', null, '2020-01-01'
  ),
  (
    'aaaaaaaa-0000-0000-0000-000000000004',
    '11111111-1111-1111-1111-111111111111',
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
    current_date + 4, '18:00', '19:00', 500,
    'confirmed', 'paid',
    now() - interval '5 minutes', null, '2020-01-01'
  ),
  (
    'aaaaaaaa-0000-0000-0000-000000000005',
    '11111111-1111-1111-1111-111111111111',
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
    current_date + 5, '18:00', '19:00', 500,
    'completed', 'paid',
    null, null, '2020-01-01'
  ),
  (
    'aaaaaaaa-0000-0000-0000-000000000006',
    '11111111-1111-1111-1111-111111111111',
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
    current_date + 6, '18:00', '19:00', 500,
    'cancelled', 'pending',
    null, '2020-01-01', '2020-01-01'
  ),
  (
    'aaaaaaaa-0000-0000-0000-000000000007',
    '11111111-1111-1111-1111-111111111111',
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
    current_date + 7, '18:00', '19:00', 500,
    'expired', 'pending',
    now() - interval '5 minutes', null, '2020-01-01'
  );


-- ============================================================
-- Function shape
-- ============================================================

select has_function(
  'public',
  'expire_pending_bookings',
  array[]::text[],
  'expire_pending_bookings() should exist'
);

select function_returns(
  'public',
  'expire_pending_bookings',
  array[]::text[],
  'integer',
  'expire_pending_bookings() should return an integer count'
);


-- ============================================================
-- Before expiry: the overdue pending booking (+1) is still an
-- active reservation, so the exclusion constraint must reject
-- an overlapping reservation for the same slot and date.
-- ============================================================

select throws_ok(
  $$
    insert into public.bookings (
      user_id, facility_id, slot_id, booking_date,
      start_time, end_time, amount, status, payment_status, expires_at
    )
    values (
      '11111111-1111-1111-1111-111111111111',
      '33333333-3333-3333-3333-333333333333',
      '44444444-4444-4444-4444-444444444444',
      current_date + 1, '18:30', '19:30', 500,
      'pending_payment', 'pending', now() + interval '10 minutes'
    )
  $$,
  '23P01',
  null,
  'an unexpired-by-status pending booking should block an overlapping reservation'
);


-- ============================================================
-- First run
-- ============================================================

select is(
  public.expire_pending_bookings(),
  2,
  'first run should return the number of bookings expired (2)'
);

select is(
  (select status::text from public.bookings
   where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'expired',
  'overdue pending booking should become expired'
);

select is(
  (select status::text from public.bookings
   where id = 'aaaaaaaa-0000-0000-0000-000000000002'),
  'expired',
  'pending booking expiring exactly now should become expired'
);

select ok(
  (select bool_and(updated_at = now()) from public.bookings
   where id in (
     'aaaaaaaa-0000-0000-0000-000000000001',
     'aaaaaaaa-0000-0000-0000-000000000002'
   )),
  'expired bookings should have updated_at refreshed'
);

select is(
  (select status::text from public.bookings
   where id = 'aaaaaaaa-0000-0000-0000-000000000003'),
  'pending_payment',
  'unexpired pending booking should remain pending_payment'
);

select is(
  (select status::text || '/' || payment_status::text
   from public.bookings
   where id = 'aaaaaaaa-0000-0000-0000-000000000004'),
  'confirmed/paid',
  'confirmed booking should remain confirmed even with a past expires_at'
);

select results_eq(
  $$
    select status::text
    from public.bookings
    where id in (
      'aaaaaaaa-0000-0000-0000-000000000005',
      'aaaaaaaa-0000-0000-0000-000000000006',
      'aaaaaaaa-0000-0000-0000-000000000007'
    )
    order by booking_date
  $$,
  $$ values ('completed'), ('cancelled'), ('expired') $$,
  'completed, cancelled and already-expired bookings keep their status'
);

select is(
  (select count(*)::integer from public.bookings
   where id in (
     'aaaaaaaa-0000-0000-0000-000000000003',
     'aaaaaaaa-0000-0000-0000-000000000004',
     'aaaaaaaa-0000-0000-0000-000000000005',
     'aaaaaaaa-0000-0000-0000-000000000006',
     'aaaaaaaa-0000-0000-0000-000000000007'
   )
   and updated_at = '2020-01-01'),
  5,
  'bookings that were not due should not be written to'
);


-- ============================================================
-- Repeated execution
-- ============================================================

create temp table before_second_run as
select id, ctid as tuple_id
from public.bookings;

select is(
  public.expire_pending_bookings(),
  0,
  'repeated run should expire nothing and return 0'
);

select is(
  (select count(*)::integer
   from public.bookings b
   join before_second_run s on s.id = b.id
   where b.ctid <> s.tuple_id),
  0,
  'repeated run should not rewrite any booking row'
);


-- ============================================================
-- The slot is released
-- ============================================================

select lives_ok(
  $$
    insert into public.bookings (
      user_id, facility_id, slot_id, booking_date,
      start_time, end_time, amount, status, payment_status, expires_at
    )
    values (
      '11111111-1111-1111-1111-111111111111',
      '33333333-3333-3333-3333-333333333333',
      '44444444-4444-4444-4444-444444444444',
      current_date + 1, '18:00', '19:00', 500,
      'pending_payment', 'pending', now() + interval '10 minutes'
    )
  $$,
  'after expiry, the same slot and date can be reserved again'
);


-- ============================================================
-- Privileges
-- ============================================================

select ok(
  not has_function_privilege(
    'anon', 'public.expire_pending_bookings()', 'execute'
  ),
  'anon should not have EXECUTE'
);

select ok(
  not has_function_privilege(
    'authenticated', 'public.expire_pending_bookings()', 'execute'
  ),
  'authenticated should not have EXECUTE'
);

select ok(
  (select p.proacl is not null
          and not exists (
            select 1
            from aclexplode(p.proacl) a
            where a.grantee = 0 -- PUBLIC
          )
   from pg_proc p
   where p.oid = 'public.expire_pending_bookings()'::regprocedure),
  'PUBLIC should not have EXECUTE'
);

select ok(
  has_function_privilege(
    'service_role', 'public.expire_pending_bookings()', 'execute'
  ),
  'service_role should be able to execute it'
);

set local role anon;

select throws_ok(
  'select public.expire_pending_bookings()',
  '42501',
  null,
  'anon calling expire_pending_bookings() should be denied'
);

set local role authenticated;

select throws_ok(
  'select public.expire_pending_bookings()',
  '42501',
  null,
  'authenticated calling expire_pending_bookings() should be denied'
);

reset role;


-- ============================================================
-- SECURITY DEFINER hardening
-- ============================================================

select ok(
  (select p.prosecdef
          and coalesce(p.proconfig, '{}') @> array['search_path=""']
   from pg_proc p
   where p.oid = 'public.expire_pending_bookings()'::regprocedure),
  'function should be SECURITY DEFINER with an empty search_path'
);


-- ============================================================
-- Scheduling
--
-- Only enforced where pg_cron can run. If the extension is
-- available and loaded for this database the job must exist;
-- otherwise the check is skipped rather than failed.
-- ============================================================

create function pg_temp.expiry_job_state()
returns text
language plpgsql
as $$
begin
  if to_regclass('cron.job') is null then
    if current_setting('cron.database_name', true)
         is not distinct from current_database() then
      return 'missing';
    end if;
    return 'unsupported';
  end if;

  if (
    select count(*)
    from cron.job
    where jobname = 'expire-pending-bookings'
      and schedule = '* * * * *'
      and command = 'select public.expire_pending_bookings()'
      and active
  ) = 1 then
    return 'scheduled';
  end if;

  return 'missing';
end;
$$;

select case pg_temp.expiry_job_state()
  when 'unsupported' then
    skip('pg_cron is not available in this database', 1)
  else
    is(
      pg_temp.expiry_job_state(),
      'scheduled',
      'expire-pending-bookings should be scheduled once per minute'
    )
end;


select * from finish();

rollback;
