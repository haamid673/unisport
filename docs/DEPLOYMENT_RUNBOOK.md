# Hosted deployment runbook (DRAFT — for review, never executed)

Status: **written, not run.** Nothing in this document has been applied to any
hosted project. Every step marked **GATE** needs the owner's explicit approval
at the moment it is done. The repository's automation (`npm run guards`) fails
if a workflow or script contains `supabase link`, `--linked`, `db push`,
`migration repair` or `--project-ref`, so none of this can happen by accident.

Hard rules, restated:

1. Never run `supabase db push`, `db reset`, `migration repair` or any `--linked`
   command from a developer machine or CI. Hosted changes are applied by the
   owner, deliberately, as described below.
2. Never run the `supabase db diff` output from a linked checkout: it was a
   generated list of `DROP` statements for a database that differs from the
   migrations, and it is not a migration.
3. Only the **publishable** (anon) key ever reaches the browser. The
   service-role and secret keys stay out of every `VITE_*` variable and out of
   the repository.

## 1. Decisions still open

| Decision | Options | Needed before |
|---|---|---|
| Static hosting for the built app (D7) | Cloudflare Pages, Netlify, Vercel, GitHub Pages, any static host or object store + CDN | step 5 |
| Transactional email provider (SMTP) for sign-up confirmation and password reset | Resend, Postmark, SES, the host's built-in | step 4 (Auth) |
| Whether to enable email confirmation on the hosted project | yes (recommended once SMTP exists) / no | step 4 |
| Payments | **Off.** Decision D6: the demo uses the local simulator only; no live Razorpay. The payment Edge Functions are not deployed and no `VITE_RAZORPAY_TEST_KEY_ID` is set | — |

## 2. Prerequisites

- A **new, empty** hosted Supabase project dedicated to UniSport (do not reuse
  the project that was linked during development).
- The database password, kept in the owner's password manager.
- A fresh backup point (see §6) before the first change.
- CI green on the commit being released (tests, lint, build, repository guards,
  built-output guard, database suite).

## 3. Confirm the target is the right, empty project (read-only) — GATE

Run by the owner, with the connection string from the dashboard (Settings →
Database), never from a linked checkout:

```sql
select current_database(), current_user, version();
select count(*) as app_tables
from information_schema.tables
where table_schema = 'public';                      -- expect 0
select count(*) from supabase_migrations.schema_migrations;  -- expect 0 (or the table absent)
select count(*) from auth.users;                    -- expect 0
```

Stop if any count is not zero or the project reference is not the intended one.
Record the project reference and the date here: `__________`.

## 4. Supabase project settings (dashboard) — GATE

- **Extensions:** enable `pg_cron` (Database → Extensions). The migrations
  schedule three jobs only if it is available; otherwise they log a warning and
  the sweeper, waitlist processing and expiring-offer notifications would not
  run. After step 6, check `select jobname, schedule, active from cron.job;`
  lists `expire-pending-bookings`, `process-waitlist`, `notify-expiring-offers`.
- **Auth → URL configuration:** Site URL = the production origin (including the
  base path if any); Redirect URLs = that origin with a `/**` wildcard (the
  password-reset link returns to `<origin>/reset-password`) and any preview
  origin. The
  local value `http://127.0.0.1:3000` must not remain.
- **Auth → Providers → Email:** confirmations on once SMTP is configured; set
  a minimum password length of at least 8 (the local default is 6); keep
  sign-ups enabled (players register themselves).
- **Auth → SMTP:** the chosen provider; sender domain with SPF/DKIM.
- **Rate limits:** leave the defaults or tighten; review before launch.
- **API:** leave the exposed schema as `public`. All tables are closed or
  protected by RLS and revoke-first grants; `supabase/tests/database` proves it.

## 5. Static hosting

Build: `npm ci && npm run build` with exactly these variables (public by design):

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<publishable key>
# VITE_BASE_PATH=/subpath/   only if not served from the domain root
```

Output is `dist/`. It is a single-page app with client-side routes
(`/`, `/owner`, `/admin`, `/community`, `/community/:id`, `/profile`, `/auth`),
so the host **must serve `index.html` for any path that is not a file** (SPA
fallback), under the base path if one is used:

| Host | Rule |
|---|---|
| Cloudflare Pages | add `dist/_redirects`: `/*  /index.html  200` |
| Netlify | same `_redirects` file, or `[[redirects]] from="/*" to="/index.html" status=200` |
| Vercel | `vercel.json`: `{"rewrites":[{"source":"/(.*)","destination":"/index.html"}]}` |
| GitHub Pages | copy `index.html` to `404.html` (and use `VITE_BASE_PATH=/<repo>/`) |
| nginx | `location / { try_files $uri /index.html; }` |

Verified locally with a sub-path build served by `vite preview`: deep links,
refresh, back/forward and the post-sign-in return all work.

Response headers worth setting at the host: `Content-Security-Policy` (the app
needs `connect-src` for the Supabase origin and `img-src` for its images, plus
`script-src`/`frame-src` for `checkout.razorpay.com` only if payments are ever
enabled), `X-Content-Type-Options: nosniff`, `Referrer-Policy:
strict-origin-when-cross-origin`, long-lived caching for `/assets/*` (hashed
file names) and no caching for `index.html`.

## 6. Database rollout — GATE (each statement of intent confirmed at the moment)

**Backup first:** enable PITR or take a manual backup from the dashboard and
note its timestamp. On a fresh project this is cheap insurance.

**Apply the migrations in this exact order**, as one forward-only sequence
(the owner runs the files in the SQL editor or with the CLI against the
hosted connection string, after confirming §3). The 40 files, oldest first:

1. `20261008135629_foundation.sql`
2. `20261008135914_facilities.sql`
3. `20261008140109_facility_scheduling.sql`
4. `20261008140917_bookings_payments.sql`
5. `20261008142050_booking_rpc.sql`
6. `20261010175500_fix_booking_date_constraint.sql`
7. `20261010175600_expire_pending_bookings.sql`
8. `20261010175700_schedule_booking_expiration.sql`
9. `20261010180000_waitlist_entries.sql`
10. `20261010180100_waitlist_aware_create_booking.sql`
11. `20261010180200_waitlist_functions.sql`
12. `20261010180300_schedule_waitlist_processing.sql`
13. `20261010180400_serialize_booking_with_waitlist_offers.sql`
14. `20261010180500_accept_waitlist_lock_order.sql`
15. `20261010180600_get_slot_availability.sql`
16. `20261010180700_require_pending_status_on_facility_insert.sql`
17. `20261010180800_booking_horizon.sql`
18. `20261010180900_per_user_booking_limits.sql`
19. `20261010181000_restrict_profile_self_edit.sql`
20. `20261010181100_least_privilege_table_grants.sql`
21. `20261011190000_harden_security_definer_search_paths.sql`
22. `20261012190000_restrict_trigger_function_execution.sql`
23. `20261013190000_prevent_overlapping_facility_slots.sql`
24. `20261014190000_prevent_overlapping_bookings_per_facility.sql`
25. `20261014190100_expire_stale_holds_per_facility.sql`
26. `20261014190200_prevent_slot_facility_change.sql`
27. `20261015190000_wait_on_locked_expired_holds.sql`
28. `20261016190000_freeze_slot_times_with_live_references.sql`
29. `20261017190000_freeze_clock_utc_and_lock_slot_on_waitlist_join.sql`
30. `20261018190000_payment_attempts_and_observed_payments_schema.sql`
31. `20261019190000_payment_order_and_settlement_functions.sql`
32. `20261020190000_payment_window_policy.sql`
33. `20261021190000_payment_verification_and_retryable_conflicts.sql`
34. `20261022190000_payment_hold_seconds_remaining.sql`
35. `20261023190000_payment_checkout_lease.sql`
36. `20261024190000_payment_settlement_decisions_and_lease_state.sql`
37. `20261025190000_cancel_booking.sql`
38. `20261026100000_admin_functions.sql`
39. `20261027100000_community.sql`
40. `20261028100000_notifications.sql`

**All 40 ship, including the 7 payment migrations** (`20261018…`–`20261024…`).
This is deliberate: later migrations depend on them (`cancel_booking` reads
`payment_attempts`), the schema is simpler to reason about when hosted equals
local, and with no Edge Functions deployed and no key configured the payment
tables simply stay empty and the UI keeps payment switched off.

After applying, verify (read-only):

```sql
select count(*) from supabase_migrations.schema_migrations;   -- 40 if the CLI recorded them
select jobname, active from cron.job order by 1;               -- the three jobs
select count(*) from pg_proc where proname in
  ('create_booking','cancel_booking','join_waitlist','create_group','join_event',
   'admin_set_user_role','get_my_notifications');                -- 7
select relname, relrowsecurity from pg_class
where relnamespace = 'public'::regnamespace and relkind = 'r'
order by 1;                                                      -- every table true
```

Then run the same database suite the CI runs, against a **disposable local**
stack (never the hosted one). The hosted database is not a place to run
`supabase test db` (the multi-session tests commit fixtures and refuse to run
anywhere but the local stack).

## 7. First administrator (hosted)

`supabase/dev/bootstrap_first_admin.sql` refuses anything but the local stack,
by design. On hosted, after the owner has signed up through the app with the
address that should administer it, run in the SQL editor (profile INSERTs are
not guarded; the role-protection trigger stays enabled):

```sql
begin;
create temp table _p on commit drop as
  select p.* from public.profiles p join auth.users u on u.id = p.id
  where lower(u.email) = lower('ADMIN-EMAIL-HERE') and p.role <> 'admin';
-- expect exactly one row
select count(*) from _p;
delete from public.profiles where id in (select id from _p);
insert into public.profiles (id, full_name, phone, city, avatar_url, role)
  select id, full_name, phone, city, avatar_url, 'admin' from _p;
commit;
```

Every later promotion is done in the Governance Center. Do not run the dev
seed (`seed_dev_facilities.sql`) on hosted; venues come from real owners.

## 8. Smoke test after the release

As three real accounts (player, owner promoted by the admin, admin):
sign up and sign in; owner creates a venue; admin approves it; player sees it,
reserves a slot (10-minute hold), cancels it; a second player joins the
waitlist and receives the offer notification; create and approve a community
and an event; join it; mark notifications read. Check no request goes to a
third-party host except Supabase (browser network panel).

## 9. Rollback

- **Frontend:** redeploy the previous build (keep the last two `dist/`
  artifacts). Safe at any time; the database is forward-compatible with the
  previous build for one release as long as migrations only add.
- **Database:** migrations are forward-only. If a migration fails midway, fix
  forward with a new, later migration. If the data is damaged or the schema is
  in an unknown state, **restore the §6 backup** (project-level restore) and
  re-run from the last good migration. Never "repair" the migration history
  by hand.
- **Kill switches:** disable sign-ups in Auth settings; revoke `EXECUTE` on
  `create_booking` from `authenticated` to stop new reservations (this is the
  database-level equivalent of the UI's `RESERVATIONS_ENABLED`); unschedule a
  cron job with `select cron.unschedule('<name>')`.

## 10. After launch

Monitor: Auth and database logs in the dashboard, cron job run history
(`cron.job_run_details`), error rate in the host. Schedule: dependency updates,
a periodic `npm audit`, and a review of Auth rate limits. Email, SMS and push
notifications remain out of scope for the MVP (see `docs/MVP_BACKLOG.md`).
