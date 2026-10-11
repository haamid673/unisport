-- ============================================================
-- UniSport — Migration 003: Facility Scheduling
-- ============================================================


-- ============================================================
-- 1. Facility Images
-- ============================================================

create table public.facility_images (
  id uuid primary key default gen_random_uuid(),

  facility_id uuid not null
    references public.facilities(id)
    on delete cascade,

  storage_path text not null,

  display_order integer not null default 0,

  created_at timestamptz not null default now(),

  constraint facility_images_storage_path_not_empty
    check (char_length(trim(storage_path)) > 0),

  constraint facility_images_display_order_non_negative
    check (display_order >= 0)
);


create index facility_images_facility_id_idx
  on public.facility_images(facility_id);

create index facility_images_facility_order_idx
  on public.facility_images(facility_id, display_order);


-- ============================================================
-- 2. Facility Operating Hours
-- ============================================================

create table public.facility_operating_hours (
  id uuid primary key default gen_random_uuid(),

  facility_id uuid not null
    references public.facilities(id)
    on delete cascade,

  day_of_week smallint not null,

  opens_at time,
  closes_at time,

  is_closed boolean not null default false,

  created_at timestamptz not null default now(),

  constraint operating_hours_day_valid
    check (day_of_week between 0 and 6),

  constraint operating_hours_time_configuration
    check (
      (
        is_closed = true
        and opens_at is null
        and closes_at is null
      )
      or
      (
        is_closed = false
        and opens_at is not null
        and closes_at is not null
        and opens_at < closes_at
      )
    ),

  constraint operating_hours_unique_day
    unique (facility_id, day_of_week)
);


create index facility_operating_hours_facility_id_idx
  on public.facility_operating_hours(facility_id);


-- ============================================================
-- 3. Facility Slots
--
-- These are reusable time-slot definitions.
--
-- Example:
--
-- 18:00 → 19:00
-- 19:00 → 20:00
-- 20:00 → 21:00
--
-- The actual booking date is stored later in `bookings`.
-- ============================================================

create table public.facility_slots (
  id uuid primary key default gen_random_uuid(),

  facility_id uuid not null
    references public.facilities(id)
    on delete cascade,

  start_time time not null,
  end_time time not null,

  duration_min integer not null,

  base_price numeric(10, 2) not null,

  is_active boolean not null default true,

  created_at timestamptz not null default now(),

  constraint facility_slots_time_valid
    check (start_time < end_time),

  constraint facility_slots_duration_positive
    check (duration_min > 0),

  constraint facility_slots_price_non_negative
    check (base_price >= 0),

  constraint facility_slots_unique_time
    unique (facility_id, start_time, end_time)
);


create index facility_slots_facility_id_idx
  on public.facility_slots(facility_id);

create index facility_slots_active_idx
  on public.facility_slots(facility_id, is_active);

create index facility_slots_time_idx
  on public.facility_slots(facility_id, start_time);


-- ============================================================
-- 4. Row Level Security
-- ============================================================

alter table public.facility_images enable row level security;
alter table public.facility_operating_hours enable row level security;
alter table public.facility_slots enable row level security;


-- ============================================================
-- 5. Facility Images Policies
-- ============================================================


-- Anyone who can see a facility can see its images.

create policy "Users can view facility images"
on public.facility_images
for select
to authenticated
using (
  exists (
    select 1
    from public.facilities f
    where f.id = facility_images.facility_id
      and (
        f.status = 'active'
        or f.owner_id = auth.uid()
        or public.is_admin()
      )
  )
);


-- Owners can add images to their own facilities.

create policy "Owners can add facility images"
on public.facility_images
for insert
to authenticated
with check (
  public.owns_facility(facility_id)
  or public.is_admin()
);


-- Owners can modify images belonging to their facilities.

create policy "Owners can update facility images"
on public.facility_images
for update
to authenticated
using (
  public.owns_facility(facility_id)
  or public.is_admin()
)
with check (
  public.owns_facility(facility_id)
  or public.is_admin()
);


-- Owners can delete their own facility images.

create policy "Owners can delete facility images"
on public.facility_images
for delete
to authenticated
using (
  public.owns_facility(facility_id)
  or public.is_admin()
);


-- ============================================================
-- 6. Operating Hours Policies
-- ============================================================


create policy "Users can view facility operating hours"
on public.facility_operating_hours
for select
to authenticated
using (
  exists (
    select 1
    from public.facilities f
    where f.id = facility_operating_hours.facility_id
      and (
        f.status = 'active'
        or f.owner_id = auth.uid()
        or public.is_admin()
      )
  )
);


create policy "Owners can create operating hours"
on public.facility_operating_hours
for insert
to authenticated
with check (
  public.owns_facility(facility_id)
  or public.is_admin()
);


create policy "Owners can update operating hours"
on public.facility_operating_hours
for update
to authenticated
using (
  public.owns_facility(facility_id)
  or public.is_admin()
)
with check (
  public.owns_facility(facility_id)
  or public.is_admin()
);


create policy "Owners can delete operating hours"
on public.facility_operating_hours
for delete
to authenticated
using (
  public.owns_facility(facility_id)
  or public.is_admin()
);


-- ============================================================
-- 7. Facility Slot Policies
-- ============================================================


create policy "Users can view facility slots"
on public.facility_slots
for select
to authenticated
using (
  exists (
    select 1
    from public.facilities f
    where f.id = facility_slots.facility_id
      and (
        f.status = 'active'
        or f.owner_id = auth.uid()
        or public.is_admin()
      )
  )
);


create policy "Owners can create facility slots"
on public.facility_slots
for insert
to authenticated
with check (
  public.owns_facility(facility_id)
  or public.is_admin()
);


create policy "Owners can update facility slots"
on public.facility_slots
for update
to authenticated
using (
  public.owns_facility(facility_id)
  or public.is_admin()
)
with check (
  public.owns_facility(facility_id)
  or public.is_admin()
);


create policy "Owners can delete facility slots"
on public.facility_slots
for delete
to authenticated
using (
  public.owns_facility(facility_id)
  or public.is_admin()
);