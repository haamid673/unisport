-- ============================================================
-- UniSport — Migration 007: Expire unpaid bookings
-- ============================================================


-- ============================================================
-- Expire pending-payment bookings
--
-- create_booking() only expires stale reservations for the
-- slot and date being booked. This function expires them
-- globally so booking state stays accurate for everything
-- else that reads it (dashboards, "my bookings", reports,
-- and the future waitlist).
--
-- Intended callers: pg_cron (as the function owner) and
-- trusted server-side code (service_role). It is not a client
-- API.
--
-- Properties:
--   * Idempotent. Only pending_payment rows are matched, so a
--     second run finds nothing new and writes nothing.
--   * Concurrency-safe. Candidate rows are claimed with
--     FOR UPDATE SKIP LOCKED:
--       - two overlapping runs never block each other and
--         never expire (or count) the same row twice;
--       - a row currently locked by create_booking() or a
--         payment confirmation is skipped instead of waited
--         on, and is picked up on the next run;
--       - the function never waits on a lock, so it cannot
--         take part in a deadlock.
--   * Narrow locking. Only rows that are actually due are
--     locked; the partial index bookings_expiry_idx
--     (expires_at) WHERE status = 'pending_payment' makes
--     finding them cheap.
--   * Because the status is re-checked after the row lock is
--     acquired, a booking confirmed just before this runs is
--     never expired.
--
-- Returns the number of bookings expired by this call.
-- ============================================================

create or replace function public.expire_pending_bookings()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expired_count integer;
begin

  with due as (
    select b.id
    from public.bookings b
    where b.status = 'pending_payment'
      and b.expires_at <= now()
    for update skip locked
  ),
  expired as (
    update public.bookings b
    set
      status = 'expired',
      updated_at = now()
    from due
    where b.id = due.id
    returning b.id
  )
  select count(*)::integer
  into v_expired_count
  from expired;

  return v_expired_count;

end;
$$;


-- ============================================================
-- Function privileges
--
-- Supabase's default privileges grant EXECUTE on new public
-- functions to anon, authenticated and service_role, and
-- PostgreSQL grants it to PUBLIC. Remove everything the
-- clients could reach.
--
-- service_role is kept deliberately: it is a trusted
-- server-side credential, and gives backend code (or an
-- operator) a way to run the expiry manually or from a
-- scheduled Edge Function in environments without pg_cron.
-- ============================================================

revoke execute
on function public.expire_pending_bookings()
from public;

revoke execute
on function public.expire_pending_bookings()
from anon;

revoke execute
on function public.expire_pending_bookings()
from authenticated;

grant execute
on function public.expire_pending_bookings()
to service_role;
