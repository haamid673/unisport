-- ============================================================
-- UniSport — Follow-up to 20261016190000 (slot time freeze)
-- ============================================================
--
-- Three narrow corrections found in review of the slot time
-- freeze. 20261016190000 is left untouched; the objects below are
-- replaced in place.
--
--   1. The freeze decided "has this interval ended?" with
--      localtimestamp, i.e. the transaction start time in the
--      SESSION time zone. A client can set that per request
--      (PostgREST accepts "Prefer: timezone=<zone>"), so an owner
--      could send Pacific/Kiritimati (UTC+14) and make a booking
--      that ends within the next 14 hours look finished, lifting
--      the freeze.
--
--      Both predicates now compare with
--
--          timezone('UTC', now())
--
--      which is a timestamp WITHOUT time zone holding the current
--      UTC wall-clock. That is the application's convention:
--      booking_date and the time columns are naive and are read as
--      UTC (see 20261016190000). timezone('UTC', timestamptz) is
--      independent of the session TimeZone setting.
--
--      Unchanged: the pending-payment and offered-entry checks
--      (expires_at > now(), offer_expires_at > now()) compare
--      timestamptz values and were never zone dependent; the
--      statuses considered live; the booking/entry date + time
--      arithmetic. create_booking()'s and the other functions'
--      current_date logic is outside this migration.
--
--   2. The error hint suggested deactivating the slot and creating
--      a new one at the new time. Inactive slots still take part in
--      facility_slots_no_overlap, and a slot that bookings or
--      waitlist entries reference cannot be deleted, so that route
--      is not generally available. The hint now only describes the
--      path that always works: wait until the live references have
--      ended or expired, then change the times.
--
--   3. join_waitlist() validated the slot (exists, belongs to the
--      facility, is_active, operating hours) from an unlocked read
--      and inserted the entry afterwards. A slot edit committing in
--      between left an entry that was validated against the old
--      definition but attached to the new one. The slot select is
--      now FOR SHARE, exactly like create_booking(), and nothing
--      else in the function changes:
--
--        join first -> a time/price/active edit waits for the join
--                      to finish and is then rejected (time edit)
--                      if the committed entry is still live;
--        edit first -> the join waits for the edit and validates
--                      against the NEW definition.
--
--      Lock order is unchanged: user advisory lock, then the slot
--      row. join_waitlist() takes no slot/date advisory lock, so
--      there is no new ordering between locks. FOR SHARE locks do
--      not conflict with each other, so concurrent joins and
--      bookings of one slot are not serialised by it.
--
-- Rollback:
--   re-apply prevent_live_slot_time_change() from
--   20261016190000_freeze_slot_times_with_live_references.sql and
--   join_waitlist() from 20261010180900_per_user_booking_limits.sql.
-- ============================================================


-- ============================================================
-- 1 + 2. prevent_live_slot_time_change(): UTC clock, corrected hint
-- ============================================================

create or replace function public.prevent_live_slot_time_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin

  -- Serialise with in-flight bookings / entries of this slot (see
  -- 20261016190000), then look at what is committed.
  perform 1
  from public.facility_slots fs
  where fs.id = OLD.id
  for update;

  -- "Now" as a naive UTC timestamp, comparable with
  -- booking_date + <time>. NOT localtimestamp: that follows the
  -- session TimeZone, which a client can set.
  if exists (
    select 1
    from public.bookings b
    where b.slot_id = OLD.id
      and (
        b.status in ('confirmed', 'completed')
        or (b.status = 'pending_payment' and b.expires_at > now())
      )
      and b.booking_date + b.end_time > timezone('UTC', now())
  )
  or exists (
    select 1
    from public.waitlist_entries w
    where w.slot_id = OLD.id
      and (
        w.status = 'waiting'
        or (w.status = 'offered' and w.offer_expires_at > now())
      )
      and w.booking_date + OLD.end_time > timezone('UTC', now())
  ) then
    raise exception
      using
        errcode = '23514',
        message = 'facility_slots start_time/end_time cannot be changed while the slot has live bookings or waitlist entries',
        hint = 'Wait until the live bookings and waitlist entries for this slot have ended or expired, then change its times.';
  end if;

  return new;

end;
$$;

-- CREATE OR REPLACE keeps the existing ACL; restated so this file is
-- self-describing.
revoke execute on function public.prevent_live_slot_time_change()
  from public, anon, authenticated;


-- ============================================================
-- 3. join_waitlist(): lock the slot row FOR SHARE
-- (definition of 20261010180900_per_user_booking_limits.sql;
-- the slot select below is the only change)
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
  v_active_entries integer;
  c_max_active_entries constant integer := 10;
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

  -- Serialise this user's own booking and waitlist actions, so
  -- the entry cap below cannot be beaten by concurrent joins on
  -- different slots. Lock order everywhere:
  --   user lock -> slot lock -> entry row
  perform pg_advisory_xact_lock(
    hashtextextended('user-actions:' || v_user_id::text, 0)
  );

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

  -- Slot. Read FOR SHARE and held until this transaction ends: an
  -- owner's edit of the slot (prevent_live_slot_time_change() locks
  -- the row before it looks for live entries) must wait for this
  -- join to finish, and a join that starts after an edit re-reads
  -- the committed definition instead of validating a stale one.
  -- FOR SHARE locks do not conflict with each other.
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
  where fs.id = p_slot_id
  for share;

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

  -- Already queued for this slot and date. Same predicate as
  -- the waitlist_one_active_entry_per_user index, checked before
  -- the cap so a duplicate keeps reporting "already on the
  -- waitlist" rather than "too many waitlists".
  if exists (
    select 1
    from public.waitlist_entries w
    where w.user_id = v_user_id
      and w.slot_id = p_slot_id
      and w.booking_date = p_booking_date
      and w.status in ('waiting', 'offered')
  ) then
    raise exception
      using
        errcode = '23505',
        message = 'You are already on the waitlist for this slot and date';
  end if;

  -- Cap on active entries. Counted by the clock, so entries that
  -- no longer have a future are not counted even before the
  -- cleanup job reaches them:
  --   * waiting  -> only while the booking date has not passed
  --   * offered  -> only while the offer window is still open
  -- accepted, cancelled and expired entries never count.
  select count(*)::integer
  into v_active_entries
  from public.waitlist_entries w
  where w.user_id = v_user_id
    and (
      (w.status = 'waiting' and w.booking_date >= current_date)
      or (w.status = 'offered' and w.offer_expires_at > now())
    );

  if v_active_entries >= c_max_active_entries then
    raise exception
      using
        errcode = 'UB002',
        message = 'You are already on the maximum number of waitlists (10). Leave one to join another.';
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

