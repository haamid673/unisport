begin;

select plan(60);


-- ============================================================
-- Fixture
--
-- Users:  U1 caller, U2 and U3 other customers,
--         OWNER (owns every facility), ADMIN
--           b2000000-0000-0000-0000-00000000000N
--
-- Facilities (b3000000-...-00000000000N)
--   F1 active, hours 06:00-22:00 every weekday except:
--        D+1  closed all day
--        D+2  no hours row at all
--   F2 pending      F3 suspended      F4 active, no slots
--
-- Slots of F1 (b4000000-...-0000000000NN), one scenario each,
-- all on date D unless noted:
--   01 07:00  nothing                           -> available
--   02 08:00  confirmed booking (U2)            -> booked
--   03 09:00  completed booking (U2)            -> booked
--   04 10:00  pending, hold valid (U2)          -> booked
--   05 11:00  pending, hold EXPIRED, unswept    -> available
--   06 12:00  live offer for U3                 -> offer_held (for U1)
--   07 13:00  offer EXPIRED, status unswept     -> available
--   08 14:00  slot inactive                     -> inactive
--   09 22:00  outside operating hours           -> closed
--   10 15:00  live offer for U1                 -> available (for U1)
--   11 16:00  pending, hold valid (U1)          -> booked
--   12 17:00  confirmed (U2) AND live offer (U3)-> booked
--   13 18:00  cancelled + expired bookings      -> available
--
-- Dates are relative to current_date; operating hours exist for
-- every weekday except the one deliberately left out, so nothing
-- depends on the day the suite runs.
-- ============================================================

insert into auth.users (
  id,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_user_meta_data
)
values
  ('b2000000-0000-0000-0000-000000000001', 'avail-u1@example.com', '', now(), '{"full_name":"Avail Caller Alice"}'),
  ('b2000000-0000-0000-0000-000000000002', 'avail-u2@example.com', '', now(), '{"full_name":"Avail Other Bob"}'),
  ('b2000000-0000-0000-0000-000000000003', 'avail-u3@example.com', '', now(), '{"full_name":"Avail Third Carol"}'),
  ('b2000000-0000-0000-0000-000000000009', 'avail-owner@example.com', '', now(), '{"full_name":"Avail Owner"}'),
  ('b2000000-0000-0000-0000-00000000000a', 'avail-admin@example.com', '', now(), '{"full_name":"Avail Admin"}');

alter table public.profiles
disable trigger profiles_prevent_role_escalation;

update public.profiles
set role = 'owner'
where id = 'b2000000-0000-0000-0000-000000000009';

update public.profiles
set role = 'admin'
where id = 'b2000000-0000-0000-0000-00000000000a';

alter table public.profiles
enable trigger profiles_prevent_role_escalation;


insert into public.facilities (
  id, owner_id, name, description, sport, address, city, status, base_price
)
values
  ('b3000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000009',
   'Avail Active', 'Availability test facility', 'Football', 'Test Address', 'Test City', 'active', 500),
  ('b3000000-0000-0000-0000-000000000002', 'b2000000-0000-0000-0000-000000000009',
   'Avail Pending', 'Availability test facility', 'Football', 'Test Address', 'Test City', 'pending', 500),
  ('b3000000-0000-0000-0000-000000000003', 'b2000000-0000-0000-0000-000000000009',
   'Avail Suspended', 'Availability test facility', 'Football', 'Test Address', 'Test City', 'suspended', 500),
  ('b3000000-0000-0000-0000-000000000004', 'b2000000-0000-0000-0000-000000000009',
   'Avail Empty', 'Availability test facility', 'Football', 'Test Address', 'Test City', 'active', 500);


-- Hours for F1: open every weekday except D+1 (closed) and D+2 (absent).
insert into public.facility_operating_hours (
  facility_id, day_of_week, opens_at, closes_at, is_closed
)
select
  'b3000000-0000-0000-0000-000000000001',
  d,
  case when d = extract(dow from current_date + 4)::integer
       then null else time '06:00' end,
  case when d = extract(dow from current_date + 4)::integer
       then null else time '22:00' end,
  d = extract(dow from current_date + 4)::integer
from generate_series(0, 6) d
where d <> extract(dow from current_date + 5)::integer;


insert into public.facility_slots (
  id, facility_id, start_time, end_time, duration_min, base_price, is_active
)
values
  ('b4000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000001', '07:00', '08:00', 60, 500, true),
  ('b4000000-0000-0000-0000-000000000002', 'b3000000-0000-0000-0000-000000000001', '08:00', '09:00', 60, 500, true),
  ('b4000000-0000-0000-0000-000000000003', 'b3000000-0000-0000-0000-000000000001', '09:00', '10:00', 60, 500, true),
  ('b4000000-0000-0000-0000-000000000004', 'b3000000-0000-0000-0000-000000000001', '10:00', '11:00', 60, 500, true),
  ('b4000000-0000-0000-0000-000000000005', 'b3000000-0000-0000-0000-000000000001', '11:00', '12:00', 60, 500, true),
  ('b4000000-0000-0000-0000-000000000006', 'b3000000-0000-0000-0000-000000000001', '12:00', '13:00', 60, 500, true),
  ('b4000000-0000-0000-0000-000000000007', 'b3000000-0000-0000-0000-000000000001', '13:00', '14:00', 60, 500, true),
  ('b4000000-0000-0000-0000-000000000008', 'b3000000-0000-0000-0000-000000000001', '14:00', '15:00', 60, 500, false),
  ('b4000000-0000-0000-0000-000000000009', 'b3000000-0000-0000-0000-000000000001', '22:00', '23:00', 60, 500, true),
  ('b4000000-0000-0000-0000-000000000010', 'b3000000-0000-0000-0000-000000000001', '15:00', '16:00', 60, 500, true),
  ('b4000000-0000-0000-0000-000000000011', 'b3000000-0000-0000-0000-000000000001', '16:00', '17:00', 60, 500, true),
  ('b4000000-0000-0000-0000-000000000012', 'b3000000-0000-0000-0000-000000000001', '17:00', '18:00', 60, 500, true),
  ('b4000000-0000-0000-0000-000000000013', 'b3000000-0000-0000-0000-000000000001', '18:00', '19:00', 60, 500, true),
  -- A slot on the pending facility, for the authorization tests.
  ('b4000000-0000-0000-0000-000000000020', 'b3000000-0000-0000-0000-000000000002', '07:00', '08:00', 60, 500, true);


-- Bookings, inserted by the table owner (no client can do this).
insert into public.bookings (
  id, user_id, facility_id, slot_id, booking_date,
  start_time, end_time, amount, status, payment_status, expires_at
)
values
  -- 02 confirmed
  ('b5000000-0000-0000-0000-000000000002', 'b2000000-0000-0000-0000-000000000002',
   'b3000000-0000-0000-0000-000000000001', 'b4000000-0000-0000-0000-000000000002',
   current_date + 3, '08:00', '09:00', 1234.50, 'confirmed', 'paid', null),
  -- 03 completed
  ('b5000000-0000-0000-0000-000000000003', 'b2000000-0000-0000-0000-000000000002',
   'b3000000-0000-0000-0000-000000000001', 'b4000000-0000-0000-0000-000000000003',
   current_date + 3, '09:00', '10:00', 1234.50, 'completed', 'paid', null),
  -- 04 pending, hold still valid
  ('b5000000-0000-0000-0000-000000000004', 'b2000000-0000-0000-0000-000000000002',
   'b3000000-0000-0000-0000-000000000001', 'b4000000-0000-0000-0000-000000000004',
   current_date + 3, '10:00', '11:00', 1234.50, 'pending_payment', 'pending', now() + interval '5 minutes'),
  -- 05 pending, hold expired a minute ago, still marked pending_payment
  ('b5000000-0000-0000-0000-000000000005', 'b2000000-0000-0000-0000-000000000002',
   'b3000000-0000-0000-0000-000000000001', 'b4000000-0000-0000-0000-000000000005',
   current_date + 3, '11:00', '12:00', 1234.50, 'pending_payment', 'pending', now() - interval '1 minute'),
  -- 11 pending for the caller
  ('b5000000-0000-0000-0000-000000000011', 'b2000000-0000-0000-0000-000000000001',
   'b3000000-0000-0000-0000-000000000001', 'b4000000-0000-0000-0000-000000000011',
   current_date + 3, '16:00', '17:00', 1234.50, 'pending_payment', 'pending', now() + interval '5 minutes'),
  -- 12 confirmed (and a live offer below)
  ('b5000000-0000-0000-0000-000000000012', 'b2000000-0000-0000-0000-000000000002',
   'b3000000-0000-0000-0000-000000000001', 'b4000000-0000-0000-0000-000000000012',
   current_date + 3, '17:00', '18:00', 1234.50, 'confirmed', 'paid', null),
  -- 13 cancelled and expired: neither occupies the slot
  ('b5000000-0000-0000-0000-000000000013', 'b2000000-0000-0000-0000-000000000002',
   'b3000000-0000-0000-0000-000000000001', 'b4000000-0000-0000-0000-000000000013',
   current_date + 3, '18:00', '19:00', 1234.50, 'cancelled', 'refunded', null),
  ('b5000000-0000-0000-0000-000000000014', 'b2000000-0000-0000-0000-000000000003',
   'b3000000-0000-0000-0000-000000000001', 'b4000000-0000-0000-0000-000000000013',
   current_date + 3, '18:00', '19:00', 1234.50, 'expired', 'pending', null);


-- Waitlist entries.
insert into public.waitlist_entries (
  user_id, facility_id, slot_id, booking_date,
  status, offered_at, offer_expires_at
)
values
  -- 06 live offer for U3
  ('b2000000-0000-0000-0000-000000000003', 'b3000000-0000-0000-0000-000000000001',
   'b4000000-0000-0000-0000-000000000006', current_date + 3,
   'offered', now() - interval '1 minute', now() + interval '10 minutes'),
  -- 07 offer lapsed a minute ago, status not yet swept
  ('b2000000-0000-0000-0000-000000000003', 'b3000000-0000-0000-0000-000000000001',
   'b4000000-0000-0000-0000-000000000007', current_date + 3,
   'offered', now() - interval '16 minutes', now() - interval '1 minute'),
  -- 10 live offer for the caller (U1)
  ('b2000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000001',
   'b4000000-0000-0000-0000-000000000010', current_date + 3,
   'offered', now() - interval '1 minute', now() + interval '10 minutes'),
  -- 12 live offer for U3 on a slot that is also booked
  ('b2000000-0000-0000-0000-000000000003', 'b3000000-0000-0000-0000-000000000001',
   'b4000000-0000-0000-0000-000000000012', current_date + 3,
   'offered', now() - interval '1 minute', now() + interval '10 minutes');


-- ============================================================
-- Authenticate as U1
-- ============================================================

set local request.jwt.claim.sub =
  'b2000000-0000-0000-0000-000000000001';

set local role = 'authenticated';


-- ============================================================
-- Status of each scenario (1-13)
-- ============================================================

select is(
  (select status from public.get_slot_availability(
     'b3000000-0000-0000-0000-000000000001', current_date + 3)
   where slot_id = 'b4000000-0000-0000-0000-000000000001'),
  'available',
  'a slot nobody has touched is available'
);

select is(
  (select status from public.get_slot_availability(
     'b3000000-0000-0000-0000-000000000001', current_date + 3)
   where slot_id = 'b4000000-0000-0000-0000-000000000002'),
  'booked',
  'a confirmed booking occupies the slot'
);

select is(
  (select status from public.get_slot_availability(
     'b3000000-0000-0000-0000-000000000001', current_date + 3)
   where slot_id = 'b4000000-0000-0000-0000-000000000003'),
  'booked',
  'a completed booking occupies the slot'
);

select is(
  (select status from public.get_slot_availability(
     'b3000000-0000-0000-0000-000000000001', current_date + 3)
   where slot_id = 'b4000000-0000-0000-0000-000000000004'),
  'booked',
  'a pending-payment booking with a valid hold occupies the slot'
);

select is(
  (select status from public.get_slot_availability(
     'b3000000-0000-0000-0000-000000000001', current_date + 3)
   where slot_id = 'b4000000-0000-0000-0000-000000000005'),
  'available',
  'an expired pending-payment hold no longer occupies the slot, even though its status is unswept'
);

select is(
  (select status from public.get_slot_availability(
     'b3000000-0000-0000-0000-000000000001', current_date + 3)
   where slot_id = 'b4000000-0000-0000-0000-000000000006'),
  'offer_held',
  'a live waitlist offer for another user holds the slot'
);

select is(
  (select status from public.get_slot_availability(
     'b3000000-0000-0000-0000-000000000001', current_date + 3)
   where slot_id = 'b4000000-0000-0000-0000-000000000007'),
  'available',
  'an expired offer no longer holds the slot, even though its status is unswept'
);

select is(
  (select status from public.get_slot_availability(
     'b3000000-0000-0000-0000-000000000001', current_date + 3)
   where slot_id = 'b4000000-0000-0000-0000-000000000008'),
  'inactive',
  'an inactive slot is reported inactive'
);

select is(
  (select status from public.get_slot_availability(
     'b3000000-0000-0000-0000-000000000001', current_date + 3)
   where slot_id = 'b4000000-0000-0000-0000-000000000009'),
  'closed',
  'a slot outside operating hours is closed'
);

select is(
  (select status from public.get_slot_availability(
     'b3000000-0000-0000-0000-000000000001', current_date + 3)
   where slot_id = 'b4000000-0000-0000-0000-000000000010'),
  'available',
  'the caller''s own live offer leaves the slot available to them'
);

select is(
  (select status from public.get_slot_availability(
     'b3000000-0000-0000-0000-000000000001', current_date + 3)
   where slot_id = 'b4000000-0000-0000-0000-000000000011'),
  'booked',
  'the caller''s own pending booking reads booked'
);

select is(
  (select status from public.get_slot_availability(
     'b3000000-0000-0000-0000-000000000001', current_date + 3)
   where slot_id = 'b4000000-0000-0000-0000-000000000012'),
  'booked',
  'a booked slot with a live offer reads booked, not offer_held'
);

select is(
  (select status from public.get_slot_availability(
     'b3000000-0000-0000-0000-000000000001', current_date + 3)
   where slot_id = 'b4000000-0000-0000-0000-000000000013'),
  'available',
  'cancelled and expired bookings do not occupy the slot'
);


-- ============================================================
-- Shape of the result
-- ============================================================

select is(
  (select count(*)::integer from public.get_slot_availability(
     'b3000000-0000-0000-0000-000000000001', current_date + 3)),
  13,
  'every slot of the facility is returned exactly once'
);

select is(
  (select count(distinct slot_id)::integer from public.get_slot_availability(
     'b3000000-0000-0000-0000-000000000001', current_date + 3)),
  13,
  'slot ids are not duplicated'
);

select is(
  (
    select array_agg(r.slot_id)
    from public.get_slot_availability(
      'b3000000-0000-0000-0000-000000000001', current_date + 3) r
  ),
  (
    select array_agg(fs.id order by fs.start_time, fs.id)
    from public.facility_slots fs
    where fs.facility_id = 'b3000000-0000-0000-0000-000000000001'
  ),
  'rows come back ordered by slot start time'
);

select is(
  (select count(*)::integer from public.get_slot_availability(
     'b3000000-0000-0000-0000-000000000001', current_date + 3)
   where slot_id = 'b4000000-0000-0000-0000-000000000020'),
  0,
  'slots of other facilities are not returned'
);

select is(
  (select count(*)::integer from public.get_slot_availability(
     'b3000000-0000-0000-0000-000000000004', current_date + 3)),
  0,
  'an active facility without slots returns no rows'
);


-- ============================================================
-- Operating hours: closed weekday, missing hours, today
-- ============================================================

select is(
  (
    select count(*)::integer
    from public.get_slot_availability(
      'b3000000-0000-0000-0000-000000000001', current_date + 4)
    where status not in ('closed', 'inactive')
  ),
  0,
  'on a weekday the facility is closed, no slot is available'
);

select is(
  (select status from public.get_slot_availability(
     'b3000000-0000-0000-0000-000000000001', current_date + 4)
   where slot_id = 'b4000000-0000-0000-0000-000000000001'),
  'closed',
  'a slot on a closed weekday reads closed'
);

select is(
  (select status from public.get_slot_availability(
     'b3000000-0000-0000-0000-000000000001', current_date + 4)
   where slot_id = 'b4000000-0000-0000-0000-000000000008'),
  'inactive',
  'an inactive slot reads inactive even on a closed day'
);

select is(
  (
    select count(*)::integer
    from public.get_slot_availability(
      'b3000000-0000-0000-0000-000000000001', current_date + 5)
    where status not in ('closed', 'inactive')
  ),
  0,
  'on a weekday with no operating hours configured, no slot is available'
);

select lives_ok(
  $$
    select * from public.get_slot_availability(
      'b3000000-0000-0000-0000-000000000001', current_date)
  $$,
  'today is an acceptable date'
);

select is(
  (select status from public.get_slot_availability(
     'b3000000-0000-0000-0000-000000000001', current_date + 6)
   where slot_id = 'b4000000-0000-0000-0000-000000000002'),
  'available',
  'bookings are per date: the same slot on another date is free'
);


-- ============================================================
-- Validation
-- ============================================================

select throws_ok(
  $$
    select * from public.get_slot_availability(
      'b3000000-0000-0000-0000-000000000001', current_date - 1)
  $$,
  '22007',
  'Booking date cannot be in the past',
  'a past date is rejected'
);

select throws_ok(
  $$
    select * from public.get_slot_availability(
      'b3000000-0000-0000-0000-000000000001', null)
  $$,
  '22023',
  'Booking date is required',
  'a null date is rejected'
);

select throws_ok(
  $$
    select * from public.get_slot_availability(
      'b3000000-0000-0000-0000-000000000001', 'infinity')
  $$,
  '22007',
  'Booking date is not a valid date',
  'an infinite date is rejected'
);

select throws_ok(
  $$
    select * from public.get_slot_availability(
      '00000000-0000-0000-0000-00000000dead', current_date + 3)
  $$,
  'P0002',
  'Facility not found',
  'an unknown facility is rejected'
);

select throws_ok(
  $$
    select * from public.get_slot_availability(null, current_date + 3)
  $$,
  'P0002',
  'Facility not found',
  'a null facility is rejected'
);


-- ============================================================
-- Authorization
-- ============================================================

select throws_ok(
  $$
    select * from public.get_slot_availability(
      'b3000000-0000-0000-0000-000000000002', current_date + 3)
  $$,
  'P0002',
  'Facility not found',
  'a customer cannot query a pending facility (indistinguishable from a missing one)'
);

select throws_ok(
  $$
    select * from public.get_slot_availability(
      'b3000000-0000-0000-0000-000000000003', current_date + 3)
  $$,
  'P0002',
  'Facility not found',
  'a customer cannot query a suspended facility'
);

-- Owner of the facilities.
set local request.jwt.claim.sub =
  'b2000000-0000-0000-0000-000000000009';

select throws_ok(
  $$
    select * from public.get_slot_availability(
      'b3000000-0000-0000-0000-000000000002', current_date + 3)
  $$,
  'P0001',
  'Facility is not currently available for booking',
  'the owner sees their pending facility but it is not bookable'
);

select lives_ok(
  $$
    select * from public.get_slot_availability(
      'b3000000-0000-0000-0000-000000000001', current_date + 3)
  $$,
  'the owner can read availability of their active facility'
);

-- Admin.
set local request.jwt.claim.sub =
  'b2000000-0000-0000-0000-00000000000a';

select throws_ok(
  $$
    select * from public.get_slot_availability(
      'b3000000-0000-0000-0000-000000000003', current_date + 3)
  $$,
  'P0001',
  'Facility is not currently available for booking',
  'an admin sees a suspended facility but it is not bookable'
);

-- Authenticated role, but no user in the token.
set local request.jwt.claim.sub = '';

select throws_ok(
  $$
    select * from public.get_slot_availability(
      'b3000000-0000-0000-0000-000000000001', current_date + 3)
  $$,
  '28000',
  'Authentication required',
  'a request without a user id is rejected'
);

-- Anonymous role.
set local role = 'anon';

select throws_ok(
  $$
    select * from public.get_slot_availability(
      'b3000000-0000-0000-0000-000000000001', current_date + 3)
  $$,
  '42501',
  NULL,
  'the anonymous role cannot execute the function'
);


-- ============================================================
-- Other customers' booking data does not leak
-- ============================================================

set local role = 'authenticated';
set local request.jwt.claim.sub =
  'b2000000-0000-0000-0000-000000000001';

-- The caller cannot read other users' bookings directly either,
-- which is the reason the function exists.
select is(
  (select count(*)::integer from public.bookings
   where user_id <> 'b2000000-0000-0000-0000-000000000001'),
  0,
  'precondition: RLS hides other customers'' bookings from the caller'
);

select is(
  (select proargnames::text
   from pg_proc
   where oid = 'public.get_slot_availability(uuid,date)'::regprocedure),
  '{p_facility_id,p_booking_date,slot_id,status}',
  'the function exposes exactly slot_id and status'
);

select is(
  (
    select count(*)::integer
    from public.get_slot_availability(
      'b3000000-0000-0000-0000-000000000001', current_date + 3) r
    where r::text ~* '(b2000000|b5000000|avail-u|Avail |1234|@example)'
  ),
  0,
  'no user id, booking id, name, email or amount appears in any row'
);

select is(
  (
    select count(distinct status)::integer
    from public.get_slot_availability(
      'b3000000-0000-0000-0000-000000000001', current_date + 3)
    where status not in
      ('available', 'booked', 'offer_held', 'inactive', 'closed')
  ),
  0,
  'every status belongs to the documented vocabulary'
);


-- Caller-relative view: U3 holds the offer on slot 06.
set local request.jwt.claim.sub =
  'b2000000-0000-0000-0000-000000000003';

select is(
  (select status from public.get_slot_availability(
     'b3000000-0000-0000-0000-000000000001', current_date + 3)
   where slot_id = 'b4000000-0000-0000-0000-000000000006'),
  'available',
  'the offer''s own holder sees their held slot as available'
);

select is(
  (select status from public.get_slot_availability(
     'b3000000-0000-0000-0000-000000000001', current_date + 3)
   where slot_id = 'b4000000-0000-0000-0000-000000000010'),
  'offer_held',
  'and another user''s offer reads offer_held for them'
);


-- ============================================================
-- Consistency with create_booking() (the authority)
--
-- Run as U1. Each availability answer is compared with what the
-- booking function actually does for the same slot and date.
-- ============================================================

set local request.jwt.claim.sub =
  'b2000000-0000-0000-0000-000000000001';

select throws_ok(
  $$
    select * from public.create_booking(
      'b3000000-0000-0000-0000-000000000001',
      'b4000000-0000-0000-0000-000000000002',
      current_date + 3)
  $$,
  '23P01',
  NULL,
  'booked: create_booking() refuses the slot'
);

select throws_ok(
  $$
    select * from public.create_booking(
      'b3000000-0000-0000-0000-000000000001',
      'b4000000-0000-0000-0000-000000000006',
      current_date + 3)
  $$,
  'P0001',
  'The selected slot is currently held for a waitlist offer',
  'offer_held: create_booking() refuses the slot'
);

select throws_ok(
  $$
    select * from public.create_booking(
      'b3000000-0000-0000-0000-000000000001',
      'b4000000-0000-0000-0000-000000000008',
      current_date + 3)
  $$,
  'P0001',
  'Selected slot is not active',
  'inactive: create_booking() refuses the slot'
);

select throws_ok(
  $$
    select * from public.create_booking(
      'b3000000-0000-0000-0000-000000000001',
      'b4000000-0000-0000-0000-000000000009',
      current_date + 3)
  $$,
  'P0001',
  'Selected slot falls outside facility operating hours',
  'closed: create_booking() refuses the slot'
);

select lives_ok(
  $$
    select * from public.create_booking(
      'b3000000-0000-0000-0000-000000000001',
      'b4000000-0000-0000-0000-000000000005',
      current_date + 3)
  $$,
  'available (expired hold, unswept): create_booking() accepts the slot'
);

select lives_ok(
  $$
    select * from public.create_booking(
      'b3000000-0000-0000-0000-000000000001',
      'b4000000-0000-0000-0000-000000000007',
      current_date + 3)
  $$,
  'available (expired offer, unswept): create_booking() accepts the slot'
);

-- Now that the booking exists, the other customers see it as booked.
set local request.jwt.claim.sub =
  'b2000000-0000-0000-0000-000000000002';

select is(
  (select status from public.get_slot_availability(
     'b3000000-0000-0000-0000-000000000001', current_date + 3)
   where slot_id = 'b4000000-0000-0000-0000-000000000005'),
  'booked',
  'after a successful booking, other users see the slot as booked'
);


-- ============================================================
-- The function is read-only, and the booking machinery is intact
-- ============================================================

reset role;

select is(
  (select status::text from public.bookings
   where id = 'b5000000-0000-0000-0000-000000000005'),
  'expired',
  'the expired hold was swept by create_booking(), as before'
);

select is(
  (select count(*)::integer from public.bookings
   where id in (
     'b5000000-0000-0000-0000-000000000002',
     'b5000000-0000-0000-0000-000000000004'
   ) and status::text in ('confirmed', 'pending_payment')),
  2,
  'fixture bookings are unchanged by availability reads'
);

select is(
  (select status::text from public.waitlist_entries
   where slot_id = 'b4000000-0000-0000-0000-000000000006'),
  'offered',
  'availability reads do not alter waitlist entries'
);

select has_function(
  'public', 'create_booking', array['uuid', 'uuid', 'date'],
  'create_booking() is untouched'
);

select ok(
  exists (
    select 1 from pg_constraint
    where conname = 'bookings_no_overlap'
      and conrelid = 'public.bookings'::regclass
  ),
  'the booking exclusion constraint is untouched'
);


-- ============================================================
-- Function attributes and privileges
-- ============================================================

select ok(
  (select prosecdef from pg_proc
   where oid = 'public.get_slot_availability(uuid,date)'::regprocedure),
  'the function is SECURITY DEFINER'
);

select is(
  (select proconfig::text from pg_proc
   where oid = 'public.get_slot_availability(uuid,date)'::regprocedure),
  '{"search_path=\"\""}',
  'the function pins an empty search_path'
);

select is(
  (select provolatile::text from pg_proc
   where oid = 'public.get_slot_availability(uuid,date)'::regprocedure),
  's',
  'the function is STABLE (it only reads)'
);

select ok(
  not has_function_privilege(
    'anon', 'public.get_slot_availability(uuid,date)', 'execute'),
  'anon cannot execute'
);

select ok(
  has_function_privilege(
    'authenticated', 'public.get_slot_availability(uuid,date)', 'execute'),
  'authenticated can execute'
);

select ok(
  not exists (
    select 1
    from pg_proc p, aclexplode(p.proacl) a
    where p.oid = 'public.get_slot_availability(uuid,date)'::regprocedure
      and a.grantee = 0
  ),
  'PUBLIC has no EXECUTE grant'
);

select * from finish();

rollback;
