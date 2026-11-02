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
- **Verification.** Vitest 567 (was 545), `tsc` clean, build OK; full SQL suite on disposable `unisport-slice1h`: 31 files, 1,218 assertions, PASS. Migration applied to `slice1h` and (with approval, 28 Oct) to `unisport-ui`: 37 of 37, data unchanged.
- **Live browser verification (28 Oct, local `unisport-ui` + built-in browser, signed in as customer2):** a fresh waitlist offer was created (customer1 hold via `create_booking`, customer2 `join_waitlist`, one approved `expires_at` write on that single hold, sweeper offered it). The slot row showed **Accept offer / Offer until 20:27**; accepting created a hold ("Held until 20:22", row "Your reservation"); **Keep it** backed out of the confirm step; **Yes, cancel** cancelled it (DB: `cancelled`, `cancelled_at` set), the schedule showed "Reservation cancelled. The slot is free again.", and Profile history showed **Cancelled**. B-02 and B-01 are therefore verified live.
- **B-04** default date is now the later of the viewer's local date and the database's UTC date (`services/bookingDate.ts`); min/max stay UTC, matching the server. **B-06** the profile form says bio/preferences are saved in this browser only.
- **Fixture left on `unisport-ui`:** one expired booking (customer1), one cancelled booking (customer2), waitlist entries expired/accepted for customer2, all for Sat 31 Oct 6 PM.
- **Pending:** none for Phase 2 apart from the authenticated visual pass of other pages (B-17).

### Phase 3 — owner and admin lifecycle: code complete 28 Oct 2026 (live acceptance run pending)
- **Migration `20261026100000_admin_functions.sql`:** `admin_set_facility_status`, `admin_find_user_by_email` (exact match only, no listing), `admin_set_user_role` (no own-role change: UB007; last administrator protected: UB008; role changes serialise on one advisory lock). The role-protection trigger stays enabled. pgTAP `admin_functions_test.sql` (38) and `admin_functions_concurrency_test.sql` (5, two admins demoting each other; mutation-checked: removing the lock is caught). Full SQL suite on `slice1h`: 33 files, 1,261 assertions, PASS. Applied to `slice1h` and (with approval) `unisport-ui`: 38 of 38.
- **Console:** `AdminDashboard` is real: awaiting-approval queue, other venues with suspend/reactivate, account lookup by full email with role change; every action confirmed, single-flight, re-read afterwards; no role change on one's own account. `services/adminRepository.ts` with typed errors. Vitest 598.
- **First-admin bootstrap:** `supabase/dev/bootstrap_first_admin.sql` (delete-and-reinsert profile; trigger never disabled; idempotent; refuses anything but the local stack); README trigger-disable recipe replaced. **Seed:** `seed_dev_facilities.sql` no longer overwrites existing venues, so owner edits and admin decisions survive a re-run (the "stack identity beyond the JWT secret" idea was not added: no reliable extra marker exists, so the check remains a documented convention).
- **Owner side:** status badge and explanation (pending/live/suspended/rejected) were already shown in `OwnerDashboard`; reviewed in the live run below.

### Phase 5 — routing: done 28 Oct 2026 (uncommitted at the time of writing)
- `services/routes.ts` is the route table: `/` (players), `/owner`, `/admin`, `/community`, `/community/:groupId`, `/profile`, `/auth`, everything else a 404 page (`components/NotFound.tsx`). Wrong role or `/auth` while signed in is redirected to the role's home. `App.tsx` now derives the active tab from the address; the dead `payment` tab was removed from the app shell (`PaymentPage.tsx` itself is left for B-14). The mobile menu now hides the player-only Community/Profile entries for owners and admins, matching desktop.
- Verified in the built-in browser (customer2): deep links, refresh on `/profile`, back/forward, active-tab highlight, `/admin` and `/owner` → `/`, `/nope` → 404, unknown group → "Group not found"; a production build with base `/unisport/` served by `vite preview` (signed-out deep link `/unisport/profile` kept its URL, sign-in returned to it, `/unisport/nope` → 404). Vitest 615, tsc and build clean.
- Not yet verified live: the owner/admin routes (needs their sign-ins, same as the Phase 3 live run).

### Phase 4 — community and events persisted: done, verified live 2 Nov 2026
- **Migration `20261027100000_community.sql`:** `approval_status`, `community_groups`, `group_members`, `community_events`, `event_participants` (RLS on, no policies, no client grants) and 12 `SECURITY DEFINER` functions: `create_group`, `join_group`, `leave_group`, `create_event`, `join_event`, `leave_event`, `get_community_groups`, `get_community_events`, `admin_list_community_groups/events`, `admin_set_group_status/event_status`. Player-created items start `pending` (max 5 pending of each per player); admin-created are approved; an event needs an active venue in the group's city; leaving a group also leaves its events; lock order group → event → rows.
- **pgTAP:** `community_test.sql` (108) and `community_concurrency_test.sql` (9, two scenarios: last place in an event, leave-group racing join-event). Mutation-checked: dropping the event row lock or the leave-group lock is caught. Catalog/privilege tests updated. Full suite on `slice1h`: 35 files, 1,378 assertions, PASS. Applied to `slice1h` only so far.
- **App:** `services/communityRepository.ts` (typed errors, malformed answers are failures), `Community.tsx` and `CommunityDetail.tsx` rewritten on it with loading/empty/error states, a create-community form and a create-event form (venues from the live catalogue, filtered to the group's city), join/leave with inline messages instead of `alert()`, own pending items badged "Awaiting approval"; Profile shows "My Community Events" from the database (B-10); Governance Center has "Community requests" (approve/reject with confirm). `eventService.ts` and the unused `CommunityGroup`/`CommunityEvent` types are deleted (`purgeLegacyDemoData()` still clears old browser keys). Vitest 646, tsc and build clean.
- **Applied to `unisport-ui`** (39 of 39, existing data unchanged) with approval.
- **Live run (built-in browser, local `unisport-ui`):** customer1 created two communities (one by accident with doubled text) → both "Awaiting approval", invisible to customer2; admin (Governance Center) **rejected** the bad one and **approved** the good one, each after a confirm step; customer1 then saw the approved one plus the rejected one badged "Rejected", customer2 saw only the approved one; customer1 created an event (venue list = the live Trivandrum court) → "Awaiting approval", approved by the admin; customer2 joined the community and the event (2 / 2); after a full reload the event showed in customer2's Profile "My Community Events". DB rows matched at every step. The admin sign-in also exercised the Phase 3 console (venue queue/list, role lookup form rendering); the venue approval and role-change actions themselves were not clicked live (no owner sign-in).
- Fixtures left on `unisport-ui`: 2 groups (1 approved, 1 rejected), 1 approved event (2 participants), all by customer1/customer2.

### Phase 6 — in-app notifications: done, verified live 2 Nov 2026
- **Migration `20261028100000_notifications.sql`:** closed `notifications` table (kind check, `(user_id, dedupe_key)` unique), producers as triggers on the source tables so existing functions are untouched (offer issued, hold expired, booking cancelled, venue approved/rejected/suspended, group and event approved/rejected), a per-minute `notify-expiring-offers` cron job (5 minutes or less left), and `get_my_notifications()` / `mark_notifications_read()` (own rows only). No client can write or call the writer. pgTAP `notifications_test.sql` (56), mutation-checked (random dedupe key, no ownership filter on marking, none on reading are all caught). Full suite on `slice1h`: 36 files, 1,434 assertions, PASS. Applied to `slice1h` only.
- **App:** `notificationRepository`, `notificationText` (message and target per kind; absent facts are left out), `NotificationBell` in the navbar (unread badge, list, mark one/all read, 60 s poll that skips hidden tabs, keeps last list on a failed refresh). Vitest 663, tsc and build clean.
- **Out of the MVP (decision recorded):** email, SMS and push. They need a provider and sender-domain/ops decision; the in-app table is the source a later sender can read from. No notification is sent for waitlist expiry on its own, nor for a player joining their event.
- **Applied to `unisport-ui`** (40 of 40, cron job `notify-expiring-offers` scheduled, data unchanged) with approval.
- **Live run (local `unisport-ui`, customer2 in the built-in browser):** through the app's own functions customer1 held a slot, customer2 waited for it and held two more; two `expires_at` writes lapsed customer1's hold and one of customer2's, and the sweeper produced exactly `hold_expired` (customer1), `hold_expired` (customer2) and `offer_issued` (customer2), once each. Cancelling the other hold in the UI produced one `booking_cancelled`. Shortening the live offer to 3 minutes produced one `offer_expiring` from the cron job, and still one a minute later. The bell showed the badge, the text and the time, marked one read on opening it (database `read_at` set), "Mark all read" cleared it, customer1's unread notification was untouched, and the badge updated by polling alone, without a reload. Venue and community decision notifications are covered by pgTAP through the same admin functions the console calls; they were not clicked live.
- **Defects found live and fixed:** the desktop and mobile bells were separate instances and could disagree (now a shared change event, tested); the navbar wrapped its labels at ~800 px with the bell added (spacing tightened below `lg`, labels kept on one line, name block shown from `lg`).
- Fixtures left on `unisport-ui`: 4 notifications, a cancelled and two expired bookings, a live waitlist offer for customer2 (11-07 18:00) that lapses on its own.

### Phase 7 — production readiness: done, 2 Nov 2026
- **Tailwind CDN removed.** Build-time Tailwind v3 (the same major version the CDN served) with the identical theme in `tailwind.config.js`; `postcss.config.js`; `index.css` carries the `@tailwind` layers. **Fonts and icons are bundled** (`@fontsource/inter` 300–900 and `oswald` 400–700, latin subset, plus `@fortawesome/fontawesome-free@6.4.0`); `index.html` has no third-party tag. Verified in the browser: the page looks the same and the resource list shows only the app and the local API.
- **Bundle split.** Every screen is `React.lazy` behind one `Suspense`; `react` and `supabase` are vendor chunks. Largest chunk 227 kB (was a single 651 kB), the size warning is gone.
- **Guards.** `scripts/repoGuards.ts` (+12 unit tests) and `npm run guards` / `guards:dist`, wired into CI: migration names and append-only order against the PR base, secrets in tracked files (private keys, `sb_secret_`, live keys, service-role JWTs), no `supabase link` / `--linked` / `db push` / `migration repair` / `--project-ref` in workflows, scripts or package.json, no tracked `.env` or `supabase/.temp`, no secret-looking `VITE_` name, and no third-party CDN in `dist/`. `.env.example` reviewed: it documents exactly the three variables the app reads.
- **Runbook.** `docs/DEPLOYMENT_RUNBOOK.md`: read-only identity and empty-schema check, Auth and `pg_cron` settings, SPA fallback per host and headers, the exact ordered list of all 40 migrations (the 7 payment migrations ship because `cancel_booking` depends on them; payments stay off), first-admin procedure for hosted, smoke test, rollback and kill switches. **Written, not run: nothing touched any hosted project.**
- **Photos bundled.** The eight Unsplash images the app linked to are now `public/images/sport-*.jpg` (800 px, 50–150 kB each, downloaded with approval from the same URLs); the four existing photos were shrunk from 5.4 MB to 0.9 MB (max 1600 px, quality 78) with `sips`. `services/sportImages.ts` has no remote URL; a test checks every sport resolves to an existing bundled file and the dist guard now also forbids `images.unsplash.com`.
- **Open:** a Deno job for the Edge Function tests is not in CI (needs a pinned, verified action SHA). Hosting choice (D7), email provider and the hosted project remain the owner's decisions.

### Phase 9 — docs and demo: done 2 Nov 2026
- README rewritten to the truth (what exists, quick start, screenshots, documentation index, layout, an honest known-limitations list, development data, deployment pointer). The seven empty documents are written from the code and migrations: ARCHITECTURE (with a data-flow diagram), AUTHORIZATION (role matrix), DATABASE, BOOKING, PRICING (states plainly that there is no dynamic pricing), PAYMENTS (switched off, simulator only, what is and is not verified), TESTING. `docs/DEMO.md` is a repeatable 20-minute script for the three roles with a clearly labelled local-only shortcut. Seven real screenshots in `docs/screenshots/` (from the local development database).
- Not done on purpose: Phase 8 (payments; frozen by D6), the hosted rollout (needs the owner's decisions and approval), removal of the unused prototype files (B-14), password reset (B-05, needs an email provider).

### Phase 3 acceptance run — done live 2 Nov 2026
Local `unisport-ui`, built-in browser, no SQL in the flow: **owner** signed in (landed on `/owner`), created "Palayam Padel Club" (status *Pending approval*, "not visible to players yet"), added an 18:00–19:00 slot and Saturday 17:00–21:00 hours (rows verified in the database); **admin** saw it in *Awaiting approval*, approved it after a confirm ("Palayam Padel Club is now live."), and the owner received exactly one `facility_approved` notification; **player (customer1)** then saw it in Find Facilities with its own Padel filter chip. This closes the Phase 3 acceptance criterion ("owner creates a facility → admin approves in the UI → customer sees it").
Fixtures left on `unisport-ui`: the venue "Palayam Padel Club" (active, 1 slot, Saturday hours).

### Production-demo plan, Phase B (local code), progress 2 Nov 2026
- **B1 test-mode notice:** `TestModeNotice` (headline "Demo: payments run in Razorpay test mode. No money is charged.", the published test card with a Copy button) shown in Your Schedule and the footer only when payments are enabled. **B8 cleanup:** deleted `aiEngine`, `bookingService`, `facilityService`, `paymentService`, `PaymentPage` and the unused demand types; a test asserts they stay gone.
- **B2 password reset:** `requestPasswordReset` (same answer whether or not the address exists; only rate limit/network reported), `/reset-password` screen (needs the recovery session, 8+ characters, match check, clear errors for reused password and expired link), "Forgot password?" on sign-in, and the `PASSWORD_RECOVERY` event routes to the screen wherever the link lands. Local `supabase/config.toml` now allows `http://127.0.0.1:3000/**` for redirects (takes effect when the local stack is next restarted). Verified live against the local mail catcher: request → neutral message → email → link → set-password screen → short password refused → reuse refused by the server. **Not verified live:** the successful save, because changing a test account's password was blocked pending your approval; it is covered by unit tests.
