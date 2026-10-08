-- ============================================================
-- UniSport — Migration 002: Facilities
-- ============================================================

-- ------------------------------------------------------------
-- Facility status
-- ------------------------------------------------------------

create type public.facility_status as enum (
  'pending',
  'active',
  'suspended',
  'rejected'
);


-- ------------------------------------------------------------
-- Facilities
-- ------------------------------------------------------------

create table public.facilities (
  id uuid primary key default gen_random_uuid(),

  owner_id uuid not null
    references public.profiles(id)
    on delete restrict,

  name text not null,
  description text,

  sport text not null,

  address text not null,
  city text not null,

  latitude double precision,
  longitude double precision,

  capacity integer,

  status public.facility_status not null default 'pending',

  base_price numeric(10, 2) not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint facilities_name_length
    check (
      char_length(trim(name)) between 2 and 150
    ),

  constraint facilities_description_length
    check (
      description is null
      or char_length(description) <= 5000
    ),

  constraint facilities_sport_length
    check (
      char_length(trim(sport)) between 2 and 100
    ),

  constraint facilities_address_length
    check (
      char_length(trim(address)) between 5 and 500
    ),

  constraint facilities_city_length
    check (
      char_length(trim(city)) between 2 and 100
    ),

  constraint facilities_capacity_positive
    check (
      capacity is null or capacity > 0
    ),

  constraint facilities_base_price_non_negative
    check (
      base_price >= 0
    ),

  constraint facilities_latitude_valid
    check (
      latitude is null
      or latitude between -90 and 90
    ),

  constraint facilities_longitude_valid
    check (
      longitude is null
      or longitude between -180 and 180
    )
);


-- ------------------------------------------------------------
-- Indexes
-- ------------------------------------------------------------

create index facilities_owner_id_idx
  on public.facilities(owner_id);

create index facilities_city_idx
  on public.facilities(city);

create index facilities_sport_idx
  on public.facilities(sport);

create index facilities_status_idx
  on public.facilities(status);

create index facilities_city_sport_status_idx
  on public.facilities(city, sport, status);


-- ------------------------------------------------------------
-- updated_at
-- ------------------------------------------------------------

create trigger facilities_set_updated_at
before update on public.facilities
for each row
execute function public.handle_updated_at();


-- ------------------------------------------------------------
-- Helper: check whether current user is an admin
-- ------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
  );
$$;


-- ------------------------------------------------------------
-- Helper: check whether current user owns a facility
-- ------------------------------------------------------------

create or replace function public.owns_facility(
  facility_uuid uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.facilities
    where id = facility_uuid
      and owner_id = auth.uid()
  );
$$;


-- ------------------------------------------------------------
-- Row Level Security
-- ------------------------------------------------------------

alter table public.facilities enable row level security;


-- ------------------------------------------------------------
-- SELECT
--
-- Anyone authenticated can see active facilities.
-- Owners can see their own facilities regardless of status.
-- Admins can see everything.
-- ------------------------------------------------------------

create policy "Authenticated users can view active facilities"
on public.facilities
for select
to authenticated
using (
  status = 'active'
  or owner_id = auth.uid()
  or public.is_admin()
);


-- ------------------------------------------------------------
-- INSERT
--
-- Owners may create facilities.
-- Admins may create facilities.
--
-- The inserted owner_id must be the authenticated user
-- unless the caller is an administrator.
-- ------------------------------------------------------------

create policy "Owners can create their own facilities"
on public.facilities
for insert
to authenticated
with check (
  (
    owner_id = auth.uid()
    and exists (
      select 1
      from public.profiles
      where id = auth.uid()
        and role = 'owner'
    )
  )
  or public.is_admin()
);


-- ------------------------------------------------------------
-- UPDATE
--
-- Owners may update their own facilities.
-- Admins may update any facility.
--
-- Owners cannot use a normal client update to transfer
-- ownership or approve/suspend/reject their own facility.
-- ------------------------------------------------------------

create policy "Owners can update their own facilities"
on public.facilities
for update
to authenticated
using (
  owner_id = auth.uid()
  or public.is_admin()
)
with check (
  (
    owner_id = auth.uid()
    and (
      public.is_admin()
      or (
        owner_id = (
          select f.owner_id
          from public.facilities f
          where f.id = facilities.id
        )
        and status = (
          select f.status
          from public.facilities f
          where f.id = facilities.id
        )
      )
    )
  )
  or public.is_admin()
);


-- ------------------------------------------------------------
-- DELETE
--
-- Facilities are intentionally not deleted by normal owners.
-- Admins may delete facilities.
--
-- Later we may replace hard deletion with archival/suspension.
-- ------------------------------------------------------------

create policy "Admins can delete facilities"
on public.facilities
for delete
to authenticated
using (
  public.is_admin()
);