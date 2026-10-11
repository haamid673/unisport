-- ============================================================
-- UniSport — Migration 015: Authoritative slot availability
-- ============================================================


-- ============================================================
-- get_slot_availability(facility, date)
--
-- A narrow, read-only function that tells the customer UI, for
-- every slot of one facility on one date, whether it can be
-- booked right now.
--
-- Why a function and not a table read
--
--   Customers cannot SELECT other customers' bookings (RLS), and
--   must not be able to. Availability is derived from exactly
--   that data, so it has to be computed by a SECURITY DEFINER
--   function that returns only the derived status.
--
-- Result: one row per slot of the facility
--
--   slot_id   the facility_slots id
--   status    one of
--
--     inactive    the slot is switched off
--     closed      the facility is closed that weekday, has no
--                 hours configured for it, or the slot lies
--                 outside the opening hours
--     booked      a confirmed or completed booking, or a
--                 pending_payment booking whose hold is still
--                 valid, occupies the slot
--     offer_held  another user holds a live waitlist offer
--     available   create_booking() would accept the slot
--
--   Precedence is the order above: a slot that is both closed
--   and booked reads "closed"; one that is booked and also has
--   an offer reads "booked".
--
-- Rules
--
--   * Time is read from the clock, never from status alone.
--     A pending_payment booking with expires_at <= now(), and
--     an "offered" waitlist entry with offer_expires_at <=
--     now(), no longer hold the slot even if the cron sweep
--     has not updated their status yet. This is the same view
--     create_booking() takes (its step 6 expires stale holds
--     before inserting). It matters because the exclusion
--     constraint's WHERE clause looks at status only.
--   * Nothing is written. The function does not sweep stale
--     rows; that stays the job of create_booking() and the
--     scheduled expiry functions.
--   * A live offer held by the CALLER reads "available": the
--     slot is theirs to book and create_booking() exempts the
--     offer's own holder. Nothing about anyone else is shown.
--   * The caller's own bookings read "booked", like anyone's.
--   * No booking id, user id, name, price, payment state or
--     timestamp is returned. "booked" and "offer_held" say that
--     a slot is taken, never by whom or why.
--
-- Authorization
--
--   Authenticated callers only. The caller must be able to see
--   the facility under the same rule as the facilities SELECT
--   policy (active, or owned by the caller, or caller is an
--   admin). Anything else is reported as "Facility not found"
--   so the function is not an oracle for facility ids. A
--   visible facility that is not active is not bookable and is
--   rejected like create_booking() does.
--
-- Not a reservation
--
--   The result is a snapshot. Another user can book the slot a
--   moment later. create_booking() stays authoritative: it
--   takes the advisory lock, re-validates everything and relies
--   on the exclusion constraint.
--
-- Known gap (deliberately not decided here)
--
--   create_booking() accepts a slot that has already started or
--   ended earlier today, and the schema has no facility time
--   zone, so the database cannot tell what "now" is for a
--   facility. This function mirrors create_booking() and
--   reports such a slot as available.
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


-- ============================================================
-- Function privileges
--
-- Supabase's default privileges grant EXECUTE on new public
-- functions to anon and authenticated, and PostgreSQL grants it
-- to PUBLIC. Remove all of that, then grant the one intended
-- role.
-- ============================================================

revoke execute
on function public.get_slot_availability(uuid, date)
from public;

revoke execute
on function public.get_slot_availability(uuid, date)
from anon;

grant execute
on function public.get_slot_availability(uuid, date)
to authenticated;
