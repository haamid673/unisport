-- ============================================================
-- admin_set_user_role() concurrency tests (REAL multi-session)
--
-- Like waitlist_concurrency_test.sql this file does not run inside
-- one transaction. It opens separate connections with dblink and
-- drives the real functions through deterministic interleavings:
--
--   conn a, b  ->  two independent transactions
--
-- Scenarios
--   M1  two administrators demote each other at the same moment
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
-- Fixtures use ids prefixed ad... Leftovers from an interrupted run
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
  select 'unisport-test-harness: installed by admin_functions_concurrency_test.sql; safe to drop'
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
        raise warning 'dblink installed by the admin_functions test harness was left in place: %', sqlerrm;
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
  if to_regprocedure('public.admin_set_user_role(uuid,public.user_role)') is null then
    return 'the admin functions migration is not applied to this database; '
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

select plan(5);


-- ------------------------------------------------------------
-- Helpers (session-local)
-- ------------------------------------------------------------

create function pg_temp.cleanup()
returns void
language sql
as $$
  delete from auth.users where id::text like 'ad000000-%';
$$;

create function pg_temp.user_id(n integer) returns uuid
language sql as $$ select ('ad000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid; $$;

-- The key admin_set_user_role() takes.
create function pg_temp.role_key() returns bigint
language sql as $$ select hashtextextended('admin-role-changes', 0) $$;

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
-- Two administrators (1, 2). Admin profiles are made by deleting the
-- fresh profile and inserting one with role 'admin'; the role
-- protection trigger is never disabled.
-- ------------------------------------------------------------

do $$
begin
  perform pg_temp.cleanup();

  insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
  select
    pg_temp.user_id(n), 'admin-conc-user' || n || '@example.com', '', now(),
    jsonb_build_object('full_name', 'Admin Concurrency User ' || n)
  from generate_series(1, 2) n;
end;
$$;

do $$
begin
  delete from public.profiles where id in (pg_temp.user_id(1), pg_temp.user_id(2));
  insert into public.profiles (id, full_name, role) values
    (pg_temp.user_id(1), 'Admin Concurrency 1', 'admin'),
    (pg_temp.user_id(2), 'Admin Concurrency 2', 'admin');
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
-- M1  Two administrators demote each other at the same moment
--
-- A: admin 1 demotes admin 2 (uncommitted).
-- B: admin 2 demotes admin 1.
--
-- Correct: B waits on the role-change lock; once A commits, B is
-- no longer an administrator and is refused (42501), so exactly one
-- administrator remains. Vulnerable: both succeed and the platform is
-- left with none.
-- ============================================================

do $$
begin
  perform dblink_exec('a', 'begin; set local role authenticated');
  perform dblink_exec('a', format('set local request.jwt.claim.sub = %L', pg_temp.user_id(1)));
end;
$$;

select is(
  (select t.r from dblink('a', format('select public.admin_set_user_role(%L, ''user'')::text', pg_temp.user_id(2))) as t(r text)),
  'user',
  'M1: admin 1 demotes admin 2 (its transaction stays open)'
);

do $$
begin
  perform dblink_exec('b', 'begin; set local role authenticated');
  perform dblink_exec('b', format('set local request.jwt.claim.sub = %L', pg_temp.user_id(2)));
  perform dblink_send_query('b', format('select public.admin_set_user_role(%L, ''user'')::text', pg_temp.user_id(1)));
  perform set_config('test.m1_obs',
    pg_temp.observe('b', current_setting('test.pid_b')::integer, pg_temp.role_key(), 100), false);
end;
$$;

select is(
  current_setting('test.m1_obs'),
  'advisory',
  'M1: the second demotion waits on the role-change lock'
);

do $$
begin
  perform dblink_exec('a', 'commit');
  perform pg_temp.wait_idle('b', 50);
  perform set_config('test.m1_res', pg_temp.res1('b'), false);
  perform dblink_exec('b', 'rollback');
end;
$$;

select ok(
  current_setting('test.m1_res') like '42501:%',
  'M1: once admin 1 has committed, admin 2 is no longer an administrator and is refused'
);

select is(
  (select count(*)::int from public.profiles
   where id in (pg_temp.user_id(1), pg_temp.user_id(2)) and role = 'admin'),
  1,
  'M1: exactly one administrator remains'
);

select is(
  (select role::text from public.profiles where id = pg_temp.user_id(1)),
  'admin',
  'M1: it is the one whose demotion went first'
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
