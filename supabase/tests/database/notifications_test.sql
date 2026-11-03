begin;

select plan(56);

-- ============================================================
-- In-app notifications
--
-- Users (f1000000-0000-0000-0000-00000000000N)
--   01 PLAYER   02 OTHER   03 OWNER of the venue   04 ADMIN   05 CREATOR
-- Everything is rolled back. No trigger is disabled; the admin is made
-- by deleting the fresh profile and inserting one with role 'admin'.
-- ============================================================

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
select ('f1000000-0000-0000-0000-00000000000' || n)::uuid,
       'notif-user' || n || '@example.com', '', now(), jsonb_build_object('full_name', 'Notif User ' || n)
from generate_series(1, 5) n;

delete from public.profiles where id = 'f1000000-0000-0000-0000-000000000004';
insert into public.profiles (id, full_name, role) values ('f1000000-0000-0000-0000-000000000004', 'Notif Admin', 'admin');

insert into public.facilities (id, owner_id, name, sport, address, city, status, base_price)
values ('f2000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000003',
        'Notif Court', 'Badminton', '1 Road', 'Notiftown', 'pending', 500);

insert into public.facility_slots (id, facility_id, start_time, end_time, duration_min, base_price, is_active)
values ('f3000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', '18:00', '19:00', 60, 500, true);

insert into public.bookings (id, user_id, facility_id, slot_id, booking_date, start_time, end_time, amount, status, payment_status, expires_at)
values
  ('f4000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001',
   'f3000000-0000-0000-0000-000000000001', current_date + 3, '18:00', '19:00', 500, 'pending_payment', 'pending', now() + interval '1 hour'),
  ('f4000000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001',
   'f3000000-0000-0000-0000-000000000001', current_date + 4, '18:00', '19:00', 500, 'pending_payment', 'pending', now() + interval '1 hour');

insert into public.waitlist_entries (id, user_id, facility_id, slot_id, booking_date)
values
  ('f5000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000002', 'f2000000-0000-0000-0000-000000000001',
   'f3000000-0000-0000-0000-000000000001', current_date + 5),
  ('f5000000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000002', 'f2000000-0000-0000-0000-000000000001',
   'f3000000-0000-0000-0000-000000000001', current_date + 6);

create function pg_temp.as_user(n integer) returns void language sql as $$
  select set_config('request.jwt.claim.sub', ('f1000000-0000-0000-0000-00000000000' || n)::text, true);
$$;
create function pg_temp.as_nobody() returns void language sql as $$
  select set_config('request.jwt.claim.sub', '', true);
$$;
create function pg_temp.u(n integer) returns uuid language sql as $$
  select ('f1000000-0000-0000-0000-00000000000' || n)::uuid;
$$;
create function pg_temp.n(p_user integer, p_kind text) returns integer language sql as $$
  select count(*)::int from public.notifications where user_id = pg_temp.u(p_user) and kind = p_kind;
$$;
create function pg_temp.total(p_user integer) returns integer language sql as $$
  select count(*)::int from public.notifications where user_id = pg_temp.u(p_user);
$$;
create temp table ids (k text primary key, v uuid) on commit drop;

-- ------------------------------------------------------------
-- Catalog and privileges
-- ------------------------------------------------------------

select is((select relrowsecurity from pg_class where oid = 'public.notifications'::regclass), true, 'row level security is on');
select is(
  (select count(*)::int from (values ('anon'),('authenticated')) r(role_name)
   cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(priv)
   where has_table_privilege(r.role_name, 'public.notifications', p.priv)),
  0, 'no client role holds any privilege on the table'
);
select is((select count(*)::int from pg_policy where polrelid = 'public.notifications'::regclass), 0, 'there are no policies: everything goes through the functions');
select is(
  (select count(*)::int from (values ('anon'),('authenticated'),('service_role')) r(role_name)
   where has_function_privilege(r.role_name, 'public.notify_user(uuid,text,jsonb,text)', 'EXECUTE')),
  0, 'no role can call notify_user directly'
);
select is(
  (select count(*)::int from (values ('notify_on_waitlist_offer'),('notify_on_booking_end'),('notify_on_facility_decision'),
                                     ('notify_on_group_decision'),('notify_on_event_decision')) f(n)
   join pg_proc p on p.proname = f.n and p.pronamespace = 'public'::regnamespace
   where has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE')),
  0, 'the trigger functions are not executable by clients'
);
select ok(
  not has_function_privilege('authenticated', 'public.notify_expiring_offers()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.notify_expiring_offers()', 'EXECUTE')
  and has_function_privilege('service_role', 'public.notify_expiring_offers()', 'EXECUTE'),
  'only the service role can run the expiring-offers job'
);
select ok(
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
   from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('notify_user','notify_expiring_offers','get_my_notifications','mark_notifications_read')),
  'the functions are SECURITY DEFINER with an empty search_path'
);
select throws_ok($$insert into public.notifications (user_id, kind, dedupe_key) values (pg_temp.u(1), 'made_up', 'x')$$, '23514', null, 'an unknown kind is refused by the table');

select pg_temp.as_nobody();
select throws_ok($$select * from public.get_my_notifications()$$, '28000', null, 'reading: signed out is refused');
select throws_ok($$select public.mark_notifications_read()$$, '28000', null, 'marking: signed out is refused');
select pg_temp.as_user(1);

-- ------------------------------------------------------------
-- Booking cancelled (by the person, through cancel_booking)
-- ------------------------------------------------------------

select is(pg_temp.total(1), 0, 'nothing exists before any event');
select public.cancel_booking('f4000000-0000-0000-0000-000000000001');
select is(pg_temp.n(1, 'booking_cancelled'), 1, 'cancelling a hold notifies its owner once');
select is(
  (select payload->>'facility_name' || ' ' || (payload->>'start_time') from public.notifications where user_id = pg_temp.u(1) and kind = 'booking_cancelled'),
  'Notif Court 18:00', 'the payload names the venue and the start time'
);
select public.cancel_booking('f4000000-0000-0000-0000-000000000001');
select is(pg_temp.n(1, 'booking_cancelled'), 1, 'cancelling again changes nothing and adds nothing');
select is(pg_temp.total(2) + pg_temp.total(3) + pg_temp.total(4), 0, 'nobody else was notified');

-- ------------------------------------------------------------
-- Hold expired (by the sweeper)
-- ------------------------------------------------------------

reset role;
update public.bookings set expires_at = now() - interval '1 minute' where id = 'f4000000-0000-0000-0000-000000000002';
select public.expire_pending_bookings();
select is(pg_temp.n(1, 'hold_expired'), 1, 'an expired hold notifies its owner once');
select public.expire_pending_bookings();
select is(pg_temp.n(1, 'hold_expired'), 1, 'a second sweep adds nothing');
select is((select status::text from public.bookings where id = 'f4000000-0000-0000-0000-000000000002'), 'expired', 'the booking itself is expired');

-- ------------------------------------------------------------
-- Waitlist offer issued, then expiring
-- ------------------------------------------------------------

update public.waitlist_entries
set status = 'offered', offered_at = now(), offer_expires_at = now() + interval '10 minutes'
where id = 'f5000000-0000-0000-0000-000000000001';
select is(pg_temp.n(2, 'offer_issued'), 1, 'an offer notifies the person it was made to');
select is(
  (select (payload->>'entry_id')::uuid from public.notifications where user_id = pg_temp.u(2) and kind = 'offer_issued'),
  'f5000000-0000-0000-0000-000000000001'::uuid, 'and points at the entry'
);
select is(public.notify_expiring_offers(), 0, 'an offer with 10 minutes left is not "expiring" yet');
select is(pg_temp.n(2, 'offer_expiring'), 0, 'no expiring notification yet');

update public.waitlist_entries set offer_expires_at = now() + interval '3 minutes' where id = 'f5000000-0000-0000-0000-000000000001';
select is(public.notify_expiring_offers(), 1, 'with 3 minutes left the job notifies');
select is(public.notify_expiring_offers(), 0, 'running the job again notifies nobody twice');
select is(pg_temp.n(2, 'offer_expiring'), 1, 'exactly one expiring notification');
select is(pg_temp.n(2, 'offer_issued'), 1, 'and still exactly one issued notification');

update public.waitlist_entries set status = 'expired' where id = 'f5000000-0000-0000-0000-000000000001';
select is(pg_temp.total(2), 2, 'expiring an offer adds no notification of its own');

update public.waitlist_entries set status = 'offered', offered_at = now() - interval '15 minutes', offer_expires_at = now() - interval '1 minute'
where id = 'f5000000-0000-0000-0000-000000000002';
select is(public.notify_expiring_offers(), 0, 'an expired offer never produces an expiring notification');

-- ------------------------------------------------------------
-- Venue decisions (through the admin function)
-- ------------------------------------------------------------

select pg_temp.as_user(4);
select public.admin_set_facility_status('f2000000-0000-0000-0000-000000000001', 'active');
select is(pg_temp.n(3, 'facility_approved'), 1, 'approving a venue notifies its owner');
select public.admin_set_facility_status('f2000000-0000-0000-0000-000000000001', 'active');
select is(pg_temp.n(3, 'facility_approved'), 1, 'approving again adds nothing');
select public.admin_set_facility_status('f2000000-0000-0000-0000-000000000001', 'suspended');
select is(pg_temp.n(3, 'facility_suspended'), 1, 'suspending notifies the owner');
select public.admin_set_facility_status('f2000000-0000-0000-0000-000000000001', 'active');
select is(pg_temp.n(3, 'facility_approved'), 2, 'reactivating notifies again (a new event)');
select public.admin_set_facility_status('f2000000-0000-0000-0000-000000000001', 'rejected');
select is(pg_temp.n(3, 'facility_rejected'), 1, 'rejecting notifies the owner');
select public.admin_set_facility_status('f2000000-0000-0000-0000-000000000001', 'pending');
select is(pg_temp.total(3), 4, 'moving back to pending notifies nobody');
select is(pg_temp.total(4), 0, 'the administrator is not notified of their own action');
select public.admin_set_facility_status('f2000000-0000-0000-0000-000000000001', 'active');

-- ------------------------------------------------------------
-- Community decisions (through the admin functions)
-- ------------------------------------------------------------

select pg_temp.as_user(5);
insert into ids select 'g', public.create_group('Notif Club', 'Badminton', 'Notiftown');
select is(pg_temp.total(5), 0, 'creating a group notifies nobody');

select pg_temp.as_user(4);
select public.admin_set_group_status((select v from ids where k = 'g'), 'approved');
select is(pg_temp.n(5, 'group_approved'), 1, 'approving a group notifies its creator');
select public.admin_set_group_status((select v from ids where k = 'g'), 'approved');
select is(pg_temp.n(5, 'group_approved'), 1, 'approving again adds nothing');

select pg_temp.as_user(5);
insert into ids select 'e', public.create_event((select v from ids where k = 'g'), 'Notif Event', current_date + 7, '18:00', 'f2000000-0000-0000-0000-000000000001');
select pg_temp.as_user(4);
select public.admin_set_event_status((select v from ids where k = 'e'), 'approved');
select is(pg_temp.n(5, 'event_approved'), 1, 'approving an event notifies its creator');
select public.admin_set_event_status((select v from ids where k = 'e'), 'rejected');
select is(pg_temp.n(5, 'event_rejected'), 1, 'rejecting it later notifies again');
select public.admin_set_group_status((select v from ids where k = 'g'), 'rejected');
select is(pg_temp.n(5, 'group_rejected'), 1, 'rejecting the group notifies its creator');
select is(pg_temp.total(5), 4, 'the creator has exactly the four decision notifications');

-- ------------------------------------------------------------
-- Reading and marking
-- ------------------------------------------------------------

select pg_temp.as_user(5);
select is((select count(*)::int from public.get_my_notifications()), 4, 'a person reads their own notifications');
select is((select max(unread_count) from public.get_my_notifications()), 4, 'and the unread count');
select is((select count(*)::int from public.get_my_notifications(2)), 2, 'the limit is honoured');
select is((select count(*)::int from public.get_my_notifications(0)), 1, 'a limit below 1 is clamped to 1');
select is((select count(*)::int from public.get_my_notifications() where kind like 'offer%' or kind like 'booking%'), 0, 'none of another person''s notifications appear');

select pg_temp.as_user(1);
select is((select count(*)::int from public.get_my_notifications()), 2, 'the player sees only theirs (cancelled and expired)');
insert into ids select 'first', id from public.get_my_notifications() limit 1;

select pg_temp.as_user(5);
select is(public.mark_notifications_read(array[(select v from ids where k = 'first')]), 0, 'marking another person''s notification marks nothing');
select pg_temp.as_user(1);
select is((select count(*)::int from public.notifications where user_id = pg_temp.u(1) and read_at is null), 2, 'and it stays unread for its owner');
select is(public.mark_notifications_read(array[(select v from ids where k = 'first')]), 1, 'a person marks their own as read');
select is((select max(unread_count) from public.get_my_notifications()), 1, 'the unread count drops');
select is(public.mark_notifications_read(array[(select v from ids where k = 'first')]), 0, 'marking again changes nothing');
select is(public.mark_notifications_read(), 1, 'with no ids, everything of theirs is marked');
select is((select max(unread_count) from public.get_my_notifications()), 0, 'nothing is unread any more');
select pg_temp.as_user(5);
select is((select max(unread_count) from public.get_my_notifications()), 4, 'another person''s unread count is untouched');

select * from finish();
rollback;
