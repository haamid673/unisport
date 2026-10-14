begin;

select plan(42);


-- ============================================================
-- facility_slots_time_freeze: start_time/end_time cannot change
-- while the slot has a LIVE booking or waitlist entry
-- (prevent_live_slot_time_change())
--
-- Fixture (rolled back):
--   Users   f9000000-...-0N  01 facility owner, 02..05 customers,
--                            09 administrator (role admin)
--   Facility f9100000-...-01 (active, owned by user 01)
--   Slots   f9200000-...-NN  (references are on D = UTC date + 5 unless noted)
--     01 06-07  unreferenced
--     02 07-08  confirmed booking                      LIVE
--     03 08-09  pending_payment hold, unexpired        LIVE
--     04 09-10  pending_payment hold, expired by clock not live
--     05 10-11  waiting entry                          LIVE
--     06 11-12  offered entry, offer running           LIVE
--     07 12-13  offered entry, offer lapsed            not live
--     08 13-14  cancelled and expired bookings         not live
--     09 14-15  cancelled and expired entries          not live
--     10 00:00-00:05  confirmed booking TODAY, interval ended
--     11 00:10-00:15  waiting entry TODAY, interval ended
--     12 22:00-24:00  confirmed booking TODAY, not ended
--     14 16-17  price tests
--     15 03-04  COMPLETED booking, future dated          LIVE
--
-- Facilities 02..04 (time-zone section) use slots whose intervals are
-- computed from the current UTC time, so the test does not depend on
-- the time of day it runs:
--   02  confirmed booking ending ~2 hours from now          LIVE
--   03  waiting entry for a slot ending ~2 hours from now   LIVE
--   04  confirmed booking that ended ~2 hours ago           not live
--
-- Slots 10 and 11 only count as "ended" after 00:20 UTC; before that
-- their two assertions are skipped with a note (the interval
-- cannot have ended yet).
--
-- Dates and times of day below are taken from the naive UTC clock,
-- timezone('UTC', now()), which is the clock the trigger compares
-- with. current_date / localtime follow the session TimeZone and
-- would disagree with it on a database whose TimeZone is not UTC.
--
-- The trigger function must read other users' waitlist entries,
-- which row-level security hides from the owner, so it is SECURITY
-- DEFINER: slot 05's entry belongs to a customer, not the owner.
-- ============================================================

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
select
  ('f9000000-0000-0000-0000-00000000000' || n)::uuid,
  'ftf-user' || n || '@example.com', '', now(), '{}'::jsonb
from unnest(array[1, 2, 3, 4, 5, 9]) n;

-- Administrator: replace the auto-created profile row (data only).
delete from public.profiles where id = 'f9000000-0000-0000-0000-000000000009';
insert into public.profiles (id, full_name, role)
values ('f9000000-0000-0000-0000-000000000009', 'FTF Admin', 'admin');

insert into public.facilities (id, owner_id, name, sport, address, city, status, base_price)
values ('f9100000-0000-0000-0000-000000000001', 'f9000000-0000-0000-0000-000000000001',
        'FTF Facility', 'Badminton', 'Test Address FTF', 'Test City', 'active', 500);

insert into public.facility_operating_hours (facility_id, day_of_week, opens_at, closes_at, is_closed)
select 'f9100000-0000-0000-0000-000000000001', d, '06:00', '22:00', false
from generate_series(0, 6) d;

insert into public.facility_slots (id, facility_id, start_time, end_time, duration_min, base_price)
values
  ('f9200000-0000-0000-0000-000000000001', 'f9100000-0000-0000-0000-000000000001', '06:00', '07:00', 60, 500),
  ('f9200000-0000-0000-0000-000000000002', 'f9100000-0000-0000-0000-000000000001', '07:00', '08:00', 60, 500),
  ('f9200000-0000-0000-0000-000000000003', 'f9100000-0000-0000-0000-000000000001', '08:00', '09:00', 60, 500),
  ('f9200000-0000-0000-0000-000000000004', 'f9100000-0000-0000-0000-000000000001', '09:00', '10:00', 60, 500),
  ('f9200000-0000-0000-0000-000000000005', 'f9100000-0000-0000-0000-000000000001', '10:00', '11:00', 60, 500),
  ('f9200000-0000-0000-0000-000000000006', 'f9100000-0000-0000-0000-000000000001', '11:00', '12:00', 60, 500),
  ('f9200000-0000-0000-0000-000000000007', 'f9100000-0000-0000-0000-000000000001', '12:00', '13:00', 60, 500),
  ('f9200000-0000-0000-0000-000000000008', 'f9100000-0000-0000-0000-000000000001', '13:00', '14:00', 60, 500),
  ('f9200000-0000-0000-0000-000000000009', 'f9100000-0000-0000-0000-000000000001', '14:00', '15:00', 60, 500),
  ('f9200000-0000-0000-0000-000000000010', 'f9100000-0000-0000-0000-000000000001', '00:00', '00:05', 5, 500),
  ('f9200000-0000-0000-0000-000000000011', 'f9100000-0000-0000-0000-000000000001', '00:10', '00:15', 5, 500),
  ('f9200000-0000-0000-0000-000000000012', 'f9100000-0000-0000-0000-000000000001', '22:00', '24:00', 120, 500),
  ('f9200000-0000-0000-0000-000000000014', 'f9100000-0000-0000-0000-000000000001', '16:00', '17:00', 60, 500),
  ('f9200000-0000-0000-0000-000000000015', 'f9100000-0000-0000-0000-000000000001', '03:00', '04:00', 60, 500);

-- Bookings (snapshots as given, raw inserts)
insert into public.bookings (id, user_id, facility_id, slot_id, booking_date, start_time, end_time, amount, status, payment_status, expires_at, cancelled_at)
values
  ('f9300000-0000-0000-0000-000000000002', 'f9000000-0000-0000-0000-000000000002', 'f9100000-0000-0000-0000-000000000001', 'f9200000-0000-0000-0000-000000000002',
   timezone('UTC', now())::date + 5, '07:00', '08:00', 500, 'confirmed', 'paid', null, null),
  ('f9300000-0000-0000-0000-000000000003', 'f9000000-0000-0000-0000-000000000002', 'f9100000-0000-0000-0000-000000000001', 'f9200000-0000-0000-0000-000000000003',
   timezone('UTC', now())::date + 5, '08:00', '09:00', 500, 'pending_payment', 'pending', now() + interval '1 hour', null),
  ('f9300000-0000-0000-0000-000000000004', 'f9000000-0000-0000-0000-000000000002', 'f9100000-0000-0000-0000-000000000001', 'f9200000-0000-0000-0000-000000000004',
   timezone('UTC', now())::date + 5, '09:00', '10:00', 500, 'pending_payment', 'pending', now() - interval '1 minute', null),
  ('f9300000-0000-0000-0000-000000000008', 'f9000000-0000-0000-0000-000000000002', 'f9100000-0000-0000-0000-000000000001', 'f9200000-0000-0000-0000-000000000008',
   timezone('UTC', now())::date + 5, '13:00', '14:00', 500, 'cancelled', 'pending', null, now()),
  ('f9300000-0000-0000-0000-000000000018', 'f9000000-0000-0000-0000-000000000002', 'f9100000-0000-0000-0000-000000000001', 'f9200000-0000-0000-0000-000000000008',
   timezone('UTC', now())::date + 5, '13:00', '14:00', 500, 'expired', 'pending', now() - interval '1 hour', null),
  ('f9300000-0000-0000-0000-000000000010', 'f9000000-0000-0000-0000-000000000002', 'f9100000-0000-0000-0000-000000000001', 'f9200000-0000-0000-0000-000000000010',
   timezone('UTC', now())::date, '00:00', '00:05', 500, 'confirmed', 'paid', null, null),
  ('f9300000-0000-0000-0000-000000000012', 'f9000000-0000-0000-0000-000000000002', 'f9100000-0000-0000-0000-000000000001', 'f9200000-0000-0000-0000-000000000012',
   timezone('UTC', now())::date, '23:00', '24:00', 500, 'confirmed', 'paid', null, null),
  ('f9300000-0000-0000-0000-000000000015', 'f9000000-0000-0000-0000-000000000002', 'f9100000-0000-0000-0000-000000000001', 'f9200000-0000-0000-0000-000000000015',
   timezone('UTC', now())::date + 5, '03:00', '04:00', 500, 'completed', 'paid', null, null);

-- Waitlist entries (waiting: no offer fields; offered: both fields)
insert into public.waitlist_entries (id, user_id, facility_id, slot_id, booking_date, status, offered_at, offer_expires_at)
values
  ('f9400000-0000-0000-0000-000000000005', 'f9000000-0000-0000-0000-000000000003', 'f9100000-0000-0000-0000-000000000001', 'f9200000-0000-0000-0000-000000000005',
   timezone('UTC', now())::date + 5, 'waiting', null, null),
  ('f9400000-0000-0000-0000-000000000006', 'f9000000-0000-0000-0000-000000000003', 'f9100000-0000-0000-0000-000000000001', 'f9200000-0000-0000-0000-000000000006',
   timezone('UTC', now())::date + 5, 'offered', now(), now() + interval '15 minutes'),
  ('f9400000-0000-0000-0000-000000000007', 'f9000000-0000-0000-0000-000000000003', 'f9100000-0000-0000-0000-000000000001', 'f9200000-0000-0000-0000-000000000007',
   timezone('UTC', now())::date + 5, 'offered', now() - interval '30 minutes', now() - interval '15 minutes'),
  ('f9400000-0000-0000-0000-000000000009', 'f9000000-0000-0000-0000-000000000003', 'f9100000-0000-0000-0000-000000000001', 'f9200000-0000-0000-0000-000000000009',
   timezone('UTC', now())::date + 5, 'cancelled', null, null),
  ('f9400000-0000-0000-0000-000000000019', 'f9000000-0000-0000-0000-000000000004', 'f9100000-0000-0000-0000-000000000001', 'f9200000-0000-0000-0000-000000000009',
   timezone('UTC', now())::date + 5, 'expired', null, null),
  ('f9400000-0000-0000-0000-000000000011', 'f9000000-0000-0000-0000-000000000003', 'f9100000-0000-0000-0000-000000000001', 'f9200000-0000-0000-0000-000000000011',
   timezone('UTC', now())::date, 'waiting', null, null);


-- ============================================================
-- Trigger and function shape
-- ============================================================

select ok(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.facility_slots'::regclass
      and tgname = 'facility_slots_time_freeze'
      and tgenabled = 'O'
      and not tgisinternal
      and tgfoid = 'public.prevent_live_slot_time_change()'::regprocedure
      and (tgtype & 2) = 2 and (tgtype & 16) = 16 and (tgtype & 1) = 1
  ),
  'the trigger exists, is enabled, and is a BEFORE UPDATE row-level trigger'
);

select ok(
  (select pg_get_triggerdef(oid) ~ 'UPDATE OF start_time, end_time'
      and pg_get_triggerdef(oid) ~ 'WHEN'
   from pg_trigger
   where tgname = 'facility_slots_time_freeze'),
  'it is limited to start_time/end_time and has a WHEN clause'
);

select ok(
  (select p.prosecdef
      and array_to_string(p.proconfig, ',') = 'search_path=""'
   from pg_proc p
   where p.oid = 'public.prevent_live_slot_time_change()'::regprocedure),
  'the function is SECURITY DEFINER (it must see every user''s entries) with an empty search_path'
);

select ok(
  not has_function_privilege('anon', 'public.prevent_live_slot_time_change()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.prevent_live_slot_time_change()', 'EXECUTE')
  and (select coalesce(proacl::text, '') !~ '(^\{|,)=X'
       from pg_proc
       where oid = 'public.prevent_live_slot_time_change()'::regprocedure),
  'clients and PUBLIC cannot execute the trigger function directly'
);

select ok(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.facility_slots'::regclass
      and tgname = 'facility_slots_facility_id_immutable'
      and tgenabled = 'O'
  ),
  'the facility_id immutability trigger is still installed and enabled'
);


-- ============================================================
-- Owner (authenticated; RLS applies)
-- ============================================================

set local role authenticated;
set local request.jwt.claim.sub = 'f9000000-0000-0000-0000-000000000001';

select throws_ok(
  $$ update public.facility_slots set start_time = '05:00', end_time = '05:30'
     where id = 'f9200000-0000-0000-0000-000000000002' $$,
  '23514',
  'facility_slots start_time/end_time cannot be changed while the slot has live bookings or waitlist entries',
  'LIVE confirmed booking in the future: time edit rejected'
);

-- Runs a statement and returns the hint of the error it raises.
create function pg_temp.hint_of(p_sql text)
returns text
language plpgsql
as $$
declare
  v_hint text;
begin
  execute p_sql;
  return '(no error)';
exception
  when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    return coalesce(v_hint, '(no hint)');
end;
$$;

select is(
  pg_temp.hint_of($$ update public.facility_slots set start_time = '05:00', end_time = '05:30'
                    where id = 'f9200000-0000-0000-0000-000000000002' $$),
  'Wait until the live bookings and waitlist entries for this slot have ended or expired, then change its times.',
  'the hint describes the valid path: wait until the live references have ended or expired'
);

select doesnt_match(
  pg_temp.hint_of($$ update public.facility_slots set start_time = '05:00', end_time = '05:30'
                    where id = 'f9200000-0000-0000-0000-000000000002' $$),
  'deactivat',
  'the hint no longer suggests deactivating the slot and creating a replacement'
);

select throws_ok(
  $$ update public.facility_slots set start_time = '02:00', end_time = '03:00'
     where id = 'f9200000-0000-0000-0000-000000000015' $$,
  '23514',
  'facility_slots start_time/end_time cannot be changed while the slot has live bookings or waitlist entries',
  'LIVE completed booking with a future interval: time edit rejected'
);

select throws_ok(
  $$ update public.facility_slots set start_time = '05:00', end_time = '05:30'
     where id = 'f9200000-0000-0000-0000-000000000003' $$,
  '23514',
  NULL,
  'unexpired pending_payment hold: time edit rejected'
);

select throws_ok(
  $$ update public.facility_slots set start_time = '05:00', end_time = '05:30'
     where id = 'f9200000-0000-0000-0000-000000000005' $$,
  '23514',
  NULL,
  'waiting entry of ANOTHER user (hidden from the owner by RLS): time edit rejected'
);

select throws_ok(
  $$ update public.facility_slots set start_time = '05:00', end_time = '05:30'
     where id = 'f9200000-0000-0000-0000-000000000006' $$,
  '23514',
  NULL,
  'offered entry with a running offer: time edit rejected'
);

select throws_ok(
  $$ update public.facility_slots set end_time = '23:00', duration_min = 60
     where id = 'f9200000-0000-0000-0000-000000000012' $$,
  '23514',
  NULL,
  'a booking today whose interval has not ended still freezes the slot (changing only end_time)'
);

select lives_ok(
  $$ update public.facility_slots set start_time = '18:00', end_time = '18:30'
     where id = 'f9200000-0000-0000-0000-000000000004' $$,
  'expired-by-clock pending hold is not live: time edit allowed'
);

select lives_ok(
  $$ update public.facility_slots set start_time = '18:30', end_time = '19:00'
     where id = 'f9200000-0000-0000-0000-000000000007' $$,
  'lapsed offer is not live: time edit allowed'
);

select lives_ok(
  $$ update public.facility_slots set start_time = '19:00', end_time = '19:30'
     where id = 'f9200000-0000-0000-0000-000000000008' $$,
  'cancelled and expired bookings are historical: time edit allowed'
);

select lives_ok(
  $$ update public.facility_slots set start_time = '19:30', end_time = '20:00'
     where id = 'f9200000-0000-0000-0000-000000000009' $$,
  'cancelled and expired entries are terminal: time edit allowed'
);

select lives_ok(
  $$ update public.facility_slots set start_time = '20:00', end_time = '20:30'
     where id = 'f9200000-0000-0000-0000-000000000001' $$,
  'unreferenced slot: time edit allowed'
);

select case
  when timezone('UTC', now())::time > time '00:20' then
    lives_ok(
      $$ update public.facility_slots set start_time = '20:30', end_time = '21:00'
         where id = 'f9200000-0000-0000-0000-000000000010' $$,
      'a booking today whose interval has ENDED does not freeze the slot'
    )
  else
    skip('interval 00:00-00:05 cannot have ended before 00:20 (UTC)', 1)
end;

select case
  when timezone('UTC', now())::time > time '00:20' then
    lives_ok(
      $$ update public.facility_slots set start_time = '21:00', end_time = '21:30'
         where id = 'f9200000-0000-0000-0000-000000000011' $$,
      'a waiting entry today whose slot interval has ENDED does not freeze the slot'
    )
  else
    skip('interval 00:10-00:15 cannot have ended before 00:20 (UTC)', 1)
end;


-- ============================================================
-- Allowed edits while references are live
-- ============================================================

select lives_ok(
  $$ update public.facility_slots set start_time = start_time, end_time = end_time
     where id = 'f9200000-0000-0000-0000-000000000002' $$,
  'a no-op assignment of the same times is allowed'
);

select lives_ok(
  $$ update public.facility_slots set base_price = 777, duration_min = 60
     where id = 'f9200000-0000-0000-0000-000000000002' $$,
  'price (and duration) edits are allowed with a live booking'
);

select is(
  (select amount::text from public.bookings where id = 'f9300000-0000-0000-0000-000000000002'),
  '500.00',
  'the existing booking keeps its amount after the price edit'
);

select lives_ok(
  $$ update public.facility_slots set is_active = false
     where id = 'f9200000-0000-0000-0000-000000000002' $$,
  'deactivation is allowed with live bookings'
);

select lives_ok(
  $$ update public.facility_slots set is_active = true
     where id = 'f9200000-0000-0000-0000-000000000002' $$,
  'reactivation is allowed'
);

select throws_ok(
  $$ update public.facility_slots set facility_id = 'f9100000-0000-0000-0000-000000000001', start_time = '05:00', end_time = '05:30'
     where id = 'f9200000-0000-0000-0000-000000000002' $$,
  '23514',
  NULL,
  'a no-op facility_id bundled with a frozen time change is still rejected'
);


-- ============================================================
-- Administrator and the other privileged roles are bound too
-- ============================================================

set local request.jwt.claim.sub = 'f9000000-0000-0000-0000-000000000009';

select throws_ok(
  $$ update public.facility_slots set start_time = '05:00', end_time = '05:30'
     where id = 'f9200000-0000-0000-0000-000000000003' $$,
  '23514',
  NULL,
  'admin: time edit rejected as well (no exemption)'
);

reset role;
set local role service_role;

select throws_ok(
  $$ update public.facility_slots set start_time = '05:00', end_time = '05:30'
     where id = 'f9200000-0000-0000-0000-000000000003' $$,
  '23514',
  NULL,
  'service_role: time edit rejected'
);

reset role;

select throws_ok(
  $$ update public.facility_slots set start_time = '05:00', end_time = '05:30'
     where id = 'f9200000-0000-0000-0000-000000000003' $$,
  '23514',
  NULL,
  'postgres (table owner): time edit rejected'
);


-- ============================================================
-- Edits become possible once every reference is historical
-- ============================================================

update public.bookings set status = 'cancelled', cancelled_at = now()
where id = 'f9300000-0000-0000-0000-000000000002';

update public.waitlist_entries set status = 'cancelled'
where id = 'f9400000-0000-0000-0000-000000000005';

update public.waitlist_entries set status = 'expired'
where id = 'f9400000-0000-0000-0000-000000000006';

update public.bookings set status = 'expired', expires_at = now() - interval '1 minute'
where id = 'f9300000-0000-0000-0000-000000000003';

set local role authenticated;
set local request.jwt.claim.sub = 'f9000000-0000-0000-0000-000000000001';

select lives_ok(
  $$ update public.facility_slots set start_time = '05:00', end_time = '05:30'
     where id = 'f9200000-0000-0000-0000-000000000002' $$,
  'confirmed booking cancelled: time edit now allowed'
);

select lives_ok(
  $$ update public.facility_slots set start_time = '05:30', end_time = '05:45'
     where id = 'f9200000-0000-0000-0000-000000000005' $$,
  'waiting entry cancelled: time edit now allowed'
);

select lives_ok(
  $$ update public.facility_slots set start_time = '04:00', end_time = '04:30'
     where id = 'f9200000-0000-0000-0000-000000000006' $$,
  'offered entry expired: time edit now allowed'
);

select lives_ok(
  $$ update public.facility_slots set start_time = '04:30', end_time = '04:45'
     where id = 'f9200000-0000-0000-0000-000000000003' $$,
  'pending hold expired: time edit now allowed'
);

reset role;


-- ============================================================
-- The "interval has ended" test does not follow the session TimeZone
--
-- PostgREST lets a client set the time zone per request
-- (Prefer: timezone=...). The freeze compares with the naive UTC
-- clock, timezone('UTC', now()), so neither direction can be
-- exploited:
--   UTC+14 (Pacific/Kiritimati): a live interval must not look ended;
--   UTC-12 (Etc/GMT+12):         an ended interval must not look live.
--
-- Intervals are computed from the current UTC time (about two hours
-- ahead / behind) so the assertions hold at any time of day. A
-- slot's interval that would cross midnight is placed on the
-- previous day ending at 24:00.
-- ============================================================

do $$
declare
  v_ahead timestamp := date_trunc('minute', timezone('UTC', now())) + interval '2 hours';
  v_behind timestamp := date_trunc('minute', timezone('UTC', now())) - interval '2 hours';
  v_date date;
  v_start time;
  v_end time;
begin
  insert into public.facilities (id, owner_id, name, sport, address, city, status, base_price)
  select ('f9100000-0000-0000-0000-00000000000' || n)::uuid,
         'f9000000-0000-0000-0000-000000000001',
         'FTF TZ Facility ' || n, 'Badminton', 'Test Address FTF', 'Test City', 'active', 500
  from unnest(array[2, 3, 4]) n;

  -- live interval, ends about two hours from now
  if v_ahead::time >= time '00:30' then
    v_date := v_ahead::date; v_start := time '00:00'; v_end := v_ahead::time;
  else
    v_date := v_ahead::date - 1; v_start := time '23:00'; v_end := time '24:00';
  end if;

  insert into public.facility_slots (id, facility_id, start_time, end_time, duration_min, base_price)
  values
    ('f9200000-0000-0000-0000-000000000102', 'f9100000-0000-0000-0000-000000000002',
     v_start, v_end, 30, 500),
    ('f9200000-0000-0000-0000-000000000103', 'f9100000-0000-0000-0000-000000000003',
     v_start, v_end, 30, 500);

  insert into public.bookings (id, user_id, facility_id, slot_id, booking_date, start_time, end_time, amount, status, payment_status, expires_at)
  values
    ('f9300000-0000-0000-0000-000000000102', 'f9000000-0000-0000-0000-000000000002',
     'f9100000-0000-0000-0000-000000000002', 'f9200000-0000-0000-0000-000000000102',
     v_date, v_start, v_end, 500, 'confirmed', 'paid', null);

  insert into public.waitlist_entries (id, user_id, facility_id, slot_id, booking_date, status)
  values
    ('f9400000-0000-0000-0000-000000000103', 'f9000000-0000-0000-0000-000000000003',
     'f9100000-0000-0000-0000-000000000003', 'f9200000-0000-0000-0000-000000000103',
     v_date, 'waiting');

  -- ended interval, ended about two hours ago
  if v_behind::time >= time '00:30' then
    v_date := v_behind::date; v_start := time '00:00'; v_end := v_behind::time;
  else
    v_date := v_behind::date - 1; v_start := time '23:00'; v_end := time '24:00';
  end if;

  insert into public.facility_slots (id, facility_id, start_time, end_time, duration_min, base_price)
  values
    ('f9200000-0000-0000-0000-000000000104', 'f9100000-0000-0000-0000-000000000004',
     v_start, v_end, 30, 500);

  insert into public.bookings (id, user_id, facility_id, slot_id, booking_date, start_time, end_time, amount, status, payment_status, expires_at)
  values
    ('f9300000-0000-0000-0000-000000000104', 'f9000000-0000-0000-0000-000000000002',
     'f9100000-0000-0000-0000-000000000004', 'f9200000-0000-0000-0000-000000000104',
     v_date, v_start, v_end, 500, 'confirmed', 'paid', null);
end;
$$;

set local role authenticated;
set local request.jwt.claim.sub = 'f9000000-0000-0000-0000-000000000001';

-- UTC+14: the session clock is a day ahead of the database's naive UTC
set local timezone = 'Pacific/Kiritimati';

select ok(
  localtimestamp - timezone('UTC', now()) = interval '14 hours',
  'tz: the session time zone really is UTC+14 (localtimestamp is 14 hours ahead)'
);

select throws_ok(
  $$ update public.facility_slots set start_time = '01:00', end_time = '01:30'
     where id = 'f9200000-0000-0000-0000-000000000102' $$,
  '23514',
  'facility_slots start_time/end_time cannot be changed while the slot has live bookings or waitlist entries',
  'tz UTC+14: a live booking (ends in ~2 hours) still freezes the slot'
);

select throws_ok(
  $$ update public.facility_slots set start_time = '01:00', end_time = '01:30'
     where id = 'f9200000-0000-0000-0000-000000000103' $$,
  '23514',
  'facility_slots start_time/end_time cannot be changed while the slot has live bookings or waitlist entries',
  'tz UTC+14: a live waiting entry (slot ends in ~2 hours) still freezes the slot'
);

-- UTC-12: the session clock is half a day behind
set local timezone = 'Etc/GMT+12';

select ok(
  timezone('UTC', now()) - localtimestamp = interval '12 hours',
  'tz: the session time zone really is UTC-12 (localtimestamp is 12 hours behind)'
);

select lives_ok(
  $$ update public.facility_slots set start_time = '01:00', end_time = '01:30'
     where id = 'f9200000-0000-0000-0000-000000000104' $$,
  'tz UTC-12: a booking that ended ~2 hours ago does not freeze the slot'
);

reset timezone;
reset role;


-- ============================================================
-- Price: existing bookings keep their amount, new ones use the
-- current slot price (create_booking reads the slot FOR SHARE)
-- ============================================================

set local role authenticated;
set local request.jwt.claim.sub = 'f9000000-0000-0000-0000-000000000004';

select lives_ok(
  $$ select * from public.create_booking(
       'f9100000-0000-0000-0000-000000000001',
       'f9200000-0000-0000-0000-000000000014',
       timezone('UTC', now())::date + 6) $$,
  'price: customer 4 books at the current price'
);

set local request.jwt.claim.sub = 'f9000000-0000-0000-0000-000000000001';

select lives_ok(
  $$ update public.facility_slots set base_price = 650
     where id = 'f9200000-0000-0000-0000-000000000014' $$,
  'price: the owner raises the slot price'
);

set local request.jwt.claim.sub = 'f9000000-0000-0000-0000-000000000005';

select lives_ok(
  $$ select * from public.create_booking(
       'f9100000-0000-0000-0000-000000000001',
       'f9200000-0000-0000-0000-000000000014',
       timezone('UTC', now())::date + 7) $$,
  'price: customer 5 books after the change'
);

reset role;

select is(
  (select string_agg(amount::text, ',' order by booking_date)
   from public.bookings
   where slot_id = 'f9200000-0000-0000-0000-000000000014'),
  '500.00,650.00',
  'price: the earlier booking keeps 500.00 and the new one uses 650.00'
);

select * from finish();

rollback;
