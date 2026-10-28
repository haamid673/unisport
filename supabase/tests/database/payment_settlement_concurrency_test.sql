-- ============================================================
-- Payment slice 1b settlement: REAL multi-session tests
--
-- payment_settlement_functions_test.sql covers the functions inside
-- one transaction. This file proves what needs two sessions:
--
--   S1  settlement racing the expiry of the hold: the observation
--       waits for the booking row held by the expiring transaction,
--       then records a late capture (no fulfilment)
--   S2  settlement racing the closure of the attempt: it waits for
--       the attempt row, then records a late capture
--   S3  lock order (booking first): a second captured payment for a
--       booking that is being fulfilled waits at the BOOKING row
--       (before touching any payment) and is then a duplicate
--       capture; no deadlock
--   S4  the same observation delivered twice concurrently: one row,
--       one fulfilment, the second is idempotent
--   S5  observation/settlement outside READ COMMITTED: UB004
--   S6  two concurrent order-creation requests for one booking: one
--       attempt, the second is told the creation is in progress
--   S7  an unmatched observation takes no booking lock: it completes
--       while another session holds the booking row
--   S8  payment window: recording an order waits for the booking row
--       held by the expiring transaction, then refuses to hand the
--       order out (booking_not_payable) and closes the attempt with
--       the order recorded
--   S9  payment window: re-using an open order waits for the expiring
--       transaction, then refuses (hold_expired)
--   S10 recording an order and a concurrent re-use serialise on the
--       booking row: the re-use returns exactly the recorded order
--   S11 the concurrent-association race (slice 1b.2): an observation
--       that read "no association" while another transaction attached
--       the payment fails with the retryable SQLSTATE 40001; its event
--       stays UNPROCESSED; the retry applies it and marks it processed
--   S12 two sessions acquiring the Checkout lease of one attempt
--       concurrently (20261023190000): the second waits at the booking
--       row and is then refused (held); exactly one lease exists
--   S13 settlement decisions are durable and never overwritten
--       (20261024190000): every decision of S1-S4 carries its label;
--       a concurrent re-observation (here with a refund) of a payment
--       whose decision is being recorded waits for it, then changes
--       neither the label nor the decision time
--
-- Every wait is established from pg_blocking_pids() (the waiter must
-- be blocked BY the other test session); nothing relies on a fixed
-- sleep to decide an outcome. Remote sessions have lock_timeout 10s.
--
-- ------------------------------------------------------------
-- SAFETY: this file COMMITS rows (and may install dblink).
-- ------------------------------------------------------------
-- It refuses to run unless the target database positively
-- identifies itself as the local Supabase development stack (see
-- waitlist_concurrency_test.sql for the guard and its limits).
-- Rows use the id prefixes fa.. and provider ids pay_FC / order_FC,
-- and are removed at the start of the next run and again at the
-- end. No existing fixture of any other suite is touched.
-- ============================================================

select
  coalesce(
    current_database() = 'postgres'
    and inet_server_addr() <<= any (array[
      '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12',
      '192.168.0.0/16', '::1/128'
    ]::inet[])
    and current_setting('app.settings.jwt_secret', true)
        = 'super-secret-jwt-token-with-at-least-32-characters-long',
    false
  ) as env_ok,
  current_database() as env_db,
  coalesce(host(inet_server_addr()), '(none)') as env_addr
\gset

\if :env_ok

create function pg_temp.conninfo()
returns text
language sql
as $$
  select 'host=' || coalesce(host(inet_server_addr()), 'localhost')
      || ' port=' || coalesce(inet_server_port(), 5432)
      || ' dbname=' || current_database()
      || ' user=postgres password='
      || coalesce(nullif(current_setting('test.db_password', true), ''), 'postgres')
$$;

create function pg_temp.dblink_marker()
returns text
language sql
as $$
  select 'unisport-test-harness: installed by payment_settlement_concurrency_test.sql; safe to drop'
$$;

create function pg_temp.release_dblink()
returns void
language plpgsql
as $$
begin
  if exists (
    select 1 from pg_extension e
    where e.extname = 'dblink'
      and obj_description(e.oid, 'pg_extension') = pg_temp.dblink_marker()
  ) then
    begin
      drop extension dblink;
    exception when others then
      raise warning 'dblink installed by the payment settlement harness was left in place: %', sqlerrm;
    end;
  end if;
end;
$$;

create function pg_temp.prereq()
returns text
language plpgsql
as $$
declare
  v_created boolean := false;
begin
  if to_regprocedure('public.payment_apply_observation(uuid,text,text,text,bigint,text,bigint,timestamptz,text,text)') is null
     or to_regprocedure('public.payment_prepare_attempt(uuid,uuid)') is null then
    return 'the payment settlement migration (20261019190000) is not applied to '
        || 'this database; apply it first (supabase migration up).';
  end if;

  if not exists (select 1 from pg_extension where extname = 'dblink') then
    begin
      create extension dblink with schema extensions;
      execute format('comment on extension dblink is %L', pg_temp.dblink_marker());
      v_created := true;
    exception when others then
      return 'the dblink extension is not installed and cannot be installed by role "'
          || current_user || '" (' || sqlerrm || '); run the suite as the postgres '
          || 'role on the local stack, or install it once with: '
          || 'create extension dblink with schema extensions;';
    end;
  end if;

  begin
    perform dblink_connect('probe', pg_temp.conninfo());
    perform dblink_disconnect('probe');
  exception when others then
    if v_created then
      perform pg_temp.release_dblink();
    end if;
    return 'dblink cannot open a second connection to this database (' || sqlerrm
        || '); check that the local database password is the default "postgres", '
        || 'or set test.db_password.';
  end;

  return 'ok';
end;
$$;

select pg_temp.prereq() as prereq_msg \gset
select (:'prereq_msg' = 'ok') as prereq_ok \gset

\if :prereq_ok

select plan(45);

set lock_timeout = '10s';

create function pg_temp.cleanup()
returns void
language sql
as $$
  -- ONE statement: fulfilled bookings and their payments reference
  -- each other (RESTRICT both ways, write-once pointer); the foreign
  -- keys are checked at the end of the statement.
  with p as (
    delete from public.payments
    where provider_payment_id like 'pay\_FC%'
       or booking_id in (select id from public.bookings
                         where facility_id = 'fa100000-0000-0000-0000-000000000001')
    returning 1
  ), a as (
    delete from public.payment_attempts
    where booking_id in (select id from public.bookings
                         where facility_id = 'fa100000-0000-0000-0000-000000000001')
    returning 1
  ), b as (
    delete from public.bookings
    where facility_id = 'fa100000-0000-0000-0000-000000000001'
    returning 1
  )
  select 1;
  delete from public.payment_events where provider_event_id like 'evt\_FC%';
  delete from public.facility_slots where facility_id = 'fa100000-0000-0000-0000-000000000001';
  delete from public.facilities where id = 'fa100000-0000-0000-0000-000000000001';
  delete from auth.users where id::text like 'fa000000-%';
$$;

select pg_temp.cleanup();

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
values ('fa000000-0000-0000-0000-000000000001', 'pay-settle-cc@example.com', '', now(), '{}');

insert into public.facilities (id, owner_id, name, description, sport, address, city, status, base_price)
values ('fa100000-0000-0000-0000-000000000001', 'fa000000-0000-0000-0000-000000000001',
        'Settlement Concurrency Facility', 'Temporary database test facility',
        'Football', 'Test Address', 'Test City', 'active', 500);

insert into public.facility_slots (id, facility_id, start_time, end_time, duration_min, base_price, is_active)
values ('fa200000-0000-0000-0000-000000000001', 'fa100000-0000-0000-0000-000000000001',
        '06:00', '07:00', 60, 500, true);

-- B1..B9, pending holds of 500.00 INR; B1..B4 and B8 get an open
-- attempt, B6, B7 and B9 a creating one
insert into public.bookings
  (id, user_id, facility_id, slot_id, booking_date, start_time, end_time,
   amount, status, payment_status, expires_at)
select ('fa400000-0000-0000-0000-00000000000' || n)::uuid,
       'fa000000-0000-0000-0000-000000000001',
       'fa100000-0000-0000-0000-000000000001', 'fa200000-0000-0000-0000-000000000001',
       current_date + 30 + n, '06:00', '07:00', 500, 'pending_payment', 'pending',
       now() + interval '1 hour'
from generate_series(1, 9) n;

do $$
declare
  v jsonb;
  n integer;
begin
  foreach n in array array[1, 2, 3, 4, 8] loop
    v := public.payment_prepare_attempt(('fa400000-0000-0000-0000-00000000000' || n)::uuid,
                                        'fa000000-0000-0000-0000-000000000001');
    perform public.payment_record_order((v->>'attempt_id')::uuid, 'order_FC' || n,
      (v->>'amount_paise')::bigint, v->>'currency', v->>'receipt');
  end loop;
  foreach n in array array[6, 7, 9] loop
    perform public.payment_prepare_attempt(('fa400000-0000-0000-0000-00000000000' || n)::uuid,
                                           'fa000000-0000-0000-0000-000000000001');
  end loop;
end;
$$;

-- ------------------------------------------------------------
-- Helpers
-- ------------------------------------------------------------

-- Watch ONE remote backend until it is observably BLOCKED BY the
-- given other backend (pg_blocking_pids, which follows the real lock
-- conflict: tuple, transaction and advisory locks alike), or until
-- its statement has finished. 'timeout' (10 s) never counts as
-- success.
create function pg_temp.observe(p_conn text, p_pid integer, p_blocker integer, p_ticks integer)
returns text
language plpgsql
as $$
begin
  for i in 1..p_ticks loop
    if pg_blocking_pids(p_pid) @> array[p_blocker] then
      return 'waiting';
    end if;
    if dblink_is_busy(p_conn) = 0 then
      return 'finished';
    end if;
    perform pg_sleep(0.05);
  end loop;
  return 'timeout';
end;
$$;

-- Result of an asynchronous single-column statement: 'ok:<value>' or '<sqlstate>: <msg>'.
create function pg_temp.collect(p_conn text)
returns text
language plpgsql
as $$
declare
  v_first text;
  v_out text;
begin
  for i in 1..200 loop
    exit when dblink_is_busy(p_conn) = 0;
    perform pg_sleep(0.05);
  end loop;
  begin
    select t.a into v_first from dblink_get_result(p_conn) as t(a text);
    v_out := 'ok:' || coalesce(v_first, '');
  exception when others then
    v_out := sqlstate || ': ' || sqlerrm;
  end;
  begin
    perform * from dblink_get_result(p_conn) as t(a text);
  exception when others then
    null;
  end;
  return v_out;
end;
$$;

create function pg_temp.note_failure(p_what text)
returns void
language plpgsql
as $$
declare
  v_old text := coalesce(nullif(current_setting('test.harness_errors', true), ''), '');
begin
  perform set_config('test.harness_errors',
    v_old || case when v_old = '' then '' else ' | ' end || p_what, false);
end;
$$;

create function pg_temp.sync_exec(p_conn text, p_sql text)
returns void
language plpgsql
as $$
begin
  perform dblink_exec(p_conn, p_sql);
exception when others then
  perform pg_temp.note_failure(p_conn || ': ' || left(p_sql, 60) || ' -> ' || sqlstate || ' ' || sqlerrm);
end;
$$;

-- An observation of fresh provider facts, returning one field.
create function pg_temp.obs(p_pay text, p_order text, p_field text default 'settlement')
returns text
language sql
as $$
  select format(
    'select public.payment_apply_observation(null, %L, %L, ''captured'', 50000, ''INR'', 0, now(), null, null)->>%L',
    p_pay, p_order, p_field)
$$;

create function pg_temp.b(n integer) returns text language sql as $$
  select 'fa400000-0000-0000-0000-00000000000' || n
$$;

-- Two persistent remote sessions
do $$
begin
  perform dblink_connect('a', pg_temp.conninfo());
  perform dblink_connect('b', pg_temp.conninfo());
  perform pg_temp.sync_exec('a', 'set lock_timeout = ''10s''');
  perform pg_temp.sync_exec('b', 'set lock_timeout = ''10s''');
  perform set_config('test.pid_a', (select t.p from dblink('a', 'select pg_backend_pid()') as t(p text)), false);
  perform set_config('test.pid_b', (select t.p from dblink('b', 'select pg_backend_pid()') as t(p text)), false);
end;
$$;

select isnt(
  current_setting('test.pid_a'), current_setting('test.pid_b'),
  'harness: the two remote sessions are different backends'
);

-- ============================================================
-- S1: settlement vs expiry of the hold
-- ============================================================

do $$
begin
  perform pg_temp.sync_exec('a', 'begin');
  perform pg_temp.sync_exec('a', format(
    'update public.bookings set status = ''expired'' where id = %L', pg_temp.b(1)));
  perform dblink_send_query('b', pg_temp.obs('pay_FC1', 'order_FC1'));
  perform set_config('test.s1_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, current_setting('test.pid_a')::integer, 200), false);
  perform pg_temp.sync_exec('a', 'commit');
  perform set_config('test.s1_b', pg_temp.collect('b'), false);
end;
$$;

select is(current_setting('test.s1_obs'), 'waiting',
  'S1: settlement waits for the booking row held by the expiring transaction');
select is(current_setting('test.s1_b'), 'ok:late_capture',
  'S1: and then records a late capture');
select is(
  (select b.status::text || '/' || coalesce(b.fulfilled_by_payment_id::text, 'null') || '/' || a.state::text
   from public.bookings b join public.payment_attempts a on a.booking_id = b.id
   where b.id = pg_temp.b(1)::uuid),
  'expired/null/closed',
  'S1: the booking stays expired and unfulfilled; its attempt is closed'
);

-- ============================================================
-- S2: settlement vs closure of the attempt
-- ============================================================

do $$
begin
  perform pg_temp.sync_exec('a', 'begin');
  perform pg_temp.sync_exec('a',
    'update public.payment_attempts set state = ''closed'', closed_at = now(), closed_reason = ''superseded'' '
    'where provider_order_id = ''order_FC2''');
  perform dblink_send_query('b', pg_temp.obs('pay_FC2', 'order_FC2'));
  perform set_config('test.s2_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, current_setting('test.pid_a')::integer, 200), false);
  perform pg_temp.sync_exec('a', 'commit');
  perform set_config('test.s2_b', pg_temp.collect('b'), false);
end;
$$;

select is(current_setting('test.s2_obs'), 'waiting',
  'S2: settlement waits for the attempt row held by the closing transaction');
select is(current_setting('test.s2_b'), 'ok:late_capture',
  'S2: and then records a late capture instead of fulfilling');

-- ============================================================
-- S3: a second capture while the booking is being fulfilled
-- ============================================================

do $$
begin
  perform pg_temp.sync_exec('a', 'begin');
  perform set_config('test.s3_a',
    (select t.r from dblink('a', pg_temp.obs('pay_FC3A', 'order_FC3')) as t(r text)), false);
  perform dblink_send_query('b', pg_temp.obs('pay_FC3B', 'order_FC3'));
  perform set_config('test.s3_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, current_setting('test.pid_a')::integer, 200), false);
  -- while b waits it must not have written (or row-locked) anything in
  -- payments yet: no RowExclusiveLock / RowShareLock on the table
  perform set_config('test.s3_rows_while_waiting',
    (select count(*)::text from pg_locks l
     where l.pid = current_setting('test.pid_b')::integer
       and l.relation = 'public.payments'::regclass
       and l.mode in ('RowExclusiveLock', 'RowShareLock')), false);
  perform pg_temp.sync_exec('a', 'commit');
  perform set_config('test.s3_b', pg_temp.collect('b'), false);
end;
$$;

select is(current_setting('test.s3_a'), 'fulfilled', 'S3: the first capture fulfils (uncommitted)');
select is(current_setting('test.s3_obs') || '/' || current_setting('test.s3_rows_while_waiting'), 'waiting/0',
  'S3: the second capture waits at the booking row, before writing or locking any payment');
select is(current_setting('test.s3_b'), 'ok:duplicate_capture',
  'S3: and is then recorded as a duplicate capture (no deadlock)');
select is(
  (select p.provider_payment_id from public.bookings b
   join public.payments p on p.id = b.fulfilled_by_payment_id
   where b.id = pg_temp.b(3)::uuid),
  'pay_FC3A',
  'S3: the booking is fulfilled by the first capture only'
);

-- ============================================================
-- S4: the same observation twice, concurrently
-- ============================================================

do $$
begin
  perform pg_temp.sync_exec('a', 'begin');
  perform set_config('test.s4_a',
    (select t.r from dblink('a', pg_temp.obs('pay_FC4', 'order_FC4')) as t(r text)), false);
  perform dblink_send_query('b', pg_temp.obs('pay_FC4', 'order_FC4'));
  perform set_config('test.s4_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, current_setting('test.pid_a')::integer, 200), false);
  perform pg_temp.sync_exec('a', 'commit');
  perform set_config('test.s4_b', pg_temp.collect('b'), false);
end;
$$;

select is(current_setting('test.s4_obs'), 'waiting', 'S4: the duplicate delivery waits for the first');
select is(current_setting('test.s4_a') || '/' || current_setting('test.s4_b'), 'fulfilled/ok:already_fulfilled',
  'S4: one fulfilment; the duplicate is idempotent');
select is((select count(*)::integer from public.payments where provider_payment_id = 'pay_FC4'), 1,
  'S4: exactly one payment row');

-- ============================================================
-- S5: outside READ COMMITTED
-- ============================================================

do $$
begin
  perform pg_temp.sync_exec('b', 'begin isolation level repeatable read');
  perform * from dblink('b', 'select 1') as t(x int);
  perform dblink_send_query('b', pg_temp.obs('pay_FC5', 'order_FC1'));
  perform set_config('test.s5_b', pg_temp.collect('b'), false);
  perform pg_temp.sync_exec('b', 'rollback');
end;
$$;

select ok(current_setting('test.s5_b') like 'UB004:%', 'S5: observation under REPEATABLE READ is rejected (UB004)');
select is((select count(*)::integer from public.payments where provider_payment_id = 'pay_FC5'), 0,
  'S5: nothing was recorded');

-- ============================================================
-- S6: two concurrent order-creation requests for one booking
-- ============================================================

do $$
declare
  v_prep text := format(
    'select public.payment_prepare_attempt(%L, ''fa000000-0000-0000-0000-000000000001'')->>''action''',
    pg_temp.b(5));
begin
  perform pg_temp.sync_exec('a', 'begin');
  perform set_config('test.s6_a', (select t.r from dblink('a', v_prep) as t(r text)), false);
  perform dblink_send_query('b', v_prep);
  perform set_config('test.s6_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, current_setting('test.pid_a')::integer, 200), false);
  perform pg_temp.sync_exec('a', 'commit');
  perform set_config('test.s6_b', pg_temp.collect('b'), false);
end;
$$;

select is(current_setting('test.s6_obs'), 'waiting', 'S6: the second request waits for the booking row');
select is(current_setting('test.s6_a') || '/' || current_setting('test.s6_b'), 'create/ok:in_progress',
  'S6: one request creates; the other is told the creation is in progress');
select is((select count(*)::integer from public.payment_attempts where booking_id = pg_temp.b(5)::uuid), 1,
  'S6: exactly one attempt exists');

-- ============================================================
-- S7: an unmatched observation takes no booking lock
-- ============================================================

do $$
begin
  perform pg_temp.sync_exec('a', 'begin');
  perform * from dblink('a', format(
    'select 1 from public.bookings where id = %L for update', pg_temp.b(6))) as t(x int);
  perform dblink_send_query('b', pg_temp.obs('pay_FC7', 'order_FCUNKNOWN', 'matched'));
  perform set_config('test.s7_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, current_setting('test.pid_a')::integer, 200), false);
  perform set_config('test.s7_b', pg_temp.collect('b'), false);
  perform pg_temp.sync_exec('a', 'rollback');
end;
$$;

select is(current_setting('test.s7_obs'), 'finished',
  'S7: an unmatched observation is not blocked by a held booking row');
select is(current_setting('test.s7_b'), 'ok:false', 'S7: and is stored unmatched');

-- ============================================================
-- S8: recording an order vs the hold expiring
-- ============================================================

create function pg_temp.rec_sql(n integer, p_order text) returns text language sql as $$
  select format(
    'select public.payment_record_order(%L, %L, 50000, ''INR'', %L)->>''outcome''',
    a.id, p_order, a.id::text)
  from public.payment_attempts a
  where a.booking_id = pg_temp.b(n)::uuid and a.state = 'creating'
$$;

do $$
declare
  v_rec text := pg_temp.rec_sql(7, 'order_FC7');
begin
  perform pg_temp.sync_exec('a', 'begin');
  perform pg_temp.sync_exec('a', format(
    'update public.bookings set status = ''expired'' where id = %L', pg_temp.b(7)));
  perform dblink_send_query('b', v_rec);
  perform set_config('test.s8_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, current_setting('test.pid_a')::integer, 200), false);
  perform pg_temp.sync_exec('a', 'commit');
  perform set_config('test.s8_b', pg_temp.collect('b'), false);
end;
$$;

select is(current_setting('test.s8_obs'), 'waiting',
  'S8: recording the order waits for the booking row held by the expiring transaction');
select is(current_setting('test.s8_b'), 'ok:booking_not_payable',
  'S8: and then refuses to hand the order out');
select is(
  (select state::text || '/' || provider_order_id || '/' || closed_reason
   from public.payment_attempts where booking_id = pg_temp.b(7)::uuid),
  'closed/order_FC7/booking_not_payable',
  'S8: the provider order is recorded durably and the attempt closed'
);

-- ============================================================
-- S9: re-use of an open order vs the hold expiring
-- ============================================================

do $$
declare
  v_prep text := format(
    'select (r->>''action'') || '':'' || coalesce(r->>''reason'', r->>''provider_order_id'') '
    'from public.payment_prepare_attempt(%L, ''fa000000-0000-0000-0000-000000000001'') r',
    pg_temp.b(8));
begin
  perform pg_temp.sync_exec('a', 'begin');
  perform pg_temp.sync_exec('a', format(
    'update public.bookings set status = ''expired'' where id = %L', pg_temp.b(8)));
  perform dblink_send_query('b', v_prep);
  perform set_config('test.s9_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, current_setting('test.pid_a')::integer, 200), false);
  perform pg_temp.sync_exec('a', 'commit');
  perform set_config('test.s9_b', pg_temp.collect('b'), false);
end;
$$;

select is(current_setting('test.s9_obs'), 'waiting',
  'S9: re-using the open order waits for the expiring transaction');
select is(current_setting('test.s9_b'), 'ok:not_payable:hold_expired',
  'S9: and then refuses: no order is handed out for the expired booking');

-- ============================================================
-- S10: recording an order vs a concurrent re-use
-- ============================================================

do $$
declare
  v_prep text := format(
    'select (r->>''action'') || '':'' || coalesce(r->>''provider_order_id'', r->>''reason'', '''') '
    'from public.payment_prepare_attempt(%L, ''fa000000-0000-0000-0000-000000000001'') r',
    pg_temp.b(9));
begin
  perform pg_temp.sync_exec('a', 'begin');
  perform set_config('test.s10_a',
    (select t.r from dblink('a', pg_temp.rec_sql(9, 'order_FC9')) as t(r text)), false);
  perform dblink_send_query('b', v_prep);
  perform set_config('test.s10_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, current_setting('test.pid_a')::integer, 200), false);
  perform pg_temp.sync_exec('a', 'commit');
  perform set_config('test.s10_b', pg_temp.collect('b'), false);
end;
$$;

select is(current_setting('test.s10_a') || '/' || current_setting('test.s10_obs'), 'recorded/waiting',
  'S10: a concurrent re-use waits while the order is being recorded');
select is(current_setting('test.s10_b'), 'ok:reuse:order_FC9',
  'S10: and then returns exactly the recorded order');

-- ============================================================
-- S11: the concurrent-association race is retryable, not lost
-- ============================================================

select public.payment_ingest_event('evt_FC11', 'payment.captured', 'pay_FC6', 'order_FC6', '{}') is not null
  as ingested \gset

do $$
declare
  v_event uuid := (select id from public.payment_events where provider_event_id = 'evt_FC11');
begin
  -- a: records the order and applies the capture (attaches + fulfils),
  -- uncommitted. Until a commits, b cannot see the order: its unlocked
  -- reads find no attempt and no payment.
  perform pg_temp.sync_exec('a', 'begin');
  perform set_config('test.s11_a_rec',
    (select t.r from dblink('a', pg_temp.rec_sql(6, 'order_FC6')) as t(r text)), false);
  perform set_config('test.s11_a',
    (select t.r from dblink('a', pg_temp.obs('pay_FC6', 'order_FC6')) as t(r text)), false);
  -- b: the same payment, carrying the event; it inserts, meets a's
  -- uncommitted row in the unique index and waits
  perform dblink_send_query('b', format(
    'select public.payment_apply_observation(%L, ''pay_FC6'', ''order_FC6'', ''captured'', 50000, ''INR'', 0, now(), null, null)->>''settlement''',
    v_event));
  perform set_config('test.s11_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, current_setting('test.pid_a')::integer, 200), false);
  perform pg_temp.sync_exec('a', 'commit');
  perform set_config('test.s11_b', pg_temp.collect('b'), false);
  perform set_config('test.s11_event_after_failure',
    (select coalesce(processed_at::text, 'unprocessed') || '/' || attempts::text
     from public.payment_events where id = v_event), false);
  -- the retry (a redelivery) applies it
  perform set_config('test.s11_retry',
    (select t.r from dblink('b', format(
      'select public.payment_apply_observation(%L, ''pay_FC6'', ''order_FC6'', ''captured'', 50000, ''INR'', 0, now(), null, null)->>''settlement''',
      v_event)) as t(r text)), false);
end;
$$;

select is(current_setting('test.s11_a_rec') || '/' || current_setting('test.s11_a') || '/' || current_setting('test.s11_obs'),
  'recorded/fulfilled/waiting',
  'S11: the second observation waits on the payment the first one is attaching');
select ok(current_setting('test.s11_b') like '40001:%',
  'S11: it then fails with the retryable SQLSTATE 40001 instead of reporting a processed conflict');
select is(current_setting('test.s11_event_after_failure'), 'unprocessed/0',
  'S11: its event is left unprocessed (the transaction rolled back), so a redelivery reprocesses it');
select is(
  current_setting('test.s11_retry') || '/' ||
  (select (processed_at is not null)::text from public.payment_events where provider_event_id = 'evt_FC11'),
  'already_fulfilled/true',
  'S11: the retry applies the observation and marks the event processed'
);

-- ============================================================
-- S12: concurrent Checkout lease acquisition for one attempt
-- ============================================================

insert into public.bookings
  (id, user_id, facility_id, slot_id, booking_date, start_time, end_time,
   amount, status, payment_status, expires_at)
values ('fa400000-0000-0000-0000-000000000012', 'fa000000-0000-0000-0000-000000000001',
        'fa100000-0000-0000-0000-000000000001', 'fa200000-0000-0000-0000-000000000001',
        current_date + 52, '06:00', '07:00', 500, 'pending_payment', 'pending',
        now() + interval '1 hour');

do $$
declare
  v jsonb;
begin
  v := public.payment_prepare_attempt('fa400000-0000-0000-0000-000000000012',
                                      'fa000000-0000-0000-0000-000000000001');
  perform public.payment_record_order((v->>'attempt_id')::uuid, 'order_FC12',
    (v->>'amount_paise')::bigint, v->>'currency', v->>'receipt');
  perform set_config('test.s12_attempt', v->>'attempt_id', false);
end;
$$;

create function pg_temp.lease_sql(p_session text)
returns text
language sql
as $$
  select format(
    'select (r->>''outcome'') || '':'' || coalesce(r->>''resumed'', r->>''retry_after_seconds'', '''') '
    'from public.payment_acquire_checkout_lease(%L, ''fa000000-0000-0000-0000-000000000001'', %L, %L) r',
    'fa400000-0000-0000-0000-000000000012', current_setting('test.s12_attempt'), p_session)
$$;

do $$
begin
  -- a: acquires (uncommitted, holding the booking row); b: another
  -- session acquires the same attempt and must wait, then be refused
  perform pg_temp.sync_exec('a', 'begin');
  perform set_config('test.s12_a',
    (select t.r from dblink('a', pg_temp.lease_sql('aaaaaaaa-0000-4000-8000-0000000000c1')) as t(r text)), false);
  perform dblink_send_query('b', pg_temp.lease_sql('bbbbbbbb-0000-4000-8000-0000000000c2'));
  perform set_config('test.s12_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, current_setting('test.pid_a')::integer, 200), false);
  perform pg_temp.sync_exec('a', 'commit');
  perform set_config('test.s12_b', pg_temp.collect('b'), false);
  -- the first session asking again is not silently granted a second time
  perform set_config('test.s12_a2',
    (select t.r from dblink('a', pg_temp.lease_sql('aaaaaaaa-0000-4000-8000-0000000000c1')) as t(r text)), false);
end;
$$;

select is(current_setting('test.s12_a') || '/' || current_setting('test.s12_obs'), 'granted:false/waiting',
  'S12: a concurrent acquisition waits at the booking row while the first is being granted');
select ok(current_setting('test.s12_b') like 'ok:held:%',
  'S12: and is then refused (held): two sessions never both hold the lease');
select is(
  (select checkout_lease_hash from public.payment_attempts where id = current_setting('test.s12_attempt')::uuid),
  encode(sha256(convert_to('aaaaaaaa-0000-4000-8000-0000000000c1', 'UTF8')), 'hex'),
  'S12: the committed lease belongs to the first session'
);
select is(current_setting('test.s12_a2'), 'verify_required:',
  'S12: the holder asking again must verify that no payment exists first');

-- ============================================================
-- S13: decisions are labelled, and a concurrent re-observation never
-- overwrites them
-- ============================================================

select is(
  (select string_agg(provider_payment_id || '=' || coalesce(settlement_decision, 'null'), ', ' order by provider_payment_id)
   from public.payments
   where provider_payment_id in ('pay_FC1', 'pay_FC2', 'pay_FC3A', 'pay_FC3B', 'pay_FC4')),
  'pay_FC1=late_capture, pay_FC2=late_capture, pay_FC3A=fulfilled, pay_FC3B=duplicate_capture, pay_FC4=fulfilled',
  'S13: every decision of S1-S4 was labelled when it was recorded (committed from other sessions)'
);

insert into public.bookings
  (id, user_id, facility_id, slot_id, booking_date, start_time, end_time,
   amount, status, payment_status, expires_at)
values ('fa400000-0000-0000-0000-000000000013', 'fa000000-0000-0000-0000-000000000001',
        'fa100000-0000-0000-0000-000000000001', 'fa200000-0000-0000-0000-000000000001',
        current_date + 53, '06:00', '07:00', 500, 'pending_payment', 'pending',
        now() + interval '1 hour');

do $$
declare
  v jsonb;
begin
  v := public.payment_prepare_attempt('fa400000-0000-0000-0000-000000000013',
                                      'fa000000-0000-0000-0000-000000000001');
  perform public.payment_record_order((v->>'attempt_id')::uuid, 'order_FC13',
    (v->>'amount_paise')::bigint, v->>'currency', v->>'receipt');
end;
$$;

create function pg_temp.obs_status(p_pay text, p_status text, p_refunded bigint)
returns text
language sql
as $$
  select format(
    'select public.payment_apply_observation(null, %L, ''order_FC13'', %L, 50000, ''INR'', %s, now(), null, null)->>''settlement''',
    p_pay, p_status, p_refunded)
$$;

do $$
begin
  -- the first payment fulfils the booking (uncommitted); a re-observation
  -- that already shows it fully refunded must wait, then change nothing
  perform pg_temp.sync_exec('a', 'begin');
  perform set_config('test.s13_a',
    (select t.r from dblink('a', pg_temp.obs_status('pay_FC13', 'captured', 0)) as t(r text)), false);
  perform dblink_send_query('b', pg_temp.obs_status('pay_FC13', 'refunded', 50000));
  perform set_config('test.s13_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, current_setting('test.pid_a')::integer, 200), false);
  perform pg_temp.sync_exec('a', 'commit');
  perform set_config('test.s13_b', pg_temp.collect('b'), false);
  perform set_config('test.s13_fulfilled',
    (select p.settlement_decision || '/' || p.provider_status::text || '/' || (b.fulfilled_by_payment_id = p.id)::text
     from public.payments p join public.bookings b on b.id = p.booking_id
     where p.provider_payment_id = 'pay_FC13'), false);
  perform set_config('test.s13_time',
    (select decision_recorded_at::text from public.payments where provider_payment_id = 'pay_FC13'), false);

  -- a duplicate capture is being decided (uncommitted); a refunded
  -- re-observation of it must not relabel it as refunded_before_settlement
  perform pg_temp.sync_exec('a', 'begin');
  perform set_config('test.s13_a2',
    (select t.r from dblink('a', pg_temp.obs_status('pay_FC13D', 'captured', 0)) as t(r text)), false);
  perform dblink_send_query('b', pg_temp.obs_status('pay_FC13D', 'refunded', 50000));
  perform set_config('test.s13_obs2',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, current_setting('test.pid_a')::integer, 200), false);
  perform pg_temp.sync_exec('a', 'commit');
  perform set_config('test.s13_b2', pg_temp.collect('b'), false);
  perform set_config('test.s13_dup',
    (select settlement_decision || '/' || provider_status::text from public.payments where provider_payment_id = 'pay_FC13D'), false);
end;
$$;

select is(current_setting('test.s13_a') || '/' || current_setting('test.s13_obs'), 'fulfilled/waiting',
  'S13: a re-observation of a payment whose decision is being recorded waits for it');
select is(current_setting('test.s13_b'), 'ok:already_fulfilled',
  'S13: and then finds it already decided (no second decision)');
select is(current_setting('test.s13_fulfilled'), 'fulfilled/refunded/true',
  'S13: the label stays fulfilled while the later refund fact is merged; the pointer is unchanged');
select is(current_setting('test.s13_a2') || '/' || current_setting('test.s13_obs2'), 'duplicate_capture/waiting',
  'S13: a refunded re-observation of a duplicate capture waits for its decision');
select is(current_setting('test.s13_b2') || '/' || current_setting('test.s13_dup'), 'ok:already_decided/duplicate_capture/refunded',
  'S13: and does not reclassify it (it stays duplicate_capture; the refund is only a provider fact)');
select is(
  (select decision_recorded_at::text from public.payments where provider_payment_id = 'pay_FC13') = current_setting('test.s13_time'),
  true,
  'S13: the decision time of the fulfilling payment never changed');

-- ------------------------------------------------------------
-- Harness health and teardown
-- ------------------------------------------------------------

select is(
  coalesce(nullif(current_setting('test.harness_errors', true), ''), 'none'),
  'none',
  'harness: no setup or helper statement failed or timed out'
);

do $$
declare
  v_conn text;
begin
  foreach v_conn in array array['a', 'b'] loop
    begin
      perform dblink_exec(v_conn, 'rollback');
    exception when others then
      null;
    end;
    begin
      perform dblink_disconnect(v_conn);
    exception when others then
      null;
    end;
  end loop;
  perform pg_temp.cleanup();
end;
$$;

select is(
  (select count(*)::integer from public.payments where provider_payment_id like 'pay\_FC%')
  + (select count(*)::integer from public.bookings
     where facility_id = 'fa100000-0000-0000-0000-000000000001')
  + (select count(*)::integer from auth.users where id::text like 'fa000000-%')
  + (select count(*)::integer from public.payment_events where provider_event_id like 'evt\_FC%'),
  0,
  'teardown: no fixture row of this suite remains (including the committed fulfilments)'
);

do $$
begin
  for i in 1..100 loop
    exit when not exists (
      select 1 from pg_stat_activity
      where pid in (current_setting('test.pid_a')::integer, current_setting('test.pid_b')::integer));
    perform pg_sleep(0.05);
  end loop;
end;
$$;

select is(
  (select count(*)::integer from pg_stat_activity
   where pid in (current_setting('test.pid_a')::integer, current_setting('test.pid_b')::integer)),
  0,
  'teardown: both remote sessions are gone'
);

select pg_temp.release_dblink();
reset lock_timeout;

select * from finish();

\else
select plan(1);
select fail('payment settlement concurrency test cannot run: ' || :'prereq_msg');
select diag('No fixtures were created. Fix the prerequisite above and re-run.');
select * from finish();
\endif

\else
select plan(1);
select fail('payment settlement concurrency test REFUSED to run: this database is not '
  || 'positively identified as the local Supabase development stack '
  || '(database=' || :'env_db' || ', server address=' || :'env_addr' || ').');
select diag('This file commits fixture rows, so it only runs against the local stack started by `supabase start` with the default config.');
select diag('Run it with: supabase test db   (not --linked and not a remote --db-url).');
select diag('Nothing was created or committed.');
select * from finish();
\endif
