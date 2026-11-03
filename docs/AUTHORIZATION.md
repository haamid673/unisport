# Authorization

Three roles exist: `user` (a player), `owner` and `admin`
(`public.user_role`). Hiding a screen from a role in the UI is a convenience.
**Every permission below is enforced by the database**, and the pgTAP suite
(`supabase/tests/database`) tests each rule, including as other users.

## How roles are held and changed

- A profile row is created for every Auth user by the `handle_new_user()`
  trigger, always as `user`.
- Clients may update only `full_name`, `phone`, `city` and `avatar_url` of
  their own profile (column-level grants). `role`, `id` and timestamps are
  not writable by any client.
- The `profiles_prevent_role_escalation` trigger refuses a role change unless
  the caller is an administrator. It stays enabled; it is never disabled to
  make a change.
- Administrators change roles with `admin_set_user_role(user, role)`:
  admin-only, never on one's own account (UB007), never removing the last
  administrator (UB008), and serialised so two administrators demoting each
  other at once cannot leave none. They find an account with
  `admin_find_user_by_email(email)`, an exact match; there is no way to list
  or browse accounts.
- The **first** administrator is made once per database outside the app:
  `supabase/dev/bootstrap_first_admin.sql` (local; deletes and re-inserts the
  account's profile, since INSERT is not guarded) or the manual statement in
  [DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md) for a hosted project.

## What each role can do

| Capability | Player | Owner | Admin | Enforced by |
|---|---|---|---|---|
| Browse active venues and slots | yes | yes | yes | RLS on `facilities`, `facility_slots` (status `active`) |
| See availability of a slot | yes | yes | yes | `get_slot_availability()` (no booker identity returned) |
| Reserve a slot (10-minute unpaid hold) | yes | yes | yes | `create_booking()` |
| Cancel **own** unpaid hold | yes | yes | yes | `cancel_booking()` (UB005 for paid, UB006 if a payment is in flight) |
| Join / leave / accept a waitlist offer | yes | yes | yes | `join_waitlist()`, `leave_waitlist()`, `accept_waitlist_offer()` |
| See own bookings | yes | yes | yes | RLS on `bookings` (own rows) |
| See bookings of own venues (read-only) | no | yes | yes | RLS on `bookings` |
| Create a venue | no | yes (starts `pending`) | yes | RLS insert policy requires status `pending` for owners |
| Edit own venue, hours and slots | no | yes | yes | RLS + column grants; owners cannot change `status` or `owner_id` |
| Approve, reject, suspend a venue | no | no | yes | `admin_set_facility_status()` |
| Start a community, create an event, join/leave | yes | yes | yes | `create_group`, `create_event`, `join_*`, `leave_*` |
| Community or event goes live immediately | no (pending) | no (pending) | yes | decided inside `create_group` / `create_event` |
| Approve or reject communities and events | no | no | yes | `admin_set_group_status()`, `admin_set_event_status()` |
| Read own notifications, mark them read | yes | yes | yes | `get_my_notifications()`, `mark_notifications_read()` |
| Change roles, look up an account by email | no | no | yes | `admin_set_user_role()`, `admin_find_user_by_email()` |

## Closed tables and revoke-first grants

New tables start with nothing granted to `anon` or `authenticated`. The
community tables, `notifications`, `payment_events` and
`reconciliation_runs` are closed to clients entirely (RLS on, no policies, no
grants). The payment tables a person may see (`payments`, `refunds`,
`payment_attempts`) are read-only through RLS. The app reaches the closed tables only through `SECURITY DEFINER` functions
that check the caller themselves. Every such function sets
`search_path = ''` and grants `EXECUTE` to `authenticated` and `service_role`
only, never `PUBLIC` or `anon`.

Two catalog tests fail when anyone adds a table or function and forgets this:
`table_privileges_test.sql` (every table accounted for) and
`payment_privileges_catalog_test.sql` (the exact allow-list of routines a
client may execute).

## Secrets

Only the publishable (anon) key reaches the browser, and the app refuses to
start if it recognises a secret key in a `VITE_*` variable. Payment secrets
live only in Edge Function environment files. `npm run guards` scans tracked
files for private keys, `sb_secret_`, live keys and service-role JWTs.
