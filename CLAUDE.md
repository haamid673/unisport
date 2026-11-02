# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

UniSport: a sports-facility booking app. React 19 + TypeScript + Vite front end, Supabase (Postgres, Auth, Edge Functions) behind it. The README and `docs/` are accurate and detailed; read `docs/ARCHITECTURE.md`, `AUTHORIZATION.md`, `DATABASE.md` and `BOOKING.md` before changing behaviour.

## Commands

```bash
npm run dev                  # Vite on :3000 (needs .env.local: VITE_SUPABASE_URL + VITE_SUPABASE_PUBLISHABLE_KEY)
npm test                     # Vitest, all unit tests
npx vitest run path/to/file.test.ts            # one file
npx vitest run -t "name fragment"              # one test by name
npm run lint                 # tsc --noEmit (there is no ESLint)
npm run build                # production build
npm run guards               # repo guards (migration names/order, secrets, no hosted commands)
npm run guards:dist          # same + built output has no CDN (run after build)

supabase start               # local Postgres/Auth, applies every migration
supabase test db             # pgTAP suite, LOCAL STACK ONLY
cd supabase/functions && deno test tests/      # payment Edge Function tests (not in CI)
```

Run a single pgTAP file against a disposable local stack with an **unlinked** workdir and an explicit `--db-url "postgresql://postgres:postgres@127.0.0.1:<port>/postgres?sslmode=disable"` (the `?sslmode=disable` is required).

## Hard rules for this repo

- **Never touch a hosted Supabase project.** The repo's `supabase/.temp` links one. Do not use `--linked`, `db push`, `db reset`, `migration repair` or the generated `db diff` DROP script; CI guards (`scripts/repoGuards.ts`) fail on these in workflows/scripts. Use an unlinked temp workdir (copy `supabase/config.toml`, `migrations/`, `tests/`; no `.temp`) plus `--db-url` for any CLI call against a local stack. Applying a migration to the developer's main local stack (`unisport-ui`, ports 54321/54322) needs the user's explicit approval each time; run the SQL suite only on a disposable stack because the multi-session suites COMMIT fixtures.
- Migrations are **forward-only and append-only**: add a new file timestamped after the latest one; never edit an applied migration.
- Don't change the visual theme or core features; fix UI only where genuinely broken. Don't print passwords, tokens or JWTs. No live Razorpay keys, ever; payments are simulator-backed only.
- Commit/push only when asked; commits end with the `Co-Authored-By` line the session specifies.

## Architecture (the parts that span files)

- **The database is the authority.** Screens never hold business rules and never read localStorage for data. Every write with a rule goes through a `SECURITY DEFINER` function (`create_booking`, `cancel_booking`, `join_waitlist`, `create_group`, `join_event`, `admin_*`, `get_my_notifications`, …) that takes the caller from `auth.uid()`. Community, notifications and payment-internal tables are closed to clients (RLS on, no policies, no grants). New tables/functions must be added to the allow-lists in `supabase/tests/database/table_privileges_test.sql` and `payment_privileges_catalog_test.sql` or those tests fail by design.
- **Layers in the app:** `components/` (render + handlers) → `services/*Repository.ts` (the only code that calls Supabase; validate input, call one RPC/query, map the answer, raise typed errors with safe messages; a malformed answer is a failure, never success; no mock fallback) → pure helpers (`slotAvailability`, `routes`, `notificationText`, `bookingDate`). Mutations run under `createSingleFlight()` and re-read state in `finally`.
- **Routing:** `services/routes.ts` is the route table and role guard (`/`, `/owner`, `/admin`, `/community[/:id]`, `/profile`, `/auth`); `App.tsx` derives the active tab from the URL, lazy-loads every screen, honours `VITE_BASE_PATH`. Guards are convenience only.
- **Booking model:** a booking is a 10-minute unpaid `pending_payment` hold; an exclusion constraint prevents double booking; waitlist offers last 15 min and are exclusive; `pg_cron` runs `expire_pending_bookings`, `process_waitlist`, `notify_expiring_offers` every minute. Lock order everywhere: user advisory lock → per-(slot,date) advisory lock → rows (communities: group row → event row). Notifications are produced by triggers on the source tables, deduplicated by `(user_id, dedupe_key)`.
- **Roles:** `profiles.role` is changed only by `admin_set_user_role` (the escalation trigger stays enabled; never disable triggers/RLS in tests or scripts). The first admin is bootstrapped by `supabase/dev/bootstrap_first_admin.sql` (delete-and-reinsert profile).
- **Payments are built but OFF.** Enabled only if `VITE_RAZORPAY_TEST_KEY_ID` is a test key id. Server side: Edge Functions in `supabase/functions/` (shared logic in `_shared/`), tested against the local simulator in `supabase/payment-simulator/` (never deployed). See `docs/PAYMENTS.md` and `supabase/functions/README.md`.
- **Time is UTC** (`current_date`); the date picker defaults to the later of local and UTC date (`services/bookingDate.ts`).
- `services/storageService.ts` survives only for `legacyCleanup` (purges old demo keys from browsers) and `cityPreference`; the old mock services (`facilityService`, `eventService`, `bookingService`, `paymentService`, `aiEngine`) and `PaymentPage` were deleted, and a test asserts they stay gone.

## Tests

- **Vitest** includes fake-client repository tests and "source-shape" tests that read a component's source and assert structure (single-flight guard, no `alert()`, no local data, no `console.log` anywhere in app/scripts). Renaming things in components can break these on purpose; update the test with the change.
- **pgTAP** (`supabase/tests/database`): single-transaction files roll back; `*_concurrency_test.sql` files use `dblink` and refuse to run unless the DB identifies as the local stack. Make admins by deleting and re-inserting a profile, never by disabling a trigger. Behaviour that matters is proven here, and concurrency tests are mutation-checked (remove a lock on a disposable DB and confirm the test fails, then restore).
- Local environment: ports and fixtures differ per stack (`unisport-ui` is the user's manual-test data; `unisport-slice1h` is the disposable test stack). Check which one a command targets.
