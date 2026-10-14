-- ============================================================
-- Facility-level booking overlap: REAL multi-session tests
--
-- Like waitlist_concurrency_test.sql this file does not run in one
-- transaction. It opens separate database connections with dblink
-- and drives the real create_booking(), expire_pending_bookings()
-- and process_waitlist() through deterministic interleavings:
--
--   conn a  the "locker": the expiry job, process_waitlist(), or a
--           raw writer, with its transaction held open
--   conn b  the customer booking (and b-then-c for two customers)
--   conn c  a second customer
--
-- The sweep in create_booking() WAITS for a stale hold that
-- another transaction holds locked, then re-evaluates it, and only
-- considers holds whose snapshot overlaps the requested slot.
--
-- Scenarios
--   E1   an UNRELATED stale hold is locked by the job: a booking
--        does not wait for it and the job expires it
--   C1   cross-slot conflicting stale hold, locker COMMITS
--   C2   cross-slot conflicting stale hold, locker ROLLS BACK
--        -> the booking succeeds in the same attempt
--   S1   same-slot conflicting stale hold, locker commits
--   S2   same-slot conflicting stale hold, locker rolls back
--   E3a  an in-flight live conflicting booking commits: the
--        waiting booking is refused (23P01)
--   E3b  ... or rolls back: the waiting booking succeeds
--   L1   a committed live conflict (confirmed) is refused at once
--   L2   a committed live conflict (live hold) is refused at once
--   K1   the stale hold is turned into a CONFIRMED booking by the
--        locker: the booking waits, then is refused (23P01);
--        the constraint is not bypassed
--   M1   several stale rows, two customers: no deadlock, both
--        bookings succeed
--   P1   the locker is process_waitlist() (skipped with a note if
--        other waitlist data exists in this database)
--   T1   a short lock_timeout: 55P03, and nothing is changed
--
-- "Waiting in the sweep" versus "waiting later at the exclusion
-- constraint": a backend that waits to lock a ROW takes a
-- heavyweight "tuple" lock first (granted for the first waiter,
-- queued for the next); one waiting at the exclusion constraint
-- waits on the other transaction's id directly and holds none.
-- pg_temp.in_row_wait() reads that from pg_locks.
--
-- Every "is waiting" assertion looks at pg_locks for that
-- session's backend pid; nothing sleeps for a fixed time.
--
-- Because slot definitions of one facility cannot overlap
-- (facility_slots_no_overlap), two create_booking() calls cannot
-- race each other into overlapping snapshots from a coherent
-- state. The conflicting row is therefore a stale hold or a raw
-- booking whose snapshot overlaps the slot being booked (the
-- state a time edit after booking leaves).
--
-- ------------------------------------------------------------
-- SAFETY: this file COMMITS rows (and may install dblink).
-- ------------------------------------------------------------
-- It refuses to run unless the target database positively
-- identifies itself as the local Supabase development stack
-- (see waitlist_concurrency_test.sql for the same guard and its
-- limits). Rows use ids prefixed ce... and are removed at the
-- start of the next run and again at the end. It also runs
-- public.expire_pending_bookings(), the job pg_cron runs every
-- minute, which only affects holds already past their expiry.
--
-- Residual timing risk: pg_cron runs expire-pending-bookings and
-- process-waitlist once a minute. If a run lands in the few
-- milliseconds between a stale hold being committed and its
-- scenario starting, the scenario's precondition assertions
-- fail loudly instead of passing for the wrong reason; re-run
-- the suite.
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
  select 'unisport-test-harness: installed by booking_facility_concurrency_test.sql; safe to drop'
$$;

create function pg_temp.release_dblink()
returns void
language plpgsql
as $$
begin
  if exists (
    select 1
    from pg_extension e
    where e.extname = 'dblink'
      and obj_description(e.oid, 'pg_extension') = pg_temp.dblink_marker()
  ) then
    begin
      drop extension dblink;
    exception
      when others then
        raise warning
          'dblink installed by the booking test harness was left in place: %',
          sqlerrm;
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
  if to_regprocedure('public.create_booking(uuid,uuid,date)') is null
     or to_regprocedure('public.expire_pending_bookings()') is null
     or not exists (
       select 1 from pg_constraint
       where conname = 'bookings_no_facility_overlap'
     ) then
    return 'the facility-level booking migrations are not applied to this '
        || 'database; apply them first (supabase migration up).';
  end if;

  if not exists (select 1 from pg_extension where extname = 'dblink') then
    begin
      create extension dblink with schema extensions;
      execute format('comment on extension dblink is %L', pg_temp.dblink_marker());
      v_created := true;
    exception
      when others then
        return 'the dblink extension is not installed and cannot be '
            || 'installed by role "' || current_user || '" (' || sqlerrm || '); '
            || 'run the suite as the postgres role on the local stack, or '
            || 'install it once with: create extension dblink with schema extensions;';
    end;
  end if;

  begin
    perform dblink_connect('probe', pg_temp.conninfo());
    perform dblink_disconnect('probe');
  exception
    when others then
      if v_created then
        perform pg_temp.release_dblink();
      end if;
      return 'dblink cannot open a second connection to this database ('
          || sqlerrm || '); check that the local database password is the '
          || 'default "postgres", or set test.db_password.';
  end;

  return 'ok';
end;
$$;

select pg_temp.prereq() as prereq_msg \gset
select (:'prereq_msg' = 'ok') as prereq_ok \gset

\if :prereq_ok

select plan(41);


-- ------------------------------------------------------------
-- Helpers (session-local; vanish with the session)
-- ------------------------------------------------------------

create function pg_temp.cleanup()
returns void
language sql
as $$
  delete from public.waitlist_entries
  where facility_id = 'ce100000-0000-0000-0000-000000000001';
  delete from public.bookings
  where facility_id = 'ce100000-0000-0000-0000-000000000001';
  delete from public.facility_slots
  where facility_id = 'ce100000-0000-0000-0000-000000000001';
  delete from public.facilities
  where id = 'ce100000-0000-0000-0000-000000000001';
  delete from auth.users
  where id::text like 'ce000000-%';
$$;

-- Insert a committed booking row with an arbitrary snapshot.
-- Slots: Y = ...01 (08-09), Z1 = ...02 (20-21), Z2 = ...03 (21-22).
create function pg_temp.put_booking(
  p_id uuid, p_day integer, p_slot uuid, p_start time, p_end time,
  p_status text, p_expires interval
)
returns void
language sql
as $$
  insert into public.bookings (
    id, user_id, facility_id, slot_id, booking_date,
    start_time, end_time, amount, status, payment_status, expires_at
  )
  values (
    p_id,
    'ce000000-0000-0000-0000-000000000000',
    'ce100000-0000-0000-0000-000000000001',
    p_slot,
    current_date + p_day, p_start, p_end, 500,
    p_status::public.booking_status,
    case when p_status = 'confirmed' then 'paid' else 'pending' end
      ::public.payment_status,
    case when p_expires is null then null else now() + p_expires end
  );
$$;

-- A stale hold: pending_payment, expires_at in the past, never swept.
create function pg_temp.stale_hold(
  p_id uuid, p_day integer, p_slot uuid, p_start time, p_end time
)
returns void
language sql
as $$
  select pg_temp.put_booking(
    p_id, p_day, p_slot, p_start, p_end,
    'pending_payment', interval '-1 minute');
$$;

-- Is this backend queued on (or holding) a heavyweight "tuple" lock?
-- PostgreSQL takes it only while waiting to lock a ROW (the stale
-- hold in the sweep). A wait at the exclusion constraint goes
-- straight to the other transaction's id and never takes it, so
-- this tells a sweep wait from an exclusion-constraint wait.
-- (The slot row's FOR SHARE assigns every booking a transaction id
-- before the sweep, so "has a transaction id" no longer does.)
create function pg_temp.in_row_wait(p_pid integer)
returns boolean
language sql
as $$
  select exists (
    select 1 from pg_locks l
    where l.pid = p_pid
      and l.locktype = 'tuple'
  )
$$;

-- Watch ONE remote session until it is observably blocked
-- (optionally on one lock type) or has finished its statement.
create function pg_temp.observe(
  p_conn text,
  p_pid integer,
  p_locktype text,
  p_ticks integer
)
returns text
language plpgsql
as $$
begin
  for i in 1..p_ticks loop
    if exists (
      select 1
      from pg_locks l
      where l.pid = p_pid
        and not l.granted
        and (p_locktype is null or l.locktype = p_locktype)
    ) then
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

create function pg_temp.wait_idle(p_conn text, p_max_ticks integer)
returns boolean
language plpgsql
as $$
begin
  for i in 1..p_max_ticks loop
    if dblink_is_busy(p_conn) = 0 then
      return true;
    end if;
    perform pg_sleep(0.1);
  end loop;
  return false;
end;
$$;

-- Result of an async 3-column statement: 'ok:<first col>' or
-- '<sqlstate>: <message>'. Drains the connection afterwards.
create function pg_temp.res3(p_conn text)
returns text
language plpgsql
as $$
declare
  v_first text;
  v_out text;
begin
  begin
    select t.a
    into v_first
    from dblink_get_result(p_conn) as t(a text, b text, c text);
    v_out := 'ok:' || coalesce(v_first, '');
  exception
    when others then
      v_out := sqlstate || ': ' || sqlerrm;
  end;

  begin
    perform * from dblink_get_result(p_conn) as t(a text, b text, c text);
  exception
    when others then
      null;
  end;

  return v_out;
end;
$$;

-- Active bookings of the test facility on one day.
create function pg_temp.active_count(p_day integer)
returns integer
language sql
as $$
  select count(*)::integer
  from public.bookings
  where facility_id = 'ce100000-0000-0000-0000-000000000001'
    and booking_date = current_date + p_day
    and status in ('pending_payment', 'confirmed', 'completed')
$$;

-- Start a remote customer transaction.
create function pg_temp.begin_as(p_conn text, p_user text)
returns void
language plpgsql
as $$
begin
  perform dblink_exec(
    p_conn,
    format('begin; set local role authenticated; '
           'set local request.jwt.claim.sub = %L', p_user)
  );
end;
$$;


-- Start a customer transaction on p_conn and send create_booking()
-- without waiting for the answer.
create function pg_temp.send_book(
  p_conn text, p_user text, p_slot uuid, p_day integer,
  p_lock_timeout text default null
)
returns void
language plpgsql
as $$
begin
  perform pg_temp.begin_as(p_conn, p_user);

  if p_lock_timeout is not null then
    perform dblink_exec(
      p_conn, format('set local lock_timeout = %L', p_lock_timeout));
  end if;

  perform dblink_send_query(
    p_conn,
    format(
      'select * from public.create_booking(
         %L, %L, current_date + %s)',
      'ce100000-0000-0000-0000-000000000001', p_slot, p_day)
  );
end;
$$;

-- Wait for the booking statement, read its result, end the
-- transaction (an aborted one simply rolls back).
--
-- If the statement is STILL running after the wait, it is cancelled
-- first (reading the result of a running statement would block this
-- whole suite forever) and the result starts with 'TIMEOUT', which
-- matches none of the expected values, so the assertion fails
-- clearly instead of hanging. Cancellation is not retried.
create function pg_temp.collect(p_conn text)
returns text
language plpgsql
as $$
declare
  v_res text;
begin
  perform pg_temp.wait_idle(p_conn, 150);

  if dblink_is_busy(p_conn) = 1 then
    perform dblink_cancel_query(p_conn);
    v_res := 'TIMEOUT: the statement was still running after the wait '
          || 'and was cancelled';

    -- The cancelled statement ends with 57014 (query_canceled), which
    -- WHEN OTHERS does not catch, so it is named here. Reading the
    -- result (and a second time, to drain the connection) leaves the
    -- connection usable for the rollback below.
    begin
      perform * from dblink_get_result(p_conn) as t(a text, b text, c text);
    exception
      when query_canceled then
        null;
      when others then
        null;
    end;

    begin
      perform * from dblink_get_result(p_conn) as t(a text, b text, c text);
    exception
      when query_canceled then
        null;
      when others then
        null;
    end;

    begin
      perform dblink_exec(p_conn, 'rollback');
    exception
      when query_canceled then
        null;
      when others then
        null;
    end;

    return v_res;
  end if;

  v_res := pg_temp.res3(p_conn);
  perform dblink_exec(p_conn, 'commit');
  return v_res;
end;
$$;

-- ------------------------------------------------------------
-- Fixtures (committed) and connections
--
--   Slot Y   08:00-09:00  carries the stale/conflicting rows
--   Slot Z1  20:00-21:00
--   Slot Z2  21:00-22:00
-- ------------------------------------------------------------

do $$
begin
  perform pg_temp.cleanup();

  insert into auth.users (
    id, email, encrypted_password, email_confirmed_at, raw_user_meta_data
  )
  select
    ('ce000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
    'bfc-user' || n || '@example.com', '', now(), '{}'::jsonb
  from generate_series(0, 19) n;

  insert into public.facilities (
    id, owner_id, name, description, sport, address, city, status, base_price
  )
  values (
    'ce100000-0000-0000-0000-000000000001',
    'ce000000-0000-0000-0000-000000000000',
    'Booking Concurrency Facility', 'Temporary database test facility',
    'Football', 'Test Address', 'Test City', 'active', 500
  );

  insert into public.facility_slots (
    id, facility_id, start_time, end_time, duration_min, base_price, is_active
  )
  values
    ('ce200000-0000-0000-0000-000000000001', 'ce100000-0000-0000-0000-000000000001',
     '08:00', '09:00', 60, 500, true),
    ('ce200000-0000-0000-0000-000000000002', 'ce100000-0000-0000-0000-000000000001',
     '20:00', '21:00', 60, 500, true),
    ('ce200000-0000-0000-0000-000000000003', 'ce100000-0000-0000-0000-000000000001',
     '21:00', '22:00', 60, 500, true);

  insert into public.facility_operating_hours (
    facility_id, day_of_week, opens_at, closes_at, is_closed
  )
  select 'ce100000-0000-0000-0000-000000000001', d, '06:00', '22:00', false
  from generate_series(0, 6) d;

  perform dblink_connect('a', pg_temp.conninfo());
  perform dblink_connect('b', pg_temp.conninfo());
  perform dblink_connect('c', pg_temp.conninfo());

  perform set_config('test.pid_a', (select t.p from dblink('a',
    'select pg_backend_pid()::text') as t(p text)), false);
  perform set_config('test.pid_b', (select t.p from dblink('b',
    'select pg_backend_pid()::text') as t(p text)), false);
  perform set_config('test.pid_c', (select t.p from dblink('c',
    'select pg_backend_pid()::text') as t(p text)), false);
end;
$$;

select ok(
  current_setting('test.pid_a') <> current_setting('test.pid_b')
  and current_setting('test.pid_b') <> current_setting('test.pid_c')
  and current_setting('test.pid_a') <> current_setting('test.pid_c'),
  'three independent backend sessions are in use'
);


-- ============================================================
-- E1  An UNRELATED stale hold is locked by the job
--
-- Stale hold X sits on slot Y (08:00-09:00). The expiry job locks
-- it and stays open. A booking for Z1 (20:00-21:00) has no reason
-- to wait for X, and its narrowed sweep does not touch it.
-- ============================================================

do $$
begin
  perform pg_temp.stale_hold('ce300000-0000-0000-0000-000000000001', 11, 'ce200000-0000-0000-0000-000000000001', '08:00', '09:00');
end;
$$;

do $$
begin
  perform dblink_exec('a', 'begin');
  perform set_config('test.e1_job', (select t.r from dblink('a',
    'select public.expire_pending_bookings()::text') as t(r text)), false);
  perform pg_temp.send_book('b', 'ce000000-0000-0000-0000-000000000002', 'ce200000-0000-0000-0000-000000000002', 11);
  perform set_config('test.e1_obs', pg_temp.observe(
    'b', current_setting('test.pid_b')::integer, null, 100), false);
  perform set_config('test.e1_b', pg_temp.collect('b'), false);
  perform dblink_exec('a', 'commit');
end;
$$;

select ok(
  current_setting('test.e1_job')::integer >= 1,
  'E1: the job (uncommitted) holds the unrelated stale hold'
);

select is(
  current_setting('test.e1_obs'),
  'finished',
  'E1: the booking does not wait for an unrelated locked row'
);

select ok(
  current_setting('test.e1_b') like 'ok:%',
  'E1: the booking succeeded while the job''s transaction was open'
);

select is(
  (select status::text from public.bookings where id = 'ce300000-0000-0000-0000-000000000001'),
  'expired',
  'E1: the job expired the unrelated hold'
);

select is(
  pg_temp.active_count(11),
  1,
  'E1: exactly one active booking'
);


-- ============================================================
-- C1  Cross-slot conflicting stale hold, locker COMMITS
--
-- Stale hold H sits on slot Y but its snapshot 20:30-21:30
-- overlaps slot Z1. The expiry job locks it and stays open. A
-- books Z1 meanwhile.
--
-- Correct: the booking waits for the job IN THE SWEEP (a row-lock
-- wait), then H is expired and the booking succeeds.
-- ============================================================

do $$
begin
  perform pg_temp.stale_hold('ce300000-0000-0000-0000-000000000002', 12, 'ce200000-0000-0000-0000-000000000001', '20:30', '21:30');
end;
$$;

do $$
begin
  perform dblink_exec('a', 'begin');
  perform set_config('test.c1_job', (select t.r from dblink('a',
    'select public.expire_pending_bookings()::text') as t(r text)), false);
  perform pg_temp.send_book('b', 'ce000000-0000-0000-0000-000000000003', 'ce200000-0000-0000-0000-000000000002', 12);
  perform set_config('test.c1_obs', pg_temp.observe(
    'b', current_setting('test.pid_b')::integer, 'transactionid', 100), false);
  perform set_config('test.c1_xid',
    pg_temp.in_row_wait(current_setting('test.pid_b')::integer)::text, false);
end;
$$;

select ok(
  current_setting('test.c1_job')::integer >= 1,
  'C1: the job (uncommitted) holds the conflicting stale hold'
);

select is(
  current_setting('test.c1_obs'),
  'waiting',
  'C1: the booking waits for the job'
);

select is(
  current_setting('test.c1_xid'),
  'true',
  'C1: ... in the expiry sweep (a row-lock wait), not at the exclusion constraint'
);

do $$
begin
  perform dblink_exec('a', 'commit');
  perform set_config('test.c1_b', pg_temp.collect('b'), false);
end;
$$;

select ok(
  current_setting('test.c1_b') like 'ok:%',
  'C1: once the job commits, the booking succeeds'
);

select is(
  (select status::text from public.bookings where id = 'ce300000-0000-0000-0000-000000000002'),
  'expired',
  'C1: the stale hold is expired'
);

select is(
  pg_temp.active_count(12),
  1,
  'C1: exactly one active booking'
);


-- ============================================================
-- C2  Cross-slot conflicting stale hold, locker ROLLS BACK
--
-- Same set-up. The job's transaction rolls back, so H stays stale.
--
-- Correct: the booking succeeds IN THE SAME ATTEMPT: its sweep
-- re-checks H, finds it still stale and expires it itself.
-- ============================================================

do $$
begin
  perform pg_temp.stale_hold('ce300000-0000-0000-0000-000000000003', 13, 'ce200000-0000-0000-0000-000000000001', '20:30', '21:30');
end;
$$;

do $$
begin
  perform dblink_exec('a', 'begin');
  perform * from dblink('a',
    'select public.expire_pending_bookings()::text') as t(r text);
  perform pg_temp.send_book('b', 'ce000000-0000-0000-0000-000000000004', 'ce200000-0000-0000-0000-000000000002', 13);
  perform set_config('test.c2_obs', pg_temp.observe(
    'b', current_setting('test.pid_b')::integer, 'transactionid', 100), false);
  perform set_config('test.c2_xid',
    pg_temp.in_row_wait(current_setting('test.pid_b')::integer)::text, false);
end;
$$;

select is(
  current_setting('test.c2_obs'),
  'waiting',
  'C2: the booking waits for the job'
);

select is(
  current_setting('test.c2_xid'),
  'true',
  'C2: ... in the expiry sweep (a row-lock wait)'
);

do $$
begin
  perform dblink_exec('a', 'rollback');
  perform set_config('test.c2_b', pg_temp.collect('b'), false);
end;
$$;

select ok(
  current_setting('test.c2_b') like 'ok:%',
  'C2: after the job rolled back, the SAME attempt succeeds (no 23P01)'
);

select is(
  (select status::text from public.bookings where id = 'ce300000-0000-0000-0000-000000000003'),
  'expired',
  'C2: the booking''s own sweep expired the stale hold'
);

select is(
  pg_temp.active_count(13),
  1,
  'C2: exactly one active booking'
);


-- ============================================================
-- S1/S2  The same cases with the stale hold on the SAME slot
--
-- This is the original behaviour of the slot-only sweep that a
-- facility-wide SKIP LOCKED sweep had regressed.
-- ============================================================

do $$
begin
  perform pg_temp.stale_hold('ce300000-0000-0000-0000-000000000004', 16, 'ce200000-0000-0000-0000-000000000002', '20:00', '21:00');
end;
$$;

do $$
begin
  perform dblink_exec('a', 'begin');
  perform * from dblink('a',
    'select public.expire_pending_bookings()::text') as t(r text);
  perform pg_temp.send_book('b', 'ce000000-0000-0000-0000-000000000009', 'ce200000-0000-0000-0000-000000000002', 16);
  perform set_config('test.s1_obs', pg_temp.observe(
    'b', current_setting('test.pid_b')::integer, 'transactionid', 100), false);
  perform set_config('test.s1_xid',
    pg_temp.in_row_wait(current_setting('test.pid_b')::integer)::text, false);
end;
$$;

select is(
  current_setting('test.s1_obs') || '/' || current_setting('test.s1_xid'),
  'waiting/true',
  'S1: the same-slot booking waits for the job in the sweep'
);

do $$
begin
  perform dblink_exec('a', 'commit');
  perform set_config('test.s1_b', pg_temp.collect('b'), false);
end;
$$;

select ok(
  current_setting('test.s1_b') like 'ok:%'
  and (select status::text from public.bookings where id = 'ce300000-0000-0000-0000-000000000004') = 'expired'
  and pg_temp.active_count(16) = 1,
  'S1: job commits: the booking succeeds and the hold is expired'
);

do $$
begin
  perform pg_temp.stale_hold('ce300000-0000-0000-0000-000000000005', 17, 'ce200000-0000-0000-0000-000000000002', '20:00', '21:00');
end;
$$;

do $$
begin
  perform dblink_exec('a', 'begin');
  perform * from dblink('a',
    'select public.expire_pending_bookings()::text') as t(r text);
  perform pg_temp.send_book('b', 'ce000000-0000-0000-0000-000000000010', 'ce200000-0000-0000-0000-000000000002', 17);
  perform set_config('test.s2_obs', pg_temp.observe(
    'b', current_setting('test.pid_b')::integer, 'transactionid', 100), false);
  perform set_config('test.s2_xid',
    pg_temp.in_row_wait(current_setting('test.pid_b')::integer)::text, false);
end;
$$;

select is(
  current_setting('test.s2_obs') || '/' || current_setting('test.s2_xid'),
  'waiting/true',
  'S2: the same-slot booking waits for the job in the sweep'
);

do $$
begin
  perform dblink_exec('a', 'rollback');
  perform set_config('test.s2_b', pg_temp.collect('b'), false);
end;
$$;

select ok(
  current_setting('test.s2_b') like 'ok:%'
  and (select status::text from public.bookings where id = 'ce300000-0000-0000-0000-000000000005') = 'expired'
  and pg_temp.active_count(17) = 1,
  'S2: job rolls back: the SAME attempt succeeds and expires the hold'
);


-- ============================================================
-- E3a  An in-flight live conflicting booking commits
--
-- A inserts an active booking whose snapshot (20:30-21:30)
-- overlaps slot Z1 and leaves its transaction open. B books Z1.
--
-- Correct: B has nothing stale to sweep, so it waits at the
-- exclusion constraint (no row-lock wait); once
-- A commits B is refused. Overlapping bookings cannot both commit.
-- ============================================================

do $$
begin
  perform dblink_exec('a', 'begin');
  perform dblink_exec(
    'a',
    'insert into public.bookings (
       id, user_id, facility_id, slot_id, booking_date,
       start_time, end_time, amount, status, payment_status)
     values (
       ''ce300000-0000-0000-0000-000000000006'',
       ''ce000000-0000-0000-0000-000000000005'',
       ''ce100000-0000-0000-0000-000000000001'',
       ''ce200000-0000-0000-0000-000000000001'',
       current_date + 14, ''20:30'', ''21:30'', 500,
       ''confirmed'', ''paid'')'
  );

  perform pg_temp.send_book('b', 'ce000000-0000-0000-0000-000000000006', 'ce200000-0000-0000-0000-000000000002', 14);
  perform set_config('test.e3a_obs', pg_temp.observe(
    'b', current_setting('test.pid_b')::integer, 'transactionid', 100), false);
  perform set_config('test.e3a_xid',
    pg_temp.in_row_wait(current_setting('test.pid_b')::integer)::text, false);
end;
$$;

select is(
  current_setting('test.e3a_obs') || '/' || current_setting('test.e3a_xid'),
  'waiting/false',
  'E3a: B waits at the exclusion constraint, not in a row-lock wait'
);

do $$
begin
  perform dblink_exec('a', 'commit');
  perform set_config('test.e3a_b', pg_temp.collect('b'), false);
end;
$$;

select is(
  current_setting('test.e3a_b'),
  '23P01: The selected slot is no longer available',
  'E3a: once the first booking commits, the overlapping one is refused'
);

select is(
  pg_temp.active_count(14),
  1,
  'E3a: only one of the two overlapping bookings committed'
);


-- ============================================================
-- E3b  The conflicting booking rolls back
-- ============================================================

do $$
begin
  perform dblink_exec('a', 'begin');
  perform dblink_exec(
    'a',
    'insert into public.bookings (
       id, user_id, facility_id, slot_id, booking_date,
       start_time, end_time, amount, status, payment_status)
     values (
       ''ce300000-0000-0000-0000-000000000007'',
       ''ce000000-0000-0000-0000-000000000007'',
       ''ce100000-0000-0000-0000-000000000001'',
       ''ce200000-0000-0000-0000-000000000001'',
       current_date + 15, ''20:30'', ''21:30'', 500,
       ''confirmed'', ''paid'')'
  );

  perform pg_temp.send_book('b', 'ce000000-0000-0000-0000-000000000008', 'ce200000-0000-0000-0000-000000000002', 15);
  perform set_config('test.e3b_obs', pg_temp.observe(
    'b', current_setting('test.pid_b')::integer, 'transactionid', 100), false);
end;
$$;

select is(
  current_setting('test.e3b_obs'),
  'waiting',
  'E3b: B waits for the in-flight conflicting booking'
);

do $$
begin
  perform dblink_exec('a', 'rollback');
  perform set_config('test.e3b_b', pg_temp.collect('b'), false);
end;
$$;

select ok(
  current_setting('test.e3b_b') like 'ok:%',
  'E3b: once the first booking rolls back, B succeeds'
);

select is(
  pg_temp.active_count(15),
  1,
  'E3b: exactly one active booking'
);


-- ============================================================
-- L1/L2  A committed LIVE conflict is refused at once
--
-- No stale row exists, so there is nothing to wait for: the
-- request is answered without ever blocking.
-- ============================================================

-- Fixtures are created in their own block so they are COMMITTED
-- before any other connection looks at them.
do $$
begin
  perform pg_temp.put_booking(
    'ce300000-0000-0000-0000-000000000008', 18, 'ce200000-0000-0000-0000-000000000001', '20:30', '21:30', 'confirmed', null);
  perform pg_temp.put_booking(
    'ce300000-0000-0000-0000-000000000009', 19, 'ce200000-0000-0000-0000-000000000001', '20:30', '21:30', 'pending_payment', interval '1 hour');
end;
$$;

do $$
begin
  perform pg_temp.send_book('b', 'ce000000-0000-0000-0000-000000000011', 'ce200000-0000-0000-0000-000000000002', 18);
  perform set_config('test.l1_obs', pg_temp.observe(
    'b', current_setting('test.pid_b')::integer, null, 100), false);
  perform set_config('test.l1_b', pg_temp.collect('b'), false);

  perform pg_temp.send_book('b', 'ce000000-0000-0000-0000-000000000012', 'ce200000-0000-0000-0000-000000000002', 19);
  perform set_config('test.l2_obs', pg_temp.observe(
    'b', current_setting('test.pid_b')::integer, null, 100), false);
  perform set_config('test.l2_b', pg_temp.collect('b'), false);
end;
$$;

select is(
  current_setting('test.l1_obs') || '|' || current_setting('test.l1_b'),
  'finished|23P01: The selected slot is no longer available',
  'L1: a committed confirmed overlapping booking is refused at once'
);

select is(
  current_setting('test.l2_obs') || '|' || current_setting('test.l2_b'),
  'finished|23P01: The selected slot is no longer available',
  'L2: a committed LIVE overlapping hold is refused at once'
);

select is(
  pg_temp.active_count(18) || '/' || pg_temp.active_count(19),
  '1/1',
  'L1/L2: no second overlapping booking was created'
);


-- ============================================================
-- K1  The locker turns the stale hold into a CONFIRMED booking
--
-- (What a payment confirmation would do.) The booking waits for
-- the row, re-evaluates it, finds it confirmed and no longer
-- eligible for expiry, and is then refused by the exclusion
-- constraint. Waiting never lets a booking through a live row.
-- ============================================================

do $$
begin
  perform pg_temp.stale_hold('ce300000-0000-0000-0000-000000000010', 20, 'ce200000-0000-0000-0000-000000000001', '20:30', '21:30');
end;
$$;

do $$
begin
  perform dblink_exec('a', 'begin');
  perform dblink_exec(
    'a',
    'update public.bookings
     set status = ''confirmed'', payment_status = ''paid''
     where id = ''ce300000-0000-0000-0000-000000000010'''
  );
  perform pg_temp.send_book('b', 'ce000000-0000-0000-0000-000000000013', 'ce200000-0000-0000-0000-000000000002', 20);
  perform set_config('test.k1_obs', pg_temp.observe(
    'b', current_setting('test.pid_b')::integer, 'transactionid', 100), false);
  perform set_config('test.k1_xid',
    pg_temp.in_row_wait(current_setting('test.pid_b')::integer)::text, false);
end;
$$;

select is(
  current_setting('test.k1_obs') || '/' || current_setting('test.k1_xid'),
  'waiting/true',
  'K1: the booking waits for the locker in the sweep'
);

do $$
begin
  perform dblink_exec('a', 'commit');
  perform set_config('test.k1_b', pg_temp.collect('b'), false);
end;
$$;

select is(
  current_setting('test.k1_b'),
  '23P01: The selected slot is no longer available',
  'K1: the hold was confirmed, so the booking is refused (no bypass)'
);

select is(
  (select status::text from public.bookings where id = 'ce300000-0000-0000-0000-000000000010')
  || '/' || pg_temp.active_count(20),
  'confirmed/1',
  'K1: the confirmed booking is untouched and is the only active one'
);


-- ============================================================
-- M1  Several stale rows, two customers: no deadlock
--
-- Stale holds on slot Y:
--   Ra  20:10-20:20   overlaps Z1 only
--   Rb  20:59-21:01   overlaps BOTH Z1 and Z2
-- (Two ACTIVE rows may not overlap each other, so at most one
-- hold can ever be shared by the sweeps of two adjacent slots;
-- ORDER BY id is therefore defensive, and this scenario checks
-- the multi-row queueing, not an unordered deadlock.)
--
-- A locks Rb and stays open. B books Z1: its sweep locks Ra, then
-- waits for Rb. C books Z2: its sweep waits for Rb. Once A commits
-- B expires both rows and books; C then re-checks Rb (now expired
-- and committed by B) and books too.
-- ============================================================

do $$
begin
  perform pg_temp.stale_hold('ce300000-0000-0000-0000-000000000011', 21, 'ce200000-0000-0000-0000-000000000001', '20:10', '20:20');
  perform pg_temp.stale_hold('ce300000-0000-0000-0000-000000000012', 21, 'ce200000-0000-0000-0000-000000000001', '20:59', '21:01');
end;
$$;

do $$
begin
  perform dblink_exec('a', 'begin');
  perform dblink_exec(
    'a',
    'update public.bookings set updated_at = now()
     where id = ''ce300000-0000-0000-0000-000000000012'''
  );
  perform pg_temp.send_book('b', 'ce000000-0000-0000-0000-000000000014', 'ce200000-0000-0000-0000-000000000002', 21);
  perform pg_temp.send_book('c', 'ce000000-0000-0000-0000-000000000015', 'ce200000-0000-0000-0000-000000000003', 21);
  -- Two sessions queued on ONE locked row: the first waits on the
  -- owner's transaction id, the second on the row's heavyweight
  -- "tuple" lock behind it. Their slots and users differ, so no
  -- other lock can be contended: any ungranted lock is that wait.
  perform set_config('test.m1_obs_b', pg_temp.observe(
    'b', current_setting('test.pid_b')::integer, null, 100), false);
  perform set_config('test.m1_obs_c', pg_temp.observe(
    'c', current_setting('test.pid_c')::integer, null, 100), false);
end;
$$;

select is(
  current_setting('test.m1_obs_b') || '/' || current_setting('test.m1_obs_c'),
  'waiting/waiting',
  'M1: both customers are blocked behind the locked stale row'
);

do $$
begin
  perform dblink_exec('a', 'commit');
  perform set_config('test.m1_b', pg_temp.collect('b'), false);
  perform set_config('test.m1_c', pg_temp.collect('c'), false);
end;
$$;

select ok(
  current_setting('test.m1_b') like 'ok:%'
  and current_setting('test.m1_c') like 'ok:%',
  'M1: both bookings succeed, with no deadlock (no 40P01)'
);

select is(
  (select count(*)::text from public.bookings
   where id in ('ce300000-0000-0000-0000-000000000011', 'ce300000-0000-0000-0000-000000000012') and status = 'expired')
  || '/' || pg_temp.active_count(21),
  '2/2',
  'M1: both stale holds are expired and both bookings exist'
);


-- ============================================================
-- P1  The locker is process_waitlist()
--
-- process_waitlist() runs the expiry and then the offer loop in
-- ONE transaction, so it holds the stale row locks for the whole
-- run. It also acts on every waiting entry in the database, so
-- this scenario only runs when this test facility owns all of
-- them; otherwise it is skipped with a note.
-- ============================================================

select (
  select count(*) = 0
  from public.waitlist_entries
  where facility_id <> 'ce100000-0000-0000-0000-000000000001'
    and status in ('waiting', 'offered')
) as p1_ok
\gset

\if :p1_ok

do $$
begin
  perform pg_temp.stale_hold('ce300000-0000-0000-0000-000000000013', 22, 'ce200000-0000-0000-0000-000000000001', '20:30', '21:30');
  -- a waiting entry behind a confirmed booking, so the job's offer
  -- loop really iterates (nothing can be offered: the slot is taken)
  perform pg_temp.put_booking(
    'ce300000-0000-0000-0000-000000000014', 23, 'ce200000-0000-0000-0000-000000000003', '21:00', '22:00', 'confirmed', null);
  insert into public.waitlist_entries (user_id, facility_id, slot_id, booking_date)
  values (
    'ce000000-0000-0000-0000-000000000017',
    'ce100000-0000-0000-0000-000000000001',
    'ce200000-0000-0000-0000-000000000003',
    current_date + 23
  );
end;
$$;

do $$
begin
  perform dblink_exec('a', 'begin');
  perform * from dblink('a',
    'select public.process_waitlist()::text') as t(r text);
  perform pg_temp.send_book('b', 'ce000000-0000-0000-0000-000000000016', 'ce200000-0000-0000-0000-000000000002', 22);
  perform set_config('test.p1_obs', pg_temp.observe(
    'b', current_setting('test.pid_b')::integer, 'transactionid', 100), false);
  perform set_config('test.p1_xid',
    pg_temp.in_row_wait(current_setting('test.pid_b')::integer)::text, false);
end;
$$;

select is(
  current_setting('test.p1_obs') || '/' || current_setting('test.p1_xid'),
  'waiting/true',
  'P1: the booking waits for process_waitlist() in the sweep'
);

do $$
begin
  perform dblink_exec('a', 'commit');
  perform set_config('test.p1_b', pg_temp.collect('b'), false);
end;
$$;

select ok(
  current_setting('test.p1_b') like 'ok:%'
  and (select status::text from public.bookings where id = 'ce300000-0000-0000-0000-000000000013') = 'expired',
  'P1: once process_waitlist() commits, the booking succeeds'
);

select is(
  (select status::text from public.waitlist_entries
   where user_id = 'ce000000-0000-0000-0000-000000000017'),
  'waiting',
  'P1: the unrelated waiting entry is untouched (its slot is still taken)'
);

\else

select skip(
  'P1 skipped: other waiting/offered waitlist entries exist in this database and process_waitlist() would act on them',
  3
);

\endif


-- ============================================================
-- T1  A short lock_timeout
--
-- The wait is bounded. With lock_timeout = 300ms the booking
-- fails with 55P03 (lock_not_available), and neither the stale
-- hold nor the bookings table is changed by the failed attempt.
-- ============================================================

do $$
begin
  perform pg_temp.stale_hold('ce300000-0000-0000-0000-000000000015', 24, 'ce200000-0000-0000-0000-000000000001', '20:30', '21:30');
end;
$$;

do $$
begin
  perform dblink_exec('a', 'begin');
  perform * from dblink('a',
    'select public.expire_pending_bookings()::text') as t(r text);
  perform pg_temp.send_book('b', 'ce000000-0000-0000-0000-000000000018', 'ce200000-0000-0000-0000-000000000002', 24, '300ms');
  perform set_config('test.t1_b', pg_temp.collect('b'), false);
  perform dblink_exec('a', 'rollback');
end;
$$;

select ok(
  current_setting('test.t1_b') like '55P03:%',
  'T1: the wait is bounded by lock_timeout (55P03)'
);

select is(
  (select status::text from public.bookings where id = 'ce300000-0000-0000-0000-000000000015')
  || '/' ||
  (select count(*)::text from public.bookings where user_id = 'ce000000-0000-0000-0000-000000000018'),
  'pending_payment/0',
  'T1: the failed attempt changed nothing (hold untouched, no booking)'
);


-- ------------------------------------------------------------
-- Teardown
-- ------------------------------------------------------------

do $$
declare
  v_conn text;
begin
  foreach v_conn in array array['a', 'b', 'c'] loop
    begin
      perform dblink_disconnect(v_conn);
    exception
      when others then
        null;
    end;
  end loop;

  perform pg_temp.cleanup();
end;
$$;

select pg_temp.release_dblink();

select * from finish();

\else

select plan(1);
select fail('booking facility concurrency test cannot run: ' || :'prereq_msg');
select diag('No fixtures were created. Fix the prerequisite above and re-run.');
select * from finish();

\endif

\else

select plan(1);
select fail('booking facility concurrency test REFUSED to run: this database is not '
  || 'positively identified as the local Supabase development stack '
  || '(database=' || :'env_db' || ', server address=' || :'env_addr' || ').');
select diag('This file commits fixture rows, so it only runs against the local stack started by `supabase start` with the default config.');
select diag('Run it with: supabase test db   (not --linked and not a remote --db-url).');
select diag('Nothing was created or committed.');
select * from finish();

\endif
