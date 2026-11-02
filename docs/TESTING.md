# Testing

Four layers; the database ones matter most because the database holds the
rules.

| Layer | Tool | What it covers | Size at the last full run |
|---|---|---|---|
| Unit and source-shape | Vitest | repositories (fake client), pure helpers, screens' structure (guards, states, no local data, no `alert()`), routes, guard scripts | 39 files, 678 tests |
| Database | pgTAP via `supabase test db` | every table privilege, RLS rule, function refusal and happy path; the multi-session suites drive real concurrent interleavings | 36 files, 1,434 assertions |
| Edge Functions | Deno | payment functions against the local simulator; the simulator itself | ~180 + 27 tests (last recorded in Phase 0) |
| Repository guards | `npm run guards` | migration order and append-only, secrets, no hosted commands, env names, no CDN in `dist/` | 12 unit tests + the checks themselves |

Source-shape tests read a component's source and assert properties (for
example "uses the repository, not storage", "runs under a single-flight
guard", "re-reads in `finally`"). They are cheap and catch regressions in
structure; they do **not** prove behaviour. Behaviour that matters is proven
in the database suite or checked in a real browser (see "Manual checks").

## Run

```bash
npm test                 # Vitest
npm run lint             # tsc --noEmit
npm run build            # production build
npm run guards           # repository checks
npm run guards:dist      # same, plus the built output (after a build)

supabase start           # local stack, applies every migration
supabase test db         # the pgTAP suite (local stack only)
```

The Edge Function and simulator tests run with Deno from their folders; see
`supabase/functions/README.md` and `supabase/payment-simulator/README.md`.

## The database suite

- Single-transaction files create their own fixtures and roll back. Admins
  are made by deleting and re-inserting a profile; **no test disables a
  trigger or RLS**.
- `*_concurrency_test.sql` files open separate connections with `dblink`,
  commit their fixtures, wait on `pg_locks` rather than sleeping, and clean
  up after themselves. They **refuse to run** (one failing test) unless the
  database identifies as the local Supabase stack, and must never be pointed
  at a hosted project. Run them only with `supabase test db` on the local
  stack, ideally a disposable one: they commit fixtures.
- Two catalog tests fail when a table or client-callable function is added
  without being accounted for (see [AUTHORIZATION.md](AUTHORIZATION.md)).
- Mutation checks: for each concurrency-sensitive function a lock or filter
  was removed on a disposable database and the matching test was confirmed to
  fail, then the original was restored. Results are in
  [COMPLETION_PLAN.md](COMPLETION_PLAN.md).

## CI

`.github/workflows/ci.yml` runs on every pull request: install (`npm ci`),
repository guards, unit tests, lint, build, the built-output guard, then a
second job that starts a disposable Postgres, applies every migration and
runs `supabase test db`. No project is linked and no secret is used. The
Deno suites are not in CI yet.

## Manual checks (recorded)

Features were also exercised in a real browser against the local stack,
signed in as the three roles: slot offer and accept, cancel with confirm,
admin approvals (venue queue, communities, events), community join/leave and
event capacity, notifications (bell, mark read, polling), routing (refresh,
back/forward, sub-path build). The step-by-step results are in the progress
log of [COMPLETION_PLAN.md](COMPLETION_PLAN.md); the repeatable script is
[DEMO.md](DEMO.md).

## Known gaps

No automated browser (end-to-end) suite exists: adding one means new
dependencies and browser downloads. No test runs against a hosted project, by
design. Visual regressions are checked by eye.
