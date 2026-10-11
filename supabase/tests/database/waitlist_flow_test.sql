begin;

select plan(58);


-- ============================================================
-- Fixture
--
-- Users:    U1..U5 (a1000000-...-00000000000N), owner (...09)
-- Facility: F1 (b1...01) with slots
--             S   18:00-19:00  active   (the contested slot)
--             S2  20:00-21:00  active   (never booked)
--             SI  10:00-11:00  INACTIVE
--           F2 (b1...02) with slot SF2
-- Dates:    D  = current_date + 3
--           D2 = current_date + 4
--
-- Operating hours exist for every weekday, so nothing depends
-- on which day the suite runs.
-- ============================================================

insert into auth.users (
  id,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_user_meta_data
)
select
  ('a1000000-0000-0000-0000-00000000000' || n)::uuid,
  'wl-flow-user' || n || '@example.com',
  '',
  now(),
  jsonb_build_object('full_name', 'Waitlist Flow User ' || n)
from generate_series(1, 5) n;

insert into auth.users (
  id,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_user_meta_data
)
values (
  'a1000000-0000-0000-0000-000000000009',
  'wl-flow-owner@example.com',
  '',
  now(),
  '{"full_name":"Waitlist Flow Owner"}'
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
values
  (
    'b1000000-0000-0000-0000-000000000001',
    'a1000000-0000-0000-0000-000000000009',
    'Waitlist Flow Facility',
    'Temporary database test facility',
    'Football',
    'Test Address',
    'Test City',
    'active',
    500
  ),
  (
    'b1000000-0000-0000-0000-000000000002',
    'a1000000-0000-0000-0000-000000000009',
    'Waitlist Other Facility',
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
values
  ('c1000000-0000-0000-0000-000000000001',
   'b1000000-0000-0000-0000-000000000001', '18:00', '19:00', 60, 500, true),
  ('c1000000-0000-0000-0000-000000000002',
   'b1000000-0000-0000-0000-000000000001', '20:00', '21:00', 60, 500, true),
  ('c1000000-0000-0000-0000-000000000003',
   'b1000000-0000-0000-0000-000000000001', '10:00', '11:00', 60, 500, false),
  ('c1000000-0000-0000-0000-000000000004',
   'b1000000-0000-0000-0000-000000000002', '18:00', '19:00', 60, 500, true);

insert into public.facility_operating_hours (
  facility_id, day_of_week, opens_at, closes_at, is_closed
)
select f.id, d, '08:00', '22:00', false
from (
  values
    ('b1000000-0000-0000-0000-000000000001'::uuid),
    ('b1000000-0000-0000-0000-000000000002'::uuid)
) f(id)
cross join generate_series(0, 6) d;

-- U1 holds a confirmed booking on S for D: the slot is full.
insert into public.bookings (
  id, user_id, facility_id, slot_id, booking_date,
  start_time, end_time, amount, status, payment_status, expires_at
)
values (
  'd1000000-0000-0000-0000-000000000001',
  'a1000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000001',
  current_date + 3, '18:00', '19:00', 500,
  'confirmed', 'paid', null
);


-- ============================================================
-- A. Joining
-- ============================================================

set local role authenticated;
set local request.jwt.claim.sub = 'a1000000-0000-0000-0000-000000000002';

select lives_ok(
  $$
    select * from public.join_waitlist(
      'b1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000001',
      current_date + 3
    )
  $$,
  'a user can join the waitlist for a full slot'
);

select results_eq(
  $$
    select status::text, offered_at is null, booking_id is null
    from public.waitlist_entries
    where user_id = 'a1000000-0000-0000-0000-000000000002'
  $$,
  $$ values ('waiting', true, true) $$,
  'a new entry is waiting, with no offer and no booking'
);

select throws_ok(
  $$
    select * from public.join_waitlist(
      'b1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000001',
      current_date + 3
    )
  $$,
  '23505', null,
  'joining twice for the same slot and date is rejected'
);

set local request.jwt.claim.sub = 'a1000000-0000-0000-0000-000000000003';

select is(
  (select entries_ahead
   from public.join_waitlist(
     'b1000000-0000-0000-0000-000000000001',
     'c1000000-0000-0000-0000-000000000001',
     current_date + 3
   )),
  1,
  'the second user joins behind one entry'
);

reset role;

select ok(
  (select queue_position from public.waitlist_entries
   where user_id = 'a1000000-0000-0000-0000-000000000002')
  <
  (select queue_position from public.waitlist_entries
   where user_id = 'a1000000-0000-0000-0000-000000000003'),
  'queue positions follow join order (FIFO)'
);

do $$
begin
  perform set_config(
    'test.e2',
    (select w.id::text from public.waitlist_entries w
     where w.user_id = 'a1000000-0000-0000-0000-000000000002'
       and w.booking_date = current_date + 3),
    true
  );
  perform set_config(
    'test.e3',
    (select w.id::text from public.waitlist_entries w
     where w.user_id = 'a1000000-0000-0000-0000-000000000003'
       and w.booking_date = current_date + 3),
    true
  );
end;
$$;


-- ------------------------------------------------------------
-- Invalid requests (as U4, who has no entry)
-- ------------------------------------------------------------

set local role authenticated;
set local request.jwt.claim.sub = 'a1000000-0000-0000-0000-000000000004';

select throws_ok(
  $$
    select * from public.join_waitlist(
      'b1000000-0000-0000-0000-0000000000aa',
      'c1000000-0000-0000-0000-000000000001',
      current_date + 3
    )
  $$,
  'P0002', 'Facility not found',
  'unknown facility is rejected'
);

select throws_ok(
  $$
    select * from public.join_waitlist(
      'b1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-0000000000aa',
      current_date + 3
    )
  $$,
  'P0002', 'Facility slot not found',
  'unknown slot is rejected'
);

select throws_ok(
  $$
    select * from public.join_waitlist(
      'b1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000004',
      current_date + 3
    )
  $$,
  '22023', null,
  'a slot belonging to another facility is rejected'
);

select throws_ok(
  $$
    select * from public.join_waitlist(
      'b1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000003',
      current_date + 3
    )
  $$,
  'P0001', 'Selected slot is not active',
  'an inactive slot is rejected'
);

select throws_ok(
  $$
    select * from public.join_waitlist(
      'b1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000001',
      current_date - 1
    )
  $$,
  '22007', null,
  'a past date is rejected'
);

select throws_ok(
  $$
    select * from public.join_waitlist(
      'b1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000002',
      current_date + 3
    )
  $$,
  'P0001', 'Selected slot is currently available; book it directly',
  'a slot that is free cannot be waitlisted'
);

set local request.jwt.claim.sub = 'a1000000-0000-0000-0000-000000000001';

select throws_ok(
  $$
    select * from public.join_waitlist(
      'b1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000001',
      current_date + 3
    )
  $$,
  'P0001', 'You already have a booking for this slot and date',
  'the holder of the booking cannot waitlist their own slot'
);

set local request.jwt.claim.sub = '';

select throws_ok(
  $$
    select * from public.join_waitlist(
      'b1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000001',
      current_date + 3
    )
  $$,
  '28000', null,
  'joining without a signed-in user is rejected'
);

reset role;
set local role anon;

select throws_ok(
  $$
    select * from public.join_waitlist(
      'b1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000001',
      current_date + 3
    )
  $$,
  '42501', null,
  'anon cannot call join_waitlist'
);

reset role;


-- ============================================================
-- B. Ownership, RLS and direct writes (as U3)
-- ============================================================

set local role authenticated;
set local request.jwt.claim.sub = 'a1000000-0000-0000-0000-000000000003';

select is(
  (select count(*)::integer from public.waitlist_entries),
  1,
  'a user sees only their own entries'
);

select is(
  (select count(*)::integer from public.waitlist_entries
   where id = current_setting('test.e2')::uuid),
  0,
  'another user''s entry is invisible'
);

select throws_ok(
  $$ select public.leave_waitlist(current_setting('test.e2')::uuid) $$,
  'P0002', 'Waitlist entry not found',
  'a user cannot leave another user''s entry'
);

select is(
  (select status::text from (
     select status from public.waitlist_entries
     where id = current_setting('test.e3')::uuid
   ) s),
  'waiting',
  'the failed attempt did not change anything'
);

select throws_ok(
  $$
    insert into public.waitlist_entries
      (user_id, facility_id, slot_id, booking_date)
    values (
      'a1000000-0000-0000-0000-000000000003',
      'b1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000002',
      current_date + 3
    )
  $$,
  '42501', null,
  'clients cannot insert entries directly'
);

select throws_ok(
  $$
    update public.waitlist_entries
    set status = 'offered'
    where id = current_setting('test.e3')::uuid
  $$,
  '42501', null,
  'clients cannot change status directly'
);

select throws_ok(
  $$ delete from public.waitlist_entries $$,
  '42501', null,
  'clients cannot delete entries directly'
);

select throws_ok(
  $$ select public.offer_next_waitlist_entry(
       'c1000000-0000-0000-0000-000000000001', current_date + 3) $$,
  '42501', null,
  'clients cannot issue offers'
);

select throws_ok(
  $$ select public.process_waitlist() $$,
  '42501', null,
  'clients cannot run the queue processor'
);

reset role;


-- ============================================================
-- C. Offers
-- ============================================================

select is(
  public.offer_next_waitlist_entry(
    'c1000000-0000-0000-0000-000000000001', current_date + 3
  ),
  null::uuid,
  'no offer is issued while a confirmed booking occupies the slot'
);

-- The booking is cancelled: the slot frees up.
update public.bookings
set status = 'cancelled', cancelled_at = now()
where id = 'd1000000-0000-0000-0000-000000000001';

select is(
  public.offer_next_waitlist_entry(
    'c1000000-0000-0000-0000-000000000001', current_date + 3
  ),
  current_setting('test.e2')::uuid,
  'the first user in line receives the offer'
);

select results_eq(
  $$
    select status::text, offer_expires_at = offered_at + interval '15 minutes'
    from public.waitlist_entries
    where id = current_setting('test.e2')::uuid
  $$,
  $$ values ('offered', true) $$,
  'the offer lasts 15 minutes'
);

select is(
  (select status::text from public.waitlist_entries
   where id = current_setting('test.e3')::uuid),
  'waiting',
  'later users keep waiting'
);

select is(
  public.offer_next_waitlist_entry(
    'c1000000-0000-0000-0000-000000000001', current_date + 3
  ),
  null::uuid,
  'no second offer is issued while one is outstanding'
);

select throws_ok(
  $$
    update public.waitlist_entries
    set
      status = 'offered',
      offered_at = now(),
      offer_expires_at = now() + interval '15 minutes'
    where id = current_setting('test.e3')::uuid
  $$,
  '23505', null,
  'the database itself refuses a second concurrent offer'
);


-- ------------------------------------------------------------
-- The offer holds the slot
-- ------------------------------------------------------------

set local role authenticated;
set local request.jwt.claim.sub = 'a1000000-0000-0000-0000-000000000003';

select throws_ok(
  $$
    select * from public.create_booking(
      'b1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000001',
      current_date + 3
    )
  $$,
  'P0001', 'The selected slot is currently held for a waitlist offer',
  'a queued user behind the offer cannot jump the line'
);

set local request.jwt.claim.sub = 'a1000000-0000-0000-0000-000000000004';

select throws_ok(
  $$
    select * from public.create_booking(
      'b1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000001',
      current_date + 3
    )
  $$,
  'P0001', 'The selected slot is currently held for a waitlist offer',
  'a user who is not queued cannot take an offered slot'
);


-- ============================================================
-- D. Accepting
-- ============================================================

set local request.jwt.claim.sub = 'a1000000-0000-0000-0000-000000000003';

select throws_ok(
  $$ select * from public.accept_waitlist_offer(current_setting('test.e2')::uuid) $$,
  'P0002', 'Waitlist entry not found',
  'a user cannot accept someone else''s offer'
);

select throws_ok(
  $$ select * from public.accept_waitlist_offer(current_setting('test.e3')::uuid) $$,
  'P0001', 'Waitlist offer is no longer valid',
  'a waiting (not offered) entry cannot be accepted'
);

set local request.jwt.claim.sub = 'a1000000-0000-0000-0000-000000000002';

select lives_ok(
  $$ select * from public.accept_waitlist_offer(current_setting('test.e2')::uuid) $$,
  'the offered user can accept the offer'
);

select results_eq(
  $$
    select
      w.status::text,
      b.status::text,
      b.payment_status::text,
      b.user_id::text,
      b.amount
    from public.waitlist_entries w
    join public.bookings b on b.id = w.booking_id
    where w.id = current_setting('test.e2')::uuid
  $$,
  $$ values (
    'accepted',
    'pending_payment',
    'pending',
    'a1000000-0000-0000-0000-000000000002',
    500.00::numeric
  ) $$,
  'accepting creates a pending, unpaid booking for the user at the server price'
);

select throws_ok(
  $$ select * from public.accept_waitlist_offer(current_setting('test.e2')::uuid) $$,
  'P0001', 'Waitlist offer is no longer valid',
  'an offer cannot be accepted twice'
);

select throws_ok(
  $$ select public.leave_waitlist(current_setting('test.e2')::uuid) $$,
  'P0001', null,
  'an accepted entry cannot be left; the booking must be cancelled instead'
);

reset role;

select is(
  public.offer_next_waitlist_entry(
    'c1000000-0000-0000-0000-000000000001', current_date + 3
  ),
  null::uuid,
  'no offer is issued while the accepted booking holds the slot'
);

select is(
  (select status::text from public.waitlist_entries
   where id = current_setting('test.e3')::uuid),
  'waiting',
  'the next user keeps waiting behind the accepted booking'
);


-- ============================================================
-- E. Unpaid booking expires -> next user is offered
-- ============================================================

update public.bookings
set expires_at = now() - interval '1 minute'
where user_id = 'a1000000-0000-0000-0000-000000000002'
  and booking_date = current_date + 3;

select is(
  public.process_waitlist(),
  1,
  'process_waitlist expires the unpaid booking and issues one offer'
);

select is(
  (select status::text from public.waitlist_entries
   where id = current_setting('test.e3')::uuid),
  'offered',
  'the next user in line now holds the offer'
);


-- ============================================================
-- F. Offer expiry
-- ============================================================

update public.waitlist_entries
set
  offered_at = now() - interval '20 minutes',
  offer_expires_at = now() - interval '5 minutes'
where id = current_setting('test.e3')::uuid;

set local role authenticated;
set local request.jwt.claim.sub = 'a1000000-0000-0000-0000-000000000003';

select throws_ok(
  $$ select * from public.accept_waitlist_offer(current_setting('test.e3')::uuid) $$,
  'P0001', 'Waitlist offer has expired',
  'a lapsed offer cannot be accepted'
);

reset role;

select is(
  (select status::text from public.waitlist_entries
   where id = current_setting('test.e3')::uuid),
  'offered',
  'a rejected accept leaves the entry untouched'
);

-- A lapsed offer no longer holds the slot.
set local role authenticated;
set local request.jwt.claim.sub = 'a1000000-0000-0000-0000-000000000004';

select lives_ok(
  $$
    select * from public.create_booking(
      'b1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000001',
      current_date + 3
    )
  $$,
  'a lapsed offer no longer blocks other users'
);

reset role;

update public.bookings
set status = 'cancelled', cancelled_at = now()
where user_id = 'a1000000-0000-0000-0000-000000000004'
  and booking_date = current_date + 3;

select is(
  public.expire_waitlist_offers(),
  1,
  'expire_waitlist_offers expires the lapsed offer'
);

select is(
  (select status::text from public.waitlist_entries
   where id = current_setting('test.e3')::uuid),
  'expired',
  'the expired offer is ineligible'
);

select is(
  public.expire_waitlist_offers(),
  0,
  'expiring again is a no-op'
);

select is(
  public.process_waitlist(),
  0,
  'with nobody waiting no offer is issued'
);


-- ============================================================
-- G. Leaving and declining (date D2)
-- ============================================================

insert into public.bookings (
  id, user_id, facility_id, slot_id, booking_date,
  start_time, end_time, amount, status, payment_status, expires_at
)
values (
  'd1000000-0000-0000-0000-000000000002',
  'a1000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000001',
  current_date + 4, '18:00', '19:00', 500,
  'confirmed', 'paid', null
);

set local role authenticated;

set local request.jwt.claim.sub = 'a1000000-0000-0000-0000-000000000004';
do $$
begin
  perform * from public.join_waitlist(
  'b1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000001',
  current_date + 4
  );
end;
$$;

set local request.jwt.claim.sub = 'a1000000-0000-0000-0000-000000000005';
do $$
begin
  perform * from public.join_waitlist(
  'b1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000001',
  current_date + 4
  );
end;
$$;

set local request.jwt.claim.sub = 'a1000000-0000-0000-0000-000000000003';
do $$
begin
  perform * from public.join_waitlist(
  'b1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000001',
  current_date + 4
  );
end;
$$;

reset role;

do $$
begin
  perform set_config(
    'test.e4',
    (select w.id::text from public.waitlist_entries w
     where w.user_id = 'a1000000-0000-0000-0000-000000000004'
       and w.booking_date = current_date + 4),
    true
  );
  perform set_config(
    'test.e5',
    (select w.id::text from public.waitlist_entries w
     where w.user_id = 'a1000000-0000-0000-0000-000000000005'
       and w.booking_date = current_date + 4),
    true
  );
  perform set_config(
    'test.e3b',
    (select w.id::text from public.waitlist_entries w
     where w.user_id = 'a1000000-0000-0000-0000-000000000003'
       and w.booking_date = current_date + 4),
    true
  );
end;
$$;

set local role authenticated;
set local request.jwt.claim.sub = 'a1000000-0000-0000-0000-000000000004';

select is(
  public.leave_waitlist(current_setting('test.e4')::uuid)::text,
  'cancelled',
  'a user can leave the waitlist'
);

select is(
  public.leave_waitlist(current_setting('test.e4')::uuid)::text,
  'cancelled',
  'leaving twice is harmless'
);

reset role;

-- U4 left, so U5 is next in line once the slot frees up.
update public.bookings
set status = 'cancelled', cancelled_at = now()
where id = 'd1000000-0000-0000-0000-000000000002';

select is(
  public.offer_next_waitlist_entry(
    'c1000000-0000-0000-0000-000000000001', current_date + 4
  ),
  current_setting('test.e5')::uuid,
  'a user who left is skipped; the next in line is offered the slot'
);

set local role authenticated;
set local request.jwt.claim.sub = 'a1000000-0000-0000-0000-000000000005';

select is(
  public.leave_waitlist(current_setting('test.e5')::uuid)::text,
  'cancelled',
  'a user can decline an offer by leaving'
);

reset role;

select is(
  (select status::text from public.waitlist_entries
   where id = current_setting('test.e3b')::uuid),
  'offered',
  'declining passes the offer to the next user immediately'
);


-- ------------------------------------------------------------
-- A failed acceptance must not corrupt the offer
-- ------------------------------------------------------------

-- A booking appears by a route that does not honour offers
-- (trusted back-office write). The exclusion constraint is the
-- final authority and must still refuse the acceptance.
insert into public.bookings (
  id, user_id, facility_id, slot_id, booking_date,
  start_time, end_time, amount, status, payment_status, expires_at
)
values (
  'd1000000-0000-0000-0000-000000000003',
  'a1000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000001',
  current_date + 4, '18:00', '19:00', 500,
  'confirmed', 'paid', null
);

set local role authenticated;
set local request.jwt.claim.sub = 'a1000000-0000-0000-0000-000000000003';

select throws_ok(
  $$ select * from public.accept_waitlist_offer(current_setting('test.e3b')::uuid) $$,
  '23P01', null,
  'accepting is refused when the slot was taken by another route'
);

reset role;

select results_eq(
  $$
    select status::text, booking_id is null
    from public.waitlist_entries
    where id = current_setting('test.e3b')::uuid
  $$,
  $$ values ('offered', true) $$,
  'a failed acceptance leaves the entry offered and unlinked'
);

select is(
  (select count(*)::integer from public.bookings
   where user_id = 'a1000000-0000-0000-0000-000000000003'),
  0,
  'a failed acceptance creates no booking'
);


-- ============================================================
-- H. Housekeeping
-- ============================================================

insert into public.waitlist_entries
  (user_id, facility_id, slot_id, booking_date)
values (
  'a1000000-0000-0000-0000-000000000002',
  'b1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000002',
  current_date - 1
);

do $$
begin
  perform public.process_waitlist();
end;
$$;

select is(
  (select status::text from public.waitlist_entries
   where user_id = 'a1000000-0000-0000-0000-000000000002'
     and slot_id = 'c1000000-0000-0000-0000-000000000002'),
  'expired',
  'waiting entries for dates that have passed are closed'
);

select is(
  public.process_waitlist(),
  0,
  'repeated processing issues no further offers'
);


select * from finish();

rollback;
