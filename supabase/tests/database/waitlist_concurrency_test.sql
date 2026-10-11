-- ============================================================
-- Waitlist concurrency regression tests (REAL multi-session)
--
-- Unlike the other test files this one does not run inside a
-- single transaction. It opens several separate database
-- connections with dblink and drives the real functions through
-- deterministic interleavings:
--
--   conn a, b, h, x, y  ->  five independent transactions
--
-- Scenarios
--   S1  offer decision in flight, other user books  (original race)
--   S2  booking in flight, worker decides
--   S3  direct booking + accept by the same user    (deadlock)
--   S4  offer decision rolls back, booking proceeds
--   S5  same user, two slots, at 2 holds            (hold cap race)
--   S6  same user, two waitlists, at 9 entries      (entry cap race)
--   S7  accept first, then direct booking           (deadlock, other order)
--   S8  a different user is not blocked
--
-- Lock order enforced by the functions (user -> slot -> entry row):
-- S5/S6/S8 observe the user lock, S3/S7 prove that the two orders
-- of start cannot deadlock.
--
-- Every "is waiting" assertion is made by looking at pg_locks
-- for that session's backend pid, not by sleeping.
--
-- ------------------------------------------------------------
-- SAFETY: this file COMMITS rows (and may install dblink).
-- ------------------------------------------------------------
-- It refuses to run unless the target database positively
-- identifies itself as the local Supabase development stack:
--
--   * database name is "postgres"
--   * the server address is loopback or private
--   * app.settings.jwt_secret is the well-known default of the
--     Supabase CLI's local stack (a hosted/linked project always
--     has its own random secret)
--
-- Anything else -- including `supabase test db --linked` or a
-- remote --db-url -- produces ONE failing test with an
-- explanation, BEFORE anything is created or committed.
--
-- Limits of this check: it is a convention, not proof. A remote
-- database deliberately configured with the public default
-- secret would pass; a local stack with a customised
-- [auth] jwt_secret is refused (fail closed). Run it only as:
--
--     supabase test db            (local stack, default config)
--
-- The file uses psql \if/\gset, which pg_prove (and therefore
-- `supabase test db`) runs through psql.
--
-- ------------------------------------------------------------
-- Prerequisites (checked before any assertion or fixture)
-- ------------------------------------------------------------
--   * the dblink extension is installed or installable by the
--     running role
--   * dblink can open a password-authenticated connection back
--     to this database (default password "postgres"; override
--     with: set test.db_password = '...';)
--   * the waitlist migrations are applied
--
-- ------------------------------------------------------------
-- dblink ownership
-- ------------------------------------------------------------
-- If dblink already exists the harness uses it and NEVER drops
-- it. If the harness installs it, it tags the extension with a
-- catalog comment in the same transaction as CREATE EXTENSION,
-- so ownership survives an interrupted run. The teardown (and
-- the next run after an interruption) drops dblink only when
-- that tag is present, without CASCADE: if anything depends on
-- it, the drop is skipped with a warning.
--
-- ------------------------------------------------------------
-- Fixtures
-- ------------------------------------------------------------
-- Rows use ids prefixed cc... so they are recognisable. Leftovers
-- from an interrupted run are removed at the start of the next
-- run, and everything is removed again at the end.
-- ============================================================


-- ------------------------------------------------------------
-- Stage 1: environment guard. Plain SQL that cannot itself
-- fail; nothing has been created or committed yet.
-- ------------------------------------------------------------

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

-- ------------------------------------------------------------
-- Stage 2: prerequisites. Everything that can go wrong is
-- caught and turned into one message.
-- ------------------------------------------------------------

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

-- Catalog marker proving the harness installed dblink.
create function pg_temp.dblink_marker()
returns text
language sql
as $$
  select 'unisport-test-harness: installed by waitlist_concurrency_test.sql; safe to drop'
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
          'dblink installed by the waitlist test harness was left in place: %',
          sqlerrm;
    end;
  end if;
end;
$$;

-- Returns 'ok', or one actionable sentence describing what is missing.
create function pg_temp.prereq()
returns text
language plpgsql
as $$
declare
  v_created boolean := false;
begin
  if to_regclass('public.waitlist_entries') is null
     or to_regprocedure('public.offer_next_waitlist_entry(uuid,date)') is null
     or to_regprocedure('public.accept_waitlist_offer(uuid)') is null
     or to_regprocedure('public.create_booking(uuid,uuid,date)') is null then
    return 'the waitlist migrations are not applied to this database; '
        || 'apply them first (supabase migration up).';
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

select plan(27);


-- ------------------------------------------------------------
-- Helpers (session-local; vanish with the session)
-- ------------------------------------------------------------

create function pg_temp.cleanup()
returns void
language sql
as $$
  delete from public.waitlist_entries
  where facility_id = 'cc100000-0000-0000-0000-000000000001';
  delete from public.bookings
  where facility_id = 'cc100000-0000-0000-0000-000000000001';
  delete from public.facility_slots
  where facility_id = 'cc100000-0000-0000-0000-000000000001';
  delete from public.facilities
  where id = 'cc100000-0000-0000-0000-000000000001';
  delete from auth.users
  where id::text like 'cc000000-%';
$$;

-- Lock key, identical to the one used by the functions.
create function pg_temp.slot_key(p_day integer)
returns bigint
language sql
as $$
  select hashtextextended(
    'cc200000-0000-0000-0000-000000000001' || ':'
      || (current_date + p_day)::text,
    0
  )
$$;

-- Per-user advisory lock key, identical to the one used by the
-- functions (create_booking, join_waitlist, accept_waitlist_offer).
create function pg_temp.user_key(p_user uuid)
returns bigint
language sql
as $$
  select hashtextextended('user-actions:' || p_user::text, 0)
$$;

-- Make the slot busy, queue p_user behind it, free the slot.
-- Returns the new entry id.
create function pg_temp.queue_user(p_day integer, p_user uuid)
returns uuid
language plpgsql
as $$
declare
  v_booking uuid;
  v_entry uuid;
begin
  insert into public.bookings (
    user_id, facility_id, slot_id, booking_date,
    start_time, end_time, amount, status, payment_status
  )
  values (
    'cc000000-0000-0000-0000-000000000001',
    'cc100000-0000-0000-0000-000000000001',
    'cc200000-0000-0000-0000-000000000001',
    current_date + p_day, '18:00', '19:00', 500,
    'confirmed', 'paid'
  )
  returning id into v_booking;

  perform set_config('request.jwt.claim.sub', p_user::text, false);

  select j.entry_id
  into v_entry
  from public.join_waitlist(
    'cc100000-0000-0000-0000-000000000001',
    'cc200000-0000-0000-0000-000000000001',
    current_date + p_day
  ) j;

  perform set_config('request.jwt.claim.sub', '', false);

  update public.bookings
  set status = 'cancelled', cancelled_at = now()
  where id = v_booking;

  return v_entry;
end;
$$;

-- Watch ONE remote session until it is observably waiting on the
-- given advisory lock key, or has finished its statement.
--
--   'waiting'   the session (by backend pid) is blocked in
--               pg_locks on that advisory key
--   'finished'  the statement completed without ever being seen
--               waiting
--   'timeout'   neither happened within p_ticks * 0.05s
--
-- This replaces fixed sleeps: it proves the remote transaction
-- really reached the intended wait, however slow the machine.
create function pg_temp.observe(
  p_conn text,
  p_pid integer,
  p_key bigint,
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
        and l.locktype = 'advisory'
        and not l.granted
        and ((l.classid::bigint << 32) | l.objid::bigint) = p_key
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

-- Wait (at most p_max_ticks * 0.1s) until both connections have
-- finished their statement.
create function pg_temp.wait_idle(p_c1 text, p_c2 text, p_max_ticks integer)
returns boolean
language plpgsql
as $$
begin
  for i in 1..p_max_ticks loop
    if dblink_is_busy(p_c1) = 0 and dblink_is_busy(p_c2) = 0 then
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

-- Same for a statement returning one column.
create function pg_temp.res1(p_conn text)
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
    from dblink_get_result(p_conn) as t(a text);
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

  insert into auth.users (
    id, email, encrypted_password, email_confirmed_at, raw_user_meta_data
  )
  select
    ('cc000000-0000-0000-0000-00000000000' || n)::uuid,
    'wl-conc-user' || n || '@example.com',
    '',
    now(),
    jsonb_build_object('full_name', 'Waitlist Concurrency User ' || n)
  from generate_series(0, 9) n;

  insert into public.facilities (
    id, owner_id, name, description, sport, address, city, status, base_price
  )
  values (
    'cc100000-0000-0000-0000-000000000001',
    'cc000000-0000-0000-0000-000000000000',
    'Waitlist Concurrency Facility',
    'Temporary database test facility',
    'Football',
    'Test Address',
    'Test City',
    'active',
    500
  );

  insert into public.facility_slots (
    id, facility_id, start_time, end_time, duration_min, base_price, is_active
  )
  values (
    'cc200000-0000-0000-0000-000000000001',
    'cc100000-0000-0000-0000-000000000001',
    '18:00', '19:00', 60, 500, true
  );

  insert into public.facility_operating_hours (
    facility_id, day_of_week, opens_at, closes_at, is_closed
  )
  select 'cc100000-0000-0000-0000-000000000001', d, '08:00', '22:00', false
  from generate_series(0, 6) d;

  -- Extra slots 02..11 (08:00 .. 17:00) for the cap scenarios:
  --   02,03  U8's two existing holds (S5)
  --   04,05  the two slots U8 books concurrently (S5)
  --   06,07  two different users book different slots (S8)
  --   08     nine existing waitlist entries of U9, one per date (S6)
  --   09,10  the two slots U9 joins concurrently (S6)
  insert into public.facility_slots (
    id, facility_id, start_time, end_time, duration_min, base_price, is_active
  )
  select
    ('cc200000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
    'cc100000-0000-0000-0000-000000000001',
    time '08:00' + (n - 2) * interval '1 hour',
    time '09:00' + (n - 2) * interval '1 hour',
    60, 500, true
  from generate_series(2, 11) n;

  -- S5: U8 already holds two live unpaid slots on current_date + 9.
  insert into public.bookings (
    user_id, facility_id, slot_id, booking_date, start_time, end_time,
    amount, status, payment_status, expires_at
  )
  select
    'cc000000-0000-0000-0000-000000000008',
    'cc100000-0000-0000-0000-000000000001',
    ('cc200000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
    current_date + 9,
    time '08:00' + (n - 2) * interval '1 hour',
    time '09:00' + (n - 2) * interval '1 hour',
    500, 'pending_payment', 'pending', now() + interval '1 hour'
  from generate_series(2, 3) n;

  -- S6: U9 already has nine active waitlist entries (slot 08, one
  -- per date, current_date + 10 .. + 18).
  insert into public.waitlist_entries (
    user_id, facility_id, slot_id, booking_date
  )
  select
    'cc000000-0000-0000-0000-000000000009',
    'cc100000-0000-0000-0000-000000000001',
    'cc200000-0000-0000-0000-000000000008',
    current_date + d
  from generate_series(10, 18) d;

  -- S6: slots 09 and 10 are taken on current_date + 20, so that they
  -- may be waitlisted.
  insert into public.bookings (
    user_id, facility_id, slot_id, booking_date, start_time, end_time,
    amount, status, payment_status
  )
  select
    'cc000000-0000-0000-0000-000000000001',
    'cc100000-0000-0000-0000-000000000001',
    ('cc200000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
    current_date + 20,
    time '08:00' + (n - 2) * interval '1 hour',
    time '09:00' + (n - 2) * interval '1 hour',
    500, 'confirmed', 'paid'
  from generate_series(9, 10) n;

  perform dblink_connect('a', pg_temp.conninfo());
  perform dblink_connect('b', pg_temp.conninfo());
  perform dblink_connect('h', pg_temp.conninfo());
  perform dblink_connect('x', pg_temp.conninfo());
  perform dblink_connect('y', pg_temp.conninfo());

  -- Backend pids, so assertions can look at exactly these sessions
  -- in pg_locks.
  perform set_config('test.pid_a', (select t.p from dblink('a',
    'select pg_backend_pid()::text') as t(p text)), false);
  perform set_config('test.pid_b', (select t.p from dblink('b',
    'select pg_backend_pid()::text') as t(p text)), false);
  perform set_config('test.pid_x', (select t.p from dblink('x',
    'select pg_backend_pid()::text') as t(p text)), false);
  perform set_config('test.pid_y', (select t.p from dblink('y',
    'select pg_backend_pid()::text') as t(p text)), false);
end;
$$;


-- ============================================================
-- S1  Offer decision in flight, another user books
--
-- Original race. A: worker decides (uncommitted). B: user U7
-- books the same slot meanwhile.
--
-- Correct: B waits for A, then sees the committed offer and is
-- refused. Vulnerable: B sails through, leaving a booking AND a
-- live offer.
-- ============================================================

do $$
begin
  perform set_config('test.e1', pg_temp.queue_user(3,
    'cc000000-0000-0000-0000-000000000002')::text, false);
  perform dblink_exec('a', 'begin');
end;
$$;

select is(
  (select t.r
   from dblink(
     'a',
     'select public.offer_next_waitlist_entry(
        ''cc200000-0000-0000-0000-000000000001'', current_date + 3)::text'
   ) as t(r text)),
  current_setting('test.e1'),
  'S1: the worker issues the offer (its transaction stays open)'
);

do $$
begin
  perform dblink_exec(
    'b',
    'begin; set local role authenticated;
     set local request.jwt.claim.sub = ''cc000000-0000-0000-0000-000000000007'''
  );
  perform dblink_send_query(
    'b',
    'select * from public.create_booking(
       ''cc100000-0000-0000-0000-000000000001'',
       ''cc200000-0000-0000-0000-000000000001'',
       current_date + 3)'
  );
  perform set_config('test.s1_obs', pg_temp.observe(
    'b', current_setting('test.pid_b')::integer, pg_temp.slot_key(3), 100
  ), false);
end;
$$;

select is(
  current_setting('test.s1_obs'),
  'waiting',
  'S1: create_booking() is blocked on the slot advisory lock while an offer decision is in flight'
);

do $$
begin
  perform dblink_exec('a', 'commit');
  perform pg_temp.wait_idle('b', 'b', 30);
  if dblink_is_busy('b') = 1 then
    perform dblink_cancel_query('b');
  end if;
  perform set_config('test.s1b', pg_temp.res3('b'), false);
  -- commit (a refused request has already aborted, so this is a
  -- rollback in that case): the final-state check below must see
  -- whatever B managed to create.
  perform dblink_exec('b', 'commit');
end;
$$;

select is(
  current_setting('test.s1b'),
  'P0001: The selected slot is currently held for a waitlist offer',
  'S1: once the offer commits, the other user is refused'
);

select is(
  (select count(*)::text
   from public.bookings
   where slot_id = 'cc200000-0000-0000-0000-000000000001'
     and booking_date = current_date + 3
     and status in ('pending_payment', 'confirmed', 'completed'))
  || '/' ||
  (select count(*)::text
   from public.waitlist_entries
   where slot_id = 'cc200000-0000-0000-0000-000000000001'
     and booking_date = current_date + 3
     and status = 'offered'),
  '0/1',
  'S1: no booking coexists with the live offer'
);


-- ============================================================
-- S2  Booking in flight, worker decides
--
-- B: user U7 books (uncommitted). A: worker runs.
--
-- Correct: the worker's try-lock fails; it returns at once with
-- nothing issued, and after B commits still issues nothing.
-- ============================================================

-- Fixtures are created in their own block so they are COMMITTED
-- before any other connection looks at them.
do $$
begin
  perform set_config('test.e2', pg_temp.queue_user(4,
    'cc000000-0000-0000-0000-000000000002')::text, false);
end;
$$;

do $$
begin
  perform dblink_exec(
    'b',
    'begin; set local role authenticated;
     set local request.jwt.claim.sub = ''cc000000-0000-0000-0000-000000000007'''
  );
  perform * from dblink(
    'b',
    'select * from public.create_booking(
       ''cc100000-0000-0000-0000-000000000001'',
       ''cc200000-0000-0000-0000-000000000001'',
       current_date + 4)'
  ) as t(a text, b text, c text);

  perform dblink_exec('a', 'begin');
  perform dblink_send_query(
    'a',
    'select public.offer_next_waitlist_entry(
       ''cc200000-0000-0000-0000-000000000001'', current_date + 4)::text'
  );
  perform set_config('test.s2_obs', pg_temp.observe(
    'a', current_setting('test.pid_a')::integer, pg_temp.slot_key(4), 100
  ), false);
end;
$$;

select is(
  current_setting('test.s2_obs'),
  'finished',
  'S2: the worker finishes without ever waiting on the slot lock'
);

do $$
begin
  perform set_config('test.s2a', pg_temp.res1('a'), false);
  perform dblink_exec('a', 'rollback');
end;
$$;

select is(
  current_setting('test.s2a'),
  'ok:',
  'S2: no offer is issued while a booking is in flight'
);

do $$
begin
  perform dblink_exec('b', 'commit');
end;
$$;

select is(
  (select coalesce(t.r, 'null')
   from dblink(
     'a',
     'select public.offer_next_waitlist_entry(
        ''cc200000-0000-0000-0000-000000000001'', current_date + 4)::text'
   ) as t(r text))
  || '/' ||
  (select e.status::text
   from public.waitlist_entries e
   where e.id = current_setting('test.e2')::uuid),
  'null/waiting',
  'S2: after the booking commits the worker still issues nothing'
);


-- ============================================================
-- S3  Direct booking and accept by the same user
--
-- H holds the slot lock so that Y (direct create_booking) takes
-- the user lock and then queues on the slot lock, and X (accept)
-- queues behind Y on the USER lock; then H releases.
--
-- Correct: lock order is user lock -> slot lock -> entry row for
-- both, so Y completes and X is refused cleanly.
-- Vulnerable: X holds the entry row and waits for the slot lock,
-- Y holds the slot lock and waits for the entry row: deadlock.
-- ============================================================

do $$
begin
  perform set_config('test.e3', pg_temp.queue_user(5,
    'cc000000-0000-0000-0000-000000000002')::text, false);

  -- offer U2 the slot
  perform public.offer_next_waitlist_entry(
    'cc200000-0000-0000-0000-000000000001', current_date + 5
  );
end;
$$;

do $$
begin
  perform dblink_exec('h', 'begin');
  perform * from dblink(
    'h',
    format('select pg_advisory_xact_lock(%s) is null', pg_temp.slot_key(5))
  ) as t(r text);

  perform dblink_exec(
    'y',
    'begin; set local role authenticated;
     set local request.jwt.claim.sub = ''cc000000-0000-0000-0000-000000000002'''
  );
  perform dblink_send_query(
    'y',
    'select * from public.create_booking(
       ''cc100000-0000-0000-0000-000000000001'',
       ''cc200000-0000-0000-0000-000000000001'',
       current_date + 5)'
  );
  perform set_config('test.y_queued',
    (pg_temp.observe('y', current_setting('test.pid_y')::integer,
                     pg_temp.slot_key(5), 100) = 'waiting')::text, false);

  perform dblink_exec(
    'x',
    'begin; set local role authenticated;
     set local request.jwt.claim.sub = ''cc000000-0000-0000-0000-000000000002'''
  );
  perform dblink_send_query(
    'x',
    format('select * from public.accept_waitlist_offer(%L)',
           current_setting('test.e3'))
  );
  -- X is queued behind Y on the caller's USER lock (Y holds it
  -- while it waits for the slot lock).
  perform set_config('test.x_queued',
    (pg_temp.observe('x', current_setting('test.pid_x')::integer,
                     pg_temp.user_key('cc000000-0000-0000-0000-000000000002'),
                     100) = 'waiting')::text, false);

  -- release: Y (first in the queue) proceeds
  perform dblink_exec('h', 'commit');

  -- Collect both results, committing each side as soon as it has
  -- finished (as an autocommitting client would). This must never
  -- wait forever: against a broken implementation a request can sit
  -- on the other's uncommitted work, so poll with a deadline and
  -- cancel whatever is left.
  declare
    v_x text;
    v_y text;
  begin
    for i in 1..80 loop
      if v_y is null and dblink_is_busy('y') = 0 then
        v_y := pg_temp.res3('y');
        begin perform dblink_exec('y', 'commit');
        exception when others then null; end;
      end if;

      if v_x is null and dblink_is_busy('x') = 0 then
        v_x := pg_temp.res3('x');
        begin perform dblink_exec('x', 'commit');
        exception when others then null; end;
      end if;

      exit when v_x is not null and v_y is not null;
      perform pg_sleep(0.1);
    end loop;

    if v_y is null then
      perform dblink_cancel_query('y');
      v_y := 'TIMEOUT ' || pg_temp.res3('y');
      begin perform dblink_exec('y', 'rollback');
      exception when others then null; end;
    end if;

    if v_x is null then
      perform dblink_cancel_query('x');
      v_x := 'TIMEOUT ' || pg_temp.res3('x');
      begin perform dblink_exec('x', 'rollback');
      exception when others then null; end;
    end if;

    perform set_config('test.s3y', v_y, false);
    perform set_config('test.s3x', v_x, false);
    perform set_config('test.s3_idle',
      (v_x not like 'TIMEOUT%' and v_y not like 'TIMEOUT%')::text, false);
  end;
end;
$$;

select ok(
  current_setting('test.y_queued') = 'true'
  and current_setting('test.x_queued') = 'true'
  and current_setting('test.s3_idle') = 'true',
  'S3: Y waits on the slot lock, X queues behind it on the user lock, and both complete'
);

select ok(
  current_setting('test.s3x') not like '40P01%'
  and current_setting('test.s3y') not like '40P01%',
  'S3: a direct booking and an accept by the same user do not deadlock'
);

select is(
  (select count(*)::text
   from public.bookings
   where user_id = 'cc000000-0000-0000-0000-000000000002'
     and booking_date = current_date + 5
     and status = 'pending_payment')
  || '/' ||
  (select e.status::text || '/' || (e.booking_id is not null)::text
   from public.waitlist_entries e
   where e.id = current_setting('test.e3')::uuid),
  '1/accepted/true',
  'S3: exactly one booking exists and the entry is linked to it'
);

select is(
  case
    when current_setting('test.s3y') like 'ok:%'
     and current_setting('test.s3x') = 'P0001: Waitlist offer is no longer valid'
    then 'booking-wins/accept-refused'
    else current_setting('test.s3y') || ' | ' || current_setting('test.s3x')
  end,
  'booking-wins/accept-refused',
  'S3: the losing request gets a clean business error'
);


-- ============================================================
-- S4  Offer decision rolls back
--
-- The lock is released at ROLLBACK as well as COMMIT: the
-- waiting booking proceeds and the entry is back to waiting.
-- ============================================================

do $$
begin
  perform set_config('test.e4', pg_temp.queue_user(6,
    'cc000000-0000-0000-0000-000000000003')::text, false);
end;
$$;

do $$
begin
  perform dblink_exec('a', 'begin');
  perform * from dblink(
    'a',
    'select public.offer_next_waitlist_entry(
       ''cc200000-0000-0000-0000-000000000001'', current_date + 6)::text'
  ) as t(r text);

  perform dblink_exec(
    'b',
    'begin; set local role authenticated;
     set local request.jwt.claim.sub = ''cc000000-0000-0000-0000-000000000007'''
  );
  perform dblink_send_query(
    'b',
    'select * from public.create_booking(
       ''cc100000-0000-0000-0000-000000000001'',
       ''cc200000-0000-0000-0000-000000000001'',
       current_date + 6)'
  );
  perform set_config('test.s4_obs', pg_temp.observe(
    'b', current_setting('test.pid_b')::integer, pg_temp.slot_key(6), 100
  ), false);
end;
$$;

select is(
  current_setting('test.s4_obs'),
  'waiting',
  'S4: create_booking() is blocked on the slot advisory lock until the offer decision ends'
);

do $$
begin
  perform dblink_exec('a', 'rollback');
  perform pg_temp.wait_idle('b', 'b', 30);
  if dblink_is_busy('b') = 1 then
    perform dblink_cancel_query('b');
  end if;
  perform set_config('test.s4b', pg_temp.res3('b'), false);
  perform dblink_exec('b', 'commit');
end;
$$;

select ok(
  current_setting('test.s4b') like 'ok:%',
  'S4: the lock is released on rollback and the booking proceeds'
);

select is(
  (select e.status::text
   from public.waitlist_entries e
   where e.id = current_setting('test.e4')::uuid),
  'waiting',
  'S4: the rolled-back offer left the entry waiting'
);


-- ============================================================
-- S5  Same user books two different slots concurrently,
--     already holding two (cap = 3)
--
-- A: U8 books slot 04 (uncommitted: holds the user lock).
-- B: U8 books slot 05 meanwhile.
--
-- Correct: B waits on U8's user lock, then counts A's committed
-- hold (3 live) and is refused with UB001. Vulnerable (slot
-- locks only): both see 2, both insert: 4 live holds.
-- ============================================================

do $$
begin
  perform dblink_exec(
    'a',
    'begin; set local role authenticated;
     set local request.jwt.claim.sub = ''cc000000-0000-0000-0000-000000000008'''
  );
  perform * from dblink(
    'a',
    'select * from public.create_booking(
       ''cc100000-0000-0000-0000-000000000001'',
       ''cc200000-0000-0000-0000-000000000004'',
       current_date + 9)'
  ) as t(a text, b text, c text);

  perform dblink_exec(
    'b',
    'begin; set local role authenticated;
     set local request.jwt.claim.sub = ''cc000000-0000-0000-0000-000000000008'''
  );
  perform dblink_send_query(
    'b',
    'select * from public.create_booking(
       ''cc100000-0000-0000-0000-000000000001'',
       ''cc200000-0000-0000-0000-000000000005'',
       current_date + 9)'
  );
  perform set_config('test.s5_obs', pg_temp.observe(
    'b', current_setting('test.pid_b')::integer,
    pg_temp.user_key('cc000000-0000-0000-0000-000000000008'), 100
  ), false);
end;
$$;

select is(
  current_setting('test.s5_obs'),
  'waiting',
  'S5: the second booking by the same user waits on that user''s lock, not on a slot lock'
);

do $$
begin
  perform dblink_exec('a', 'commit');
  perform pg_temp.wait_idle('b', 'b', 30);
  if dblink_is_busy('b') = 1 then
    perform dblink_cancel_query('b');
  end if;
  perform set_config('test.s5b', pg_temp.res3('b'), false);
  perform dblink_exec('b', 'commit');
end;
$$;

select is(
  current_setting('test.s5b'),
  'UB001: You already have the maximum number of unpaid bookings held (3). Complete payment or wait for one to expire.',
  'S5: once the first commits, the second sees 3 live holds and is refused with UB001'
);

select is(
  (select count(*)::text
   from public.bookings
   where user_id = 'cc000000-0000-0000-0000-000000000008'
     and status = 'pending_payment'
     and expires_at > now()),
  '3',
  'S5: the user ends with exactly 3 live holds, never 4'
);


-- ============================================================
-- S6  Same user joins two different waitlists concurrently,
--     already on nine (cap = 10)
--
-- A: U9 joins slot 09 (uncommitted: holds the user lock).
-- B: U9 joins slot 10 meanwhile.
--
-- Correct: B waits on the user lock, then counts 10 and is
-- refused with UB002. Vulnerable: both count 9 and insert.
-- ============================================================

do $$
begin
  perform dblink_exec(
    'a',
    'begin; set local role authenticated;
     set local request.jwt.claim.sub = ''cc000000-0000-0000-0000-000000000009'''
  );
  perform * from dblink(
    'a',
    'select entry_id::text, entries_ahead::text, null::text
     from public.join_waitlist(
       ''cc100000-0000-0000-0000-000000000001'',
       ''cc200000-0000-0000-0000-000000000009'',
       current_date + 20)'
  ) as t(a text, b text, c text);

  perform dblink_exec(
    'b',
    'begin; set local role authenticated;
     set local request.jwt.claim.sub = ''cc000000-0000-0000-0000-000000000009'''
  );
  perform dblink_send_query(
    'b',
    'select entry_id::text, entries_ahead::text, null::text
     from public.join_waitlist(
       ''cc100000-0000-0000-0000-000000000001'',
       ''cc200000-0000-0000-0000-000000000010'',
       current_date + 20)'
  );
  perform set_config('test.s6_obs', pg_temp.observe(
    'b', current_setting('test.pid_b')::integer,
    pg_temp.user_key('cc000000-0000-0000-0000-000000000009'), 100
  ), false);
end;
$$;

select is(
  current_setting('test.s6_obs'),
  'waiting',
  'S6: the second join by the same user waits on that user''s lock'
);

do $$
begin
  perform dblink_exec('a', 'commit');
  perform pg_temp.wait_idle('b', 'b', 30);
  if dblink_is_busy('b') = 1 then
    perform dblink_cancel_query('b');
  end if;
  perform set_config('test.s6b', pg_temp.res3('b'), false);
  perform dblink_exec('b', 'commit');
end;
$$;

select is(
  current_setting('test.s6b'),
  'UB002: You are already on the maximum number of waitlists (10). Leave one to join another.',
  'S6: once the first commits, the second sees 10 active entries and is refused with UB002'
);

select is(
  (select count(*)::text
   from public.waitlist_entries
   where user_id = 'cc000000-0000-0000-0000-000000000009'
     and status in ('waiting', 'offered')),
  '10',
  'S6: the user ends with exactly 10 active entries, never 11'
);


-- ============================================================
-- S7  Accept first, then a direct booking, same user, same slot
--
-- The reverse start order of S3. H holds the slot lock; X
-- (accept) takes the user lock and queues on the slot lock; Y
-- (direct booking) queues behind X on the user lock.
--
-- Correct: X completes and Y is refused cleanly (slot taken).
-- Vulnerable (slot lock before user lock in accept): X holds
-- the slot lock and wants the user lock while Y holds the user
-- lock and wants the slot lock: deadlock.
-- ============================================================

do $$
begin
  perform set_config('test.e7', pg_temp.queue_user(8,
    'cc000000-0000-0000-0000-000000000003')::text, false);

  perform public.offer_next_waitlist_entry(
    'cc200000-0000-0000-0000-000000000001', current_date + 8
  );
end;
$$;

do $$
declare
  v_x text;
  v_y text;
begin
  perform dblink_exec('h', 'begin');
  perform * from dblink(
    'h',
    format('select pg_advisory_xact_lock(%s) is null', pg_temp.slot_key(8))
  ) as t(r text);

  perform dblink_exec(
    'x',
    'begin; set local role authenticated;
     set local request.jwt.claim.sub = ''cc000000-0000-0000-0000-000000000003'''
  );
  perform dblink_send_query(
    'x',
    format('select * from public.accept_waitlist_offer(%L)',
           current_setting('test.e7'))
  );
  perform set_config('test.s7_x_queued',
    (pg_temp.observe('x', current_setting('test.pid_x')::integer,
                     pg_temp.slot_key(8), 100) = 'waiting')::text, false);

  perform dblink_exec(
    'y',
    'begin; set local role authenticated;
     set local request.jwt.claim.sub = ''cc000000-0000-0000-0000-000000000003'''
  );
  perform dblink_send_query(
    'y',
    'select * from public.create_booking(
       ''cc100000-0000-0000-0000-000000000001'',
       ''cc200000-0000-0000-0000-000000000001'',
       current_date + 8)'
  );
  perform set_config('test.s7_y_queued',
    (pg_temp.observe('y', current_setting('test.pid_y')::integer,
                     pg_temp.user_key('cc000000-0000-0000-0000-000000000003'),
                     100) = 'waiting')::text, false);

  perform dblink_exec('h', 'commit');

  for i in 1..80 loop
    if v_x is null and dblink_is_busy('x') = 0 then
      v_x := pg_temp.res3('x');
      begin perform dblink_exec('x', 'commit');
      exception when others then null; end;
    end if;

    if v_y is null and dblink_is_busy('y') = 0 then
      v_y := pg_temp.res3('y');
      begin perform dblink_exec('y', 'commit');
      exception when others then null; end;
    end if;

    exit when v_x is not null and v_y is not null;
    perform pg_sleep(0.1);
  end loop;

  if v_x is null then
    perform dblink_cancel_query('x');
    v_x := 'TIMEOUT ' || pg_temp.res3('x');
    begin perform dblink_exec('x', 'rollback');
    exception when others then null; end;
  end if;

  if v_y is null then
    perform dblink_cancel_query('y');
    v_y := 'TIMEOUT ' || pg_temp.res3('y');
    begin perform dblink_exec('y', 'rollback');
    exception when others then null; end;
  end if;

  perform set_config('test.s7x', v_x, false);
  perform set_config('test.s7y', v_y, false);
end;
$$;

select ok(
  current_setting('test.s7_x_queued') = 'true'
  and current_setting('test.s7_y_queued') = 'true'
  and current_setting('test.s7x') not like 'TIMEOUT%'
  and current_setting('test.s7y') not like 'TIMEOUT%',
  'S7: accept waits on the slot lock, the direct booking queues behind it on the user lock, and both complete'
);

select ok(
  current_setting('test.s7x') not like '40P01%'
  and current_setting('test.s7y') not like '40P01%',
  'S7: accept followed by a direct booking by the same user does not deadlock'
);

select is(
  (select count(*)::text
   from public.bookings
   where user_id = 'cc000000-0000-0000-0000-000000000003'
     and booking_date = current_date + 8
     and status = 'pending_payment')
  || '/' ||
  (select e.status::text || '/' || (e.booking_id is not null)::text
   from public.waitlist_entries e
   where e.id = current_setting('test.e7')::uuid),
  '1/accepted/true',
  'S7: exactly one booking exists and the entry is linked to it'
);

select is(
  case
    when current_setting('test.s7x') like 'ok:%'
     and current_setting('test.s7y') = '23P01: The selected slot is no longer available'
    then 'accept-wins/booking-refused'
    else current_setting('test.s7x') || ' | ' || current_setting('test.s7y')
  end,
  'accept-wins/booking-refused',
  'S7: the losing direct booking gets a clean business error'
);


-- ============================================================
-- S8  A different user is not blocked
--
-- A: U4 books slot 06 and keeps the transaction open (holds
-- U4's user lock and slot 06's lock).
-- B: U5 books slot 07 meanwhile.
--
-- Correct: the lock is per user, so B finishes without waiting.
-- ============================================================

do $$
begin
  perform dblink_exec(
    'a',
    'begin; set local role authenticated;
     set local request.jwt.claim.sub = ''cc000000-0000-0000-0000-000000000004'''
  );
  perform * from dblink(
    'a',
    'select * from public.create_booking(
       ''cc100000-0000-0000-0000-000000000001'',
       ''cc200000-0000-0000-0000-000000000006'',
       current_date + 21)'
  ) as t(a text, b text, c text);

  perform dblink_exec(
    'b',
    'begin; set local role authenticated;
     set local request.jwt.claim.sub = ''cc000000-0000-0000-0000-000000000005'''
  );
  perform dblink_send_query(
    'b',
    'select * from public.create_booking(
       ''cc100000-0000-0000-0000-000000000001'',
       ''cc200000-0000-0000-0000-000000000007'',
       current_date + 21)'
  );
  perform set_config('test.s8_obs', pg_temp.observe(
    'b', current_setting('test.pid_b')::integer,
    pg_temp.user_key('cc000000-0000-0000-0000-000000000004'), 100
  ), false);
  perform set_config('test.s8b', pg_temp.res3('b'), false);
  perform dblink_exec('b', 'commit');
  perform dblink_exec('a', 'commit');
end;
$$;

select is(
  current_setting('test.s8_obs'),
  'finished',
  'S8: another user''s booking finishes without waiting on the first user''s lock'
);

select ok(
  current_setting('test.s8b') like 'ok:%',
  'S8: the other user''s booking succeeds while the first transaction is still open'
);

select is(
  (select count(*)::text
   from public.bookings
   where user_id in ('cc000000-0000-0000-0000-000000000004',
                     'cc000000-0000-0000-0000-000000000005')
     and booking_date = current_date + 21
     and status = 'pending_payment'),
  '2',
  'S8: both users end with their booking'
);


-- ------------------------------------------------------------
-- Teardown
-- ------------------------------------------------------------

do $$
declare
  v_conn text;
begin
  foreach v_conn in array array['a', 'b', 'h', 'x', 'y'] loop
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

-- Remove dblink only if this harness installed it (marker comment).
select pg_temp.release_dblink();

select * from finish();

\else

-- Prerequisites missing: one clear failure, no fixtures created.
select plan(1);
select fail('waitlist concurrency test cannot run: ' || :'prereq_msg');
select diag('No fixtures were created. Fix the prerequisite above and re-run.');
select * from finish();

\endif

\else

-- Not positively identified as the local Supabase stack: refuse.
select plan(1);
select fail('waitlist concurrency test REFUSED to run: this database is not '
  || 'positively identified as the local Supabase development stack '
  || '(database=' || :'env_db' || ', server address=' || :'env_addr' || ').');
select diag('This file commits fixture rows, so it only runs against the local stack started by `supabase start` with the default config.');
select diag('Run it with: supabase test db   (not --linked and not a remote --db-url).');
select diag('Nothing was created or committed.');
select * from finish();

\endif
