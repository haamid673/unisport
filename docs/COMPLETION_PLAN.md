# UniSport — Completion Plan

Written 28 Oct 2026 from the engineering handoff plus a read-only look at the repo.
Branch `review/unisport-release-readiness`, HEAD `69ac96e`. This is the plan I follow
from here on. Edit it; I will keep it current as slices land.

**Goal:** a complete, coherent, demo-able product (customer, owner, admin, community),
verified in a real browser against the local stack, with a reviewed hosted-deployment
plan. Payments stay frozen (see Phase 8).

---

## 0. Ground truth (verified today, not just from the handoff)

| Fact | Evidence |
|---|---|
| 37 uncommitted entries; nothing from payments, simulator, e2e harness, or the waitlist-offer UI is committed | `git status` |
| Main dev stack `unisport-ui` is up with 29 of the repo's 36 migrations; the 7 payment migrations are not applied | earlier catalog check |
| Ten local stacks run (`unisport-ui`, `itest`, `slice1a`–`1h`); `slice1h` holds retained confirmed payment fixtures | `docker ps` |
| **No** cancel, approve/reject, notification, group, event, or membership function/table exists in any migration | grep of all migrations |
| Community and events are 100% browser `localStorage` via `services/eventService.ts` and `storageService.ts` | source |
| `BrowserRouter` is mounted, but there are no `<Route>`s: screens switch on `activeTab` state in `App.tsx` | source |
| `AdminDashboard.tsx` is a 46-line placeholder | source |
| Admin role changes and facility activation need hand-written SQL (the README's setup even tells you to disable a guard trigger) | README, trigger |
| `docs/*.md` (7 files) are all **empty** and the README still says "there is no payment provider" | `wc -l`, README |
| CI exists (`npm test`, lint, build, `supabase test db`) | `.github/workflows/ci.yml` |
| Tailwind CDN, Font Awesome CDN, Google Fonts and hotlinked images are used in production HTML | `index.html` |
| The slot-row "Accept offer" UI is unit-tested only; no live-offer browser check has happened | handoff |

---

## 1. Working rules for every slice

1. **State the slice first:** scope, files likely touched, DB changes, acceptance criteria.
2. **Tests before or with code:** pgTAP for DB rules, vitest for logic, a real-browser pass for each user-visible flow.
3. **Database is authoritative:** eligibility, pricing and state transitions live in SQL functions with RLS. The UI only decides what to show.
4. **Mutation-check the important tests** (break the code on purpose, confirm a test fails), as done so far.
5. **Full regression after each slice:** `npm test`, `npm run lint`, `npm run build`, plus the SQL suite on a *disposable* stack.
6. **One report per slice:** files changed, exact commands and counts, limitations, remaining risks.
7. **Do not** commit, push, open PRs, switch branches, reset databases, delete volumes, disable triggers, or touch hosted Supabase or Razorpay without explicit approval at that moment. Never run the generated hosted `db diff` SQL.
8. **Migrations:** new files only, timestamped after `20261024190000`, forward-only. Never edit an applied migration.
9. **Always target a stack explicitly.** The repo's `supabase/.temp` links a hosted project, so local commands use `--local`/`--workdir` or `docker exec` and never `--linked`.
10. Keep the visual design unless a change is requested. No silent removal of existing UI.

### Approval gates (I stop and ask)

| Action | Needs your explicit OK |
|---|---|
| Applying migrations to `unisport-ui` | yes, each batch |
| Any direct write to local data (fixtures, `expires_at`, roles) | yes, with the exact rows |
| Creating commits | yes |
| Anything on hosted Supabase, live keys, or real Razorpay | yes, plus a fresh review |
| Running the SQL suite | on a disposable stack only (multi-session suites commit fixtures) |

---

## 2. Phase map and order

```
P0 baseline ─▶ P1 audit + decisions ─▶ P2 customer lifecycle ─▶ P3 owner/admin
                                                                      │
        P7 prod-readiness ◀─ P6 notifications ◀─ P4 community/events ◀─ P5 routing
                 │
                 ▼
            P9 demo/portfolio          P8 payments (frozen; resumes last, only if wanted)
```

Routing (P5) goes **before** community (P4) so the community screens are built on routes
once, not rebuilt afterwards. Admin tools (P3) go early because they remove the SQL
dependency from every later manual test.

---

## Phase 0 — Safe baseline (read-only, ~½ day)

**0.1 Report.** Git status/HEAD, which stack and Vite server are live, env file used (names only), and fresh numbers for:
`npm test`, `npm run lint`, `npm run build`, Deno mocked tests, simulator tests.
**0.2 DB suite** on a disposable stack (not `unisport-ui`, which holds your manual-test data). Record files/assertions; compare with the handoff's 29 / 1,155.
**0.3 Stack parity decision.** `migration up` applies *all* pending migrations in order, so any new migration forces the 7 payment migrations onto `unisport-ui` first. Options:
 (a) apply the 7 payment migrations to the dev stack (forward-only; already validated on `slice1h`) — recommended;
 (b) build new work on a fresh disposable stack and keep `unisport-ui` as-is.
**0.4 Close the open waitlist verification** with a live offer (needs your login to the browser pane and one approved `expires_at` write, or a ~11-minute real wait).
**0.5 Checkpoint commits (recommendation).** 37 uncommitted entries of validated work is a loss risk. I would propose grouping commits (payments+simulator, waitlist UI, e2e harness, tooling/docs). I only do this if you say so.

**Deliverable:** baseline report. **Exit:** numbers recorded, parity decision made.

---

## Phase 1 — Whole-product audit and MVP definition (read-only, ~1 day)

Audit every row of the handoff's list with file/function/test evidence, classified as:
verified · implemented-unverified · mock/localStorage · incomplete · untested · needs-decision.
Output: `docs/MVP_BACKLOG.md` (new file) with user impact, dependencies, acceptance criteria.

**Decisions I need from you at the end of this phase** (defaults in bold):

| # | Decision | Default I will assume |
|---|---|---|
| D1 | Cancellation policy | **Customer may cancel their own *unpaid hold*; cancelling a paid booking is out of MVP** (needs refunds) |
| D2 | Admin approval in MVP | **Yes** — small UI over guarded RPCs |
| D3 | Owner onboarding | **Admin promotes a user to owner by email** (no self-serve application) |
| D4 | Community scope | **Groups + membership + events + participation**, with moderation via `ApprovalStatus` (pending → approved by admin) |
| D5 | Notifications | **In-app only** for MVP; email/SMS later |
| D6 | Are payments part of the demo? | **Simulator-backed demo only**, clearly labelled; no live Razorpay |
| D7 | Hosting target | undecided — needed by P7 |

---

## Phase 2 — Customer booking lifecycle (~2–3 days)

**Today:** book → 10-minute hold → expiry → waitlist → offer works in the DB; history screen exists. **Gaps:** no cancel, availability goes stale, status labels unaudited.

1. **Cancel an unpaid hold** — new migration `cancel_booking(p_booking_id)`: caller owns it, status `pending_payment` and unexpired → `cancelled` (+ `cancelled_at`), then trigger the waitlist offer path. `SECURITY DEFINER`, `search_path ''`, EXECUTE for `authenticated` only, same advisory-lock order as `create_booking`. pgTAP: ownership, wrong status, already expired, double cancel, concurrency vs expiry, waitlist offer issued.
2. **Repository + UI:** `bookingRepository.cancelBooking`, a Cancel button on held rows with single-flight and a confirm step; `cancelled` badge in history; refresh bookings + availability + waitlist after.
3. **Truthful states audit:** pending, expired, cancelled, confirmed are visibly distinct; an expired hold is never shown as payable or confirmed (including the "Pay" panel, which only exists when the payments flag is on).
4. **Staleness:** re-read availability when a hold the user *doesn't* own lapses (open facility + date), with a bounded interval (e.g. one re-read per 60 s while the slot picker is open), no aggressive polling.
5. **Live-offer browser verification** (carry-over from P0.4), with screenshots and DB evidence.

**Acceptance:** full customer journey (discover → filter → book → cancel → rebook → expire → waitlist → accept) passes in a real browser; all states match the DB; SQL + vitest green.

---

## Phase 3 — Owner and admin lifecycle (~3 days)

1. **Admin RPCs (new migration), all `is_admin()`-gated, audited by tests:**
   `admin_set_facility_status(facility, 'active'|'rejected'|'suspended'|'pending')` and `admin_set_user_role(user, role)` (prevents removing the last admin; no self-demotion).
   These replace the SQL role procedure and the trigger-disabling README recipe. The existing role-protection trigger stays enabled.
2. **Admin console UI** (`AdminDashboard.tsx`): pending-facility queue with approve/reject, facility list with suspend/reactivate, user lookup by email with role change, every action confirmed, single-flight, and refresh.
3. **Owner side:** show facility status and rejection/suspension state; allowed-field editing unchanged; clear validation errors; booking list shows hold/expired/cancelled states from P2.
4. **First-admin bootstrap:** document one safe, idempotent local procedure (the delete-and-reinsert technique the tests use) in `docs/` and replace the README's trigger-disable instruction.
5. **Seed:** harden `supabase/dev/seed_dev_facilities.sql` (stack-identity check beyond JWT secret; do not overwrite edits on re-run).

**Acceptance:** owner creates a facility → admin approves in the UI → customer sees it, with no SQL anywhere in the flow.

---

## Phase 5 — Routing and navigation (before P4; ~2 days)

1. Map the `activeTab` view model (dashboard, community, community detail, profile, payment) to URLs: `/`, `/community`, `/community/:groupId`, `/profile`, `/admin`, `/owner`, plus `/auth`.
2. Keep role-based dashboard selection; add route guards and a proper not-found page.
3. Preserve the `BASE_URL` basename; verify refresh on a nested path and back/forward.
4. Host rewrite note for the chosen platform (SPA fallback) — decided in P7.
5. Tests: route table, guard redirects, unauthenticated deep link returns to the intended page after sign-in.

**Acceptance:** every primary screen has a stable URL that survives refresh, under `/` and under a subpath.

---

## Phase 4 — Persist community and events (~1 week, the largest gap)

1. **Data model (new migration, RLS on by default, revoke-first grants):**
   `community_groups`, `group_members`, `community_events`, `event_participants`. Fields follow `types.ts` (`CommunityGroup`, `CommunityEvent`, `ApprovalStatus`). Enforce: unique membership, capacity, creator is a member, groups start `pending`, only admins approve, members only see approved groups plus their own.
2. **RPCs** for the race-prone parts: `join_group`, `leave_group`, `join_event` (capacity-safe, one active participation), `leave_event`, `create_group`, `create_event` (validates the facility reference and city).
3. **pgTAP:** each RLS rule, each RPC's refusals, capacity under concurrent joins, cannot see or edit other users' pending items.
4. **Repositories** (`groupRepository`, `eventRepository`) following the booking/waitlist repository pattern: typed errors, no mock fallback.
5. **UI wiring:** `Community.tsx`, `CommunityDetail.tsx`, `UserProfile.tsx` switch from `eventService`/`storageService` to the repositories; honest loading/empty/error states.
6. **Retire the mock path:** delete `eventService`/mock reads once nothing imports them; keep `purgeLegacyDemoData()` for one release so old browser keys are cleaned.
7. Admin approval of groups/events folded into the P3 admin console.

**Acceptance:** two real accounts see the same groups and events, joins persist across reload and devices, RLS blocks unauthorized access, no `localStorage` community data remains.

---

## Phase 6 — Notifications (in-app first; ~3 days)

1. `notifications` table (`user_id`, `kind`, `payload`, `read_at`, `created_at`), RLS: owner reads/marks own; no client insert.
2. Server-side producers (in existing functions/jobs): waitlist offer issued, offer about to lapse, hold expired, booking cancelled, facility approved/rejected, group/event approved.
3. UI: a bell with unread count, list, mark read; polling at the same bounded cadence as the waitlist.
4. Email/SMS/push: out of MVP; write the provider/ops decision into the backlog.

**Acceptance:** each event above produces exactly one notification for the right user, visible after reload.

---

## Phase 7 — Production readiness (~3–4 days, then a gated hosted rollout)

1. Replace the **Tailwind CDN** with the build-time plugin; self-host or bundle **Font Awesome**, fonts, and replace hotlinked images with bundled assets or a fallback.
2. Code-split heavy screens to address the bundle-size warning; check the build output size.
3. Env review: public vs server-only variables, `.env.example` accuracy, secret scanning in CI.
4. CI: keep tests/lint/build/DB suite; add a migration-ordering check and an "no hosted link used" guard.
5. **Hosted plan (write-up only):** read-only confirm of the hosted project's identity and empty schema; an exact ordered migration list; a rollback plan; whether the 7 payment migrations ship (D6); hosting + SPA fallback; Auth redirect URLs.
6. **Hard gate:** nothing is applied to hosted Supabase without your explicit approval at that moment, and the `db diff` DROP script is never run.

**Acceptance:** `npm run build` output has no CDN style/script dependency; a reviewed, written deployment runbook exists.

---

## Phase 8 — Payments (frozen; resumes last, only if wanted)

No payment features until P2–P7 are done and you ask for it. When resumed: capture-time vs observation-time lateness policy, a refund lifecycle with reconciliation and alerting, server-side rate limiting, surfacing second captures after confirmation, and verifying the real Razorpay **test-mode** behaviour (list completeness, retries, capture settings). Live keys stay refused. Existing 180 Deno / 27 simulator / 12 E2E tests must stay green throughout.

---

## Phase 9 — Demo and portfolio (~2 days)

Rewrite the README to the truth (it still says there is no payment provider); fill the seven empty `docs/*.md` (architecture, authorization, booking, database, payments, pricing, testing); add a data-flow diagram; a repeatable demo script with the seed + the three roles; screenshots; an honest "known limitations" section (simulator-only payments, no email, no live Razorpay).

---

## 3. Definition of "MVP complete"

- [ ] Customer: sign up, browse, book, cancel an unpaid hold, join/leave waitlist, accept an offer, see truthful history.
- [ ] Owner: create/edit a facility, hours, slots, see bookings and approval state.
- [ ] Admin: approve/reject/suspend facilities, set roles, approve groups/events, all in the UI.
- [ ] Community: groups, membership, events, participation persisted and RLS-protected.
- [ ] Notifications (in-app) for the listed events.
- [ ] Stable URLs and refresh-safe deep links.
- [ ] Green: frontend tests, lint, build, SQL suite on a disposable stack, CI.
- [ ] No CDN-only production dependencies; deployment runbook written.
- [ ] README and `docs/` accurate; known limitations stated.

## 4. Risks I'm watching

| Risk | Mitigation |
|---|---|
| Large uncommitted tree | checkpoint commits (with your OK) |
| Forced payment-migration ordering on the dev stack | decide at P0.3 |
| Concurrency bugs in new RPCs (capacity, cancel vs expiry) | pgTAP concurrency tests, mutation checks |
| RLS gaps on new tables | revoke-first grants, per-policy tests, catalog privilege test |
| Scope creep back into payments | Phase 8 is explicitly last |
| Hosted deploy mistakes | read-only first; written runbook; explicit approval |

## 5. Rough sizing

P0 ½d · P1 1d · P2 2–3d · P3 3d · P5 2d · P4 ~5d · P6 3d · P7 3–4d · P9 2d ≈ **4–5 working weeks**, payments excluded.

---

## Progress log

### Phase 0 — baseline recorded 28 Oct 2026 (read-only)

| Check | Result |
|---|---|
| Repo | branch `review/unisport-release-readiness`, HEAD `69ac96e`, 38 uncommitted entries (nothing committed) |
| `npm test` | 29 files, **545 passed** |
| `npm run lint` | pass |
| `npm run build` | pass; main JS 605 kB (gzip 172 kB) still triggers the >500 kB warning |
| Deno mocked payment suites | **180 passed**, 17 ignored (stack-dependent), `deno check`/`lint` clean |
| Simulator suite | **27 passed** |
| SQL suite (`slice1h`, explicit `--db-url`, unlinked throwaway workdir) | **29 files, 1,155 assertions, PASS** — matches the handoff exactly |
| Disposable stack state after the run | unchanged: users 1, bookings 2, facilities 2, payments 3, 36 migrations |

Environment notes:
- The Vite dev server on port 3000 is **not running** now (it ended with the earlier session).
- `unisport-ui` has 29 of 36 migrations, with the 4 test accounts, 1 facility, 1 booking. Only `slice1h` has all 36.
- The old `/tmp/unisport-slice1h` workspace no longer exists. For the SQL suite use `supabase test db --workdir <unlinked dir> --db-url "postgresql://…:59402/postgres?sslmode=disable"` (`sslmode=disable` is required; the CLI otherwise insists on TLS).

Still open from Phase 0: stack-parity decision (0.3), live waitlist-offer browser check (0.4), checkpoint commits (0.5).

### Phase 0.3–0.5 — done 28 Oct 2026
- Backup (outside the repo, mode 600), then the 7 payment migrations applied to `unisport-ui` through an unlinked workdir: **36 of 36**, data/roles/guards/cron/customer RPCs intact.
- Five local checkpoint commits (`699779a`, `75103e9`, `609ba37`, `b07c5ed`, `ddf18cf`); nothing pushed; committed tree re-verified green (545 tests, lint, build).

### Phase 1 — audit complete
See `docs/MVP_BACKLOG.md`. Open: authenticated visual pass (needs a sign-in), live waitlist-offer check (B-02).

### Phase 2 — customer booking lifecycle: code complete 28 Oct 2026 (browser/live checks pending)
- **B-01 cancel an unpaid hold.** New forward-only migration `20261025190000_cancel_booking.sql` (`cancel_booking(uuid)`: own unpaid hold only; UB005 for paid/finished, UB006 while a payment attempt is creating/open; idempotent for cancelled/expired; offers the freed slot to the next waitlist entry). pgTAP: `cancel_booking_test.sql` (48) and `cancel_booking_concurrency_test.sql` (15, multi-session), both mutation-checked. Repository `cancelBooking` + `toCancelError`; Cancel reservation button with confirm step on held rows in Your Schedule (single-flight, re-reads bookings/availability/waitlist). The catalog privilege test's allow-list now names `cancel_booking(uuid)`.
- **B-03 bounded availability refresh.** One quiet re-read per 60 s while a venue is open, plus on tab return (not sooner than 15 s after the last); no refresh for hidden tabs; rows do not flash "loading"; a failed background read keeps the last answer.
- **Truthful states.** An unpaid hold without an expiry reads "Unpaid hold", never "Confirmed".
- **Verification.** Vitest 567 (was 545), `tsc` clean, build OK; full SQL suite on disposable `unisport-slice1h`: 31 files, 1,218 assertions, PASS. Migration applied to `slice1h` only; **not yet applied to `unisport-ui`** (needs approval).
- **Pending (need user access):** apply the migration to `unisport-ui`; browser sign-in to verify cancel + the live waitlist-offer "Accept offer" (B-02); B-04 (UTC default date) and B-06 (label bio/preferences as browser-only) still to do.
