begin;

select plan(13);

-- ============================================================
-- Catalog-wide client privilege regression
--
-- Unlike table_privileges_test.sql (which lists known tables), this
-- file reads the CATALOG: every table, column and routine that
-- exists in the public schema is compared with an explicit
-- allow-list. A table or function added by a later migration and
-- forgotten in a REVOKE (Supabase's default privileges grant anon
-- and authenticated full access to new tables, including TRUNCATE,
-- and EXECUTE on new functions) fails here without anyone having
-- to remember to list it.
--
-- To intentionally grant a client privilege, add the exact
-- (object, privilege) pair to the allow-list below in the same
-- migration's pull request.
--
-- Nothing is written outside this rolled-back transaction.
-- ============================================================

-- ------------------------------------------------------------
-- Allow-lists
-- ------------------------------------------------------------

-- Table privileges the `authenticated` role is meant to hold.
-- (`anon` and PUBLIC hold none.) has_table_privilege() is true for
-- grants made to PUBLIC as well, so a PUBLIC grant is caught too.
create temp table expected_table_privs (
  table_name text not null,
  privilege text not null,
  primary key (table_name, privilege)
) on commit drop;

insert into expected_table_privs (table_name, privilege) values
  -- read-only for clients; written only by SECURITY DEFINER functions
  ('bookings',                 'SELECT'),
  ('payments',                 'SELECT'),
  ('refunds',                  'SELECT'),
  ('payment_attempts',         'SELECT'),
  ('waitlist_entries',         'SELECT'),
  ('profiles',                 'SELECT'),
  -- owner-managed through RLS
  ('facilities',               'SELECT'),
  ('facilities',               'INSERT'),
  ('facilities',               'UPDATE'),
  ('facilities',               'DELETE'),
  ('facility_images',          'SELECT'),
  ('facility_images',          'INSERT'),
  ('facility_images',          'UPDATE'),
  ('facility_images',          'DELETE'),
  ('facility_operating_hours', 'SELECT'),
  ('facility_operating_hours', 'INSERT'),
  ('facility_operating_hours', 'UPDATE'),
  ('facility_operating_hours', 'DELETE'),
  ('facility_slots',           'SELECT'),
  ('facility_slots',           'INSERT'),
  ('facility_slots',           'UPDATE'),
  ('facility_slots',           'DELETE');
-- NOT listed on purpose (clients hold nothing): payment_events,
-- reconciliation_runs.

-- Column-level privileges a client role may hold.
create temp table expected_column_privs (
  table_name text not null,
  column_name text not null,
  privilege text not null,
  primary key (table_name, column_name, privilege)
) on commit drop;

insert into expected_column_privs values
  ('profiles', 'full_name',  'UPDATE'),
  ('profiles', 'phone',      'UPDATE'),
  ('profiles', 'city',       'UPDATE'),
  ('profiles', 'avatar_url', 'UPDATE');

-- Routines (outside extensions) clients may execute.
create temp table expected_routine_exec (
  signature text not null,
  role_name text not null,
  primary key (signature, role_name)
) on commit drop;

insert into expected_routine_exec values
  -- client RPC API
  ('create_booking(uuid,uuid,date)',         'authenticated'),
  ('cancel_booking(uuid)',                   'authenticated'),
  ('admin_set_facility_status(uuid,facility_status)', 'authenticated'),
  ('admin_find_user_by_email(text)',          'authenticated'),
  ('admin_set_user_role(uuid,user_role)',     'authenticated'),
  ('create_group(text,text,text,text)', 'authenticated'),
  ('join_group(uuid)', 'authenticated'),
  ('leave_group(uuid)', 'authenticated'),
  ('create_event(uuid,text,date,time without time zone,uuid,integer)', 'authenticated'),
  ('join_event(uuid)', 'authenticated'),
  ('leave_event(uuid)', 'authenticated'),
  ('get_community_groups()', 'authenticated'),
  ('get_community_events(uuid,boolean)', 'authenticated'),
  ('admin_list_community_groups(approval_status)', 'authenticated'),
  ('admin_list_community_events(approval_status)', 'authenticated'),
  ('admin_set_group_status(uuid,approval_status)', 'authenticated'),
  ('admin_set_event_status(uuid,approval_status)', 'authenticated'),
  ('join_waitlist(uuid,uuid,date)',          'authenticated'),
  ('leave_waitlist(uuid)',                   'authenticated'),
  ('accept_waitlist_offer(uuid)',            'authenticated'),
  ('get_slot_availability(uuid,date)',       'authenticated'),
  -- boolean helpers used inside RLS policies
  ('is_admin()',                             'anon'),
  ('is_admin()',                             'authenticated'),
  ('owns_facility(uuid)',                    'anon'),
  ('owns_facility(uuid)',                    'authenticated');

-- ------------------------------------------------------------
-- Observed state, from the catalog
-- ------------------------------------------------------------

create temp table observed_table_privs on commit drop as
select
  c.relname::text as table_name,
  r.role_name,
  p.privilege
from pg_class c
cross join (values ('anon'), ('authenticated')) r(role_name)
cross join (
  values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
         ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
) p(privilege)
where c.relnamespace = 'public'::regnamespace
  and c.relkind in ('r', 'p')
  and has_table_privilege(r.role_name, c.oid, p.privilege);

-- MAINTAIN exists from PostgreSQL 17; include it when present.
do $$
begin
  if current_setting('server_version_num')::integer >= 170000 then
    insert into observed_table_privs
    select c.relname::text, r.role_name, 'MAINTAIN'
    from pg_class c
    cross join (values ('anon'), ('authenticated')) r(role_name)
    where c.relnamespace = 'public'::regnamespace
      and c.relkind in ('r', 'p')
      and has_table_privilege(r.role_name, c.oid, 'MAINTAIN');
  end if;
end;
$$;

-- ------------------------------------------------------------
-- 1. The tables exist in the catalog the way this test assumes
-- ------------------------------------------------------------

select ok(
  (select count(*) from pg_class
   where relnamespace = 'public'::regnamespace and relkind in ('r', 'p')) >= 12
  and to_regclass('public.payment_attempts') is not null
  and to_regclass('public.payment_events') is not null
  and to_regclass('public.reconciliation_runs') is not null,
  'the catalog scan covers every public table, including the new payment tables'
);

-- ------------------------------------------------------------
-- 2. anon holds no table privilege anywhere
-- ------------------------------------------------------------

select is(
  (select coalesce(string_agg(table_name || ':' || privilege, ', ' order by table_name, privilege), '')
   from observed_table_privs where role_name = 'anon'),
  '',
  'anon has no privilege on any public table'
);

-- ------------------------------------------------------------
-- 3. authenticated holds exactly the allow-listed table privileges
-- ------------------------------------------------------------

select is(
  (select coalesce(string_agg(d.what, ', ' order by d.what), '')
   from (
     select 'UNEXPECTED ' || o.table_name || ':' || o.privilege as what
     from observed_table_privs o
     where o.role_name = 'authenticated'
       and not exists (
         select 1 from expected_table_privs e
         where e.table_name = o.table_name and e.privilege = o.privilege)
     union all
     select 'MISSING ' || e.table_name || ':' || e.privilege
     from expected_table_privs e
     where not exists (
       select 1 from observed_table_privs o
       where o.role_name = 'authenticated'
         and o.table_name = e.table_name and o.privilege = e.privilege)
   ) d),
  '',
  'authenticated holds exactly the allow-listed table privileges (no TRUNCATE, REFERENCES, TRIGGER or MAINTAIN anywhere)'
);

-- ------------------------------------------------------------
-- 4. Column-level privileges are exactly the allow-list
-- ------------------------------------------------------------

select is(
  (select coalesce(string_agg(d.what, ', ' order by d.what), '')
   from (
     select 'UNEXPECTED ' || c.relname || '.' || a.attname || ':' || x.privilege_type as what
     from pg_attribute a
     join pg_class c on c.oid = a.attrelid
     cross join lateral aclexplode(a.attacl) x
     join pg_roles g on g.oid = x.grantee
     where c.relnamespace = 'public'::regnamespace
       and a.attacl is not null
       and (x.grantee = 0 or g.rolname in ('anon', 'authenticated'))
       and not exists (
         select 1 from expected_column_privs e
         where e.table_name = c.relname and e.column_name = a.attname
           and e.privilege = x.privilege_type)
     union all
     select 'MISSING ' || e.table_name || '.' || e.column_name || ':' || e.privilege
     from expected_column_privs e
     where not has_column_privilege('authenticated', ('public.' || e.table_name)::regclass,
                                    e.column_name, e.privilege)
   ) d),
  '',
  'column-level client privileges are exactly the allow-list'
);

-- ------------------------------------------------------------
-- 5. Row Level Security is enabled on every public table
-- ------------------------------------------------------------

select is(
  (select coalesce(string_agg(relname, ', ' order by relname), '')
   from pg_class
   where relnamespace = 'public'::regnamespace
     and relkind in ('r', 'p')
     and not relrowsecurity),
  '',
  'every public table has Row Level Security enabled'
);

-- ------------------------------------------------------------
-- 6. Routines: clients may execute exactly the allow-list
-- ------------------------------------------------------------

create temp table observed_routine_exec on commit drop as
select
  (p.proname || '(' || replace(oidvectortypes(p.proargtypes), ', ', ',') || ')') as signature,
  r.role_name
from pg_proc p
cross join (values ('anon'), ('authenticated')) r(role_name)
where p.pronamespace = 'public'::regnamespace
  and p.prokind in ('f', 'p')
  and not exists (
    select 1 from pg_depend d
    where d.objid = p.oid and d.deptype = 'e')   -- not extension-owned
  and has_function_privilege(r.role_name, p.oid, 'EXECUTE');

select is(
  (select coalesce(string_agg(d.what, ', ' order by d.what), '')
   from (
     select 'UNEXPECTED ' || o.signature || ' -> ' || o.role_name as what
     from observed_routine_exec o
     where not exists (
       select 1 from expected_routine_exec e
       where e.signature = o.signature and e.role_name = o.role_name)
     union all
     select 'MISSING ' || e.signature || ' -> ' || e.role_name
     from expected_routine_exec e
     where not exists (
       select 1 from observed_routine_exec o
       where o.signature = e.signature and o.role_name = e.role_name)
   ) d),
  '',
  'anon and authenticated can execute exactly the allow-listed public routines'
);

-- ------------------------------------------------------------
-- 7. Trigger functions hold no PUBLIC/anon/authenticated EXECUTE
-- ------------------------------------------------------------

select is(
  (select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.prorettype = 'trigger'::regtype
     and exists (
       select 1 from aclexplode(p.proacl) x
       where x.privilege_type = 'EXECUTE'
         and (x.grantee = 0
              or x.grantee in (select oid from pg_roles
                               where rolname in ('anon', 'authenticated')))
     )),
  '',
  'no public trigger function grants EXECUTE to PUBLIC, anon or authenticated'
);

-- ------------------------------------------------------------
-- 8. Every SECURITY DEFINER routine has a pinned search_path
-- ------------------------------------------------------------

select is(
  (select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.prosecdef
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
     and not exists (
       select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
       where cfg like 'search_path=%')),
  '',
  'every SECURITY DEFINER routine in public pins its search_path'
);

-- ------------------------------------------------------------
-- 9. The new payment routines exist and are not callable by clients
-- ------------------------------------------------------------

select is(
  (select count(*)::integer
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in (
       'payment_attempts_guard', 'payments_guard_observation',
       'refunds_guard_state_and_reservation',
       'bookings_guard_identity', 'bookings_guard_fulfilment',
       'bookings_guard_fulfilment_eligibility')
     and not has_function_privilege('anon', p.oid, 'EXECUTE')
     and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
     and not has_function_privilege('service_role', p.oid, 'EXECUTE')),
  6,
  'the six new trigger functions exist and neither clients nor service_role can execute them'
);

-- ------------------------------------------------------------
-- 10. No sequence privilege leaks to clients
-- ------------------------------------------------------------

select is(
  (select coalesce(string_agg(c.relname || ':' || r.role_name, ', ' order by c.relname), '')
   from pg_class c
   cross join (values ('anon'), ('authenticated')) r(role_name)
   where c.relnamespace = 'public'::regnamespace
     and c.relkind = 'S'
     and (has_sequence_privilege(r.role_name, c.oid, 'USAGE')
          or has_sequence_privilege(r.role_name, c.oid, 'UPDATE'))),
  '',
  'clients hold no privilege on any public sequence'
);

-- ------------------------------------------------------------
-- 11-13. service_role on the payment tables
--
-- service_role is the trusted server credential and legitimately
-- needs to read, insert and update payment data. It must not hold
-- TRUNCATE (fires no trigger, so it would bypass every guard and
-- reach bookings through CASCADE), DELETE (would erase processed
-- money movements), TRIGGER or REFERENCES. Intentional exceptions:
-- none. MAINTAIN (PostgreSQL 17) is tolerated: it cannot alter
-- rows. Any future public table named like a payment table is
-- covered by the name pattern, so a new one that keeps Supabase's
-- default full grants fails here.
-- ------------------------------------------------------------

create temp table payment_tables on commit drop as
select c.relname::text as table_name, c.oid as table_oid
from pg_class c
where c.relnamespace = 'public'::regnamespace
  and c.relkind in ('r', 'p')
  and (c.relname in ('payments', 'refunds', 'reconciliation_runs')
       or c.relname like 'payment\_%');

select is(
  (select string_agg(table_name, ',' order by table_name) from payment_tables),
  'payment_attempts,payment_events,payments,reconciliation_runs,refunds',
  'the name pattern finds exactly the five payment tables'
);

select is(
  (select coalesce(string_agg(t.table_name || ':' || p.privilege, ', '
                              order by t.table_name, p.privilege), '')
   from payment_tables t
   cross join (values ('TRUNCATE'), ('DELETE'), ('TRIGGER'), ('REFERENCES')) p(privilege)
   where has_table_privilege('service_role', t.table_oid, p.privilege)),
  '',
  'service_role holds no TRUNCATE, DELETE, TRIGGER or REFERENCES on any payment table'
);

select is(
  (select coalesce(string_agg(t.table_name || ':' || p.privilege, ', '
                              order by t.table_name, p.privilege), '')
   from payment_tables t
   cross join (values ('SELECT'), ('INSERT'), ('UPDATE')) p(privilege)
   where not has_table_privilege('service_role', t.table_oid, p.privilege)),
  '',
  'service_role keeps SELECT, INSERT and UPDATE on every payment table'
);

select * from finish();

rollback;
