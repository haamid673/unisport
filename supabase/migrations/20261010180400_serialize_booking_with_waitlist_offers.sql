-- ============================================================
-- UniSport — Migration 013: Serialise bookings with waitlist offers
-- ============================================================


-- ============================================================
-- Race fixed
--
--   T1  offer_next_waitlist_entry(): no booking occupies the
--       slot -> mark the next entry "offered"   (uncommitted)
--   T2  create_booking(): no live offer exists (T1's is not
--       visible yet) -> insert pending booking  (commit)
--   T1  commit
--
-- Outcome: a pending booking AND a live offer for the same slot
-- and date. The exclusion constraint prevented a double
-- booking, but the offer can never be accepted (23P01), burns
-- the 15-minute window and blocks the next user in line.
--
-- Fix: create_booking() takes the same advisory lock as
-- offer_next_waitlist_entry(), keyed by slot and date, so the
-- two decisions can no longer overlap. The only change to
-- create_booking() is step 5b below.
-- ============================================================

create or replace function public.create_booking(
  p_facility_id uuid,
  p_slot_id uuid,
  p_booking_date date
)
returns table (
  booking_id uuid,
  booking_amount numeric(10, 2),
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_facility_status public.facility_status;
  v_slot_facility_id uuid;
  v_slot_start time;
  v_slot_end time;
  v_slot_price numeric(10, 2);
  v_slot_active boolean;
  v_day_of_week integer;
  v_is_closed boolean;
  v_opens_at time;
  v_closes_at time;
  v_booking_id uuid;
  v_expires_at timestamptz;
begin

  -- ----------------------------------------------------------
  -- 1. Authentication
  -- ----------------------------------------------------------

  v_user_id := (select auth.uid());

  if v_user_id is null then
    raise exception
      using
        errcode = '28000',
        message = 'Authentication required';
  end if;


  -- ----------------------------------------------------------
  -- 2. Validate booking date
  -- ----------------------------------------------------------

  if p_booking_date < current_date then
    raise exception
      using
        errcode = '22007',
        message = 'Booking date cannot be in the past';
  end if;


  -- ----------------------------------------------------------
  -- 3. Validate facility
  -- ----------------------------------------------------------

  select f.status
  into v_facility_status
  from public.facilities f
  where f.id = p_facility_id;

  if not found then
    raise exception
      using
        errcode = 'P0002',
        message = 'Facility not found';
  end if;

  if v_facility_status <> 'active' then
    raise exception
      using
        errcode = 'P0001',
        message = 'Facility is not currently available for booking';
  end if;


  -- ----------------------------------------------------------
  -- 4. Validate slot belongs to facility
  -- ----------------------------------------------------------

  select
    fs.facility_id,
    fs.start_time,
    fs.end_time,
    fs.base_price,
    fs.is_active
  into
    v_slot_facility_id,
    v_slot_start,
    v_slot_end,
    v_slot_price,
    v_slot_active
  from public.facility_slots fs
  where fs.id = p_slot_id;

  if not found then
    raise exception
      using
        errcode = 'P0002',
        message = 'Facility slot not found';
  end if;

  if v_slot_facility_id <> p_facility_id then
    raise exception
      using
        errcode = '22023',
        message = 'Slot does not belong to the selected facility';
  end if;

  if not v_slot_active then
    raise exception
      using
        errcode = 'P0001',
        message = 'Selected slot is not active';
  end if;


  -- ----------------------------------------------------------
  -- 5. Validate operating hours
  --
  -- PostgreSQL EXTRACT(DOW):
  --   0 = Sunday
  --   1 = Monday
  --   ...
  --   6 = Saturday
  -- ----------------------------------------------------------

  v_day_of_week :=
    extract(dow from p_booking_date)::integer;

  select
    oh.is_closed,
    oh.opens_at,
    oh.closes_at
  into
    v_is_closed,
    v_opens_at,
    v_closes_at
  from public.facility_operating_hours oh
  where oh.facility_id = p_facility_id
    and oh.day_of_week = v_day_of_week;

  if not found then
    raise exception
      using
        errcode = 'P0001',
        message = 'Facility operating hours are not configured for this day';
  end if;

  if v_is_closed then
    raise exception
      using
        errcode = 'P0001',
        message = 'Facility is closed on the selected date';
  end if;

  if v_slot_start < v_opens_at
     or v_slot_end > v_closes_at then
    raise exception
      using
        errcode = 'P0001',
        message = 'Selected slot falls outside facility operating hours';
  end if;


  -- ----------------------------------------------------------
  -- 5b. Serialise with waitlist offer decisions
  --
  -- offer_next_waitlist_entry() decides "nothing occupies this
  -- slot, so offer it" and create_booking() decides "nobody
  -- holds an offer, so book it". Each can only see the other's
  -- COMMITTED work, so without a shared lock both can succeed
  -- and leave a booking and a live offer for the same slot.
  --
  -- Take the same per-(slot, date) advisory lock the offer
  -- worker uses. This call waits (briefly: the offer decision
  -- is short); the worker uses the try variant and simply
  -- retries on its next tick. The lock is released at the end
  -- of the transaction, after the booking is committed or
  -- rolled back.
  -- ----------------------------------------------------------

  perform pg_advisory_xact_lock(
    hashtextextended(p_slot_id::text || ':' || p_booking_date::text, 0)
  );


  -- ----------------------------------------------------------
  -- 6. Expire stale pending-payment bookings
  --
  -- A pending booking reserves its slot for 10 minutes.
  -- Once that reservation expires, the slot becomes available
  -- again.
  -- ----------------------------------------------------------

  update public.bookings b
  set
    status = 'expired',
    updated_at = now()
  where b.slot_id = p_slot_id
    and b.booking_date = p_booking_date
    and b.status = 'pending_payment'
    and b.expires_at <= now();


  -- ----------------------------------------------------------
  -- 6b. Respect waitlist offers
  --
  -- While another user holds a live waitlist offer for this
  -- slot and date, the slot is held for them. Without this
  -- check an offer would be a notification, not a reservation.
  -- The offer's own holder is not blocked.
  -- ----------------------------------------------------------

  if exists (
    select 1
    from public.waitlist_entries w
    where w.slot_id = p_slot_id
      and w.booking_date = p_booking_date
      and w.status = 'offered'
      and w.offer_expires_at > now()
      and w.user_id <> v_user_id
  ) then
    raise exception
      using
        errcode = 'P0001',
        message = 'The selected slot is currently held for a waitlist offer';
  end if;


  -- ----------------------------------------------------------
  -- 7. Create pending-payment booking
  --
  -- The amount comes from the database's slot price.
  -- The client cannot supply the amount.
  --
  -- Future demand-aware pricing will replace this calculation
  -- with a server-side pricing function.
  -- ----------------------------------------------------------

  v_expires_at := now() + interval '10 minutes';

  begin

    insert into public.bookings (
      user_id,
      facility_id,
      slot_id,
      booking_date,
      start_time,
      end_time,
      amount,
      status,
      payment_status,
      expires_at
    )
    values (
      v_user_id,
      p_facility_id,
      p_slot_id,
      p_booking_date,
      v_slot_start,
      v_slot_end,
      v_slot_price,
      'pending_payment',
      'pending',
      v_expires_at
    )
    returning id
    into v_booking_id;

  exception
    when exclusion_violation then
      raise exception
        using
          errcode = '23P01',
          message = 'The selected slot is no longer available';
  end;


  -- ----------------------------------------------------------
  -- 7b. Close the caller's own waitlist entries
  --
  -- A live offer becomes accepted and is linked to the new
  -- booking. This does not confirm or pay for anything: the
  -- booking is still pending_payment.
  -- Any other entry the caller had for this slot and date is
  -- no longer needed.
  -- ----------------------------------------------------------

  update public.waitlist_entries w
  set
    status = 'accepted',
    booking_id = v_booking_id
  where w.user_id = v_user_id
    and w.slot_id = p_slot_id
    and w.booking_date = p_booking_date
    and w.status = 'offered'
    and w.offer_expires_at > now();

  update public.waitlist_entries w
  set status = 'cancelled'
  where w.user_id = v_user_id
    and w.slot_id = p_slot_id
    and w.booking_date = p_booking_date
    and w.status in ('waiting', 'offered');


  -- ----------------------------------------------------------
  -- 8. Return booking details
  -- ----------------------------------------------------------

  booking_id := v_booking_id;
  booking_amount := v_slot_price;
  expires_at := v_expires_at;

  return next;

end;
$$;


-- ============================================================
-- Function privileges (unchanged; restated for clarity)
-- ============================================================

revoke execute
on function public.create_booking(uuid, uuid, date)
from public;

revoke execute
on function public.create_booking(uuid, uuid, date)
from anon;

grant execute
on function public.create_booking(uuid, uuid, date)
to authenticated;
