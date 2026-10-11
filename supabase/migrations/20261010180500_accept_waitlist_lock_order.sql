-- ============================================================
-- UniSport — Migration 014: Consistent lock order in accept
-- ============================================================


-- ============================================================
-- Deadlock fixed
--
-- Before this migration, for the SAME user and the SAME offer:
--
--   Y  create_booking()           X  accept_waitlist_offer()
--   -----------------------       --------------------------
--   advisory lock K  (slot/date)  FOR UPDATE on entry row E
--   insert booking                create_booking() ->
--   UPDATE entry E  <- waits X       advisory lock K <- waits Y
--
-- Y holds K and waits for E; X holds E and waits for K.
-- PostgreSQL aborted one of them with 40P01 after
-- deadlock_timeout (1s). The final state was consistent, but a
-- user could see a spurious error.
--
-- Fix: accept_waitlist_offer() takes K before E, matching
-- create_booking(). Every path that waits now acquires:
--
--   1. slot/date advisory lock
--   2. waitlist entry row
--
-- Paths that touch an entry row first (leave_waitlist) only TRY
-- the advisory lock afterwards, and the workers use try-lock and
-- SKIP LOCKED throughout, so none of them can complete a cycle.
--
-- Nothing else about acceptance changes: it is still one
-- transaction, still delegates to create_booking(), and a
-- failure still rolls everything back.
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
  v_slot_id uuid;
  v_booking_date date;
begin

  v_user_id := (select auth.uid());

  if v_user_id is null then
    raise exception
      using
        errcode = '28000',
        message = 'Authentication required';
  end if;

  -- Lock order: slot/date advisory lock first, then the entry row.
  --
  -- create_booking() takes the advisory lock and later updates
  -- the caller's entry row. If this function locked the entry
  -- row first and only then reached create_booking()'s advisory
  -- lock, a direct booking and an accept by the same user would
  -- acquire the two locks in opposite orders and deadlock.
  --
  -- slot_id and booking_date never change for an entry, so they
  -- can be read without a lock. Ownership, status and expiry
  -- are re-validated under the row lock below.
  select w.slot_id, w.booking_date
  into v_slot_id, v_booking_date
  from public.waitlist_entries w
  where w.id = p_entry_id
    and w.user_id = v_user_id;

  if not found then
    raise exception
      using
        errcode = 'P0002',
        message = 'Waitlist entry not found';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_slot_id::text || ':' || v_booking_date::text, 0)
  );

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
-- Function privileges (unchanged; restated for clarity)
-- ============================================================

revoke execute on function public.accept_waitlist_offer(uuid)
  from public, anon;

grant execute on function public.accept_waitlist_offer(uuid)
  to authenticated;
