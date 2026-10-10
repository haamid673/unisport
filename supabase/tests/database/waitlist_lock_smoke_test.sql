begin;

select plan(4);


-- ============================================================
-- STRUCTURAL SMOKE TEST -- not a concurrency test
--
-- What it checks (single transaction, rolled back):
--
--   * create_booking() leaves a transaction-level advisory lock
--     for the slot/date key behind once it returns, and
--   * offer_next_waitlist_entry() leaves a lock with the SAME
--     key behind (observed through pg_locks).
--
-- What it does NOT prove:
--
--   * WHERE in the function the lock is taken. Position inside
--     create_booking() is invisible from outside, so moving the
--     lock after the offer check or the insert would still pass.
--   * That the lock blocks anyone: one session holds its own
--     advisory locks re-entrantly, so nothing here ever waits.
--
-- Why it stays: it runs in every environment, including ones
-- where waitlist_concurrency_test.sql refuses to run (it needs
-- the local stack and commits fixtures), and it catches the most
-- basic regression -- one side forgetting the lock or using a
-- different key -- at no cost.
--
-- The real behavioural coverage (the original race, the
-- reverse order, the accept/booking deadlock, rollback release,
-- and placement of the lock) lives in
-- waitlist_concurrency_test.sql, which drives separate sessions.
-- ============================================================


-- ============================================================
-- Fixture
-- ============================================================

insert into auth.users (
  id, email, encrypted_password, email_confirmed_at, raw_user_meta_data
)
values
  (
    'a1000000-0000-0000-0000-000000000001',
    'wl-lock-user@example.com',
    '',
    now(),
    '{"full_name":"Waitlist Lock User"}'
  ),
  (
    'a1000000-0000-0000-0000-000000000009',
    'wl-lock-owner@example.com',
    '',
    now(),
    '{"full_name":"Waitlist Lock Owner"}'
  );

alter table public.profiles
disable trigger profiles_prevent_role_escalation;

update public.profiles
set role = 'owner'
where id = 'a1000000-0000-0000-0000-000000000009';

alter table public.profiles
enable trigger profiles_prevent_role_escalation;

insert into public.facilities (
  id, owner_id, name, description, sport, address, city, status, base_price
)
values (
  'b1000000-0000-0000-0000-000000000001',
  'a1000000-0000-0000-0000-000000000009',
  'Waitlist Lock Facility',
  'Temporary database test facility',
  'Football',
  'Test Address',
  'Test City',
  'active',
  500
);

insert into public.facility_slots (
  id, facility_id, start_time, end_time, duration_min, base_price, is_active
)
values
  ('c1000000-0000-0000-0000-000000000001',
   'b1000000-0000-0000-0000-000000000001', '18:00', '19:00', 60, 500, true),
  ('c1000000-0000-0000-0000-000000000002',
   'b1000000-0000-0000-0000-000000000001', '20:00', '21:00', 60, 500, true);

insert into public.facility_operating_hours (
  facility_id, day_of_week, opens_at, closes_at, is_closed
)
select 'b1000000-0000-0000-0000-000000000001', d, '08:00', '22:00', false
from generate_series(0, 6) d;


-- Advisory locks currently held by this backend, by key.
create function pg_temp.held_lock_count(p_slot uuid, p_date date)
returns integer
language sql
as $$
  select count(*)::integer
  from pg_locks l
  where l.locktype = 'advisory'
    and l.pid = pg_backend_pid()
    and l.granted
    and ((l.classid::bigint << 32) | l.objid::bigint)
        = hashtextextended(p_slot::text || ':' || p_date::text, 0)
$$;


-- ============================================================
-- Nothing is locked before the calls (so the checks below
-- cannot pass vacuously)
-- ============================================================

select is(
  pg_temp.held_lock_count(
    'c1000000-0000-0000-0000-000000000001', current_date + 2
  )
  + pg_temp.held_lock_count(
    'c1000000-0000-0000-0000-000000000002', current_date + 2
  ),
  0,
  'no slot/date advisory lock is held before the calls'
);


-- ============================================================
-- create_booking() takes the slot/date lock
-- ============================================================

set local role authenticated;
set local request.jwt.claim.sub = 'a1000000-0000-0000-0000-000000000001';

do $$
begin
  perform * from public.create_booking(
    'b1000000-0000-0000-0000-000000000001',
    'c1000000-0000-0000-0000-000000000001',
    current_date + 2
  );
end;
$$;

reset role;

select is(
  pg_temp.held_lock_count(
    'c1000000-0000-0000-0000-000000000001', current_date + 2
  ),
  1,
  'create_booking() leaves the per-slot/date advisory lock held'
);


-- ============================================================
-- offer_next_waitlist_entry() uses the SAME key
-- ============================================================

select is(
  public.offer_next_waitlist_entry(
    'c1000000-0000-0000-0000-000000000002', current_date + 2
  ),
  null::uuid,
  'offer_next returns null when nobody is waiting'
);

select is(
  pg_temp.held_lock_count(
    'c1000000-0000-0000-0000-000000000002', current_date + 2
  ),
  1,
  'offer_next_waitlist_entry() should hold the same per-slot/date lock key'
);


select * from finish();

rollback;
