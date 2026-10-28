begin;

select plan(40);

-- ============================================================
-- Payment window (20261020190000): an order is created, re-used or
-- handed out only while the hold is valid with >= 180 s left, and a
-- hold that ends while the provider call is in flight closes the
-- attempt (order recorded, not handed out).
--
-- Single transaction, rolled back. The races with the expiry sweep
-- are in payment_settlement_concurrency_test.sql (S8-S10).
-- Ids use the f8 / f9 prefixes.
-- ============================================================

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
values ('f8000000-0000-0000-0000-000000000001', 'pay-window-1@example.com', '', now(), '{}');

insert into public.facilities (id, owner_id, name, sport, address, city, status, base_price)
values ('f8100000-0000-0000-0000-000000000001', 'f8000000-0000-0000-0000-000000000001',
        'Window Arena', 'Badminton', '1 Window Road', 'Windowville', 'active', 500);

insert into public.facility_slots (id, facility_id, start_time, end_time, duration_min, base_price)
values ('f8200000-0000-0000-0000-000000000001', 'f8100000-0000-0000-0000-000000000001',
        '06:00', '07:00', 60, 500);

-- W1 normal, W2 expired by clock, W3 expired by status, W4 too short,
-- W5 confirmed, W6 expires (clock) in flight, W7 expires (status) in
-- flight, W8 re-use with a short hold, W9 already recorded then
-- expired, W10 cancelled in flight, W11 ambiguous creation
insert into public.bookings
  (id, user_id, facility_id, slot_id, booking_date, start_time, end_time,
   amount, status, payment_status, expires_at)
select ('f8400000-0000-0000-0000-0000000000' || lpad(w.n::text, 2, '0'))::uuid,
       'f8000000-0000-0000-0000-000000000001',
       'f8100000-0000-0000-0000-000000000001', 'f8200000-0000-0000-0000-000000000001',
       current_date + w.n, '06:00', '07:00', 500,
       w.status::public.booking_status, w.pstatus::public.payment_status,
       case when w.status = 'pending_payment' then now() + w.ttl end
from (values
  (1,  'pending_payment', 'pending', interval '1 hour'),
  (2,  'pending_payment', 'pending', interval '-1 minute'),
  (3,  'expired',         'pending', interval '1 hour'),
  (4,  'pending_payment', 'pending', interval '120 seconds'),
  (5,  'confirmed',       'paid',    interval '1 hour'),
  (6,  'pending_payment', 'pending', interval '1 hour'),
  (7,  'pending_payment', 'pending', interval '1 hour'),
  (8,  'pending_payment', 'pending', interval '1 hour'),
  (9,  'pending_payment', 'pending', interval '1 hour'),
  (10, 'pending_payment', 'pending', interval '1 hour'),
  (11, 'pending_payment', 'pending', interval '1 hour')
) as w(n, status, pstatus, ttl);

create function pg_temp.bk(n integer) returns uuid language sql as $$
  select ('f8400000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid
$$;

create function pg_temp.prep(n integer) returns jsonb language sql as $$
  select public.payment_prepare_attempt(pg_temp.bk(n), 'f8000000-0000-0000-0000-000000000001')
$$;

create function pg_temp.rec(p jsonb, p_order text) returns jsonb language sql as $$
  select public.payment_record_order((p->>'attempt_id')::uuid, p_order,
    (p->>'amount_paise')::bigint, p->>'currency', p->>'receipt')
$$;

create function pg_temp.attempt_of(n integer) returns text language sql as $$
  select string_agg(state::text || '/' || coalesce(provider_order_id, 'no-order') || '/'
                    || coalesce(closed_reason, '-'), ',' order by created_at)
  from public.payment_attempts where booking_id = pg_temp.bk(n)
$$;

-- ============================================================
-- A, B: not payable when the request begins
-- ============================================================

select is(pg_temp.prep(2)->>'action' || ':' || (pg_temp.prep(2)->>'reason'), 'not_payable:hold_expired',
  'A/B: a pending hold past its expiry is not payable (hold_expired)');
select is(pg_temp.prep(3)->>'action' || ':' || (pg_temp.prep(3)->>'reason'), 'not_payable:hold_expired',
  'A/B: an expired booking is not payable (hold_expired)');
select is(pg_temp.prep(5)->>'action' || ':' || (pg_temp.prep(5)->>'reason'), 'not_payable:booking_not_pending',
  'a confirmed booking is not payable (booking_not_pending)');
select is(pg_temp.prep(4)->>'action' || ':' || (pg_temp.prep(4)->>'reason'), 'not_payable:hold_too_short',
  'policy 2: less than 180 s of hold left refuses to start (hold_too_short)');
select ok((pg_temp.prep(4)->>'hold_seconds_remaining')::integer between 1 and 120,
  'and reports the seconds remaining');
select is(
  (select count(*)::integer from public.payment_attempts
   where booking_id in (pg_temp.bk(2), pg_temp.bk(3), pg_temp.bk(4), pg_temp.bk(5))),
  0,
  'no attempt was created for any refused request'
);

-- ============================================================
-- E: normal create and re-use
-- ============================================================

create temp table w1 on commit drop as select pg_temp.prep(1) as p;
select is((select p->>'action' from w1), 'create', 'E: a booking with a valid hold creates an attempt');
select is((select pg_temp.rec(p, 'order_W1')->>'outcome' from w1), 'recorded', 'E: and records its order');
select ok((select (p->>'hold_seconds_remaining')::integer between 3500 and 3600 from w1),
  'create reports the remaining hold in seconds (database clock)');
select ok((pg_temp.prep(1)->>'hold_seconds_remaining')::integer between 3500 and 3600,
  're-use reports it too');
select is(pg_temp.prep(1)->>'action', 'reuse', 'E: a retry re-uses it');
select is(pg_temp.prep(1)->>'provider_order_id', 'order_W1', 'E: with the same order');
select is((select pg_temp.rec(p, 'order_W1')->>'outcome' from w1), 'already_recorded',
  'E: recording the same order again on a payable booking is idempotent');

-- re-use is refused once the hold is too short (policy 2 applies to
-- every path that hands an order out); the attempt is left open
do $$ begin perform pg_temp.rec(pg_temp.prep(8), 'order_W8'); end $$;
update public.bookings set expires_at = now() + interval '60 seconds' where id = pg_temp.bk(8);
select is(pg_temp.prep(8)->>'action' || ':' || (pg_temp.prep(8)->>'reason'), 'not_payable:hold_too_short',
  'an open order is not re-used when the hold is too short');
select is(pg_temp.attempt_of(8), 'open/order_W8/-', 'and the attempt is left as it was');

-- ============================================================
-- C, D: the hold ends while the provider call is in flight
-- ============================================================

create temp table w6 on commit drop as select pg_temp.prep(6) as p;
select is((select p->>'action' from w6), 'create', 'C: the request starts with a valid hold');
update public.bookings set expires_at = now() - interval '1 second' where id = pg_temp.bk(6);
create temp table w6r on commit drop as select pg_temp.rec(p, 'order_W6') as r from w6;
select is((select r->>'outcome' from w6r), 'booking_not_payable',
  'C/D: recording after the hold ended is refused as not payable');
select is((select r->>'reason' from w6r), 'hold_expired', 'C/D: with the reason hold_expired');
select is(pg_temp.attempt_of(6), 'closed/order_W6/booking_not_payable',
  'D: the provider order is recorded durably and the attempt closed (not discarded, not a provider failure)');
select is(pg_temp.prep(6)->>'reason', 'hold_expired', 'D: a retry gets no order');
select is((select count(*)::integer from public.payment_attempts where booking_id = pg_temp.bk(6)), 1,
  'D: and no second attempt or order is created');

-- G: a payment on that order is matched and is a late capture
create temp table w6p on commit drop as
select public.payment_apply_observation(null, 'pay_W6LATE', 'order_W6', 'captured', 50000, 'INR', 0,
  now(), null, null) as r;
select is((select r->>'matched' from w6p), 'true', 'G: a capture on the recorded order is matched (not unmatched)');
select is((select r->>'settlement' from w6p), 'late_capture', 'G: and is a late capture');
select is(
  (select status::text || '/' || coalesce(fulfilled_by_payment_id::text, 'null') from public.bookings
   where id = pg_temp.bk(6)),
  'pending_payment/null',
  'G: the expired booking is not fulfilled'
);
select ok((select decision_recorded_at is not null from public.payments where provider_payment_id = 'pay_W6LATE'),
  'G: the late capture is durably decided (refund required later)');

-- expiry by status (the sweep) while in flight
create temp table w7 on commit drop as select pg_temp.prep(7) as p;
update public.bookings set status = 'expired' where id = pg_temp.bk(7);
select is((select pg_temp.rec(p, 'order_W7')->>'reason' from w7), 'hold_expired',
  'C: a booking expired by the sweep while in flight is not payable');
select is(pg_temp.attempt_of(7), 'closed/order_W7/booking_not_payable', 'C: order recorded, attempt closed');

-- cancelled while in flight
create temp table w10 on commit drop as select pg_temp.prep(10) as p;
update public.bookings set status = 'cancelled', cancelled_at = now() where id = pg_temp.bk(10);
select is((select pg_temp.rec(p, 'order_W10')->>'reason' from w10), 'booking_not_pending',
  'a booking cancelled while in flight is not payable (booking_not_pending)');

-- a retried record on an order recorded earlier, after the hold ended
create temp table w9 on commit drop as select pg_temp.prep(9) as p;
select is((select pg_temp.rec(p, 'order_W9')->>'outcome' from w9), 'recorded', 'fixture: an open order');
update public.bookings set expires_at = now() - interval '1 second' where id = pg_temp.bk(9);
select is((select pg_temp.rec(p, 'order_W9')->>'outcome' from w9), 'booking_not_payable',
  'a retried record of an already-recorded order is not handed out after the hold ended');
select is(pg_temp.attempt_of(9), 'closed/order_W9/booking_not_payable', 'and closes the attempt, keeping its order');

-- write-once and conflicts still apply on an unpayable booking
select is((select pg_temp.rec(p, 'order_W9other')->>'outcome' from w9), 'conflict',
  'the order id stays write-once on a closed attempt');

-- ============================================================
-- F: an ambiguous creation stays recoverable
-- ============================================================

create temp table w11 on commit drop as select pg_temp.prep(11) as p;
update public.payment_attempts set order_lease_until = now() - interval '1 second'
where id = (select (p->>'attempt_id')::uuid from w11);
create temp table w11r on commit drop as select pg_temp.prep(11) as p;
select is((select p->>'action' from w11r), 'recover', 'F: with enough hold left the creating attempt is recovered');
select ok((select (p->>'hold_seconds_remaining')::integer between 3500 and 3600 from w11r),
  'recover reports the remaining hold too');
update public.payment_attempts set order_lease_until = now() - interval '1 second'
where id = (select (p->>'attempt_id')::uuid from w11);
update public.bookings set expires_at = now() + interval '90 seconds' where id = pg_temp.bk(11);
select is(pg_temp.prep(11)->>'reason', 'hold_too_short', 'F: with too little hold left nothing is started');
select is(pg_temp.attempt_of(11), 'creating/no-order/-',
  'F: the ambiguous attempt is NOT closed or marked failed: it stays recoverable');

-- ============================================================
-- H: grants and locking unchanged
-- ============================================================

select ok(
  has_function_privilege('service_role', 'public.payment_prepare_attempt(uuid,uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.payment_record_order(uuid,text,bigint,text,text)', 'EXECUTE'),
  'H: service_role still executes both functions'
);
select ok(
  not has_function_privilege('anon', 'public.payment_prepare_attempt(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.payment_prepare_attempt(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.payment_record_order(uuid,text,bigint,text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.payment_record_order(uuid,text,bigint,text,text)', 'EXECUTE'),
  'H: clients still cannot execute either function'
);
select is(
  (select count(*)::integer from pg_proc
   where oid in ('public.payment_prepare_attempt(uuid,uuid)'::regprocedure,
                 'public.payment_record_order(uuid,text,bigint,text,text)'::regprocedure)
     and prosecdef and proconfig @> array['search_path=""']),
  2,
  'H: both remain SECURITY DEFINER with an empty search_path'
);
select ok(
  pg_get_functiondef('public.payment_record_order(uuid,text,bigint,text,text)'::regprocedure)
    ~ 'FROM public\.bookings b\s+WHERE b\.id = v_booking_id\s+FOR UPDATE',
  'H: recording locks the booking row (booking -> attempt order); the race itself is S8 in the concurrency suite'
);

select * from finish();

rollback;
