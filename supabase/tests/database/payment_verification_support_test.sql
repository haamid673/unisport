begin;

select plan(19);

-- ============================================================
-- Slice 1b.2 (20261021190000): verification context and the
-- transient/permanent conflict classification of
-- payment_apply_observation. Single transaction, rolled back. The
-- real concurrent-association race is S11 in
-- payment_settlement_concurrency_test.sql. Ids use the f9 prefix.
-- ============================================================

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
select ('f9000000-0000-0000-0000-00000000000' || n)::uuid, 'pay-verify-' || n || '@example.com', '', now(), '{}'
from generate_series(1, 2) n;

insert into public.facilities (id, owner_id, name, sport, address, city, status, base_price)
values ('f9100000-0000-0000-0000-000000000001', 'f9000000-0000-0000-0000-000000000001',
        'Verify Arena', 'Badminton', '1 Verify Road', 'Verifyville', 'active', 500);

insert into public.facility_slots (id, facility_id, start_time, end_time, duration_min, base_price)
values ('f9200000-0000-0000-0000-000000000001', 'f9100000-0000-0000-0000-000000000001',
        '06:00', '07:00', 60, 500);

insert into public.bookings
  (id, user_id, facility_id, slot_id, booking_date, start_time, end_time,
   amount, status, payment_status, expires_at)
select ('f9400000-0000-0000-0000-00000000000' || n)::uuid, 'f9000000-0000-0000-0000-000000000001',
       'f9100000-0000-0000-0000-000000000001', 'f9200000-0000-0000-0000-000000000001',
       current_date + n, '06:00', '07:00', 500, 'pending_payment', 'pending', now() + interval '1 hour'
from generate_series(1, 3) n;

create function pg_temp.bk(n integer) returns uuid language sql as $$
  select ('f9400000-0000-0000-0000-00000000000' || n)::uuid
$$;

create function pg_temp.ctx(n integer, u integer default 1, p text default null) returns jsonb language sql as $$
  select public.payment_booking_payment_context(pg_temp.bk(n), ('f9000000-0000-0000-0000-00000000000' || u)::uuid, p)
$$;

create function pg_temp.open_attempt(n integer, p_order text) returns uuid language plpgsql as $$
declare
  v jsonb := public.payment_prepare_attempt(pg_temp.bk(n), 'f9000000-0000-0000-0000-000000000001');
begin
  perform public.payment_record_order((v->>'attempt_id')::uuid, p_order,
    (v->>'amount_paise')::bigint, v->>'currency', v->>'receipt');
  return (v->>'attempt_id')::uuid;
end;
$$;

-- ============================================================
-- A. privileges
-- ============================================================

select ok(
  has_function_privilege('service_role', 'public.payment_booking_payment_context(uuid,uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.payment_booking_payment_context(uuid,uuid,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.payment_booking_payment_context(uuid,uuid,text)', 'EXECUTE'),
  'the context lookup is executable by service_role only'
);
select ok(
  (select prosecdef and proconfig @> array['search_path=""'] from pg_proc
   where oid = 'public.payment_booking_payment_context(uuid,uuid,text)'::regprocedure),
  'it is SECURITY DEFINER with an empty search_path'
);
select ok(
  has_function_privilege('service_role',
    'public.payment_apply_observation(uuid,text,text,text,bigint,text,bigint,timestamptz,text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.payment_apply_observation(uuid,text,text,text,bigint,text,bigint,timestamptz,text,text)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.payment_settle_locked(uuid)', 'EXECUTE'),
  'payment_apply_observation keeps its grants; the settlement step stays private'
);

-- ============================================================
-- B. context: ownership and trusted orders
-- ============================================================

select is(pg_temp.ctx(1, 2), '{"found": false}'::jsonb, 'another user''s booking is not found');
select is(public.payment_booking_payment_context('f9400000-0000-0000-0000-0000000000ff',
            'f9000000-0000-0000-0000-000000000001'), '{"found": false}'::jsonb,
  'a missing booking looks the same');
select is(pg_temp.ctx(1)->'orders', '[]'::jsonb, 'a booking without an order lists none');

do $$ begin perform pg_temp.open_attempt(1, 'order_V1'); end $$;

select is(
  (select jsonb_build_object('order', o->>'provider_order_id', 'amount', (o->>'amount_paise')::bigint,
                             'currency', o->>'currency', 'state', o->>'attempt_state')
   from jsonb_array_elements(pg_temp.ctx(1)->'orders') o),
  '{"order": "order_V1", "amount": 50000, "currency": "INR", "state": "open"}'::jsonb,
  'the booking''s own order, amount and currency come from the attempt'
);
select is(pg_temp.ctx(1)->>'booking_status', 'pending_payment', 'the booking status is reported');
select is(pg_temp.ctx(1, 1, 'pay_V1')->>'payment_fulfils_booking', 'false', 'before payment nothing fulfils it');

select is(
  (public.payment_apply_observation(null, 'pay_V1', 'order_V1', 'captured', 50000, 'INR', 0, now(), null, null))->>'settlement',
  'fulfilled', 'fixture: the payment fulfils the booking through the observation path'
);
select is(pg_temp.ctx(1, 1, 'pay_V1')->>'payment_fulfils_booking', 'true', 'the context reports the fulfilling payment');
select is(pg_temp.ctx(1, 1, 'pay_OTHER')->>'payment_fulfils_booking', 'false', 'but not for another payment id');
select is(pg_temp.ctx(1)->>'booking_status', 'confirmed', 'and the confirmed status');
select is(
  (select o->>'attempt_state' from jsonb_array_elements(pg_temp.ctx(1)->'orders') o),
  'closed', 'closed attempts keep their order in the context (a late payment can still be verified)'
);

-- ============================================================
-- C. permanent conflicts are durable anomalies, never retried
-- ============================================================

create temp table ev on commit drop as
select public.payment_ingest_event('evt_verify_1', 'payment.captured', 'pay_V1', 'order_V1', '{}') as r;
select is(
  (public.payment_apply_observation((select (r->>'event_id')::uuid from ev), 'pay_V1', 'order_V1', 'captured',
     60000, 'INR', 0, now(), null, null))->>'observation',
  'identity_conflict', 'an amount disagreeing with the stored payment is an identity conflict (no exception)'
);
select is(
  (select (processed_at is not null)::text || '/' || process_result
   from public.payment_events where provider_event_id = 'evt_verify_1'),
  'true/identity_conflict:none',
  'and its event is processed with the anomaly: a permanent mismatch is not retried'
);

-- a payment linked to booking 2 only (no attempt) observed with an order
-- owned by booking 3: the stored and the derived booking disagree
do $$ begin perform pg_temp.open_attempt(3, 'order_V3'); end $$;
insert into public.payments (provider_payment_id, provider_status, amount_paise, booking_id)
values ('pay_V2LINK', 'captured', 50000, pg_temp.bk(2));
create temp table mm on commit drop as
select public.payment_apply_observation(null, 'pay_V2LINK', 'order_V3', 'captured', 50000, 'INR', 0, now(), null, null) as r;
select is((select r->>'unmatched_reason' from mm), 'attempt_booking_mismatch',
  'a stored booking that disagrees with the order''s attempt is a permanent mismatch (renamed reason)');
select is(
  (select coalesce(attempt_id::text, 'null') || '/' || booking_id::text from public.payments
   where provider_payment_id = 'pay_V2LINK'),
  'null/' || pg_temp.bk(2)::text,
  'it is not attached to the other booking''s attempt'
);
select is(
  (select coalesce(fulfilled_by_payment_id::text, 'null') from public.bookings where id = pg_temp.bk(3)),
  'null', 'and the other booking is not fulfilled by it'
);

select * from finish();

rollback;
