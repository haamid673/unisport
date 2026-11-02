<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/149dbc7e-c03b-4e1f-b277-7616fbbdc3e7

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Configure Supabase (see the next section).
3. Run the app:
   `npm run dev`

## Supabase (authentication)

Sign-in, sign-up and sessions use Supabase Auth. The database
(`supabase/migrations`) owns profiles, roles and authorization.

1. Start the local stack: `supabase start` (applies the migrations).
2. `cp .env.example .env.local`, then set `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_PUBLISHABLE_KEY` from `supabase status`.
3. `npm run dev`. If the variables are missing the app shows a
   configuration error instead of a login screen.

Only the **publishable** key may be used in the browser; never put a
`sb_secret_...` / service-role key in a `VITE_*` variable.

How it works:

- `services/supabaseClient.ts`: the single client, validated from env.
- `services/authService.ts`: sign-up / sign-in / sign-out, session
  restoration and profile loading. The `public.profiles` row is created
  by the database trigger `handle_new_user()`; the role is read from it
  and never from user metadata or localStorage.
- `App.tsx` subscribes to the auth state and shows a loading spinner
  until the stored session has been restored.

Tests: `npm test` (unit tests with a fake client, no network).

Facility browsing (customer view) reads facilities and slots from
Supabase through `services/facilityRepository.ts`. A failed read shows
an error with a Retry button; it is never replaced by mock data.

Slot availability for the open facility and date comes from the database
function `get_slot_availability(facility_id, date)` (migration
`20261010180600`), called through `facilityRepository.loadSlotAvailability()`.
It returns one status per slot (`available`, `booked`, `offer_held`,
`inactive`, `closed`) and nothing about who booked. Expired payment holds
and expired waitlist offers are read from the clock, so they count as free
even before the cron sweep updates them. The answer is a snapshot, not a
reservation: `create_booking()` is still the authority. A failed read
shows an error with Retry; slots are never assumed available.

**Facility approval** (migration `20261010180700`): a facility created by an
owner must start with status `pending`; an insert with `active`, `suspended`
or `rejected` is refused, so owners cannot self-approve. Only an admin can
activate a facility (change `pending` to `active`), and admins do it in the
Governance Center through `admin_set_facility_status()` (migration
`20261026100000`).

**Limits enforced by the database** (migrations `20261010180800`,
`20261010180900`; the UI is not the control):

- at most 3 *live* unpaid holds per user (`pending_payment` with
  `expires_at` still in the future); error `UB001`. A user holding a live
  waitlist offer for a slot may still book/accept that slot at the cap.
- at most 10 *active* waitlist entries per user (waiting for a future date,
  or offered with the offer still open); error `UB002`.
- bookings, waitlist joins and availability reads accept dates up to
  `current_date + 31` (error `22008`). This is a **temporary
  compatibility bound** (UI allows 30 days from the browser's local date,
  the server only knows the UTC date); replace it when facilities get a
  time zone.

Counts use the clock, so expired holds and offers free capacity even before
the cleanup job runs. Per-user actions are serialised by an advisory lock.
Every *blocking* path takes locks in the order user, slot, waitlist entry.
`leave_waitlist` takes an entry row lock first but only a non-blocking
try-lock on the slot, so it cannot create a blocking lock-order inversion.
Several accounts, rate limiting, CAPTCHA and retention of old rows are not
addressed here.

## What is implemented

Backed by Supabase (database rules and Row Level Security are the
authority; the UI only decides what to show):

- **Accounts:** sign-up, sign-in, sessions, profile name/phone. Roles
  are assigned in the database; sign-up always creates a `user`.
- **Customer:** facility discovery by city (the chosen city is remembered
  per user in this browser), slot availability, reservations, waitlists
  (join, leave, accept an offer) and a booking history on the profile.
- **Owner:** create and edit venues (always created `pending`), weekly
  operating hours, add slots and switch them on/off, and a read-only list
  of the venue's latest bookings.
- **Data integrity in the database:** no overlapping slots or bookings at
  one facility, a slot never changes facility, and a slot's times are
  frozen while live bookings or waitlist entries reference it.

**A reservation is an unpaid 10-minute hold.** It expires automatically.
Accepting a waitlist offer also creates a hold, not a paid booking.

## Communities and events

Stored in Supabase (migration `20261027100000_community.sql`). Players can
start a community, join and leave, and members of an approved community can
create events (at a live venue in the community's city, with an optional
capacity) and join them. Capacity is enforced by the database, also under
simultaneous joins. A player's new community or event is `pending` until an
administrator approves it in the Governance Center; administrators' own are
approved at once. The four tables are closed to clients: everything goes
through `SECURITY DEFINER` functions, so people see counts but never member
lists.

## Not implemented yet

- **Payments and booking confirmation:** there is no payment provider and
  nothing in the app turns a hold into a `confirmed` booking. Cancellation
  and refunds do not exist either. `components/PaymentPage.tsx` and
  `services/bookingService.ts` are leftover mock code that is not
  reachable from the UI (`CUSTOMER_CHECKOUT_ENABLED = false`).
- **Admin audit trail and booking oversight:** the Governance Center
  approves, rejects and suspends venues and changes roles, but does not keep
  a history of those actions and has no booking/payment oversight views.
- **Image uploads:** there is no storage bucket or upload UI. Venue images
  are bundled defaults (`public/images`) or external stock photos.
- **Notifications:** none (no email, SMS or push); offers and holds are
  only visible in the app.
- **Browser-only extras:** profile bio and preferences are stored in this
  browser, not in the database.

## Development data (local only)

A fresh local database has no facilities. To load a small realistic set:

1. `supabase start`, then sign up in the app with the email you want as
   the facility owner (no fake users are ever inserted into `auth.users`).
2. Make a first administrator once per local database (no trigger is
   disabled; see the header of the script):

   ```bash
   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
        -v admin_email=admin@example.com \
        -f supabase/dev/bootstrap_first_admin.sql
   ```

   Then sign in as that administrator, open the Governance Center and look
   up the owner's account by its full email to change its role to `owner`.
3. Run the seed:

   ```bash
   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
        -v owner_email=you@example.com \
        -f supabase/dev/seed_dev_facilities.sql
   ```

The script is idempotent (fixed ids; a re-run never overwrites existing
venues, so owner edits and admin decisions survive), refuses to run unless the database
identifies itself as the local Supabase stack, and fails with a clear
message when the owner does not exist or is not an owner. It is not
`supabase/seed.sql`, so `supabase db reset` never runs it automatically.
