-- ============================================================
-- UniSport — Migration 001: Foundation
-- ============================================================

-- ------------------------------------------------------------
-- Extensions
-- ------------------------------------------------------------

create extension if not exists "pgcrypto";


-- ------------------------------------------------------------
-- Enums
-- ------------------------------------------------------------

create type public.user_role as enum (
  'user',
  'owner',
  'admin'
);


-- ------------------------------------------------------------
-- Helper: automatically maintain updated_at
-- ------------------------------------------------------------

create or replace function public.handle_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- ------------------------------------------------------------
-- Profiles
-- Extends Supabase Auth users with application-level data.
-- The profile ID is always the same as auth.users.id.
-- ------------------------------------------------------------

create table public.profiles (
  id uuid primary key
    references auth.users(id)
    on delete cascade,

  full_name text,
  phone text,
  city text,
  avatar_url text,

  role public.user_role not null default 'user',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint profiles_full_name_length
    check (full_name is null or char_length(full_name) <= 150),

  constraint profiles_phone_length
    check (phone is null or char_length(phone) <= 30),

  constraint profiles_city_length
    check (city is null or char_length(city) <= 100)
);


-- ------------------------------------------------------------
-- Indexes
-- ------------------------------------------------------------

create index profiles_role_idx
  on public.profiles(role);

create index profiles_city_idx
  on public.profiles(city);


-- ------------------------------------------------------------
-- updated_at trigger
-- ------------------------------------------------------------

create trigger profiles_set_updated_at
before update on public.profiles
for each row
execute function public.handle_updated_at();


-- ------------------------------------------------------------
-- Create profile automatically after Auth signup
-- ------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    id,
    full_name
  )
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name'
    )
  );

  return new;
end;
$$;


create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();


-- ------------------------------------------------------------
-- Row Level Security
-- ------------------------------------------------------------

alter table public.profiles enable row level security;


-- ------------------------------------------------------------
-- Profile policies
-- ------------------------------------------------------------

create policy "Users can view their own profile"
on public.profiles
for select
to authenticated
using (
  auth.uid() = id
);


create policy "Users can update their own profile"
on public.profiles
for update
to authenticated
using (
  auth.uid() = id
)
with check (
  auth.uid() = id
);


-- ------------------------------------------------------------
-- Prevent clients from creating profiles directly.
--
-- Profiles are created by the auth.users trigger.
-- ------------------------------------------------------------

-- No INSERT policy intentionally.


-- ------------------------------------------------------------
-- Prevent normal users from deleting profiles directly.
--
-- Account deletion will be handled separately through
-- an appropriate server-side/admin flow.
-- ------------------------------------------------------------

-- No DELETE policy intentionally.


-- ------------------------------------------------------------
-- Role protection
--
-- A normal authenticated user must never be able to change
-- their own role through the client.
--
-- This trigger allows profile updates while preventing
-- privilege escalation.
-- ------------------------------------------------------------

create or replace function public.prevent_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.role is distinct from new.role then

    if not exists (
      select 1
      from public.profiles
      where id = auth.uid()
        and role = 'admin'
    ) then
      raise exception 'Only administrators can change user roles';
    end if;

  end if;

  return new;
end;
$$;


create trigger profiles_prevent_role_escalation
before update on public.profiles
for each row
execute function public.prevent_role_escalation();