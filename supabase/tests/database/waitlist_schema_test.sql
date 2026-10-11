begin;

select plan(26);


-- ============================================================
-- Fixture
-- ============================================================

insert into auth.users (
  id,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_user_meta_data
)
values
  (
    'a1000000-0000-0000-0000-000000000001',
    'wl-schema-user1@example.com',
    '',
    now(),
    '{"full_name":"Waitlist Schema User 1"}'
  ),
  (
    'a1000000-0000-0000-0000-000000000002',
    'wl-schema-user2@example.com',
    '',
    now(),
    '{"full_name":"Waitlist Schema User 2"}'
  ),
  (
    'a1000000-0000-0000-0000-000000000009',
    'wl-schema-owner@example.com',
    '',
    now(),
    '{"full_name":"Waitlist Schema Owner"}'
  );

alter table public.profiles
disable trigger profiles_prevent_role_escalation;

update public.profiles
set role = 'owner'
where id = 'a1000000-0000-0000-0000-000000000009';

alter table public.profiles
enable trigger profiles_prevent_role_escalation;

insert into public.facilities (
  id, owner_id, name, description, sport, address, city, status, base_price
)
values (
  'b1000000-0000-0000-0000-000000000001',
  'a1000000-0000-0000-0000-000000000009',
  'Waitlist Schema Facility',
  'Temporary database test facility',
  'Football',
  'Test Address',
  'Test City',
  'active',
  500
);

insert into public.facility_slots (
  id, facility_id, start_time, end_time, duration_min, base_price, is_active
)
values (
  'c1000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000001',
  '18:00', '19:00', 60, 500, true
);

insert into public.bookings (
  id, user_id, facility_id, slot_id, booking_date,
  start_time, end_time, amount, status, payment_status, expires_at
)
values (
  'd1000000-0000-0000-0000-000000000001',
  'a1000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000001',
  current_date + 10, '18:00', '19:00', 500,
  'pending_payment', 'pending', now() + interval '10 minutes'
);


-- ============================================================
-- Table, RLS and policies
-- ============================================================

select has_table('public', 'waitlist_entries', 'waitlist_entries should exist');

select ok(
  (select relrowsecurity from pg_class
   where oid = 'public.waitlist_entries'::regclass),
  'RLS should be enabled on waitlist_entries'
);

select ok(
  (select count(*) = 1
          and bool_and(cmd = 'SELECT' and roles = '{authenticated}'::name[])
   from pg_policies
   where schemaname = 'public' and tablename = 'waitlist_entries'),
  'the only policy should be a SELECT policy for authenticated'
);

select has_index(
  'public', 'waitlist_entries', 'waitlist_one_active_entry_per_user',
  'active-entry uniqueness index should exist'
);

select has_index(
  'public', 'waitlist_entries', 'waitlist_one_offer_per_slot_date',
  'one-offer-per-slot-date index should exist'
);


-- ============================================================
-- Table privileges
-- ============================================================

select ok(
  has_table_privilege('authenticated', 'public.waitlist_entries', 'select'),
  'authenticated should be able to SELECT (filtered by RLS)'
);

select ok(
  not has_table_privilege('authenticated', 'public.waitlist_entries', 'insert')
  and not has_table_privilege('authenticated', 'public.waitlist_entries', 'update')
  and not has_table_privilege('authenticated', 'public.waitlist_entries', 'delete'),
  'authenticated should have no direct write privileges'
);

select ok(
  not has_table_privilege('anon', 'public.waitlist_entries', 'select')
  and not has_table_privilege('anon', 'public.waitlist_entries', 'insert')
  and not has_table_privilege('anon', 'public.waitlist_entries', 'update')
  and not has_table_privilege('anon', 'public.waitlist_entries', 'delete'),
  'anon should have no privileges on waitlist_entries'
);


-- ============================================================
-- Constraints (exercised as the table owner)
-- ============================================================

select throws_ok(
  $$
    insert into public.waitlist_entries
      (user_id, facility_id, slot_id, booking_date, status)
    values (
      'a1000000-0000-0000-0000-000000000001',
      'b1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000001',
      current_date + 10, 'offered'
    )
  $$,
  '23514', null,
  'an offered entry must carry offer timestamps'
);

select throws_ok(
  $$
    insert into public.waitlist_entries
      (user_id, facility_id, slot_id, booking_date, status,
       offered_at, offer_expires_at)
    values (
      'a1000000-0000-0000-0000-000000000001',
      'b1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000001',
      current_date + 10, 'waiting', now(), now() + interval '15 minutes'
    )
  $$,
  '23514', null,
  'a waiting entry must not carry offer data'
);

select throws_ok(
  $$
    insert into public.waitlist_entries
      (user_id, facility_id, slot_id, booking_date, status,
       offered_at, offer_expires_at)
    values (
      'a1000000-0000-0000-0000-000000000001',
      'b1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000001',
      current_date + 10, 'offered', now(), now()
    )
  $$,
  '23514', null,
  'an offer must expire after it starts'
);

select throws_ok(
  $$
    insert into public.waitlist_entries
      (user_id, facility_id, slot_id, booking_date, status,
       offered_at, offer_expires_at)
    values (
      'a1000000-0000-0000-0000-000000000001',
      'b1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000001',
      current_date + 10, 'accepted', now(), now() + interval '15 minutes'
    )
  $$,
  '23514', null,
  'an accepted entry must reference a booking'
);

select throws_ok(
  $$
    insert into public.waitlist_entries
      (user_id, facility_id, slot_id, booking_date, queue_position)
    values (
      'a1000000-0000-0000-0000-000000000001',
      'b1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000001',
      current_date + 10, 1
    )
  $$,
  '428C9', null,
  'queue_position cannot be supplied by the writer'
);

select throws_ok(
  $$
    insert into public.waitlist_entries
      (user_id, facility_id, slot_id, booking_date)
    values (
      'a1000000-0000-0000-0000-0000000000ff',
      'b1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000001',
      current_date + 10
    )
  $$,
  '23503', null,
  'user_id must reference an existing profile'
);

-- Base row for uniqueness tests.
insert into public.waitlist_entries
  (user_id, facility_id, slot_id, booking_date)
values (
  'a1000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000001',
  current_date + 10
);

select throws_ok(
  $$
    insert into public.waitlist_entries
      (user_id, facility_id, slot_id, booking_date)
    values (
      'a1000000-0000-0000-0000-000000000001',
      'b1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000001',
      current_date + 10
    )
  $$,
  '23505', null,
  'a user cannot hold two active entries for the same slot and date'
);

select lives_ok(
  $$
    insert into public.waitlist_entries
      (user_id, facility_id, slot_id, booking_date, status,
       offered_at, offer_expires_at)
    values (
      'a1000000-0000-0000-0000-000000000002',
      'b1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000001',
      current_date + 10, 'offered', now(), now() + interval '15 minutes'
    )
  $$,
  'one offered entry for a slot and date is allowed'
);

select throws_ok(
  $$
    update public.waitlist_entries
    set
      status = 'offered',
      offered_at = now(),
      offer_expires_at = now() + interval '15 minutes'
    where user_id = 'a1000000-0000-0000-0000-000000000001'
  $$,
  '23505', null,
  'a second outstanding offer for the same slot and date is rejected'
);

select lives_ok(
  $$
    update public.waitlist_entries
    set status = 'cancelled'
    where user_id = 'a1000000-0000-0000-0000-000000000001';

    insert into public.waitlist_entries
      (user_id, facility_id, slot_id, booking_date)
    values (
      'a1000000-0000-0000-0000-000000000001',
      'b1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000001',
      current_date + 10
    );
  $$,
  'a user may queue again once the earlier entry is no longer active'
);

select is(
  (select count(*)::integer
   from public.waitlist_entries
   where user_id = 'a1000000-0000-0000-0000-000000000001'
     and queue_position is not null),
  2,
  'queue_position is always assigned by the database'
);


-- ============================================================
-- Function privileges
-- ============================================================

select ok(
  has_function_privilege('authenticated', 'public.join_waitlist(uuid,uuid,date)', 'execute')
  and has_function_privilege('authenticated', 'public.leave_waitlist(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.accept_waitlist_offer(uuid)', 'execute'),
  'authenticated should be able to join, leave and accept'
);

select ok(
  not has_function_privilege('authenticated', 'public.offer_next_waitlist_entry(uuid,date)', 'execute')
  and not has_function_privilege('authenticated', 'public.expire_waitlist_offers()', 'execute')
  and not has_function_privilege('authenticated', 'public.process_waitlist()', 'execute'),
  'authenticated should not be able to run queue maintenance'
);

select ok(
  not has_function_privilege('anon', 'public.join_waitlist(uuid,uuid,date)', 'execute')
  and not has_function_privilege('anon', 'public.leave_waitlist(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.accept_waitlist_offer(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.offer_next_waitlist_entry(uuid,date)', 'execute')
  and not has_function_privilege('anon', 'public.expire_waitlist_offers()', 'execute')
  and not has_function_privilege('anon', 'public.process_waitlist()', 'execute'),
  'anon should not be able to execute any waitlist function'
);

select ok(
  has_function_privilege('service_role', 'public.offer_next_waitlist_entry(uuid,date)', 'execute')
  and has_function_privilege('service_role', 'public.expire_waitlist_offers()', 'execute')
  and has_function_privilege('service_role', 'public.process_waitlist()', 'execute'),
  'service_role should be able to run queue maintenance'
);

select is(
  (select count(*)::integer
   from pg_proc p
   cross join lateral aclexplode(p.proacl) a
   where p.oid = any (array[
     'public.join_waitlist(uuid,uuid,date)'::regprocedure,
     'public.leave_waitlist(uuid)'::regprocedure,
     'public.accept_waitlist_offer(uuid)'::regprocedure,
     'public.offer_next_waitlist_entry(uuid,date)'::regprocedure,
     'public.expire_waitlist_offers()'::regprocedure,
     'public.process_waitlist()'::regprocedure
   ])
   and a.grantee = 0),
  0,
  'PUBLIC should have EXECUTE on no waitlist function'
);

select is(
  (select count(*)::integer
   from pg_proc p
   where p.oid = any (array[
     'public.join_waitlist(uuid,uuid,date)'::regprocedure,
     'public.leave_waitlist(uuid)'::regprocedure,
     'public.accept_waitlist_offer(uuid)'::regprocedure,
     'public.offer_next_waitlist_entry(uuid,date)'::regprocedure,
     'public.expire_waitlist_offers()'::regprocedure,
     'public.process_waitlist()'::regprocedure
   ])
   and p.prosecdef
   and coalesce(p.proconfig, '{}') @> array['search_path=""']),
  6,
  'all waitlist functions should be SECURITY DEFINER with an empty search_path'
);

create function pg_temp.waitlist_job_state()
returns text
language plpgsql
as $$
begin
  if to_regclass('cron.job') is null then
    if current_setting('cron.database_name', true)
         is not distinct from current_database() then
      return 'missing';
    end if;
    return 'unsupported';
  end if;

  if (
    select count(*)
    from cron.job
    where jobname = 'process-waitlist'
      and schedule = '* * * * *'
      and command = 'select public.process_waitlist()'
      and active
  ) = 1 then
    return 'scheduled';
  end if;

  return 'missing';
end;
$$;

select case pg_temp.waitlist_job_state()
  when 'unsupported' then
    skip('pg_cron is not available in this database', 1)
  else
    is(
      pg_temp.waitlist_job_state(),
      'scheduled',
      'process-waitlist should be scheduled once per minute'
    )
end;


select * from finish();

rollback;
