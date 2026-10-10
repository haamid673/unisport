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
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
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

Still mock-backed (localStorage, not yet on Supabase): bookings and
payments, community groups/events, the admin user list, and the owner and
admin dashboards (they use the mock facility service). These are keyed by
mock ids, so seeded demo data does not belong to a real signed-in user.

**Checkout is disabled** (`CUSTOMER_CHECKOUT_ENABLED = false` in
`services/bookingService.ts`): the mock checkout cannot create bookings
for real slots, so slots show "Soon" until booking goes through the
`create_booking()` RPC and a real payment flow.

## Development data (local only)

A fresh local database has no facilities. To load a small realistic set:

1. `supabase start`, then sign up in the app with the email you want as
   the facility owner (no fake users are ever inserted into `auth.users`).
2. Promote that profile to `owner` (the role-guard trigger is lifted for
   this one local statement):

   ```sql
   alter table public.profiles disable trigger profiles_prevent_role_escalation;
   update public.profiles set role = 'owner'
     where id = (select id from auth.users where email = 'you@example.com');
   alter table public.profiles enable trigger profiles_prevent_role_escalation;
   ```
3. Run the seed:

   ```bash
   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
        -v owner_email=you@example.com \
        -f supabase/dev/seed_dev_facilities.sql
   ```

The script is idempotent (fixed ids), refuses to run unless the database
identifies itself as the local Supabase stack, and fails with a clear
message when the owner does not exist or is not an owner. It is not
`supabase/seed.sql`, so `supabase db reset` never runs it automatically.
