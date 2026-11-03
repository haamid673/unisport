-- ============================================================
-- UniSport — DEVELOPMENT-ONLY first-administrator bootstrap
-- ============================================================
--
-- Role changes are guarded by the profiles_prevent_role_escalation
-- trigger, and the admin console can only be used by an existing
-- administrator. The very first administrator therefore has to be made
-- outside the app, once per local database. Every later promotion
-- (owners, more administrators) is done in the Governance Center.
--
-- How this works without touching the guard: profile INSERTs are not
-- guarded (only role UPDATEs are), so the account's profile is removed
-- and inserted again with role 'admin'. The trigger stays enabled the
-- whole time. Name, phone, city and avatar are carried over.
--
-- Safe by construction:
--
--   * It refuses to run unless the database identifies itself as the
--     local Supabase development stack (database "postgres", private
--     server address, local-default JWT secret). That is a convention,
--     not proof: never point this at a hosted project.
--   * It needs a REAL account created by signing up in the app. No
--     passwords or tokens appear here and nothing is written to
--     auth.users.
--   * Idempotent: an account that is already an administrator is left
--     alone. It is one statement block, so it either completes or
--     changes nothing. If the account owns venues or has bookings the
--     profile cannot be removed; the block fails and nothing changes.
--
-- Usage:
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--        -v admin_email=you@example.com \
--        -f supabase/dev/bootstrap_first_admin.sql
-- ============================================================

\set ON_ERROR_STOP on

\if :{?admin_email}

select set_config('bootstrap.admin_email', :'admin_email', false);

do $$
declare
  v_email text := lower(btrim(current_setting('bootstrap.admin_email', true)));
  v_profile public.profiles%rowtype;
begin

  if current_database() <> 'postgres'
     or inet_server_addr() is null
     or not (inet_server_addr() <<= any (array[
          '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12',
          '192.168.0.0/16', '::1/128'
        ]::inet[]))
     or current_setting('app.settings.jwt_secret', true)
          is distinct from 'super-secret-jwt-token-with-at-least-32-characters-long'
  then
    raise exception
      'Refusing to bootstrap: this database is not positively identified as '
      'the local Supabase development stack. This file is development-only.';
  end if;

  select p.*
  into v_profile
  from auth.users u
  join public.profiles p on p.id = u.id
  where lower(u.email) = v_email;

  if not found then
    raise exception
      'No Supabase Auth user with email "%" exists. Sign up with that email '
      'in the app first.', v_email;
  end if;

  if v_profile.role = 'admin' then
    raise notice '% is already an administrator; nothing changed.', v_email;
    return;
  end if;

  delete from public.profiles where id = v_profile.id;

  insert into public.profiles (id, full_name, phone, city, avatar_url, role)
  values (v_profile.id, v_profile.full_name, v_profile.phone, v_profile.city,
          v_profile.avatar_url, 'admin');

  raise notice '% is now an administrator.', v_email;

end;
$$;

\else

do $$
begin
  raise exception
    'admin_email is required. Usage: psql <db-url> -v admin_email=you@example.com '
    '-f supabase/dev/bootstrap_first_admin.sql  (see the header of this file).';
end;
$$;

\endif
