-- ============================================================
-- UniSport — Migration 009: Waitlist entries
-- ============================================================


-- ============================================================
-- 1. Waitlist status
--
--   waiting    in the queue
--   offered    holds a time-limited offer to book the slot
--   accepted   took the offer; booking_id references the
--              pending-payment booking that resulted
--   expired    offer lapsed, or the booking date passed
--   cancelled  user left the queue or declined the offer
--
-- "accepted" never means paid or confirmed. It only means the
-- user created a pending_payment booking through
-- create_booking().
-- ============================================================

create type public.waitlist_status as enum (
  'waiting',
  'offered',
  'accepted',
  'expired',
  'cancelled'
);


-- ============================================================
-- 2. Waitlist entries
-- ============================================================

create table public.waitlist_entries (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null
    references public.profiles(id)
    on delete restrict,

  facility_id uuid not null
    references public.facilities(id)
    on delete restrict,

  slot_id uuid not null
    references public.facility_slots(id)
    on delete restrict,

  booking_date date not null,

  -- Server-assigned FIFO position. Clients can never supply
  -- this value (GENERATED ALWAYS), and no client has INSERT
  -- or UPDATE privileges on the table anyway.
  queue_position bigint generated always as identity,

  status public.waitlist_status not null default 'waiting',

  offered_at timestamptz,
  offer_expires_at timestamptz,

  -- The pending-payment booking created when the offer was
  -- accepted.
  booking_id uuid
    references public.bookings(id)
    on delete restrict,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint waitlist_offer_fields_valid
    check (
      status <> 'offered'
      or (offered_at is not null and offer_expires_at is not null)
    ),

  constraint waitlist_waiting_has_no_offer
    check (
      status <> 'waiting'
      or (
        offered_at is null
        and offer_expires_at is null
        and booking_id is null
      )
    ),

  constraint waitlist_offer_window_valid
    check (
      offer_expires_at is null
      or offered_at is null
      or offer_expires_at > offered_at
    ),

  constraint waitlist_accepted_has_booking
    check (
      status <> 'accepted'
      or booking_id is not null
    )
);


-- ============================================================
-- 3. Indexes and uniqueness
-- ============================================================

-- One active entry per user, slot and date.
create unique index waitlist_one_active_entry_per_user
  on public.waitlist_entries(user_id, slot_id, booking_date)
  where status in ('waiting', 'offered');

-- At most one outstanding offer per slot and date.
-- This is the database-level backstop that stops concurrent
-- workers from issuing two offers for the same slot.
create unique index waitlist_one_offer_per_slot_date
  on public.waitlist_entries(slot_id, booking_date)
  where status = 'offered';

-- Next-in-line lookup.
create index waitlist_queue_idx
  on public.waitlist_entries(slot_id, booking_date, queue_position)
  where status = 'waiting';

-- Offer expiry sweep.
create index waitlist_offer_expiry_idx
  on public.waitlist_entries(offer_expires_at)
  where status = 'offered';

create index waitlist_user_id_idx
  on public.waitlist_entries(user_id);

create index waitlist_facility_id_idx
  on public.waitlist_entries(facility_id);

create index waitlist_booking_id_idx
  on public.waitlist_entries(booking_id)
  where booking_id is not null;


-- ============================================================
-- 4. updated_at trigger
-- ============================================================

create trigger waitlist_entries_set_updated_at
before update on public.waitlist_entries
for each row
execute function public.handle_updated_at();


-- ============================================================
-- 5. Row Level Security
--
-- Users may read only their own entries. There are no INSERT,
-- UPDATE or DELETE policies: every transition goes through the
-- SECURITY DEFINER functions in the waitlist functions
-- migration.
-- ============================================================

alter table public.waitlist_entries enable row level security;

create policy "Users can view their own waitlist entries"
on public.waitlist_entries
for select
to authenticated
using (user_id = (select auth.uid()));


-- ============================================================
-- 6. Table privileges
--
-- Supabase's default privileges grant full table access to
-- anon and authenticated. Remove everything except SELECT for
-- authenticated (still filtered by RLS).
-- ============================================================

revoke all on table public.waitlist_entries from public;
revoke all on table public.waitlist_entries from anon;
revoke all on table public.waitlist_entries from authenticated;

grant select on table public.waitlist_entries to authenticated;
