# UniSport — Phase 1 Audit and MVP Backlog

Audited 28 Oct 2026 (read-only) at HEAD `ddf18cf`. Evidence is from source, the live
`unisport-ui` dev database (36/36 migrations), and the running app. Constraint from the
product owner: **do not change core features or the UI theme; fix UI only where it is
actually broken.** Everything below respects that: new work adds missing capability or
fixes defects, and never restyles existing screens.

Status key: ✅ verified working · 🟡 implemented, not verified end-to-end · 🧩 mock / browser-only ·
❌ missing · ⏸ frozen by decision

## 1. Feature matrix

| Area | Status | Evidence | Gap |
|---|---|---|---|
| Sign up / sign in / sign out | ✅ | `authService`, `Auth.tsx`; four accounts registered and signed in manually; role read from DB profile | no password reset, no email-confirmation flow locally (autoconfirm on) |
| Roles (user/owner/admin) | 🟡 | DB trigger + column grants + tests; roles assigned in this session | no UI to change a role; first admin needs SQL |
| Facility discovery, city/sport filter | ✅ | catalog read through RLS; manual test showed the facility after activation | city/date default uses the UTC date, not the user's local date (see B-04) |
| Slot availability | 🟡 | `get_slot_availability`; stale until a manual reload except own-hold lapse | stale for others' holds (B-03) |
| Booking hold (10 min) and expiry | ✅ | `create_booking`; cron expiry verified in DB timestamps | none found |
| Booking history | 🟡 | `UserProfile.tsx` has labels for pending, confirmed, completed, expired, cancelled | not re-verified in a browser; no way to *produce* `cancelled` (B-01) |
| Cancellation | ❌ | no `cancel_*` function in any migration, no UI | B-01 |
| Waitlist join / leave | ✅ | `waitlist_flow` SQL tests; manual join by customer 2 | none found |
| Waitlist offer + accept | 🟡 | offer issuance verified in DB (09:38, 15-min window); slot-row "Accept offer" unit-tested only | live-offer browser check still owed (B-02) |
| Owner: create/edit facility, hours, slots, bookings | ✅ | manual test: created, saved, persisted; hours initially not saved until per-day Save used | no status management, no rejection reason, no images (B-13) |
| Admin approval of facilities | ❌ | `AdminDashboard.tsx` is a 46-line placeholder; activation done by SQL | B-07 |
| Role management / first admin | ❌ | README recipe disables a guard trigger | B-08 |
| Community groups and membership | 🧩 | `eventService` reads/writes `localStorage`; empty by default after demo purge | B-09 |
| Events and participation | 🧩 | same; `UserProfile` lists events from `localStorage` | B-09, B-10 |
| Community creation | ❌ | no create-group or create-event UI exists | B-09 |
| Profile editing (name, phone) | ✅ | persisted through `updateOwnProfile` | |
| Profile bio / preferences | 🧩 | stored in `unisport_profile_extras_v1` in the browser only | B-06 |
| Notifications | ❌ | no table, function or UI | B-12 |
| Routing / deep links | ❌ | `BrowserRouter` mounted, no `<Route>`s; screens switch on `activeTab` | B-11 |
| Payments | ⏸ | simulator-verified locally; off in the UI unless the test key is set | frozen |
| Build / deploy | 🟡 | build passes; Tailwind CDN, Font Awesome CDN, hotlinked Unsplash images; 605 kB bundle; hosted project is empty | B-15 |
| CI | ✅ | tests, lint, build, pgTAP | no migration-ordering guard |
| Docs | ❌ | all seven `docs/*.md` are empty; README says "no payment provider" | B-16 |

## 2. Backlog (ordered)

Priority: **P0** blocks the MVP · **P1** needed for the MVP · **P2** polish / later.

| ID | Pri | Item | Phase | Acceptance criteria |
|---|---|---|---|---|
| B-01 | P0 | Cancel an unpaid hold (`cancel_booking` RPC, repository, Cancel button with confirm). Paid-booking cancellation out of scope (needs refunds). | 2 | owner-only; wrong/expired status refused; slot reopens and the waitlist offer fires; concurrent cancel vs expiry safe; pgTAP + vitest + browser |
| B-02 | P0 | Verify the slot-row "Accept offer" with a live offer in a real browser | 2 | screenshots + DB rows: offer → accept → linked booking; 19:00 row still "Book" |
| B-03 | P1 | Refresh slot availability while the picker is open, bounded (one read per ~60 s plus on focus), not aggressive polling | 2 | another user's lapsed hold turns "Full" into "Book" without reload |
| B-04 | P2 | Date default uses `toISOString()` (UTC) while the user is local; decide facility time zone handling (README already flags it) | 2/7 | decision recorded; default date and the "past date" rule agree |
| B-05 | P1 | Password reset (needs email provider; local mail catcher exists) | 6 | request link → reset → sign in; no account enumeration |
| B-06 | P2 | Persist bio/preferences or label them clearly as this-browser-only | 2 | no data silently lost across devices, or an honest label |
| B-07 | P0 | Admin console: pending-facility queue, approve / reject / suspend, over `is_admin()`-gated RPCs | 3 | owner creates → admin approves in UI → customer sees it, no SQL |
| B-08 | P0 | Admin role management by email via a guarded RPC; replace the README trigger-disable recipe with the safe first-admin procedure | 3 | cannot remove the last admin; guard trigger stays enabled; documented |
| B-09 | P0 | Persist communities: tables, RLS, RPCs (create/join/leave group, create/join/leave event with capacity), repositories, UI incl. **create** flows | 4 | two users see the same state across reloads; RLS blocks others' pending items |
| B-10 | P1 | Profile "my events" from the database | 4 | matches B-09 |
| B-11 | P1 | Real routes (`/`, `/community`, `/community/:id`, `/profile`, `/admin`, `/owner`), guards, 404, base-path safe | 5 | refresh and back/forward work on every primary URL |
| B-12 | P1 | In-app notifications (offer issued/expiring, hold expired, booking cancelled, facility approved/rejected, group/event approved) | 6 | one notification per event, correct user, survives reload |
| B-13 | P1 | Owner: show status and rejection/suspension; clearer validation; booking list shows cancelled/expired | 3 | status always visible; no confusing states |
| B-14 | P2 | Remove unreachable legacy code (`PaymentPage`, `bookingService`, `paymentService`, `facilityService`, `aiEngine`, the dead `payment` tab) **only after confirming nothing imports it**; no visible behaviour change | 7 | tests, lint, build green; no UI change |
| B-15 | P1 | **Done.** Production assets: replace Tailwind CDN with the build plugin, bundle icons and fonts, bundle or fall back for hotlinked images, split the bundle | 7 | built page needs no CDN style/script; size warning addressed |
| B-16 | P1 | Truthful README and filled `docs/*.md`; demo script; screenshots | 9 | each doc accurate against the code |
| B-17 | P1 | Authenticated visual audit of every screen at desktop and phone width (the unauthenticated screen passed: no overflow at 375 px) | 2–3 | list of real defects, fixed without restyling |
| B-18 | P2 | **Done** (`docs/DEPLOYMENT_RUNBOOK.md`, `npm run guards`). Hosted rollout runbook, CI migration-order guard | 7 | reviewed, not executed |

## 3. Decisions this audit still needs

| # | Question | Default |
|---|---|---|
| D1–D7 | as in `COMPLETION_PLAN.md` (all defaults accepted) | |
| D8 | Password reset in the MVP? | **Yes** (can't recover an account otherwise) |
| D9 | Time-zone model (UTC dates vs per-facility zone) | **Keep UTC for now; fix the default-date display; revisit with facility time zones** |
| D10 | Persist bio/preferences? | **Label as browser-only for now** |

## 4. What I did not verify

- Authenticated screens were not viewed (I don't have the account passwords); the visual audit of
  dashboard, owner portal, profile and community needs you to sign in once in the browser pane.
- Real browser behaviour of history, cancellation (does not exist), and notifications (does not exist).
- Anything hosted.
