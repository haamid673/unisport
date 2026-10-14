begin;

select plan(37);


-- ============================================================
-- Table privilege model (migration 020)
--
-- This file tests the PRIVILEGE layer only: who holds which
-- table and column privileges, and that the database refuses
-- statements the privileges do not allow. It deliberately says
-- nothing about which ROWS RLS lets a role see or change; that
-- is covered by the other test files.
--
-- No fixtures are needed. Everything is rolled back at the end.
-- ============================================================


-- Effective table-level privileges of a role on a table, as a
-- sorted, comma-separated list. has_table_privilege() includes
-- privileges inherited through PUBLIC, so a stray PUBLIC grant
-- shows up here too. MAINTAIN exists from PostgreSQL 17.
create function pg_temp.table_privs(p_role text, p_table text)
returns text
language sql
as $$
  select coalesce(string_agg(p, ',' order by p), '')
  from unnest(
    case
      when current_setting('server_version_num')::int >= 170000
        then array['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE']
      else array['DELETE','INSERT','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE']
    end
  ) as p
  where has_table_privilege(p_role, p_table, p)
$$;

create function pg_temp.all_privs()
returns text
language sql
as $$
  select case
    when current_setting('server_version_num')::int >= 170000
      then 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'
    else 'DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'
  end
$$;

-- The intended model. anon: nothing. service_role: everything.
create temp table h1_expected (
  tbl text primary key,
  auth_privs text not null
);

insert into h1_expected (tbl, auth_privs)
values
  ('public.profiles',                 'SELECT'),
  ('public.facilities',               'DELETE,INSERT,SELECT,UPDATE'),
  ('public.facility_images',          'DELETE,INSERT,SELECT,UPDATE'),
  ('public.facility_operating_hours', 'DELETE,INSERT,SELECT,UPDATE'),
  ('public.facility_slots',           'DELETE,INSERT,SELECT,UPDATE'),
  ('public.bookings',                 'SELECT'),
  ('public.payments',                 'SELECT'),
  ('public.refunds',                  'SELECT'),
  ('public.waitlist_entries',         'SELECT');


-- ============================================================
-- 1. The model covers every table in public
-- ============================================================

select is(
  (select string_agg(c.relname, ',' order by c.relname)
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p', 'v', 'm', 'f')),
  (select string_agg(substr(tbl, 8), ',' order by tbl) from h1_expected),
  'public contains exactly the application tables this model covers'
);

select is(
  (select count(*)::integer
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   cross join lateral aclexplode(c.relacl) a
   where n.nspname = 'public'
     and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and a.grantee = 0),
  0,
  'no public table carries a PUBLIC (grantee 0) privilege'
);

select is(
  (select coalesce(string_agg(c.relname, ',' order by c.relname), '')
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and (
       pg_temp.table_privs('anon', format('public.%I', c.relname)) <> ''
       or pg_temp.table_privs('authenticated', format('public.%I', c.relname))
          ~ '(TRUNCATE|TRIGGER|REFERENCES|MAINTAIN)'
     )),
  '',
  'no public table gives anon anything or authenticated TRUNCATE/TRIGGER/REFERENCES/MAINTAIN'
);


-- ============================================================
-- 2. anon
-- ============================================================

select is(
  (select coalesce(string_agg(tbl, ',' order by tbl), '')
   from h1_expected
   where pg_temp.table_privs('anon', tbl) <> ''),
  '',
  'anon holds no table-level privilege on any application table'
);

select is(
  (select count(*)::integer
   from h1_expected e
   join pg_attribute a on a.attrelid = e.tbl::regclass
   where a.attnum > 0 and not a.attisdropped
     and (
       has_column_privilege('anon', e.tbl, a.attname, 'SELECT')
       or has_column_privilege('anon', e.tbl, a.attname, 'INSERT')
       or has_column_privilege('anon', e.tbl, a.attname, 'UPDATE')
       or has_column_privilege('anon', e.tbl, a.attname, 'REFERENCES')
     )),
  0,
  'and no column-level privilege on any column'
);


-- ============================================================
-- 3. authenticated: exact table-level privileges
-- ============================================================

select is(
  (select coalesce(
     string_agg(tbl || '=' || pg_temp.table_privs('authenticated', tbl), '; ' order by tbl),
     '')
   from h1_expected
   where pg_temp.table_privs('authenticated', tbl) <> auth_privs),
  '',
  'authenticated holds exactly the intended table privileges on every table'
);

select is(
  (select string_agg(tbl, ',' order by tbl)
   from h1_expected
   where has_table_privilege('authenticated', tbl, 'SELECT')),
  (select string_agg(tbl, ',' order by tbl) from h1_expected),
  'authenticated keeps SELECT on every application table'
);

select is(
  (select count(*)::integer
   from h1_expected
   where tbl in (
     'public.facilities', 'public.facility_images',
     'public.facility_operating_hours', 'public.facility_slots')
     and pg_temp.table_privs('authenticated', tbl) = 'DELETE,INSERT,SELECT,UPDATE'),
  4,
  'authenticated keeps SELECT, INSERT, UPDATE, DELETE on the four facility-management tables'
);

select is(
  (select coalesce(string_agg(tbl, ',' order by tbl), '')
   from h1_expected
   where tbl in (
     'public.bookings', 'public.payments',
     'public.refunds', 'public.waitlist_entries')
     and (
       has_table_privilege('authenticated', tbl, 'INSERT')
       or has_table_privilege('authenticated', tbl, 'UPDATE')
       or has_table_privilege('authenticated', tbl, 'DELETE')
     )),
  '',
  'authenticated has no direct INSERT/UPDATE/DELETE on bookings, payments, refunds or waitlist_entries'
);

select is(
  (select count(*)::integer
   from h1_expected e
   join pg_attribute a on a.attrelid = e.tbl::regclass
   where e.tbl in (
       'public.bookings', 'public.payments',
       'public.refunds', 'public.waitlist_entries')
     and a.attnum > 0 and not a.attisdropped
     and (
       has_column_privilege('authenticated', e.tbl, a.attname, 'INSERT')
       or has_column_privilege('authenticated', e.tbl, a.attname, 'UPDATE')
     )),
  0,
  'nor any column-level INSERT/UPDATE on those four tables'
);

select ok(
  not has_table_privilege('authenticated', 'public.bookings', 'TRUNCATE')
  and not has_table_privilege('authenticated', 'public.payments', 'TRUNCATE')
  and not has_table_privilege('authenticated', 'public.refunds', 'TRUNCATE')
  and not has_table_privilege('authenticated', 'public.facilities', 'TRUNCATE'),
  'authenticated cannot TRUNCATE the money and facility tables'
);


-- ============================================================
-- 4. profiles: table-level SELECT, four column-level UPDATEs
-- ============================================================

select ok(
  has_table_privilege('authenticated', 'public.profiles', 'SELECT'),
  'authenticated can SELECT profiles'
);

select ok(
  not has_table_privilege('authenticated', 'public.profiles', 'UPDATE'),
  'authenticated has no table-level UPDATE on profiles'
);

select is(
  (select string_agg(a.attname, ',' order by a.attname)
   from pg_attribute a
   where a.attrelid = 'public.profiles'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.profiles', a.attname, 'UPDATE')),
  'avatar_url,city,full_name,phone',
  'authenticated can UPDATE exactly full_name, phone, city and avatar_url'
);

select ok(
  not has_table_privilege('authenticated', 'public.profiles', 'INSERT')
  and not has_table_privilege('authenticated', 'public.profiles', 'DELETE'),
  'authenticated has no INSERT or DELETE on profiles'
);

select is(
  (select count(*)::integer
   from pg_attribute a
   where a.attrelid = 'public.profiles'::regclass
     and a.attnum > 0 and not a.attisdropped
     and (
       has_column_privilege('authenticated', 'public.profiles', a.attname, 'INSERT')
       or has_column_privilege('authenticated', 'public.profiles', a.attname, 'REFERENCES')
     )),
  0,
  'and no column-level INSERT or REFERENCES on profiles'
);


-- ============================================================
-- 5. service_role is unchanged
-- ============================================================

select is(
  (select coalesce(
     string_agg(tbl || '=' || pg_temp.table_privs('service_role', tbl), '; ' order by tbl),
     '')
   from h1_expected
   where pg_temp.table_privs('service_role', tbl) <> pg_temp.all_privs()),
  '',
  'service_role still holds every table privilege on every application table'
);


-- ============================================================
-- 6. Booking / waitlist function EXECUTE grants are unchanged
-- ============================================================

create temp table h1_functions (
  sig text primary key,
  anon_x boolean not null,
  auth_x boolean not null,
  svc_x boolean not null
);

insert into h1_functions (sig, anon_x, auth_x, svc_x)
values
  ('public.create_booking(uuid, uuid, date)',        false, true,  true),
  ('public.join_waitlist(uuid, uuid, date)',         false, true,  true),
  ('public.leave_waitlist(uuid)',                    false, true,  true),
  ('public.accept_waitlist_offer(uuid)',             false, true,  true),
  ('public.get_slot_availability(uuid, date)',       false, true,  true),
  ('public.offer_next_waitlist_entry(uuid, date)',   false, false, true),
  ('public.expire_waitlist_offers()',                false, false, true),
  ('public.process_waitlist()',                      false, false, true),
  ('public.expire_pending_bookings()',               false, false, true);

select is(
  (select coalesce(string_agg(sig, ',' order by sig), '')
   from h1_functions
   where has_function_privilege('authenticated', sig::regprocedure, 'EXECUTE') <> auth_x),
  '',
  'authenticated EXECUTE on the booking and waitlist functions is as before'
);

select is(
  (select coalesce(string_agg(sig, ',' order by sig), '')
   from h1_functions
   where has_function_privilege('anon', sig::regprocedure, 'EXECUTE') <> anon_x),
  '',
  'anon has no EXECUTE on the booking and waitlist functions'
);

select is(
  (select coalesce(string_agg(sig, ',' order by sig), '')
   from h1_functions
   where has_function_privilege('service_role', sig::regprocedure, 'EXECUTE') <> svc_x),
  '',
  'service_role EXECUTE on the booking and waitlist functions is as before'
);

select is(
  (select count(*)::integer
   from h1_functions f
   join pg_proc p on p.oid = f.sig::regprocedure
   cross join lateral aclexplode(p.proacl) a
   where a.grantee = 0),
  0,
  'none of those functions is executable through PUBLIC'
);

select is(
  (select count(*)::integer
   from h1_functions f
   join pg_proc p on p.oid = f.sig::regprocedure
   where p.prosecdef),
  9,
  'and all of them are still SECURITY DEFINER'
);


-- ============================================================
-- 7. The database enforces the privileges
--
-- Each statement is refused with 42501 "permission denied for
-- table", which is the privilege check. It happens before RLS
-- is consulted, so these do not depend on any policy.
-- ============================================================

set local role = 'authenticated';

select lives_ok(
  $$ select count(*) from public.profiles $$,
  'authenticated can SELECT from profiles'
);

select lives_ok(
  $$ select count(*) from public.bookings $$,
  'authenticated can SELECT from bookings'
);

select lives_ok(
  $$ select count(*) from public.facility_slots $$,
  'authenticated can SELECT from facility_slots'
);

select throws_ok(
  $$ insert into public.bookings default values $$,
  '42501', 'permission denied for table bookings',
  'authenticated cannot INSERT into bookings directly'
);

select throws_ok(
  $$ update public.bookings set status = 'confirmed' $$,
  '42501', 'permission denied for table bookings',
  'authenticated cannot UPDATE bookings directly'
);

select throws_ok(
  $$ delete from public.bookings $$,
  '42501', 'permission denied for table bookings',
  'authenticated cannot DELETE from bookings directly'
);

select throws_ok(
  $$ insert into public.payments default values $$,
  '42501', 'permission denied for table payments',
  'authenticated cannot INSERT into payments directly'
);

select throws_ok(
  $$ update public.refunds set reason = 'x' $$,
  '42501', 'permission denied for table refunds',
  'authenticated cannot UPDATE refunds directly'
);

select throws_ok(
  $$ delete from public.waitlist_entries $$,
  '42501', 'permission denied for table waitlist_entries',
  'authenticated cannot DELETE from waitlist_entries directly'
);

select throws_ok(
  $$ truncate public.facilities $$,
  '42501', 'permission denied for table facilities',
  'authenticated cannot TRUNCATE facilities'
);

select throws_ok(
  $$ delete from public.profiles $$,
  '42501', 'permission denied for table profiles',
  'authenticated cannot DELETE profiles'
);

select throws_ok(
  $$ update public.profiles set role = 'admin' $$,
  '42501', 'permission denied for table profiles',
  'authenticated cannot UPDATE profiles.role'
);

set local role = 'anon';

select throws_ok(
  $$ select count(*) from public.facilities $$,
  '42501', 'permission denied for table facilities',
  'anon cannot SELECT from facilities'
);

select throws_ok(
  $$ select count(*) from public.bookings $$,
  '42501', 'permission denied for table bookings',
  'anon cannot SELECT from bookings'
);

reset role;
set local role = 'service_role';

select lives_ok(
  $$ select count(*) from public.bookings $$,
  'service_role can still SELECT from bookings'
);

reset role;

select * from finish();

rollback;
