-- ============================================================
-- UniSport — create_booking: wait for locked expired holds
-- ============================================================
--
-- Replaces public.create_booking(uuid, uuid, date) with the
-- definition from 20261014190100_expire_stale_holds_per_facility.sql.
-- The ONLY functional change is step 6 (expiry sweep):
--
--   * SKIP LOCKED is removed: the sweep waits for a stale hold
--     that another transaction has locked and re-evaluates it
--     afterwards;
--   * the sweep is narrowed to holds whose snapshot overlaps the
--     requested slot's interval, so a booking only ever waits for
--     a row that could actually refuse it.
--
-- Why: with SKIP LOCKED, a booking that skipped a locked stale
-- hold failed with 23P01 at the insert whenever the locking
-- transaction rolled back, a failure the original slot-only sweep
-- (which waited) did not have.
--
-- Unchanged on purpose: signature, SECURITY DEFINER, empty
-- search_path, lock order (user -> slot -> entry row; no new lock),
-- validation, hold cap, insert, waitlist bookkeeping, error
-- handling and grants. bookings_no_facility_overlap and
-- bookings_no_overlap are not touched.
--
-- Rollback: re-apply the create_booking definition from
-- 20261014190100_expire_stale_holds_per_facility.sql.
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
  v_live_holds integer;
  c_max_live_holds constant integer := 3;
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
  -- 2c. Serialise this user's own booking and waitlist actions
  --
  -- The per-slot advisory lock below cannot enforce a per-user
  -- cap: two concurrent bookings by the same user on different
  -- slots take different slot locks, both count the same
  -- holds, and both insert. This lock is keyed by the caller's
  -- own id (never anyone else's), so it only ever makes a user
  -- wait for their own other request.
  --
  -- LOCK ORDER, everywhere:  user lock -> slot lock -> entry row
  -- ----------------------------------------------------------

  perform pg_advisory_xact_lock(
    hashtextextended('user-actions:' || v_user_id::text, 0)
  );


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
  --
  -- Only holds that could actually refuse THIS booking are
  -- considered: same facility and date, and a snapshot that
  -- overlaps the requested slot's interval (half-open, like
  -- bookings_no_facility_overlap). A pending_payment row stays in
  -- that constraint until its status changes, so an
  -- expired-but-unswept hold would otherwise refuse the booking
  -- until the next scheduled run.
  --
  -- The sweep WAITS for a row that another transaction holds
  -- locked (no SKIP LOCKED). Under READ COMMITTED PostgreSQL then
  -- re-checks the row against the same conditions:
  --
  --   * the other transaction committed the expiry: the row no
  --     longer qualifies and is left alone;
  --   * the other transaction rolled back: the row is still stale,
  --     and this sweep expires it itself;
  --   * the other transaction made the row something else (for
  --     example confirmed): it no longer qualifies, and the
  --     insert below is refused by the exclusion constraint.
  --
  -- This is the same wait-and-re-evaluate behaviour the slot-only
  -- sweep had before facility-wide sweeping was introduced. SKIP
  -- LOCKED made the request skip such a row and then fail at the
  -- insert (23P01) when the other transaction rolled back.
  --
  -- ORDER BY x.id makes every sweeper lock rows in the same
  -- order, so two sweeps over several rows queue instead of
  -- deadlocking. The expiry job and process_waitlist() never wait
  -- for anything a booking holds (SKIP LOCKED / try-locks), and
  -- bookings only wait for rows locked by earlier transactions,
  -- so no wait cycle exists. No new advisory lock is needed: the
  -- exclusion constraint remains the final integrity boundary.
  -- ----------------------------------------------------------

  update public.bookings b
  set
    status = 'expired',
    updated_at = now()
  where b.id in (
    select x.id
    from public.bookings x
    where x.facility_id = p_facility_id
      and x.booking_date = p_booking_date
      and x.status = 'pending_payment'
      and x.expires_at <= now()
      and x.start_time < v_slot_end
      and v_slot_start < x.end_time
    order by x.id
    for update
  );


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
  -- 6c. Cap on live unpaid holds
  --
  -- A user may hold at most c_max_live_holds pending_payment
  -- bookings whose hold is still running. Counted by the clock
  -- (expires_at > now()), not by status alone, so an expired
  -- hold the sweep has not reached yet does not use capacity.
  -- Confirmed, completed, cancelled and expired bookings never
  -- count.
  --
  -- A user holding a live waitlist offer for THIS slot and date
  -- is exempt: the offer is a server-issued entitlement to book
  -- exactly this slot, and refusing it would strand them while
  -- their offer runs out. Offers are bounded by the waitlist
  -- cap, so the total stays finite.
  --
  -- Precedence: a slot held for ANOTHER user's waitlist offer
  -- (6b) is reported before the cap. A slot that is simply
  -- booked is only detected by the exclusion constraint at the
  -- insert below, which runs after this check, so a user who is
  -- at the cap gets the cap error for it. That is intended: at
  -- the cap no booking could succeed, and the cap message is
  -- the actionable one.
  -- ----------------------------------------------------------

  if not exists (
    select 1
    from public.waitlist_entries w
    where w.user_id = v_user_id
      and w.slot_id = p_slot_id
      and w.booking_date = p_booking_date
      and w.status = 'offered'
      and w.offer_expires_at > now()
  ) then

    select count(*)::integer
    into v_live_holds
    from public.bookings b
    where b.user_id = v_user_id
      and b.status = 'pending_payment'
      and b.expires_at > now();

    if v_live_holds >= c_max_live_holds then
      raise exception
        using
          errcode = 'UB001',
          message = 'You already have the maximum number of unpaid bookings held (3). Complete payment or wait for one to expire.';
    end if;

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
