-- ============================================================
-- cancel_booking() concurrency tests (REAL multi-session)
--
-- Like waitlist_concurrency_test.sql this file does not run inside
-- one transaction. It opens separate connections with dblink and
-- drives the real functions through deterministic interleavings:
--
--   conn a, b  ->  two independent transactions
--
-- Scenarios
--   C1  a cancel is in flight, another user books the freed slot
--   C2  the same booking is cancelled twice at once
--   C3  the expiry sweep runs while a cancel holds the row
--   C4  a cancel runs while the expiry sweep holds the row
--
-- Every "is waiting" assertion looks at pg_locks for the backend pid
-- of that session, never at a sleep.
--
-- ------------------------------------------------------------
-- SAFETY: this file COMMITS rows (and may install dblink).
-- ------------------------------------------------------------
-- It refuses to run unless the target database positively
-- identifies itself as the local Supabase development stack:
-- database "postgres", a loopback/private server address, and the
-- well-known default local jwt secret. Anything else produces ONE
-- failing test BEFORE anything is created or committed.
-- Limits: a convention, not proof (see waitlist_concurrency_test.sql).
-- Run it only as:  supabase test db   (local stack; not --linked).
--
-- dblink: used if present and NEVER dropped. If this file installs
-- it, it tags the extension with a catalog comment and drops it
-- again only when that tag is present, without CASCADE.
--
-- Fixtures use ids prefixed cd... Leftovers from an interrupted run
-- are removed at the start of the next run, and again at the end.
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
  select 'unisport-test-harness: installed by cancel_booking_concurrency_test.sql; safe to drop'
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
        raise warning 'dblink installed by the cancel_booking test harness was left in place: %', sqlerrm;
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
  if to_regprocedure('public.cancel_booking(uuid)') is null
     or to_regprocedure('public.create_booking(uuid,uuid,date)') is null
     or to_regprocedure('public.expire_pending_bookings()') is null
     or to_regclass('public.payment_attempts') is null then
    return 'the cancel_booking migration (and the payment migrations it follows) '
        || 'are not applied to this database; apply them first (supabase migration up).';
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

select plan(15);


-- ------------------------------------------------------------
-- Helpers (session-local)
-- ------------------------------------------------------------

create function pg_temp.cleanup()
returns void
language sql
as $$
  delete from public.waitlist_entries where facility_id = 'cd100000-0000-0000-0000-000000000001';
  delete from public.payment_attempts
  where booking_id in (select id from public.bookings where facility_id = 'cd100000-0000-0000-0000-000000000001');
  delete from public.bookings where facility_id = 'cd100000-0000-0000-0000-000000000001';
  delete from public.facility_slots where facility_id = 'cd100000-0000-0000-0000-000000000001';
  delete from public.facilities where id = 'cd100000-0000-0000-0000-000000000001';
  delete from auth.users where id::text like 'cd000000-%';
$$;

create function pg_temp.slot_id(n integer) returns uuid
language sql as $$ select ('cd200000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid; $$;

create function pg_temp.user_id(n integer) returns uuid
language sql as $$ select ('cd000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid; $$;

-- Advisory lock keys, identical to the ones the functions take.
create function pg_temp.slot_key(p_slot integer, p_day integer) returns bigint
language sql as $$
  select hashtextextended(pg_temp.slot_id(p_slot)::text || ':' || (current_date + p_day)::text, 0)
$$;

create function pg_temp.user_key(p_user integer) returns bigint
language sql as $$
  select hashtextextended('user-actions:' || pg_temp.user_id(p_user)::text, 0)
$$;

-- A committed unpaid hold for user p_user on slot p_slot, p_day days
-- ahead. p_expires is relative to now(), in seconds.
create function pg_temp.hold(p_user integer, p_slot integer, p_day integer, p_expires integer)
returns uuid
language plpgsql
as $$
declare v_id uuid;
begin
  insert into public.bookings (
    user_id, facility_id, slot_id, booking_date, start_time, end_time,
    amount, status, payment_status, expires_at
  )
  values (
    pg_temp.user_id(p_user), 'cd100000-0000-0000-0000-000000000001', pg_temp.slot_id(p_slot),
    current_date + p_day, time '18:00' + (p_slot - 1) * interval '1 hour',
    time '19:00' + (p_slot - 1) * interval '1 hour',
    500, 'pending_payment', 'pending', now() + make_interval(secs => p_expires)
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- Watch ONE remote session until it is observably waiting, or has
-- finished its statement.
--   'advisory'  waiting on the advisory lock with key p_key
--   'row'       waiting for another transaction (a row lock)
--   'finished'  the statement completed without ever waiting
--   'timeout'   neither within p_ticks * 0.05s
create function pg_temp.observe(p_conn text, p_pid integer, p_key bigint, p_ticks integer)
returns text
language plpgsql
as $$
begin
  for i in 1..p_ticks loop
    if exists (
      select 1 from pg_locks l
      where l.pid = p_pid and l.locktype = 'advisory' and not l.granted
        and ((l.classid::bigint << 32) | l.objid::bigint) = p_key
    ) then
      return 'advisory';
    end if;

    if exists (
      select 1 from pg_locks l
      where l.pid = p_pid and not l.granted and l.locktype in ('transactionid', 'tuple')
    ) then
      return 'row';
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

-- Result of an async single-column statement: 'ok:<value>' or
-- '<sqlstate>: <message>'. Drains the connection afterwards.
create function pg_temp.res1(p_conn text)
returns text
language plpgsql
as $$
declare
  v_first text;
  v_out text;
begin
  begin
    select t.a into v_first from dblink_get_result(p_conn) as t(a text);
    v_out := 'ok:' || coalesce(v_first, '');
  exception
    when others then
      v_out := sqlstate || ': ' || sqlerrm;
  end;

  begin
    perform * from dblink_get_result(p_conn) as t(a text);
  exception
    when others then
      null;
  end;

  return v_out;
end;
$$;


-- ------------------------------------------------------------
-- Fixtures (committed) and connections
-- ------------------------------------------------------------

do $$
begin
  perform pg_temp.cleanup();

  insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
  select
    pg_temp.user_id(n), 'cancel-conc-user' || n || '@example.com', '', now(),
    jsonb_build_object('full_name', 'Cancel Concurrency User ' || n)
  from generate_series(0, 8) n;

  insert into public.facilities (id, owner_id, name, description, sport, address, city, status, base_price)
  values (
    'cd100000-0000-0000-0000-000000000001', pg_temp.user_id(0),
    'Cancel Concurrency Facility', 'Temporary database test facility',
    'Football', 'Test Address', 'Test City', 'active', 500
  );

  insert into public.facility_slots (id, facility_id, start_time, end_time, duration_min, base_price, is_active)
  select
    pg_temp.slot_id(n), 'cd100000-0000-0000-0000-000000000001',
    time '18:00' + (n - 1) * interval '1 hour', time '19:00' + (n - 1) * interval '1 hour',
    60, 500, true
  from generate_series(1, 4) n;

  insert into public.facility_operating_hours (facility_id, day_of_week, opens_at, closes_at, is_closed)
  select 'cd100000-0000-0000-0000-000000000001', d, '08:00', '23:59', false
  from generate_series(0, 6) d;

  perform dblink_connect('a', pg_temp.conninfo());
  perform dblink_connect('b', pg_temp.conninfo());

  perform set_config('test.pid_a', (select t.p from dblink('a', 'select pg_backend_pid()::text') as t(p text)), false);
  perform set_config('test.pid_b', (select t.p from dblink('b', 'select pg_backend_pid()::text') as t(p text)), false);
end;
$$;


-- ============================================================
-- C1  A cancel is in flight; another user books the freed slot
--
-- A: U1 cancels (uncommitted). The cancel takes the per-slot
--    advisory lock through the waitlist offer call.
-- B: U2 books the same slot and date meanwhile.
--
-- Correct: B waits on the slot lock, and once the cancel commits
-- the slot is free: B gets it. Vulnerable: B is refused ("taken")
-- or ends up double-booked.
-- ============================================================

do $$
begin
  perform set_config('test.c1', pg_temp.hold(1, 1, 3, 3600)::text, false);
  perform dblink_exec('a', 'begin; set local role authenticated');
  perform dblink_exec('a', format('set local request.jwt.claim.sub = %L', pg_temp.user_id(1)));
end;
$$;

select is(
  (select t.r from dblink('a', format('select public.cancel_booking(%L)::text', current_setting('test.c1'))) as t(r text)),
  'cancelled',
  'C1: the cancel succeeds (its transaction stays open)'
);

do $$
begin
  perform dblink_exec('b', 'begin; set local role authenticated');
  perform dblink_exec('b', format('set local request.jwt.claim.sub = %L', pg_temp.user_id(2)));
  perform dblink_send_query('b', format(
    'select booking_id::text from public.create_booking(%L, %L, current_date + 3)',
    'cd100000-0000-0000-0000-000000000001', pg_temp.slot_id(1)));
  perform set_config('test.c1_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, pg_temp.slot_key(1, 3), 100), false);
end;
$$;

select is(
  current_setting('test.c1_obs'),
  'advisory',
  'C1: create_booking() waits on the slot lock while the cancel is in flight'
);

do $$
begin
  perform dblink_exec('a', 'commit');
  perform pg_temp.wait_idle('b', 50);
  perform set_config('test.c1_res', pg_temp.res1('b'), false);
  perform dblink_exec('b', 'commit');
end;
$$;

select ok(
  current_setting('test.c1_res') like 'ok:%',
  'C1: once the cancel commits, the other user gets the freed slot'
);

select is(
  (select string_agg(status::text || ':' || (user_id = pg_temp.user_id(2))::text, ',' order by status::text)
   from public.bookings
   where slot_id = pg_temp.slot_id(1) and booking_date = current_date + 3),
  'cancelled:false,pending_payment:true',
  'C1: one cancelled booking and exactly one live booking (the new user''s)'
);


-- ============================================================
-- C2  The same booking is cancelled twice at once
--
-- U3 holds slot 2; U4 waits for it. A: U3 cancels (uncommitted).
-- B: U3 cancels the same booking again.
--
-- Correct: B waits on the user lock, then finds the booking
-- already cancelled and returns it without writing; U4 is offered
-- the slot exactly once.
-- ============================================================

do $$
begin
  perform set_config('test.c2', pg_temp.hold(3, 2, 4, 3600)::text, false);

  perform set_config('request.jwt.claim.sub', pg_temp.user_id(4)::text, false);
  perform public.join_waitlist('cd100000-0000-0000-0000-000000000001', pg_temp.slot_id(2), current_date + 4);
  perform set_config('request.jwt.claim.sub', '', false);

  perform dblink_exec('a', 'begin; set local role authenticated');
  perform dblink_exec('a', format('set local request.jwt.claim.sub = %L', pg_temp.user_id(3)));
end;
$$;

select is(
  (select t.r from dblink('a', format('select public.cancel_booking(%L)::text', current_setting('test.c2'))) as t(r text)),
  'cancelled',
  'C2: the first cancel succeeds (its transaction stays open)'
);

do $$
begin
  perform dblink_exec('b', 'begin; set local role authenticated');
  perform dblink_exec('b', format('set local request.jwt.claim.sub = %L', pg_temp.user_id(3)));
  perform dblink_send_query('b', format('select public.cancel_booking(%L)::text', current_setting('test.c2')));
  perform set_config('test.c2_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, pg_temp.user_key(3), 100), false);
end;
$$;

select is(
  current_setting('test.c2_obs'),
  'advisory',
  'C2: the second cancel waits on the user lock'
);

do $$
begin
  perform dblink_exec('a', 'commit');
  perform pg_temp.wait_idle('b', 50);
  perform set_config('test.c2_res', pg_temp.res1('b'), false);
  perform dblink_exec('b', 'commit');
end;
$$;

select is(
  current_setting('test.c2_res'),
  'ok:cancelled',
  'C2: the second cancel returns cancelled without an error'
);

select is(
  (select count(*)::text from public.waitlist_entries
   where slot_id = pg_temp.slot_id(2) and booking_date = current_date + 4 and status = 'offered')
  || '/' ||
  (select status::text from public.bookings where id = current_setting('test.c2')::uuid),
  '1/cancelled',
  'C2: exactly one offer was issued and the booking is cancelled'
);


-- ============================================================
-- C3  The expiry sweep runs while a cancel holds the row
--
-- U5's hold has run out by the clock. A: U5 cancels (reports
-- expired, holds the row lock). B: the sweep runs.
--
-- Correct: the sweep skips the locked row and finishes at once
-- (it never waits); after A commits the next sweep expires it.
-- ============================================================

do $$
begin
  perform set_config('test.c3', pg_temp.hold(5, 3, 5, -60)::text, false);
  perform dblink_exec('a', 'begin; set local role authenticated');
  perform dblink_exec('a', format('set local request.jwt.claim.sub = %L', pg_temp.user_id(5)));
end;
$$;

select is(
  (select t.r from dblink('a', format('select public.cancel_booking(%L)::text', current_setting('test.c3'))) as t(r text)),
  'expired',
  'C3: cancelling a lapsed hold reports expired (the row stays locked)'
);

do $$
begin
  perform dblink_send_query('b', 'select public.expire_pending_bookings()::text');
  perform set_config('test.c3_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, 0, 100), false);
  perform set_config('test.c3_sweep', pg_temp.res1('b'), false);
end;
$$;

select is(
  current_setting('test.c3_obs'),
  'finished',
  'C3: the sweep does not wait for the in-flight cancel'
);

select is(
  (select status::text from public.bookings where id = current_setting('test.c3')::uuid),
  'pending_payment',
  'C3: the locked row was skipped by the sweep'
);

do $$
begin
  perform dblink_exec('a', 'commit');
  perform public.expire_pending_bookings();
end;
$$;

select is(
  (select status::text from public.bookings where id = current_setting('test.c3')::uuid),
  'expired',
  'C3: after the cancel commits, the next sweep expires the row'
);


-- ============================================================
-- C4  A cancel runs while the expiry sweep holds the row
--
-- U6's hold has run out. A: the sweep expires it (uncommitted,
-- row locked). B: U6 cancels.
--
-- Correct: B waits for the sweep, then finds the booking expired
-- and reports it, writing nothing. Never "cancelled".
-- ============================================================

-- Fixture in its own block, so it is COMMITTED before the other
-- connections look at it.
do $$
begin
  perform set_config('test.c4', pg_temp.hold(6, 4, 6, -60)::text, false);
end;
$$;

do $$
begin
  perform dblink_exec('a', 'begin');
  perform * from dblink('a', 'select public.expire_pending_bookings()::text') as t(r text);
  perform dblink_exec('b', 'begin; set local role authenticated');
  perform dblink_exec('b', format('set local request.jwt.claim.sub = %L', pg_temp.user_id(6)));
  perform dblink_send_query('b', format('select public.cancel_booking(%L)::text', current_setting('test.c4')));
  perform set_config('test.c4_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, pg_temp.user_key(6), 100), false);
end;
$$;

select is(
  current_setting('test.c4_obs'),
  'row',
  'C4: the cancel waits for the in-flight sweep on the same row'
);

do $$
begin
  perform dblink_exec('a', 'commit');
  perform pg_temp.wait_idle('b', 50);
  perform set_config('test.c4_res', pg_temp.res1('b'), false);
  perform dblink_exec('b', 'commit');
end;
$$;

select is(
  current_setting('test.c4_res'),
  'ok:expired',
  'C4: once the sweep commits, the cancel reports expired'
);

select is(
  (select status::text || ':' || (cancelled_at is null)::text
   from public.bookings where id = current_setting('test.c4')::uuid),
  'expired:true',
  'C4: the booking is expired and was never marked cancelled'
);


-- ------------------------------------------------------------
-- Teardown
-- ------------------------------------------------------------

do $$
declare
  v_conn text;
begin
  foreach v_conn in array array['a', 'b'] loop
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
select fail('cancel_booking concurrency test cannot run: ' || :'prereq_msg');
select diag('No fixtures were created. Fix the prerequisite above and re-run.');
select * from finish();

\endif

\else

select plan(1);
select fail('cancel_booking concurrency test REFUSED to run: this database is not '
  || 'positively identified as the local Supabase development stack '
  || '(database=' || :'env_db' || ', server address=' || :'env_addr' || ').');
select diag('This file commits fixture rows, so it only runs against the local stack started by `supabase start` with the default config.');
select diag('Run it with: supabase test db   (not --linked and not a remote --db-url).');
select diag('Nothing was created or committed.');
select * from finish();

\endif
