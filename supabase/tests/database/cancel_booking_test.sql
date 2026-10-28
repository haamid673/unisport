begin;

select plan(48);

-- ============================================================
-- cancel_booking(): a customer cancels their own UNPAID hold
--
-- Users:    U1..U4 (c1000000-...-00000000000N), U9 owns the facility
-- Facility: F (c2...01) with slots
--             S   18:00-19:00  active  (the contested slot)
--             S2  20:00-21:00  active
-- Date:     D = current_date + 3 (operating hours exist for every
--           weekday, so nothing depends on the day the suite runs)
--
-- Everything is rolled back. No trigger is disabled.
-- ============================================================

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
select
  ('c1000000-0000-0000-0000-00000000000' || n)::uuid,
  'cancel-user' || n || '@example.com', '', now(),
  jsonb_build_object('full_name', 'Cancel User ' || n)
from generate_series(1, 4) n;

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
values ('c1000000-0000-0000-0000-000000000009', 'cancel-owner@example.com', '', now(), '{"full_name":"Cancel Owner"}');

insert into public.facilities (id, owner_id, name, description, sport, address, city, status, base_price)
values (
  'c2000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000009',
  'Cancel Test Facility', 'Temporary database test facility', 'Badminton',
  '1 Cancel Road', 'Testville', 'active', 500
);

insert into public.facility_slots (id, facility_id, start_time, end_time, duration_min, base_price, is_active)
values
  ('c3000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001', '18:00', '19:00', 60, 500, true),
  ('c3000000-0000-0000-0000-000000000002', 'c2000000-0000-0000-0000-000000000001', '20:00', '21:00', 60, 500, true);

insert into public.facility_operating_hours (facility_id, day_of_week, opens_at, closes_at, is_closed)
select 'c2000000-0000-0000-0000-000000000001', d, time '06:00', time '22:00', false
from generate_series(0, 6) d;

-- ---- helpers ------------------------------------------------

create function pg_temp.as_user(n integer) returns void
language sql as $$
  select set_config('request.jwt.claim.sub',
                    ('c1000000-0000-0000-0000-00000000000' || n)::text, true);
$$;

create function pg_temp.as_nobody() returns void
language sql as $$
  select set_config('request.jwt.claim.sub', '', true);
$$;

create function pg_temp.slot(n integer) returns uuid
language sql as $$
  select ('c3000000-0000-0000-0000-00000000000' || n)::uuid;
$$;

create function pg_temp.d() returns date
language sql as $$ select current_date + 3; $$;

-- Books slot n for the CURRENT user through the real function and
-- returns the booking id.
create function pg_temp.book(n integer) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  select booking_id into v_id
  from public.create_booking('c2000000-0000-0000-0000-000000000001', pg_temp.slot(n), pg_temp.d());
  return v_id;
end;
$$;

create function pg_temp.status_of(p_id uuid) returns text
language sql as $$ select status::text from public.bookings where id = p_id; $$;

-- ============================================================
-- 1. Catalog: shape and privileges
-- ============================================================

select ok(
  (select p.prosecdef
          and p.proconfig = array['search_path=""']
          and p.prorettype = 'public.booking_status'::regtype
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'cancel_booking'),
  'cancel_booking is SECURITY DEFINER, has an empty search_path and returns booking_status'
);

select ok(
  has_function_privilege('authenticated', 'public.cancel_booking(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.cancel_booking(uuid)', 'execute'),
  'authenticated and service_role can execute it'
);

select ok(
  not has_function_privilege('anon', 'public.cancel_booking(uuid)', 'execute')
  and not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) a
    where p.proname = 'cancel_booking' and p.pronamespace = 'public'::regnamespace and a.grantee = 0
  ),
  'anon and PUBLIC cannot execute it'
);

-- ============================================================
-- 2. Authentication and input
-- ============================================================

select pg_temp.as_nobody();
select throws_ok(
  $$ select public.cancel_booking('c4000000-0000-0000-0000-000000000001') $$,
  '28000', 'Authentication required',
  'an unauthenticated call is refused'
);

select pg_temp.as_user(1);
select throws_ok(
  $$ select public.cancel_booking(null) $$,
  '22023', 'Booking id is required',
  'a null booking id is refused'
);

select throws_ok(
  $$ select public.cancel_booking('c4000000-0000-0000-0000-0000000000ff') $$,
  'P0002', 'Booking not found',
  'an unknown booking id is "not found"'
);

-- ============================================================
-- 3. Cancelling a live hold
-- ============================================================

select pg_temp.as_user(1);
create temp table t as select pg_temp.book(1) as b1;

select is(pg_temp.status_of((select b1 from t)), 'pending_payment', 'fixture: U1 holds slot 1');

select is(
  public.cancel_booking((select b1 from t)),
  'cancelled'::public.booking_status,
  'cancelling a live hold returns cancelled'
);

select is(pg_temp.status_of((select b1 from t)), 'cancelled', 'the booking is stored as cancelled');

select ok(
  (select cancelled_at is not null and cancelled_at <= now() from public.bookings where id = (select b1 from t)),
  'cancelled_at is set'
);

select is(
  (select amount from public.bookings where id = (select b1 from t)),
  500::numeric,
  'the booking keeps its amount and identity (only status and cancelled_at change)'
);

-- the slot is free for everyone immediately
select pg_temp.as_user(2);
create temp table t2 as select pg_temp.book(1) as b2;
select is(pg_temp.status_of((select b2 from t2)), 'pending_payment',
  'another user can book the freed slot straight away');

-- ============================================================
-- 4. Ownership: another user's booking is "not found"
-- ============================================================

select pg_temp.as_user(3);
select throws_ok(
  format($$ select public.cancel_booking(%L) $$, (select b2 from t2)),
  'P0002', 'Booking not found',
  'a user cannot cancel someone else''s booking'
);
select is(pg_temp.status_of((select b2 from t2)), 'pending_payment',
  'and that booking is untouched');

select pg_temp.as_user(9);
select throws_ok(
  format($$ select public.cancel_booking(%L) $$, (select b2 from t2)),
  'P0002', 'Booking not found',
  'the facility owner cannot cancel a customer''s booking either'
);

-- ============================================================
-- 5. Idempotency
-- ============================================================

select pg_temp.as_user(1);
select ok(
  (select cancelled_at from public.bookings where id = (select b1 from t)) is not null,
  'fixture: b1 is cancelled'
);
create temp table snap as select cancelled_at as c, updated_at as u from public.bookings where id = (select b1 from t);
select pg_sleep(0.05);

select is(
  public.cancel_booking((select b1 from t)),
  'cancelled'::public.booking_status,
  'cancelling again returns cancelled (no error)'
);
select ok(
  (select b.cancelled_at = a.c and b.updated_at = a.u
   from public.bookings b, snap a where b.id = (select b1 from t)),
  'and nothing was written the second time'
);

-- ============================================================
-- 6. Expired holds
-- ============================================================

-- (a) already swept to expired
select pg_temp.as_user(4);
create temp table t4 as select pg_temp.book(2) as b4;
update public.bookings set expires_at = now() - interval '1 second' where id = (select b4 from t4);
select is(public.expire_pending_bookings(), 1, 'fixture: the sweep expires the lapsed hold');
select is(pg_temp.status_of((select b4 from t4)), 'expired', 'fixture: stored as expired');
select is(
  public.cancel_booking((select b4 from t4)),
  'expired'::public.booking_status,
  'cancelling a swept hold reports expired'
);
select is(pg_temp.status_of((select b4 from t4)), 'expired', 'and does not turn it into cancelled');

-- (b) lapsed by the clock, not yet swept
select pg_temp.as_user(4);
create temp table t4b as select pg_temp.book(2) as b4b;
update public.bookings set expires_at = now() - interval '1 second' where id = (select b4b from t4b);
select is(pg_temp.status_of((select b4b from t4b)), 'pending_payment', 'fixture: lapsed but still stored pending');
select is(
  public.cancel_booking((select b4b from t4b)),
  'expired'::public.booking_status,
  'a hold that has run out by the clock is reported expired'
);
select is(pg_temp.status_of((select b4b from t4b)), 'pending_payment',
  'and nothing is written (the sweep owns that transition)');
select ok(
  (select cancelled_at is null from public.bookings where id = (select b4b from t4b)),
  'cancelled_at stays null for it'
);

-- ============================================================
-- 7. Paid bookings cannot be cancelled here
-- ============================================================

select pg_temp.as_user(4);
create temp table t4c as select pg_temp.book(2) as b4c;
update public.bookings set status = 'confirmed' where id = (select b4c from t4c);
select throws_ok(
  format($$ select public.cancel_booking(%L) $$, (select b4c from t4c)),
  'UB005', 'Only an unpaid hold can be cancelled',
  'a confirmed booking is refused'
);
select is(pg_temp.status_of((select b4c from t4c)), 'confirmed', 'and stays confirmed');

update public.bookings set status = 'completed' where id = (select b4c from t4c);
select throws_ok(
  format($$ select public.cancel_booking(%L) $$, (select b4c from t4c)),
  'UB005', 'Only an unpaid hold can be cancelled',
  'a completed booking is refused'
);
-- free the slot again for the next fixture (not a cancellation)
update public.bookings set status = 'expired' where id = (select b4c from t4c);

-- ============================================================
-- 8. A payment in flight blocks cancellation
-- ============================================================

select pg_temp.as_user(4);
create temp table t4d as select pg_temp.book(2) as b4d;
insert into public.payment_attempts (booking_id, amount_paise, state)
select b4d, 50000, 'creating' from t4d;

select throws_ok(
  format($$ select public.cancel_booking(%L) $$, (select b4d from t4d)),
  'UB006', 'A payment may be in progress for this booking; it cannot be cancelled now',
  'a creating payment attempt blocks the cancel'
);
select is(pg_temp.status_of((select b4d from t4d)), 'pending_payment', 'the hold is untouched');

update public.payment_attempts
set state = 'open', provider_order_id = 'order_CANCELTEST0001'
where booking_id = (select b4d from t4d);
select throws_ok(
  format($$ select public.cancel_booking(%L) $$, (select b4d from t4d)),
  'UB006', 'A payment may be in progress for this booking; it cannot be cancelled now',
  'an open payment attempt blocks the cancel'
);

update public.payment_attempts
set state = 'closed', closed_at = now(), closed_reason = 'test'
where booking_id = (select b4d from t4d);
select is(
  public.cancel_booking((select b4d from t4d)),
  'cancelled'::public.booking_status,
  'once the attempt is closed the hold can be cancelled'
);

-- ============================================================
-- 9. Other holds are unaffected (setup for the checks below)
-- ============================================================

-- U2 already holds slot 1; add a hold on slot 2 as well
select pg_temp.as_user(2);
create temp table t2b as select pg_temp.book(2) as b2b;
select is(
  (select count(*)::integer from public.bookings where user_id = 'c1000000-0000-0000-0000-000000000002' and status = 'pending_payment' and expires_at > now()),
  2, 'fixture: U2 holds two live slots'
);

-- ============================================================
-- 10. Waitlist: the freed slot is offered at once
-- ============================================================

-- U3 waits for slot 1 (held by U2 from section 3)
select pg_temp.as_user(3);
select lives_ok(
  $$ select public.join_waitlist('c2000000-0000-0000-0000-000000000001', pg_temp.slot(1), pg_temp.d()) $$,
  'U3 joins the waitlist for the held slot'
);
select is(
  (select status::text from public.waitlist_entries where user_id = 'c1000000-0000-0000-0000-000000000003'),
  'waiting', 'fixture: U3 is waiting'
);

-- U2 cancels the hold on slot 1
select pg_temp.as_user(2);
select is(
  public.cancel_booking((select b2 from t2)),
  'cancelled'::public.booking_status,
  'U2 cancels the contested hold'
);

select is(
  (select status::text from public.waitlist_entries where user_id = 'c1000000-0000-0000-0000-000000000003'),
  'offered',
  'U3''s entry is offered immediately, not at the next sweep'
);
select ok(
  (select offered_at is not null
          and offer_expires_at > now() + interval '14 minutes'
          and offer_expires_at <= now() + interval '15 minutes'
   from public.waitlist_entries where user_id = 'c1000000-0000-0000-0000-000000000003'),
  'with the normal 15-minute offer window'
);

-- the slot is now held for U3's offer
select pg_temp.as_user(4);
select throws_ok(
  $$ select pg_temp.book(1) $$,
  'P0001', 'The selected slot is currently held for a waitlist offer',
  'another user cannot book the slot while U3 holds the offer'
);

-- U3 accepts; then cancels the booking that resulted
select pg_temp.as_user(3);
create temp table t3 as
  select booking_id as b3
  from public.accept_waitlist_offer((select id from public.waitlist_entries where user_id = 'c1000000-0000-0000-0000-000000000003'));
select is(
  (select status::text from public.waitlist_entries where user_id = 'c1000000-0000-0000-0000-000000000003'),
  'accepted', 'fixture: U3 accepted the offer'
);

-- U4 now waits, then U3 cancels
select pg_temp.as_user(4);
select lives_ok(
  $$ select public.join_waitlist('c2000000-0000-0000-0000-000000000001', pg_temp.slot(1), pg_temp.d()) $$,
  'U4 joins the waitlist behind U3''s booking'
);
select pg_temp.as_user(3);
select is(
  public.cancel_booking((select b3 from t3)),
  'cancelled'::public.booking_status,
  'U3 cancels the booking that came from the offer'
);
select is(
  (select status::text from public.waitlist_entries where user_id = 'c1000000-0000-0000-0000-000000000003'),
  'accepted',
  'U3''s accepted entry stays accepted (history is not rewritten)'
);
select is(
  (select status::text from public.waitlist_entries where user_id = 'c1000000-0000-0000-0000-000000000004'),
  'offered',
  'and the next waiting user, U4, is offered the slot'
);

-- ============================================================
-- 11. Side effects stay narrow
-- ============================================================

select is(
  (select count(*)::integer from public.bookings where status = 'cancelled' and user_id in
     ('c1000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000002','c1000000-0000-0000-0000-000000000003','c1000000-0000-0000-0000-000000000004')),
  4,
  'exactly the four bookings cancelled in this file are cancelled'
);
select is(
  (select status::text from public.bookings where id = (select b2b from t2b)),
  'pending_payment',
  'U2''s other live hold was not touched'
);

-- ============================================================
-- 12. The sweep and the cancel agree
-- ============================================================

select pg_temp.as_user(2);
select is(
  public.expire_pending_bookings(),
  0,
  'the sweep finds nothing to expire (a cancelled booking is not pending)'
);

select * from finish();
rollback;
