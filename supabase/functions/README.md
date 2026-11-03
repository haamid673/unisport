# Payment Edge Functions (slice 1b)

Server-side half of the Razorpay integration. The browser never talks to
the Razorpay API and never sees a server credential.

| Function | Caller | Purpose |
|---|---|---|
| `payments-create-order` | signed-in user (JWT required) | create, re-use or recover the Razorpay order for one of the caller's own `pending_payment` bookings and hand it out under a Checkout lease (`{ booking_id, checkout_session }`); returns only `attempt_id, order_id, amount_paise, currency, key_id, hold_seconds_remaining` |
| `payments-verify` | signed-in user (JWT required) | after Checkout: fetches `razorpay_payment_id` from the API and, only if it belongs to one of the caller's booking's own orders with the expected amount/currency, applies it through the same observation path; returns `{ booking_id, booking_status, payment_status, provider_refund, result }`. Without a payment id: booking-based recovery (below) |
| `payments-webhook` | Razorpay (no JWT; HMAC signature) | verified webhook receiver; fetches the payment from the API and applies it (merge, match, settle) |

All logic lives in `_shared/` and is dependency-free (plain `fetch` to
Razorpay, GoTrue and PostgREST). The database side is
`supabase/migrations/20261019190000_payment_order_and_settlement_functions.sql`:
the functions call only those SQL functions (service_role), never tables.

## Trust boundaries

- **Caller identity:** the JWT, validated with GoTrue (`/auth/v1/user`).
  A user id, amount, currency or order id in the request body is ignored.
- **Ownership, eligibility, amount:** `payment_prepare_attempt` (database),
  from the booking row under a row lock.
- **Order:** persisted as an attempt *before* the provider call
  (`receipt` = attempt id, 36 characters); the provider response is
  validated, then recorded write-once (`payment_record_order`).
- **Payment facts:** always fetched from `GET /v1/payments/{id}` with the
  server key. A webhook body is only used to know which payment to fetch,
  after its signature (HMAC-SHA256 over the raw body) has been verified.
- **Settlement:** only inside `payment_apply_observation`, on the facts
  just fetched, under the slice 1a lock order. A created order, an
  authorized payment or a webhook alone never confirms a booking.

## Order creation and recovery

| Provider outcome | What happens |
|---|---|
| order created and matches | recorded, attempt `open`, checkout fields returned |
| order created but amount / currency / receipt / entity differs | not recorded; attempt closed (`order_response_mismatch`); 502 |
| `400 Duplicate request` (receipt already used) | look the order up by receipt, adopt it if it matches |
| other definitive 4xx | look up by receipt first (in case it was a duplicate); none → attempt closed; 502 |
| timeout, network error, 5xx, 429, unreadable success | **ambiguous**: attempt stays `creating` under its 60 s lease; 503 + `Retry-After` |
| retry while the lease is held | 409 `order_creation_in_progress` |
| retry after the lease expired | `recover`: look up by receipt (exact match; the API filter is "contains"); create with the *same* receipt only if none exists. Razorpay rejects a second order with that receipt, so one attempt can never get two orders |
| retry after success | `reuse`: the open order is returned, no provider call |

### Payment window (`20261020190000_payment_window_policy.sql`)

- An order is created, recovered or re-used only while the booking is
  `pending_payment` with at least **180 s** of its 10-minute hold left.
  180 s covers the worst-case server path (about 55 s) plus about two
  minutes for the customer to complete Checkout. The hold is never
  extended.
- Recording the order re-checks the booking under its row lock. If the
  hold ended while the provider call was in flight, the order id is
  still recorded (so a payment on it is matched and settled as a late
  capture), the attempt is closed with `booking_not_payable`, and the
  order is not returned.
- `hold_seconds_remaining` (`20261022190000_payment_hold_seconds_remaining.sql`)
  is the hold left, computed by the database's clock when the attempt was
  prepared, minus the time the Edge Function spent since (rounded down,
  never increased; `null` if the database did not report it). It is
  relative, so the browser's clock does not matter. The frontend ends
  Razorpay Checkout 60 s before it (at most 600 s) and does not open
  Checkout with less than 60 s left.
- Since `20261023190000` the value is measured when the Checkout lease is
  granted (later, and therefore tighter, than the prepare step).
- Refusals are `409 { "error": "booking_not_payable", "reason": … }` with
  `reason` one of `hold_expired`, `hold_too_short`, `booking_not_pending`,
  `attempt_closed`, `free_booking`.

The durable recovery record is the `creating` attempt itself (its id is
the receipt). The ambiguous error class is logged (structured, no
secrets); the schema has no column for it.

### Checkout lease (`20261023190000_payment_checkout_lease.sql`)

Request: `{ "booking_id": "<uuid>", "checkout_session": "<uuid>" }`. The
session id is generated by the browser for its checkout flow (one per
booking per page) and re-sent on every retry. Only its SHA-256 is stored
(`payment_attempts.checkout_lease_hash`); it is never returned.

The order is handed out only by `payment_acquire_checkout_lease`
(booking row, then attempt row: the usual lock order; concurrent requests
queue on the booking row, so at most one lease is ever granted):

| Lease state | Request | Answer |
|---|---|---|
| never leased | any session | lease granted until the hold ends; 200 with the order (no provider call: the order was never handed out) |
| active | another session, or held by nobody (orders handed out before leases existed) | 409 `checkout_in_progress` (`retry_after_seconds` = lease left); no order id, no provider call |
| active | the holding session (a retry, or Checkout re-opened) | the order's payments are listed at the provider: none at all (complete list) → 200, same lease; any payment, **even a failed one** → 409 `payment_may_exist` (`reason: payment_on_order`); provider failure or an incomplete list → 503 |
| ended | any | 409 `payment_may_exist` (`reason: checkout_session_ended`): an ended lease never means no payment was made, so it is never re-granted |

There is no release and no override: a stale browser cannot end or take
over a newer session. The cost is deliberate: after a reload (new
session id) or in another tab, a new Checkout cannot be started for the
rest of that hold; the customer can check the payment status. The lease
does not stop a hand-crafted Checkout: the owner can read their own
attempt's order id (RLS SELECT) and the public key; the lease protects
honest clients from opening two sessions.

A failed payment is never treated as final: no server mechanism here can
establish that a payment Razorpay reported as `failed` will not be
authorized or captured later, so neither the lease nor the frontend
starts another payment on that booking's order.

## Verification (`payments-verify`) — API contract

Request (JWT required):

```json
{ "booking_id": "<uuid>", "razorpay_payment_id": "pay_…" }
```

Any other field (success flag, Checkout signature, order id, amount,
status) is ignored. The payment is fetched from the provider with the
server key and applied only if its order is one of THIS booking's recorded
orders with that attempt's amount and currency, through the same
observation path as the webhook.

Response 200 (exactly these fields):

```json
{ "booking_id": "…", "booking_status": "…", "payment_status": "…",
  "provider_refund": "none|partial|full", "result": "…" }
```

**`result === "confirmed"` is the only successful outcome for the payment
being verified.** Nothing else proves that this payment paid for the booking:

- `booking_status === "confirmed"` alone is not proof: the booking may have
  been fulfilled by a *different* payment (this one is then a duplicate
  capture, `result: "not_fulfilled"`).
- `payment_status === "captured"` (or `"refunded"`) alone is not proof: a
  captured payment can arrive after the hold ended, on a closed attempt, or
  after the booking was already paid.

| `result` | Reached when | Guarantees |
|---|---|---|
| `confirmed` | the booking's fulfilment pointer, read back from the database after the observation, is this payment | this payment fulfilled the booking (durable, write-once). `provider_refund` can still be `partial`/`full` if the provider refunded it *afterwards* |
| `not_fulfilled` | the provider reports the payment `captured` or `refunded`, but it is not the fulfilling payment: hold expired (clock or status), attempt closed, booking already fulfilled by another payment, refunded before settlement, an existing refund obligation, or an anomaly | this payment did **not** confirm the booking. The UI must not say it did |
| `payment_failed` | provider status `failed` | not captured now; `failed` is not final at the provider, so a later capture is still applied (by the webhook or a later verification) |
| `payment_pending` | provider status `created` or `authorized` | not captured (yet) |

`provider_refund` is a **provider fact**, fetched on this call
(`amount_refunded`, `status = refunded`), never inferred from `result`:

| `provider_refund` | Meaning |
|---|---|
| `none` | the provider reports nothing refunded. With `not_fulfilled` the captured money is **unresolved**: this system has not created any refund (refund processing is not implemented yet) |
| `partial` | refunds for part of the amount exist at the provider |
| `full` | refunds totalling the amount exist at the provider. This does not prove the money has reached the customer |

The system never reports a refund as "pending" or "requested": it does not
create refunds yet, so it cannot know.

Errors:

| Status | `error` | When |
|---|---|---|
| 401 | `unauthorized` | no or invalid JWT |
| 400 / 413 | `invalid_request` / `request_too_large` | malformed body |
| 404 | `booking_not_found` | missing booking **or someone else's** (same answer) |
| 409 | `payment_not_for_booking` | the payment belongs to no order of this booking, has no order, or the provider does not know it (one answer, so the endpoint reveals nothing about other payments; the server log keeps the reason) |
| 409 | `payment_mismatch` | one of this booking's orders, but a different amount or currency |
| 503 | `payment_provider_unavailable` / `temporarily_unavailable` / `payments_unavailable` | retry (`Retry-After`) |
| 502 | `verification_failed` | the provider answer or the database rejected the observation deterministically |

Repeated calls are idempotent and return the same state (with fresh
provider refund facts).

### Booking-based recovery (no payment id)

Request: `{ "booking_id": "<uuid>", "checkout_session": "<uuid>" }`
(`razorpay_payment_id` absent or `null`; any other malformed value is
still 400). For when the browser lost the payment id: a reload, another
tab or device, an ambiguous verification. `checkout_session` is optional
and only tells the server whose Checkout lease the caller holds (see
`checkout_lease` below); it is compared by SHA-256, never stored,
returned or logged, and a malformed one is a 400 before anything else
happens.

- Same JWT and ownership checks first (another user's booking: 404
  `booking_not_found`, with no provider call).
- Orders come only from this booking's recorded attempts (the database),
  newest first, at most **3** orders and **6** provider calls. No order or
  payment id is taken from the client.
- `GET /v1/orders/{id}/payments` per order. Razorpay documents no
  pagination for this endpoint; the list is treated as complete only when
  `count` equals the items returned and is below 10 (the documented
  default page size of other collections). Anything else marks the answer
  incomplete.
- Each listed payment must be a valid payment of exactly that order with the
  attempt's amount and currency; if the listed entity cannot be parsed it is
  fetched individually (`GET /v1/payments/{id}`) within the call budget.
  Mismatches are not applied (and make the answer incomplete).
- Valid payments go through `payment_apply_observation` (the same path as
  explicit verification and the webhook). The fulfilment pointer is never
  replaced; `confirmed` is reported only for the payment the pointer names.
- A booking that is already fulfilled always reports its fulfilling
  payment (from `payment_booking_payment_context.fulfilling_payment`), even
  when it belongs to an older order outside the 3-order bound: one of the 6
  calls is reserved to fetch it.

Response 200:

```json
{ "booking_id": "…", "booking_status": "…", "mode": "recovery",
  "complete": true, "result": "…", "razorpay_payment_id": "pay_…|null",
  "payment_status": "…|null", "provider_refund": "none|partial|full|null",
  "other_payments": [ { "razorpay_payment_id": "pay_…", "payment_status": "…",
                        "provider_refund": "none|partial|full", "result": "…",
                        "decision": "…|null" } ],
  "checkout_lease": "none|yours|other|ended" }
```

`result` describes the most significant payment found (`confirmed` >
`not_fulfilled` > `payment_pending` > `payment_failed`), or
`no_payment_found` (only when `complete` is true; it does not prove a
payment cannot still be made on an open order). `complete: false` means
more orders or payments may exist, so **additional payments cannot be
ruled out**; it is never "no additional payments". `complete: true` means
every record the server could reach was inspected and is reported; it
does not prove the provider holds nothing more (the list endpoint's
completeness is a documented-behaviour assumption, see below). Nothing
found on an incomplete inspection is `503 recovery_incomplete`; any
provider failure is `503 payment_provider_unavailable` (a failed fetch
never means "no payment"); a deterministic apply rejection is `502
verification_failed`.

**`other_payments`** lists EVERY OTHER valid payment found on the booking's
orders (each already applied through the single settlement path), most
significant first, at most 10 (a longer list makes the answer incomplete).
So a booking confirmed by payment A with a second captured payment B
answers `result: "confirmed"` for A and
`other_payments: [{ B, captured, result: "not_fulfilled", decision:
"duplicate_capture" }]`. `result` is that payment's own outcome and
`decision` is OUR stored, write-once label (below) or `null` (pending,
failed, or decided before labels existed). `provider_refund` is a provider
fact; nothing in this response says a refund was created or completed, and
refunds are not implemented. Only ids, statuses and these labels are
returned, never a provider payload.

**`checkout_lease`** is the booking's Checkout lease as seen by this
caller: `none` (no order handed out; create-order would grant one), `yours`
(the supplied session holds it), `other` (another session, an order handed
out before leases existed, or no session supplied), `ended` (a lease ended;
never re-granted). It is read from the booking's open attempt and says
**nothing about whether a payment exists**: `no_payment_found` with `other`
or `ended` means create-order will refuse, not that a payment was made, and
a payment is never inferred from the lease. An unknown or missing lease
state is reported as `other` (fail closed).

**Rate limiting: not implemented (deferred).** Every call costs one
provider fetch (a recovery call up to 6). An in-memory limit would be per Edge instance and trivially
bypassed, and a durable limit needs state the schema does not have. The
fetch is not skipped for already-confirmed payments either, because the
provider's refund state can change after fulfilment. Recommended later
design: a `payment_rate_limits (user_id, bucket_start, count)` table with a
service_role-only SQL function that increments with
`INSERT … ON CONFLICT (user_id, bucket_start) DO UPDATE SET count = count + 1
RETURNING count` and refuses above a per-minute limit (atomic, bounded, one
row per user per window, pruned by age), called before the provider fetch.

## Frontend (Razorpay TEST mode)

- Switch: `VITE_RAZORPAY_TEST_KEY_ID=rzp_test_…` in `.env.local` (public key
  id only; it must equal the Edge Functions' `RAZORPAY_KEY_ID`). Unset, a
  live key or any non-test value keeps online payment off and the UI keeps
  its "payment is not available yet" copy. There is no live fallback.
- Flow (`services/bookingCheckout.ts`, `components/BookingPaymentPanel.tsx`):
  an existing hold → `payments-create-order` (booking id only; the order,
  amount, currency and key come from the server, and the key must equal the
  configured test key) → Razorpay Checkout → `payments-verify` with the
  payment id Checkout returned. Checkout's success callback and signature are
  never treated as proof.
- Only `result === "confirmed"` shows "Booking confirmed". Transient failures
  are retried up to 3 times with a delay, then by the user ("Check payment
  status") at most 5 times per panel.
- **Before any new order** the flow runs a booking-based recovery check. Only
  a complete answer of `no_payment_found` lets Checkout open. Any payment,
  a failed one included, an incomplete answer or a failed check blocks it
  (and the server's lease enforces the same rule).
- Recovery requests carry this page's checkout session, so the answer says
  whose Checkout lease the booking has. A complete `no_payment_found` clears
  the way only with lease `none` or `yours`; `other` or `ended` keeps the
  record and shows "a payment window may be open elsewhere" (never "you can
  pay"), without claiming a payment exists.
- `409 checkout_in_progress` / `payment_may_exist` from create-order mark the
  booking unresolved: no Pay button, only "Check payment status". The
  refusal is also remembered for the booking in page memory and overrides a
  later recovery answer that would offer a payment; after a reload the
  server's lease state takes over.
- `other_payments` are shown under the main result. A confirmed booking with
  an additional captured payment is "Booking confirmed, additional payment
  found" (warning): the extra payment's id, that it did not confirm the
  booking, our recorded decision, the provider's refund report worded as a
  provider fact, and that refunds are not handled automatically yet. An
  incomplete answer says additional payments cannot be ruled out and can be
  re-checked.
- After Checkout returns a payment id, that payment is verified first; if
  that stays ambiguous, "Check payment status" uses recovery (no id).
- One unresolved-payment record per booking in page memory
  (`hasUnresolvedPayment`): set when Checkout opens, kept on dismissal,
  timeout or verification failure, cleared only by an authoritative answer
  (`confirmed`, or a complete recovery that found no payment at all). While it is set no
  panel offers or opens Checkout. It is not persisted (no browser storage)
  and does not cross tabs; the recovery check above covers reloads, other
  tabs and devices.
- checkout.js is loaded first, bounded to 15 s, so no order is requested
  for a Checkout that cannot open.
- Checkout's own `timeout` is `hold_seconds_remaining` minus the time spent
  since the order arrived, minus 60 s, at most 600 s; under 60 s, or a
  missing or invalid hold, Checkout is not opened (fail closed).
- A watchdog (timeout + 120 s) closes a Checkout that never reports back
  (`rzp.close()` where available) and treats it like a dismissal, never as
  a failure. A success callback that arrives afterwards is still verified
  with the server, but only while that Checkout is the latest one and no
  other flow runs; an obsolete Checkout's callback only adds its payment id
  to the unresolved record.
- Every payment request has a 30 s timeout; a timeout is "no answer"
  (retryable), never evidence that nothing happened.
- Authoritative answers are announced (`onBookingPaymentChange`) so the
  bookings list refreshes even after the panel was closed.

## Webhook behaviour

1. Body read with a 256 KiB cap (413 above it).
2. `X-Razorpay-Signature` verified against `RAZORPAY_WEBHOOK_SECRET`
   (and `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` during a rotation); 401 otherwise.
3. `x-razorpay-event-id` required (dedupe key); JSON required; the event
   type must fit the inbox limit (100 characters); 400 otherwise.
4. Stored in `payment_events` with a minimised payload (no contact data).
   A redelivery of a processed event answers 200 `duplicate`.
5. `payment.authorized|captured|failed` and `order.paid`: the payment is
   fetched from the API and applied. Other events are recorded as ignored.
6. 2xx only when durably handled; transient failures answer 503 (Razorpay
   redelivers for 24 h) and are recorded on the event (`attempts`, `last_error`),
   which stays unprocessed so the redelivery reprocesses it.

Failure classes (`20261021190000`):

| Class | Examples | Event | Answer |
|---|---|---|---|
| transient | provider timeout, network, 429, 5xx, unreadable body, 401/403; database errors outside SQLSTATE classes 22/23, including `40001` from a concurrent payment association | unprocessed, `attempts`/`last_error` | 503 |
| deterministic | provider 400 (other than "does not exist"), a well-formed but invalid provider response, database class 22/23 rejections, a payment event without a payment id (`missing_payment_id`) or with one that is not a provider payment id (`unrecognised_payment_id`) | processed, `process_result` = the class (e.g. `apply_rejected:23514`) | 200 (503 if the classification cannot be written) |
| permanent anomaly | identity/order conflict with the stored payment, `attempt_booking_mismatch` | processed with the anomaly; payment left unmatched / unchanged | 200 |

Settlement outcomes (`payment_events.process_result`, and the payment row):
`fulfilled`, `not_captured`, `already_fulfilled`, `late_capture`,
`duplicate_capture`, `refunded_before_settlement`, `refund_obligation`,
`amount_mismatch`; unmatched payments keep `attempt_id`/`booking_id` NULL
and are never refunded automatically.

### Durable settlement decisions (`20261024190000_payment_settlement_decisions_and_lease_state.sql`)

Until this migration a non-fulfilling decision was labelled only on the
webhook path (`payment_events.process_result`); a payment settled by
explicit verification or recovery kept just `decision_recorded_at`, so a
late and a duplicate capture were indistinguishable. Now
`payments.settlement_decision` holds the label of every decision, whichever
path made it:

- written by `payment_settle_locked` in the same UPDATE as
  `decision_recorded_at`, under the payment-row lock (lock order unchanged:
  booking → attempt → payment). Values: `fulfilled`, `late_capture`,
  `duplicate_capture`, `refunded_before_settlement`, `refund_obligation`;
- **write-once**: a trigger refuses to change or clear it and refuses to set
  it on a payment whose decision was already recorded without one; CHECKs
  restrict the values and require a recorded decision;
- **never recomputed**: observing the payment again returns
  `already_decided` and never reaches the UPDATE, and two racing
  observations serialise on the payment-row lock, so the second finds the
  first one's decision. A later refund fact is merged into the provider
  columns only; a refunded duplicate stays `duplicate_capture`;
- `NULL` = undecided, or decided before labels existed. The backfill labels
  only the certain case (the payment that fulfilled its booking) and
  deliberately does not guess the others;
- it is OUR record of the decision about captured money, not a refund state.
  Refund state lives in `refunds`, which nothing creates yet.

**Not solved here (needs the refund/reconciliation slice):** a non-fulfilling
captured payment is durably recorded and labelled, and appears in the refund
work list, but nothing acts on it. Lateness is still judged at observation
time (`expires_at <= now()`), not capture time, so a payment captured inside
the hold but first observed after it is labelled `late_capture`; fixing that
needs the provider's capture time and a policy for it.

## Configuration (server-only)

| Variable | Notes |
|---|---|
| `RAZORPAY_KEY_ID` | `rzp_test_…`. `rzp_live_…` is refused unless `RAZORPAY_ALLOW_LIVE_KEYS=true` (not for this slice) |
| `RAZORPAY_KEY_SECRET` | never returned or logged |
| `RAZORPAY_WEBHOOK_SECRET` | webhook HMAC secret; `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` optional |
| `RAZORPAY_API_BASE` | optional. Real mode: unset or exactly `https://api.razorpay.com`; any other value disables payments (no fallback). Plain http is accepted **only** in simulator mode, for the local simulator origins below |
| `PAYMENT_SIMULATOR` | unset in every real environment. `local-only` enables the local simulator mode below; any other non-empty value disables payments |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | provided by the Edge runtime |

Never put any of these in a `VITE_*` variable or commit them. Without
Razorpay credentials, `payments-create-order` answers 503
`payments_unavailable` before writing anything, and the webhook records
payment events as not processed (503).

### Local simulator mode (`PAYMENT_SIMULATOR=local-only`)

For local demos and tests without Razorpay (`supabase/payment-simulator`).
`readConfig` (`_shared/config.ts`) enables it only when every condition holds;
otherwise payments are disabled (no provider call):

- `SUPABASE_URL` is `http://kong:8000` (what `supabase functions serve`
  injects) or `http://127.0.0.1:<port>` / `http://localhost:<port>`;
- `RAZORPAY_API_BASE` is exactly `http://host.docker.internal:59480`,
  `http://127.0.0.1:59480` or `http://localhost:59480`;
- `RAZORPAY_KEY_ID` is the placeholder `rzp_test_LOCALSIMULATORONLY`,
  `RAZORPAY_KEY_SECRET` is unset (or the documented placeholder; the
  placeholder is what is sent), and `RAZORPAY_ALLOW_LIVE_KEYS` is unset.

What this guarantees, and what it does not:

- **Supabase Cloud:** cannot satisfy it (the platform sets
  `SUPABASE_URL=https://<ref>.supabase.co`).
- **Self-hosted Supabase:** its gateway is also `http://kong:8000`, so the
  guard only prevents *accidental* enabling. An operator who deliberately
  sets all of the values above (and runs the simulator on that host) would
  enable it, and simulated payments would confirm real bookings in that
  database. Never set `PAYMENT_SIMULATOR` outside a disposable local stack.
- Simulated payments are stored with `provider = 'razorpay'`; only their
  ids (`order_SIMULATED…`, `pay_SIMULATED…`) tell them apart.

### What each kind of test does and does not show

| Kind | Provider | Checkout in the browser | Shows | Does not show |
|---|---|---|---|---|
| Deno unit tests (`tests/*_test.ts`) | scripted fake HTTP | none | handler logic, parsing, refusal paths | anything about a running stack |
| `local_stack_e2e_test.ts` | in-process fake | none | real GoTrue/PostgREST/Postgres, settlement | the served Edge Runtime |
| `simulator_stack_e2e_test.ts` | local simulator over HTTP | none | served Edge Functions + real DB + simulator | Razorpay's real API |
| `e2e/checkout-browser/` run | local simulator | **mocked** Checkout callbacks | the real UI, controller and backend together | Razorpay Checkout itself, real callback timing |
| Razorpay **test mode** | Razorpay test API | real Checkout.js | real provider behaviour, no real money | **not performed yet** |
| Live mode | — | — | — | not supported: live keys are refused |

None of the simulator or mocked runs proves Razorpay's real pagination,
consistency, capture, refund or webhook behaviour.

## Tests

```bash
cd supabase/functions && deno test tests/
```

`config_test.ts`, `create_order_test.ts`, `verify_test.ts`,
`verify_recovery_test.ts` and `webhook_test.ts` mock all HTTP (no network).
`simulator_stack_e2e_test.ts` drives the *served* functions against the
disposable stack and the simulator; it refuses any gateway but
`http://127.0.0.1:59401` and is skipped unless its `SIM_E2E_*` variables
are set (see its header).
`local_stack_e2e_test.ts` runs against a **local** stack (real GoTrue,
PostgREST, Postgres; Razorpay still mocked) and is skipped unless
`E2E_SUPABASE_URL` is a `127.0.0.1`/`localhost` URL with `E2E_ANON_KEY`
and `E2E_SERVICE_KEY` set:

```bash
deno test --allow-net=127.0.0.1 --allow-env tests/local_stack_e2e_test.ts
```

It leaves throw-away users (`e2e-*@unisport-payments.test`) and fixture
rows (facility named `E2E <run>`, payments `pay_E2E*`, events `evt_E2E*`)
that must be removed with SQL afterwards (service_role has no DELETE on
the payment tables).

Database tests: `payment_settlement_functions_test.sql`,
`payment_checkout_lease_test.sql`, `payment_settlement_decision_test.sql`
(decision labels on the explicit path, write-once, lease state in the
context) and
`payment_settlement_concurrency_test.sql` (S12: concurrent lease
acquisition; S13: decisions labelled and never overwritten by a concurrent
re-observation) in `supabase/tests/database`.

## Optional manual Razorpay test-mode smoke test (not run)

Requires explicit authorization and real Razorpay **test** credentials;
never with live keys. Not performed yet: nothing in this repository has
been verified against the real Razorpay API.

1. Create an env file **outside the repository** with `RAZORPAY_KEY_ID`
   (`rzp_test_…`), `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`. Do not
   set `PAYMENT_SIMULATOR` or `RAZORPAY_API_BASE`.
2. Use a **disposable** local stack that has every migration applied, and
   serve against it explicitly:
   `supabase functions serve --workdir <disposable workspace> --env-file <that file>`.
3. As a signed-in user with a `pending_payment` booking:
   `POST http://127.0.0.1:<that stack's API port>/functions/v1/payments-create-order`
   with `{"booking_id": "…", "checkout_session": "<a UUID>"}` and the
   user's JWT. Expect an `order_…` id.
4. Pay in Razorpay test Checkout with that order id and `key_id`.
5. Deliver the webhook: Razorpay cannot reach localhost, so either use a
   tunnel to `/functions/v1/payments-webhook` with the test-mode webhook
   configured in the dashboard, or replay the captured event body with a
   locally computed signature.
6. Expect the booking `confirmed`, `payment_status = paid`, and the
   payment as `bookings.fulfilled_by_payment_id`.

## Not in this slice

- Refund creation/submission/retry and refund webhooks (refund events are
  recorded as ignored). The work list for the refund slice is every
  matched captured payment with `decision_recorded_at` set that is not a
  booking's `fulfilled_by_payment_id`.
- Scheduled reconciliation: stale `creating` attempts, unprocessed events,
  attempts of bookings that expired by the clock, manual-capture accounts
  (`authorized` payments are not captured by this code).
- Deployment, hosted secrets, notifications.
