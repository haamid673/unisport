begin;

select plan(30);

-- ============================================================
-- Checkout lease (20261023190000): an order is handed out for
-- Checkout only under a lease on its attempt; one session at a time;
-- an ended lease never means "no payment"; the holding session is
-- re-admitted only after the caller verified no payment exists.
--
-- Single transaction, rolled back. The concurrent acquisition race is
-- S12 in payment_settlement_concurrency_test.sql. Ids use the fb
-- prefix.
-- ============================================================

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
values ('fb000000-0000-0000-0000-000000000001', 'pay-lease-1@example.com', '', now(), '{}'),
       ('fb000000-0000-0000-0000-000000000002', 'pay-lease-2@example.com', '', now(), '{}');

insert into public.facilities (id, owner_id, name, sport, address, city, status, base_price)
values ('fb100000-0000-0000-0000-000000000001', 'fb000000-0000-0000-0000-000000000001',
        'Lease Arena', 'Badminton', '1 Lease Road', 'Leaseville', 'active', 500);

insert into public.facility_slots (id, facility_id, start_time, end_time, duration_min, base_price)
values ('fb200000-0000-0000-0000-000000000001', 'fb100000-0000-0000-0000-000000000001',
        '06:00', '07:00', 60, 500);

-- L1 main, L2 ended lease, L3 too short, L4 expired in between,
-- L5 closed attempt, L6 fulfilled, L7 held by nobody (pre-lease order)
insert into public.bookings
  (id, user_id, facility_id, slot_id, booking_date, start_time, end_time,
   amount, status, payment_status, expires_at)
select ('fb400000-0000-0000-0000-00000000000' || n)::uuid,
       'fb000000-0000-0000-0000-000000000001',
       'fb100000-0000-0000-0000-000000000001', 'fb200000-0000-0000-0000-000000000001',
       current_date + 50 + n, '06:00', '07:00', 500, 'pending_payment', 'pending',
       now() + interval '1 hour'
from generate_series(1, 7) n;

create function pg_temp.bk(n integer) returns uuid language sql as $$
  select ('fb400000-0000-0000-0000-00000000000' || n)::uuid
$$;

-- open attempt with order order_FB<n>; returns the attempt id
create function pg_temp.open_attempt(n integer) returns uuid language plpgsql as $$
declare
  v jsonb;
begin
  v := public.payment_prepare_attempt(pg_temp.bk(n), 'fb000000-0000-0000-0000-000000000001');
  perform public.payment_record_order((v->>'attempt_id')::uuid, 'order_FB' || n,
    (v->>'amount_paise')::bigint, v->>'currency', v->>'receipt');
  return (v->>'attempt_id')::uuid;
end;
$$;

create temp table att on commit drop as
select n, pg_temp.open_attempt(n) as id from generate_series(1, 7) n;

create function pg_temp.att(n integer) returns uuid language sql as $$
  select id from att where att.n = $1
$$;

create function pg_temp.lease(n integer, s text, verified boolean default false,
                              u text default 'fb000000-0000-0000-0000-000000000001')
returns jsonb language sql as $$
  select public.payment_acquire_checkout_lease(pg_temp.bk(n), u::uuid, pg_temp.att(n), s, verified)
$$;

\set s1 '''aaaaaaaa-0000-4000-8000-000000000001'''
\set s2 '''bbbbbbbb-0000-4000-8000-000000000002'''

-- ------------------------------------------------------------
-- privileges
-- ------------------------------------------------------------

select ok(
  has_function_privilege('service_role', 'public.payment_acquire_checkout_lease(uuid,uuid,uuid,text,boolean)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.payment_acquire_checkout_lease(uuid,uuid,uuid,text,boolean)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.payment_acquire_checkout_lease(uuid,uuid,uuid,text,boolean)', 'EXECUTE'),
  'only service_role can acquire a Checkout lease'
);
select ok(
  (select prosecdef and proconfig @> array['search_path=""']
   from pg_proc where oid = 'public.payment_acquire_checkout_lease(uuid,uuid,uuid,text,boolean)'::regprocedure),
  'it is SECURITY DEFINER with an empty search_path'
);

-- ------------------------------------------------------------
-- never leased -> granted
-- ------------------------------------------------------------

select is((select checkout_lease_until from public.payment_attempts where id = pg_temp.att(1)), null,
  'a newly recorded order has never been leased');

create temp table g1 on commit drop as select pg_temp.lease(1, :s1) as r;
select is((select r->>'outcome' || ':' || (r->>'resumed') from g1), 'granted:false',
  'the first session is granted the lease');
select is((select r->>'provider_order_id' from g1), 'order_FB1', 'with the attempt''s order');
select ok((select (r->>'hold_seconds_remaining')::integer between 3500 and 3600 from g1),
  'and the remaining hold, from the database clock');
select is(
  (select checkout_lease_hash from public.payment_attempts where id = pg_temp.att(1)),
  encode(sha256(convert_to('aaaaaaaa-0000-4000-8000-000000000001', 'UTF8')), 'hex'),
  'only the SHA-256 of the session id is stored'
);
select is(
  (select a.checkout_lease_until = b.expires_at
   from public.payment_attempts a join public.bookings b on b.id = a.booking_id
   where a.id = pg_temp.att(1)),
  true,
  'the lease lasts until the hold ends'
);

-- ------------------------------------------------------------
-- active lease
-- ------------------------------------------------------------

select is(pg_temp.lease(1, :s2)->>'outcome', 'held', 'another session is refused while the lease is active');
select ok((pg_temp.lease(1, :s2)->>'retry_after_seconds')::integer between 3500 and 3600,
  'and told how long the lease lasts');
select is(pg_temp.lease(1, :s2, true)->>'outcome', 'held',
  'claiming "no payments verified" does not let another session in');
select is(pg_temp.lease(1, :s1)->>'outcome' || ':' || (pg_temp.lease(1, :s1)->>'provider_order_id'),
  'verify_required:order_FB1',
  'the holding session again must first verify that no payment exists on the order');
select is(pg_temp.lease(1, :s1, true)->>'outcome' || ':' || (pg_temp.lease(1, :s1, true)->>'resumed'),
  'granted:true',
  'after verification the holding session continues (resumed)');
select is(
  (select checkout_lease_hash = encode(sha256(convert_to('aaaaaaaa-0000-4000-8000-000000000001', 'UTF8')), 'hex')
   from public.payment_attempts where id = pg_temp.att(1)),
  true,
  'no request by another session changed the lease holder'
);
select is(pg_temp.lease(1, :s2, false, 'fb000000-0000-0000-0000-000000000002')->>'outcome', 'not_found',
  'another user learns nothing (not_found)');
select is(public.payment_acquire_checkout_lease(pg_temp.bk(1), 'fb000000-0000-0000-0000-000000000001',
            pg_temp.att(2), :s1)->>'outcome', 'not_found',
  'an attempt of another booking is not found');

-- ------------------------------------------------------------
-- ended lease: never re-granted
-- ------------------------------------------------------------

select is(pg_temp.lease(2, :s1)->>'outcome', 'granted', 'L2 is leased');
update public.payment_attempts set checkout_lease_until = now() - interval '1 second' where id = pg_temp.att(2);
select is(
  pg_temp.lease(2, :s1)->>'outcome' || '/' || (pg_temp.lease(2, :s2)->>'outcome') || '/'
  || (pg_temp.lease(2, :s2, true)->>'outcome'),
  'ended/ended/ended',
  'an ended lease is never re-granted, to anyone (it does not mean no payment was made)'
);

-- held by nobody (an order handed out before leases existed)
update public.payment_attempts set checkout_lease_until = now() + interval '10 minutes' where id = pg_temp.att(7);
select is(pg_temp.lease(7, :s1)->>'outcome' || '/' || (pg_temp.lease(7, :s1, true)->>'outcome'), 'held/held',
  'an order already handed out without a lease is held by nobody until it ends');

-- ------------------------------------------------------------
-- booking and attempt state
-- ------------------------------------------------------------

update public.bookings set expires_at = now() + interval '100 seconds' where id = pg_temp.bk(3);
select is(pg_temp.lease(3, :s1)->>'outcome' || ':' || (pg_temp.lease(3, :s1)->>'reason'), 'not_payable:hold_too_short',
  'no lease with less than 120 s of hold left');
select is((select checkout_lease_until from public.payment_attempts where id = pg_temp.att(3)), null,
  'and the attempt stays unleased');

update public.bookings set expires_at = now() - interval '1 second' where id = pg_temp.bk(4);
select is(pg_temp.lease(4, :s1)->>'reason', 'hold_expired', 'no lease after the hold ended');

update public.payment_attempts set state = 'closed', closed_at = now(), closed_reason = 'test' where id = pg_temp.att(5);
select is(pg_temp.lease(5, :s1)->>'outcome', 'attempt_not_open', 'no lease on a closed attempt');

-- fulfilment: confirmed booking, context reports the fulfilling payment
select is(
  public.payment_apply_observation(null, 'pay_FB6', 'order_FB6', 'captured', 50000, 'INR', 0, now(), null, null)->>'settlement',
  'fulfilled', 'L6 is fulfilled by pay_FB6');
select is(pg_temp.lease(6, :s1)->>'reason', 'booking_not_pending', 'no lease on a fulfilled booking');
select is(
  public.payment_booking_payment_context(pg_temp.bk(6), 'fb000000-0000-0000-0000-000000000001')->'fulfilling_payment',
  '{"provider_payment_id": "pay_FB6", "provider_order_id": "order_FB6"}'::jsonb,
  'the payment context reports the fulfilling payment and its order'
);
select is(
  public.payment_booking_payment_context(pg_temp.bk(1), 'fb000000-0000-0000-0000-000000000001')->'fulfilling_payment',
  'null'::jsonb,
  'and null for an unfulfilled booking'
);

-- ------------------------------------------------------------
-- input and integrity
-- ------------------------------------------------------------

select throws_ok(
  $$ select pg_temp.lease(1, 'AAAAAAAA-0000-4000-8000-000000000001') $$,
  '22023', null, 'an upper-case session id is refused (the server normalises before calling)');
select throws_ok($$ select pg_temp.lease(1, 'not-a-uuid') $$, '22023', null, 'a malformed session id is refused');
select throws_ok(
  $$ update public.payment_attempts set checkout_lease_hash = 'aaaa' where id = pg_temp.att(1) $$,
  '23514', null, 'a lease hash must be a SHA-256 hex digest');

select * from finish();

rollback;
