begin;

select plan(66);


-- ============================================================
-- Fixture
--
-- Users (e1000000-0000-0000-0000-0000000000NN)
--   01 CAP    hold-cap subject                (role user)
--   02 BLOCK  owns the blocking bookings      (role user)
--   03 NONPEND has only non-counting bookings (role user)
--   04 OTHER  isolation check                 (role user)
--   05 WL     waitlist-cap subject            (role user)
--   06 OFFER  at the hold cap, holds an offer (role user)
--   07 OFFER2 at the hold cap, holds an offer (role user)
--   08 HORIZ  horizon checks for booking      (role user)
--   09 HORIZ2 horizon checks for waitlist     (role user)
--   10 REL    releases capacity by booking    (role user)
--   11 OWNER  owns the facility               (role owner)
--   12 ADMIN                                  (role admin)
--   13 OWNHOLD an owner who is also a customer(role owner)
--
-- Facility FAC (e2000000-...-01), active, hours 06:00-22:00 every
-- weekday, so nothing depends on the day the suite runs.
-- Slots (e3000000-0000-0000-0000-0000000000NN), one hour each:
--   01..06  H1..H6   06:00 .. 11:00   free slots for holds
--   07,08   O1,O2    12:00, 13:00     offer slots
--   09      SW       14:00            waitlisted slot (blocked by BLOCK)
--   10      HX       15:00            horizon slot
--   11      HW       16:00            horizon waitlist slot
-- Dates are relative to current_date; the table owner inserts the
-- fixtures (no client can), everything is rolled back.
-- ============================================================

insert into auth.users (
  id, email, encrypted_password, email_confirmed_at, raw_user_meta_data
)
select
  ('e1000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  'lim-user' || n || '@example.com',
  '',
  now(),
  jsonb_build_object('full_name', 'Limits User ' || n)
from generate_series(1, 13) n;

alter table public.profiles
disable trigger profiles_prevent_role_escalation;

update public.profiles
set role = 'owner'
where id in (
  'e1000000-0000-0000-0000-000000000011',
  'e1000000-0000-0000-0000-000000000013'
);

update public.profiles
set role = 'admin'
where id = 'e1000000-0000-0000-0000-000000000012';

alter table public.profiles
enable trigger profiles_prevent_role_escalation;

insert into public.facilities (
  id, owner_id, name, description, sport, address, city, status, base_price
)
values (
  'e2000000-0000-0000-0000-000000000001',
  'e1000000-0000-0000-0000-000000000011',
  'Limits Facility', 'Limits test facility', 'Football',
  'Test Address', 'Test City', 'active', 500
);

insert into public.facility_operating_hours (
  facility_id, day_of_week, opens_at, closes_at, is_closed
)
select 'e2000000-0000-0000-0000-000000000001', d, '06:00', '22:00', false
from generate_series(0, 6) d;

insert into public.facility_slots (
  id, facility_id, start_time, end_time, duration_min, base_price, is_active
)
select
  ('e3000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  'e2000000-0000-0000-0000-000000000001',
  time '06:00' + (case n when 7 then 6 when 8 then 7 when 9 then 8
                         when 10 then 9 when 11 then 10 else n - 1 end)
       * interval '1 hour',
  time '07:00' + (case n when 7 then 6 when 8 then 7 when 9 then 8
                         when 10 then 9 when 11 then 10 else n - 1 end)
       * interval '1 hour',
  60, 500, true
from generate_series(1, 11) n;

-- Helper for fixtures: a booking inserted by the table owner.
create function pg_temp.fx_booking(
  p_user text, p_slot int, p_day int, p_status text, p_expires interval
)
returns void
language sql
as $$
  insert into public.bookings (
    user_id, facility_id, slot_id, booking_date, start_time, end_time,
    amount, status, payment_status, expires_at
  )
  select
    ('e1000000-0000-0000-0000-' || lpad(p_user, 12, '0'))::uuid,
    s.facility_id, s.id, current_date + p_day, s.start_time, s.end_time,
    500, p_status::public.booking_status,
    case when p_status = 'pending_payment' then 'pending'
         else 'paid' end::public.payment_status,
    case when p_status = 'pending_payment' then now() + p_expires end
  from public.facility_slots s
  where s.id = ('e3000000-0000-0000-0000-' || lpad(p_slot::text, 12, '0'))::uuid;
$$;

-- Helper: switch the acting user (PostgREST does the same).
create function pg_temp.act_as(p_user text)
returns void
language plpgsql
as $$
begin
  reset role;
  perform set_config('request.jwt.claim.sub',
    'e1000000-0000-0000-0000-' || lpad(p_user, 12, '0'), true);
  set local role authenticated;
end;
$$;


-- ============================================================
-- Fixture state used by the cases below
-- ============================================================

-- SW (slot 09) is taken by BLOCK on current_date + 1 .. + 14 so
-- that it may be waitlisted on those dates.
select pg_temp.fx_booking('2', 9, d, 'confirmed', null)
from generate_series(1, 14) d;

-- O1 (slot 07) on day 2 and O2 (slot 08) on day 2 are the offer
-- slots for the two exemption users.
-- OFFER (06): three live holds on day 9, one live offer for O1/day 2.
select pg_temp.fx_booking('6', n, 9, 'pending_payment', interval '1 hour')
from generate_series(1, 3) n;

insert into public.waitlist_entries (
  user_id, facility_id, slot_id, booking_date,
  status, offered_at, offer_expires_at
)
values (
  'e1000000-0000-0000-0000-000000000006',
  'e2000000-0000-0000-0000-000000000001',
  'e3000000-0000-0000-0000-000000000007',
  current_date + 2,
  'offered', now() - interval '1 minute', now() + interval '10 minutes'
);

-- OFFER2 (07): three live holds on day 10, one live offer for O2/day 2.
select pg_temp.fx_booking('7', n, 10, 'pending_payment', interval '1 hour')
from generate_series(1, 3) n;

insert into public.waitlist_entries (
  user_id, facility_id, slot_id, booking_date,
  status, offered_at, offer_expires_at
)
values (
  'e1000000-0000-0000-0000-000000000007',
  'e2000000-0000-0000-0000-000000000001',
  'e3000000-0000-0000-0000-000000000008',
  current_date + 2,
  'offered', now() - interval '1 minute', now() + interval '10 minutes'
);

-- NONPEND (03): one booking of every non-counting kind, on day 4.
select pg_temp.fx_booking('3', 1, 4, 'confirmed', null);
select pg_temp.fx_booking('3', 2, 4, 'completed', null);
select pg_temp.fx_booking('3', 3, 4, 'cancelled', null);
select pg_temp.fx_booking('3', 4, 4, 'expired', null);

-- ============================================================
-- 1. Privileges, configuration, helper
-- ============================================================

select is(
  (select count(*)::integer
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('create_booking', 'join_waitlist',
                       'accept_waitlist_offer', 'get_slot_availability')
     and p.prosecdef
     and p.proconfig = array['search_path=""']),
  4,
  'the four client RPCs are SECURITY DEFINER with an empty search_path'
);

select ok(
  has_function_privilege('authenticated', 'public.create_booking(uuid,uuid,date)', 'execute')
  and has_function_privilege('authenticated', 'public.join_waitlist(uuid,uuid,date)', 'execute')
  and has_function_privilege('authenticated', 'public.accept_waitlist_offer(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.get_slot_availability(uuid,date)', 'execute'),
  'authenticated can still execute the four client RPCs'
);

select ok(
  not has_function_privilege('anon', 'public.create_booking(uuid,uuid,date)', 'execute')
  and not has_function_privilege('anon', 'public.join_waitlist(uuid,uuid,date)', 'execute')
  and not has_function_privilege('anon', 'public.accept_waitlist_offer(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.get_slot_availability(uuid,date)', 'execute'),
  'anon still cannot execute any of them'
);

select ok(
  not exists (
    select 1
    from pg_proc p, aclexplode(p.proacl) a
    where p.proname in ('create_booking', 'join_waitlist',
                        'accept_waitlist_offer', 'get_slot_availability',
                        'max_booking_date')
      and p.pronamespace = 'public'::regnamespace
      and a.grantee = 0
  ),
  'PUBLIC has no EXECUTE on any of them or on the horizon helper'
);

select ok(
  not has_function_privilege('authenticated', 'public.max_booking_date()', 'execute')
  and not has_function_privilege('anon', 'public.max_booking_date()', 'execute'),
  'the horizon helper is not callable by API roles'
);

select is(
  public.max_booking_date() - current_date,
  31,
  'the temporary compatibility horizon is current_date + 31'
);

-- ============================================================
-- 2. Hold cap (UB001): CAP user, day 3
-- ============================================================

select pg_temp.act_as('1');

select lives_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000001', current_date + 3) $$,
  'hold 1 of 3 is allowed'
);
select lives_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000002', current_date + 3) $$,
  'hold 2 of 3 is allowed'
);
select lives_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000003', current_date + 3) $$,
  'hold 3 of 3 is allowed'
);

select throws_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000004', current_date + 3) $$,
  'UB001',
  'You already have the maximum number of unpaid bookings held (3). Complete payment or wait for one to expire.',
  'the fourth live hold is refused with the stable code UB001'
);

select is(
  (select count(*)::integer from public.bookings
   where user_id = 'e1000000-0000-0000-0000-000000000001'),
  3,
  'the refused booking created no row'
);

-- Isolation: another user is unaffected by CAP's cap.
select pg_temp.act_as('4');

select lives_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000004', current_date + 3) $$,
  'limits are per user: another user can still hold a slot'
);

-- Expired, unswept hold does not count.
reset role;
update public.bookings
set expires_at = now() - interval '1 minute'
where user_id = 'e1000000-0000-0000-0000-000000000001'
  and slot_id = 'e3000000-0000-0000-0000-000000000001';

select is(
  (select status::text from public.bookings
   where user_id = 'e1000000-0000-0000-0000-000000000001'
     and slot_id = 'e3000000-0000-0000-0000-000000000001'),
  'pending_payment',
  'precondition: the expired hold is still marked pending_payment (unswept)'
);

select pg_temp.act_as('1');

select lives_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000005', current_date + 3) $$,
  'an expired but unswept hold does not use capacity'
);

select throws_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000006', current_date + 3) $$,
  'UB001',
  NULL,
  'and the cap is reached again with three LIVE holds'
);

-- Boundary: a hold expiring exactly now is not live (strictly greater).
reset role;
update public.bookings
set expires_at = now()
where user_id = 'e1000000-0000-0000-0000-000000000001'
  and slot_id = 'e3000000-0000-0000-0000-000000000002';

select pg_temp.act_as('1');

select lives_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000006', current_date + 3) $$,
  'a hold with expires_at = now() is not live (the comparison is strict)'
);

-- Non-counting kinds: NONPEND has four of them and may still hold 3.
select pg_temp.act_as('3');

select lives_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000001', current_date + 5) $$,
  'confirmed, completed, cancelled and expired bookings do not count (hold 1)'
);
select lives_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000002', current_date + 5) $$,
  'hold 2'
);
select lives_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000003', current_date + 5) $$,
  'hold 3'
);
select throws_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000004', current_date + 5) $$,
  'UB001',
  NULL,
  'and the fourth live hold is still refused'
);

-- A confirmed booking frees a hold slot.
reset role;
update public.bookings
set status = 'confirmed', payment_status = 'paid', expires_at = null
where user_id = 'e1000000-0000-0000-0000-000000000003'
  and slot_id = 'e3000000-0000-0000-0000-000000000001'
  and booking_date = current_date + 5;

select pg_temp.act_as('3');

select lives_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000004', current_date + 5) $$,
  'paying for a hold (status confirmed) releases capacity'
);

-- Owners and admins are capped too.
select pg_temp.act_as('13');

select lives_ok(
  $$ do $d$ begin
       perform public.create_booking('e2000000-0000-0000-0000-000000000001',
         'e3000000-0000-0000-0000-000000000001', current_date + 7);
       perform public.create_booking('e2000000-0000-0000-0000-000000000001',
         'e3000000-0000-0000-0000-000000000002', current_date + 7);
       perform public.create_booking('e2000000-0000-0000-0000-000000000001',
         'e3000000-0000-0000-0000-000000000003', current_date + 7);
     end $d$ $$,
  'an owner can hold three slots'
);
select throws_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000004', current_date + 7) $$,
  'UB001',
  NULL,
  'an owner is capped like everyone else'
);

select pg_temp.act_as('12');

select lives_ok(
  $$ do $d$ begin
       perform public.create_booking('e2000000-0000-0000-0000-000000000001',
         'e3000000-0000-0000-0000-000000000001', current_date + 8);
       perform public.create_booking('e2000000-0000-0000-0000-000000000001',
         'e3000000-0000-0000-0000-000000000002', current_date + 8);
       perform public.create_booking('e2000000-0000-0000-0000-000000000001',
         'e3000000-0000-0000-0000-000000000003', current_date + 8);
     end $d$ $$,
  'an admin can hold three slots'
);
select throws_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000004', current_date + 8) $$,
  'UB001',
  NULL,
  'an admin is capped like everyone else'
);

-- Error precedence. The cap is checked before the insert, so a
-- user AT the cap who tries a slot that is simply booked (found
-- only by the exclusion constraint) gets the cap error: nothing
-- could succeed for them anyway. A slot held for someone else's
-- waitlist offer is reported first (section 3).
select pg_temp.act_as('1');

select throws_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000009', current_date + 1) $$,
  'UB001',
  NULL,
  'at the cap, a booked slot is answered with the cap error (checked before the insert)'
);

-- Below the cap the same slot reports the exclusion violation.
select pg_temp.act_as('4');

select throws_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000009', current_date + 1) $$,
  '23P01',
  'The selected slot is no longer available',
  'below the cap, a booked slot still reports "no longer available" (23P01)'
);

-- ============================================================
-- 3. Live-offer exemption (OFFER: three holds + a live offer)
-- ============================================================

select pg_temp.act_as('6');

select throws_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000004', current_date + 9) $$,
  'UB001',
  NULL,
  'a user at the cap is refused a direct booking of an unrelated slot'
);

select lives_ok(
  $$ select * from public.accept_waitlist_offer(
       (select id from public.waitlist_entries
        where user_id = 'e1000000-0000-0000-0000-000000000006'
          and status = 'offered')) $$,
  'a user at the cap CAN accept the live offer held for them'
);

select is(
  (select count(*)::integer from public.bookings
   where user_id = 'e1000000-0000-0000-0000-000000000006'
     and status = 'pending_payment' and expires_at > now()),
  4,
  'the accepted hold is a normal live hold (4 now)'
);

select is(
  (select status::text from public.waitlist_entries
   where user_id = 'e1000000-0000-0000-0000-000000000006'),
  'accepted',
  'the offered entry is now accepted'
);

select throws_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000004', current_date + 9) $$,
  'UB001',
  NULL,
  'the exemption was for that offer only: other direct bookings stay refused'
);

-- Someone else's live offer does not exempt anybody, and is
-- reported before the cap. (Run before OFFER2's offer is used.)
select pg_temp.act_as('1');

select throws_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000008', current_date + 2) $$,
  'P0001',
  'The selected slot is currently held for a waitlist offer',
  'another user''s live offer is still respected (and reported before the cap)'
);

-- Direct booking of the offered slot is exempt as well.
select pg_temp.act_as('7');

select lives_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000008', current_date + 2) $$,
  'the offer holder may also book the offered slot directly while at the cap'
);

select is(
  (select status::text from public.waitlist_entries
   where user_id = 'e1000000-0000-0000-0000-000000000007'),
  'accepted',
  'and that closes their offer as accepted'
);

-- Negative cases: offers that must NOT exempt a user at the cap.
--
-- A dedicated user (14) holds three live unpaid slots on day 15
-- and owns three offered entries, all set up by the table owner.
-- Every attempt below is made while the user is at the cap, and a
-- refusal changes no state, so the three cases are independent.
-- The (slot, date) pairs are all different, which keeps the
-- one-offer-per-slot-and-date and one-entry-per-user indexes out
-- of the picture.
--
--   entry A  slot 07 / day 11  offered, window CLOSED a minute ago
--                              (status not yet swept)
--   entry B  slot 07 / day 12  offered, window open
--   entry C  slot 08 / day 14  offered, window open
reset role;

insert into auth.users (
  id, email, encrypted_password, email_confirmed_at, raw_user_meta_data
)
values (
  'e1000000-0000-0000-0000-000000000014',
  'lim-user14@example.com', '', now(), '{"full_name":"Limits User 14"}'
);

select pg_temp.fx_booking('14', n, 15, 'pending_payment', interval '1 hour')
from generate_series(1, 3) n;

insert into public.waitlist_entries (
  user_id, facility_id, slot_id, booking_date,
  status, offered_at, offer_expires_at
)
values
  ('e1000000-0000-0000-0000-000000000014',
   'e2000000-0000-0000-0000-000000000001',
   'e3000000-0000-0000-0000-000000000007', current_date + 11,
   'offered', now() - interval '30 minutes', now() - interval '1 minute'),
  ('e1000000-0000-0000-0000-000000000014',
   'e2000000-0000-0000-0000-000000000001',
   'e3000000-0000-0000-0000-000000000007', current_date + 12,
   'offered', now() - interval '1 minute', now() + interval '10 minutes'),
  ('e1000000-0000-0000-0000-000000000014',
   'e2000000-0000-0000-0000-000000000001',
   'e3000000-0000-0000-0000-000000000008', current_date + 14,
   'offered', now() - interval '1 minute', now() + interval '10 minutes');

select is(
  (select count(*)::integer from public.bookings
   where user_id = 'e1000000-0000-0000-0000-000000000014'
     and status = 'pending_payment' and expires_at > now()),
  3,
  'precondition: the user is at the live-hold limit before the negative cases'
);

select pg_temp.act_as('14');

select throws_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000007', current_date + 11) $$,
  'UB001',
  NULL,
  'an expired but unswept offer for the same slot and date does not exempt the user'
);

select throws_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000007', current_date + 13) $$,
  'UB001',
  NULL,
  'a live offer for the same slot on a different date does not exempt the user'
);

select throws_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000005', current_date + 14) $$,
  'UB001',
  NULL,
  'a live offer for the same date on a different slot does not exempt the user'
);

-- ============================================================
-- 4. Waitlist cap (UB002): WL user on SW, days 1..14
-- ============================================================

select pg_temp.act_as('5');

select lives_ok(
  $$ do $d$ begin
       for i in 1..10 loop
         perform public.join_waitlist('e2000000-0000-0000-0000-000000000001',
           'e3000000-0000-0000-0000-000000000009', current_date + i);
       end loop;
     end $d$ $$,
  'ten active waitlist entries are allowed'
);

select throws_ok(
  $$ select * from public.join_waitlist(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000009', current_date + 11) $$,
  'UB002',
  'You are already on the maximum number of waitlists (10). Leave one to join another.',
  'the eleventh active entry is refused with the stable code UB002'
);

select throws_ok(
  $$ select * from public.join_waitlist(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000009', current_date + 1) $$,
  '23505',
  'You are already on the waitlist for this slot and date',
  'a duplicate entry keeps its own error even at the cap'
);

-- Leaving frees capacity.
select lives_ok(
  $$ select public.leave_waitlist(
       (select id from public.waitlist_entries
        where user_id = 'e1000000-0000-0000-0000-000000000005'
          and booking_date = current_date + 10)) $$,
  'leave_waitlist works at the cap'
);

select lives_ok(
  $$ select * from public.join_waitlist(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000009', current_date + 11) $$,
  'leaving an entry releases capacity'
);

-- An expired, unswept offer does not count.
reset role;
update public.waitlist_entries
set status = 'offered',
    offered_at = now() - interval '30 minutes',
    offer_expires_at = now() - interval '1 minute'
where user_id = 'e1000000-0000-0000-0000-000000000005'
  and booking_date = current_date + 9;

select pg_temp.act_as('5');

select lives_ok(
  $$ select * from public.join_waitlist(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000009', current_date + 12) $$,
  'an expired offer (status not yet swept) does not use capacity'
);

-- A waiting entry whose date has passed does not count.
reset role;
update public.waitlist_entries
set booking_date = current_date - 1
where user_id = 'e1000000-0000-0000-0000-000000000005'
  and booking_date = current_date + 8;

select pg_temp.act_as('5');

select lives_ok(
  $$ select * from public.join_waitlist(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000009', current_date + 13) $$,
  'a waiting entry for a past date does not use capacity'
);

select throws_ok(
  $$ select * from public.join_waitlist(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000009', current_date + 14) $$,
  'UB002',
  NULL,
  'and the cap applies again at ten eligible entries'
);

-- A LIVE offer still counts.
reset role;
update public.waitlist_entries
set status = 'offered',
    offered_at = now() - interval '1 minute',
    offer_expires_at = now() + interval '10 minutes'
where user_id = 'e1000000-0000-0000-0000-000000000005'
  and booking_date = current_date + 7;

select pg_temp.act_as('5');

select throws_ok(
  $$ select * from public.join_waitlist(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000009', current_date + 14) $$,
  'UB002',
  NULL,
  'a live offered entry still counts toward the cap'
);

-- Isolation.
select pg_temp.act_as('4');

select lives_ok(
  $$ select * from public.join_waitlist(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000009', current_date + 1) $$,
  'the waitlist cap is per user'
);

-- Direct booking releases the user's own waiting entry: REL joins
-- SW/day 1... SW is taken by BLOCK, so use the offered-slot route:
-- cancel BLOCK's booking, REL (waiting) then books the slot directly.
select pg_temp.act_as('10');

select lives_ok(
  $$ select * from public.join_waitlist(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000009', current_date + 2) $$,
  'REL joins a waitlist'
);

reset role;
update public.bookings
set status = 'cancelled', cancelled_at = now()
where user_id = 'e1000000-0000-0000-0000-000000000002'
  and slot_id = 'e3000000-0000-0000-0000-000000000009'
  and booking_date = current_date + 2;

select pg_temp.act_as('10');

select lives_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000009', current_date + 2) $$,
  'REL books the freed slot directly'
);

select is(
  (select status::text from public.waitlist_entries
   where user_id = 'e1000000-0000-0000-0000-000000000010'
     and booking_date = current_date + 2),
  'cancelled',
  'a direct booking closes the user''s own waiting entry (capacity released)'
);

-- Accept is not subject to the waitlist cap: WL is at ten entries
-- (one of them a live offer for a slot that is actually free).
reset role;
update public.bookings
set status = 'cancelled', cancelled_at = now()
where user_id = 'e1000000-0000-0000-0000-000000000002'
  and slot_id = 'e3000000-0000-0000-0000-000000000009'
  and booking_date = current_date + 7;

select pg_temp.act_as('5');

select lives_ok(
  $$ select * from public.accept_waitlist_offer(
       (select id from public.waitlist_entries
        where user_id = 'e1000000-0000-0000-0000-000000000005'
          and booking_date = current_date + 7)) $$,
  'accepting an offer is not blocked by the waitlist cap'
);

select pg_temp.act_as('5');

select lives_ok(
  $$ select * from public.join_waitlist(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000009', current_date + 14) $$,
  'an accepted entry no longer counts, so a new join is possible'
);

-- ============================================================
-- 5. Horizon (current_date + 31) across the three RPCs
-- ============================================================

select pg_temp.act_as('8');

select lives_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000010', current_date + 31) $$,
  'create_booking accepts current_date + 31'
);

select throws_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000010', current_date + 32) $$,
  '22008',
  'Booking date is too far in the future',
  'create_booking refuses current_date + 32 with 22008'
);

select throws_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000010', date '5000-06-15') $$,
  '22008',
  NULL,
  'create_booking refuses a date thousands of years away'
);

select throws_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000010', current_date - 1) $$,
  '22007',
  'Booking date cannot be in the past',
  'the past-date rule and its code are unchanged'
);

reset role;
select pg_temp.fx_booking('2', 11, 31, 'confirmed', null);

select pg_temp.act_as('9');

select lives_ok(
  $$ select * from public.join_waitlist(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000011', current_date + 31) $$,
  'join_waitlist accepts current_date + 31'
);

select throws_ok(
  $$ select * from public.join_waitlist(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000011', current_date + 32) $$,
  '22008',
  'Booking date is too far in the future',
  'join_waitlist refuses current_date + 32 with 22008'
);

select lives_ok(
  $$ select * from public.get_slot_availability(
       'e2000000-0000-0000-0000-000000000001', current_date + 31) $$,
  'get_slot_availability accepts current_date + 31'
);

select throws_ok(
  $$ select * from public.get_slot_availability(
       'e2000000-0000-0000-0000-000000000001', current_date + 32) $$,
  '22008',
  'Booking date is too far in the future',
  'get_slot_availability refuses current_date + 32 with 22008'
);

select throws_ok(
  $$ select * from public.get_slot_availability(
       'e2000000-0000-0000-0000-000000000001', 'infinity') $$,
  '22007',
  'Booking date is not a valid date',
  'an infinite date keeps its own error in get_slot_availability'
);

-- ============================================================
-- 6. Unchanged behaviour: authentication and ownership
-- ============================================================

reset role;
set local role = 'authenticated';
select set_config('request.jwt.claim.sub', '', true);

select throws_ok(
  $$ select * from public.create_booking(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000001', current_date + 3) $$,
  '28000',
  'Authentication required',
  'create_booking still requires an authenticated user'
);

select throws_ok(
  $$ select * from public.join_waitlist(
       'e2000000-0000-0000-0000-000000000001',
       'e3000000-0000-0000-0000-000000000009', current_date + 3) $$,
  '28000',
  'Authentication required',
  'join_waitlist still requires an authenticated user'
);

select pg_temp.act_as('4');

select throws_ok(
  $$ select * from public.accept_waitlist_offer(gen_random_uuid()) $$,
  'P0002',
  'Waitlist entry not found',
  'accept_waitlist_offer still reports an unknown or foreign entry as not found'
);

select * from finish();

rollback;
