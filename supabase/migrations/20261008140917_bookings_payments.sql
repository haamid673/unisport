-- ============================================================
-- UniSport — Migration 004: Bookings & Payments
-- ============================================================

-- ------------------------------------------------------------
-- Required extension for reservation/exclusion constraints
-- ------------------------------------------------------------

create extension if not exists btree_gist;


-- ============================================================
-- 1. Booking status
-- ============================================================

create type public.booking_status as enum (
  'pending_payment',
  'confirmed',
  'completed',
  'cancelled',
  'expired'
);


-- ============================================================
-- 2. Payment status
-- ============================================================

create type public.payment_status as enum (
  'pending',
  'paid',
  'failed',
  'refunded',
  'partially_refunded'
);


-- ============================================================
-- 3. Payment provider
-- ============================================================

create type public.payment_provider as enum (
  'razorpay'
);


-- ============================================================
-- 4. Bookings
-- ============================================================

create table public.bookings (
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

  -- Snapshot the slot's actual times at booking creation.
  -- This protects historical booking records if the slot
  -- definition changes later.
  start_time time not null,
  end_time time not null,

  -- Final agreed booking amount.
  -- This must never be recalculated for an existing booking.
  amount numeric(10, 2) not null,

  status public.booking_status not null default 'pending_payment',

  payment_status public.payment_status not null default 'pending',

  expires_at timestamptz,

  cancelled_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint bookings_date_valid
    check (booking_date >= current_date),

  constraint bookings_time_valid
    check (start_time < end_time),

  constraint bookings_amount_non_negative
    check (amount >= 0),

  constraint bookings_expiry_valid
    check (
      status <> 'pending_payment'
      or expires_at is not null
    )
);


-- ============================================================
-- 5. Booking indexes
-- ============================================================

create index bookings_user_id_idx
  on public.bookings(user_id);

create index bookings_facility_id_idx
  on public.bookings(facility_id);

create index bookings_slot_id_idx
  on public.bookings(slot_id);

create index bookings_date_idx
  on public.bookings(booking_date);

create index bookings_user_date_idx
  on public.bookings(user_id, booking_date);

create index bookings_facility_date_idx
  on public.bookings(facility_id, booking_date);

create index bookings_payment_status_idx
  on public.bookings(payment_status);

create index bookings_expiry_idx
  on public.bookings(expires_at)
  where status = 'pending_payment';


-- ============================================================
-- 6. Prevent overlapping active reservations
--
-- A slot can have multiple bookings across different dates.
--
-- But for the SAME slot and SAME booking date, the actual
-- booking time range must not overlap while the reservation
-- is active.
--
-- Cancelled and expired bookings do not participate.
--
-- The [start, end) representation means:
--
-- 18:00–19:00
-- 19:00–20:00
--
-- are allowed next to each other.
-- ============================================================

alter table public.bookings
add constraint bookings_no_overlap
exclude using gist (
  slot_id with =,
  booking_date with =,
  tsrange(
    booking_date + start_time,
    booking_date + end_time,
    '[)'
  ) with &&
)
where (
  status in ('pending_payment', 'confirmed', 'completed')
);


-- ============================================================
-- 7. Payments
-- ============================================================

create table public.payments (
  id uuid primary key default gen_random_uuid(),

  booking_id uuid not null
    references public.bookings(id)
    on delete restrict,

  provider public.payment_provider not null default 'razorpay',

  provider_order_id text,
  provider_payment_id text,

  amount numeric(10, 2) not null,

  status public.payment_status not null default 'pending',

  paid_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint payments_amount_non_negative
    check (amount >= 0),

  constraint payments_provider_order_id_length
    check (
      provider_order_id is null
      or char_length(provider_order_id) <= 255
    ),

  constraint payments_provider_payment_id_length
    check (
      provider_payment_id is null
      or char_length(provider_payment_id) <= 255
    )
);


-- ------------------------------------------------------------
-- Payment indexes
-- ------------------------------------------------------------

create index payments_booking_id_idx
  on public.payments(booking_id);

create index payments_status_idx
  on public.payments(status);


-- ------------------------------------------------------------
-- Razorpay identifiers must be unique when present.
-- This is important for webhook idempotency.
-- ------------------------------------------------------------

create unique index payments_provider_order_id_unique
  on public.payments(provider_order_id)
  where provider_order_id is not null;

create unique index payments_provider_payment_id_unique
  on public.payments(provider_payment_id)
  where provider_payment_id is not null;


-- ------------------------------------------------------------
-- One payment record per booking.
--
-- If a future business requirement needs multiple payment
-- attempts, this constraint can be replaced by a dedicated
-- payment-attempt model.
-- ------------------------------------------------------------

create unique index payments_one_per_booking
  on public.payments(booking_id);


-- ============================================================
-- 8. Refunds
-- ============================================================

create table public.refunds (
  id uuid primary key default gen_random_uuid(),

  payment_id uuid not null
    references public.payments(id)
    on delete restrict,

  amount numeric(10, 2) not null,

  reason text,

  provider_refund_id text,

  status public.payment_status not null default 'pending',

  created_at timestamptz not null default now(),

  constraint refunds_amount_positive
    check (amount > 0),

  constraint refunds_reason_length
    check (
      reason is null
      or char_length(reason) <= 1000
    )
);


-- ------------------------------------------------------------
-- Refund indexes
-- ------------------------------------------------------------

create index refunds_payment_id_idx
  on public.refunds(payment_id);

create index refunds_status_idx
  on public.refunds(status);


create unique index refunds_provider_refund_id_unique
  on public.refunds(provider_refund_id)
  where provider_refund_id is not null;


-- ============================================================
-- 9. updated_at triggers
-- ============================================================

create trigger bookings_set_updated_at
before update on public.bookings
for each row
execute function public.handle_updated_at();


create trigger payments_set_updated_at
before update on public.payments
for each row
execute function public.handle_updated_at();


-- ============================================================
-- 10. Row Level Security
-- ============================================================

alter table public.bookings enable row level security;
alter table public.payments enable row level security;
alter table public.refunds enable row level security;


-- ============================================================
-- 11. Booking policies
-- ============================================================


-- Users can see their own bookings.
-- Owners/admins can see bookings belonging to facilities
-- they manage.

create policy "Users can view their own bookings"
on public.bookings
for select
to authenticated
using (
  user_id = auth.uid()
  or public.is_admin()
  or public.owns_facility(facility_id)
);


-- No direct INSERT policy.
--
-- Booking creation will happen through a transaction-safe
-- database function in the next migration.


-- Users can cancel their own bookings through the controlled
-- booking cancellation function.
--
-- No direct UPDATE policy is intentionally provided.


-- No direct DELETE policy.
--
-- Booking records are historical business records and should
-- not be deleted by normal clients.


-- ============================================================
-- 12. Payment policies
-- ============================================================


-- Users can see payment records belonging to their bookings.
-- Facility owners can see payment information associated
-- with their facilities.
-- Admins can see all payments.

create policy "Users can view relevant payments"
on public.payments
for select
to authenticated
using (
  exists (
    select 1
    from public.bookings b
    where b.id = payments.booking_id
      and (
        b.user_id = auth.uid()
        or public.owns_facility(b.facility_id)
        or public.is_admin()
      )
  )
);


-- No direct INSERT/UPDATE/DELETE policies.
--
-- Payment state is controlled by trusted server-side
-- payment/webhook logic.


-- ============================================================
-- 13. Refund policies
-- ============================================================


create policy "Users can view relevant refunds"
on public.refunds
for select
to authenticated
using (
  exists (
    select 1
    from public.payments p
    join public.bookings b
      on b.id = p.booking_id
    where p.id = refunds.payment_id
      and (
        b.user_id = auth.uid()
        or public.owns_facility(b.facility_id)
        or public.is_admin()
      )
  )
);


-- No direct INSERT/UPDATE/DELETE policies.
--
-- Refunds will be created through trusted server-side
-- cancellation/refund logic.