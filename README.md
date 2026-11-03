# UniSport

A sports-facility booking platform: players find a venue, hold a slot, join a
waitlist when it is full and join communities and events; venue owners run
their venues; administrators approve venues, communities and events and
manage roles.

React 19 + TypeScript + Vite on the front end; Supabase (Postgres, Auth, Edge
Functions) behind it. **The database is the authority**: the browser asks, the
database decides, and the UI shows only what the database answered.

![Player home](docs/screenshots/01-player-home.jpg)

| | |
|---|---|
| ![Waitlist offer on a slot](docs/screenshots/02-waitlist-offer-on-slot.jpg) | ![Cancel with confirmation](docs/screenshots/03-cancel-with-confirm.jpg) |
| A waitlist offer on its slot row | Cancelling an unpaid hold asks first |
| ![Governance Center](docs/screenshots/04-admin-governance-center.jpg) | ![Notifications](docs/screenshots/07-notifications-bell.jpg) |
| Governance Center (admin) | The notification bell |

(Screenshots are from a local development database with test accounts.)

## What it does

- **Players:** browse active venues by city, see live slot availability,
  reserve a slot (a 10-minute unpaid hold), cancel their own hold, join a
  slot's waitlist and accept an offer when it frees up, see a truthful booking
  history, start and join communities and events, and get in-app
  notifications.
- **Owners:** create venues (they start *pending*), set weekly hours and
  slots, switch slots on and off, and see their venues' bookings.
- **Administrators (Governance Center):** approve, reject or suspend venues,
  approve or reject communities and events, and look up an account by its full
  email to change its role. Every action is confirmed and re-read.
- **In the database:** no double booking (an exclusion constraint), per-user
  limits, a booking window, exclusive waitlist offers, capacity-safe event
  joins, notifications that cannot repeat, and role changes that cannot
  remove the last administrator.

Payments exist but are **switched off** (see Known limitations).

## Quick start (local)

Prerequisites: Node.js 22, Docker and the Supabase CLI.

```bash
npm ci
supabase start                       # local Postgres + Auth, applies every migration
cp .env.example .env.local           # then set the two VITE_ values from `supabase status`
npm run dev                          # http://localhost:3000
```

Only the **publishable** key belongs in `.env.local`; the app refuses to start
if it sees a secret key in a `VITE_*` variable. A fresh database has no
venues: follow the demo script, [docs/DEMO.md](docs/DEMO.md), which creates
the three roles and walks the whole product.

Commands:

```bash
npm test               # unit tests (Vitest)
npm run lint           # type-check
npm run build          # production build (no CDN, split bundles)
npm run guards         # repository checks (migrations, secrets, no hosted commands)
supabase test db       # database tests (pgTAP) — local stack only
```

## Documentation

| Document | What it covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | the pieces, the data-flow diagram, layers, routing, time |
| [docs/AUTHORIZATION.md](docs/AUTHORIZATION.md) | roles, what each can do, who enforces it, closed tables |
| [docs/DATABASE.md](docs/DATABASE.md) | tables, functions, integrity rules, concurrency, error codes |
| [docs/BOOKING.md](docs/BOOKING.md) | holds, cancel, availability, the waitlist |
| [docs/PRICING.md](docs/PRICING.md) | how prices work (and what does not exist) |
| [docs/PAYMENTS.md](docs/PAYMENTS.md) | the payment design, the simulator, what is and is not verified |
| [docs/TESTING.md](docs/TESTING.md) | the test layers, how to run them, CI |
| [docs/DEMO.md](docs/DEMO.md) | a repeatable demo with the three roles |
| [docs/DEPLOYMENT_RUNBOOK.md](docs/DEPLOYMENT_RUNBOOK.md) | the reviewed plan for a hosted rollout (not executed) |
| [docs/COMPLETION_PLAN.md](docs/COMPLETION_PLAN.md), [docs/MVP_BACKLOG.md](docs/MVP_BACKLOG.md) | how the product was completed, with results, and what remains |

## Project layout

```
App.tsx, components/      screens (no business rules)
services/                 repositories (the only code that talks to Supabase) and pure helpers
supabase/migrations/      the schema and every rule (forward-only)
supabase/tests/database/  pgTAP tests, including multi-session concurrency
supabase/functions/       payment Edge Functions (off by default)
supabase/payment-simulator/  local stand-in for Razorpay (never deployed)
supabase/dev/             local-only scripts: first admin, dev venues
scripts/                  repository guards
e2e/checkout-browser/     local browser run of the checkout UI against a mock
```

## Known limitations

- **Payments are off.** A reservation is an unpaid 10-minute hold that expires
  by itself. The payment code is complete and tested against a local
  **simulator only**; it has never talked to Razorpay, no live key is used,
  and refunds are not implemented. A paid booking cannot be cancelled in the
  app.
- **No SMS or push; email only for sign-in help.** Notifications are in-app
  only. Password reset sends an email through Supabase Auth (the built-in
  sender is very low-volume; use an SMTP provider for real traffic).
- **Time is UTC.** The database's day is UTC; venues have no time zone.
- **No image upload.** Venue photos are bundled defaults per sport.
- **Profile bio and preferences are saved in the browser only** (the form says
  so); name and phone are saved to the account.
- **No booking or payment oversight screens** for administrators (the
  Governance Center has an audit trail of venue, community, event and role
  decisions).
- **Browser testing is light:** one Playwright smoke journey, run by hand.
  Other features were verified in a real browser by hand.
- **Not deployed anywhere.** The hosted plan is written, not executed:
  [docs/DEPLOYMENT_RUNBOOK.md](docs/DEPLOYMENT_RUNBOOK.md).

## Development data (local only)

A fresh local database has no venues.

1. `supabase start`, then register in the app with the email you want as the
   venue owner (no fake users are ever inserted into `auth.users`).
2. Make a first administrator once per local database (no trigger is
   disabled; see the header of the script):

   ```bash
   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
        -v admin_email=admin@example.com \
        -f supabase/dev/bootstrap_first_admin.sql
   ```

   Sign in as that administrator, open the Governance Center, look up the
   owner by full email and change the role to `owner`.
3. Either let the owner create a venue in the app and approve it as the
   administrator (the real flow), or load six sample venues:

   ```bash
   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
        -v owner_email=you@example.com \
        -f supabase/dev/seed_dev_facilities.sql
   ```

Both scripts are idempotent, refuse to run unless the database identifies as
the local Supabase stack, and never overwrite existing data. The seed is not
`supabase/seed.sql`, so `supabase db reset` never runs it automatically.

## Deployment

Static files plus a Supabase project. Read
[docs/DEPLOYMENT_RUNBOOK.md](docs/DEPLOYMENT_RUNBOOK.md) first: nothing is
ever applied to a hosted project without an explicit decision, and the
repository's automation refuses commands that could do so by accident.
Set `VITE_BASE_PATH` to deploy under a sub-path; the host must serve
`index.html` for unknown paths (SPA fallback).
