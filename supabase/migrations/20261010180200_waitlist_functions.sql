-- ============================================================
-- UniSport — Migration 011: Waitlist functions
-- ============================================================
--
-- Client-callable (authenticated):
--   join_waitlist(facility, slot, date)
--   leave_waitlist(entry)
--   accept_waitlist_offer(entry)
--
-- Backend only (postgres / pg_cron, service_role):
--   offer_next_waitlist_entry(slot, date)
--   expire_waitlist_offers()
--   process_waitlist()
--
-- All are SECURITY DEFINER with search_path = '' because the
-- table has no write policies. Every one of them derives the
-- acting user from auth.uid(); no function accepts a user id,
-- status, price or queue position from the client.
--
-- Concurrency model (offers):
--   * pg_try_advisory_xact_lock per (slot, date) serialises
--     offer decisions without ever waiting, so workers cannot
--     deadlock; a worker that loses the lock simply returns
--     and the next tick retries.
--   * waitlist_one_offer_per_slot_date (partial unique index)
--     guarantees at most one offered entry per slot and date
--     even if the lock were bypassed.
--   * Candidate rows are claimed FOR UPDATE SKIP LOCKED.
--   * create_booking() refuses other users while an offer is
--     live, and the bookings exclusion constraint remains the
--     final authority on availability.
-- ============================================================


-- ============================================================
-- 1. Join a waitlist
--
-- Product rule: a waitlist exists for slots that cannot be
-- booked. If the slot is currently bookable the user is told
-- to book it directly, instead of queueing behind nobody and
-- waiting for a worker tick.
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


-- ============================================================
-- 2. Offer the slot to the next user in line
--
-- Backend only. Returns the id of the entry that was offered
-- the slot, or null when no offer was issued (no one waiting,
-- an offer is already live, the slot is still booked, the
-- facility or slot is inactive, the date has passed, or
-- another worker is deciding for the same slot).
-- ============================================================

create or replace function public.offer_next_waitlist_entry(
  p_slot_id uuid,
  p_booking_date date
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry_id uuid;
begin

  if p_booking_date < current_date then
    return null;
  end if;

  -- One decision-maker per slot and date. Never waits.
  if not pg_try_advisory_xact_lock(
    hashtextextended(p_slot_id::text || ':' || p_booking_date::text, 0)
  ) then
    return null;
  end if;

  -- Lapse stale offers for this slot and date so they are
  -- never considered live and never block the next offer.
  with stale as (
    select w.id
    from public.waitlist_entries w
    where w.slot_id = p_slot_id
      and w.booking_date = p_booking_date
      and w.status = 'offered'
      and w.offer_expires_at <= now()
    for update skip locked
  )
  update public.waitlist_entries w
  set status = 'expired'
  from stale
  where w.id = stale.id;

  -- An offer is already outstanding.
  if exists (
    select 1
    from public.waitlist_entries w
    where w.slot_id = p_slot_id
      and w.booking_date = p_booking_date
      and w.status = 'offered'
  ) then
    return null;
  end if;

  -- A booking still occupies the slot.
  if exists (
    select 1
    from public.bookings b
    where b.slot_id = p_slot_id
      and b.booking_date = p_booking_date
      and (
        b.status in ('confirmed', 'completed')
        or (b.status = 'pending_payment' and b.expires_at > now())
      )
  ) then
    return null;
  end if;

  -- The slot must still be bookable at all.
  if not exists (
    select 1
    from public.facility_slots fs
    join public.facilities f
      on f.id = fs.facility_id
    where fs.id = p_slot_id
      and fs.is_active
      and f.status = 'active'
  ) then
    return null;
  end if;

  -- Next in line: lowest queue_position among waiting entries.
  -- Rows locked by a concurrent leave/accept are skipped.
  select w.id
  into v_entry_id
  from public.waitlist_entries w
  where w.slot_id = p_slot_id
    and w.booking_date = p_booking_date
    and w.status = 'waiting'
  order by w.queue_position
  limit 1
  for update skip locked;

  if v_entry_id is null then
    return null;
  end if;

  begin
    update public.waitlist_entries w
    set
      status = 'offered',
      offered_at = now(),
      offer_expires_at = now() + interval '15 minutes'
    where w.id = v_entry_id;
  exception
    when unique_violation then
      -- waitlist_one_offer_per_slot_date: someone else's offer
      -- is outstanding. Treat as "no offer issued".
      return null;
  end;

  return v_entry_id;

end;
$$;


-- ============================================================
-- 3. Leave a waitlist / decline an offer
--
-- Owner only. A waiting entry is cancelled. An entry holding
-- an offer is cancelled too, which declines the offer, and the
-- slot is passed to the next user in line immediately.
-- Calling it again on a finished entry is a harmless no-op.
-- An accepted entry cannot be left; the user has a booking,
-- which is cancelled through the booking flow instead.
-- ============================================================

create or replace function public.leave_waitlist(
  p_entry_id uuid
)
returns public.waitlist_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_entry public.waitlist_entries;
begin

  v_user_id := (select auth.uid());

  if v_user_id is null then
    raise exception
      using
        errcode = '28000',
        message = 'Authentication required';
  end if;

  -- Another user's entry is indistinguishable from a missing one.
  select w.*
  into v_entry
  from public.waitlist_entries w
  where w.id = p_entry_id
    and w.user_id = v_user_id
  for update;

  if not found then
    raise exception
      using
        errcode = 'P0002',
        message = 'Waitlist entry not found';
  end if;

  if v_entry.status = 'accepted' then
    raise exception
      using
        errcode = 'P0001',
        message = 'Offer already accepted; cancel the booking instead';
  end if;

  if v_entry.status in ('expired', 'cancelled') then
    return v_entry.status;
  end if;

  update public.waitlist_entries w
  set status = 'cancelled'
  where w.id = v_entry.id;

  if v_entry.status = 'offered' then
    perform public.offer_next_waitlist_entry(
      v_entry.slot_id,
      v_entry.booking_date
    );
  end if;

  return 'cancelled';

end;
$$;


-- ============================================================
-- 4. Accept an offer
--
-- Owner only. Accepting does not confirm or pay for anything:
-- it creates a pending_payment booking through the ordinary
-- create_booking() (same validation, same server-side price,
-- same 10-minute payment hold, same exclusion constraint),
-- which also links this entry to that booking.
--
-- The entry row is locked for the duration, and everything
-- happens in one transaction: if create_booking() raises for
-- any reason (slot taken, hours changed, ...) the whole call
-- rolls back and the entry is still a valid, unaccepted offer.
-- ============================================================

create or replace function public.accept_waitlist_offer(
  p_entry_id uuid
)
returns table (
  booking_id uuid,
  booking_amount numeric(10, 2),
  booking_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_entry public.waitlist_entries;
  v_booking_id uuid;
  v_amount numeric(10, 2);
  v_expires_at timestamptz;
  v_status public.waitlist_status;
begin

  v_user_id := (select auth.uid());

  if v_user_id is null then
    raise exception
      using
        errcode = '28000',
        message = 'Authentication required';
  end if;

  select w.*
  into v_entry
  from public.waitlist_entries w
  where w.id = p_entry_id
    and w.user_id = v_user_id
  for update;

  if not found then
    raise exception
      using
        errcode = 'P0002',
        message = 'Waitlist entry not found';
  end if;

  if v_entry.status <> 'offered' then
    raise exception
      using
        errcode = 'P0001',
        message = 'Waitlist offer is no longer valid';
  end if;

  if v_entry.offer_expires_at <= now() then
    raise exception
      using
        errcode = 'P0001',
        message = 'Waitlist offer has expired';
  end if;

  -- Existing booking safeguards. auth.uid() is unchanged by
  -- being called from here, so the booking is created for the
  -- signed-in user.
  select
    cb.booking_id,
    cb.booking_amount,
    cb.expires_at
  into
    v_booking_id,
    v_amount,
    v_expires_at
  from public.create_booking(
    v_entry.facility_id,
    v_entry.slot_id,
    v_entry.booking_date
  ) cb;

  -- create_booking() closes the caller's live offer. Verify,
  -- rather than assume, so this can never report success
  -- without the entry being linked to the booking.
  select w.status
  into v_status
  from public.waitlist_entries w
  where w.id = v_entry.id
    and w.booking_id = v_booking_id;

  if v_status is distinct from 'accepted' then
    raise exception
      using
        errcode = 'XX000',
        message = 'Waitlist entry was not linked to the booking';
  end if;

  booking_id := v_booking_id;
  booking_amount := v_amount;
  booking_expires_at := v_expires_at;

  return next;

end;
$$;


-- ============================================================
-- 5. Expire offers
--
-- Backend only. Lapses every offer whose window has closed so
-- it is no longer eligible. Rows locked by a concurrent accept
-- are skipped (the accept re-checks the window itself).
-- Idempotent; returns the number of offers expired.
-- ============================================================

create or replace function public.expire_waitlist_offers()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expired_count integer;
begin

  with stale as (
    select w.id
    from public.waitlist_entries w
    where w.status = 'offered'
      and w.offer_expires_at <= now()
    for update skip locked
  ),
  expired as (
    update public.waitlist_entries w
    set status = 'expired'
    from stale
    where w.id = stale.id
    returning w.id
  )
  select count(*)::integer
  into v_expired_count
  from expired;

  return v_expired_count;

end;
$$;


-- ============================================================
-- 6. Process the waitlist
--
-- Backend only; scheduled once per minute. In one pass:
--   1. expire unpaid bookings (frees slots immediately),
--   2. expire lapsed offers,
--   3. close waiting entries whose date has passed,
--   4. offer every slot/date that is now free to the next user.
--
-- Returns the number of offers issued. Safe to run repeatedly
-- and concurrently.
-- ============================================================

create or replace function public.process_waitlist()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_offers integer := 0;
  v_target record;
begin

  perform public.expire_pending_bookings();
  perform public.expire_waitlist_offers();

  with stale as (
    select w.id
    from public.waitlist_entries w
    where w.status = 'waiting'
      and w.booking_date < current_date
    for update skip locked
  )
  update public.waitlist_entries w
  set status = 'expired'
  from stale
  where w.id = stale.id;

  for v_target in
    select
      w.slot_id,
      w.booking_date
    from public.waitlist_entries w
    where w.status = 'waiting'
      and w.booking_date >= current_date
    group by w.slot_id, w.booking_date
    order by min(w.queue_position)
  loop
    if public.offer_next_waitlist_entry(
         v_target.slot_id,
         v_target.booking_date
       ) is not null then
      v_offers := v_offers + 1;
    end if;
  end loop;

  return v_offers;

end;
$$;


-- ============================================================
-- Function privileges
--
-- Remove the default grants (PUBLIC, anon, authenticated),
-- then grant narrowly.
-- ============================================================

revoke execute on function public.join_waitlist(uuid, uuid, date)
  from public, anon, authenticated;
revoke execute on function public.leave_waitlist(uuid)
  from public, anon, authenticated;
revoke execute on function public.accept_waitlist_offer(uuid)
  from public, anon, authenticated;
revoke execute on function public.offer_next_waitlist_entry(uuid, date)
  from public, anon, authenticated;
revoke execute on function public.expire_waitlist_offers()
  from public, anon, authenticated;
revoke execute on function public.process_waitlist()
  from public, anon, authenticated;

-- Client API
grant execute on function public.join_waitlist(uuid, uuid, date)
  to authenticated;
grant execute on function public.leave_waitlist(uuid)
  to authenticated;
grant execute on function public.accept_waitlist_offer(uuid)
  to authenticated;

-- Internal maintenance: function owner (pg_cron) and the
-- trusted service role only.
grant execute on function public.offer_next_waitlist_entry(uuid, date)
  to service_role;
grant execute on function public.expire_waitlist_offers()
  to service_role;
grant execute on function public.process_waitlist()
  to service_role;
