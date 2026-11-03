-- ============================================================
-- UniSport — nightly tidy-up for the public demo site
-- ============================================================
--
-- Run once by the project owner in the hosted project's SQL editor, after
-- seed_demo.sql. It installs one function and one pg_cron job that keep a
-- public demo presentable:
--
--   * keep the sample event in the future;
--   * remove communities visitors created, after 7 days;
--   * remove pending or rejected venues other than the samples, after 7 days,
--     unless something references them;
--   * remove finished waitlist entries, old notifications, and expired or
--     cancelled unpaid bookings with no payment record, after 14 days.
--
-- Sample rows (ids starting de) and anything with a payment record are never
-- removed. Confirmed bookings are never removed. No client can run it.
--
-- Not a migration, on purpose: deleting visitors' data suits only the demo.
-- To remove:  select cron.unschedule('demo-nightly-cleanup');
--             drop function public.demo_nightly_cleanup();
-- ============================================================

create or replace function public.demo_nightly_cleanup()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin

  update public.community_events e
  set event_date = current_date + 7
  where e.id = 'de400000-0000-4000-8000-000000000001'
    and e.event_date < current_date + 3;

  delete from public.community_groups g
  where g.id::text not like 'de300000-%'
    and g.created_at < now() - interval '7 days';

  delete from public.facilities f
  where f.id::text not like 'de100000-%'
    and f.status in ('pending', 'rejected')
    and f.created_at < now() - interval '7 days'
    and not exists (select 1 from public.bookings b where b.facility_id = f.id)
    and not exists (select 1 from public.waitlist_entries w where w.facility_id = f.id)
    and not exists (select 1 from public.community_events e where e.facility_id = f.id);

  delete from public.waitlist_entries w
  where w.status in ('accepted', 'expired', 'cancelled')
    and w.updated_at < now() - interval '14 days';

  delete from public.notifications n
  where n.created_at < now() - interval '14 days';

  delete from public.bookings b
  where b.status in ('expired', 'cancelled')
    and b.payment_status = 'pending'
    and b.created_at < now() - interval '14 days'
    and not exists (select 1 from public.payments p where p.booking_id = b.id)
    and not exists (select 1 from public.payment_attempts a where a.booking_id = b.id)
    and not exists (select 1 from public.waitlist_entries w where w.booking_id = b.id);

end;
$$;

revoke all on function public.demo_nightly_cleanup() from public, anon, authenticated;

select cron.schedule('demo-nightly-cleanup', '0 21 * * *', 'select public.demo_nightly_cleanup()');
