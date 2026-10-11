begin;

select plan(30);


-- ============================================================
-- Fixture
--
-- Users (c5000000-0000-0000-0000-00000000000N):
--   01 OWNER1    role owner
--   02 OWNER2    role owner (a different owner)
--   03 CUSTOMER  role user
--   09 ADMIN     role admin
--
-- Facilities (c6000000-0000-0000-0000-00000000000N), inserted by
-- the table owner (bypasses RLS) so each case starts from a
-- known state:
--   01 owned by OWNER1, status pending
--   02 owned by OWNER1, status active
--
-- Everything is rolled back at the end.
-- ============================================================

insert into auth.users (
  id,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_user_meta_data
)
values
  ('c5000000-0000-0000-0000-000000000001', 'fsi-owner1@example.com', '', now(), '{"full_name":"FSI Owner One"}'),
  ('c5000000-0000-0000-0000-000000000002', 'fsi-owner2@example.com', '', now(), '{"full_name":"FSI Owner Two"}'),
  ('c5000000-0000-0000-0000-000000000003', 'fsi-customer@example.com', '', now(), '{"full_name":"FSI Customer"}'),
  ('c5000000-0000-0000-0000-000000000009', 'fsi-admin@example.com', '', now(), '{"full_name":"FSI Admin"}');

alter table public.profiles
disable trigger profiles_prevent_role_escalation;

update public.profiles
set role = 'owner'
where id in (
  'c5000000-0000-0000-0000-000000000001',
  'c5000000-0000-0000-0000-000000000002'
);

update public.profiles
set role = 'admin'
where id = 'c5000000-0000-0000-0000-000000000009';

alter table public.profiles
enable trigger profiles_prevent_role_escalation;


insert into public.facilities (
  id, owner_id, name, description, sport, address, city, status, base_price
)
values
  ('c6000000-0000-0000-0000-000000000001', 'c5000000-0000-0000-0000-000000000001',
   'FSI Pending', 'Status insert test', 'Football', 'Test Address One', 'Test City', 'pending', 500),
  ('c6000000-0000-0000-0000-000000000002', 'c5000000-0000-0000-0000-000000000001',
   'FSI Active', 'Status insert test', 'Football', 'Test Address Two', 'Test City', 'active', 500);


-- ============================================================
-- Policy shape
-- ============================================================

select is(
  (select count(*)::integer from pg_policies
   where schemaname = 'public' and tablename = 'facilities' and cmd = 'INSERT'),
  1,
  'facilities still has exactly one INSERT policy'
);

select ok(
  (select with_check from pg_policies
   where schemaname = 'public' and tablename = 'facilities' and cmd = 'INSERT')
  ~ 'pending',
  'the INSERT check mentions the pending status'
);

select is(
  (select roles::text from pg_policies
   where schemaname = 'public' and tablename = 'facilities' and cmd = 'INSERT'),
  '{authenticated}',
  'the INSERT policy is still limited to authenticated'
);


-- ============================================================
-- OWNER 1
-- ============================================================

set local request.jwt.claim.sub = 'c5000000-0000-0000-0000-000000000001';
set local role = 'authenticated';

-- 1. Status omitted: the column default applies.
select lives_ok(
  $$
    insert into public.facilities
      (id, owner_id, name, sport, address, city, base_price)
    values
      ('c6000000-0000-0000-0000-000000000011',
       'c5000000-0000-0000-0000-000000000001',
       'FSI Omitted', 'Football', 'Test Address Omitted', 'Test City', 100)
  $$,
  'owner can create a facility without specifying a status'
);

select is(
  (select status::text from public.facilities
   where id = 'c6000000-0000-0000-0000-000000000011'),
  'pending',
  'a facility created without a status is stored as pending'
);

-- 2. Explicit pending is fine.
select lives_ok(
  $$
    insert into public.facilities
      (id, owner_id, name, sport, address, city, status, base_price)
    values
      ('c6000000-0000-0000-0000-000000000012',
       'c5000000-0000-0000-0000-000000000001',
       'FSI Explicit Pending', 'Football', 'Test Address Pending', 'Test City', 'pending', 100)
  $$,
  'owner can create a facility with status pending'
);

-- 3. Anything else is refused.
select throws_ok(
  $$
    insert into public.facilities
      (id, owner_id, name, sport, address, city, status, base_price)
    values
      ('c6000000-0000-0000-0000-000000000013',
       'c5000000-0000-0000-0000-000000000001',
       'FSI Self Active', 'Football', 'Test Address Active', 'Test City', 'active', 100)
  $$,
  '42501',
  NULL,
  'owner cannot create a facility with status active'
);

select throws_ok(
  $$
    insert into public.facilities
      (id, owner_id, name, sport, address, city, status, base_price)
    values
      ('c6000000-0000-0000-0000-000000000014',
       'c5000000-0000-0000-0000-000000000001',
       'FSI Self Suspended', 'Football', 'Test Address Suspended', 'Test City', 'suspended', 100)
  $$,
  '42501',
  NULL,
  'owner cannot create a facility with status suspended'
);

select throws_ok(
  $$
    insert into public.facilities
      (id, owner_id, name, sport, address, city, status, base_price)
    values
      ('c6000000-0000-0000-0000-000000000015',
       'c5000000-0000-0000-0000-000000000001',
       'FSI Self Rejected', 'Football', 'Test Address Rejected', 'Test City', 'rejected', 100)
  $$,
  '42501',
  NULL,
  'owner cannot create a facility with status rejected'
);

-- 4. Ownership checks are intact.
select throws_ok(
  $$
    insert into public.facilities
      (id, owner_id, name, sport, address, city, status, base_price)
    values
      ('c6000000-0000-0000-0000-000000000016',
       'c5000000-0000-0000-0000-000000000002',
       'FSI Spoofed Owner', 'Football', 'Test Address Spoof', 'Test City', 'pending', 100)
  $$,
  '42501',
  NULL,
  'owner cannot create a facility on behalf of another owner'
);

-- 5. Upsert cannot be used to skip approval.
select throws_ok(
  $$
    insert into public.facilities
      (id, owner_id, name, sport, address, city, status, base_price)
    values
      ('c6000000-0000-0000-0000-000000000001',
       'c5000000-0000-0000-0000-000000000001',
       'FSI Pending', 'Football', 'Test Address One', 'Test City', 'active', 500)
    on conflict (id) do update set status = 'active'
  $$,
  '42501',
  NULL,
  'upsert proposing status active is refused'
);

select throws_ok(
  $$
    insert into public.facilities
      (id, owner_id, name, sport, address, city, status, base_price)
    values
      ('c6000000-0000-0000-0000-000000000001',
       'c5000000-0000-0000-0000-000000000001',
       'FSI Pending', 'Football', 'Test Address One', 'Test City', 'pending', 500)
    on conflict (id) do update set status = 'active'
  $$,
  '42501',
  NULL,
  'upsert that would promote an existing pending facility is refused'
);

-- 6. Promotion by UPDATE is still blocked.
select throws_ok(
  $$
    update public.facilities
    set status = 'active'
    where id = 'c6000000-0000-0000-0000-000000000001'
  $$,
  '42501',
  NULL,
  'owner cannot promote a pending facility to active through UPDATE'
);

select throws_ok(
  $$
    update public.facilities
    set status = 'rejected'
    where id = 'c6000000-0000-0000-0000-000000000002'
  $$,
  '42501',
  NULL,
  'owner cannot change the status of an active facility either'
);

-- 7. Legitimate owner edits still work.
select lives_ok(
  $$
    update public.facilities
    set name = 'FSI Pending Renamed', base_price = 650
    where id = 'c6000000-0000-0000-0000-000000000001'
  $$,
  'owner can still edit their own facility details'
);

select is(
  (select name from public.facilities
   where id = 'c6000000-0000-0000-0000-000000000001'),
  'FSI Pending Renamed',
  'the owner''s edit was applied'
);

select is(
  (select status::text from public.facilities
   where id = 'c6000000-0000-0000-0000-000000000001'),
  'pending',
  'and the facility is still pending'
);


-- ============================================================
-- OTHER OWNER (OWNER2)
-- ============================================================

set local request.jwt.claim.sub = 'c5000000-0000-0000-0000-000000000002';

select is(
  (select count(*)::integer from public.facilities
   where id = 'c6000000-0000-0000-0000-000000000001'),
  0,
  'another owner cannot see a pending facility they do not own'
);

select lives_ok(
  $$
    update public.facilities
    set status = 'active', name = 'Hijacked'
    where id = 'c6000000-0000-0000-0000-000000000001'
  $$,
  'another owner''s update statement runs (RLS hides the row)'
);

select lives_ok(
  $$
    delete from public.facilities
    where id = 'c6000000-0000-0000-0000-000000000001'
  $$,
  'another owner''s delete statement runs (no policy lets it match)'
);

-- Reached the other owner's row? Check as the table owner.
reset role;

select is(
  (select name || '/' || status::text from public.facilities
   where id = 'c6000000-0000-0000-0000-000000000001'),
  'FSI Pending Renamed/pending',
  'the other owner changed nothing: name and status are intact'
);


-- ============================================================
-- CUSTOMER (role user) and ANON
-- ============================================================

set local request.jwt.claim.sub = 'c5000000-0000-0000-0000-000000000003';
set local role = 'authenticated';

select throws_ok(
  $$
    insert into public.facilities
      (id, owner_id, name, sport, address, city, base_price)
    values
      ('c6000000-0000-0000-0000-000000000021',
       'c5000000-0000-0000-0000-000000000003',
       'FSI Customer Facility', 'Football', 'Test Address Customer', 'Test City', 100)
  $$,
  '42501',
  NULL,
  'a user without the owner role cannot create a facility at all'
);

reset role;
set local role = 'anon';

select throws_ok(
  $$
    insert into public.facilities
      (id, owner_id, name, sport, address, city, base_price)
    values
      ('c6000000-0000-0000-0000-000000000022',
       'c5000000-0000-0000-0000-000000000001',
       'FSI Anon Facility', 'Football', 'Test Address Anon', 'Test City', 100)
  $$,
  '42501',
  NULL,
  'anonymous callers cannot create a facility'
);


-- ============================================================
-- ADMIN
--
-- The existing model lets an admin create a facility in any
-- status and update any facility. That is preserved.
-- ============================================================

reset role;
set local request.jwt.claim.sub = 'c5000000-0000-0000-0000-000000000009';
set local role = 'authenticated';

select lives_ok(
  $$
    insert into public.facilities
      (id, owner_id, name, sport, address, city, base_price)
    values
      ('c6000000-0000-0000-0000-000000000031',
       'c5000000-0000-0000-0000-000000000001',
       'FSI Admin Default', 'Football', 'Test Address Admin Default', 'Test City', 100)
  $$,
  'admin can create a facility for an owner with the default status'
);

select lives_ok(
  $$
    insert into public.facilities
      (id, owner_id, name, sport, address, city, status, base_price)
    values
      ('c6000000-0000-0000-0000-000000000032',
       'c5000000-0000-0000-0000-000000000001',
       'FSI Admin Active', 'Football', 'Test Address Admin Active', 'Test City', 'active', 100)
  $$,
  'admin can create a facility that is already active'
);

select lives_ok(
  $$
    update public.facilities
    set status = 'active'
    where id = 'c6000000-0000-0000-0000-000000000001'
  $$,
  'admin can approve a pending facility'
);

select is(
  (select status::text from public.facilities
   where id = 'c6000000-0000-0000-0000-000000000001'),
  'active',
  'the approved facility is now active'
);

select lives_ok(
  $$
    update public.facilities
    set status = 'suspended'
    where id = 'c6000000-0000-0000-0000-000000000002'
  $$,
  'admin can suspend a facility'
);


-- ============================================================
-- Net effect, read as the table owner
-- ============================================================

reset role;

select is(
  (
    select count(*)::integer
    from public.facilities
    where owner_id = 'c5000000-0000-0000-0000-000000000001'
      and created_at >= now() - interval '1 minute'
      and id in (
        'c6000000-0000-0000-0000-000000000011',
        'c6000000-0000-0000-0000-000000000012'
      )
      and status = 'pending'
  ),
  2,
  'both owner-created facilities that were accepted are pending'
);

select is(
  (
    select count(*)::integer
    from public.facilities
    where id in (
      'c6000000-0000-0000-0000-000000000013',
      'c6000000-0000-0000-0000-000000000014',
      'c6000000-0000-0000-0000-000000000015',
      'c6000000-0000-0000-0000-000000000016',
      'c6000000-0000-0000-0000-000000000021',
      'c6000000-0000-0000-0000-000000000022'
    )
  ),
  0,
  'none of the refused inserts left a row behind'
);

select * from finish();

rollback;
