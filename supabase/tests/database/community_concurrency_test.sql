-- ============================================================
-- community functions concurrency tests (REAL multi-session)
--
-- Like waitlist_concurrency_test.sql this file does not run inside
-- one transaction. It opens separate connections with dblink and
-- drives the real functions through deterministic interleavings:
--
--   conn a, b  ->  two independent transactions
--
-- Scenarios
--   C1  two members race for the last place in an event
--   C2  a member leaves the group while joining one of its events
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
-- Fixtures use ids prefixed ce... Leftovers from an interrupted run
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
  select 'unisport-test-harness: installed by community_concurrency_test.sql; safe to drop'
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
        raise warning 'dblink installed by the community test harness was left in place: %', sqlerrm;
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
  if to_regprocedure('public.join_event(uuid)') is null then
    return 'the community migration is not applied to this database; '
        || 'apply it first (supabase migration up).';
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

select plan(9);


-- ------------------------------------------------------------
-- Helpers (session-local)
-- ------------------------------------------------------------

create function pg_temp.cleanup()
returns void
language sql
as $$
  delete from public.community_groups where created_by::text like 'ce000000-%';
  delete from public.facilities where id = 'ce200000-0000-0000-0000-000000000001';
  delete from auth.users where id::text like 'ce000000-%';
$$;

create function pg_temp.user_id(n integer) returns uuid
language sql as $$ select ('ce000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid; $$;

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
--
-- User 1 is an administrator (made by deleting the fresh profile and
-- inserting one with role 'admin'; the role trigger is never disabled),
-- so its group and events are approved at once. Users 2 and 3 are
-- members of that group. Event E1 has capacity 2 and one place taken
-- (by its creator); event E2 has no capacity limit.
-- ------------------------------------------------------------

do $$
begin
  perform pg_temp.cleanup();

  insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
  select pg_temp.user_id(n), 'comm-conc-user' || n || '@example.com', '', now(),
         jsonb_build_object('full_name', 'Community Concurrency User ' || n)
  from generate_series(1, 4) n;
end;
$$;

do $$
begin
  delete from public.profiles where id = pg_temp.user_id(1);
  insert into public.profiles (id, full_name, role)
  values (pg_temp.user_id(1), 'Community Concurrency Admin', 'admin');

  insert into public.facilities (id, owner_id, name, sport, address, city, status, base_price)
  values ('ce200000-0000-0000-0000-000000000001', pg_temp.user_id(4), 'Community Concurrency Court',
          'Badminton', '1 Road', 'Conctown', 'active', 500);
end;
$$;

do $$
declare v_group uuid;
begin
  perform set_config('request.jwt.claim.sub', pg_temp.user_id(1)::text, false);
  v_group := public.create_group('CE Concurrency Club', 'Badminton', 'Conctown');
  perform set_config('test.group', v_group::text, false);
  perform set_config('test.e1', public.create_event(v_group, 'CE Last Place', current_date + 5, '18:00', 'ce200000-0000-0000-0000-000000000001', 2)::text, false);
  perform set_config('test.e2', public.create_event(v_group, 'CE Open Event', current_date + 6, '18:00', 'ce200000-0000-0000-0000-000000000001', null)::text, false);

  perform set_config('request.jwt.claim.sub', pg_temp.user_id(2)::text, false);
  perform public.join_group(v_group);
  perform set_config('request.jwt.claim.sub', pg_temp.user_id(3)::text, false);
  perform public.join_group(v_group);
  perform set_config('request.jwt.claim.sub', '', false);
end;
$$;

do $$
begin
  perform dblink_connect('a', pg_temp.conninfo());
  perform dblink_connect('b', pg_temp.conninfo());

  perform set_config('test.pid_a', (select t.p from dblink('a', 'select pg_backend_pid()::text') as t(p text)), false);
  perform set_config('test.pid_b', (select t.p from dblink('b', 'select pg_backend_pid()::text') as t(p text)), false);
end;
$$;


-- ============================================================
-- C1  Two members race for the last place in an event
--
-- A: member 2 joins E1 (uncommitted). B: member 3 joins E1.
--
-- Correct: B waits for the event row; once A commits the event is
-- full and B is refused (UC002). Vulnerable: both succeed and the
-- event is over capacity.
-- ============================================================

do $$
begin
  perform dblink_exec('a', 'begin; set local role authenticated');
  perform dblink_exec('a', format('set local request.jwt.claim.sub = %L', pg_temp.user_id(2)));
end;
$$;

select is(
  (select t.r from dblink('a', format('select public.join_event(%L)::text', current_setting('test.e1'))) as t(r text)),
  'true',
  'C1: the first member takes the last place (its transaction stays open)'
);

do $$
begin
  perform dblink_exec('b', 'begin; set local role authenticated');
  perform dblink_exec('b', format('set local request.jwt.claim.sub = %L', pg_temp.user_id(3)));
  perform dblink_send_query('b', format('select public.join_event(%L)::text', current_setting('test.e1')));
  perform set_config('test.c1_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, 0, 100), false);
end;
$$;

select is(current_setting('test.c1_obs'), 'row', 'C1: the second join waits for the event row');

do $$
begin
  perform dblink_exec('a', 'commit');
  perform pg_temp.wait_idle('b', 50);
  perform set_config('test.c1_res', pg_temp.res1('b'), false);
  perform dblink_exec('b', 'rollback');
end;
$$;

select ok(current_setting('test.c1_res') like 'P0001:%' or current_setting('test.c1_res') like 'UC002:%',
  'C1: once the first join commits, the second is refused because the event is full');

select is(
  (select count(*)::int from public.event_participants where event_id = current_setting('test.e1')::uuid),
  2,
  'C1: the event holds exactly its capacity'
);

select is(
  (select count(*)::int from public.event_participants
   where event_id = current_setting('test.e1')::uuid and user_id = pg_temp.user_id(3)),
  0,
  'C1: the refused member did not get a place'
);


-- ============================================================
-- C2  A member leaves the group while joining one of its events
--
-- A: member 2 joins E2 (uncommitted).
-- B: member 2 leaves the group.
--
-- Correct: B waits (the group row is held shared by A); once A commits,
-- B removes the membership AND the new participation. Vulnerable: the
-- member is gone but still listed as a participant.
-- ============================================================

do $$
begin
  perform dblink_exec('a', 'begin; set local role authenticated');
  perform dblink_exec('a', format('set local request.jwt.claim.sub = %L', pg_temp.user_id(2)));
end;
$$;

select is(
  (select t.r from dblink('a', format('select public.join_event(%L)::text', current_setting('test.e2'))) as t(r text)),
  'true',
  'C2: the member joins an event (its transaction stays open)'
);

do $$
begin
  perform dblink_exec('b', 'begin; set local role authenticated');
  perform dblink_exec('b', format('set local request.jwt.claim.sub = %L', pg_temp.user_id(2)));
  perform dblink_send_query('b', format('select public.leave_group(%L)::text', current_setting('test.group')));
  perform set_config('test.c2_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, 0, 100), false);
end;
$$;

select is(current_setting('test.c2_obs'), 'row', 'C2: leaving the group waits for the join to finish');

do $$
begin
  perform dblink_exec('a', 'commit');
  perform pg_temp.wait_idle('b', 50);
  perform set_config('test.c2_res', pg_temp.res1('b'), false);
  perform dblink_exec('b', 'commit');
end;
$$;

select is(current_setting('test.c2_res'), 'ok:true', 'C2: the member then leaves the group');

select is(
  (select (select count(*) from public.group_members where group_id = current_setting('test.group')::uuid and user_id = pg_temp.user_id(2))
        + (select count(*) from public.event_participants where event_id = current_setting('test.e2')::uuid and user_id = pg_temp.user_id(2)))::int,
  0,
  'C2: no membership and no participation remain'
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
select fail('admin functions concurrency test cannot run: ' || :'prereq_msg');
select diag('No fixtures were created. Fix the prerequisite above and re-run.');
select * from finish();

\endif

\else

select plan(1);
select fail('admin functions concurrency test REFUSED to run: this database is not '
  || 'positively identified as the local Supabase development stack '
  || '(database=' || :'env_db' || ', server address=' || :'env_addr' || ').');
select diag('This file commits fixture rows, so it only runs against the local stack started by `supabase start` with the default config.');
select diag('Run it with: supabase test db   (not --linked and not a remote --db-url).');
select diag('Nothing was created or committed.');
select * from finish();

\endif
