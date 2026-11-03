-- ============================================================
-- UniSport — seed for the public demo site
-- ============================================================
--
-- Run by the project owner in the hosted project's SQL editor, after all
-- migrations, once these two accounts exist (Authentication → Users →
-- Add user, with Auto Confirm on; use generated passwords):
--
--     owner@unisport-demo.test    player@unisport-demo.test
--
-- It makes the first one an owner and adds sample venues, slots, hours, a
-- community and an event, so a visitor sees a living product on first open.
-- The names are invented; nothing here is a real venue.
--
-- Idempotent: fixed ids, and a re-run never overwrites what exists. It
-- refuses to run if the accounts are missing. It writes nothing to
-- auth.users and contains no password. The role-protection trigger stays
-- enabled: a profile INSERT is not guarded, so the profile is re-inserted
-- with the role; if the owner already has venues the role is left alone.
--
-- Not a migration: it must never reach any other database by accident, so
-- it is not in supabase/migrations and not supabase/seed.sql.
-- ============================================================

do $$
declare
  v_owner uuid;
  v_player uuid;
  v_profile public.profiles%rowtype;
begin

  select id into v_owner from auth.users where lower(email) = 'owner@unisport-demo.test';
  select id into v_player from auth.users where lower(email) = 'player@unisport-demo.test';

  if v_owner is null or v_player is null then
    raise exception 'Create owner@unisport-demo.test and player@unisport-demo.test first (Authentication → Users → Add user).';
  end if;

  select * into v_profile from public.profiles where id = v_owner;

  if v_profile.role <> 'owner' then
    delete from public.profiles where id = v_owner;
    insert into public.profiles (id, full_name, phone, city, avatar_url, role)
    values (v_owner, coalesce(v_profile.full_name, 'Demo Owner'), v_profile.phone, v_profile.city, v_profile.avatar_url, 'owner');
  end if;

  update public.profiles set full_name = 'Demo Player'
  where id = v_player and coalesce(full_name, '') = '';

  insert into public.facilities
    (id, owner_id, name, description, sport, address, city, latitude, longitude, status, base_price)
  values
    ('de100000-0000-4000-8000-000000000001', v_owner, 'Kowdiar Badminton Hub', 'Sample venue. Six wooden-floor courts with floodlights.',
     'Badminton', 'Kowdiar Junction Road', 'Trivandrum', 8.5190, 76.9610, 'active', 500),
    ('de100000-0000-4000-8000-000000000002', v_owner, 'Palayam Padel Club', 'Sample venue. Two glass-walled padel courts.',
     'Padel', 'Palayam Main Road', 'Trivandrum', 8.5033, 76.9487, 'active', 1200),
    ('de100000-0000-4000-8000-000000000003', v_owner, 'Technopark Turf Arena', 'Sample venue. 5-a-side artificial turf with night lighting.',
     'Football', 'Technopark Phase 1 Road', 'Trivandrum', 8.5581, 76.8800, 'active', 1600)
  on conflict (id) do nothing;

  insert into public.facility_operating_hours (facility_id, day_of_week, opens_at, closes_at, is_closed)
  select f.id, d, time '06:00', time '22:00', false
  from public.facilities f
  cross join generate_series(0, 6) d
  where f.id::text like 'de100000-%'
  on conflict (facility_id, day_of_week) do nothing;

  insert into public.facility_slots (id, facility_id, start_time, end_time, duration_min, base_price, is_active)
  select
    ('de200000-0000-4000-8000-' || lpad((substr(f.id::text, 35, 2)::int * 100 + s.n)::text, 12, '0'))::uuid,
    f.id, s.start_time, s.start_time + interval '1 hour', 60,
    case when s.start_time >= time '18:00' then f.base_price + 200 else f.base_price end,
    true
  from public.facilities f
  cross join (values (1, time '07:00'), (2, time '09:00'), (3, time '18:00'), (4, time '19:00'), (5, time '20:00')) s(n, start_time)
  where f.id::text like 'de100000-%'
  on conflict do nothing;

  insert into public.community_groups (id, name, sport, city, description, status, created_by)
  values ('de300000-0000-4000-8000-000000000001', 'Trivandrum Smashers', 'Badminton', 'Trivandrum',
          'Sample community. Weekend doubles for all levels.', 'approved', v_player)
  on conflict (id) do nothing;

  insert into public.group_members (group_id, user_id)
  values ('de300000-0000-4000-8000-000000000001', v_player)
  on conflict do nothing;

  insert into public.community_events (id, group_id, title, event_date, event_time, facility_id, capacity, status, created_by)
  values ('de400000-0000-4000-8000-000000000001', 'de300000-0000-4000-8000-000000000001', 'Saturday Doubles',
          current_date + 7, '18:00', 'de100000-0000-4000-8000-000000000001', 8, 'approved', v_player)
  on conflict (id) do nothing;

  insert into public.event_participants (event_id, user_id)
  values ('de400000-0000-4000-8000-000000000001', v_player)
  on conflict do nothing;

end;
$$;
