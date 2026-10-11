-- ============================================================
-- UniSport — Migration 017: Booking horizon
-- ============================================================


-- ============================================================
-- Problem
--
-- create_booking() and join_waitlist() rejected past dates but
-- accepted any future date, so one account could create rows
-- for dates up to the end of the date range. The UI already
-- limits the date picker to 30 days, but the UI is not a
-- security control.
--
-- Fix
--
-- A single helper, public.max_booking_date(), defines the
-- latest bookable date. create_booking(), join_waitlist() and
-- get_slot_availability() reject anything later with
-- SQLSTATE 22008 "Booking date is too far in the future".
--
-- TEMPORARY COMPATIBILITY BOUND
--
-- The UI allows today .. today + 30 using the browser's local
-- date. The database only knows current_date, which is the
-- server's (UTC) date. For a user in India, between 00:00 and
-- 05:30 local time, "today + 30" is one day beyond the UTC
-- "current_date + 30", so an exact bound would reject a date
-- the UI offers for about 5.5 hours every day.
--
-- Until facilities carry a time zone, the bound is therefore
-- current_date + 31: a safety valve against unbounded dates,
-- not the product rule (the UI keeps the exact 30 days).
--
-- When facility time zones are introduced, replace the body of
-- public.max_booking_date() (or give it a facility argument)
-- together with the elapsed-slot rule. The three RPCs do not
-- need to change. The same time-zone gap is why "today" in
-- create_booking() is still the server date.
--
-- Never lower the bound without checking existing waitlist
-- entries: an entry beyond a smaller bound could no longer be
-- accepted.
-- ============================================================

create or replace function public.max_booking_date()
returns date
language sql
stable
set search_path = ''
as $$
  select current_date + 31;
$$;

-- Internal helper: callable by the SECURITY DEFINER functions
-- below (they run as the function owner), not by API clients.
revoke execute on function public.max_booking_date()
  from public, anon, authenticated;


-- ============================================================
-- create_booking(): horizon check (step 2b). Nothing else is
-- changed from migration 013.
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
  -- 2b. Booking horizon
  --
  -- No booking more than public.max_booking_date() ahead.
  -- Without an upper bound one account could create rows for
  -- any date up to the end of the date range.
  -- ----------------------------------------------------------

  if p_booking_date > public.max_booking_date() then
    raise exception
      using
        errcode = '22008',
        message = 'Booking date is too far in the future';
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

revoke execute on function public.create_booking(uuid, uuid, date)
  from public, anon;
grant execute on function public.create_booking(uuid, uuid, date)
  to authenticated;


-- ============================================================
-- join_waitlist(): horizon check. Nothing else is changed from
-- migration 011.
-- ============================================================

create or replace function public.join_waitlist(
  p_facility_id uuid,
  p_slot_id uuid,
  p_booking_date date
)
returns table (
  entry_id uuid,
  entries_ahead integer
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
  v_slot_active boolean;
  v_is_closed boolean;
  v_opens_at time;
  v_closes_at time;
  v_entry_id uuid;
  v_position bigint;
  v_ahead integer;
begin

  -- Authentication
  v_user_id := (select auth.uid());

  if v_user_id is null then
    raise exception
      using
        errcode = '28000',
        message = 'Authentication required';
  end if;

  -- Booking date
  if p_booking_date is null or p_booking_date < current_date then
    raise exception
      using
        errcode = '22007',
        message = 'Booking date cannot be in the past';
  end if;

  -- Booking horizon (same bound as create_booking()).
  if p_booking_date > public.max_booking_date() then
    raise exception
      using
        errcode = '22008',
        message = 'Booking date is too far in the future';
  end if;

  -- Facility
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

  -- Slot
  select
    fs.facility_id,
    fs.start_time,
    fs.end_time,
    fs.is_active
  into
    v_slot_facility_id,
    v_slot_start,
    v_slot_end,
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

  -- Operating hours: do not queue for a slot that can never
  -- be booked on that day.
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
    and oh.day_of_week = extract(dow from p_booking_date)::integer;

  if not found
     or v_is_closed
     or v_slot_start < v_opens_at
     or v_slot_end > v_closes_at then
    raise exception
      using
        errcode = 'P0001',
        message = 'Selected slot is not bookable on the selected date';
  end if;

  -- The caller already holds a booking for this slot and date.
  if exists (
    select 1
    from public.bookings b
    where b.user_id = v_user_id
      and b.slot_id = p_slot_id
      and b.booking_date = p_booking_date
      and (
        b.status in ('confirmed', 'completed')
        or (b.status = 'pending_payment' and b.expires_at > now())
      )
  ) then
    raise exception
      using
        errcode = 'P0001',
        message = 'You already have a booking for this slot and date';
  end if;

  -- Only unavailable slots can be waitlisted: an unexpired
  -- pending booking, a confirmed or completed booking, or a
  -- live offer held for someone in the queue.
  if not exists (
    select 1
    from public.bookings b
    where b.slot_id = p_slot_id
      and b.booking_date = p_booking_date
      and (
        b.status in ('confirmed', 'completed')
        or (b.status = 'pending_payment' and b.expires_at > now())
      )
  )
  and not exists (
    select 1
    from public.waitlist_entries w
    where w.slot_id = p_slot_id
      and w.booking_date = p_booking_date
      and w.status = 'offered'
      and w.offer_expires_at > now()
  ) then
    raise exception
      using
        errcode = 'P0001',
        message = 'Selected slot is currently available; book it directly';
  end if;

  -- Enqueue. queue_position is assigned by the database.
  begin
    insert into public.waitlist_entries (
      user_id,
      facility_id,
      slot_id,
      booking_date
    )
    values (
      v_user_id,
      p_facility_id,
      p_slot_id,
      p_booking_date
    )
    returning id, queue_position
    into v_entry_id, v_position;
  exception
    when unique_violation then
      raise exception
        using
          errcode = '23505',
          message = 'You are already on the waitlist for this slot and date';
  end;

  select count(*)::integer
  into v_ahead
  from public.waitlist_entries w
  where w.slot_id = p_slot_id
    and w.booking_date = p_booking_date
    and w.status in ('waiting', 'offered')
    and w.queue_position < v_position;

  entry_id := v_entry_id;
  entries_ahead := v_ahead;

  return next;

end;
$$;

revoke execute on function public.join_waitlist(uuid, uuid, date)
  from public, anon;
grant execute on function public.join_waitlist(uuid, uuid, date)
  to authenticated;


-- ============================================================
-- get_slot_availability(): horizon check. Nothing else is
-- changed from migration 015.
-- ============================================================

create or replace function public.get_slot_availability(
  p_facility_id uuid,
  p_booking_date date
)
returns table (
  slot_id uuid,
  status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_facility_status public.facility_status;
  v_visible boolean;
  v_is_closed boolean;
  v_opens_at time;
  v_closes_at time;
  v_hours_found boolean;
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
  -- 2. Validate the date
  --
  -- Same rule as create_booking(). Infinite dates have no
  -- weekday and are never a real booking date.
  -- ----------------------------------------------------------

  if p_booking_date is null then
    raise exception
      using
        errcode = '22023',
        message = 'Booking date is required';
  end if;

  if p_booking_date < current_date then
    raise exception
      using
        errcode = '22007',
        message = 'Booking date cannot be in the past';
  end if;

  if p_booking_date = 'infinity'::date then
    raise exception
      using
        errcode = '22007',
        message = 'Booking date is not a valid date';
  end if;

  -- Booking horizon: the same bound create_booking() applies, so
  -- the UI is never shown availability for a date it cannot book.
  if p_booking_date > public.max_booking_date() then
    raise exception
      using
        errcode = '22008',
        message = 'Booking date is too far in the future';
  end if;


  -- ----------------------------------------------------------
  -- 3. Validate and authorise the facility
  --
  -- This function is SECURITY DEFINER, so Row Level Security
  -- does not protect the facilities lookup. The facilities
  -- SELECT policy is restated explicitly.
  -- ----------------------------------------------------------

  select
    f.status,
    (
      f.status = 'active'
      or f.owner_id = v_user_id
      or public.is_admin()
    )
  into
    v_facility_status,
    v_visible
  from public.facilities f
  where f.id = p_facility_id;

  if not found or not v_visible then
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
  -- 4. Operating hours for that weekday
  --
  -- EXTRACT(DOW): 0 = Sunday ... 6 = Saturday, as in
  -- create_booking().
  -- ----------------------------------------------------------

  select
    true,
    oh.is_closed,
    oh.opens_at,
    oh.closes_at
  into
    v_hours_found,
    v_is_closed,
    v_opens_at,
    v_closes_at
  from public.facility_operating_hours oh
  where oh.facility_id = p_facility_id
    and oh.day_of_week = extract(dow from p_booking_date)::integer;

  v_hours_found := coalesce(v_hours_found, false);


  -- ----------------------------------------------------------
  -- 5. One status per slot
  -- ----------------------------------------------------------

  return query
  select
    fs.id,
    case
      when not fs.is_active
        then 'inactive'

      when not v_hours_found
        or v_is_closed
        or fs.start_time < v_opens_at
        or fs.end_time > v_closes_at
        then 'closed'

      when exists (
        select 1
        from public.bookings b
        where b.slot_id = fs.id
          and b.booking_date = p_booking_date
          and (
            b.status in ('confirmed', 'completed')
            or (
              b.status = 'pending_payment'
              and b.expires_at > now()
            )
          )
      )
        then 'booked'

      when exists (
        select 1
        from public.waitlist_entries w
        where w.slot_id = fs.id
          and w.booking_date = p_booking_date
          and w.status = 'offered'
          and w.offer_expires_at > now()
          and w.user_id <> v_user_id
      )
        then 'offer_held'

      else 'available'
    end
  from public.facility_slots fs
  where fs.facility_id = p_facility_id
  order by fs.start_time, fs.id;

end;
$$;

revoke execute on function public.get_slot_availability(uuid, date)
  from public, anon;
grant execute on function public.get_slot_availability(uuid, date)
  to authenticated;
