begin;

select plan(61);


-- ============================================================
-- Fixture
--
-- Users (f3000000-0000-0000-0000-00000000000N), created through
-- the real signup trigger (handle_new_user):
--   01 EDITOR  plain user, edits their own profile
--   02 VICTIM  plain user, must not be touched by EDITOR
--   03 META    signs up asking for role "admin" in metadata
--   09 ADMIN   role admin
--
-- The only elevated role needed is ADMIN. The role-escalation
-- trigger is disabled ONLY inside this fixture block and is
-- re-enabled in the same block, before any assertion. The
-- updated_at trigger is paused for one statement so updated_at
-- can be set to a past value to prove a later refresh.
-- ============================================================

insert into auth.users (
  id, email, encrypted_password, email_confirmed_at, raw_user_meta_data
)
values
  ('f3000000-0000-0000-0000-000000000001', 'pse-editor@example.com', '', now(), '{"full_name":"Editor Original"}'),
  ('f3000000-0000-0000-0000-000000000002', 'pse-victim@example.com', '', now(), '{"full_name":"Victim Original"}'),
  ('f3000000-0000-0000-0000-000000000003', 'pse-meta@example.com', '', now(),
   '{"full_name":"Meta","role":"admin","user_role":"admin","app_role":"admin"}'),
  ('f3000000-0000-0000-0000-000000000009', 'pse-admin@example.com', '', now(), '{"full_name":"Admin"}');

alter table public.profiles
disable trigger profiles_prevent_role_escalation;

update public.profiles
set role = 'admin'
where id = 'f3000000-0000-0000-0000-000000000009';

alter table public.profiles
enable trigger profiles_prevent_role_escalation;

-- Give EDITOR a known past updated_at and created_at baseline.
alter table public.profiles
disable trigger profiles_set_updated_at;

update public.profiles
set updated_at = timestamptz '2000-01-01 00:00:00+00'
where id = 'f3000000-0000-0000-0000-000000000001';

alter table public.profiles
enable trigger profiles_set_updated_at;

-- Rows affected by a statement run as the CURRENT role (invoker),
-- so RLS and privileges apply exactly as for a client.
create function pg_temp.rows_affected(p_sql text)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end;
$$;

create temp table pse_baseline as
select id, created_at
from public.profiles
where id in (
  'f3000000-0000-0000-0000-000000000001',
  'f3000000-0000-0000-0000-000000000002'
);


-- ============================================================
-- 1. Protections are in place (checked as the table owner)
-- ============================================================

select is(
  (select tgenabled::text from pg_trigger
   where tgrelid = 'public.profiles'::regclass
     and tgname = 'profiles_prevent_role_escalation'),
  'O',
  'the role-escalation trigger is enabled'
);

select is(
  (select count(*)::integer from pg_trigger
   where tgrelid = 'public.profiles'::regclass
     and tgname = 'profiles_prevent_role_escalation'
     and (tgtype & 2) = 2      -- BEFORE
     and (tgtype & 16) = 16    -- UPDATE
     and (tgtype & 1) = 1),    -- ROW
  1,
  'and it is still BEFORE UPDATE FOR EACH ROW'
);

select is(
  (select tgenabled::text from pg_trigger
   where tgrelid = 'public.profiles'::regclass
     and tgname = 'profiles_set_updated_at'),
  'O',
  'the updated_at trigger is enabled'
);

select ok(
  not has_table_privilege('authenticated', 'public.profiles', 'UPDATE'),
  'authenticated has no table-level UPDATE privilege'
);

select ok(
  has_column_privilege('authenticated', 'public.profiles', 'full_name', 'UPDATE')
  and has_column_privilege('authenticated', 'public.profiles', 'phone', 'UPDATE')
  and has_column_privilege('authenticated', 'public.profiles', 'city', 'UPDATE')
  and has_column_privilege('authenticated', 'public.profiles', 'avatar_url', 'UPDATE'),
  'authenticated can UPDATE full_name, phone, city and avatar_url'
);

select is(
  (select string_agg(a.attname, ',' order by a.attname)
   from pg_attribute a
   where a.attrelid = 'public.profiles'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.profiles', a.attname, 'UPDATE')),
  'avatar_url,city,full_name,phone',
  'those are exactly the columns authenticated can UPDATE'
);

select ok(
  not has_column_privilege('authenticated', 'public.profiles', 'id', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.profiles', 'created_at', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.profiles', 'updated_at', 'UPDATE'),
  'authenticated cannot UPDATE id, role, created_at or updated_at'
);

select is(
  (select count(*)::integer
   from pg_attribute a
   where a.attrelid = 'public.profiles'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('anon', 'public.profiles', a.attname, 'UPDATE')),
  0,
  'anon has no UPDATE privilege on any column'
);

select ok(
  not has_table_privilege('anon', 'public.profiles', 'UPDATE'),
  'and no table-level UPDATE privilege'
);

select ok(
  has_table_privilege('authenticated', 'public.profiles', 'SELECT'),
  'authenticated keeps SELECT'
);

select is(
  (select count(*)::integer from pg_policies
   where schemaname = 'public' and tablename = 'profiles'
     and cmd in ('INSERT', 'DELETE')),
  0,
  'there is still no INSERT or DELETE policy on profiles'
);

select ok(
  (select convalidated from pg_constraint
   where conname = 'profiles_avatar_url_https'
     and conrelid = 'public.profiles'::regclass),
  'the avatar_url constraint exists and is validated'
);


-- ============================================================
-- 2. Signup cannot assign an elevated role (owner-level check)
-- ============================================================

select is(
  (select role::text from public.profiles
   where id = 'f3000000-0000-0000-0000-000000000003'),
  'user',
  'signup metadata asking for role admin produced a plain user'
);

select is(
  (select full_name from public.profiles
   where id = 'f3000000-0000-0000-0000-000000000003'),
  'Meta',
  'while the signup trigger still copied the full name'
);


-- ============================================================
-- 3. EDITOR: legitimate edits
-- ============================================================

set local request.jwt.claim.sub = 'f3000000-0000-0000-0000-000000000001';
set local role = 'authenticated';

select lives_ok(
  $$ update public.profiles
     set full_name = 'Editor New', phone = '9000000000', city = 'Chennai'
     where id = auth.uid() $$,
  'a user can edit full_name, phone and city'
);

select is(
  (select full_name || '|' || phone || '|' || city from public.profiles
   where id = auth.uid()),
  'Editor New|9000000000|Chennai',
  'the edit was applied'
);

select lives_ok(
  $$ update public.profiles
     set avatar_url = 'https://cdn.example.com/avatars/editor.png'
     where id = auth.uid() $$,
  'a valid https avatar URL is accepted'
);

select lives_ok(
  $$ update public.profiles set avatar_url = null where id = auth.uid() $$,
  'a NULL avatar URL is accepted'
);

select lives_ok(
  $$ update public.profiles
     set avatar_url = 'HTTPS://CDN.EXAMPLE.COM/A.PNG'
     where id = auth.uid() $$,
  'the https scheme is matched case-insensitively'
);

select lives_ok(
  $$ update public.profiles
     set avatar_url = 'https://' || repeat('a', 2040)
     where id = auth.uid() $$,
  'an avatar URL of exactly 2048 characters is accepted'
);

select lives_ok(
  $$ update public.profiles set avatar_url = null where id = auth.uid() $$,
  'and it can be cleared again'
);

select lives_ok(
  $$ update public.profiles set phone = '9123456789' where id = auth.uid()
     returning id, full_name, phone, city, avatar_url, role, created_at $$,
  'an update with RETURNING of the whole row works (as the client does)'
);


-- ============================================================
-- 4. EDITOR: protected columns are refused, even as no-ops
-- ============================================================

select throws_ok(
  $$ update public.profiles set role = 'owner' where id = auth.uid() $$,
  '42501', NULL,
  'a user cannot set their role to owner'
);

select throws_ok(
  $$ update public.profiles set role = 'admin' where id = auth.uid() $$,
  '42501', NULL,
  'a user cannot set their role to admin'
);

select throws_ok(
  $$ update public.profiles set role = 'admin', city = 'Delhi' where id = auth.uid() $$,
  '42501', NULL,
  'mixing role with a permitted column is still refused'
);

select throws_ok(
  $$ update public.profiles set role = role where id = auth.uid() $$,
  '42501', NULL,
  'even assigning role to itself is refused'
);

select throws_ok(
  $$ update public.profiles set id = gen_random_uuid() where id = auth.uid() $$,
  '42501', NULL,
  'a user cannot change id'
);

select throws_ok(
  $$ update public.profiles set id = id where id = auth.uid() $$,
  '42501', NULL,
  'even assigning id to itself is refused'
);

select throws_ok(
  $$ update public.profiles set created_at = timestamptz '2000-01-01' where id = auth.uid() $$,
  '42501', NULL,
  'a user cannot change created_at'
);

select throws_ok(
  $$ update public.profiles set created_at = created_at where id = auth.uid() $$,
  '42501', NULL,
  'even assigning created_at to itself is refused'
);

select throws_ok(
  $$ update public.profiles set updated_at = timestamptz '2000-01-01' where id = auth.uid() $$,
  '42501', NULL,
  'a user cannot set updated_at'
);

select throws_ok(
  $$ update public.profiles set updated_at = updated_at where id = auth.uid() $$,
  '42501', NULL,
  'even assigning updated_at to itself is refused'
);

select throws_ok(
  $$ update public.profiles set role = 'admin' $$,
  '42501', NULL,
  'a bulk update touching role is refused'
);


-- ============================================================
-- 5. EDITOR: avatar_url format
-- ============================================================

select throws_ok(
  $$ update public.profiles set avatar_url = 'http://example.com/a.png' where id = auth.uid() $$,
  '23514', 'new row for relation "profiles" violates check constraint "profiles_avatar_url_https"',
  'an http:// URL is rejected'
);

select throws_ok(
  $$ update public.profiles set avatar_url = 'javascript:alert(1)' where id = auth.uid() $$,
  '23514', 'new row for relation "profiles" violates check constraint "profiles_avatar_url_https"',
  'a javascript: URL is rejected'
);

select throws_ok(
  $$ update public.profiles set avatar_url = 'data:text/html;base64,PHNjcmlwdD4=' where id = auth.uid() $$,
  '23514', 'new row for relation "profiles" violates check constraint "profiles_avatar_url_https"',
  'a data: URL is rejected'
);

select throws_ok(
  $$ update public.profiles set avatar_url = 'https://example.com/a b.png' where id = auth.uid() $$,
  '23514', 'new row for relation "profiles" violates check constraint "profiles_avatar_url_https"',
  'a URL containing a space is rejected'
);

select throws_ok(
  $$ update public.profiles set avatar_url = E'https://example.com/a\tb.png' where id = auth.uid() $$,
  '23514', 'new row for relation "profiles" violates check constraint "profiles_avatar_url_https"',
  'a URL containing a tab is rejected'
);

select throws_ok(
  $$ update public.profiles set avatar_url = E'https://example.com/a\nb.png' where id = auth.uid() $$,
  '23514', 'new row for relation "profiles" violates check constraint "profiles_avatar_url_https"',
  'a URL containing a newline is rejected'
);

select throws_ok(
  $$ update public.profiles set avatar_url = E'https://example.com/a\x01b.png' where id = auth.uid() $$,
  '23514', 'new row for relation "profiles" violates check constraint "profiles_avatar_url_https"',
  'a URL containing a control character is rejected'
);

select throws_ok(
  $$ update public.profiles set avatar_url = '' where id = auth.uid() $$,
  '23514', 'new row for relation "profiles" violates check constraint "profiles_avatar_url_https"',
  'an empty string is rejected (clear with NULL)'
);

select throws_ok(
  $$ update public.profiles set avatar_url = 'https://' || repeat('a', 2041) where id = auth.uid() $$,
  '23514', 'new row for relation "profiles" violates check constraint "profiles_avatar_url_https"',
  'a URL of 2049 characters is rejected'
);

select throws_ok(
  $$ update public.profiles set avatar_url = 'ftp://example.com/a.png' where id = auth.uid() $$,
  '23514', 'new row for relation "profiles" violates check constraint "profiles_avatar_url_https"',
  'another scheme (ftp://) is rejected'
);


-- ============================================================
-- 6. EDITOR: other users, INSERT, UPSERT, DELETE
-- ============================================================

select is(
  pg_temp.rows_affected(
   $q$ update public.profiles set full_name = 'Pwned'
     where id = 'f3000000-0000-0000-0000-000000000002' $q$),
  0,
  'a user cannot update another user''s profile (no row matches)'
);

select throws_ok(
  $$ insert into public.profiles (id, full_name)
     values (gen_random_uuid(), 'Ghost') $$,
  '42501', NULL,
  'a user cannot INSERT a profile'
);

select throws_ok(
  $$ insert into public.profiles (id, role)
     values (auth.uid(), 'admin')
     on conflict (id) do update set role = 'admin' $$,
  '42501', NULL,
  'a user cannot UPSERT a profile to change their role'
);

select throws_ok(
  $$ delete from public.profiles
     where id in (auth.uid(), 'f3000000-0000-0000-0000-000000000002') $$,
  '42501', NULL,
  'a user cannot DELETE any profile, including their own (no DELETE privilege)'
);


-- ============================================================
-- 7. ANON, ADMIN, SERVICE_ROLE
-- ============================================================

set local role = 'anon';

select throws_ok(
  $$ update public.profiles set city = 'Anywhere' $$,
  '42501', NULL,
  'anon cannot update profiles'
);

set local request.jwt.claim.sub = 'f3000000-0000-0000-0000-000000000009';
set local role = 'authenticated';

select throws_ok(
  $$ update public.profiles set role = 'user' where id = auth.uid() $$,
  '42501', NULL,
  'an admin cannot change roles through the client API either'
);

select is(
  pg_temp.rows_affected(
   $q$ update public.profiles set full_name = 'Admin Pwned'
     where id = 'f3000000-0000-0000-0000-000000000002' $q$),
  0,
  'an admin''s client update does not reach another user''s profile'
);

select lives_ok(
  $$ update public.profiles set city = 'Mumbai' where id = auth.uid() $$,
  'an admin can still edit their own permitted fields'
);

-- service_role: a service key carries no sub.
reset role;
set local request.jwt.claim.sub = '';
set local role = 'service_role';

select throws_ok(
  $$ update public.profiles set role = 'owner'
     where id = 'f3000000-0000-0000-0000-000000000002' $$,
  'P0001',
  'Only administrators can change user roles',
  'service_role without a sub still cannot change a role (fail closed)'
);

select lives_ok(
  $$ update public.profiles set full_name = 'Set By Service'
     where id = 'f3000000-0000-0000-0000-000000000002' $$,
  'service_role can still update ordinary profile fields'
);

select throws_ok(
  $$ update public.profiles set avatar_url = 'http://example.com/a.png'
     where id = 'f3000000-0000-0000-0000-000000000002' $$,
  '23514', NULL,
  'the avatar_url constraint also binds service_role'
);


-- ============================================================
-- 8. Net effect, read as the table owner
-- ============================================================

reset role;

select is(
  (select role::text from public.profiles
   where id = 'f3000000-0000-0000-0000-000000000001'),
  'user',
  'EDITOR is still a plain user'
);

select is(
  (select role::text from public.profiles
   where id = 'f3000000-0000-0000-0000-000000000002'),
  'user',
  'VICTIM''s role was never changed'
);

select is(
  (select full_name from public.profiles
   where id = 'f3000000-0000-0000-0000-000000000002'),
  'Set By Service',
  'VICTIM''s name changed only through the service_role update'
);

select is(
  (select count(*)::integer
   from public.profiles p
   join pse_baseline b using (id)
   where p.created_at is distinct from b.created_at),
  0,
  'created_at is unchanged for every fixture user'
);

select ok(
  (select updated_at > timestamptz '2000-01-01' and updated_at <= now()
   from public.profiles
   where id = 'f3000000-0000-0000-0000-000000000001'),
  'updated_at was refreshed by the trigger after an ordinary edit'
);

select is(
  (select count(*)::integer from public.profiles
   where id in ('f3000000-0000-0000-0000-000000000001',
                'f3000000-0000-0000-0000-000000000002')),
  2,
  'no profile was deleted'
);

select is(
  (select tgenabled::text from pg_trigger
   where tgrelid = 'public.profiles'::regclass
     and tgname = 'profiles_prevent_role_escalation'),
  'O',
  'the role-escalation trigger is still enabled at the end'
);

select * from finish();

rollback;
