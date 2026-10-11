begin;

select plan(7);


-- ============================================================
-- Test fixture
-- ============================================================

-- Create Auth users.
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
    'booking-user@example.com',
    '',
    now(),
    '{"full_name":"Booking Test User"}'
  ),
  (
    '22222222-2222-2222-2222-222222222222',
    'booking-owner@example.com',
    '',
    now(),
    '{"full_name":"Booking Test Owner"}'
  );


-- The auth trigger automatically creates profiles.


-- Promote the test owner.
--
-- This is test-fixture setup, not an application operation.
-- Disable only the role-protection trigger temporarily.

alter table public.profiles
disable trigger profiles_prevent_role_escalation;

update public.profiles
set role = 'owner'
where id = '22222222-2222-2222-2222-222222222222';

alter table public.profiles
enable trigger profiles_prevent_role_escalation;


-- ============================================================
-- Facility
-- ============================================================

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
  'RPC Test Football Facility',
  'Temporary database test facility',
  'Football',
  'Test Address',
  'Test City',
  'active',
  500
);


-- ============================================================
-- Slot
-- ============================================================

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


-- ============================================================
-- Operating hours
--
-- The booking date used throughout is (current_date + 1).
-- Operating hours are created for that date's weekday.
-- ============================================================

insert into public.facility_operating_hours (
  facility_id,
  day_of_week,
  opens_at,
  closes_at,
  is_closed
)
values (
  '33333333-3333-3333-3333-333333333333',
  extract(dow from current_date + 1)::integer,
  '08:00',
  '22:00',
  false
);


-- ============================================================
-- Authenticate as test user
--
-- Supabase's auth.uid() reads the JWT sub claim.
-- ============================================================

set local request.jwt.claim.sub =
  '11111111-1111-1111-1111-111111111111';

set local role = 'authenticated';


-- ============================================================
-- Test 1
-- Valid booking should succeed.
-- ============================================================

select lives_ok(
  $$
    select *
    from public.create_booking(
      '33333333-3333-3333-3333-333333333333',
      '44444444-4444-4444-4444-444444444444',
      (current_date + 1)
    )
  $$,
  'valid booking should succeed'
);


-- ============================================================
-- Test 2
-- Amount must come from the database.
-- ============================================================

select is(
  (
    select amount
    from public.bookings
    where user_id = '11111111-1111-1111-1111-111111111111'
      and facility_id = '33333333-3333-3333-3333-333333333333'
      and booking_date = (current_date + 1)
  ),
  500::numeric,
  'booking amount should equal server-side slot price'
);


-- ============================================================
-- Test 3
-- New booking should be pending payment.
-- ============================================================

select is(
  (
    select status::text
    from public.bookings
    where user_id = '11111111-1111-1111-1111-111111111111'
      and booking_date = (current_date + 1)
  ),
  'pending_payment',
  'new booking should start in pending_payment state'
);


-- ============================================================
-- Test 4
-- Expiry should be approximately 10 minutes.
-- ============================================================

select ok(
  exists (
    select 1
    from public.bookings
    where user_id = '11111111-1111-1111-1111-111111111111'
      and booking_date = (current_date + 1)
      and expires_at between
        now() + interval '9 minutes'
        and now() + interval '11 minutes'
  ),
  'pending booking should expire approximately 10 minutes later'
);


-- ============================================================
-- Test 5
-- Same slot/date should be rejected.
-- ============================================================

select throws_ok(
  $$
    select *
    from public.create_booking(
      '33333333-3333-3333-3333-333333333333',
      '44444444-4444-4444-4444-444444444444',
      (current_date + 1)
    )
  $$,
  '23P01',
  NULL,
  'double booking should be rejected'
);


-- ============================================================
-- Test 6
-- Past date should be rejected.
-- ============================================================

select throws_ok(
  $$
    select *
    from public.create_booking(
      '33333333-3333-3333-3333-333333333333',
      '44444444-4444-4444-4444-444444444444',
      '2020-01-01'
    )
  $$,
  '22007',
  NULL,
  'past booking date should be rejected'
);


-- ============================================================
-- Test 7
-- Invalid slot should be rejected.
-- ============================================================

select throws_ok(
  $$
    select *
    from public.create_booking(
      '33333333-3333-3333-3333-333333333333',
      '55555555-5555-5555-5555-555555555555',
      (current_date + 1)
    )
  $$,
  'P0002',
  NULL,
  'unknown slot should be rejected'
);

select * from finish();

rollback;