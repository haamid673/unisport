-- ============================================================
-- UniSport — Migration 008: Schedule booking expiration
-- ============================================================


-- ============================================================
-- Run public.expire_pending_bookings() once per minute.
--
-- Uses pg_cron, which Supabase preloads and which can only
-- run jobs in the database named by cron.database_name
-- (normally "postgres").
--
-- This migration deliberately does not assume pg_cron is
-- usable. If the extension is unavailable, not preloaded, or
-- this is not the cron database, it logs a WARNING and leaves
-- the function unscheduled instead of failing every deploy.
-- Booking correctness does not depend on the job: the
-- exclusion constraint prevents double booking, and
-- create_booking() expires stale reservations for the slot
-- being booked. The job keeps booking *state* accurate
-- everywhere else.
--
-- Re-running is safe. cron.schedule() with a job name updates
-- the existing job in place, so resets and re-applied
-- migrations never create duplicates.
--
-- To remove the job:
--   select cron.unschedule('expire-pending-bookings');
-- ============================================================

do $$
declare
  v_job_name constant text := 'expire-pending-bookings';
begin

  if not exists (
    select 1
    from pg_available_extensions
    where name = 'pg_cron'
  ) then
    raise warning
      'pg_cron is not available in this PostgreSQL installation; '
      '% was NOT scheduled. Run public.expire_pending_bookings() '
      'from another scheduler.', v_job_name;
    return;
  end if;

  -- Null when the library is not preloaded (the GUC does not
  -- exist) or when pg_cron is configured for another database.
  if current_setting('cron.database_name', true)
       is distinct from current_database() then
    raise warning
      'pg_cron is not loaded for database "%" '
      '(cron.database_name = %); % was NOT scheduled.',
      current_database(),
      coalesce(current_setting('cron.database_name', true), '<unset>'),
      v_job_name;
    return;
  end if;

  create extension if not exists pg_cron;

  perform cron.schedule(
    v_job_name,
    '* * * * *',
    'select public.expire_pending_bookings()'
  );

end;
$$;
