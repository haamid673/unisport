-- ============================================================
-- Refund reservation: REAL multi-session tests
--
-- payment_schema_test.sql covers the reservation rule inside one
-- transaction. This file proves the part a single session cannot:
-- that the BEFORE trigger on refunds locks the PAYMENT row first,
-- so concurrent direct INSERTs for one payment (bypassing any
-- function) are serialised and can never reserve more than the
-- payment amount, and that an UNCOMMITTED failure does not release
-- a reservation.
--
--   conn a, b   two independent sessions
--
--   K1  two inserts of 30000 against a 50000 payment: the second
--       waits for the first, then is refused (UB003); one reserves
--   K2  two inserts of 20000: both fit, the second waits and then
--       succeeds (serialisation does not reject valid work)
--   K3  an in-flight UNCOMMITTED failed-update does not release the
--       reservation: the competing insert is refused; once the
--       failure commits, the same insert is accepted
--   K4  two retries of one failed refund: exactly one is accepted
--   K5  an insert waits behind an in-flight update of the payment
--       row (payment row is locked first), then completes
--   K6  a refund insert in a REPEATABLE READ or SERIALIZABLE
--       transaction is rejected (UB004) at once, without waiting
--       for the payment row and without reserving anything
--   K7  one idempotency key presented for two DIFFERENT payments
--       concurrently: the second waits for the first, then fails
--       loudly (23505) even with ON CONFLICT DO NOTHING; one row
--   K8  a replay (ON CONFLICT DO NOTHING) of a request that is
--       still in flight, and of one that consumed the whole cap,
--       is a no-op: it is never charged against the cap (no UB003)
--   K9  the fulfilment pointer check share-locks the payment row:
--       an in-flight refund observation makes the fulfilling
--       UPDATE wait, and the refund is seen once it commits
--   K10 the opposite order: an in-flight fulfilment holds the
--       payment row, a refund observation waits for it, then is
--       retained (a legitimate later fact); fulfilment is also
--       rejected outside READ COMMITTED (UB004)
--   K11 a refund INSERT in flight makes the fulfilling UPDATE
--       wait, and once the refund commits the fulfilment is
--       refused (refund obligation)
--   K12 lock order of refund creation (payment row, then key):
--       a replay of key K2 queued behind a transaction that creates
--       K1 and then K2 for the same payment does not deadlock
--
-- Every wait is established from pg_blocking_pids(): the waiting
-- backend must be blocked BY the other test session (not merely
-- waiting for something); nothing relies on a fixed sleep to decide
-- an outcome. Every remote transaction has a lock_timeout.
--
-- ------------------------------------------------------------
-- SAFETY: this file COMMITS rows (and may install dblink).
-- ------------------------------------------------------------
-- It refuses to run unless the target database positively
-- identifies itself as the local Supabase development stack (see
-- waitlist_concurrency_test.sql for the guard and its limits).
-- Rows use provider ids prefixed pay_ce_ / pay_cf_ / rfd_ce_ and
-- the id prefixes ce.., cf.. and are removed at the start of the
-- next run and again at the end. No existing fixture of any other
-- suite is touched.
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
  select 'unisport-test-harness: installed by payment_refund_reservation_concurrency_test.sql; safe to drop'
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
      raise warning 'dblink installed by the payment reservation harness was left in place: %', sqlerrm;
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
  if to_regclass('public.payment_attempts') is null
     or not exists (
       select 1 from pg_trigger
       where tgname = 'refunds_guard_state_and_reservation'
         and not tgisinternal
     )
     or not exists (
       select 1 from pg_trigger
       where tgname = 'bookings_guard_fulfilment_eligibility'
         and not tgisinternal
     )
     or not exists (
       select 1 from pg_constraint
       where conname = 'payments_attempt_consistency_fkey'
     ) then
    return 'the payment schema migration (20261018190000) is not applied to '
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

select plan(48);

set lock_timeout = '10s';

-- Rows left over from an interrupted run, then a clean fixture
create function pg_temp.cleanup()
returns void
language sql
as $$
  -- ONE statement: K10 commits a fulfilment, and a fulfilled booking
  -- and its payment reference each other (RESTRICT both ways, and
  -- the pointer is write-once), so they can only be removed
  -- together. The foreign keys are checked at the end of the
  -- statement, when all of these rows are gone.
  with r as (
    delete from public.refunds
    where payment_id in (
      select id from public.payments
      where provider_payment_id like 'pay_ce_%' or provider_payment_id like 'pay_cf_%')
    returning 1
  ), p as (
    delete from public.payments
    where provider_payment_id like 'pay_ce_%' or provider_payment_id like 'pay_cf_%'
    returning 1
  ), a as (
    delete from public.payment_attempts
    where booking_id in (
      select id from public.bookings
      where facility_id = 'cf100000-0000-0000-0000-000000000001')
    returning 1
  ), b as (
    delete from public.bookings
    where facility_id = 'cf100000-0000-0000-0000-000000000001'
    returning 1
  )
  select 1;
  delete from public.facility_slots
  where facility_id = 'cf100000-0000-0000-0000-000000000001';
  delete from public.facilities
  where id = 'cf100000-0000-0000-0000-000000000001';
  delete from auth.users
  where id::text like 'cf000000-%';
$$;

select pg_temp.cleanup();

-- payments 1..9 (+10): unmatched captured payments for the refund scenarios
insert into public.payments
  (id, provider_payment_id, provider_order_id, provider_status, amount_paise)
select ('ce000000-0000-0000-0000-00000000000' || n)::uuid,
       'pay_ce_' || n, 'order_ce_' || n, 'captured', 50000
from generate_series(1, 9) n;

insert into public.payments
  (id, provider_payment_id, provider_order_id, provider_status, amount_paise)
values ('ce000000-0000-0000-0000-000000000010', 'pay_ce_10', 'order_ce_10', 'captured', 50000);

-- K9/K11 fixture: a booking with a matched attempt and two captured
-- payments of that attempt. The fulfilling UPDATEs there are never
-- committed (the remote transaction is always rolled back).
-- K10 fixture: a second booking whose fulfilment IS committed; its
-- rows are removed together by cleanup() (see there).
insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
select ('cf000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
       'pay-cf-user' || n || '@example.com', '', now(), '{}'::jsonb
from generate_series(1, 2) n;

insert into public.facilities (id, owner_id, name, description, sport, address, city, status, base_price)
values ('cf100000-0000-0000-0000-000000000001', 'cf000000-0000-0000-0000-000000000002',
        'Payment Concurrency Facility', 'Temporary database test facility',
        'Football', 'Test Address', 'Test City', 'active', 500);

insert into public.facility_slots (id, facility_id, start_time, end_time, duration_min, base_price, is_active)
values ('cf200000-0000-0000-0000-000000000001', 'cf100000-0000-0000-0000-000000000001',
        '06:00', '07:00', 60, 500, true);

insert into public.bookings
  (id, user_id, facility_id, slot_id, booking_date, start_time, end_time,
   amount, status, payment_status, expires_at)
values ('cf400000-0000-0000-0000-000000000001', 'cf000000-0000-0000-0000-000000000001',
        'cf100000-0000-0000-0000-000000000001', 'cf200000-0000-0000-0000-000000000001',
        current_date + 9, '06:00', '07:00', 500, 'pending_payment', 'pending',
        now() + interval '2 hours');

insert into public.payment_attempts (id, booking_id, amount_paise, provider_order_id, state)
values ('cf500000-0000-0000-0000-000000000001', 'cf400000-0000-0000-0000-000000000001',
        50000, 'order_cf_1', 'open');

insert into public.payments
  (id, attempt_id, booking_id, provider_payment_id, provider_order_id, provider_status, amount_paise)
values
  ('cf600000-0000-0000-0000-000000000001', 'cf500000-0000-0000-0000-000000000001',
   'cf400000-0000-0000-0000-000000000001', 'pay_cf_1', 'order_cf_1', 'captured', 50000),
  ('cf600000-0000-0000-0000-000000000002', 'cf500000-0000-0000-0000-000000000001',
   'cf400000-0000-0000-0000-000000000001', 'pay_cf_2', 'order_cf_1', 'captured', 50000);

insert into public.bookings
  (id, user_id, facility_id, slot_id, booking_date, start_time, end_time,
   amount, status, payment_status, expires_at)
values ('cf400000-0000-0000-0000-000000000002', 'cf000000-0000-0000-0000-000000000001',
        'cf100000-0000-0000-0000-000000000001', 'cf200000-0000-0000-0000-000000000001',
        current_date + 10, '06:00', '07:00', 500, 'pending_payment', 'pending',
        now() + interval '2 hours');

insert into public.payment_attempts (id, booking_id, amount_paise, provider_order_id, state)
values ('cf500000-0000-0000-0000-000000000002', 'cf400000-0000-0000-0000-000000000002',
        50000, 'order_cf_2', 'open');

insert into public.payments
  (id, attempt_id, booking_id, provider_payment_id, provider_order_id, provider_status, amount_paise)
values
  ('cf600000-0000-0000-0000-000000000003', 'cf500000-0000-0000-0000-000000000002',
   'cf400000-0000-0000-0000-000000000002', 'pay_cf_3', 'order_cf_2', 'captured', 50000);

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

create function pg_temp.reserved(p_payment text)
returns bigint
language sql
as $$
  select coalesce(sum(amount_paise), 0)::bigint
  from public.refunds
  where payment_id = p_payment::uuid and state <> 'failed'
$$;

create function pg_temp.ins(p_payment text, p_amount bigint, p_key text)
returns text
language sql
as $$
  select format(
    'insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code) '
    'values (%L, %s, %L, ''duplicate_capture'') returning id::text',
    p_payment, p_amount, p_key)
$$;

-- A replay-style insert: counts the rows actually inserted (0 for a
-- no-op), so a no-op and an error are distinguishable.
create function pg_temp.ins_oc(p_payment text, p_amount bigint, p_key text)
returns text
language sql
as $$
  select format(
    'with i as (insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code) '
    'values (%L, %s, %L, ''duplicate_capture'') '
    'on conflict (idempotency_key) do nothing returning id) '
    'select count(*)::text from i',
    p_payment, p_amount, p_key)
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
-- K1: 30000 + 30000 against 50000 -> one reserves, one is refused
-- ============================================================

do $$
begin
  perform pg_temp.sync_exec('a', 'begin');
  perform pg_temp.sync_exec('a', replace(pg_temp.ins('ce000000-0000-0000-0000-000000000001', 30000, 'rfd_ce_k1_a_00001'), ' returning id::text', ''));
  perform dblink_send_query('b', pg_temp.ins('ce000000-0000-0000-0000-000000000001', 30000, 'rfd_ce_k1_b_00001'));
  perform set_config('test.k1_obs', pg_temp.observe('b', current_setting('test.pid_b')::integer, current_setting('test.pid_a')::integer, 200), false);
  perform pg_temp.sync_exec('a', 'commit');
  perform set_config('test.k1_b', pg_temp.collect('b'), false);
end;
$$;

select is(
  current_setting('test.k1_obs'), 'waiting',
  'K1: the second creator waits for the payment row held by the first'
);
select ok(
  current_setting('test.k1_b') like 'UB003:%',
  'K1: once the first commits, the second is refused (UB003)'
);
select is(
  pg_temp.reserved('ce000000-0000-0000-0000-000000000001'), 30000::bigint,
  'K1: exactly 30000 paise are reserved'
);

-- ============================================================
-- K2: 20000 + 20000 against 50000 -> both reserve
-- ============================================================

do $$
begin
  perform pg_temp.sync_exec('a', 'begin');
  perform pg_temp.sync_exec('a', replace(pg_temp.ins('ce000000-0000-0000-0000-000000000002', 20000, 'rfd_ce_k2_a_00001'), ' returning id::text', ''));
  perform dblink_send_query('b', pg_temp.ins('ce000000-0000-0000-0000-000000000002', 20000, 'rfd_ce_k2_b_00001'));
  perform set_config('test.k2_obs', pg_temp.observe('b', current_setting('test.pid_b')::integer, current_setting('test.pid_a')::integer, 200), false);
  perform pg_temp.sync_exec('a', 'commit');
  perform set_config('test.k2_b', pg_temp.collect('b'), false);
end;
$$;

select is(
  current_setting('test.k2_obs'), 'waiting',
  'K2: concurrent creators are serialised'
);
select ok(
  current_setting('test.k2_b') like 'ok:%',
  'K2: the second creator succeeds once there is room'
);
select is(
  pg_temp.reserved('ce000000-0000-0000-0000-000000000002'), 40000::bigint,
  'K2: both reservations are held'
);

-- ============================================================
-- K3: an uncommitted failure does not release the reservation
-- ============================================================

insert into public.refunds (id, payment_id, amount_paise, idempotency_key, reason_code)
values ('ce700000-0000-0000-0000-000000000003', 'ce000000-0000-0000-0000-000000000003',
        50000, 'rfd_ce_k3_full_0001', 'duplicate_capture');

do $$
begin
  -- a marks the full reservation definitively failed, NOT yet committed
  perform pg_temp.sync_exec('a', 'begin');
  perform pg_temp.sync_exec('a',
    'update public.refunds set state = ''failed'', failure_reason = ''definitive'' '
    'where id = ''ce700000-0000-0000-0000-000000000003''');
  -- b tries to reserve the capacity a is about to release
  perform set_config('test.k3_before',
    (select t.r from dblink('b',
       pg_temp.ins('ce000000-0000-0000-0000-000000000003', 50000, 'rfd_ce_k3_b_00001'))
       as t(r text)) , false);
exception when others then
  perform set_config('test.k3_before', sqlstate || ': ' || sqlerrm, false);
end;
$$;

select ok(
  current_setting('test.k3_before') like 'UB003:%' or current_setting('test.k3_before') like '%exceed%',
  'K3: while the failure is uncommitted the competing reservation is refused'
);

do $$
begin
  perform pg_temp.sync_exec('a', 'commit');
  perform set_config('test.k3_after',
    (select t.r from dblink('b',
       pg_temp.ins('ce000000-0000-0000-0000-000000000003', 50000, 'rfd_ce_k3_b_00002'))
       as t(r text)), false);
exception when others then
  perform set_config('test.k3_after', sqlstate || ': ' || sqlerrm, false);
end;
$$;

select ok(
  current_setting('test.k3_after') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  'K3: once the failure commits the released capacity can be reserved'
);
select is(
  pg_temp.reserved('ce000000-0000-0000-0000-000000000003'), 50000::bigint,
  'K3: the payment is reserved exactly once at the end'
);

-- ============================================================
-- K4: two retries of one failed refund -> exactly one
-- ============================================================

insert into public.refunds (id, payment_id, amount_paise, idempotency_key, reason_code, state)
values ('ce700000-0000-0000-0000-000000000004', 'ce000000-0000-0000-0000-000000000004',
        1000, 'rfd_ce_k4_fail_0001', 'duplicate_capture', 'failed');

do $$
begin
  perform pg_temp.sync_exec('a', 'begin');
  perform pg_temp.sync_exec('a',
    'insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code, retry_of) '
    'values (''ce000000-0000-0000-0000-000000000004'', 1000, ''rfd_ce_k4_a_00001'', ''duplicate_capture'', '
    '''ce700000-0000-0000-0000-000000000004'')');
  perform dblink_send_query('b',
    'insert into public.refunds (payment_id, amount_paise, idempotency_key, reason_code, retry_of) '
    'values (''ce000000-0000-0000-0000-000000000004'', 1000, ''rfd_ce_k4_b_00001'', ''duplicate_capture'', '
    '''ce700000-0000-0000-0000-000000000004'') returning id::text');
  perform set_config('test.k4_obs', pg_temp.observe('b', current_setting('test.pid_b')::integer, current_setting('test.pid_a')::integer, 200), false);
  perform pg_temp.sync_exec('a', 'commit');
  perform set_config('test.k4_b', pg_temp.collect('b'), false);
end;
$$;

select is(
  current_setting('test.k4_obs'), 'waiting',
  'K4: the second retry waits behind the first'
);
select ok(
  current_setting('test.k4_b') ~ '^(23505|23514):',
  'K4: the second retry of the same failed refund is refused'
);
select is(
  (select count(*)::integer from public.refunds
   where retry_of = 'ce700000-0000-0000-0000-000000000004'),
  1,
  'K4: exactly one retry exists'
);

-- ============================================================
-- K5: an insert waits behind an in-flight update of the payment
--     row (the payment row is locked FIRST), then completes
-- ============================================================

do $$
begin
  perform pg_temp.sync_exec('a', 'begin');
  perform pg_temp.sync_exec('a',
    'update public.payments set last_seen_at = now() '
    'where id = ''ce000000-0000-0000-0000-000000000005''');
  perform dblink_send_query('b', pg_temp.ins('ce000000-0000-0000-0000-000000000005', 100, 'rfd_ce_k5_b_00001'));
  perform set_config('test.k5_obs', pg_temp.observe('b', current_setting('test.pid_b')::integer, current_setting('test.pid_a')::integer, 200), false);
  perform pg_temp.sync_exec('a', 'commit');
  perform set_config('test.k5_b', pg_temp.collect('b'), false);
end;
$$;

select is(
  current_setting('test.k5_obs'), 'waiting',
  'K5: a refund insert waits for an in-flight payment-row update'
);
select ok(
  current_setting('test.k5_b') like 'ok:%',
  'K5: and completes once the payment row is released'
);

-- ============================================================
-- K6: REPEATABLE READ / SERIALIZABLE refund inserts are rejected
--     immediately, before the payment row is awaited
-- ============================================================

do $$
declare
  v_level text;
begin
  -- a holds the payment row lock through an uncommitted insert
  perform pg_temp.sync_exec('a', 'begin');
  perform pg_temp.sync_exec('a', replace(pg_temp.ins('ce000000-0000-0000-0000-000000000006', 1000, 'rfd_ce_k6_a_00001'), ' returning id::text', ''));

  foreach v_level in array array['repeatable read', 'serializable'] loop
    perform pg_temp.sync_exec('b', 'begin isolation level ' || v_level);
    -- a statement first, so the transaction snapshot really exists
    perform * from dblink('b', 'select 1') as t(x int);
    perform dblink_send_query('b', pg_temp.ins('ce000000-0000-0000-0000-000000000006', 1000,
      'rfd_ce_k6_b_' || case v_level when 'serializable' then 's' else 'r' end || '0001'));
    perform set_config('test.k6_obs_' || left(v_level, 1),
      pg_temp.observe('b', current_setting('test.pid_b')::integer, current_setting('test.pid_a')::integer, 200), false);
    perform set_config('test.k6_b_' || left(v_level, 1), pg_temp.collect('b'), false);
    perform pg_temp.sync_exec('b', 'rollback');
  end loop;

  perform pg_temp.sync_exec('a', 'commit');
end;
$$;

select is(
  current_setting('test.k6_obs_r') || '/' || current_setting('test.k6_obs_s'),
  'finished/finished',
  'K6: neither isolation-level attempt waited for the payment row held by a'
);
select ok(
  current_setting('test.k6_b_r') like 'UB004:%',
  'K6: REPEATABLE READ is rejected with UB004'
);
select ok(
  current_setting('test.k6_b_s') like 'UB004:%',
  'K6: SERIALIZABLE is rejected with UB004'
);
select is(
  (select count(*)::integer from public.refunds
   where payment_id = 'ce000000-0000-0000-0000-000000000006'),
  1,
  'K6: only the READ COMMITTED reservation exists; nothing was reserved by the rejected inserts'
);

-- ============================================================
-- K7: one key, two payments, concurrently -> loud 23505, one row
-- ============================================================

do $$
begin
  perform pg_temp.sync_exec('a', 'begin');
  perform pg_temp.sync_exec('a', replace(pg_temp.ins('ce000000-0000-0000-0000-000000000007', 1000, 'rfd_ce_k7_shared_01'), ' returning id::text', ''));
  perform dblink_send_query('b', pg_temp.ins_oc('ce000000-0000-0000-0000-000000000008', 1000, 'rfd_ce_k7_shared_01'));
  perform set_config('test.k7_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, current_setting('test.pid_a')::integer, 200), false);
  perform pg_temp.sync_exec('a', 'commit');
  perform set_config('test.k7_b', pg_temp.collect('b'), false);
end;
$$;

select is(
  current_setting('test.k7_obs'), 'waiting',
  'K7: the second creator of the key waits for the first (key lock), although it names another payment'
);
select ok(
  current_setting('test.k7_b') like '23505:%different refund request%',
  'K7: ON CONFLICT DO NOTHING does not turn a cross-payment key reuse into a silent success'
);
select is(
  (select count(*)::integer from public.refunds where idempotency_key = 'rfd_ce_k7_shared_01'),
  1,
  'K7: exactly one refund holds the key'
);
select is(
  (select count(*)::integer from public.refunds
   where payment_id = 'ce000000-0000-0000-0000-000000000008'),
  0,
  'K7: the other payment received no refund'
);

-- ============================================================
-- K8: replays are not charged against the cap
-- ============================================================

do $$
begin
  -- a: 30000 of 50000, in flight. b replays the SAME request.
  perform pg_temp.sync_exec('a', 'begin');
  perform pg_temp.sync_exec('a', replace(pg_temp.ins('ce000000-0000-0000-0000-000000000009', 30000, 'rfd_ce_k8_a_00001'), ' returning id::text', ''));
  perform dblink_send_query('b', pg_temp.ins_oc('ce000000-0000-0000-0000-000000000009', 30000, 'rfd_ce_k8_a_00001'));
  perform set_config('test.k8_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, current_setting('test.pid_a')::integer, 200), false);
  perform pg_temp.sync_exec('a', 'commit');
  perform set_config('test.k8_b', pg_temp.collect('b'), false);
end;
$$;

select is(
  current_setting('test.k8_obs'), 'waiting',
  'K8: a replay of an in-flight request waits for it'
);
select is(
  current_setting('test.k8_b'), 'ok:0',
  'K8: and is then a no-op: it is not counted against the cap a second time (no UB003)'
);
select is(
  pg_temp.reserved('ce000000-0000-0000-0000-000000000009'), 30000::bigint,
  'K8: the reservation was counted exactly once'
);

-- the rest of the cap is consumed, then the first request is replayed
select dblink_exec('a',
  replace(pg_temp.ins('ce000000-0000-0000-0000-000000000009', 20000, 'rfd_ce_k8_b_00001'), ' returning id::text', ''));

select is(
  (select t.c from dblink('b', pg_temp.ins_oc('ce000000-0000-0000-0000-000000000009', 30000, 'rfd_ce_k8_a_00001'))
     as t(c text)),
  '0',
  'K8: replaying a request against a fully reserved payment is a no-op, not UB003'
);
select is(
  pg_temp.reserved('ce000000-0000-0000-0000-000000000009'), 50000::bigint,
  'K8: the payment is exactly fully reserved and unchanged by the replay'
);

-- ============================================================
-- K9: the fulfilment guard share-locks the payment row
-- ============================================================

-- (a) an in-flight refund observation is waited for and then SEEN
do $$
begin
  perform pg_temp.sync_exec('a', 'begin');
  perform pg_temp.sync_exec('a',
    'update public.payments set provider_amount_refunded_paise = 10000 '
    'where id = ''cf600000-0000-0000-0000-000000000001''');
  perform pg_temp.sync_exec('b', 'begin');
  perform dblink_send_query('b',
    'update public.bookings set status = ''confirmed'', confirmed_at = now(), '
    'fulfilled_by_payment_id = ''cf600000-0000-0000-0000-000000000001'' '
    'where id = ''cf400000-0000-0000-0000-000000000001'' returning id::text');
  perform set_config('test.k9a_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, current_setting('test.pid_a')::integer, 200), false);
  perform pg_temp.sync_exec('a', 'commit');
  perform set_config('test.k9a_b', pg_temp.collect('b'), false);
  perform pg_temp.sync_exec('b', 'rollback');
end;
$$;

select is(
  current_setting('test.k9a_obs'), 'waiting',
  'K9: fulfilment waits for an in-flight observation of the payment'
);
select ok(
  current_setting('test.k9a_b') like '23514:%refunded%',
  'K9: and, once the refund observation commits, refuses the (partly) refunded payment'
);

-- (b) control: an unrelated in-flight update is waited for, then the
--     fulfilment of a clean captured payment succeeds (rolled back)
do $$
begin
  perform pg_temp.sync_exec('a', 'begin');
  perform pg_temp.sync_exec('a',
    'update public.payments set last_seen_at = now() '
    'where id = ''cf600000-0000-0000-0000-000000000002''');
  perform pg_temp.sync_exec('b', 'begin');
  perform dblink_send_query('b',
    'update public.bookings set status = ''confirmed'', confirmed_at = now(), '
    'fulfilled_by_payment_id = ''cf600000-0000-0000-0000-000000000002'' '
    'where id = ''cf400000-0000-0000-0000-000000000001'' returning id::text');
  perform set_config('test.k9b_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, current_setting('test.pid_a')::integer, 200), false);
  perform pg_temp.sync_exec('a', 'commit');
  perform set_config('test.k9b_b', pg_temp.collect('b'), false);
  perform pg_temp.sync_exec('b', 'rollback');
end;
$$;

select is(
  current_setting('test.k9b_obs'), 'waiting',
  'K9 control: fulfilment also waits for an unrelated in-flight update of the payment row'
);
select ok(
  current_setting('test.k9b_b') like 'ok:%',
  'K9 control: a clean captured payment fulfils the booking once the row is free'
);
select is(
  (select fulfilled_by_payment_id::text from public.bookings
   where id = 'cf400000-0000-0000-0000-000000000001'),
  null,
  'K9: the test transactions were rolled back; the write-once pointer is still NULL'
);

-- ============================================================
-- K10: fulfilment first -> the refund observation waits and is kept
-- ============================================================

do $$
begin
  perform pg_temp.sync_exec('a', 'begin');
  perform pg_temp.sync_exec('a',
    'update public.bookings set status = ''confirmed'', confirmed_at = now(), '
    'fulfilled_by_payment_id = ''cf600000-0000-0000-0000-000000000003'' '
    'where id = ''cf400000-0000-0000-0000-000000000002''');
  perform dblink_send_query('b',
    'update public.payments set provider_amount_refunded_paise = 10000 '
    'where id = ''cf600000-0000-0000-0000-000000000003'' '
    'returning provider_amount_refunded_paise::text');
  perform set_config('test.k10_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, current_setting('test.pid_a')::integer, 200), false);
  perform pg_temp.sync_exec('a', 'commit');
  perform set_config('test.k10_b', pg_temp.collect('b'), false);
end;
$$;

select is(
  current_setting('test.k10_obs'), 'waiting',
  'K10: a refund observation waits for the in-flight fulfilment of its payment'
);
select is(
  current_setting('test.k10_b'), 'ok:10000',
  'K10: and proceeds once the fulfilment commits'
);
select is(
  (select provider_status::text || '/' || provider_amount_refunded_paise::text
   from public.payments where id = 'cf600000-0000-0000-0000-000000000003'),
  'captured/10000',
  'K10: the later partial refund observation is retained'
);
select is(
  (select status::text || '/' || fulfilled_by_payment_id::text from public.bookings
   where id = 'cf400000-0000-0000-0000-000000000002'),
  'confirmed/cf600000-0000-0000-0000-000000000003',
  'K10: the booking is fulfilled by that payment'
);

-- fulfilment outside READ COMMITTED is rejected before anything is read
do $$
begin
  perform pg_temp.sync_exec('b', 'begin isolation level repeatable read');
  perform * from dblink('b', 'select 1') as t(x int);
  perform dblink_send_query('b',
    'update public.bookings set status = ''confirmed'', '
    'fulfilled_by_payment_id = ''cf600000-0000-0000-0000-000000000001'' '
    'where id = ''cf400000-0000-0000-0000-000000000001'' returning id::text');
  perform set_config('test.k10_rr', pg_temp.collect('b'), false);
  perform pg_temp.sync_exec('b', 'rollback');
end;
$$;

select ok(
  current_setting('test.k10_rr') like 'UB004:%',
  'K10: first fulfilment under REPEATABLE READ is rejected with UB004'
);

-- ============================================================
-- K11: a refund INSERT in flight vs the first fulfilment
-- ============================================================

do $$
begin
  perform pg_temp.sync_exec('a', 'begin');
  perform pg_temp.sync_exec('a', replace(pg_temp.ins('cf600000-0000-0000-0000-000000000002', 1000, 'rfd_ce_k11_a_00001'), ' returning id::text', ''));
  perform pg_temp.sync_exec('b', 'begin');
  perform dblink_send_query('b',
    'update public.bookings set status = ''confirmed'', confirmed_at = now(), '
    'fulfilled_by_payment_id = ''cf600000-0000-0000-0000-000000000002'' '
    'where id = ''cf400000-0000-0000-0000-000000000001'' returning id::text');
  perform set_config('test.k11_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, current_setting('test.pid_a')::integer, 200), false);
  perform pg_temp.sync_exec('a', 'commit');
  perform set_config('test.k11_b', pg_temp.collect('b'), false);
  perform pg_temp.sync_exec('b', 'rollback');
end;
$$;

select is(
  current_setting('test.k11_obs'), 'waiting',
  'K11: fulfilment waits for a refund insert that is in flight'
);
select ok(
  current_setting('test.k11_b') like '23514:%refund obligation%',
  'K11: once the refund commits, the fulfilment is refused (refund obligation)'
);
select is(
  (select count(*)::integer from public.refunds
   where payment_id = 'cf600000-0000-0000-0000-000000000002')
  || '/' ||
  coalesce((select fulfilled_by_payment_id::text from public.bookings
            where id = 'cf400000-0000-0000-0000-000000000001'), 'null'),
  '1/null',
  'K11: the refund exists and the pointer is still NULL'
);

-- ============================================================
-- K12: lock order payment row -> key: no deadlock
-- ============================================================

do $$
begin
  -- a: creates K1 and then K2 for one payment. b: replays K2 while
  -- a is between its two inserts. Under a key-then-payment order, b
  -- would hold K2's key lock while waiting for the payment row, and
  -- a's second insert would wait for that key: a deadlock.
  perform pg_temp.sync_exec('a', 'begin');
  perform pg_temp.sync_exec('a', replace(pg_temp.ins('ce000000-0000-0000-0000-000000000010', 1000, 'rfd_ce_k12_a_00001'), ' returning id::text', ''));
  perform dblink_send_query('b', pg_temp.ins_oc('ce000000-0000-0000-0000-000000000010', 1000, 'rfd_ce_k12_b_00001'));
  perform set_config('test.k12_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, current_setting('test.pid_a')::integer, 200), false);
  begin
    perform dblink_exec('a',
      replace(pg_temp.ins('ce000000-0000-0000-0000-000000000010', 1000, 'rfd_ce_k12_b_00001'), ' returning id::text', ''));
    perform set_config('test.k12_a', 'ok', false);
  exception when others then
    perform set_config('test.k12_a', sqlstate || ': ' || sqlerrm, false);
  end;
  perform pg_temp.sync_exec('a', 'commit');
  perform set_config('test.k12_b', pg_temp.collect('b'), false);
end;
$$;

select is(
  current_setting('test.k12_obs'), 'waiting',
  'K12: the replay queues on the payment row held by the first transaction'
);
select is(
  current_setting('test.k12_a'), 'ok',
  'K12: the first transaction creates its second key without a deadlock'
);
select is(
  current_setting('test.k12_b'), 'ok:0',
  'K12: and the queued replay is then a no-op'
);
select is(
  (select count(*)::integer from public.refunds
   where payment_id = 'ce000000-0000-0000-0000-000000000010'),
  2,
  'K12: exactly the two refunds of the first transaction exist'
);

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

-- teardown verification: no fixture row and no remote session is left
select is(
  (select count(*)::integer from public.payments
   where provider_payment_id like 'pay\_ce\_%' or provider_payment_id like 'pay\_cf\_%')
  + (select count(*)::integer from public.payment_attempts
     where booking_id in (select id from public.bookings
                          where facility_id = 'cf100000-0000-0000-0000-000000000001'))
  + (select count(*)::integer from public.bookings
     where facility_id = 'cf100000-0000-0000-0000-000000000001')
  + (select count(*)::integer from auth.users where id::text like 'cf000000-%'),
  0,
  'teardown: no fixture row of this suite remains (including the committed fulfilment)'
);

do $$
begin
  -- the remote backends exit asynchronously after the disconnect
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
  'teardown: both remote sessions are gone (no dangling or idle-in-transaction backend)'
);

select pg_temp.release_dblink();
reset lock_timeout;

select * from finish();

\else
select plan(1);
select fail('payment refund reservation concurrency test cannot run: ' || :'prereq_msg');
select diag('No fixtures were created. Fix the prerequisite above and re-run.');
select * from finish();
\endif

\else
select plan(1);
select fail('payment refund reservation concurrency test REFUSED to run: this database is not '
  || 'positively identified as the local Supabase development stack '
  || '(database=' || :'env_db' || ', server address=' || :'env_addr' || ').');
select diag('This file commits fixture rows, so it only runs against the local stack started by `supabase start` with the default config.');
select diag('Run it with: supabase test db   (not --linked and not a remote --db-url).');
select diag('Nothing was created or committed.');
select * from finish();
\endif
