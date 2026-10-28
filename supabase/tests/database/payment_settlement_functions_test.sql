begin;

select plan(93);

-- ============================================================
-- Payment slice 1b (20261019190000): order-creation, observation
-- and settlement functions
--
-- Single transaction, rolled back. Concurrency (expiry/closure races,
-- lock order, isolation) is in payment_settlement_concurrency_test.sql.
-- Ids use the f1.. f7 prefixes.
-- ============================================================

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
select ('f1000000-0000-0000-0000-00000000000' || n)::uuid,
       'pay-settle-' || n || '@example.com', '', now(), '{}'::jsonb
from generate_series(1, 3) n;

insert into public.facilities (id, owner_id, name, sport, address, city, status, base_price)
values ('f2000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000003',
        'Settlement Arena', 'Badminton', '1 Settle Road', 'Settleville', 'active', 500);

insert into public.facility_slots (id, facility_id, start_time, end_time, duration_min, base_price)
values ('f3000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001',
        '06:00', '07:00', 60, 500);

-- B1 main flow, B2 clock-expired late capture, B3 closed-attempt late
-- capture, B4 legacy confirmed, B5 free, B6 refund obligation,
-- B7 close/recreate, B8 expired status, B9 amount mismatch,
-- B10 pending but past expires_at, B11 status-expired late capture,
-- B12 payment seen before its order was recorded
insert into public.bookings
  (id, user_id, facility_id, slot_id, booking_date, start_time, end_time,
   amount, status, payment_status, expires_at)
select ('f4000000-0000-0000-0000-0000000000' || lpad(b.n::text, 2, '0'))::uuid,
       'f1000000-0000-0000-0000-000000000001',
       'f2000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000001',
       current_date + b.n, '06:00', '07:00', b.amount,
       b.status::public.booking_status, b.pstatus::public.payment_status,
       case when b.status = 'pending_payment' then now() + b.ttl end
from (values
  (1,  500.00, 'pending_payment', 'pending', interval '1 hour'),
  (2,  500.00, 'pending_payment', 'pending', interval '1 hour'),
  (3,  500.00, 'pending_payment', 'pending', interval '1 hour'),
  (4,  500.00, 'confirmed',       'paid',    interval '1 hour'),
  (5,    0.00, 'pending_payment', 'pending', interval '1 hour'),
  (6,  500.00, 'pending_payment', 'pending', interval '1 hour'),
  (7,  500.00, 'pending_payment', 'pending', interval '1 hour'),
  (8,  500.00, 'expired',         'pending', interval '1 hour'),
  (9,  500.00, 'pending_payment', 'pending', interval '1 hour'),
  (10, 500.00, 'pending_payment', 'pending', interval '-1 minute'),
  (11, 500.00, 'pending_payment', 'pending', interval '1 hour'),
  (12, 500.00, 'pending_payment', 'pending', interval '1 hour')
) as b(n, amount, status, pstatus, ttl);

create function pg_temp.bk(n integer) returns uuid language sql as $$
  select ('f4000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid
$$;

create function pg_temp.prep(n integer, u integer default 1) returns jsonb language sql as $$
  select public.payment_prepare_attempt(pg_temp.bk(n), ('f1000000-0000-0000-0000-00000000000' || u)::uuid)
$$;

-- prepare + record a provider order for booking n; returns the attempt id
create function pg_temp.open_attempt(n integer, p_order text) returns uuid language plpgsql as $$
declare
  v jsonb := pg_temp.prep(n);
begin
  perform public.payment_record_order((v->>'attempt_id')::uuid, p_order,
    (v->>'amount_paise')::bigint, v->>'currency', v->>'receipt');
  return (v->>'attempt_id')::uuid;
end;
$$;

create function pg_temp.obs(
  p_pay text, p_order text, p_status text,
  p_amount bigint default 50000, p_refunded bigint default 0,
  p_currency text default 'INR', p_event uuid default null
) returns jsonb language sql as $$
  select public.payment_apply_observation(p_event, p_pay, p_order, p_status, p_amount, p_currency,
    p_refunded, now() - interval '1 minute', null, null)
$$;

-- ============================================================
-- A. Privileges
-- ============================================================

create temp table fn(sig text primary key, svc boolean) on commit drop;
insert into fn values
  ('public.payment_prepare_attempt(uuid,uuid)', true),
  ('public.payment_record_order(uuid,text,bigint,text,text)', true),
  ('public.payment_close_attempt(uuid,text)', true),
  ('public.payment_ingest_event(text,text,text,text,jsonb)', true),
  ('public.payment_mark_event(uuid,text,text)', true),
  ('public.payment_apply_observation(uuid,text,text,text,bigint,text,bigint,timestamptz,text,text)', true),
  ('public.payment_settle_locked(uuid)', false);

select is(
  (select coalesce(string_agg(sig, ', ' order by sig), '') from fn
   where has_function_privilege('anon', sig::regprocedure, 'EXECUTE')
      or has_function_privilege('authenticated', sig::regprocedure, 'EXECUTE')),
  '',
  'no slice 1b function is executable by anon or authenticated'
);
select is(
  (select coalesce(string_agg(sig, ', ' order by sig), '') from fn
   where has_function_privilege('service_role', sig::regprocedure, 'EXECUTE') <> svc),
  '',
  'service_role executes exactly the six entry points, not the internal settlement step'
);
select is(
  (select count(*)::integer from fn f
   join pg_proc p on p.oid = f.sig::regprocedure
   where p.prosecdef and p.proconfig @> array['search_path=""']),
  7,
  'all seven functions are SECURITY DEFINER with an empty search_path'
);

-- ============================================================
-- B. Prepare: ownership and eligibility (server-derived amount)
-- ============================================================

select is(pg_temp.prep(1, 2)->>'action', 'not_found',
  'another user''s booking is reported as not found');
select is(public.payment_prepare_attempt('f4000000-0000-0000-0000-0000000000ff',
            'f1000000-0000-0000-0000-000000000001')->>'action', 'not_found',
  'a missing booking is reported the same way');
select is(pg_temp.prep(5)->>'action', 'free_booking', 'a zero-price booking is never payable');
select is(pg_temp.prep(4)->>'action', 'not_payable', 'a confirmed booking is not payable');
select is(pg_temp.prep(8)->>'action', 'not_payable', 'an expired booking is not payable');
select is(pg_temp.prep(10)->>'action', 'not_payable', 'a pending hold past its expiry is not payable');
select is(
  (select count(*)::integer from public.payment_attempts
   where booking_id in (pg_temp.bk(1), pg_temp.bk(4), pg_temp.bk(5), pg_temp.bk(8), pg_temp.bk(10))),
  0,
  'none of the refused requests created an attempt'
);

create temp table t_b1 on commit drop as select pg_temp.prep(1) as r;

select is((select r->>'action' from t_b1), 'create', 'an eligible booking gets a new attempt');
select is((select (r->>'amount_paise')::bigint from t_b1), 50000::bigint,
  'the amount comes from the booking (500.00 INR = 50000 paise)');
select is((select r->>'currency' from t_b1), 'INR', 'the currency is INR');
select is((select r->>'receipt' from t_b1), (select r->>'attempt_id' from t_b1),
  'the receipt is the attempt id');
select ok(char_length((select r->>'receipt' from t_b1)) <= 40, 'the receipt fits the provider''s 40-character limit');
select is(
  (select state::text || '/' || (order_lease_until > now())::text from public.payment_attempts
   where id = (select (r->>'attempt_id')::uuid from t_b1)),
  'creating/true',
  'the attempt is persisted as creating, with a lease, before any provider call'
);

select is(pg_temp.prep(1)->>'action', 'in_progress',
  'a concurrent request while the lease is held does not get a second creator');
select is(
  (select count(*)::integer from public.payment_attempts where booking_id = pg_temp.bk(1)),
  1,
  'still exactly one attempt'
);

update public.payment_attempts set order_lease_until = now() - interval '1 second'
where id = (select (r->>'attempt_id')::uuid from t_b1);

create temp table t_b1r on commit drop as select pg_temp.prep(1) as r;

select is((select r->>'action' from t_b1r), 'recover',
  'after the lease ran out the attempt must be RECOVERED by receipt, not re-created');
select is((select r->>'attempt_id' from t_b1r), (select r->>'attempt_id' from t_b1),
  'recovery keeps the same attempt (and receipt)');
select ok(
  (select order_lease_until > now() from public.payment_attempts
   where id = (select (r->>'attempt_id')::uuid from t_b1)),
  'the recovering request holds a fresh lease'
);

-- ============================================================
-- C. Record order (write-once, validated)
-- ============================================================

select is(public.payment_record_order((select (r->>'attempt_id')::uuid from t_b1), 'order_B1', 49999, 'INR',
            (select r->>'receipt' from t_b1))->>'outcome', 'mismatch',
  'a provider amount that differs from the attempt is not recorded');
select is(public.payment_record_order((select (r->>'attempt_id')::uuid from t_b1), 'order_B1', 50000, 'USD',
            (select r->>'receipt' from t_b1))->>'outcome', 'mismatch',
  'a provider currency that differs is not recorded');
select is(public.payment_record_order((select (r->>'attempt_id')::uuid from t_b1), 'order_B1', 50000, 'INR',
            'some-other-receipt')->>'outcome', 'mismatch',
  'a provider receipt that differs is not recorded');
select throws_ok(
  $$ select public.payment_record_order((select (r->>'attempt_id')::uuid from t_b1), 'not-an-order', 50000, 'INR', 'x') $$,
  '22023', NULL,
  'a malformed provider order id is rejected'
);
select is(public.payment_record_order((select (r->>'attempt_id')::uuid from t_b1), 'order_B1', 50000, 'INR',
            (select r->>'receipt' from t_b1))->>'outcome', 'recorded',
  'a matching provider order is recorded');
select is(
  (select state::text || '/' || provider_order_id || '/' || coalesce(order_lease_until::text, 'no-lease')
   from public.payment_attempts where id = (select (r->>'attempt_id')::uuid from t_b1)),
  'open/order_B1/no-lease',
  'the attempt is open with its order id and the lease released'
);
select is(public.payment_record_order((select (r->>'attempt_id')::uuid from t_b1), 'order_B1', 50000, 'INR',
            (select r->>'receipt' from t_b1))->>'outcome', 'already_recorded',
  'recording the same order again is an idempotent retry');
select is(public.payment_record_order((select (r->>'attempt_id')::uuid from t_b1), 'order_B1other', 50000, 'INR',
            (select r->>'receipt' from t_b1))->>'outcome', 'conflict',
  'the provider order id is write-once');

select is(pg_temp.prep(1)->>'action', 'reuse', 'a retried checkout reuses the open order');
select is(pg_temp.prep(1)->>'provider_order_id', 'order_B1', 'and returns that order id');
select is(public.payment_close_attempt((select (r->>'attempt_id')::uuid from t_b1), 'order_create_rejected')->>'outcome',
  'not_closable', 'an attempt that has an order cannot be closed as a creation failure');

create temp table t_b7 on commit drop as select pg_temp.prep(7) as r;
select is(public.payment_record_order((select (r->>'attempt_id')::uuid from t_b7), 'order_B1', 50000, 'INR',
            (select r->>'receipt' from t_b7))->>'outcome', 'conflict',
  'an order id already owned by another attempt is a conflict');
select is(public.payment_close_attempt((select (r->>'attempt_id')::uuid from t_b7), 'order_create_rejected')->>'outcome',
  'closed', 'a creating attempt without an order can be closed after a definitive failure');
select isnt(pg_temp.prep(7)->>'attempt_id', (select r->>'attempt_id' from t_b7),
  'after a definitive failure the next request starts a NEW attempt (new receipt)');
select throws_ok(
  $$ select public.payment_close_attempt((select (r->>'attempt_id')::uuid from t_b7), 'Bad Reason!') $$,
  '22023', NULL,
  'the close reason is a bounded code'
);

-- ============================================================
-- D. Observation: unmatched, validation
-- ============================================================

create temp table t_unknown on commit drop as
select pg_temp.obs('pay_UNKNOWN1', 'order_NOTOURS', 'captured') as r;

select is((select r->>'matched' from t_unknown), 'false', 'a payment of an unknown order is stored unmatched');
select is((select r->>'unmatched_reason' from t_unknown), 'unknown_order', 'with the reason');
select is((select r->>'settlement' from t_unknown), 'none', 'and nothing is settled');
select is(
  (select coalesce(booking_id::text, 'null') || '/' || coalesce(attempt_id::text, 'null') || '/'
          || coalesce(decision_recorded_at::text, 'null') || '/' || resolution_attempts::text
   from public.payments where provider_payment_id = 'pay_UNKNOWN1'),
  'null/null/null/1',
  'unmatched: no booking, no attempt, no decision, one resolution attempt counted'
);
select is(
  (select count(*)::integer from public.refunds r
   join public.payments p on p.id = r.payment_id
   where p.provider_payment_id = 'pay_UNKNOWN1'),
  0,
  'an unmatched captured payment is never refunded automatically'
);
select is((pg_temp.obs('pay_NOORDER1', null, 'captured'))->>'unmatched_reason', 'no_order',
  'a payment without an order id is stored unmatched');
select throws_ok($$ select pg_temp.obs('not_a_payment', 'order_B1', 'captured') $$, '22023', NULL,
  'a malformed provider payment id is rejected');
select throws_ok($$ select pg_temp.obs('pay_BAD1', 'order_B1', 'settled') $$, '22023', NULL,
  'an unknown provider status is rejected');
select throws_ok($$ select pg_temp.obs('pay_BAD2', 'order_B1', 'captured', 50000, 50001) $$, '22023', NULL,
  'a refunded amount above the payment amount is rejected');

-- amount that disagrees with the attempt -> unmatched, never forced
do $$ begin perform pg_temp.open_attempt(9, 'order_B9'); end $$;
select is((pg_temp.obs('pay_B9WRONG', 'order_B9', 'captured', 40000))->>'unmatched_reason', 'amount_mismatch',
  'a payment whose amount disagrees with the attempt stays unmatched');
select is((select booking_id::text from public.payments where provider_payment_id = 'pay_B9WRONG'), null,
  'it acquired no booking association');
select is((select status::text from public.bookings where id = pg_temp.bk(9)), 'pending_payment',
  'and the booking is untouched');

-- ============================================================
-- E. Settlement: the happy path, idempotency, merges
-- ============================================================

select is((pg_temp.obs('pay_B1A', 'order_B1', 'authorized'))->>'settlement', 'not_captured',
  'an authorized payment is matched but does not fulfil');
select is(
  (select status::text || '/' || coalesce(fulfilled_by_payment_id::text, 'null')
   from public.bookings where id = pg_temp.bk(1)),
  'pending_payment/null',
  'the booking stays pending after authorization'
);

select is((pg_temp.obs('pay_B1A', 'order_B1', 'captured'))->>'settlement', 'fulfilled',
  'the captured, matched payment fulfils the booking');
select is(
  (select b.status::text || '/' || b.payment_status::text || '/' || (b.confirmed_at is not null)::text
          || '/' || (b.fulfilled_by_payment_id = p.id)::text
   from public.bookings b join public.payments p on p.provider_payment_id = 'pay_B1A'
   where b.id = pg_temp.bk(1)),
  'confirmed/paid/true/true',
  'confirmed, paid, confirmed_at set, pointer to the payment'
);
select is(
  (select count(*)::integer from public.payment_attempts
   where booking_id = pg_temp.bk(1) and state in ('creating', 'open')),
  0,
  'every live attempt of the booking is closed on fulfilment'
);
select is(
  (select closed_reason from public.payment_attempts where provider_order_id = 'order_B1'),
  'fulfilled',
  'with the reason fulfilled'
);
select ok(
  (select decision_recorded_at is not null and captured_observed_at is not null
   from public.payments where provider_payment_id = 'pay_B1A'),
  'the decision and the first capture observation are recorded'
);

select is((pg_temp.obs('pay_B1A', 'order_B1', 'captured'))->>'settlement', 'already_fulfilled',
  'a duplicate observation is idempotent');
select is((pg_temp.obs('pay_B1A', 'order_B1', 'authorized'))->>'observation', 'merged',
  'a stale authorized observation after capture is merged without error');
select is((select provider_status::text from public.payments where provider_payment_id = 'pay_B1A'), 'captured',
  'and does not downgrade the stored status');
select is((pg_temp.obs('pay_B1A', 'order_B1', 'failed'))->>'observation', 'merged',
  'a stale failed observation after capture is merged without error');
select is((select provider_status::text from public.payments where provider_payment_id = 'pay_B1A'), 'captured',
  'and does not downgrade it either');

select is((pg_temp.obs('pay_B1A', 'order_B1', 'captured', 50000, 10000))->>'settlement', 'already_fulfilled',
  'a partial refund observed after fulfilment is recorded');
select is((pg_temp.obs('pay_B1A', 'order_B1', 'captured', 50000, 5000))->>'observation', 'merged',
  'an older, smaller refunded total is merged without error');
select is(
  (select provider_amount_refunded_paise from public.payments where provider_payment_id = 'pay_B1A'),
  10000::bigint,
  'the refunded total only grows'
);
select is((select fulfilled_by_payment_id::text from public.bookings where id = pg_temp.bk(1)),
  (select id::text from public.payments where provider_payment_id = 'pay_B1A'),
  'and the booking stays fulfilled by the payment'
);

-- identity facts are never overwritten by an observation
select is((pg_temp.obs('pay_B1A', 'order_B1', 'captured', 60000))->>'observation', 'identity_conflict',
  'an observation with a different amount is an identity conflict');
select is((select amount_paise from public.payments where provider_payment_id = 'pay_B1A'), 50000::bigint,
  'and the stored amount is unchanged');
select is((pg_temp.obs('pay_B1A', 'order_OTHER', 'captured'))->>'observation', 'order_conflict',
  'an observation with a different order id is an order conflict');
select is((select provider_order_id from public.payments where provider_payment_id = 'pay_B1A'), 'order_B1',
  'and the stored order id is unchanged');

-- a second capture on the same order: recorded, decided, not fulfilling
select is((pg_temp.obs('pay_B1B', 'order_B1', 'captured'))->>'settlement', 'duplicate_capture',
  'a second captured payment for a fulfilled booking is a duplicate capture');
select ok(
  (select decision_recorded_at is not null and attempt_id is not null
   from public.payments where provider_payment_id = 'pay_B1B'),
  'it is matched and its (refund) decision is recorded'
);
select is((select fulfilled_by_payment_id::text from public.bookings where id = pg_temp.bk(1)),
  (select id::text from public.payments where provider_payment_id = 'pay_B1A'),
  'the pointer is unchanged'
);

-- ============================================================
-- F. Late captures (recorded, not fulfilled, not refunded here)
-- ============================================================

-- hold expired by the clock (not yet swept)
do $$ begin perform pg_temp.open_attempt(2, 'order_B2'); end $$;
update public.bookings set expires_at = now() - interval '1 second' where id = pg_temp.bk(2);
select is((pg_temp.obs('pay_B2', 'order_B2', 'captured'))->>'settlement', 'late_capture',
  'a capture after the hold expired by the clock is a late capture');
select is(
  (select status::text || '/' || coalesce(fulfilled_by_payment_id::text, 'null')
   from public.bookings where id = pg_temp.bk(2)),
  'pending_payment/null',
  'the booking is not fulfilled (its status is left to the expiry sweep)'
);
select ok((select decision_recorded_at is not null from public.payments where provider_payment_id = 'pay_B2'),
  'the late capture is durably recorded as decided (refund required later)');
select is(
  (select count(*)::integer from public.refunds r join public.payments p on p.id = r.payment_id
   where p.provider_payment_id = 'pay_B2'),
  0,
  'no refund is created in this slice'
);

-- booking expired by status
do $$ begin perform pg_temp.open_attempt(11, 'order_B11'); end $$;
update public.bookings set status = 'expired' where id = pg_temp.bk(11);
select is((pg_temp.obs('pay_B11', 'order_B11', 'captured'))->>'settlement', 'late_capture',
  'a capture for an expired booking is a late capture');
select is(
  (select state::text || '/' || closed_reason from public.payment_attempts where provider_order_id = 'order_B11'),
  'closed/booking_expired',
  'and the booking''s live attempts are closed'
);

-- attempt closed while the booking is still pending
do $$ begin perform pg_temp.open_attempt(3, 'order_B3'); end $$;
update public.payment_attempts set state = 'closed', closed_at = now(), closed_reason = 'superseded'
where provider_order_id = 'order_B3';
select is((pg_temp.obs('pay_B3', 'order_B3', 'captured'))->>'settlement', 'late_capture',
  'a capture on a closed attempt is a late capture');
select is((select status::text from public.bookings where id = pg_temp.bk(3)), 'pending_payment',
  'the booking is not fulfilled');

-- ============================================================
-- G. Refund obligation blocks the first fulfilment
-- ============================================================

create temp table t_b6 on commit drop as select pg_temp.open_attempt(6, 'order_B6') as a;
insert into public.payments
  (id, attempt_id, booking_id, provider_payment_id, provider_order_id, provider_status, amount_paise)
values ('f6000000-0000-0000-0000-000000000006', (select a from t_b6), pg_temp.bk(6),
        'pay_B6', 'order_B6', 'captured', 50000);
insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code)
values ('f6000000-0000-0000-0000-000000000006', 1000, 'rfd_settle_b6_0001', 'customer_cancel');

select is((pg_temp.obs('pay_B6', 'order_B6', 'captured'))->>'settlement', 'refund_obligation',
  'an existing refund obligation prevents fulfilment');
select is((select fulfilled_by_payment_id::text from public.bookings where id = pg_temp.bk(6)), null,
  'the pointer stays NULL');

-- ============================================================
-- H. Seen before its order was recorded, matched later
-- ============================================================

create temp table t_b12 on commit drop as select pg_temp.prep(12) as r;
select is((pg_temp.obs('pay_B12', 'order_B12', 'captured'))->>'unmatched_reason', 'unknown_order',
  'a payment arriving before its order is recorded is stored unmatched');
select is(public.payment_record_order((select (r->>'attempt_id')::uuid from t_b12), 'order_B12', 50000, 'INR',
            (select r->>'receipt' from t_b12))->>'outcome', 'recorded',
  'the order is recorded afterwards');
create temp table t_b12o on commit drop as select pg_temp.obs('pay_B12', 'order_B12', 'captured') as r;
select is((select r->>'matched' from t_b12o), 'true',
  'the next observation attaches the payment once identity checks pass');
select is((select r->>'settlement' from t_b12o), 'fulfilled', 'and settles it');

-- an operator disposition keeps a payment unmatched
do $$ begin perform pg_temp.obs('pay_DISP', 'order_DISP', 'captured'); end $$;
update public.payments set unmatched_disposition = 'foreign' where provider_payment_id = 'pay_DISP';
select is((pg_temp.obs('pay_DISP', 'order_DISP', 'captured'))->>'matched', 'false',
  'a dispositioned unmatched payment stays unmatched');

-- ============================================================
-- I. Webhook inbox
-- ============================================================

create temp table t_ev on commit drop as
select public.payment_ingest_event('evt_settle_1', 'payment.captured', 'pay_EV1', 'order_EV1', '{"event":"payment.captured"}') as r;

select is((select (r->>'inserted') || '/' || (r->>'processed') from t_ev), 'true/false',
  'a new event is stored, not yet processed');
select is((public.payment_ingest_event('evt_settle_1', 'payment.captured', 'pay_EV1', 'order_EV1', '{}'))->>'inserted',
  'false', 'a duplicate delivery is not stored twice');
select is((public.payment_ingest_event('evt_settle_1', 'payment.captured', 'pay_EV1', 'order_EV1', '{}'))->>'event_id',
  (select r->>'event_id' from t_ev), 'and resolves to the same event');

select is((public.payment_mark_event((select (r->>'event_id')::uuid from t_ev), 'fetch_failed', 'provider timeout'))->>'outcome',
  'failure_recorded', 'a transient failure is recorded');
select is(
  (select coalesce(processed_at::text, 'null') || '/' || attempts::text || '/' || last_error
   from public.payment_events where provider_event_id = 'evt_settle_1'),
  'null/1/provider timeout',
  'it leaves the event unprocessed for a redelivery'
);

do $$ begin perform pg_temp.obs('pay_EV1', 'order_EV1', 'captured', 50000, 0, 'INR', (select (r->>'event_id')::uuid from t_ev)); end $$;
select is(
  (select (processed_at is not null)::text || '/' || process_result
   from public.payment_events where provider_event_id = 'evt_settle_1'),
  'true/inserted:unmatched:unknown_order:none',
  'the observation marks its event processed with the outcome, in the same transaction'
);
select is((public.payment_mark_event((select (r->>'event_id')::uuid from t_ev), 'ignored_event_type'))->>'outcome',
  'already_processed', 'a processed event is not re-marked');

select * from finish();

rollback;
