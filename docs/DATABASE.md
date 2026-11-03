# Database

Everything lives in `supabase/migrations/` (40 files, forward-only, applied in
timestamp order). A migration that has been applied anywhere is never edited;
fixes are new files. CI fails if a migration is renamed, removed or added
out of order (`npm run guards`), and applies all of them to a fresh Postgres
before running the database tests.

## Tables

| Table | Purpose | Client access |
|---|---|---|
| `profiles` | one row per Auth user: name, phone, city, avatar, **role** | own row; `full_name`, `phone`, `city`, `avatar_url` updatable |
| `facilities` | venues: owner, sport, address, city, base price, **status** (`pending`, `active`, `suspended`, `rejected`) | active ones to everyone; own to owners; all to admins; writes via RLS + column grants |
| `facility_operating_hours` | open/close per weekday, or closed | via RLS (`owns_facility()`) |
| `facility_slots` | one-hour bookable slots with a price; times freeze once a booking or waitlist entry references them | via RLS |
| `facility_images` | planned (no storage bucket yet) | via RLS |
| `bookings` | a slot on a date for a user; status `pending_payment`, `confirmed`, `completed`, `cancelled`, `expired`; amount and expiry set by the database | read own (and own venues'); **no direct writes** |
| `waitlist_entries` | queue per slot and date: `waiting`, `offered`, `accepted`, `expired`, `cancelled` | read own; **no direct writes** |
| `community_groups`, `group_members`, `community_events`, `event_participants` | communities and events with approval | **closed**; via functions |
| `notifications` | in-app notifications, one per event per person | **closed**; via functions |
| `payments`, `refunds`, `payment_attempts` | payment records, written only by the server | read-only through RLS (the payer, and the venue owner or an administrator where the policy allows) |
| `payment_events`, `reconciliation_runs` | payment audit and reconciliation | **closed** |

## Functions (the application's API)

| Area | Functions |
|---|---|
| Booking | `create_booking`, `cancel_booking`, `get_slot_availability`, `expire_pending_bookings` (cron) |
| Waitlist | `join_waitlist`, `leave_waitlist`, `accept_waitlist_offer`, `offer_next_waitlist_entry`, `expire_waitlist_offers`, `process_waitlist` (cron) |
| Community | `create_group`, `join_group`, `leave_group`, `create_event`, `join_event`, `leave_event`, `get_community_groups`, `get_community_events` |
| Notifications | `get_my_notifications`, `mark_notifications_read`, `notify_expiring_offers` (cron); triggers produce the rest |
| Admin | `admin_set_facility_status`, `admin_find_user_by_email`, `admin_set_user_role`, `admin_list_community_groups/events`, `admin_set_group_status`, `admin_set_event_status` |
| Payments | `payment_*` functions, callable only by the Edge Functions with the service role |
| Helpers | `is_admin()`, `owns_facility()` (used inside RLS policies) |

All client-callable functions are `SECURITY DEFINER` with an empty
`search_path`, take the caller from `auth.uid()` (never from an argument),
and grant `EXECUTE` to `authenticated` and `service_role` only.

## Integrity enforced by the database itself

- **No double booking:** an exclusion constraint on live bookings of the same
  slot and date (`btree_gist`), so two people can never both hold a slot even
  if the application misbehaves.
- **Limits:** at most 3 live unpaid holds per user (UB001) and 10 active
  waitlist entries (UB002); at most 5 community groups and 5 events waiting
  for approval per player (UC004).
- **Booking window:** today up to 30 days ahead (SQLSTATE 22007 / 22008).
- **Immutable history:** slot times and facility ids freeze once referenced.
- **One live offer per slot and date** (partial unique index).
- **Membership consistency:** leaving a community also leaves its events.
- **Notifications:** `(user_id, dedupe_key)` is unique, so an event can never
  notify twice.

## Concurrency

Every function that can race takes locks in one documented order: the user
advisory lock, then the per-(slot, date) advisory lock, then rows (for
communities: group row, then event row). The sweeper uses `SKIP LOCKED`, so it
never waits for a user action and a user action never waits for it. The
multi-session pgTAP files (`*_concurrency_test.sql`) drive real interleavings
and assert on `pg_locks`, not on sleeps; the mutation checks recorded in
[COMPLETION_PLAN.md](COMPLETION_PLAN.md) show those tests fail when a lock is
removed.

## Custom error codes

| Code | Meaning |
|---|---|
| UB001 / UB002 | too many live holds / too many waitlist entries |
| UB003 / UB004 | payment-related refusals |
| UB005 / UB006 | cancel: not an unpaid hold / a payment may be in flight |
| UB007 / UB008 | admin: own role / last administrator |
| UC001 | not a member of the community |
| UC002 | event full |
| UC003 | not open (not approved, or date passed) |
| UC004 | too many items awaiting approval |
| UC005 | a community with that name exists in the city |

Standard codes used: 28000 (not signed in), 42501 (not allowed), 22023 (bad
argument), 22007/22008 (date), P0002 (not found), 23P01 (slot taken).

## Local development

```bash
supabase start                 # applies every migration to a local database
supabase test db               # runs supabase/tests/database (pgTAP)
```

Dev data: sign up in the app, make a first administrator with
`supabase/dev/bootstrap_first_admin.sql`, make an owner in the Governance
Center, then run `supabase/dev/seed_dev_facilities.sql` (it never overwrites
existing venues). Details in the README. Never use `--linked`, `db push`,
`db reset` or `migration repair` against a hosted project; see the runbook.
