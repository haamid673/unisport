-- ============================================================
-- UniSport — DEVELOPMENT-ONLY facility seed
-- ============================================================
--
-- Loads a small set of realistic facilities, slots and operating
-- hours so the customer browse screen has something to show.
--
-- This file is deliberately NOT supabase/seed.sql. config.toml points
-- [db.seed] at ./seed.sql, which `supabase db reset` runs
-- automatically at a moment when no Auth user can exist yet. An owner
-- is required, so an automatic seed would either fail every reset or
-- do nothing. This script is run by hand, once an owner exists.
--
-- Safe by construction:
--
--   * No passwords, tokens or keys appear here and nothing is written
--     to auth.users. The owner is a REAL Supabase Auth user you create
--     yourself (sign up in the app); this script only looks them up by
--     email.
--   * It refuses to run unless the database positively identifies
--     itself as the local Supabase development stack (database
--     "postgres", private server address, local-default JWT secret).
--     Run against a hosted or linked project it aborts before writing.
--   * Fixed ids make it repeatable: running it again updates the same
--     rows instead of duplicating them.
--
-- Prerequisite (one time, local only):
--
--   1. Sign up in the app (or via Studio) with the email you will use
--      as the owner.
--   2. Promote that profile to owner. Role changes are guarded by a
--      trigger, so the guard is lifted for this one statement:
--
--        alter table public.profiles disable trigger profiles_prevent_role_escalation;
--        update public.profiles set role = 'owner'
--          where id = (select id from auth.users where email = 'you@example.com');
--        alter table public.profiles enable trigger profiles_prevent_role_escalation;
--
-- Usage:
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--        -v owner_email=you@example.com \
--        -f supabase/dev/seed_dev_facilities.sql
--
-- ============================================================

\set ON_ERROR_STOP on

\if :{?owner_email}

select set_config('seed.owner_email', :'owner_email', false);

do $$
declare
  v_owner_id uuid;
  v_owner_role public.user_role;
  v_email text := lower(current_setting('seed.owner_email', true));
begin

  -- -------------------------------------------------------
  -- Environment guard: local Supabase development stack only.
  -- -------------------------------------------------------
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
      'Refusing to seed: this database is not positively identified as '
      'the local Supabase development stack. This file is development-only.';
  end if;

  -- -------------------------------------------------------
  -- Owner: must already exist as a real Auth user with role owner.
  -- -------------------------------------------------------
  select p.id, p.role
  into v_owner_id, v_owner_role
  from auth.users u
  join public.profiles p on p.id = u.id
  where lower(u.email) = v_email;

  if v_owner_id is null then
    raise exception
      'No Supabase Auth user with email "%" exists. Sign up with that '
      'email in the app first (see the prerequisite at the top of this file).',
      v_email;
  end if;

  if v_owner_role <> 'owner' then
    raise exception
      'User "%" has role "%", not "owner". Promote the profile first (see '
      'the prerequisite at the top of this file).',
      v_email, v_owner_role;
  end if;

  -- -------------------------------------------------------
  -- Facilities (fixed ids => repeatable)
  -- -------------------------------------------------------
  insert into public.facilities
    (id, owner_id, name, description, sport, address, city,
     latitude, longitude, status, base_price)
  values
    ('d0000000-0000-4000-8000-000000000001', v_owner_id,
     'Kowdiar Badminton Hub', 'Six wooden-floor courts with floodlights.',
     'Badminton', 'Kowdiar Junction Road', 'Trivandrum',
     8.5190, 76.9610, 'active', 900),
    ('d0000000-0000-4000-8000-000000000002', v_owner_id,
     'Palayam Tennis Courts', 'Two hard courts in the city centre.',
     'Tennis', 'Palayam Main Road', 'Trivandrum',
     8.5033, 76.9487, 'active', 1400),
    ('d0000000-0000-4000-8000-000000000003', v_owner_id,
     'Technopark Turf Arena', '5-a-side artificial turf with night lighting.',
     'Football', 'Technopark Phase 1 Road', 'Trivandrum',
     8.5581, 76.8800, 'active', 1600),
    ('d0000000-0000-4000-8000-000000000004', v_owner_id,
     'Anna Nagar Smashers Arena', 'Air-conditioned badminton arena.',
     'Badminton', '2nd Avenue, Anna Nagar', 'Chennai',
     13.0850, 80.2101, 'active', 800),
    ('d0000000-0000-4000-8000-000000000005', v_owner_id,
     'Marina Turf FC', 'Full-size turf near the beach.',
     'Football', 'Marina Beach Road', 'Chennai',
     13.0500, 80.2824, 'active', 1500),
    ('d0000000-0000-4000-8000-000000000006', v_owner_id,
     'Indiranagar Padel Club', 'Two glass-walled padel courts.',
     'Padel', '100 Feet Road, Indiranagar', 'Bangalore',
     12.9784, 77.6408, 'active', 1800)
  on conflict (id) do update
  set
    owner_id    = excluded.owner_id,
    name        = excluded.name,
    description = excluded.description,
    sport       = excluded.sport,
    address     = excluded.address,
    city        = excluded.city,
    latitude    = excluded.latitude,
    longitude   = excluded.longitude,
    status      = excluded.status,
    base_price  = excluded.base_price;

  -- -------------------------------------------------------
  -- Operating hours: every day 06:00-22:00
  -- -------------------------------------------------------
  insert into public.facility_operating_hours
    (facility_id, day_of_week, opens_at, closes_at, is_closed)
  select f.id, d, time '06:00', time '22:00', false
  from public.facilities f
  cross join generate_series(0, 6) as d
  where f.id::text like 'd0000000-0000-4000-8000-0000000000%'
  on conflict (facility_id, day_of_week) do nothing;

  -- -------------------------------------------------------
  -- One-hour slots. Prices follow the facility base price, with a
  -- small evening premium.
  -- -------------------------------------------------------
  insert into public.facility_slots
    (id, facility_id, start_time, end_time, duration_min, base_price, is_active)
  select
    ('d1000000-0000-4000-8000-' ||
      lpad((substr(f.id::text, 35, 2)::int * 100 + s.n)::text, 12, '0'))::uuid,
    f.id,
    s.start_time,
    s.start_time + interval '1 hour',
    60,
    case when s.start_time >= time '18:00'
         then f.base_price + 200 else f.base_price end,
    true
  from public.facilities f
  cross join (values
    (1, time '06:00'),
    (2, time '07:00'),
    (3, time '18:00'),
    (4, time '19:00'),
    (5, time '20:00')
  ) as s(n, start_time)
  where f.id::text like 'd0000000-0000-4000-8000-0000000000%'
  on conflict do nothing;

  raise notice 'Seeded % facilities for owner %.',
    (select count(*) from public.facilities
      where id::text like 'd0000000-0000-4000-8000-0000000000%'),
    v_email;

end;
$$;

\else

do $$
begin
  raise exception
    'owner_email is required. Usage: psql <db-url> -v owner_email=you@example.com '
    '-f supabase/dev/seed_dev_facilities.sql  (see the header of this file).';
end;
$$;

\endif
