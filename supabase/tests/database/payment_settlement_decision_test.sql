begin;

select plan(47);

-- ============================================================
-- Durable settlement decisions (20261024190000)
--
-- Every decision is labelled in payments.settlement_decision by the
-- same UPDATE that sets decision_recorded_at, on the EXPLICIT
-- VERIFICATION path too (payment_apply_observation with no event).
-- The label is write-once, restricted to the five decisions, never
-- recomputed when a payment is observed again, and visible to the
-- Edge Function through payment_booking_payment_context together with
-- the booking's Checkout lease state.
--
-- Single transaction, rolled back. The concurrent cases are S13 and the
-- label assertions in S3/S4 of payment_settlement_concurrency_test.sql.
-- Ids use the fc prefix.
-- ============================================================

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
values ('fc000000-0000-0000-0000-000000000001', 'pay-decision-1@example.com', '', now(), '{}'),
       ('fc000000-0000-0000-0000-000000000002', 'pay-decision-2@example.com', '', now(), '{}');

insert into public.facilities (id, owner_id, name, sport, address, city, status, base_price)
values ('fc100000-0000-0000-0000-000000000001', 'fc000000-0000-0000-0000-000000000001',
        'Decision Arena', 'Badminton', '1 Decision Road', 'Decisionville', 'active', 500);

insert into public.facility_slots (id, facility_id, start_time, end_time, duration_min, base_price)
values ('fc200000-0000-0000-0000-000000000001', 'fc100000-0000-0000-0000-000000000001',
        '06:00', '07:00', 60, 500);

-- D1 normal, D2 expires (clock) before capture, D3 expired (status),
-- D4 captured already refunded, D5 refund obligation, D6 authorized then
-- captured, D7 partial refund seen after a duplicate, D8 lease state
insert into public.bookings
  (id, user_id, facility_id, slot_id, booking_date, start_time, end_time,
   amount, status, payment_status, expires_at)
select ('fc400000-0000-0000-0000-00000000000' || n)::uuid,
       'fc000000-0000-0000-0000-000000000001',
       'fc100000-0000-0000-0000-000000000001', 'fc200000-0000-0000-0000-000000000001',
       current_date + 70 + n, '06:00', '07:00', 500, 'pending_payment', 'pending',
       now() + interval '1 hour'
from generate_series(1, 8) n;

create function pg_temp.bk(n integer) returns uuid language sql as $$
  select ('fc400000-0000-0000-0000-00000000000' || n)::uuid
$$;

create function pg_temp.open_attempt(n integer) returns uuid language plpgsql as $$
declare
  v jsonb;
begin
  v := public.payment_prepare_attempt(pg_temp.bk(n), 'fc000000-0000-0000-0000-000000000001');
  perform public.payment_record_order((v->>'attempt_id')::uuid, 'order_FD' || n,
    (v->>'amount_paise')::bigint, v->>'currency', v->>'receipt');
  return (v->>'attempt_id')::uuid;
end;
$$;

create temp table att on commit drop as
select n, pg_temp.open_attempt(n) as id from generate_series(1, 8) n;

-- an observation of fresh provider facts (the explicit verification path:
-- no event)
create function pg_temp.obs(p_pay text, p_order text, p_status text,
                            p_refunded bigint default 0) returns jsonb language sql as $$
  select public.payment_apply_observation(null, p_pay, p_order, p_status, 50000, 'INR',
    p_refunded, now() - interval '1 minute', null, null)
$$;

create function pg_temp.lbl(p_pay text) returns text language sql as $$
  select coalesce(settlement_decision, 'null') || '/' || (decision_recorded_at is not null)::text
  from public.payments where provider_payment_id = p_pay
$$;

-- ------------------------------------------------------------
-- structure and privileges
-- ------------------------------------------------------------

select has_column('public', 'payments', 'settlement_decision', 'payments has a settlement_decision column');
select ok(
  not has_function_privilege('anon', 'public.payments_guard_settlement_decision()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.payments_guard_settlement_decision()', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.payments_guard_settlement_decision()', 'EXECUTE'),
  'the label guard trigger function is executable by nobody'
);
select ok(
  has_function_privilege('service_role', 'public.payment_booking_payment_context(uuid,uuid,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.payment_booking_payment_context(uuid,uuid,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.payment_settle_locked(uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.payment_settle_locked(uuid)', 'EXECUTE'),
  'grants of the replaced functions are unchanged (context: service_role only; settle: nobody)'
);
select ok(
  (select prosecdef and proconfig @> array['search_path=""']
   from pg_proc where oid = 'public.payment_settle_locked(uuid)'::regprocedure)
  and (select prosecdef and proconfig @> array['search_path=""']
       from pg_proc where oid = 'public.payment_booking_payment_context(uuid,uuid,text)'::regprocedure),
  'both stay SECURITY DEFINER with an empty search_path'
);

-- ------------------------------------------------------------
-- each decision is labelled on the explicit verification path
-- ------------------------------------------------------------

select is(pg_temp.obs('pay_FD1', 'order_FD1', 'created')->>'settlement', 'not_captured', 'D1: an unpaid payment is undecided');
select is(pg_temp.lbl('pay_FD1'), 'null/false', 'D1: and carries no label');
select is(pg_temp.obs('pay_FD1', 'order_FD1', 'captured')->>'settlement', 'fulfilled', 'D1: its capture fulfils the booking');
select is(pg_temp.lbl('pay_FD1'), 'fulfilled/true', 'D1: and is labelled fulfilled with the decision');
select is(
  (select p.id = b.fulfilled_by_payment_id from public.bookings b, public.payments p
   where b.id = pg_temp.bk(1) and p.provider_payment_id = 'pay_FD1'),
  true, 'D1: the labelled payment is the fulfilment pointer');

-- a second capture on the same order: duplicate
select is(pg_temp.obs('pay_FD1B', 'order_FD1', 'captured')->>'settlement', 'duplicate_capture', 'D1: a second capture is a duplicate');
select is(pg_temp.lbl('pay_FD1B'), 'duplicate_capture/true', 'D1: labelled duplicate_capture');

create temp table before_again on commit drop as
select provider_payment_id, settlement_decision, decision_recorded_at
from public.payments where provider_payment_id in ('pay_FD1', 'pay_FD1B');

-- observing again, even with changed provider facts, never relabels
select is(pg_temp.obs('pay_FD1', 'order_FD1', 'captured')->>'settlement', 'already_fulfilled', 'D1: the fulfilling payment observed again');
select is(pg_temp.obs('pay_FD1B', 'order_FD1', 'captured')->>'settlement', 'already_decided', 'D1: the duplicate observed again');
select is(pg_temp.obs('pay_FD1B', 'order_FD1', 'captured', 20000)->>'settlement', 'already_decided',
  'D1: and again after the provider reports a partial refund');
select is(pg_temp.obs('pay_FD1B', 'order_FD1', 'refunded', 50000)->>'settlement', 'already_decided',
  'D1: and after it is reported fully refunded');
select is(
  (select count(*)::integer from public.payments p join before_again b using (provider_payment_id)
   where p.settlement_decision is not distinct from b.settlement_decision
     and p.decision_recorded_at is not distinct from b.decision_recorded_at),
  2, 'D1: no label or decision time changed (a refunded duplicate is still labelled duplicate_capture)');
select is(
  (select p.id = b.fulfilled_by_payment_id from public.bookings b, public.payments p
   where b.id = pg_temp.bk(1) and p.provider_payment_id = 'pay_FD1'),
  true, 'D1: the fulfilment pointer is unchanged');

-- hold ends between order and capture: late
update public.bookings set expires_at = now() - interval '1 second' where id = pg_temp.bk(2);
select is(pg_temp.obs('pay_FD2', 'order_FD2', 'captured')->>'settlement', 'late_capture', 'D2: a capture after the hold is late');
select is(pg_temp.lbl('pay_FD2'), 'late_capture/true', 'D2: labelled late_capture');

update public.bookings set status = 'expired' where id = pg_temp.bk(3);
select is(pg_temp.obs('pay_FD3', 'order_FD3', 'captured')->>'settlement', 'late_capture', 'D3: a capture on an expired booking is late');
select is(pg_temp.lbl('pay_FD3'), 'late_capture/true', 'D3: labelled late_capture');

select is(pg_temp.obs('pay_FD4', 'order_FD4', 'captured', 50000)->>'settlement', 'refunded_before_settlement',
  'D4: a capture the provider already shows refunded');
select is(pg_temp.lbl('pay_FD4'), 'refunded_before_settlement/true', 'D4: labelled refunded_before_settlement');

insert into public.payments
  (id, attempt_id, booking_id, provider_payment_id, provider_order_id, provider_status, amount_paise)
values ('fc600000-0000-0000-0000-000000000005', (select id from att where n = 5), pg_temp.bk(5),
        'pay_FD5', 'order_FD5', 'captured', 50000);
insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code)
values ('fc600000-0000-0000-0000-000000000005', 1000, 'rfd_decision_d5_0001', 'customer_cancel');
select is(pg_temp.obs('pay_FD5', 'order_FD5', 'captured')->>'settlement', 'refund_obligation', 'D5: an existing refund obligation');
select is(pg_temp.lbl('pay_FD5'), 'refund_obligation/true', 'D5: labelled refund_obligation');

select is(pg_temp.obs('pay_FD6', 'order_FD6', 'authorized')->>'settlement', 'not_captured', 'D6: authorized is not captured');
select is(pg_temp.lbl('pay_FD6'), 'null/false', 'D6: undecided, no label');
select is(pg_temp.obs('pay_FD6', 'order_FD6', 'captured')->>'settlement', 'fulfilled', 'D6: captured later');
select is(pg_temp.lbl('pay_FD6'), 'fulfilled/true', 'D6: labelled once decided');

select is(pg_temp.obs('pay_FDU', 'order_FDUNKNOWN', 'captured')->>'matched', 'false', 'an unmatched payment');
select is(pg_temp.lbl('pay_FDU'), 'null/false', 'an unmatched payment is never decided or labelled');

-- ------------------------------------------------------------
-- integrity: values, requirement of a decision, write-once
-- ------------------------------------------------------------

select throws_ok(
  $$ update public.payments set settlement_decision = 'refunded' where provider_payment_id = 'pay_FD6' $$,
  '23514', null, 'only the five decisions are valid labels (and a decided payment cannot be relabelled)');
select throws_ok(
  $$ update public.payments set settlement_decision = 'late_capture' where provider_payment_id = 'pay_FD6' $$,
  '23514', null, 'a label cannot be changed');
select throws_ok(
  $$ update public.payments set settlement_decision = null where provider_payment_id = 'pay_FD6' $$,
  '23514', null, 'a label cannot be cleared');
select throws_ok(
  $$ update public.payments set settlement_decision = 'fulfilled' where provider_payment_id = 'pay_FDU' $$,
  '23514', null, 'an undecided payment cannot be labelled (a decision must be recorded with it)');
select throws_ok(
  $$ update public.payments set decision_recorded_at = null where provider_payment_id = 'pay_FD6' $$,
  '23514', null, 'the decision time stays write-once');

-- simulate a decision recorded before labels existed
alter table public.payments disable trigger payments_guard_settlement_decision;
alter table public.payments disable trigger payments_guard_observation;
update public.payments set settlement_decision = null
where provider_payment_id in ('pay_FD1', 'pay_FD1B', 'pay_FD2');
alter table public.payments enable trigger payments_guard_observation;
alter table public.payments enable trigger payments_guard_settlement_decision;

select throws_ok(
  $$ update public.payments set settlement_decision = 'late_capture' where provider_payment_id = 'pay_FD2' $$,
  '23514', null, 'a payment decided without a label cannot be labelled afterwards (no guessing)');

-- the migration's backfill statement labels only the certain case (it runs
-- before the guard trigger exists, so the trigger is off here as well)
alter table public.payments disable trigger payments_guard_settlement_decision;
update public.payments p
set settlement_decision = 'fulfilled'
from public.bookings b
where b.fulfilled_by_payment_id = p.id
  and p.decision_recorded_at is not null
  and p.settlement_decision is null;
alter table public.payments enable trigger payments_guard_settlement_decision;
select is(
  pg_temp.lbl('pay_FD1') || ' ' || pg_temp.lbl('pay_FD1B') || ' ' || pg_temp.lbl('pay_FD2'),
  'fulfilled/true null/true null/true',
  'backfill: the fulfilling payment is labelled; duplicates and late captures are NOT guessed'
);

-- ------------------------------------------------------------
-- the context seen by the Edge Function
-- ------------------------------------------------------------

select is(
  public.payment_booking_payment_context(pg_temp.bk(1), 'fc000000-0000-0000-0000-000000000001', 'pay_FD1')->>'payment_decision',
  'fulfilled', 'the context reports the stored label of a payment');
select is(
  public.payment_booking_payment_context(pg_temp.bk(3), 'fc000000-0000-0000-0000-000000000001', 'pay_FD3')->>'payment_decision',
  'late_capture', 'including a late capture');
select is(
  public.payment_booking_payment_context(pg_temp.bk(2), 'fc000000-0000-0000-0000-000000000001', 'pay_FD3')->'payment_decision',
  'null'::jsonb, 'a payment of another booking has no decision here');
select is(
  public.payment_booking_payment_context(pg_temp.bk(1), 'fc000000-0000-0000-0000-000000000002', 'pay_FD1'),
  '{"found": false}'::jsonb, 'and another user sees nothing');

-- the Checkout lease state
select is(
  public.payment_booking_payment_context(pg_temp.bk(8), 'fc000000-0000-0000-0000-000000000001')->'checkout_lease',
  '{"hash": null, "state": "none"}'::jsonb, 'a booking whose order was never handed out: lease none');
select is(
  public.payment_acquire_checkout_lease(pg_temp.bk(8), 'fc000000-0000-0000-0000-000000000001',
    (select id from att where n = 8), 'aaaaaaaa-0000-4000-8000-0000000000d8')->>'outcome', 'granted', 'D8: a lease is granted');
select is(
  public.payment_booking_payment_context(pg_temp.bk(8), 'fc000000-0000-0000-0000-000000000001')->'checkout_lease',
  jsonb_build_object('state', 'active', 'hash', encode(sha256(convert_to('aaaaaaaa-0000-4000-8000-0000000000d8', 'UTF8')), 'hex')),
  'then active, with the hash of the session (never the session)');
update public.payment_attempts set checkout_lease_until = now() - interval '1 second' where id = (select id from att where n = 8);
select is(
  public.payment_booking_payment_context(pg_temp.bk(8), 'fc000000-0000-0000-0000-000000000001')->'checkout_lease'->>'state',
  'ended', 'and ended once it runs out');
select is(
  public.payment_booking_payment_context(pg_temp.bk(1), 'fc000000-0000-0000-0000-000000000001')->'checkout_lease',
  'null'::jsonb, 'a fulfilled booking has no open attempt: lease null');

select * from finish();

rollback;
