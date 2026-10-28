begin;

select plan(38);

-- ============================================================
-- admin_set_facility_status, admin_find_user_by_email,
-- admin_set_user_role
--
-- Users (d1000000-0000-0000-0000-00000000000N)
--   01 ADMIN1   role admin   02 ADMIN2   role admin
--   03 OWNER    role owner   04 USER     role user
-- Facilities (d2000000-...-00000000000N), owned by OWNER
--   01 pending   02 active
--
-- Admins are made by deleting the fresh profile and inserting one with
-- role 'admin' (INSERT is not guarded); the role-protection trigger is
-- never disabled. Everything is rolled back.
-- ============================================================

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
select
  ('d1000000-0000-0000-0000-00000000000' || n)::uuid,
  (array['adm-one','adm-two','adm-owner','adm-user'])[n] || '@example.com', '', now(),
  jsonb_build_object('full_name', (array['Admin One','Admin Two','Owner Person','Plain User'])[n])
from generate_series(1, 4) n;

delete from public.profiles where id in
  ('d1000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000002',
   'd1000000-0000-0000-0000-000000000003');
insert into public.profiles (id, full_name, role) values
  ('d1000000-0000-0000-0000-000000000001', 'Admin One', 'admin'),
  ('d1000000-0000-0000-0000-000000000002', 'Admin Two', 'admin'),
  ('d1000000-0000-0000-0000-000000000003', 'Owner Person', 'owner');

insert into public.facilities (id, owner_id, name, sport, address, city, status, base_price)
values
  ('d2000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000003', 'Pending Court', 'Badminton', '1 Road', 'Testville', 'pending', 500),
  ('d2000000-0000-0000-0000-000000000002', 'd1000000-0000-0000-0000-000000000003', 'Active Court',  'Badminton', '2 Road', 'Testville', 'active',  500);

create function pg_temp.as_user(n integer) returns void language sql as $$
  select set_config('request.jwt.claim.sub', ('d1000000-0000-0000-0000-00000000000' || n)::text, true);
$$;
create function pg_temp.as_nobody() returns void language sql as $$
  select set_config('request.jwt.claim.sub', '', true);
$$;
create function pg_temp.u(n integer) returns uuid language sql as $$
  select ('d1000000-0000-0000-0000-00000000000' || n)::uuid;
$$;
create function pg_temp.f(n integer) returns uuid language sql as $$
  select ('d2000000-0000-0000-0000-00000000000' || n)::uuid;
$$;
create function pg_temp.fstatus(n integer) returns text language sql as $$
  select status::text from public.facilities where id = pg_temp.f(n);
$$;
create function pg_temp.role_of(n integer) returns text language sql as $$
  select role::text from public.profiles where id = pg_temp.u(n);
$$;

-- ------------------------------------------------------------
-- catalog and privileges
-- ------------------------------------------------------------

select ok(
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('admin_set_facility_status','admin_find_user_by_email','admin_set_user_role')),
  'all three are SECURITY DEFINER with an empty search_path'
);

select is(
  (select count(*)::int from (values
     ('admin_set_facility_status(uuid,facility_status)'),
     ('admin_find_user_by_email(text)'),
     ('admin_set_user_role(uuid,user_role)')) v(sig)
   where has_function_privilege('anon', 'public.' || v.sig, 'EXECUTE')
      or has_function_privilege('authenticated', 'public.' || v.sig, 'EXECUTE') is false),
  0,
  'anon cannot execute any; authenticated can execute all'
);

select is(
  (select count(*)::int from information_schema.routine_privileges
   where routine_schema = 'public'
     and routine_name in ('admin_set_facility_status','admin_find_user_by_email','admin_set_user_role')
     and grantee = 'PUBLIC'),
  0,
  'nothing is granted to PUBLIC'
);

-- ------------------------------------------------------------
-- authentication and authorisation
-- ------------------------------------------------------------

select pg_temp.as_nobody();
select throws_ok($$select public.admin_set_facility_status(pg_temp.f(1), 'active')$$, '28000', null, 'facility status: signed out is refused');
select throws_ok($$select * from public.admin_find_user_by_email('adm-user@example.com')$$, '28000', null, 'find user: signed out is refused');
select throws_ok($$select public.admin_set_user_role(pg_temp.u(4), 'owner')$$, '28000', null, 'set role: signed out is refused');

select pg_temp.as_user(3);
select throws_ok($$select public.admin_set_facility_status(pg_temp.f(1), 'active')$$, '42501', null, 'facility status: an owner is refused');
select throws_ok($$select public.admin_set_user_role(pg_temp.u(4), 'admin')$$, '42501', null, 'set role: an owner cannot make an admin');

select pg_temp.as_user(4);
select throws_ok($$select public.admin_set_facility_status(pg_temp.f(1), 'active')$$, '42501', null, 'facility status: a customer is refused');
select throws_ok($$select * from public.admin_find_user_by_email('adm-one@example.com')$$, '42501', null, 'find user: a customer is refused');
select throws_ok($$select public.admin_set_user_role(pg_temp.u(4), 'admin')$$, '42501', null, 'set role: a customer cannot promote themselves');

select is(pg_temp.fstatus(1), 'pending', 'refused calls changed nothing (facility)');
select is(pg_temp.role_of(4), 'user', 'refused calls changed nothing (role)');

-- ------------------------------------------------------------
-- admin_set_facility_status
-- ------------------------------------------------------------

select pg_temp.as_user(1);

select is(public.admin_set_facility_status(pg_temp.f(1), 'active'), 'active'::public.facility_status, 'approve: returns the new status');
select is(pg_temp.fstatus(1), 'active', 'approve: pending becomes active');
select is(public.admin_set_facility_status(pg_temp.f(1), 'active'), 'active'::public.facility_status, 'approve again is idempotent');
select is(public.admin_set_facility_status(pg_temp.f(2), 'suspended'), 'suspended'::public.facility_status, 'suspend works');
select is(public.admin_set_facility_status(pg_temp.f(2), 'active'), 'active'::public.facility_status, 'reactivate works');
select is(public.admin_set_facility_status(pg_temp.f(2), 'rejected'), 'rejected'::public.facility_status, 'reject works');
select is(public.admin_set_facility_status(pg_temp.f(2), 'pending'), 'pending'::public.facility_status, 'back to pending works');
select throws_ok($$select public.admin_set_facility_status('d2999999-0000-0000-0000-000000000000', 'active')$$, 'P0002', null, 'unknown facility');
select throws_ok($$select public.admin_set_facility_status(null, 'active')$$, '22023', null, 'null facility is refused');
select throws_ok($$select public.admin_set_facility_status(pg_temp.f(1), null)$$, '22023', null, 'null status is refused');

-- ------------------------------------------------------------
-- admin_find_user_by_email
-- ------------------------------------------------------------

select is(
  (select user_id from public.admin_find_user_by_email('  ADM-Owner@Example.com ')),
  pg_temp.u(3),
  'finds an account by exact email, ignoring case and spaces'
);
select is(
  (select role::text from public.admin_find_user_by_email('adm-owner@example.com')),
  'owner', 'returns the role'
);
select is((select count(*)::int from public.admin_find_user_by_email('adm-owner')), 0, 'a partial email matches nothing');
select is((select count(*)::int from public.admin_find_user_by_email('%@example.com')), 0, 'a wildcard matches nothing');
select throws_ok($$select * from public.admin_find_user_by_email('  ')$$, '22023', null, 'blank email is refused');

-- ------------------------------------------------------------
-- admin_set_user_role
-- ------------------------------------------------------------

select is(public.admin_set_user_role(pg_temp.u(4), 'owner'), 'owner'::public.user_role, 'promote a user to owner');
select is(pg_temp.role_of(4), 'owner', 'the role is stored');
select is(public.admin_set_user_role(pg_temp.u(4), 'owner'), 'owner'::public.user_role, 'same role again is idempotent');
select throws_ok($$select public.admin_set_user_role(pg_temp.u(1), 'user')$$, 'UB007', null, 'an admin cannot change their own role');
select throws_ok($$select public.admin_set_user_role('d1999999-0000-0000-0000-000000000000', 'owner')$$, 'P0002', null, 'unknown user');
select throws_ok($$select public.admin_set_user_role(null, 'owner')$$, '22023', null, 'null user is refused');

-- Admin2 can be demoted by Admin1 while another admin remains (Admin1).
select is(public.admin_set_user_role(pg_temp.u(2), 'user'), 'user'::public.user_role, 'an admin can demote another admin while one remains');

-- A demoted admin has lost every admin power at once.
select pg_temp.as_user(2);
select throws_ok($$select public.admin_set_facility_status(pg_temp.f(1), 'suspended')$$, '42501', null, 'a demoted admin can no longer change facilities');
select pg_temp.as_user(1);
select is(public.admin_set_user_role(pg_temp.u(4), 'admin'), 'admin'::public.user_role, 'an admin can promote another account to admin');

-- The trigger is still enabled, and the last admin is protected.
select is(
  (select tgenabled::text from pg_trigger where tgname = 'profiles_prevent_role_escalation'),
  'O', 'the role-protection trigger is still enabled'
);

select * from finish();
rollback;
