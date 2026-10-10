-- ============================================================
-- UniSport — Migration 012: Schedule waitlist processing
-- ============================================================


-- ============================================================
-- Run public.process_waitlist() once per minute.
--
-- process_waitlist() expires unpaid bookings, lapses stale
-- offers and issues offers for freed slots, so a freed slot
-- reaches the next user within about a minute.
--
-- Same guarded approach as the booking-expiration schedule:
-- if pg_cron is unusable here, log a WARNING and leave the
-- function unscheduled instead of failing the deploy. Without
-- the job, offers are never issued automatically (but no
-- booking is ever affected); call process_waitlist() from
-- another scheduler as service_role.
--
-- cron.schedule() upserts by job name, so re-running is safe.
--
-- To remove the job:
--   select cron.unschedule('process-waitlist');
-- ============================================================

do $$
declare
  v_job_name constant text := 'process-waitlist';
begin

  if not exists (
    select 1
    from pg_available_extensions
    where name = 'pg_cron'
  ) then
    raise warning
      'pg_cron is not available in this PostgreSQL installation; '
      '% was NOT scheduled. Run public.process_waitlist() '
      'from another scheduler.', v_job_name;
    return;
  end if;

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
    'select public.process_waitlist()'
  );

end;
$$;
