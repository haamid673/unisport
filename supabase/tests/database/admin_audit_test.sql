begin;

select plan(26);

-- ============================================================
-- Audit trail of administrator actions
--
-- Users (a7000000-0000-0000-0000-00000000000N)
--   01 ADMIN   02 OWNER   03 PLAYER
-- Admin and owner are made by deleting the fresh profile and inserting
-- one with the role; no trigger is disabled. Everything is rolled back.
-- ============================================================

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
select ('a7000000-0000-0000-0000-00000000000' || n)::uuid,
       (array['audit-admin','audit-owner','audit-player'])[n] || '@example.com', '', now(),
       jsonb_build_object('full_name', 'Audit ' || n)
from generate_series(1, 3) n;

delete from public.profiles where id in
  ('a7000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000002');
insert into public.profiles (id, full_name, role) values
  ('a7000000-0000-0000-0000-000000000001', 'Audit Admin', 'admin'),
  ('a7000000-0000-0000-0000-000000000002', 'Audit Owner', 'owner');

insert into public.facilities (id, owner_id, name, sport, address, city, status, base_price)
values ('a7100000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000002',
        'Audit Court', 'Badminton', '1 Road', 'Audittown', 'pending', 500);

create function pg_temp.as_user(n integer) returns void language sql as $$
  select set_config('request.jwt.claim.sub', ('a7000000-0000-0000-0000-00000000000' || n)::text, true);
$$;
create function pg_temp.as_nobody() returns void language sql as $$
  select set_config('request.jwt.claim.sub', '', true);
$$;
create function pg_temp.fac() returns uuid language sql as $$
  select 'a7100000-0000-0000-0000-000000000001'::uuid;
$$;
create function pg_temp.n(p_type text) returns integer language sql as $$
  select count(*)::int from public.admin_actions
  where target_type = p_type and admin_email like 'audit-%';
$$;
create temp table ids (k text primary key, v uuid) on commit drop;

-- catalog and privileges

select is((select relrowsecurity from pg_class where oid = 'public.admin_actions'::regclass), true, 'row level security is on');
select is(
  (select count(*)::int from (values ('anon'),('authenticated')) r(role_name)
   cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) p(priv)
   where has_table_privilege(r.role_name, 'public.admin_actions', p.priv)),
  0, 'no client role holds any privilege on the table'
);
select is((select count(*)::int from pg_policy where polrelid = 'public.admin_actions'::regclass), 0, 'there are no policies');
select ok(not has_function_privilege('authenticated', 'public.audit_admin_change()', 'EXECUTE'), 'clients cannot call the trigger function');
select ok(
  not has_function_privilege('anon', 'public.admin_list_actions(integer)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.admin_list_actions(integer)', 'EXECUTE'),
  'anon cannot read the trail; signed-in users may call it (and are checked inside)'
);

-- reading is admin-only

select pg_temp.as_nobody();
select throws_ok($$select * from public.admin_list_actions()$$, '28000', null, 'signed out is refused');
select pg_temp.as_user(3);
select throws_ok($$select * from public.admin_list_actions()$$, '42501', null, 'a player is refused');
select pg_temp.as_user(2);
select throws_ok($$select * from public.admin_list_actions()$$, '42501', null, 'an owner is refused');

-- venue decisions

select pg_temp.as_user(1);
select public.admin_set_facility_status(pg_temp.fac(), 'active');
select is(pg_temp.n('facility'), 1, 'approving a venue is recorded');
select is(
  (select admin_email || ' ' || target_label || ' ' || old_value || '>' || new_value
   from public.admin_actions where target_id = pg_temp.fac()),
  'audit-admin@example.com Audit Court pending>active',
  'with who, what, and from and to'
);
select public.admin_set_facility_status(pg_temp.fac(), 'active');
select is(pg_temp.n('facility'), 1, 'repeating the same decision records nothing');
select public.admin_set_facility_status(pg_temp.fac(), 'suspended');
select is(pg_temp.n('facility'), 2, 'a new decision is a new row');

-- an administrator writing the venue directly through RLS is covered too
update public.facilities set status = 'active' where id = pg_temp.fac();
select is(pg_temp.n('facility'), 3, 'a direct status update by an administrator is recorded');

-- an owner editing other fields is not an admin action
select pg_temp.as_user(2);
update public.facilities set description = 'edited' where id = pg_temp.fac();
select is(pg_temp.n('facility'), 3, 'an owner editing a venue records nothing');

-- a status change while a non-administrator is signed in (the session here
-- is the table owner, so RLS does not stop it: only the audit rule is tested)
update public.facilities set status = 'suspended' where id = pg_temp.fac();
select is(pg_temp.n('facility'), 3, 'a change by a signed-in non-administrator is not recorded as an admin action');

-- something changed with no signed-in admin (a job, a maintenance script)
select pg_temp.as_nobody();
update public.facilities set status = 'pending' where id = pg_temp.fac();
select is(pg_temp.n('facility'), 3, 'a change with no signed-in user records nothing');

-- roles

select pg_temp.as_user(1);
select public.admin_set_user_role('a7000000-0000-0000-0000-000000000003', 'owner');
select is(pg_temp.n('user'), 1, 'a role change is recorded');
select is(
  (select target_label || ' ' || old_value || '>' || new_value from public.admin_actions where target_type = 'user' and admin_email like 'audit-%'),
  'audit-player@example.com user>owner',
  'naming the account and the roles'
);
select throws_ok($$select public.admin_set_user_role('a7000000-0000-0000-0000-000000000001', 'user')$$, 'UB007', null, 'a refused role change still fails');
select is(pg_temp.n('user'), 1, 'and records nothing');

-- community decisions

select pg_temp.as_user(3);
insert into ids select 'g', public.create_group('Audit Club', 'Badminton', 'Audittown');
select is(pg_temp.n('group'), 0, 'creating a community is not an admin action');
select pg_temp.as_user(1);
select public.admin_set_group_status((select v from ids where k = 'g'), 'approved');
select is(pg_temp.n('group'), 1, 'approving a community is recorded');

select public.admin_set_facility_status(pg_temp.fac(), 'active');
select pg_temp.as_user(3);
insert into ids select 'e', public.create_event((select v from ids where k = 'g'), 'Audit Event', current_date + 3, '18:00', pg_temp.fac());
select pg_temp.as_user(1);
select public.admin_set_event_status((select v from ids where k = 'e'), 'rejected');
select is(pg_temp.n('event'), 1, 'rejecting an event is recorded');

-- reading

select is((select count(*)::int from public.admin_list_actions(2)), 2, 'the limit is honoured');
select is((select count(*)::int from public.admin_list_actions(0)), 1, 'a limit below 1 is clamped to 1');
select is(
  (select target_type from public.admin_list_actions(1)),
  'event',
  'newest first'
);

select * from finish();
rollback;
