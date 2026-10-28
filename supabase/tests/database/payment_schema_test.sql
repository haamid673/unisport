begin;

select plan(188);

-- ============================================================
-- Payment schema, slice 1a (20261018190000)
--
-- Constraints, write-once rules, composite foreign keys, refund
-- reservations, amount boundaries and read visibility. Everything
-- runs in one transaction that is rolled back; nothing is
-- committed. Concurrent behaviour is covered by
-- payment_refund_reservation_concurrency_test.sql.
--
-- The migration GUARD (abort when payments/refunds already hold
-- rows) cannot be exercised from inside a transaction that is
-- already past the migration; it is verified by applying the
-- migration to a disposable database that holds legacy rows
-- (procedure recorded in the migration's pull request).
--
-- Ids use the d1.. d9 prefixes. All dates are relative to the
-- current date and are distinct per booking, so neither booking
-- exclusion constraint is ever involved.
-- ============================================================

-- ------------------------------------------------------------
-- Fixture (as the table owner)
-- ------------------------------------------------------------

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
select
  ('d1000000-0000-0000-0000-00000000000' || n)::uuid,
  'pay-schema-' || n || '@example.com', '', now(), '{}'::jsonb
from unnest(array[1, 2, 3, 4, 5]) n;

-- user 5 is an administrator (data-only replacement of the profile)
delete from public.profiles where id = 'd1000000-0000-0000-0000-000000000005';
insert into public.profiles (id, full_name, role)
values ('d1000000-0000-0000-0000-000000000005', 'Pay Schema Admin', 'admin');

insert into public.facilities (id, owner_id, name, sport, address, city, status, base_price)
values
  ('d2000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000003',
   'Pay Schema Arena', 'Badminton', '1 Schema Road', 'Schemaville', 'active', 500),
  ('d2000000-0000-0000-0000-000000000002', 'd1000000-0000-0000-0000-000000000004',
   'Other Arena', 'Badminton', '2 Schema Road', 'Schemaville', 'active', 500);

insert into public.facility_slots (id, facility_id, start_time, end_time, duration_min, base_price)
values ('d3000000-0000-0000-0000-000000000001', 'd2000000-0000-0000-0000-000000000001',
        '06:00', '07:00', 60, 500);

-- b01..b05, b08..b12, b17, b18 are payable holds; b13..b16 are
-- cancelled / expired / completed / legacy-confirmed (no pointer); b06/b07 are LEGACY rows that
-- are confirmed/completed with no payment record at all.
insert into public.bookings
  (id, user_id, facility_id, slot_id, booking_date, start_time, end_time,
   amount, status, payment_status, expires_at)
select
  ('d4000000-0000-0000-0000-0000000000' || lpad(b.n::text, 2, '0'))::uuid,
  b.uid::uuid,
  'd2000000-0000-0000-0000-000000000001',
  'd3000000-0000-0000-0000-000000000001',
  current_date + b.n, '06:00', '07:00',
  b.amount, b.status::public.booking_status, b.pstatus::public.payment_status,
  case when b.status = 'pending_payment' then now() + interval '1 hour' end
from (values
  (1,  'd1000000-0000-0000-0000-000000000001', 500.00,       'pending_payment', 'pending'),
  (2,  'd1000000-0000-0000-0000-000000000001', 500.00,       'pending_payment', 'pending'),
  (3,  'd1000000-0000-0000-0000-000000000001', 0.00,         'pending_payment', 'pending'),
  (4,  'd1000000-0000-0000-0000-000000000001', 99999999.99,  'pending_payment', 'pending'),
  (5,  'd1000000-0000-0000-0000-000000000001', 0.01,         'pending_payment', 'pending'),
  (6,  'd1000000-0000-0000-0000-000000000001', 500.00,       'confirmed',       'paid'),
  (7,  'd1000000-0000-0000-0000-000000000001', 500.00,       'completed',       'paid'),
  (8,  'd1000000-0000-0000-0000-000000000002', 500.00,       'pending_payment', 'pending'),
  (9,  'd1000000-0000-0000-0000-000000000001', 500.00,       'pending_payment', 'pending'),
  (10, 'd1000000-0000-0000-0000-000000000001', 500.00,       'pending_payment', 'pending'),
  (11, 'd1000000-0000-0000-0000-000000000001', 500.00,       'pending_payment', 'pending'),
  (12, 'd1000000-0000-0000-0000-000000000001', 500.00,       'pending_payment', 'pending'),
  (13, 'd1000000-0000-0000-0000-000000000001', 500.00,       'cancelled',       'pending'),
  (14, 'd1000000-0000-0000-0000-000000000001', 500.00,       'expired',         'pending'),
  (15, 'd1000000-0000-0000-0000-000000000001', 500.00,       'completed',       'paid'),
  (16, 'd1000000-0000-0000-0000-000000000001', 500.00,       'confirmed',       'paid'),
  (17, 'd1000000-0000-0000-0000-000000000001', 500.00,       'pending_payment', 'pending'),
  (18, 'd1000000-0000-0000-0000-000000000001', 500.00,       'pending_payment', 'pending')
) as b(n, uid, amount, status, pstatus);

create function pg_temp.act_as(p_user text)
returns void
language plpgsql
as $$
begin
  reset role;
  perform set_config('request.jwt.claim.sub',
    'd1000000-0000-0000-0000-' || lpad(p_user, 12, '0'), true);
  set local role authenticated;
end;
$$;

-- ============================================================
-- A. Shape: columns, types, dropped objects
-- ============================================================

select hasnt_column('public', 'payments', 'status',
  'payments no longer has a shared payment_status column');
select hasnt_column('public', 'payments', 'amount',
  'payments no longer stores rupees');
select hasnt_column('public', 'payments', 'paid_at',
  'payments has no paid_at (no provider capture time is documented)');

select has_column('public', 'payments', 'provider_status', 'payments has provider_status');
select has_column('public', 'payments', 'decision_recorded_at', 'payments has decision_recorded_at');
select has_column('public', 'payments', 'captured_observed_at', 'payments has captured_observed_at');
select has_column('public', 'payments', 'provider_amount_refunded_paise',
  'payments records the observed refunded amount');

select col_type_is('public', 'payments', 'amount_paise', 'bigint', 'payments.amount_paise is bigint');
select col_type_is('public', 'payment_attempts', 'amount_paise', 'bigint', 'payment_attempts.amount_paise is bigint');
select col_type_is('public', 'refunds', 'amount_paise', 'bigint', 'refunds.amount_paise is bigint');
select col_type_is('public', 'payments', 'provider_amount_refunded_paise', 'bigint',
  'observed refunded amount is bigint');

select is(
  (select count(*)::integer from pg_indexes
   where schemaname = 'public'
     and indexname in ('payments_one_per_booking', 'payments_provider_order_id_unique')),
  0,
  'one-payment-per-booking and unique-order indexes are gone'
);
select is(
  (select count(*)::integer from pg_indexes
   where schemaname = 'public' and indexname = 'payments_provider_payment_id_unique'),
  0,
  'the partial unique index on provider_payment_id is replaced'
);
select is(
  (select count(*)::integer from pg_constraint
   where conrelid = 'public.payments'::regclass
     and conname = 'payments_provider_payment_id_key'
     and contype = 'u'
     and pg_get_constraintdef(oid) = 'UNIQUE (provider, provider_payment_id)'),
  1,
  'provider payment identity is a plain UNIQUE (provider, provider_payment_id): a valid ON CONFLICT target'
);
select is(
  (select regexp_replace(pg_get_constraintdef(oid), '\s+', ' ', 'g')
   from pg_constraint
   where conrelid = 'public.payments'::regclass
     and conname = 'payments_attempt_consistency_fkey'),
  'FOREIGN KEY (attempt_id, booking_id, provider, provider_order_id, amount_paise, currency) '
  'REFERENCES payment_attempts(id, booking_id, provider, provider_order_id, amount_paise, currency) '
  'ON DELETE RESTRICT',
  'a payment agrees with its attempt on booking, provider, order id, amount and currency (one composite FK)'
);

-- ============================================================
-- B. payment_attempts
-- ============================================================

insert into public.payment_attempts (id, booking_id, amount_paise)
values ('d5000000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-000000000001', 50000);

select is(
  (select state::text from public.payment_attempts
   where id = 'd5000000-0000-0000-0000-000000000001'),
  'creating',
  'a new attempt starts in the creating state'
);

select throws_ok(
  $$ insert into public.payment_attempts (booking_id, amount_paise)
     values ('d4000000-0000-0000-0000-000000000001', 50000) $$,
  '23505', NULL,
  'a second live attempt for one booking is rejected'
);

select throws_ok(
  $$ insert into public.payment_attempts (booking_id, amount_paise)
     values ('d4000000-0000-0000-0000-000000000002', 49999) $$,
  '23514', NULL,
  'an attempt amount that differs from the booking amount is rejected'
);

select throws_ok(
  $$ insert into public.payment_attempts (booking_id, amount_paise)
     values ('d4000000-0000-0000-0000-000000000003', 1) $$,
  '23514', 'a zero-amount booking cannot have a payment attempt',
  'a zero-price booking cannot have a payment attempt'
);

select lives_ok(
  $$ update public.payment_attempts
     set state = 'closed', closed_at = now(), closed_reason = 'expired'
     where id = 'd5000000-0000-0000-0000-000000000001' $$,
  'an attempt can be closed'
);
select lives_ok(
  $$ insert into public.payment_attempts (id, booking_id, amount_paise)
     values ('d5000000-0000-0000-0000-000000000002',
             'd4000000-0000-0000-0000-000000000001', 50000) $$,
  'a closed attempt permits a subsequent attempt for the booking'
);

select throws_ok(
  $$ update public.payment_attempts set state = 'creating'
     where id = 'd5000000-0000-0000-0000-000000000001' $$,
  '23514', NULL,
  'a closed attempt cannot go back to creating'
);

select throws_ok(
  $$ update public.payment_attempts set state = 'open'
     where id = 'd5000000-0000-0000-0000-000000000002' $$,
  '23514', NULL,
  'an open attempt must carry a provider order id'
);

select lives_ok(
  $$ update public.payment_attempts
     set provider_order_id = 'order_schema_1', state = 'open'
     where id = 'd5000000-0000-0000-0000-000000000002' $$,
  'NULL provider_order_id may become an order id'
);

select lives_ok(
  $$ update public.payment_attempts set provider_order_id = 'order_schema_1'
     where id = 'd5000000-0000-0000-0000-000000000002' $$,
  'writing the same order id again is harmless'
);

select throws_ok(
  $$ update public.payment_attempts set provider_order_id = 'order_schema_2'
     where id = 'd5000000-0000-0000-0000-000000000002' $$,
  '23514', NULL,
  'an assigned provider order id cannot be replaced'
);

select throws_ok(
  $$ update public.payment_attempts set provider_order_id = NULL
     where id = 'd5000000-0000-0000-0000-000000000002' $$,
  '23514', NULL,
  'an assigned provider order id cannot be cleared'
);

insert into public.payment_attempts (id, booking_id, amount_paise)
values ('d5000000-0000-0000-0000-000000000003', 'd4000000-0000-0000-0000-000000000002', 50000);

select throws_ok(
  $$ update public.payment_attempts set provider_order_id = 'order_schema_1'
     where id = 'd5000000-0000-0000-0000-000000000003' $$,
  '23505', NULL,
  'a provider order id can belong to only one attempt'
);

-- attempt 3 becomes payable under its own order (payments attach to it below)
select lives_ok(
  $$ update public.payment_attempts
     set provider_order_id = 'order_shared', state = 'open'
     where id = 'd5000000-0000-0000-0000-000000000003' $$,
  'an attempt receives its provider order id'
);

select throws_ok(
  $$ update public.payment_attempts set amount_paise = 60000
     where id = 'd5000000-0000-0000-0000-000000000003' $$,
  '23514', NULL,
  'an attempt amount is fixed once created'
);

select throws_ok(
  $$ update public.payment_attempts
     set booking_id = 'd4000000-0000-0000-0000-000000000009'
     where id = 'd5000000-0000-0000-0000-000000000003' $$,
  '23514', NULL,
  'an attempt cannot be moved to another booking'
);

-- amount boundaries (exact numeric rupees -> paise)
select lives_ok(
  $$ insert into public.payment_attempts (id, booking_id, amount_paise, provider_order_id, state)
     values ('d5000000-0000-0000-0000-000000000004',
             'd4000000-0000-0000-0000-000000000004', 9999999999, 'order_big', 'open') $$,
  '99,999,999.99 rupees is accepted as 9,999,999,999 paise (above int4)'
);
select lives_ok(
  $$ insert into public.payment_attempts (id, booking_id, amount_paise)
     values ('d5000000-0000-0000-0000-000000000005',
             'd4000000-0000-0000-0000-000000000005', 1) $$,
  '0.01 rupee is accepted as 1 paise'
);

-- ============================================================
-- C. payments: observations and composite foreign keys
-- ============================================================

-- an unmatched payment: no booking, no attempt
select lives_ok(
  $$ insert into public.payments
       (id, provider_payment_id, provider_order_id, provider_status, amount_paise)
     values ('d6000000-0000-0000-0000-000000000001', 'pay_unmatched_1',
             'order_unknown_1', 'captured', 50000) $$,
  'a payment with NULL booking and NULL attempt can be recorded'
);

select throws_ok(
  $$ insert into public.payments
       (provider_payment_id, provider_status, amount_paise)
     values ('pay_unmatched_1', 'captured', 50000) $$,
  '23505', NULL,
  'a provider payment id cannot be recorded twice'
);

-- two payment objects share one order (a failed one and a captured one)
select lives_ok(
  $$ insert into public.payments
       (id, provider_payment_id, provider_order_id, provider_status, amount_paise)
     values ('d6000000-0000-0000-0000-000000000002', 'pay_shared_a', 'order_shared', 'failed', 50000),
            ('d6000000-0000-0000-0000-000000000003', 'pay_shared_b', 'order_shared', 'captured', 50000) $$,
  'several payment objects may share one provider order id'
);

-- attached to the attempt and booking that agree
select lives_ok(
  $$ insert into public.payments
       (id, attempt_id, booking_id, provider_payment_id, provider_order_id, provider_status, amount_paise)
     values ('d6000000-0000-0000-0000-000000000004',
             'd5000000-0000-0000-0000-000000000002',
             'd4000000-0000-0000-0000-000000000001',
             'pay_b01', 'order_schema_1', 'captured', 50000) $$,
  'a payment attached to an attempt and its booking is accepted'
);

select throws_ok(
  $$ insert into public.payments
       (attempt_id, booking_id, provider_payment_id, provider_order_id, provider_status, amount_paise)
     values ('d5000000-0000-0000-0000-000000000002',
             'd4000000-0000-0000-0000-000000000002',
             'pay_mismatch', 'order_schema_1', 'captured', 50000) $$,
  '23503', NULL,
  'a payment whose attempt belongs to a different booking is rejected'
);

select throws_ok(
  $$ insert into public.payments
       (attempt_id, provider_payment_id, provider_order_id, provider_status, amount_paise)
     values ('d5000000-0000-0000-0000-000000000002', 'pay_noboook', 'order_schema_1', 'captured', 50000) $$,
  '23514', NULL,
  'an attempt without a booking is rejected'
);

-- the attempt and the payment must agree on order, amount and currency
select throws_ok(
  $$ insert into public.payments
       (attempt_id, booking_id, provider_payment_id, provider_order_id, provider_status, amount_paise)
     values ('d5000000-0000-0000-0000-000000000002',
             'd4000000-0000-0000-0000-000000000001',
             'pay_wrong_order', 'order_other', 'captured', 50000) $$,
  '23503', NULL,
  'H1: a payment whose order id differs from its attempt''s order id is rejected'
);
select throws_ok(
  $$ insert into public.payments
       (attempt_id, booking_id, provider_payment_id, provider_order_id, provider_status, amount_paise)
     values ('d5000000-0000-0000-0000-000000000002',
             'd4000000-0000-0000-0000-000000000001',
             'pay_wrong_amount', 'order_schema_1', 'captured', 40000) $$,
  '23503', NULL,
  'H1: a payment whose amount differs from its attempt''s amount is rejected'
);
select throws_ok(
  $$ insert into public.payments
       (attempt_id, booking_id, provider_payment_id, provider_order_id, provider_status, amount_paise, currency)
     values ('d5000000-0000-0000-0000-000000000002',
             'd4000000-0000-0000-0000-000000000001',
             'pay_wrong_currency', 'order_schema_1', 'captured', 50000, 'USD') $$,
  '23503', NULL,
  'H1: a payment whose currency differs from its attempt''s currency is rejected'
);
select throws_like(
  $$ insert into public.payments
       (attempt_id, booking_id, provider_payment_id, provider_status, amount_paise)
     values ('d5000000-0000-0000-0000-000000000002',
             'd4000000-0000-0000-0000-000000000001',
             'pay_null_order', 'captured', 50000) $$,
  '%payments_attempt_requires_order%',
  'H1: an attempt association without a provider order id is rejected'
);
-- an attempt that has no order id yet cannot be attached to at all
select lives_ok(
  $$ insert into public.payments
       (id, provider_payment_id, provider_order_id, provider_status, amount_paise)
     values ('d6000000-0000-0000-0000-000000000011', 'pay_early', 'order_not_yet', 'captured', 1) $$,
  'fixture: a payment for an order whose attempt has no order id'
);
select throws_ok(
  $$ update public.payments
     set attempt_id = 'd5000000-0000-0000-0000-000000000005',
         booking_id = 'd4000000-0000-0000-0000-000000000005'
     where provider_payment_id = 'pay_early' $$,
  '23503', NULL,
  'H1: a payment cannot be attached to an attempt that has no provider order id'
);
-- unmatched payments attach later only to the attempt of THEIR order
select lives_ok(
  $$ insert into public.payments
       (id, provider_payment_id, provider_order_id, provider_status, amount_paise)
     values ('d6000000-0000-0000-0000-000000000012', 'pay_wrong_late', 'order_other_late', 'captured', 50000) $$,
  'fixture: an unmatched payment of some other order'
);
select throws_ok(
  $$ update public.payments
     set attempt_id = 'd5000000-0000-0000-0000-000000000002',
         booking_id = 'd4000000-0000-0000-0000-000000000001'
     where provider_payment_id = 'pay_wrong_late' $$,
  '23503', NULL,
  'H1: a later attachment is subject to the same order/amount/currency agreement'
);
-- provider is part of the same key; the enum has a single value, so
-- a differing provider cannot be constructed here (see the FK test in A).

select throws_ok(
  $$ insert into public.payments
       (provider_payment_id, provider_status, amount_paise)
     values ('pay_zero', 'captured', 0) $$,
  '23514', NULL,
  'a provider payment amount must be positive'
);

-- a payment recorded at the int8 boundary
select lives_ok(
  $$ insert into public.payments
       (id, attempt_id, booking_id, provider_payment_id, provider_order_id, provider_status, amount_paise)
     values ('d6000000-0000-0000-0000-000000000005',
             'd5000000-0000-0000-0000-000000000004',
             'd4000000-0000-0000-0000-000000000004',
             'pay_big', 'order_big', 'captured', 9999999999) $$,
  'a 9,999,999,999 paise payment is stored exactly'
);
select is(
  (select amount_paise from public.payments where provider_payment_id = 'pay_big'),
  9999999999::bigint,
  'the boundary amount round-trips without loss'
);

select lives_ok(
  $$ insert into public.payments
       (id, provider_payment_id, provider_order_id, provider_status, amount_paise)
     values ('d6000000-0000-0000-0000-000000000006', 'pay_cap_multi', 'order_cap_multi',
             'captured', 50000) $$,
  'fixture: a captured payment with spare refund capacity'
);

-- observed data rules
select throws_ok(
  $$ update public.payments set amount_paise = 1
     where provider_payment_id = 'pay_b01' $$,
  '23514', NULL,
  'a recorded provider amount cannot change'
);
select throws_ok(
  $$ update public.payments set provider_payment_id = 'pay_renamed'
     where provider_payment_id = 'pay_b01' $$,
  '23514', NULL,
  'a recorded provider payment id cannot change'
);
select throws_ok(
  $$ update public.payments set provider_status = 'failed'
     where provider_payment_id = 'pay_b01' $$,
  '23514', NULL,
  'a captured payment cannot be downgraded to failed by a late event'
);
select throws_ok(
  $$ update public.payments set provider_status = 'authorized'
     where provider_payment_id = 'pay_b01' $$,
  '23514', NULL,
  'a captured payment cannot be downgraded to authorized'
);
select lives_ok(
  $$ update public.payments set provider_status = 'captured'
     where provider_payment_id = 'pay_shared_a' $$,
  'a payment first observed failed may later be observed captured'
);
select lives_ok(
  $$ update public.payments
     set provider_status = 'refunded', provider_amount_refunded_paise = 50000
     where provider_payment_id = 'pay_shared_b' $$,
  'a captured payment may be observed fully refunded'
);
select throws_ok(
  $$ update public.payments set provider_status = 'captured'
     where provider_payment_id = 'pay_shared_b' $$,
  '23514', NULL,
  'a refunded payment cannot be treated as captured again'
);
select throws_ok(
  $$ update public.payments set provider_amount_refunded_paise = 100
     where provider_payment_id = 'pay_shared_b' $$,
  '23514', NULL,
  'the observed refunded amount cannot decrease'
);
select throws_ok(
  $$ update public.payments set provider_amount_refunded_paise = 50001
     where provider_payment_id = 'pay_b01' $$,
  '23514', NULL,
  'the observed refunded amount cannot exceed the payment amount'
);

-- partial refund observation: status stays captured, the total grows
select lives_ok(
  $$ update public.payments set provider_amount_refunded_paise = 20000
     where provider_payment_id = 'pay_cap_multi' $$,
  'a partial provider refund is observed as captured with a refunded amount'
);
select is(
  (select provider_status::text || '/' || provider_amount_refunded_paise::text
   from public.payments where provider_payment_id = 'pay_cap_multi'),
  'captured/20000',
  'a partly refunded payment stays captured and records how much was refunded'
);
select throws_ok(
  $$ update public.payments set provider_amount_refunded_paise = 10000
     where provider_payment_id = 'pay_cap_multi' $$,
  '23514', NULL,
  'a partial refund observation cannot be lowered by a stale event'
);

-- provider_order_id of a payment: NULL may be filled once, never changed
select lives_ok(
  $$ insert into public.payments (id, provider_payment_id, provider_status, amount_paise)
     values ('d6000000-0000-0000-0000-000000000013', 'pay_order_later', 'created', 50000) $$,
  'fixture: a payment first seen without an order id'
);
select lives_ok(
  $$ update public.payments set provider_order_id = 'order_filled_later'
     where provider_payment_id = 'pay_order_later' $$,
  'a NULL provider order id of a payment may be filled once'
);
select throws_ok(
  $$ update public.payments set provider_order_id = 'order_changed_later'
     where provider_payment_id = 'pay_order_later' $$,
  '23514', NULL,
  'payments.provider_order_id is write-once (cannot be changed)'
);
select throws_ok(
  $$ update public.payments set provider_order_id = NULL
     where provider_payment_id = 'pay_order_later' $$,
  '23514', NULL,
  'payments.provider_order_id cannot be cleared'
);

-- association is write-once once set; NULL may be filled once
select throws_ok(
  $$ update public.payments
     set booking_id = 'd4000000-0000-0000-0000-000000000009'
     where provider_payment_id = 'pay_b01' $$,
  '23514', NULL,
  'an established booking association cannot be re-pointed'
);
select lives_ok(
  $$ update public.payments
     set attempt_id = 'd5000000-0000-0000-0000-000000000003',
         booking_id = 'd4000000-0000-0000-0000-000000000002'
     where provider_payment_id = 'pay_shared_a' $$,
  'an unmatched payment can later be attached once, to a consistent attempt/booking'
);
select throws_ok(
  $$ update public.payments
     set attempt_id = 'd5000000-0000-0000-0000-000000000002',
         booking_id = 'd4000000-0000-0000-0000-000000000001'
     where provider_payment_id = 'pay_shared_a' $$,
  '23514', NULL,
  'a payment already attached to an attempt cannot be moved to another'
);

-- decision and disposition markers
select throws_ok(
  $$ update public.payments set decision_recorded_at = now()
     where provider_payment_id = 'pay_unmatched_1' $$,
  '23514', NULL,
  'a decision cannot be recorded for an unmatched payment'
);
select lives_ok(
  $$ update public.payments set decision_recorded_at = now()
     where provider_payment_id = 'pay_b01' $$,
  'a decision can be recorded for a matched captured payment'
);
select throws_ok(
  $$ update public.payments set decision_recorded_at = now() + interval '1 minute'
     where provider_payment_id = 'pay_b01' $$,
  '23514', NULL,
  'decision_recorded_at is write-once'
);
select throws_ok(
  $$ update public.payments set unmatched_disposition = 'foreign'
     where provider_payment_id = 'pay_b01' $$,
  '23514', NULL,
  'an operator disposition is only valid on an unmatched payment'
);
select lives_ok(
  $$ update public.payments set unmatched_disposition = 'foreign', resolution_attempts = 3
     where provider_payment_id = 'pay_unmatched_1' $$,
  'an unmatched payment can be dispositioned and counted'
);
select lives_ok(
  $$ update public.payments set unmatched_disposition = NULL
     where provider_payment_id = 'pay_unmatched_1' $$,
  'the disposition can be revisited while unmatched'
);

-- ============================================================
-- D. bookings: fulfilment pointer, immutability, legacy rows
-- ============================================================

-- b01 is fulfilled by pay_b01 (same booking)
select lives_ok(
  $$ update public.bookings
     set status = 'confirmed', payment_status = 'paid', confirmed_at = now(),
         fulfilled_by_payment_id = 'd6000000-0000-0000-0000-000000000004'
     where id = 'd4000000-0000-0000-0000-000000000001' $$,
  'a booking can be fulfilled by a payment that belongs to it'
);

select throws_ok(
  $$ update public.bookings
     set status = 'confirmed',
         fulfilled_by_payment_id = 'd6000000-0000-0000-0000-000000000005'
     where id = 'd4000000-0000-0000-0000-000000000002' $$,
  '23503', NULL,
  'a booking cannot be fulfilled by another booking''s payment (composite FK)'
);

select throws_ok(
  $$ update public.bookings
     set status = 'confirmed',
         fulfilled_by_payment_id = 'd6000000-0000-0000-0000-000000000004'
     where id = 'd4000000-0000-0000-0000-000000000002' $$,
  '23505', NULL,
  'a payment that already fulfilled a booking cannot fulfil a second one (unique)'
);

select throws_ok(
  $$ update public.bookings
     set status = 'confirmed',
         fulfilled_by_payment_id = 'd6000000-0000-0000-0000-000000000001'
     where id = 'd4000000-0000-0000-0000-000000000008' $$,
  '23503', NULL,
  'an unmatched payment (NULL booking) can never fulfil a booking'
);

select throws_ok(
  $$ update public.bookings
     set fulfilled_by_payment_id = 'd6000000-0000-0000-0000-000000000003'
     where id = 'd4000000-0000-0000-0000-000000000001' $$,
  '23514', NULL,
  'bookings.fulfilled_by_payment_id is write-once (cannot be replaced)'
);

select throws_ok(
  $$ update public.bookings set fulfilled_by_payment_id = NULL
     where id = 'd4000000-0000-0000-0000-000000000001' $$,
  '23514', NULL,
  'bookings.fulfilled_by_payment_id cannot be cleared'
);

select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.bookings'::regclass
      and conname = 'bookings_fulfilled_by_payment_id_key'
      and contype = 'u'
  ),
  'fulfilled_by_payment_id has a unique constraint (a payment fulfils at most one booking)'
);

select throws_ok(
  $$ update public.bookings
     set fulfilled_by_payment_id = 'd6000000-0000-0000-0000-000000000005'
     where id = 'd4000000-0000-0000-0000-000000000004' $$,
  '23514', NULL,
  'a pending booking cannot carry a fulfilling payment (status check)'
);

-- fulfilment eligibility (H1): the payment's OBSERVED state is checked
-- when the pointer is first set. b12 has one open attempt and
-- payments in every state the provider can report.
insert into public.payment_attempts (id, booking_id, amount_paise, provider_order_id, state)
values ('d5000000-0000-0000-0000-000000000012', 'd4000000-0000-0000-0000-000000000012',
        50000, 'order_b12', 'open');

insert into public.payments
  (id, attempt_id, booking_id, provider_payment_id, provider_order_id,
   provider_status, amount_paise, provider_amount_refunded_paise)
values
  ('d6000000-0000-0000-0000-000000000021', 'd5000000-0000-0000-0000-000000000012',
   'd4000000-0000-0000-0000-000000000012', 'pay_f_failed', 'order_b12', 'failed', 50000, 0),
  ('d6000000-0000-0000-0000-000000000022', 'd5000000-0000-0000-0000-000000000012',
   'd4000000-0000-0000-0000-000000000012', 'pay_f_auth', 'order_b12', 'authorized', 50000, 0),
  ('d6000000-0000-0000-0000-000000000023', 'd5000000-0000-0000-0000-000000000012',
   'd4000000-0000-0000-0000-000000000012', 'pay_f_refunded', 'order_b12', 'refunded', 50000, 50000),
  ('d6000000-0000-0000-0000-000000000024', 'd5000000-0000-0000-0000-000000000012',
   'd4000000-0000-0000-0000-000000000012', 'pay_f_partial', 'order_b12', 'captured', 50000, 10000),
  ('d6000000-0000-0000-0000-000000000026', 'd5000000-0000-0000-0000-000000000012',
   'd4000000-0000-0000-0000-000000000012', 'pay_f_ok', 'order_b12', 'captured', 50000, 0);

-- linked to the booking only (no attempt, no order): allowed to exist,
-- never allowed to fulfil
insert into public.payments
  (id, booking_id, provider_payment_id, provider_status, amount_paise)
values
  ('d6000000-0000-0000-0000-000000000025', 'd4000000-0000-0000-0000-000000000012',
   'pay_f_noattempt', 'captured', 50000);

select throws_like(
  $$ update public.bookings
     set status = 'confirmed', fulfilled_by_payment_id = 'd6000000-0000-0000-0000-000000000025'
     where id = 'd4000000-0000-0000-0000-000000000012' $$,
  '%matched to a payment attempt%',
  'H1: a payment without an attempt cannot fulfil its booking'
);
select throws_like(
  $$ update public.bookings
     set status = 'confirmed', fulfilled_by_payment_id = 'd6000000-0000-0000-0000-000000000021'
     where id = 'd4000000-0000-0000-0000-000000000012' $$,
  '%captured payment (payment is failed)%',
  'H1: a failed payment cannot fulfil a booking'
);
select throws_like(
  $$ update public.bookings
     set status = 'confirmed', fulfilled_by_payment_id = 'd6000000-0000-0000-0000-000000000022'
     where id = 'd4000000-0000-0000-0000-000000000012' $$,
  '%captured payment (payment is authorized)%',
  'H1: an authorized (not captured) payment cannot fulfil a booking'
);
select throws_like(
  $$ update public.bookings
     set status = 'confirmed', fulfilled_by_payment_id = 'd6000000-0000-0000-0000-000000000023'
     where id = 'd4000000-0000-0000-0000-000000000012' $$,
  '%captured payment (payment is refunded)%',
  'H1: a fully refunded payment cannot fulfil a booking'
);
select throws_like(
  $$ update public.bookings
     set status = 'confirmed', fulfilled_by_payment_id = 'd6000000-0000-0000-0000-000000000024'
     where id = 'd4000000-0000-0000-0000-000000000012' $$,
  '%(partly) refunded%',
  'H1: a partly refunded captured payment cannot fulfil a booking'
);
select is(
  (select fulfilled_by_payment_id::text from public.bookings
   where id = 'd4000000-0000-0000-0000-000000000012'),
  null,
  'every refused fulfilment left the pointer NULL'
);
select lives_ok(
  $$ update public.bookings
     set status = 'confirmed', payment_status = 'paid', confirmed_at = now(),
         fulfilled_by_payment_id = 'd6000000-0000-0000-0000-000000000026'
     where id = 'd4000000-0000-0000-0000-000000000012' $$,
  'H1: a matched, captured, unrefunded payment of the right amount fulfils its booking'
);
select lives_ok(
  $$ update public.payments set provider_amount_refunded_paise = 10000
     where provider_payment_id = 'pay_f_ok' $$,
  'a refund observed AFTER fulfilment is a legitimate later fact and is accepted'
);
select is(
  (select fulfilled_by_payment_id::text from public.bookings
   where id = 'd4000000-0000-0000-0000-000000000012'),
  'd6000000-0000-0000-0000-000000000026',
  'and the booking stays fulfilled by that payment'
);

-- F3: the FIRST assignment is exactly pending_payment -> confirmed.
-- b13 cancelled, b14 expired, b15 completed and b16 confirmed each
-- have an open attempt and a clean captured payment, so nothing but
-- the booking's lifecycle can be the reason for the refusal.
insert into public.payment_attempts (id, booking_id, amount_paise, provider_order_id, state)
select ('d5000000-0000-0000-0000-0000000000' || n)::uuid,
       ('d4000000-0000-0000-0000-0000000000' || n)::uuid,
       50000, 'order_b' || n, 'open'
from unnest(array['13', '14', '15', '16', '18']) n;

insert into public.payments
  (id, attempt_id, booking_id, provider_payment_id, provider_order_id, provider_status, amount_paise)
select ('d6000000-0000-0000-0000-0000000000' || (n::int + 30)::text)::uuid,
       ('d5000000-0000-0000-0000-0000000000' || n)::uuid,
       ('d4000000-0000-0000-0000-0000000000' || n)::uuid,
       'pay_lc_' || n, 'order_b' || n, 'captured', 50000
from unnest(array['13', '14', '15', '16', '18']) n;

select throws_like(
  $$ update public.bookings
     set fulfilled_by_payment_id = 'd6000000-0000-0000-0000-000000000043'
     where id = 'd4000000-0000-0000-0000-000000000013' $$,
  '%from pending_payment to confirmed (booking is cancelled%',
  'F3: a cancelled booking cannot receive its first fulfilling payment'
);
select throws_like(
  $$ update public.bookings
     set fulfilled_by_payment_id = 'd6000000-0000-0000-0000-000000000044'
     where id = 'd4000000-0000-0000-0000-000000000014' $$,
  '%booking is expired%',
  'F3: an expired booking cannot receive its first fulfilling payment'
);
select throws_like(
  $$ update public.bookings
     set fulfilled_by_payment_id = 'd6000000-0000-0000-0000-000000000045'
     where id = 'd4000000-0000-0000-0000-000000000015' $$,
  '%booking is completed%',
  'F3: a completed booking cannot receive its first fulfilling payment'
);
select throws_like(
  $$ update public.bookings
     set fulfilled_by_payment_id = 'd6000000-0000-0000-0000-000000000046'
     where id = 'd4000000-0000-0000-0000-000000000016' $$,
  '%booking is confirmed%',
  'F3: a legacy confirmed booking is not retro-fitted with a fulfilling payment'
);
select throws_like(
  $$ update public.bookings
     set fulfilled_by_payment_id = 'd6000000-0000-0000-0000-000000000048'
     where id = 'd4000000-0000-0000-0000-000000000018' $$,
  '%this update sets pending_payment%',
  'F3: the pointer cannot be set on a booking that stays pending_payment'
);
select throws_like(
  $$ update public.bookings
     set status = 'cancelled', fulfilled_by_payment_id = 'd6000000-0000-0000-0000-000000000048'
     where id = 'd4000000-0000-0000-0000-000000000018' $$,
  '%this update sets cancelled%',
  'F3: the first assignment cannot also cancel the booking'
);
select is(
  (select count(*)::integer from public.bookings
   where id in ('d4000000-0000-0000-0000-000000000013', 'd4000000-0000-0000-0000-000000000014',
                'd4000000-0000-0000-0000-000000000015', 'd4000000-0000-0000-0000-000000000016',
                'd4000000-0000-0000-0000-000000000018')
     and fulfilled_by_payment_id is not null),
  0,
  'F3: every refused assignment left the pointer NULL, and the legacy rows stay valid without one'
);
select lives_ok(
  $$ update public.bookings
     set status = 'confirmed', confirmed_at = now(),
         fulfilled_by_payment_id = 'd6000000-0000-0000-0000-000000000048'
     where id = 'd4000000-0000-0000-0000-000000000018' $$,
  'F3: a pending_payment booking moving to confirmed is fulfilled'
);

-- F1: a refund obligation blocks the first fulfilment. b17 has one
-- payment per refund state. None of the refunds has appeared in the
-- provider's refunded amount yet (that stays 0), which is exactly
-- the window the eligibility check must close.
insert into public.payment_attempts (id, booking_id, amount_paise, provider_order_id, state)
values ('d5000000-0000-0000-0000-000000000017', 'd4000000-0000-0000-0000-000000000017',
        50000, 'order_b17', 'open');

insert into public.payments
  (id, attempt_id, booking_id, provider_payment_id, provider_order_id, provider_status, amount_paise)
select ('d6000000-0000-0000-0000-0000000000' || t.id)::uuid,
       'd5000000-0000-0000-0000-000000000017', 'd4000000-0000-0000-0000-000000000017',
       t.pid, 'order_b17', 'captured', 50000
from (values
  ('51', 'pay_r_requested'), ('52', 'pay_r_in_doubt'), ('53', 'pay_r_submitted'),
  ('54', 'pay_r_processed'), ('55', 'pay_r_failed')
) t(id, pid);

insert into public.refunds
  (id, payment_id, amount_paise, idempotency_key, reason_code, state, provider_refund_id)
values
  ('d7000000-0000-0000-0000-000000000051', 'd6000000-0000-0000-0000-000000000051',
   1000, 'rfd_obl_requested_01', 'customer_cancel', 'requested', NULL),
  ('d7000000-0000-0000-0000-000000000052', 'd6000000-0000-0000-0000-000000000052',
   1000, 'rfd_obl_in_doubt_001', 'customer_cancel', 'in_doubt', NULL),
  ('d7000000-0000-0000-0000-000000000053', 'd6000000-0000-0000-0000-000000000053',
   1000, 'rfd_obl_submitted_001', 'customer_cancel', 'submitted', 'rfnd_obl_submitted'),
  ('d7000000-0000-0000-0000-000000000054', 'd6000000-0000-0000-0000-000000000054',
   1000, 'rfd_obl_processed_001', 'customer_cancel', 'processed', 'rfnd_obl_processed'),
  ('d7000000-0000-0000-0000-000000000055', 'd6000000-0000-0000-0000-000000000055',
   1000, 'rfd_obl_failed_000001', 'customer_cancel', 'failed', NULL);

select is(
  (select count(*)::integer from public.payments
   where provider_payment_id like 'pay_r\_%' and provider_amount_refunded_paise <> 0),
  0,
  'F1: none of the refund obligations is visible in the provider refunded amount yet'
);
select throws_like(
  $$ update public.bookings
     set status = 'confirmed', fulfilled_by_payment_id = 'd6000000-0000-0000-0000-000000000051'
     where id = 'd4000000-0000-0000-0000-000000000017' $$,
  '%already has a refund obligation%',
  'F1: a requested refund blocks the first fulfilment'
);
select throws_like(
  $$ update public.bookings
     set status = 'confirmed', fulfilled_by_payment_id = 'd6000000-0000-0000-0000-000000000052'
     where id = 'd4000000-0000-0000-0000-000000000017' $$,
  '%already has a refund obligation%',
  'F1: an in_doubt refund blocks the first fulfilment'
);
select throws_like(
  $$ update public.bookings
     set status = 'confirmed', fulfilled_by_payment_id = 'd6000000-0000-0000-0000-000000000053'
     where id = 'd4000000-0000-0000-0000-000000000017' $$,
  '%already has a refund obligation%',
  'F1: a submitted refund blocks the first fulfilment'
);
select throws_like(
  $$ update public.bookings
     set status = 'confirmed', fulfilled_by_payment_id = 'd6000000-0000-0000-0000-000000000054'
     where id = 'd4000000-0000-0000-0000-000000000017' $$,
  '%already has a refund obligation%',
  'F1: a processed refund blocks the first fulfilment'
);
select lives_ok(
  $$ update public.bookings
     set status = 'confirmed', confirmed_at = now(),
         fulfilled_by_payment_id = 'd6000000-0000-0000-0000-000000000055'
     where id = 'd4000000-0000-0000-0000-000000000017' $$,
  'F1: a payment whose only refund failed can fulfil the booking'
);
select lives_ok(
  $$ insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code)
     values ('d6000000-0000-0000-0000-000000000055', 1000, 'rfd_obl_later_000001', 'customer_cancel') $$,
  'F1: a refund recorded AFTER fulfilment is a legitimate later fact'
);
select is(
  (select fulfilled_by_payment_id::text from public.bookings
   where id = 'd4000000-0000-0000-0000-000000000017'),
  'd6000000-0000-0000-0000-000000000055',
  'F1: the booking stays fulfilled by that payment'
);

-- bookings.amount is part of the immutable set
select throws_ok(
  $$ update public.bookings set amount = 600
     where id = 'd4000000-0000-0000-0000-000000000011' $$,
  '23514', NULL,
  'a booking''s amount cannot be changed'
);

-- identity columns
select throws_ok(
  $$ update public.bookings set user_id = 'd1000000-0000-0000-0000-000000000002'
     where id = 'd4000000-0000-0000-0000-000000000011' $$,
  '23514', NULL,
  'a booking''s user cannot be changed'
);
select throws_ok(
  $$ update public.bookings set facility_id = 'd2000000-0000-0000-0000-000000000002'
     where id = 'd4000000-0000-0000-0000-000000000011' $$,
  '23514', NULL,
  'a booking''s facility cannot be changed'
);
select throws_ok(
  $$ update public.bookings set booking_date = booking_date + 40
     where id = 'd4000000-0000-0000-0000-000000000011' $$,
  '23514', NULL,
  'a booking''s date cannot be changed'
);
select throws_ok(
  $$ update public.bookings set start_time = '08:00', end_time = '09:00'
     where id = 'd4000000-0000-0000-0000-000000000011' $$,
  '23514', NULL,
  'a booking''s times cannot be changed'
);
select lives_ok(
  $$ update public.bookings
     set status = 'expired', expires_at = now() - interval '1 minute'
     where id = 'd4000000-0000-0000-0000-000000000011' $$,
  'status and expiry remain updatable'
);
select lives_ok(
  $$ update public.bookings set user_id = user_id, booking_date = booking_date
     where id = 'd4000000-0000-0000-0000-000000000010' $$,
  'a no-op assignment of identity columns is not an error'
);

-- legacy fixtures
select is(
  (select count(*)::integer from public.bookings
   where id in ('d4000000-0000-0000-0000-000000000006',
                'd4000000-0000-0000-0000-000000000007')
     and status in ('confirmed', 'completed')
     and fulfilled_by_payment_id is null),
  2,
  'legacy confirmed/completed bookings with no payment remain valid'
);
select lives_ok(
  $$ update public.bookings set status = 'completed'
     where id = 'd4000000-0000-0000-0000-000000000006' $$,
  'a legacy confirmed booking can still be completed'
);
select lives_ok(
  $$ insert into public.bookings
       (user_id, facility_id, slot_id, booking_date, start_time, end_time,
        amount, status, payment_status)
     values ('d1000000-0000-0000-0000-000000000001',
             'd2000000-0000-0000-0000-000000000001',
             'd3000000-0000-0000-0000-000000000001',
             current_date + 20, '06:00', '07:00', 500, 'confirmed', 'paid') $$,
  'a test fixture inserting a confirmed booking without a payment still works'
);

-- ============================================================
-- E. refunds: key, reservations, state order, retry
-- ============================================================

-- pay_unmatched_1 (50000 paise, captured) is the refund target
select lives_ok(
  $$ insert into public.refunds
       (id, payment_id, amount_paise, idempotency_key, reason_code)
     values ('d7000000-0000-0000-0000-000000000001',
             'd6000000-0000-0000-0000-000000000001',
             30000, 'rfd_schema_000001', 'duplicate_capture') $$,
  'a refund within the payment amount is reserved'
);

select throws_ok(
  $$ insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code)
     values ('d6000000-0000-0000-0000-000000000001', 100, 'rfd_schema_000001', 'duplicate_capture') $$,
  '23505', NULL,
  'a refund idempotency key can be used once'
);
select throws_ok(
  $$ insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code)
     values ('d6000000-0000-0000-0000-000000000001', 100, 'short_key', 'duplicate_capture') $$,
  '23514', NULL,
  'an idempotency key shorter than 10 characters is rejected'
);
select throws_ok(
  $$ insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code)
     values ('d6000000-0000-0000-0000-000000000001', 100, 'rfd:schema:000002', 'duplicate_capture') $$,
  '23514', NULL,
  'an idempotency key with characters the provider forbids is rejected'
);

select throws_ok(
  $$ insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code)
     values ('d6000000-0000-0000-0000-000000000001', 20001, 'rfd_schema_000003', 'duplicate_capture') $$,
  'UB003', NULL,
  'a refund that would exceed the payment amount is rejected'
);
select lives_ok(
  $$ insert into public.refunds (id, payment_id, amount_paise, idempotency_key, reason_code)
     values ('d7000000-0000-0000-0000-000000000002',
             'd6000000-0000-0000-0000-000000000001',
             20000, 'rfd_schema_000004', 'amount_mismatch') $$,
  'refunds may reserve exactly the whole payment amount'
);
select throws_ok(
  $$ insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code)
     values ('d6000000-0000-0000-0000-000000000001', 1, 'rfd_schema_000005', 'duplicate_capture') $$,
  'UB003', NULL,
  'a fully reserved payment accepts no further refund'
);

-- in_doubt keeps its reservation; failed releases it
select lives_ok(
  $$ update public.refunds set state = 'in_doubt', claimed_at = now(), attempts = 1
     where id = 'd7000000-0000-0000-0000-000000000002' $$,
  'a refund can be claimed for sending (in_doubt)'
);
select throws_ok(
  $$ insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code)
     values ('d6000000-0000-0000-0000-000000000001', 1, 'rfd_schema_000006', 'duplicate_capture') $$,
  'UB003', NULL,
  'an in_doubt refund still reserves its amount'
);
select throws_ok(
  $$ update public.refunds set state = 'requested'
     where id = 'd7000000-0000-0000-0000-000000000002' $$,
  '23514', NULL,
  'a refund cannot go back from in_doubt to requested'
);
select lives_ok(
  $$ update public.refunds set state = 'failed', failure_reason = 'definitive provider rejection'
     where id = 'd7000000-0000-0000-0000-000000000002' $$,
  'a refund can be marked definitively failed'
);
select throws_ok(
  $$ update public.refunds set state = 'requested'
     where id = 'd7000000-0000-0000-0000-000000000002' $$,
  '23514', NULL,
  'a failed refund is final and cannot be revived'
);

-- retry replaces a failed refund of the same payment, once
select throws_ok(
  $$ insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code, retry_of)
     values ('d6000000-0000-0000-0000-000000000001', 20000, 'rfd_schema_000007', 'amount_mismatch',
             'd7000000-0000-0000-0000-000000000001') $$,
  '23514', NULL,
  'a refund can retry only a refund that definitively failed'
);
select lives_ok(
  $$ insert into public.refunds (id, payment_id, amount_paise, idempotency_key, reason_code, retry_of)
     values ('d7000000-0000-0000-0000-000000000003',
             'd6000000-0000-0000-0000-000000000001', 20000, 'rfd_schema_000008', 'amount_mismatch',
             'd7000000-0000-0000-0000-000000000002') $$,
  'a failed refund can be retried without double-reserving (the failed row released its amount)'
);
-- a failed refund may be retried only once (needs spare capacity so
-- the unique index, not the cap, is what rejects the second retry)
select lives_ok(
  $$ insert into public.refunds (id, payment_id, amount_paise, idempotency_key, reason_code, state)
     values ('d7000000-0000-0000-0000-000000000006',
             'd6000000-0000-0000-0000-000000000006', 100, 'rfd_once_0000001', 'amount_mismatch', 'failed') $$,
  'fixture: a definitively failed refund'
);
select lives_ok(
  $$ insert into public.refunds (id, payment_id, amount_paise, idempotency_key, reason_code, retry_of)
     values ('d7000000-0000-0000-0000-000000000007',
             'd6000000-0000-0000-0000-000000000006', 100, 'rfd_once_0000002', 'amount_mismatch',
             'd7000000-0000-0000-0000-000000000006') $$,
  'the first retry of a failed refund is accepted'
);
select throws_ok(
  $$ insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code, retry_of)
     values ('d6000000-0000-0000-0000-000000000006', 100, 'rfd_once_0000003', 'amount_mismatch',
             'd7000000-0000-0000-0000-000000000006') $$,
  '23505', NULL,
  'a failed refund can be retried only once'
);

-- immutability and provider-id rules
select throws_ok(
  $$ update public.refunds set amount_paise = 1
     where id = 'd7000000-0000-0000-0000-000000000001' $$,
  '23514', NULL,
  'a refund amount is fixed once created'
);
select throws_ok(
  $$ update public.refunds set state = 'submitted'
     where id = 'd7000000-0000-0000-0000-000000000001' $$,
  '23514', NULL,
  'a submitted refund must carry the provider refund id'
);
select lives_ok(
  $$ update public.refunds set state = 'submitted', provider_refund_id = 'rfnd_schema_1'
     where id = 'd7000000-0000-0000-0000-000000000001' $$,
  'a refund becomes submitted with the provider refund id'
);
select throws_ok(
  $$ update public.refunds set provider_refund_id = 'rfnd_schema_other'
     where id = 'd7000000-0000-0000-0000-000000000001' $$,
  '23514', NULL,
  'a provider refund id is write-once'
);

-- immutable fields of a refund
select throws_ok(
  $$ update public.refunds set payment_id = 'd6000000-0000-0000-0000-000000000006'
     where id = 'd7000000-0000-0000-0000-000000000001' $$,
  '23514', NULL,
  'M3: a refund cannot be moved to another payment'
);
select throws_ok(
  $$ update public.refunds set retry_of = NULL
     where id = 'd7000000-0000-0000-0000-000000000003' $$,
  '23514', NULL,
  'M3: retry_of cannot be changed or cleared'
);
select throws_ok(
  $$ update public.refunds set idempotency_key = 'rfd_changed_00001'
     where id = 'd7000000-0000-0000-0000-000000000001' $$,
  '23514', NULL,
  'M3: a refund''s idempotency key cannot be changed'
);

-- state machine: submitted may not go back; processed is final
select throws_ok(
  $$ update public.refunds set state = 'in_doubt'
     where id = 'd7000000-0000-0000-0000-000000000001' $$,
  '23514', NULL,
  'M3: submitted cannot go back to in_doubt'
);
select lives_ok(
  $$ update public.refunds set state = 'processed', processed_observed_at = now()
     where id = 'd7000000-0000-0000-0000-000000000001' $$,
  'a submitted refund becomes processed'
);
select throws_ok(
  $$ update public.refunds set state = 'failed'
     where id = 'd7000000-0000-0000-0000-000000000001' $$,
  '23514', NULL,
  'M3: a processed refund is final (cannot become failed)'
);
select throws_ok(
  $$ update public.refunds set state = 'in_doubt'
     where id = 'd7000000-0000-0000-0000-000000000001' $$,
  '23514', NULL,
  'M3: a processed refund is final (cannot go back to in_doubt)'
);
select is(
  (select reserved from (
     select coalesce(sum(amount_paise), 0)::bigint as reserved
     from public.refunds
     where payment_id = 'd6000000-0000-0000-0000-000000000001' and state <> 'failed') x),
  50000::bigint,
  'a processed refund still reserves its amount'
);

-- retry_of must belong to the SAME payment (composite FK)
insert into public.refunds (id, payment_id, amount_paise, idempotency_key, reason_code, state)
values ('d7000000-0000-0000-0000-000000000014', 'd6000000-0000-0000-0000-000000000006',
        100, 'rfd_xpay_0000001', 'amount_mismatch', 'failed');

select throws_ok(
  $$ insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code, retry_of)
     values ('d6000000-0000-0000-0000-000000000003', 100, 'rfd_xpay_0000002', 'amount_mismatch',
             'd7000000-0000-0000-0000-000000000014') $$,
  '23503', NULL,
  'M3: a refund cannot retry a failed refund that belongs to a different payment'
);

-- ---- H2: idempotent replay of a stored refund request ----------
insert into public.payments
  (id, provider_payment_id, provider_order_id, provider_status, amount_paise)
values ('d6000000-0000-0000-0000-000000000014', 'pay_replay_1', 'order_replay_1', 'captured', 50000);

insert into public.refunds (id, payment_id, amount_paise, idempotency_key, reason_code)
values ('d7000000-0000-0000-0000-000000000015', 'd6000000-0000-0000-0000-000000000014',
        50000, 'rfd_replay_000001', 'duplicate_capture');

select lives_ok(
  $$ insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code)
     values ('d6000000-0000-0000-0000-000000000014', 50000, 'rfd_replay_000001', 'duplicate_capture')
     on conflict (idempotency_key) do nothing $$,
  'H2: replaying a request that consumed the whole cap with ON CONFLICT DO NOTHING is not UB003'
);
select is(
  (select count(*)::integer || '/' || sum(amount_paise)::text || '/' || min(state::text)
   from public.refunds where payment_id = 'd6000000-0000-0000-0000-000000000014'),
  '1/50000/requested',
  'H2: the replay created no row and left the reservation and the stored row unchanged'
);
select throws_ok(
  $$ insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code)
     values ('d6000000-0000-0000-0000-000000000014', 50000, 'rfd_replay_000001', 'duplicate_capture') $$,
  '23505', NULL,
  'H2: a plain INSERT of a stored key is still a unique violation (no silent success)'
);
select throws_like(
  $$ insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code)
     values ('d6000000-0000-0000-0000-000000000014', 100, 'rfd_replay_000001', 'duplicate_capture')
     on conflict (idempotency_key) do nothing $$,
  '%different refund request%',
  'H2: the same key with a different amount is an error even under DO NOTHING'
);
select throws_like(
  $$ insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code)
     values ('d6000000-0000-0000-0000-000000000006', 50000, 'rfd_replay_000001', 'duplicate_capture')
     on conflict (idempotency_key) do nothing $$,
  '%different refund request%',
  'H2: the same key for a different payment is an error even under DO NOTHING'
);
select is(
  (select count(*)::integer from public.refunds where idempotency_key = 'rfd_replay_000001')
  || '/' ||
  (select amount_paise::text from public.refunds where idempotency_key = 'rfd_replay_000001')
  || '/' ||
  (select count(*)::integer from public.refunds
   where payment_id = 'd6000000-0000-0000-0000-000000000006'
     and idempotency_key = 'rfd_replay_000001'),
  '1/50000/0',
  'H2: conflicting presentations created no second refund and did not mutate the original'
);
select throws_ok(
  $$ insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code)
     values ('d6000000-0000-0000-0000-000000000014', 100, 'rfd_replay_000001', 'duplicate_capture')
     on conflict (idempotency_key) do update set amount_paise = excluded.amount_paise $$,
  '23505', NULL,
  'H2: DO UPDATE cannot be used to change the stored amount'
);
select lives_ok(
  $$ insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code)
     values ('d6000000-0000-0000-0000-000000000014', 50000, 'rfd_replay_000001', 'duplicate_capture')
     on conflict (idempotency_key) do update set failure_reason = 'replayed' $$,
  'H2: an identical replay with DO UPDATE reaches the UPDATE guard and may touch mutable fields'
);
select is(
  (select amount_paise::text || '/' || payment_id::text
   from public.refunds where idempotency_key = 'rfd_replay_000001'),
  '50000/d6000000-0000-0000-0000-000000000014',
  'H2: the immutable fields of the stored refund are unchanged'
);

-- the payment moves on (fully refunded at the provider): a replay of the
-- stored request is still a no-op, not a status-guard failure
update public.payments
set provider_status = 'refunded', provider_amount_refunded_paise = 50000
where provider_payment_id = 'pay_replay_1';

select lives_ok(
  $$ insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code)
     values ('d6000000-0000-0000-0000-000000000014', 50000, 'rfd_replay_000001', 'duplicate_capture')
     on conflict (idempotency_key) do nothing $$,
  'H2: a replay after the payment changed state is still a no-op'
);

-- a retry replays too (its amount is already reserved by the stored row)
select lives_ok(
  $$ insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code, retry_of)
     values ('d6000000-0000-0000-0000-000000000001', 20000, 'rfd_schema_000008', 'amount_mismatch',
             'd7000000-0000-0000-0000-000000000002')
     on conflict (idempotency_key) do nothing $$,
  'H2: replaying a stored retry request is a no-op'
);
select is(
  (select count(*)::integer from public.refunds where retry_of = 'd7000000-0000-0000-0000-000000000002'),
  1,
  'H2: exactly one retry of the failed refund exists'
);

-- reservations: a multi-row INSERT sees its own earlier rows
select throws_ok(
  $$ insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code)
     values ('d6000000-0000-0000-0000-000000000006', 30000, 'rfd_multi_00000a', 'duplicate_capture'),
            ('d6000000-0000-0000-0000-000000000006', 30000, 'rfd_multi_00000b', 'duplicate_capture') $$,
  'UB003', NULL,
  'two rows in one INSERT cannot together exceed the payment amount'
);
select is(
  (select count(*)::integer from public.refunds
   where idempotency_key like 'rfd_multi_00000%'),
  0,
  'the rejected multi-row INSERT left no refund behind'
);

-- refunds need a captured payment
select lives_ok(
  $$ insert into public.payments
       (id, provider_payment_id, provider_order_id, provider_status, amount_paise)
     values ('d6000000-0000-0000-0000-000000000007', 'pay_authorized_1', 'order_auth_1',
             'authorized', 50000) $$,
  'fixture: an authorized (uncaptured) payment'
);
select throws_ok(
  $$ insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code)
     values ('d6000000-0000-0000-0000-000000000007', 100, 'rfd_auth_0000001', 'duplicate_capture') $$,
  '23514', NULL,
  'a refund cannot be recorded for an uncaptured payment'
);
select throws_ok(
  $$ insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code)
     values ('d6000000-0000-0000-0000-0000000000ff', 100, 'rfd_nopay_000001', 'duplicate_capture') $$,
  '23503', NULL,
  'a refund must reference an existing payment'
);

-- ============================================================
-- F. payment_events and reconciliation_runs
-- ============================================================

select lives_ok(
  $$ insert into public.payment_events
       (provider_event_id, source, event_type, provider_payment_id, provider_order_id, payload)
     values ('evt_schema_1', 'webhook', 'payment.captured', 'pay_b01', 'order_schema_1', '{"k":1}') $$,
  'an event can be stored with correlation fields'
);
select throws_ok(
  $$ insert into public.payment_events (provider_event_id, source, event_type, payload)
     values ('evt_schema_1', 'webhook', 'payment.captured', '{}') $$,
  '23505', NULL,
  'a provider event id is stored once'
);
select throws_ok(
  $$ insert into public.payment_events (provider_event_id, source, event_type, payload)
     values ('evt_schema_2', 'browser', 'payment.captured', '{}') $$,
  '23514', NULL,
  'an event source must be webhook, verify or reconcile'
);
select ok(
  exists (select 1 from pg_indexes
          where schemaname = 'public' and tablename = 'payment_events'
            and indexdef like '%provider_payment_id%')
  and exists (select 1 from pg_indexes
              where schemaname = 'public' and tablename = 'payment_events'
                and indexdef like '%provider_order_id%'),
  'payment_events indexes both correlation fields'
);

select lives_ok(
  $$ insert into public.reconciliation_runs (kind, window_from, window_to)
     values ('payments', now() - interval '1 hour', now()) $$,
  'a reconciliation run is recorded'
);
select throws_ok(
  $$ insert into public.reconciliation_runs (kind, window_from, window_to)
     values ('payments', now(), now() - interval '1 hour') $$,
  '23514', NULL,
  'a reconciliation window must not be inverted'
);
select throws_ok(
  $$ insert into public.reconciliation_runs (kind, window_from, window_to, status)
     values ('orders', now() - interval '1 hour', now(), 'succeeded') $$,
  '23514', NULL,
  'a finished run must have a finished_at'
);

-- ============================================================
-- G. Row Level Security: who can read what
-- ============================================================
--
-- Fixture for visibility (as the owner of the tables):
--   b09: fulfilled by pay_b09 (captured)         + refund r_b09
--   b10: pay_b10 attached but NOT fulfilling     + refund r_b10
--   pay_unmatched_1 (unmatched)                  + refund r_unm (already created above, id ...01)

reset role;

insert into public.payment_attempts (id, booking_id, amount_paise, provider_order_id, state)
values
  ('d5000000-0000-0000-0000-000000000009', 'd4000000-0000-0000-0000-000000000009', 50000, 'order_b09', 'open'),
  ('d5000000-0000-0000-0000-000000000010', 'd4000000-0000-0000-0000-000000000010', 50000, 'order_b10', 'open');

insert into public.payments
  (id, attempt_id, booking_id, provider_payment_id, provider_order_id, provider_status, amount_paise)
values
  ('d6000000-0000-0000-0000-000000000009', 'd5000000-0000-0000-0000-000000000009',
   'd4000000-0000-0000-0000-000000000009', 'pay_b09', 'order_b09', 'captured', 50000),
  ('d6000000-0000-0000-0000-000000000010', 'd5000000-0000-0000-0000-000000000010',
   'd4000000-0000-0000-0000-000000000010', 'pay_b10', 'order_b10', 'captured', 50000);

update public.bookings
set status = 'confirmed', payment_status = 'paid', confirmed_at = now(),
    fulfilled_by_payment_id = 'd6000000-0000-0000-0000-000000000009'
where id = 'd4000000-0000-0000-0000-000000000009';

insert into public.refunds (id, payment_id, amount_paise, idempotency_key, reason_code)
values
  ('d7000000-0000-0000-0000-000000000009', 'd6000000-0000-0000-0000-000000000009', 1000, 'rfd_vis_b09_0001', 'customer_cancel'),
  ('d7000000-0000-0000-0000-000000000010', 'd6000000-0000-0000-0000-000000000010', 1000, 'rfd_vis_b10_0001', 'duplicate_capture');

-- the customer (user 1)
select pg_temp.act_as('1');

select is(
  (select count(*)::integer from public.payments
   where id in ('d6000000-0000-0000-0000-000000000009',
                'd6000000-0000-0000-0000-000000000010',
                'd6000000-0000-0000-0000-000000000001')),
  2,
  'a customer sees the payments of their own bookings but not an unmatched payment'
);
select is(
  (select count(*)::integer from public.payment_attempts
   where id in ('d5000000-0000-0000-0000-000000000009',
                'd5000000-0000-0000-0000-000000000010')),
  2,
  'a customer sees the payment attempts of their own bookings'
);
select is(
  (select count(*)::integer from public.refunds
   where id in ('d7000000-0000-0000-0000-000000000009',
                'd7000000-0000-0000-0000-000000000010',
                'd7000000-0000-0000-0000-000000000001')),
  2,
  'a customer sees refunds of their own payments but not those of an unmatched payment'
);

-- the facility owner (user 3)
select pg_temp.act_as('3');

select is(
  (select string_agg(provider_payment_id, ',' order by provider_payment_id) from public.payments
   where id in ('d6000000-0000-0000-0000-000000000009',
                'd6000000-0000-0000-0000-000000000010',
                'd6000000-0000-0000-0000-000000000001')),
  'pay_b09',
  'an owner sees only the payment that fulfilled one of their bookings'
);
select is(
  (select count(*)::integer from public.payment_attempts
   where id in ('d5000000-0000-0000-0000-000000000009',
                'd5000000-0000-0000-0000-000000000010')),
  0,
  'an owner does not see payment attempts'
);
select is(
  (select string_agg(id::text, ',') from public.refunds
   where id in ('d7000000-0000-0000-0000-000000000009',
                'd7000000-0000-0000-0000-000000000010',
                'd7000000-0000-0000-0000-000000000001')),
  'd7000000-0000-0000-0000-000000000009',
  'an owner sees only refunds of the fulfilling payment'
);

-- another customer (user 2) and another owner (user 4)
select pg_temp.act_as('2');
select is(
  (select count(*)::integer from public.payments)
  + (select count(*)::integer from public.payment_attempts)
  + (select count(*)::integer from public.refunds),
  0,
  'an unrelated customer sees no payment data'
);

select pg_temp.act_as('4');
select is(
  (select count(*)::integer from public.payments)
  + (select count(*)::integer from public.payment_attempts)
  + (select count(*)::integer from public.refunds),
  0,
  'an unrelated owner sees no payment data'
);

-- the administrator (user 5)
select pg_temp.act_as('5');
select is(
  (select count(*)::integer from public.payments
   where id in ('d6000000-0000-0000-0000-000000000009',
                'd6000000-0000-0000-0000-000000000010',
                'd6000000-0000-0000-0000-000000000001')),
  3,
  'an administrator sees unmatched and unfulfilled payments too'
);

-- ============================================================
-- H. Client privileges on the new tables
-- ============================================================

select pg_temp.act_as('1');

select throws_ok(
  $$ insert into public.payment_attempts (booking_id, amount_paise)
     values ('d4000000-0000-0000-0000-000000000005', 1) $$,
  '42501', NULL,
  'a client cannot insert payment attempts'
);
select throws_ok(
  $$ update public.payment_attempts set state = 'closed' $$,
  '42501', NULL,
  'a client cannot update payment attempts'
);
select throws_ok(
  $$ select count(*) from public.payment_events $$,
  '42501', NULL,
  'a client cannot read payment_events'
);
select throws_ok(
  $$ select count(*) from public.reconciliation_runs $$,
  '42501', NULL,
  'a client cannot read reconciliation_runs'
);
select throws_ok(
  $$ truncate public.payment_attempts $$,
  '42501', NULL,
  'a client cannot truncate payment_attempts'
);
select throws_ok(
  $$ update public.bookings set fulfilled_by_payment_id = NULL, status = 'confirmed'
     where id = 'd4000000-0000-0000-0000-000000000005' $$,
  '42501', NULL,
  'a client still cannot write bookings, including the fulfilment pointer'
);

reset role;

select * from finish();

rollback;
