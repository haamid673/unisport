begin;

select plan(108);

-- ============================================================
-- Community groups and events
--
-- Users (e1000000-0000-0000-0000-00000000000N)
--   01 CREATOR  02 MEMBER   03 THIRD    04 OUTSIDER
--   05 ADMIN (role admin)   09 OWNER of the venues
-- Venues (e2000000-...-00000000000N), owned by 09
--   01 active in Testville   02 active in Otherton
--   03 PENDING in Testville
-- Admin is made by deleting the fresh profile and inserting one with
-- role 'admin'; the role-protection trigger is never disabled.
-- Everything is rolled back.
-- ============================================================

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
select ('e1000000-0000-0000-0000-00000000000' || n)::uuid,
       'comm-user' || n || '@example.com', '', now(),
       jsonb_build_object('full_name', 'Comm User ' || n)
from unnest(array[1,2,3,4,5,9]) n;

delete from public.profiles where id = 'e1000000-0000-0000-0000-000000000005';
insert into public.profiles (id, full_name, role)
values ('e1000000-0000-0000-0000-000000000005', 'Comm Admin', 'admin');

insert into public.facilities (id, owner_id, name, sport, address, city, status, base_price) values
  ('e2000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000009', 'Test Court A',  'Badminton', '1 Road', 'Testville', 'active',  500),
  ('e2000000-0000-0000-0000-000000000002', 'e1000000-0000-0000-0000-000000000009', 'Other Court',   'Badminton', '2 Road', 'Otherton', 'active',  500),
  ('e2000000-0000-0000-0000-000000000003', 'e1000000-0000-0000-0000-000000000009', 'Pending Court', 'Badminton', '3 Road', 'Testville', 'pending', 500);

create temp table ids (k text primary key, v uuid) on commit drop;

create function pg_temp.as_user(n integer) returns void language sql as $$
  select set_config('request.jwt.claim.sub', ('e1000000-0000-0000-0000-00000000000' || n)::text, true);
$$;
create function pg_temp.as_nobody() returns void language sql as $$
  select set_config('request.jwt.claim.sub', '', true);
$$;
create function pg_temp.id(p_key text) returns uuid language sql as $$
  select v from ids where k = p_key;
$$;
create function pg_temp.fac(n integer) returns uuid language sql as $$
  select ('e2000000-0000-0000-0000-00000000000' || n)::uuid;
$$;
create function pg_temp.d(n integer) returns date language sql as $$
  select current_date + n;
$$;
create function pg_temp.visible_groups(p_user integer) returns text language plpgsql as $$
declare r text;
begin
  perform pg_temp.as_user(p_user);
  select coalesce(string_agg(name, ',' order by name), '') into r from public.get_community_groups()
  where name like 'T-%';
  return r;
end $$;
create function pg_temp.visible_events(p_user integer, p_group uuid) returns text language plpgsql as $$
declare r text;
begin
  perform pg_temp.as_user(p_user);
  select coalesce(string_agg(title, ',' order by title), '') into r from public.get_community_events(p_group);
  return r;
end $$;

-- ------------------------------------------------------------
-- Catalog and privileges
-- ------------------------------------------------------------

select is(
  (select count(*)::int from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('community_groups','group_members','community_events','event_participants')
     and c.relrowsecurity),
  4, 'row level security is on for all four tables'
);

select is(
  (select count(*)::int from pg_class c
   cross join (values ('anon'),('authenticated')) r(role_name)
   cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(priv)
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('community_groups','group_members','community_events','event_participants')
     and has_table_privilege(r.role_name, c.oid, p.priv)),
  0, 'no client role holds any privilege on the four tables'
);

select is(
  (select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid
   where c.relname in ('community_groups','group_members','community_events','event_participants')),
  0, 'there are no policies: every access goes through the functions'
);

select ok(
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('create_group','join_group','leave_group','create_event','join_event','leave_event',
                       'get_community_groups','get_community_events',
                       'admin_list_community_groups','admin_list_community_events',
                       'admin_set_group_status','admin_set_event_status')),
  'all twelve functions are SECURITY DEFINER with an empty search_path'
);

select is(
  (select count(*)::int from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('create_group','join_group','leave_group','create_event','join_event','leave_event',
                       'get_community_groups','get_community_events',
                       'admin_list_community_groups','admin_list_community_events',
                       'admin_set_group_status','admin_set_event_status')
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
          or not has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
  0, 'anon cannot execute any; authenticated can execute all'
);

-- ------------------------------------------------------------
-- Signed out
-- ------------------------------------------------------------

select pg_temp.as_nobody();
select throws_ok($$select public.create_group('T-X','Badminton','Testville')$$, '28000', null, 'create_group: signed out');
select throws_ok($$select public.join_group(gen_random_uuid())$$, '28000', null, 'join_group: signed out');
select throws_ok($$select public.leave_group(gen_random_uuid())$$, '28000', null, 'leave_group: signed out');
select throws_ok($$select public.create_event(gen_random_uuid(),'T',pg_temp.d(5),'18:00',pg_temp.fac(1))$$, '28000', null, 'create_event: signed out');
select throws_ok($$select public.join_event(gen_random_uuid())$$, '28000', null, 'join_event: signed out');
select throws_ok($$select public.leave_event(gen_random_uuid())$$, '28000', null, 'leave_event: signed out');
select throws_ok($$select * from public.get_community_groups()$$, '28000', null, 'get_community_groups: signed out');
select throws_ok($$select * from public.get_community_events()$$, '28000', null, 'get_community_events: signed out');
select throws_ok($$select * from public.admin_list_community_groups()$$, '28000', null, 'admin_list_community_groups: signed out');
select throws_ok($$select * from public.admin_list_community_events()$$, '28000', null, 'admin_list_community_events: signed out');
select throws_ok($$select public.admin_set_group_status(gen_random_uuid(),'approved')$$, '28000', null, 'admin_set_group_status: signed out');
select throws_ok($$select public.admin_set_event_status(gen_random_uuid(),'approved')$$, '28000', null, 'admin_set_event_status: signed out');

-- ------------------------------------------------------------
-- create_group
-- ------------------------------------------------------------

select pg_temp.as_user(1);
insert into ids select 'g1', public.create_group('T-Smashers', 'Badminton', 'Testville', 'Friendly games');

select is((select status::text from public.community_groups where id = pg_temp.id('g1')), 'pending', 'a player''s group starts pending');
select is((select created_by from public.community_groups where id = pg_temp.id('g1')), 'e1000000-0000-0000-0000-000000000001'::uuid, 'the creator is recorded');
select ok(exists (select 1 from public.group_members where group_id = pg_temp.id('g1') and user_id = 'e1000000-0000-0000-0000-000000000001'), 'the creator is a member');
select throws_ok($$select public.create_group(' ', 'Badminton', 'Testville')$$, '22023', null, 'blank name is refused');
select throws_ok($$select public.create_group('T-Ok', 'B', 'Testville')$$, '22023', null, 'too-short sport is refused');
select throws_ok($$select public.create_group('T-Ok', 'Badminton', null)$$, '22023', null, 'null city is refused');
select throws_ok($$select public.create_group('  t-SMASHERS ', 'Badminton', 'TESTVILLE')$$, 'UC005', null, 'a duplicate name in the city is refused, ignoring case and spaces');
select lives_ok($$select public.create_group('T-Smashers', 'Badminton', 'Otherton')$$, 'the same name in another city is fine');

-- pending limit: 2 pending so far for user 1 (g1 and the Otherton one); fill to 5
select lives_ok($$select public.create_group('T-A1','Badminton','Testville')$$, 'third pending group');
select lives_ok($$select public.create_group('T-A2','Badminton','Testville')$$, 'fourth pending group');
select lives_ok($$select public.create_group('T-A3','Badminton','Testville')$$, 'fifth pending group');
select throws_ok($$select public.create_group('T-A4','Badminton','Testville')$$, 'UC004', null, 'a sixth pending group is refused');

select pg_temp.as_user(5);
insert into ids select 'g2', public.create_group('T-Admin Club', 'Football', 'Testville');
select is((select status::text from public.community_groups where id = pg_temp.id('g2')), 'approved', 'an administrator''s group is approved at once');
select lives_ok($$select public.create_group('T-B1','Football','Testville')$$, 'administrators are not subject to the pending limit');

-- ------------------------------------------------------------
-- Visibility of groups
-- ------------------------------------------------------------

select is(pg_temp.visible_groups(1), 'T-A1,T-A2,T-A3,T-Admin Club,T-B1,T-Smashers,T-Smashers', 'the creator sees their own pending groups and the approved ones');
select is(pg_temp.visible_groups(2), 'T-Admin Club,T-B1', 'another player sees approved groups only');
select is(pg_temp.visible_groups(4), 'T-Admin Club,T-B1', 'an outsider sees approved groups only');
select pg_temp.as_user(5);
select is((select count(*)::int from public.get_community_groups() where name = 'T-Admin Club' and member_count = 1 and is_member), 1, 'member_count and is_member are reported');

-- ------------------------------------------------------------
-- join_group / leave_group
-- ------------------------------------------------------------

select pg_temp.as_user(2);
select throws_ok(format($$select public.join_group(%L)$$, pg_temp.id('g1')), 'P0002', null, 'a pending group cannot be joined by others (looks absent)');
select throws_ok($$select public.join_group('e9999999-0000-0000-0000-000000000000')$$, 'P0002', null, 'unknown group');
select throws_ok($$select public.join_group(null)$$, '22023', null, 'null group');
select is(public.join_group(pg_temp.id('g2')), true, 'joining an approved group returns true');
select is(public.join_group(pg_temp.id('g2')), false, 'joining again is idempotent');
select is((select count(*)::int from public.group_members where group_id = pg_temp.id('g2')), 2, 'two members now');

select pg_temp.as_user(3);
select is(public.join_group(pg_temp.id('g2')), true, 'a third player joins');

select pg_temp.as_user(4);
select is(public.leave_group(pg_temp.id('g2')), false, 'leaving a group you are not in returns false');

-- ------------------------------------------------------------
-- create_event
-- ------------------------------------------------------------

select pg_temp.as_user(4);
select throws_ok(format($$select public.create_event(%L,'T-Ev',pg_temp.d(5),'18:00',pg_temp.fac(1))$$, pg_temp.id('g2')), 'UC001', null, 'a non-member cannot create an event');

select pg_temp.as_user(1);
select throws_ok(format($$select public.create_event(%L,'T-Ev',pg_temp.d(5),'18:00',pg_temp.fac(1))$$, pg_temp.id('g1')), 'UC003', null, 'no events in a group that is not approved');

select pg_temp.as_user(2);
select throws_ok(format($$select public.create_event(%L,'T-Ev',pg_temp.d(-1),'18:00',pg_temp.fac(1))$$, pg_temp.id('g2')), '22007', null, 'a past date is refused');
select throws_ok(format($$select public.create_event(%L,'T-Ev',pg_temp.d(5),'18:00',pg_temp.fac(2))$$, pg_temp.id('g2')), '22023', null, 'a venue in another city is refused');
select throws_ok(format($$select public.create_event(%L,'T-Ev',pg_temp.d(5),'18:00',pg_temp.fac(3))$$, pg_temp.id('g2')), '22023', null, 'a venue that is not active is refused');
select throws_ok(format($$select public.create_event(%L,'T-Ev',pg_temp.d(5),'18:00','e9999999-0000-0000-0000-000000000000')$$, pg_temp.id('g2')), '22023', null, 'an unknown venue is refused');
select throws_ok(format($$select public.create_event(%L,'T-Ev',pg_temp.d(5),'18:00',pg_temp.fac(1),0)$$, pg_temp.id('g2')), '22023', null, 'capacity 0 is refused');
select throws_ok(format($$select public.create_event(%L,'x',pg_temp.d(5),'18:00',pg_temp.fac(1))$$, pg_temp.id('g2')), '22023', null, 'a one-letter title is refused');
select throws_ok($$select public.create_event('e9999999-0000-0000-0000-000000000000','T-Ev',pg_temp.d(5),'18:00',pg_temp.fac(1))$$, 'P0002', null, 'unknown group');

insert into ids select 'e1', public.create_event(pg_temp.id('g2'), 'T-Pending Event', pg_temp.d(5), '18:00', pg_temp.fac(1), 2);
select is((select status::text from public.community_events where id = pg_temp.id('e1')), 'pending', 'a member''s event starts pending');
select ok(exists (select 1 from public.event_participants where event_id = pg_temp.id('e1') and user_id = 'e1000000-0000-0000-0000-000000000002'), 'the creator takes part');

select lives_ok(format($$select public.create_event(%L,'T-P2',pg_temp.d(5),'18:00',pg_temp.fac(1))$$, pg_temp.id('g2')), 'second pending event');
select lives_ok(format($$select public.create_event(%L,'T-P3',pg_temp.d(5),'18:00',pg_temp.fac(1))$$, pg_temp.id('g2')), 'third pending event');
select lives_ok(format($$select public.create_event(%L,'T-P4',pg_temp.d(5),'18:00',pg_temp.fac(1))$$, pg_temp.id('g2')), 'fourth pending event');
select lives_ok(format($$select public.create_event(%L,'T-P5',pg_temp.d(5),'18:00',pg_temp.fac(1))$$, pg_temp.id('g2')), 'fifth pending event');
select throws_ok(format($$select public.create_event(%L,'T-P6',pg_temp.d(5),'18:00',pg_temp.fac(1))$$, pg_temp.id('g2')), 'UC004', null, 'a sixth pending event is refused');

select pg_temp.as_user(5);
insert into ids select 'e2', public.create_event(pg_temp.id('g2'), 'T-Admin Event', pg_temp.d(6), '19:00', pg_temp.fac(1), 2);
select is((select status::text from public.community_events where id = pg_temp.id('e2')), 'approved', 'an administrator''s event is approved at once');

-- ------------------------------------------------------------
-- Visibility of events
-- ------------------------------------------------------------

select is(pg_temp.visible_events(3, pg_temp.id('g2')), 'T-Admin Event', 'another member sees approved events only');
select is(pg_temp.visible_events(4, pg_temp.id('g2')), 'T-Admin Event', 'an outsider sees approved events only');
select is(pg_temp.visible_events(2, pg_temp.id('g2')), 'T-Admin Event,T-P2,T-P3,T-P4,T-P5,T-Pending Event', 'the creator also sees their pending events');
select is((select count(*)::int from public.get_community_events(pg_temp.id('g2')) where title = 'T-Admin Event' and facility_name = 'Test Court A' and city = 'Testville' and participant_count = 1), 1, 'the venue name, city and participant count are reported');

-- ------------------------------------------------------------
-- join_event
-- ------------------------------------------------------------

select pg_temp.as_user(3);
select throws_ok(format($$select public.join_event(%L)$$, pg_temp.id('e1')), 'P0002', null, 'a pending event looks absent to others');
select pg_temp.as_user(2);
select throws_ok(format($$select public.join_event(%L)$$, pg_temp.id('e1')), 'UC003', null, 'its creator is told it is not open yet');

select pg_temp.as_user(4);
select throws_ok(format($$select public.join_event(%L)$$, pg_temp.id('e2')), 'UC001', null, 'a non-member cannot join an event');

select pg_temp.as_user(3);
select throws_ok($$select public.join_event('e9999999-0000-0000-0000-000000000000')$$, 'P0002', null, 'unknown event');
select throws_ok($$select public.join_event(null)$$, '22023', null, 'null event');
select is(public.join_event(pg_temp.id('e2')), true, 'a member joins an approved event');
select is(public.join_event(pg_temp.id('e2')), false, 'joining again is idempotent');
select is((select participant_count from public.get_community_events(pg_temp.id('g2')) where id = pg_temp.id('e2')), 2, 'the count is 2 (admin creator + member)');

select pg_temp.as_user(2);
select throws_ok(format($$select public.join_event(%L)$$, pg_temp.id('e2')), 'UC002', null, 'a full event (capacity 2) refuses a third person');

-- a past event cannot be joined
reset role;
update public.community_events set status = 'approved', event_date = current_date - 1 where id = pg_temp.id('e1');
select pg_temp.as_user(3);
select throws_ok(format($$select public.join_event(%L)$$, pg_temp.id('e1')), 'UC003', null, 'an event whose date has passed cannot be joined');

-- ------------------------------------------------------------
-- leave_event / my events
-- ------------------------------------------------------------

select pg_temp.as_user(3);
select is((select count(*)::int from public.get_community_events(null, true)), 1, 'my events lists the one I take part in');
select is(public.leave_event(pg_temp.id('e2')), true, 'leaving an event returns true');
select is(public.leave_event(pg_temp.id('e2')), false, 'leaving again returns false');
select is((select count(*)::int from public.get_community_events(null, true)), 0, 'my events is empty after leaving');
select is(public.join_event(pg_temp.id('e2')), true, 'the freed place can be taken again');

-- leaving the group also leaves its events
select is(public.leave_group(pg_temp.id('g2')), true, 'leaving a group returns true');
select is((select count(*)::int from public.event_participants where event_id = pg_temp.id('e2') and user_id = 'e1000000-0000-0000-0000-000000000003'), 0, 'leaving the group removed the person from its events');
select is((select count(*)::int from public.group_members where group_id = pg_temp.id('g2') and user_id = 'e1000000-0000-0000-0000-000000000003'), 0, 'and from the group');
select throws_ok(format($$select public.join_event(%L)$$, pg_temp.id('e2')), 'UC001', null, 'a former member cannot join its events');

-- ------------------------------------------------------------
-- Administrators
-- ------------------------------------------------------------

select pg_temp.as_user(4);
select throws_ok(format($$select public.admin_set_group_status(%L,'approved')$$, pg_temp.id('g1')), '42501', null, 'a player cannot approve a group');
select throws_ok(format($$select public.admin_set_event_status(%L,'approved')$$, pg_temp.id('e1')), '42501', null, 'a player cannot approve an event');
select throws_ok($$select * from public.admin_list_community_groups()$$, '42501', null, 'a player cannot list the review queue (groups)');
select throws_ok($$select * from public.admin_list_community_events()$$, '42501', null, 'a player cannot list the review queue (events)');
select pg_temp.as_user(1);
select throws_ok(format($$select public.admin_set_group_status(%L,'approved')$$, pg_temp.id('g1')), '42501', null, 'a group''s own creator cannot approve it');
select is((select status::text from public.community_groups where id = pg_temp.id('g1')), 'pending', 'refused calls changed nothing');

select pg_temp.as_user(5);
select is((select count(*)::int from public.admin_list_community_groups('pending') where name = 'T-Smashers'), 2, 'the queue lists pending groups with their creators');
select is((select created_by_email from public.admin_list_community_groups() where id = pg_temp.id('g1')), 'comm-user1@example.com', 'and the creator''s email');
select is(public.admin_set_group_status(pg_temp.id('g1'), 'approved'), 'approved'::public.approval_status, 'approve a group');
select is(public.admin_set_group_status(pg_temp.id('g1'), 'approved'), 'approved'::public.approval_status, 'approving again is idempotent');
select throws_ok($$select public.admin_set_group_status('e9999999-0000-0000-0000-000000000000','approved')$$, 'P0002', null, 'unknown group');
select throws_ok($$select public.admin_set_group_status(null,'approved')$$, '22023', null, 'null group');

select is(pg_temp.visible_groups(2), 'T-Admin Club,T-B1,T-Smashers', 'an approved group becomes visible to others');

select pg_temp.as_user(5);
select is(public.admin_set_group_status(pg_temp.id('g1'), 'rejected'), 'rejected'::public.approval_status, 'reject a group');
select is(pg_temp.visible_groups(2), 'T-Admin Club,T-B1', 'a rejected group disappears for others');
select pg_temp.as_user(1);
select throws_ok(format($$select public.join_group(%L)$$, pg_temp.id('g1')), 'P0002', null, 'and cannot be joined');
select pg_temp.as_user(5);
select lives_ok($$select public.create_group('T-Smashers','Badminton','Testville')$$, 'a rejected group frees its name');
select throws_ok(format($$select public.admin_set_group_status(%L,'approved')$$, pg_temp.id('g1')), 'UC005', null, 'reinstating it while the name is taken is refused');

select is(public.admin_set_event_status(pg_temp.id('e1'), 'rejected'), 'rejected'::public.approval_status, 'reject an event');
select throws_ok($$select public.admin_set_event_status('e9999999-0000-0000-0000-000000000000','approved')$$, 'P0002', null, 'unknown event');
select is((select count(*)::int from public.admin_list_community_events('rejected') where title = 'T-Pending Event' and group_name = 'T-Admin Club'), 1, 'the event queue lists it with its group');
select is(public.admin_set_event_status(pg_temp.id('e1'), 'approved'), 'approved'::public.approval_status, 'approve an event again');

-- an unapproved group hides its (approved) events
select is(public.admin_set_group_status(pg_temp.id('g2'), 'pending'), 'pending'::public.approval_status, 'move a group back to pending');
select is(pg_temp.visible_events(3, pg_temp.id('g2')), '', 'its events are hidden from others');
select pg_temp.as_user(3);
select throws_ok(format($$select public.join_event(%L)$$, pg_temp.id('e2')), 'P0002', null, 'and cannot be joined');

select * from finish();
rollback;
