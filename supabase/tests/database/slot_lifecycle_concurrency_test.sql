-- ============================================================
-- Slot lifecycle: edits racing with bookings and offer acceptance
-- (REAL multi-session tests)
--
-- Like waitlist_concurrency_test.sql this file does not run in one
-- transaction. It opens separate database connections with dblink
-- and drives the real create_booking(), accept_waitlist_offer() and
-- an owner's UPDATE of facility_slots (RLS applies: the editor runs
-- as role authenticated, signed in as the facility owner):
--
--   conn a  the owner editing the slot (price, active flag, times)
--   conn b  the customer booking / accepting an offer
--
-- create_booking() reads the slot row FOR SHARE and the
-- facility_slots_time_freeze trigger locks it FOR UPDATE before it
-- looks for live references, so an edit and a booking of the same
-- slot are serialised in either order:
--
--   R1  booking first, time edit second -> the edit waits, then is
--       rejected (23514): the booking is live
--   R2  time edit first (allowed: no live reference), booking
--       second -> the booking waits and uses the NEW times
--   R3  deactivation first, booking second -> the booking waits,
--       then is refused: the slot is no longer active
--   R4  booking first, deactivation second -> the deactivation
--       waits; the booking stands, the slot ends inactive
--   R5  price edit first, booking second -> the booking waits and
--       uses the NEW price
--   R6a price edit first, offer acceptance second -> the
--       acceptance waits, books at the new price, entry accepted
--   R6b acceptance first, time edit second -> the edit waits, then
--       is rejected; entry accepted and linked to the booking
--   R6c time edit while an offer is running -> rejected at once
--   R6d deactivation first, acceptance second -> the acceptance
--       waits, then fails cleanly: no booking, the offer is left
--       exactly as it was (offered, unaccepted)
--
--   J1  waitlist join first, time edit second -> the edit waits for
--       the join (which is held after it validated the slot) and is
--       rejected: the committed ENTRY is live (the booking that made
--       the slot joinable is cancelled meanwhile, so only the entry
--       can be the reason)
--   J2  time edit first (outside operating hours), join second ->
--       the join waits and validates the NEW definition
--   J3  deactivation first, join second -> the join waits and is
--       refused: the slot is no longer active
--   J4a a join that is rolled back leaves no entry and does not
--       block a subsequent edit (which waited for it)
--   J4b a join that fails leaves nothing and does not block an edit
--
-- J1 holds join_waitlist() at its INSERT with a table lock
-- (conn c: LOCK TABLE waitlist_entries IN SHARE MODE, which blocks
-- the insert's ROW EXCLUSIVE lock but not the function's reads), so
-- the order "join validated the slot, edit arrives, join inserts"
-- is reproduced without sleeping.
--
-- Not orderable: "time edit first, then accept". A running offer
-- is itself a live reference, so that edit is rejected before it
-- can hold anything (R6c). Price and deactivation cover the
-- edit-first order for acceptance.
--
-- Every "is waiting" assertion looks at pg_locks for that
-- session's backend pid; nothing sleeps for a fixed time.
--
-- Bounded waits: every remote transaction runs with
-- lock_timeout = 10s (and so does this session), so a lock that is
-- never released produces a 55P03 failure instead of a hang. The
-- synchronous remote statements do not raise: a failure is recorded
-- and reported by the last assertion, which lets the teardown run.
--
-- The J scenarios check WHO blocks (pg_blocking_pids) and, for the
-- held join, WHICH relation it waits on, not just that something
-- blocks.
--
-- ------------------------------------------------------------
-- SAFETY: this file COMMITS rows (and may install dblink).
-- ------------------------------------------------------------
-- It refuses to run unless the target database positively
-- identifies itself as the local Supabase development stack (see
-- waitlist_concurrency_test.sql for the guard and its limits).
-- Rows use ids prefixed cd... and are removed at the start of the
-- next run and again at the end.
--
-- Residual timing risk: raw offers expire 15 minutes after the
-- fixtures are inserted, and pg_cron runs once a minute; a run
-- that is suspended for longer than that fails loudly.
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
  select 'unisport-test-harness: installed by slot_lifecycle_concurrency_test.sql; safe to drop'
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
          'dblink installed by the slot lifecycle test harness was left in place: %',
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
     or to_regprocedure('public.accept_waitlist_offer(uuid)') is null
     or to_regprocedure('public.prevent_live_slot_time_change()') is null
     or not exists (
       select 1 from pg_trigger
       where tgname = 'facility_slots_time_freeze'
     ) then
    return 'the slot lifecycle migration is not applied to this '
        || 'database; apply it first (supabase migration up).';
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

select plan(46);

set lock_timeout = '10s';


-- ------------------------------------------------------------
-- Helpers (session-local; vanish with the session)
-- ------------------------------------------------------------

create function pg_temp.cleanup()
returns void
language sql
as $$
  delete from public.waitlist_entries
  where facility_id = 'cd100000-0000-0000-0000-000000000001';
  delete from public.bookings
  where facility_id = 'cd100000-0000-0000-0000-000000000001';
  delete from public.facility_slots
  where facility_id = 'cd100000-0000-0000-0000-000000000001';
  delete from public.facilities
  where id = 'cd100000-0000-0000-0000-000000000001';
  delete from auth.users
  where id::text like 'cd000000-%';
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

-- Failures of setup / helper statements are collected here and
-- asserted at the end (test.harness_errors).
create function pg_temp.note_failure(p_what text)
returns void
language plpgsql
as $$
declare
  v_old text := coalesce(nullif(current_setting('test.harness_errors', true), ''), '');
begin
  perform set_config(
    'test.harness_errors',
    v_old || case when v_old = '' then '' else ' | ' end || p_what,
    false);
end;
$$;

-- Synchronous remote command (it cannot hang: the remote
-- transaction has a lock_timeout). Does not raise.
create function pg_temp.sync_exec(p_conn text, p_sql text)
returns void
language plpgsql
as $$
begin
  perform dblink_exec(p_conn, p_sql);
exception
  when others then
    perform pg_temp.note_failure(
      format('%s: %s: %s', p_conn, sqlstate, sqlerrm));
end;
$$;

-- Synchronous remote query returning three columns. Does not raise.
create function pg_temp.sync_query(p_conn text, p_sql text)
returns void
language plpgsql
as $$
begin
  perform * from dblink(p_conn, p_sql) as t(a text, b text, c text);
exception
  when others then
    perform pg_temp.note_failure(
      format('%s: %s: %s', p_conn, sqlstate, sqlerrm));
end;
$$;

-- dblink_send_query() returns 0 when the query could not be sent.
create function pg_temp.send_sql(p_conn text, p_sql text)
returns void
language plpgsql
as $$
begin
  if dblink_send_query(p_conn, p_sql) <> 1 then
    perform pg_temp.note_failure(p_conn || ': the query could not be sent');
  end if;
end;
$$;

-- Like observe(), but 'waiting' only when p_blocker is among the
-- backends blocking p_pid and, when p_rel is given, p_pid has an
-- ungranted lock on that relation.
create function pg_temp.observe_blocked(
  p_conn text,
  p_pid integer,
  p_blocker integer,
  p_rel regclass,
  p_ticks integer
)
returns text
language plpgsql
as $$
begin
  for i in 1..p_ticks loop
    if p_blocker = any (pg_blocking_pids(p_pid))
       and (
         p_rel is null
         or exists (
           select 1
           from pg_locks l
           where l.pid = p_pid
             and not l.granted
             and l.locktype = 'relation'
             and l.relation = p_rel::oid
         )
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

-- Start a remote customer transaction.
create function pg_temp.begin_as(p_conn text, p_user text)
returns void
language plpgsql
as $$
begin
  perform pg_temp.sync_exec(
    p_conn,
    format('begin; set local lock_timeout = ''10s''; '
           'set local role authenticated; '
           'set local request.jwt.claim.sub = %L', p_user)
  );
end;
$$;



-- Send create_booking() for the test facility without waiting.
create function pg_temp.send_book(
  p_conn text, p_user text, p_slot uuid, p_day integer
)
returns void
language plpgsql
as $$
begin
  perform pg_temp.begin_as(p_conn, p_user);
  perform pg_temp.send_sql(
    p_conn,
    format(
      'select * from public.create_booking(%L, %L, current_date + %s)',
      'cd100000-0000-0000-0000-000000000001', p_slot, p_day)
  );
end;
$$;

-- Send accept_waitlist_offer() without waiting.
create function pg_temp.send_accept(p_conn text, p_user text, p_entry uuid)
returns void
language plpgsql
as $$
begin
  perform pg_temp.begin_as(p_conn, p_user);
  perform pg_temp.send_sql(
    p_conn,
    format('select * from public.accept_waitlist_offer(%L)', p_entry)
  );
end;
$$;

-- Send join_waitlist() without waiting (result padded to 3 columns).
create function pg_temp.send_join(
  p_conn text, p_user text, p_slot uuid, p_date date
)
returns void
language plpgsql
as $$
begin
  perform pg_temp.begin_as(p_conn, p_user);
  perform pg_temp.send_sql(
    p_conn,
    format(
      'select entry_id::text, entries_ahead::text, null::text '
      'from public.join_waitlist(%L, %L, %L::date)',
      'cd100000-0000-0000-0000-000000000001', p_slot, p_date)
  );
end;
$$;

-- Send a one-statement UPDATE as the owner without waiting.
create function pg_temp.send_edit(p_conn text, p_sql text)
returns void
language plpgsql
as $$
begin
  perform pg_temp.begin_as(p_conn, 'cd000000-0000-0000-0000-000000000000');
  perform pg_temp.send_sql(p_conn, p_sql);
end;
$$;

-- Result of an async single-column / command statement:
-- 'ok:<first column>' or '<sqlstate>: <message>'.
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

-- Wait for the statement, read its result (p_cols = 3 for the
-- booking RPCs, 1 for an UPDATE), end the transaction. A statement
-- still running after the wait is cancelled first (reading it would
-- block the suite) and reported as 'TIMEOUT...'. The cancelled
-- statement ends with 57014, which WHEN OTHERS does not catch, so
-- it is named.
create function pg_temp.collect(p_conn text, p_cols integer)
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

  if p_cols = 3 then
    v_res := pg_temp.res3(p_conn);
  else
    v_res := pg_temp.res1(p_conn);
  end if;

  perform dblink_exec(p_conn, 'commit');
  return v_res;
end;
$$;

create function pg_temp.slot_row(p_slot uuid)
returns text
language sql
as $$
  select to_char(start_time, 'HH24:MI') || '-' || to_char(end_time, 'HH24:MI')
         || ' ' || base_price::text || ' ' || is_active::text
  from public.facility_slots
  where id = p_slot
$$;


-- ------------------------------------------------------------
-- Fixtures (committed) and connections
--
--   Slots (hourly, within operating hours 06:00-22:00)
--     S1 06-07  R1        S5 10-11  R5
--     S2 07-08  R2        S6 11-12  R6a (offer to user 4)
--     S3 08-09  R3        S7 12-13  R6b (offer to user 5)
--     S4 09-10  R4        S8 13-14  R6c (offer to user 6)
--                         S9 14-15  R6d (offer to user 7)
--   Free space 17:00-22:00 is where time edits go.
--   Offers are raw rows: offered, running for 15 minutes.
-- ------------------------------------------------------------

do $$
begin
  perform pg_temp.cleanup();

  insert into auth.users (
    id, email, encrypted_password, email_confirmed_at, raw_user_meta_data
  )
  select
    ('cd000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
    'slc-user' || n || '@example.com', '', now(), '{}'::jsonb
  from generate_series(0, 9) n;

  insert into public.facilities (
    id, owner_id, name, description, sport, address, city, status, base_price
  )
  values (
    'cd100000-0000-0000-0000-000000000001', 'cd000000-0000-0000-0000-000000000000',
    'Slot Lifecycle Facility', 'Temporary database test facility',
    'Football', 'Test Address', 'Test City', 'active', 500
  );

  insert into public.facility_slots (
    id, facility_id, start_time, end_time, duration_min, base_price, is_active
  )
  select
    ('cd200000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
    'cd100000-0000-0000-0000-000000000001',
    time '05:00' + n * interval '1 hour',
    time '06:00' + n * interval '1 hour',
    60, 500, true
  from generate_series(1, 9) n;

  insert into public.facility_operating_hours (
    facility_id, day_of_week, opens_at, closes_at, is_closed
  )
  select 'cd100000-0000-0000-0000-000000000001', d, '06:00', '22:00', false
  from generate_series(0, 6) d;

  -- Slots for the waitlist-join scenarios (30 minutes each)
  insert into public.facility_slots (
    id, facility_id, start_time, end_time, duration_min, base_price, is_active
  )
  values
    ('cd200000-0000-0000-0000-000000000010', 'cd100000-0000-0000-0000-000000000001', '15:00', '15:30', 30, 500, true),
    ('cd200000-0000-0000-0000-000000000011', 'cd100000-0000-0000-0000-000000000001', '15:30', '16:00', 30, 500, true),
    ('cd200000-0000-0000-0000-000000000012', 'cd100000-0000-0000-0000-000000000001', '16:00', '16:30', 30, 500, true),
    ('cd200000-0000-0000-0000-000000000013', 'cd100000-0000-0000-0000-000000000001', '16:30', '17:00', 30, 500, true),
    ('cd200000-0000-0000-0000-000000000014', 'cd100000-0000-0000-0000-000000000001', '21:00', '21:30', 30, 500, true);

  -- Confirmed bookings by user 9 make slots 10, 12 and 13 unavailable,
  -- so waiting for them is allowed (J1, J3, J4a). Slots 11 and 14
  -- have no references.
  insert into public.bookings (
    id, user_id, facility_id, slot_id, booking_date, start_time, end_time,
    amount, status, payment_status, expires_at
  )
  values
    ('cd400000-0000-0000-0000-000000000010', 'cd000000-0000-0000-0000-000000000009',
     'cd100000-0000-0000-0000-000000000001', 'cd200000-0000-0000-0000-000000000010',
     current_date + 5, '15:00', '15:30', 500, 'confirmed', 'paid', null),
    ('cd400000-0000-0000-0000-000000000012', 'cd000000-0000-0000-0000-000000000009',
     'cd100000-0000-0000-0000-000000000001', 'cd200000-0000-0000-0000-000000000012',
     current_date + 7, '16:00', '16:30', 500, 'confirmed', 'paid', null),
    ('cd400000-0000-0000-0000-000000000013', 'cd000000-0000-0000-0000-000000000009',
     'cd100000-0000-0000-0000-000000000001', 'cd200000-0000-0000-0000-000000000013',
     current_date + 8, '16:30', '17:00', 500, 'confirmed', 'paid', null);

  insert into public.waitlist_entries (
    id, user_id, facility_id, slot_id, booking_date,
    status, offered_at, offer_expires_at
  )
  values
    ('cd300000-0000-0000-0000-000000000006',  'cd000000-0000-0000-0000-000000000004', 'cd100000-0000-0000-0000-000000000001', 'cd200000-0000-0000-0000-000000000006', current_date + 8,
     'offered', now(), now() + interval '15 minutes'),
    ('cd300000-0000-0000-0000-000000000007',  'cd000000-0000-0000-0000-000000000005', 'cd100000-0000-0000-0000-000000000001', 'cd200000-0000-0000-0000-000000000007', current_date + 9,
     'offered', now(), now() + interval '15 minutes'),
    ('cd300000-0000-0000-0000-000000000008',  'cd000000-0000-0000-0000-000000000006', 'cd100000-0000-0000-0000-000000000001', 'cd200000-0000-0000-0000-000000000008', current_date + 10,
     'offered', now(), now() + interval '15 minutes'),
    ('cd300000-0000-0000-0000-000000000009',  'cd000000-0000-0000-0000-000000000007', 'cd100000-0000-0000-0000-000000000001', 'cd200000-0000-0000-0000-000000000009', current_date + 11,
     'offered', now(), now() + interval '15 minutes');

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
  current_setting('test.pid_a') <> current_setting('test.pid_b'),
  'two independent backend sessions are in use'
);


-- ============================================================
-- R1  Booking first, time edit second
-- ============================================================

do $$
begin
  perform pg_temp.begin_as('b', 'cd000000-0000-0000-0000-000000000001');
  perform pg_temp.sync_query('b',
    format('select * from public.create_booking(%L, %L, current_date + 3)',
           'cd100000-0000-0000-0000-000000000001', 'cd200000-0000-0000-0000-000000000001'));

  perform pg_temp.send_edit('a',
    format('update public.facility_slots
            set start_time = ''17:00'', end_time = ''18:00''
            where id = %L', 'cd200000-0000-0000-0000-000000000001'));
  perform set_config('test.r1_obs', pg_temp.observe(
    'a', current_setting('test.pid_a')::integer, null, 100), false);

  perform dblink_exec('b', 'commit');
  perform set_config('test.r1_a', pg_temp.collect('a', 1), false);
end;
$$;

select is(
  current_setting('test.r1_obs'),
  'waiting',
  'R1: the time edit waits for the in-flight booking'
);

select ok(
  current_setting('test.r1_a') like '23514:%',
  'R1: once the booking commits, the time edit is rejected (23514)'
);

select is(
  pg_temp.slot_row('cd200000-0000-0000-0000-000000000001') || '/' ||
  (select count(*)::text from public.bookings
   where slot_id = 'cd200000-0000-0000-0000-000000000001' and status = 'pending_payment'),
  '06:00-07:00 500.00 true/1',
  'R1: the slot kept its times and the booking exists'
);


-- ============================================================
-- R2  Time edit first, booking second
-- ============================================================

do $$
begin
  perform pg_temp.begin_as('a', 'cd000000-0000-0000-0000-000000000000');
  perform pg_temp.sync_exec('a',
    format('update public.facility_slots
            set start_time = ''18:00'', end_time = ''19:00''
            where id = %L', 'cd200000-0000-0000-0000-000000000002'));

  perform pg_temp.send_book('b', 'cd000000-0000-0000-0000-000000000002', 'cd200000-0000-0000-0000-000000000002', 4);
  perform set_config('test.r2_obs', pg_temp.observe(
    'b', current_setting('test.pid_b')::integer, null, 100), false);

  perform dblink_exec('a', 'commit');
  perform set_config('test.r2_b', pg_temp.collect('b', 3), false);
end;
$$;

select is(
  current_setting('test.r2_obs'),
  'waiting',
  'R2: the booking waits for the in-flight time edit'
);

select ok(
  current_setting('test.r2_b') like 'ok:%',
  'R2: once the edit commits, the booking succeeds'
);

select is(
  (select to_char(start_time, 'HH24:MI') || '-' || to_char(end_time, 'HH24:MI')
   from public.bookings
   where slot_id = 'cd200000-0000-0000-0000-000000000002' and status = 'pending_payment'),
  '18:00-19:00',
  'R2: the booking snapshot uses the NEW times, not a stale read'
);


-- ============================================================
-- R3  Deactivation first, booking second
-- ============================================================

do $$
begin
  perform pg_temp.begin_as('a', 'cd000000-0000-0000-0000-000000000000');
  perform pg_temp.sync_exec('a',
    format('update public.facility_slots set is_active = false
            where id = %L', 'cd200000-0000-0000-0000-000000000003'));

  perform pg_temp.send_book('b', 'cd000000-0000-0000-0000-000000000003', 'cd200000-0000-0000-0000-000000000003', 5);
  perform set_config('test.r3_obs', pg_temp.observe(
    'b', current_setting('test.pid_b')::integer, null, 100), false);

  perform dblink_exec('a', 'commit');
  perform set_config('test.r3_b', pg_temp.collect('b', 3), false);
end;
$$;

select is(
  current_setting('test.r3_obs'),
  'waiting',
  'R3: the booking waits for the in-flight deactivation'
);

select is(
  current_setting('test.r3_b') || '/' ||
  (select count(*)::text from public.bookings where slot_id = 'cd200000-0000-0000-0000-000000000003'),
  'P0001: Selected slot is not active/0',
  'R3: once the deactivation commits, the booking is refused and nothing is created'
);


-- ============================================================
-- R4  Booking first, deactivation second
-- ============================================================

do $$
begin
  perform pg_temp.begin_as('b', 'cd000000-0000-0000-0000-000000000004');
  perform pg_temp.sync_query('b',
    format('select * from public.create_booking(%L, %L, current_date + 6)',
           'cd100000-0000-0000-0000-000000000001', 'cd200000-0000-0000-0000-000000000004'));

  perform pg_temp.send_edit('a',
    format('update public.facility_slots set is_active = false
            where id = %L', 'cd200000-0000-0000-0000-000000000004'));
  perform set_config('test.r4_obs', pg_temp.observe(
    'a', current_setting('test.pid_a')::integer, null, 100), false);

  perform dblink_exec('b', 'commit');
  perform set_config('test.r4_a', pg_temp.collect('a', 1), false);
end;
$$;

select is(
  current_setting('test.r4_obs'),
  'waiting',
  'R4: the deactivation waits for the in-flight booking'
);

select ok(
  current_setting('test.r4_a') like 'ok:%',
  'R4: once the booking commits, the deactivation succeeds'
);

select is(
  pg_temp.slot_row('cd200000-0000-0000-0000-000000000004') || '/' ||
  (select count(*)::text from public.bookings
   where slot_id = 'cd200000-0000-0000-0000-000000000004' and status = 'pending_payment'),
  '09:00-10:00 500.00 false/1',
  'R4: the slot is inactive and the booking stands'
);


-- ============================================================
-- R5  Price edit first, booking second
-- ============================================================

do $$
begin
  perform pg_temp.begin_as('a', 'cd000000-0000-0000-0000-000000000000');
  perform pg_temp.sync_exec('a',
    format('update public.facility_slots set base_price = 777
            where id = %L', 'cd200000-0000-0000-0000-000000000005'));

  perform pg_temp.send_book('b', 'cd000000-0000-0000-0000-000000000008', 'cd200000-0000-0000-0000-000000000005', 7);
  perform set_config('test.r5_obs', pg_temp.observe(
    'b', current_setting('test.pid_b')::integer, null, 100), false);

  perform dblink_exec('a', 'commit');
  perform set_config('test.r5_b', pg_temp.collect('b', 3), false);
end;
$$;

select is(
  current_setting('test.r5_obs'),
  'waiting',
  'R5: the booking waits for the in-flight price edit'
);

select ok(
  current_setting('test.r5_b') like 'ok:%',
  'R5: the booking succeeds after the edit commits'
);

select is(
  (select amount::text from public.bookings where slot_id = 'cd200000-0000-0000-0000-000000000005'),
  '777.00',
  'R5: the booking uses the NEW price'
);


-- ============================================================
-- R6a  Price edit first, offer acceptance second
-- ============================================================

do $$
begin
  perform pg_temp.begin_as('a', 'cd000000-0000-0000-0000-000000000000');
  perform pg_temp.sync_exec('a',
    format('update public.facility_slots set base_price = 888
            where id = %L', 'cd200000-0000-0000-0000-000000000006'));

  perform pg_temp.send_accept('b', 'cd000000-0000-0000-0000-000000000004', 'cd300000-0000-0000-0000-000000000006');
  perform set_config('test.r6a_obs', pg_temp.observe(
    'b', current_setting('test.pid_b')::integer, null, 100), false);

  perform dblink_exec('a', 'commit');
  perform set_config('test.r6a_b', pg_temp.collect('b', 3), false);
end;
$$;

select is(
  current_setting('test.r6a_obs'),
  'waiting',
  'R6a: the acceptance waits for the in-flight price edit'
);

select ok(
  current_setting('test.r6a_b') like 'ok:%',
  'R6a: once the edit commits, the acceptance succeeds'
);

select is(
  (select w.status::text || '/' || b.amount::text || '/' || b.status::text
   from public.waitlist_entries w
   join public.bookings b on b.id = w.booking_id
   where w.id = 'cd300000-0000-0000-0000-000000000006'),
  'accepted/888.00/pending_payment',
  'R6a: entry accepted and linked to an unpaid hold at the NEW price'
);


-- ============================================================
-- R6b  Acceptance first, time edit second
-- ============================================================

do $$
begin
  perform pg_temp.begin_as('b', 'cd000000-0000-0000-0000-000000000005');
  perform pg_temp.sync_query('b',
    format('select * from public.accept_waitlist_offer(%L)', 'cd300000-0000-0000-0000-000000000007'));

  perform pg_temp.send_edit('a',
    format('update public.facility_slots
            set start_time = ''19:00'', end_time = ''20:00''
            where id = %L', 'cd200000-0000-0000-0000-000000000007'));
  perform set_config('test.r6b_obs', pg_temp.observe(
    'a', current_setting('test.pid_a')::integer, null, 100), false);

  perform dblink_exec('b', 'commit');
  perform set_config('test.r6b_a', pg_temp.collect('a', 1), false);
end;
$$;

select is(
  current_setting('test.r6b_obs'),
  'waiting',
  'R6b: the time edit waits for the in-flight acceptance'
);

select ok(
  current_setting('test.r6b_a') like '23514:%',
  'R6b: once the acceptance commits, the time edit is rejected (23514)'
);

select is(
  pg_temp.slot_row('cd200000-0000-0000-0000-000000000007') || '/' ||
  (select w.status::text || '/' || (w.booking_id is not null)::text
   from public.waitlist_entries w where w.id = 'cd300000-0000-0000-0000-000000000007'),
  '12:00-13:00 500.00 true/accepted/true',
  'R6b: the slot kept its times; the entry is accepted and linked'
);


-- ============================================================
-- R6c  Time edit while an offer is running
-- ============================================================

do $$
begin
  perform pg_temp.send_edit('a',
    format('update public.facility_slots
            set start_time = ''20:00'', end_time = ''21:00''
            where id = %L', 'cd200000-0000-0000-0000-000000000008'));
  perform set_config('test.r6c_obs', pg_temp.observe(
    'a', current_setting('test.pid_a')::integer, null, 100), false);
  perform set_config('test.r6c_a', pg_temp.collect('a', 1), false);
end;
$$;

select is(
  current_setting('test.r6c_obs') || '|' ||
  case when current_setting('test.r6c_a') like '23514:%' then '23514' else current_setting('test.r6c_a') end,
  'finished|23514',
  'R6c: with a running offer the time edit is rejected at once (nothing to wait for)'
);

select is(
  pg_temp.slot_row('cd200000-0000-0000-0000-000000000008') || '/' ||
  (select status::text from public.waitlist_entries where id = 'cd300000-0000-0000-0000-000000000008'),
  '13:00-14:00 500.00 true/offered',
  'R6c: slot and offer are untouched'
);


-- ============================================================
-- R6d  Deactivation first, offer acceptance second
-- ============================================================

do $$
begin
  perform pg_temp.begin_as('a', 'cd000000-0000-0000-0000-000000000000');
  perform pg_temp.sync_exec('a',
    format('update public.facility_slots set is_active = false
            where id = %L', 'cd200000-0000-0000-0000-000000000009'));

  perform pg_temp.send_accept('b', 'cd000000-0000-0000-0000-000000000007', 'cd300000-0000-0000-0000-000000000009');
  perform set_config('test.r6d_obs', pg_temp.observe(
    'b', current_setting('test.pid_b')::integer, null, 100), false);

  perform dblink_exec('a', 'commit');
  perform set_config('test.r6d_b', pg_temp.collect('b', 3), false);
end;
$$;

select is(
  current_setting('test.r6d_obs'),
  'waiting',
  'R6d: the acceptance waits for the in-flight deactivation'
);

select is(
  current_setting('test.r6d_b'),
  'P0001: Selected slot is not active',
  'R6d: once it commits, the acceptance is refused cleanly'
);

select is(
  (select w.status::text || '/' || (w.booking_id is null)::text
   from public.waitlist_entries w where w.id = 'cd300000-0000-0000-0000-000000000009')
  || '/' ||
  (select count(*)::text from public.bookings where slot_id = 'cd200000-0000-0000-0000-000000000009'),
  'offered/true/0',
  'R6d: the offer is left exactly as it was: still offered, no booking'
);


-- ============================================================
-- J1  Waitlist join first, time edit second
--
-- Slot 10 has a confirmed booking (user 9) for current_date + 5, so
-- user 1 may join its waitlist. The join is held at its INSERT by a
-- table lock; it has validated the slot by then. The booking is then
-- cancelled, so the only live reference the edit can find is the
-- entry the join is about to commit.
-- ============================================================

do $$
begin
  -- conn c holds the table lock; with its lock_timeout a lock it
  -- cannot get is a recorded failure, not a hang.
  perform pg_temp.sync_exec('c', 'begin; set local lock_timeout = ''10s''');
  perform pg_temp.sync_exec('c', 'lock table public.waitlist_entries in share mode');

  -- the join is for the DATE STORED in the holder's booking
  perform pg_temp.send_join('b', 'cd000000-0000-0000-0000-000000000001',
                            'cd200000-0000-0000-0000-000000000010',
                            (select b.booking_date from public.bookings b
                             where b.id = 'cd400000-0000-0000-0000-000000000010'));
  perform set_config('test.j1_b_obs', pg_temp.observe_blocked(
    'b', current_setting('test.pid_b')::integer,
    current_setting('test.pid_c')::integer,
    'public.waitlist_entries'::regclass, 100), false);
end;
$$;

update public.bookings
set status = 'cancelled', cancelled_at = now()
where id = 'cd400000-0000-0000-0000-000000000010';

do $$
begin
  perform pg_temp.send_edit('a',
    format('update public.facility_slots
            set start_time = ''01:00'', end_time = ''01:30''
            where id = %L', 'cd200000-0000-0000-0000-000000000010'));
  perform set_config('test.j1_a_obs', pg_temp.observe_blocked(
    'a', current_setting('test.pid_a')::integer,
    current_setting('test.pid_b')::integer, null, 100), false);

  perform pg_temp.sync_exec('c', 'commit');
  perform set_config('test.j1_b', pg_temp.collect('b', 3), false);
  perform set_config('test.j1_a', pg_temp.collect('a', 1), false);
end;
$$;

select is(
  current_setting('test.j1_b_obs'),
  'waiting',
  'J1: the join is held at its insert (blocked by conn c on waitlist_entries), after it validated the slot'
);

select is(
  current_setting('test.j1_a_obs'),
  'waiting',
  'J1: the time edit waits for the in-flight join (blocked by conn b, which holds the slot row)'
);

select ok(
  current_setting('test.j1_b') like 'ok:%',
  'J1: the join succeeds'
);

select ok(
  current_setting('test.j1_a') like '23514:%',
  'J1: once the join commits, the time edit is rejected (the entry is live)'
);

select is(
  pg_temp.slot_row('cd200000-0000-0000-0000-000000000010'),
  '15:00-15:30 500.00 true',
  'J1: the slot kept its times'
);

select ok(
  exists (
    select 1 from public.waitlist_entries
    where slot_id = 'cd200000-0000-0000-0000-000000000010'
      and user_id = 'cd000000-0000-0000-0000-000000000001'
      and status in ('waiting', 'offered')
  ),
  'J1: the committed entry exists and is live'
);


-- ============================================================
-- J2  Time edit first, join second
--
-- Slot 11 has no references, so the edit is allowed. It moves the
-- slot outside operating hours. The join, which started after the
-- edit, must validate the NEW times (against the old ones it would
-- have reported the slot as available instead).
-- ============================================================

do $$
begin
  perform pg_temp.begin_as('a', 'cd000000-0000-0000-0000-000000000000');
  perform pg_temp.sync_exec('a',
    format('update public.facility_slots
            set start_time = ''04:00'', end_time = ''05:00''
            where id = %L', 'cd200000-0000-0000-0000-000000000011'));

  perform pg_temp.send_join('b', 'cd000000-0000-0000-0000-000000000002',
                            'cd200000-0000-0000-0000-000000000011',
                            current_date + 6);
  perform set_config('test.j2_obs', pg_temp.observe_blocked(
    'b', current_setting('test.pid_b')::integer,
    current_setting('test.pid_a')::integer, null, 100), false);

  perform dblink_exec('a', 'commit');
  perform set_config('test.j2_b', pg_temp.collect('b', 3), false);
end;
$$;

select is(
  current_setting('test.j2_obs'),
  'waiting',
  'J2: the join waits for the in-flight time edit (blocked by conn a)'
);

select is(
  current_setting('test.j2_b'),
  'P0001: Selected slot is not bookable on the selected date',
  'J2: the join validated the NEW times (outside operating hours)'
);

select is(
  pg_temp.slot_row('cd200000-0000-0000-0000-000000000011') || '/' ||
  (select count(*)::text from public.waitlist_entries
   where slot_id = 'cd200000-0000-0000-0000-000000000011'),
  '04:00-05:00 500.00 true/0',
  'J2: the slot has the new times and no entry was created'
);


-- ============================================================
-- J3  Deactivation first, join second
-- (slot 12 has a confirmed booking, so a join would otherwise be valid)
-- ============================================================

do $$
begin
  perform pg_temp.begin_as('a', 'cd000000-0000-0000-0000-000000000000');
  perform pg_temp.sync_exec('a',
    format('update public.facility_slots set is_active = false
            where id = %L', 'cd200000-0000-0000-0000-000000000012'));

  perform pg_temp.send_join('b', 'cd000000-0000-0000-0000-000000000003',
                            'cd200000-0000-0000-0000-000000000012',
                            (select b.booking_date from public.bookings b
                             where b.id = 'cd400000-0000-0000-0000-000000000012'));
  perform set_config('test.j3_obs', pg_temp.observe_blocked(
    'b', current_setting('test.pid_b')::integer,
    current_setting('test.pid_a')::integer, null, 100), false);

  perform dblink_exec('a', 'commit');
  perform set_config('test.j3_b', pg_temp.collect('b', 3), false);
end;
$$;

select is(
  current_setting('test.j3_obs'),
  'waiting',
  'J3: the join waits for the in-flight deactivation (blocked by conn a)'
);

select is(
  current_setting('test.j3_b'),
  'P0001: Selected slot is not active',
  'J3: once the deactivation commits, the join is refused'
);

select is(
  (select count(*)::text from public.waitlist_entries
   where slot_id = 'cd200000-0000-0000-0000-000000000012'),
  '0',
  'J3: no entry was created for the deactivated slot'
);


-- ============================================================
-- J4a  A rolled-back join does not block a later edit
--
-- User 1 joins slot 13 (in flight, entry inserted, nothing
-- committed). The booking that made the slot joinable is cancelled,
-- and the owner's time edit waits for the join. The join is then
-- rolled back: the edit proceeds and no entry remains.
-- ============================================================

do $$
begin
  perform pg_temp.begin_as('b', 'cd000000-0000-0000-0000-000000000001');
  perform pg_temp.sync_query('b',
    format('select entry_id::text, entries_ahead::text, null::text
            from public.join_waitlist(%L, %L, %L::date)',
           'cd100000-0000-0000-0000-000000000001', 'cd200000-0000-0000-0000-000000000013',
           (select b.booking_date from public.bookings b
            where b.id = 'cd400000-0000-0000-0000-000000000013')));
end;
$$;

update public.bookings
set status = 'cancelled', cancelled_at = now()
where id = 'cd400000-0000-0000-0000-000000000013';

do $$
begin
  perform pg_temp.send_edit('a',
    format('update public.facility_slots
            set start_time = ''03:00'', end_time = ''03:30''
            where id = %L', 'cd200000-0000-0000-0000-000000000013'));
  perform set_config('test.j4a_obs', pg_temp.observe_blocked(
    'a', current_setting('test.pid_a')::integer,
    current_setting('test.pid_b')::integer, null, 100), false);

  perform dblink_exec('b', 'rollback');
  perform set_config('test.j4a_a', pg_temp.collect('a', 1), false);
end;
$$;

select is(
  current_setting('test.j4a_obs'),
  'waiting',
  'J4a: the time edit waits for the in-flight join (blocked by conn b)'
);

select ok(
  current_setting('test.j4a_a') like 'ok:%',
  'J4a: once the join is rolled back, the time edit succeeds'
);

select is(
  pg_temp.slot_row('cd200000-0000-0000-0000-000000000013'),
  '03:00-03:30 500.00 true',
  'J4a: the slot has the new times'
);

select is(
  (select count(*)::text from public.waitlist_entries
   where slot_id = 'cd200000-0000-0000-0000-000000000013'),
  '0',
  'J4a: the rolled-back join left no entry'
);


-- ============================================================
-- J4b  A failed join leaves nothing behind
-- (slot 14 is available, so the join is refused)
-- ============================================================

do $$
begin
  perform pg_temp.send_join('b', 'cd000000-0000-0000-0000-000000000002',
                            'cd200000-0000-0000-0000-000000000014',
                            current_date + 9);
  perform set_config('test.j4b_b', pg_temp.collect('b', 3), false);

  perform pg_temp.send_edit('a',
    format('update public.facility_slots
            set start_time = ''02:00'', end_time = ''02:30''
            where id = %L', 'cd200000-0000-0000-0000-000000000014'));
  perform set_config('test.j4b_obs', pg_temp.observe(
    'a', current_setting('test.pid_a')::integer, null, 100), false);
  perform set_config('test.j4b_a', pg_temp.collect('a', 1), false);
end;
$$;

select is(
  current_setting('test.j4b_b'),
  'P0001: Selected slot is currently available; book it directly',
  'J4b: the join is refused'
);

select ok(
  current_setting('test.j4b_obs') = 'finished'
  and current_setting('test.j4b_a') like 'ok:%',
  'J4b: the time edit that follows is not blocked and succeeds'
);

select is(
  pg_temp.slot_row('cd200000-0000-0000-0000-000000000014') || '/' ||
  (select count(*)::text from public.waitlist_entries
   where slot_id = 'cd200000-0000-0000-0000-000000000014'),
  '02:00-02:30 500.00 true/0',
  'J4b: the slot has the new times and no entry exists'
);


-- ------------------------------------------------------------
-- Harness health: no setup or helper statement failed or timed out
-- (a failed lock acquisition would otherwise only show up as a
-- puzzling failure of a later assertion)
-- ------------------------------------------------------------

select is(
  coalesce(nullif(current_setting('test.harness_errors', true), ''), 'none'),
  'none',
  'harness: no setup or helper statement failed or timed out'
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

reset lock_timeout;

select * from finish();

\else

select plan(1);
select fail('slot lifecycle concurrency test cannot run: ' || :'prereq_msg');
select diag('No fixtures were created. Fix the prerequisite above and re-run.');
select * from finish();

\endif

\else

select plan(1);
select fail('slot lifecycle concurrency test REFUSED to run: this database is not '
  || 'positively identified as the local Supabase development stack '
  || '(database=' || :'env_db' || ', server address=' || :'env_addr' || ').');
select diag('This file commits fixture rows, so it only runs against the local stack started by `supabase start` with the default config.');
select diag('Run it with: supabase test db   (not --linked and not a remote --db-url).');
select diag('Nothing was created or committed.');
select * from finish();

\endif
