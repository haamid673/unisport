begin;

select plan(5);


-- ============================================================
-- Regression: bookings must not carry a time-dependent CHECK
--
-- bookings_date_valid (booking_date >= current_date) made every
-- UPDATE of a booking fail once its date had passed, including
-- completing it or expiring it. The "not in the past" rule for
-- new bookings lives in create_booking().
-- ============================================================


-- ============================================================
-- Test fixture
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
    'date-user@example.com',
    '',
    now(),
    '{"full_name":"Date Test User"}'
  ),
  (
    '22222222-2222-2222-2222-222222222222',
    'date-owner@example.com',
    '',
    now(),
    '{"full_name":"Date Test Owner"}'
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
  'Date Constraint Test Facility',
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

-- Bookings whose date has already passed: one confirmed (to be
-- completed) and one still pending (to be expired). These model
-- real rows after a day boundary.
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
  expires_at
)
values
  (
    'bbbbbbbb-0000-0000-0000-000000000001',
    '11111111-1111-1111-1111-111111111111',
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
    current_date - 2, '18:00', '19:00', 500,
    'confirmed', 'paid',
    null
  ),
  (
    'bbbbbbbb-0000-0000-0000-000000000002',
    '11111111-1111-1111-1111-111111111111',
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
    current_date - 1, '18:00', '19:00', 500,
    'pending_payment', 'pending',
    now() - interval '1 hour'
  );


-- ============================================================
-- Test 1
-- The time-dependent constraint is gone.
-- ============================================================

select ok(
  not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.bookings'::regclass
      and conname = 'bookings_date_valid'
  ),
  'bookings_date_valid should not exist'
);


-- ============================================================
-- Test 2
-- No remaining CHECK on bookings depends on the current date.
-- ============================================================

select is(
  (
    select count(*)::integer
    from pg_constraint
    where conrelid = 'public.bookings'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ~* 'current_date|now\(\)|current_timestamp'
  ),
  0,
  'no bookings CHECK constraint should depend on the current time'
);


-- ============================================================
-- Test 3
-- A booking whose date has passed can still be updated.
-- ============================================================

select lives_ok(
  $$
    update public.bookings
    set status = 'completed'
    where id = 'bbbbbbbb-0000-0000-0000-000000000001'
  $$,
  'a booking for a past date can be completed'
);


-- ============================================================
-- Test 4
-- The expiry job is not blocked by past-dated pending bookings.
-- ============================================================

select is(
  public.expire_pending_bookings(),
  1,
  'expire_pending_bookings() should expire a past-dated pending booking'
);


-- ============================================================
-- Test 5
-- create_booking() still rejects past dates.
-- ============================================================

set local request.jwt.claim.sub =
  '11111111-1111-1111-1111-111111111111';

set local role = 'authenticated';

select throws_ok(
  $$
    select *
    from public.create_booking(
      '33333333-3333-3333-3333-333333333333',
      '44444444-4444-4444-4444-444444444444',
      (current_date - 1)
    )
  $$,
  '22007',
  'Booking date cannot be in the past',
  'create_booking() should still reject past booking dates'
);

reset role;


select * from finish();

rollback;
