begin;

select plan(35);


-- ============================================================
-- Facility-level booking overlap (bookings_no_facility_overlap)
-- and the facility-wide expiry sweep in create_booking()
--
-- Fixture (all ids are test-only and rolled back):
--
--   Users   f5000000-0000-0000-0000-00000000000N
--             01..04 customers, 09 owner of every facility
--
--   Facilities (f6000000-...-0000000000N)
--     01  A: raw constraint cases      slots 01 18-19, 02 19-20, 03 21-22
--     02  B: other facility            slot  04 18-19
--     03  C: documented time-edit      slots 11 18-19, 12 19-20
--     04  D: expiry sweep              slots 21 18-19, 22 19-20
--     05  E: waitlist acceptance       slots 31 18-19, 32 19-20
--
--   Operating hours exist for every weekday so nothing depends on
--   the day the suite runs.
--
-- Dates: D = current_date + 5, D2 = +6, D3 = +7.
--
-- A booking's start_time/end_time are SNAPSHOTS taken when it was
-- created, independent of the slot's current times. Raw inserts
-- below give a booking a snapshot that differs from its slot,
-- which is the state a time edit after booking produces.
-- ============================================================

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
select
  ('f5000000-0000-0000-0000-00000000000' || n)::uuid,
  'bfo-user' || n || '@example.com', '', now(), '{}'::jsonb
from unnest(array[1, 2, 3, 4, 9]) n;

insert into public.facilities (id, owner_id, name, sport, address, city, status, base_price)
select
  ('f6000000-0000-0000-0000-00000000000' || n)::uuid,
  'f5000000-0000-0000-0000-000000000009',
  'BFO Facility ' || n, 'Badminton', 'Test Address ' || n, 'Test City', 'active', 500
from generate_series(1, 5) n;

insert into public.facility_operating_hours (facility_id, day_of_week, opens_at, closes_at, is_closed)
select ('f6000000-0000-0000-0000-00000000000' || n)::uuid, d, '06:00', '22:00', false
from generate_series(1, 5) n cross join generate_series(0, 6) d;

insert into public.facility_slots (id, facility_id, start_time, end_time, duration_min, base_price)
values
  ('f7000000-0000-0000-0000-000000000001', 'f6000000-0000-0000-0000-000000000001', '18:00', '19:00', 60, 500),
  ('f7000000-0000-0000-0000-000000000002', 'f6000000-0000-0000-0000-000000000001', '19:00', '20:00', 60, 500),
  ('f7000000-0000-0000-0000-000000000003', 'f6000000-0000-0000-0000-000000000001', '21:00', '22:00', 60, 500),
  ('f7000000-0000-0000-0000-000000000004', 'f6000000-0000-0000-0000-000000000002', '18:00', '19:00', 60, 500),
  ('f7000000-0000-0000-0000-000000000011', 'f6000000-0000-0000-0000-000000000003', '18:00', '19:00', 60, 500),
  ('f7000000-0000-0000-0000-000000000012', 'f6000000-0000-0000-0000-000000000003', '19:00', '20:00', 60, 500),
  ('f7000000-0000-0000-0000-000000000021', 'f6000000-0000-0000-0000-000000000004', '18:00', '19:00', 60, 500),
  ('f7000000-0000-0000-0000-000000000022', 'f6000000-0000-0000-0000-000000000004', '19:00', '20:00', 60, 500),
  ('f7000000-0000-0000-0000-000000000031', 'f6000000-0000-0000-0000-000000000005', '18:00', '19:00', 60, 500),
  ('f7000000-0000-0000-0000-000000000032', 'f6000000-0000-0000-0000-000000000005', '19:00', '20:00', 60, 500);


-- ============================================================
-- A1. Constraint shape
-- ============================================================

select is(
  (select contype::text from pg_constraint
   where conrelid = 'public.bookings'::regclass
     and conname = 'bookings_no_facility_overlap'),
  'x',
  'bookings_no_facility_overlap is an exclusion constraint'
);

select ok(
  (select pg_get_constraintdef(oid) from pg_constraint
   where conrelid = 'public.bookings'::regclass
     and conname = 'bookings_no_facility_overlap')
  ~ 'facility_id WITH =.*tsrange.*WITH &&',
  'it keys on facility_id and the snapshot interval'
);

select ok(
  (select pg_get_constraintdef(oid) from pg_constraint
   where conrelid = 'public.bookings'::regclass
     and conname = 'bookings_no_facility_overlap') ~ 'pending_payment'
  and (select pg_get_constraintdef(oid) from pg_constraint
   where conrelid = 'public.bookings'::regclass
     and conname = 'bookings_no_facility_overlap') ~ 'confirmed'
  and (select pg_get_constraintdef(oid) from pg_constraint
   where conrelid = 'public.bookings'::regclass
     and conname = 'bookings_no_facility_overlap') ~ 'completed'
  and (select pg_get_constraintdef(oid) from pg_constraint
   where conrelid = 'public.bookings'::regclass
     and conname = 'bookings_no_facility_overlap') !~ 'expired|cancelled',
  'it covers pending_payment, confirmed and completed only'
);

select is(
  (select count(*)::integer from pg_constraint
   where conrelid = 'public.bookings'::regclass
     and conname = 'bookings_no_overlap'
     and contype = 'x'),
  1,
  'the existing slot-level bookings_no_overlap is still installed'
);


-- ============================================================
-- A2. Raw inserts (table owner; snapshots as given)
-- ============================================================

select lives_ok(
  $$ insert into public.bookings (id, user_id, facility_id, slot_id, booking_date, start_time, end_time, amount, status, payment_status)
     values ('f8000000-0000-0000-0000-000000000001', 'f5000000-0000-0000-0000-000000000001',
             'f6000000-0000-0000-0000-000000000001', 'f7000000-0000-0000-0000-000000000001',
             current_date + 5, '18:00', '19:00', 500, 'confirmed', 'paid') $$,
  'a confirmed booking is accepted'
);

select throws_ok(
  $$ insert into public.bookings (user_id, facility_id, slot_id, booking_date, start_time, end_time, amount, status, payment_status, expires_at)
     values ('f5000000-0000-0000-0000-000000000002',
             'f6000000-0000-0000-0000-000000000001', 'f7000000-0000-0000-0000-000000000002',
             current_date + 5, '18:30', '19:30', 500, 'pending_payment', 'pending', now() + interval '10 minutes') $$,
  '23P01',
  NULL,
  'a partially overlapping snapshot on a DIFFERENT slot of the same facility is rejected'
);

select throws_ok(
  $$ insert into public.bookings (user_id, facility_id, slot_id, booking_date, start_time, end_time, amount, status, payment_status)
     values ('f5000000-0000-0000-0000-000000000002',
             'f6000000-0000-0000-0000-000000000001', 'f7000000-0000-0000-0000-000000000002',
             current_date + 5, '17:00', '21:00', 500, 'confirmed', 'paid') $$,
  '23P01',
  NULL,
  'a snapshot that contains an existing booking is rejected'
);

select lives_ok(
  $$ insert into public.bookings (id, user_id, facility_id, slot_id, booking_date, start_time, end_time, amount, status, payment_status)
     values ('f8000000-0000-0000-0000-000000000002', 'f5000000-0000-0000-0000-000000000002',
             'f6000000-0000-0000-0000-000000000001', 'f7000000-0000-0000-0000-000000000002',
             current_date + 5, '19:00', '20:00', 500, 'confirmed', 'paid') $$,
  'an adjacent interval (19:00 starts where 18:00-19:00 ends) is accepted'
);

select lives_ok(
  $$ insert into public.bookings (user_id, facility_id, slot_id, booking_date, start_time, end_time, amount, status, payment_status)
     values ('f5000000-0000-0000-0000-000000000003',
             'f6000000-0000-0000-0000-000000000002', 'f7000000-0000-0000-0000-000000000004',
             current_date + 5, '18:00', '19:00', 500, 'confirmed', 'paid') $$,
  'the same interval at a different facility is accepted'
);

select lives_ok(
  $$ insert into public.bookings (user_id, facility_id, slot_id, booking_date, start_time, end_time, amount, status, payment_status)
     values ('f5000000-0000-0000-0000-000000000003',
             'f6000000-0000-0000-0000-000000000001', 'f7000000-0000-0000-0000-000000000001',
             current_date + 6, '18:00', '19:00', 500, 'confirmed', 'paid') $$,
  'the same interval on a different date is accepted'
);

-- expired and cancelled rows never block
select lives_ok(
  $$ insert into public.bookings (id, user_id, facility_id, slot_id, booking_date, start_time, end_time, amount, status, payment_status, expires_at)
     values ('f8000000-0000-0000-0000-000000000011', 'f5000000-0000-0000-0000-000000000003',
             'f6000000-0000-0000-0000-000000000001', 'f7000000-0000-0000-0000-000000000003',
             current_date + 6, '21:00', '22:00', 500, 'expired', 'pending', now() - interval '1 hour') $$,
  'an expired booking is accepted'
);

select lives_ok(
  $$ insert into public.bookings (user_id, facility_id, slot_id, booking_date, start_time, end_time, amount, status, payment_status, cancelled_at)
     values ('f5000000-0000-0000-0000-000000000003',
             'f6000000-0000-0000-0000-000000000001', 'f7000000-0000-0000-0000-000000000003',
             current_date + 6, '21:00', '22:00', 500, 'cancelled', 'pending', now()) $$,
  'a cancelled booking over the same interval is accepted'
);

select lives_ok(
  $$ insert into public.bookings (user_id, facility_id, slot_id, booking_date, start_time, end_time, amount, status, payment_status)
     values ('f5000000-0000-0000-0000-000000000004',
             'f6000000-0000-0000-0000-000000000001', 'f7000000-0000-0000-0000-000000000003',
             current_date + 6, '21:00', '22:00', 500, 'confirmed', 'paid') $$,
  'expired and cancelled rows do not block an active booking in the same interval'
);

select throws_ok(
  $$ update public.bookings
     set status = 'pending_payment', expires_at = now() + interval '10 minutes'
     where id = 'f8000000-0000-0000-0000-000000000011' $$,
  '23P01',
  NULL,
  'reactivating an expired row over an active booking is rejected (UPDATE path)'
);

-- completed bookings count
select lives_ok(
  $$ insert into public.bookings (user_id, facility_id, slot_id, booking_date, start_time, end_time, amount, status, payment_status)
     values ('f5000000-0000-0000-0000-000000000004',
             'f6000000-0000-0000-0000-000000000001', 'f7000000-0000-0000-0000-000000000003',
             current_date + 7, '20:00', '21:00', 500, 'completed', 'paid') $$,
  'a completed booking is accepted'
);

select throws_ok(
  $$ insert into public.bookings (user_id, facility_id, slot_id, booking_date, start_time, end_time, amount, status, payment_status)
     values ('f5000000-0000-0000-0000-000000000004',
             'f6000000-0000-0000-0000-000000000001', 'f7000000-0000-0000-0000-000000000002',
             current_date + 7, '20:30', '21:30', 500, 'confirmed', 'paid') $$,
  '23P01',
  NULL,
  'a completed booking blocks an overlapping one'
);


-- ============================================================
-- A3. The documented time-edit reproduction, through the real
-- owner UPDATE path and the real RPC.
--
-- Originally: c1 holds slot T1 (18-19); the owner edited T1 to
-- 17-18 and T2 to 18-20 (slot definitions do not overlap); c2 then
-- booked T2 for the same date: two active bookings overlapping
-- 18:00-19:00. The facility-level constraint made that last
-- booking fail; since the slot-time freeze the FIRST edit is
-- refused while c1's booking is live, so the sequence cannot even
-- start. (Snapshots that differ from their slot, which this
-- sequence used to create, are still built with raw inserts in
-- section A2 and B to keep the constraint itself covered.)
-- ============================================================

set local role authenticated;
set local request.jwt.claim.sub = 'f5000000-0000-0000-0000-000000000001';

select lives_ok(
  $$ select * from public.create_booking(
       'f6000000-0000-0000-0000-000000000003',
       'f7000000-0000-0000-0000-000000000011',
       current_date + 5) $$,
  'T1: customer 1 holds the 18:00-19:00 slot'
);

set local request.jwt.claim.sub = 'f5000000-0000-0000-0000-000000000009';

select throws_ok(
  $$ update public.facility_slots
     set start_time = '17:00', end_time = '18:00'
     where id = 'f7000000-0000-0000-0000-000000000011' $$,
  '23514',
  NULL,
  'T1: the owner can no longer move the time of a slot with a live booking'
);

select throws_ok(
  $$ update public.facility_slots
     set start_time = '18:00', end_time = '20:00', duration_min = 120
     where id = 'f7000000-0000-0000-0000-000000000012' $$,
  '23P01',
  NULL,
  'T1: the second slot cannot be stretched onto the still-held window'
);

set local request.jwt.claim.sub = 'f5000000-0000-0000-0000-000000000002';

select lives_ok(
  $$ select * from public.create_booking(
       'f6000000-0000-0000-0000-000000000003',
       'f7000000-0000-0000-0000-000000000012',
       current_date + 5) $$,
  'T1: customer 2 books the second slot at its own, adjacent time'
);

reset role;

select is(
  (select count(*)::integer
   from public.bookings x
   join public.bookings y
     on y.facility_id = x.facility_id
    and y.booking_date = x.booking_date
    and x.id < y.id
    and x.start_time < y.end_time
    and y.start_time < x.end_time
   where x.facility_id = 'f6000000-0000-0000-0000-000000000003'
     and x.status in ('pending_payment', 'confirmed', 'completed')
     and y.status in ('pending_payment', 'confirmed', 'completed')),
  0,
  'T1: no overlapping active bookings exist at the facility'
);


-- ============================================================
-- B. Facility-wide expiry sweep in create_booking()
--
-- Facility D (04), slots U1 18-19 and U2 19-20. Holds are given
-- snapshots that overlap U2 although they sit on slot U1.
--   b21  U1, D , 19:00-20:00, STALE  (expired by clock, unswept)
--   b22  U1, D2, 19:00-20:00, LIVE
--   b23  U1, D3, 19:00-20:00, STALE  (other date)
--   b24  facility B slot 04, D, 19:00-20:00, STALE (other facility)
-- ============================================================

insert into public.bookings (id, user_id, facility_id, slot_id, booking_date, start_time, end_time, amount, status, payment_status, expires_at)
values
  ('f8000000-0000-0000-0000-000000000021', 'f5000000-0000-0000-0000-000000000004',
   'f6000000-0000-0000-0000-000000000004', 'f7000000-0000-0000-0000-000000000021',
   current_date + 5, '19:00', '20:00', 500, 'pending_payment', 'pending', now() - interval '1 minute'),
  ('f8000000-0000-0000-0000-000000000022', 'f5000000-0000-0000-0000-000000000004',
   'f6000000-0000-0000-0000-000000000004', 'f7000000-0000-0000-0000-000000000021',
   current_date + 6, '19:00', '20:00', 500, 'pending_payment', 'pending', now() + interval '1 hour'),
  ('f8000000-0000-0000-0000-000000000023', 'f5000000-0000-0000-0000-000000000004',
   'f6000000-0000-0000-0000-000000000004', 'f7000000-0000-0000-0000-000000000021',
   current_date + 7, '19:00', '20:00', 500, 'pending_payment', 'pending', now() - interval '1 minute'),
  ('f8000000-0000-0000-0000-000000000024', 'f5000000-0000-0000-0000-000000000004',
   'f6000000-0000-0000-0000-000000000002', 'f7000000-0000-0000-0000-000000000004',
   current_date + 5, '19:00', '20:00', 500, 'pending_payment', 'pending', now() - interval '1 minute');

select is(
  (select status::text from public.bookings where id = 'f8000000-0000-0000-0000-000000000021'),
  'pending_payment',
  'B: precondition: the stale hold on another slot is still pending_payment'
);

set local role authenticated;
set local request.jwt.claim.sub = 'f5000000-0000-0000-0000-000000000003';

select lives_ok(
  $$ select * from public.create_booking(
       'f6000000-0000-0000-0000-000000000004',
       'f7000000-0000-0000-0000-000000000022',
       current_date + 5) $$,
  'B: a stale hold on ANOTHER slot of the facility does not block the new booking'
);

reset role;

select is(
  (select status::text from public.bookings where id = 'f8000000-0000-0000-0000-000000000021'),
  'expired',
  'B: the stale hold was expired by the sweep'
);

set local role authenticated;
set local request.jwt.claim.sub = 'f5000000-0000-0000-0000-000000000002';

select throws_ok(
  $$ select * from public.create_booking(
       'f6000000-0000-0000-0000-000000000004',
       'f7000000-0000-0000-0000-000000000022',
       current_date + 6) $$,
  '23P01',
  'The selected slot is no longer available',
  'B: a LIVE hold on another overlapping slot still blocks'
);

reset role;

select is(
  (select status::text from public.bookings where id = 'f8000000-0000-0000-0000-000000000022'),
  'pending_payment',
  'B: the live hold was not touched'
);

select is(
  (select status::text from public.bookings where id = 'f8000000-0000-0000-0000-000000000023'),
  'pending_payment',
  'B: a stale hold on another date is not swept'
);

select is(
  (select status::text from public.bookings where id = 'f8000000-0000-0000-0000-000000000024'),
  'pending_payment',
  'B: a stale hold at another facility is not swept'
);


-- ============================================================
-- D. Waitlist acceptance into a conflicting window
--
-- Facility E (05). U4 holds slot 32 (19-20) so U2 can queue.
-- The hold is cancelled and the scheduled job issues U2 the
-- offer. Meanwhile slot 31 gained a booking whose snapshot
-- 19:00-20:00 overlaps slot 32 (the state a time edit leaves).
-- Accepting must not create an overlapping booking.
-- ============================================================

insert into public.bookings (id, user_id, facility_id, slot_id, booking_date, start_time, end_time, amount, status, payment_status)
values ('f8000000-0000-0000-0000-000000000031', 'f5000000-0000-0000-0000-000000000004',
        'f6000000-0000-0000-0000-000000000005', 'f7000000-0000-0000-0000-000000000032',
        current_date + 5, '19:00', '20:00', 500, 'confirmed', 'paid');

set local role authenticated;
set local request.jwt.claim.sub = 'f5000000-0000-0000-0000-000000000002';

select lives_ok(
  $$ select * from public.join_waitlist(
       'f6000000-0000-0000-0000-000000000005',
       'f7000000-0000-0000-0000-000000000032',
       current_date + 5) $$,
  'D: customer 2 joins the waitlist of the taken slot'
);

reset role;

update public.bookings
set status = 'cancelled', cancelled_at = now()
where id = 'f8000000-0000-0000-0000-000000000031';

select lives_ok(
  $$ select public.process_waitlist() $$,
  'D: the scheduled job runs'
);

select is(
  (select status::text from public.waitlist_entries
   where user_id = 'f5000000-0000-0000-0000-000000000002'
     and slot_id = 'f7000000-0000-0000-0000-000000000032'),
  'offered',
  'D: the scheduled job issued the offer'
);

insert into public.bookings (id, user_id, facility_id, slot_id, booking_date, start_time, end_time, amount, status, payment_status)
values ('f8000000-0000-0000-0000-000000000032', 'f5000000-0000-0000-0000-000000000003',
        'f6000000-0000-0000-0000-000000000005', 'f7000000-0000-0000-0000-000000000031',
        current_date + 5, '19:00', '20:00', 500, 'confirmed', 'paid');

set local role authenticated;
set local request.jwt.claim.sub = 'f5000000-0000-0000-0000-000000000002';

select throws_ok(
  $$ select * from public.accept_waitlist_offer(
       (select id from public.waitlist_entries
        where user_id = 'f5000000-0000-0000-0000-000000000002'
          and slot_id = 'f7000000-0000-0000-0000-000000000032')) $$,
  '23P01',
  'The selected slot is no longer available',
  'D: accepting an offer into a conflicting window is refused'
);

reset role;

select is(
  (select count(*)::integer from public.bookings
   where facility_id = 'f6000000-0000-0000-0000-000000000005'
     and booking_date = current_date + 5
     and status in ('pending_payment', 'confirmed', 'completed')),
  1,
  'D: no overlapping booking was created'
);

select is(
  (select status::text from public.waitlist_entries
   where user_id = 'f5000000-0000-0000-0000-000000000002'
     and slot_id = 'f7000000-0000-0000-0000-000000000032'),
  'offered',
  'D: documented existing behaviour: the entry stays offered (not accepted, not cancelled)'
);

select ok(
  (select offer_expires_at > now() from public.waitlist_entries
   where user_id = 'f5000000-0000-0000-0000-000000000002'
     and slot_id = 'f7000000-0000-0000-0000-000000000032'),
  'D: ... and the offer stays live until its own expiry'
);

select * from finish();

rollback;
