# Local payment simulator

A local-only, in-memory stand-in for the four Razorpay endpoints the
payment Edge Functions call. It lets the real order creation, webhook
observation, settlement and recovery code run against simulated
provider answers **without contacting Razorpay**.

**It is not Razorpay.** No money moves, and it proves nothing about
Razorpay's real pagination, consistency, capture or refund behaviour.
It answers only in the shapes our client
(`supabase/functions/_shared/razorpay.ts`) parses.

It lives outside `supabase/functions`, so `supabase functions deploy`
can never ship it.

## Run

```bash
cd supabase/payment-simulator
export PAYMENT_SIMULATOR_CONTROL_TOKEN="$(openssl rand -hex 32)"   # optional; enables the control API
deno run --allow-net=127.0.0.1 --allow-env=PAYMENT_SIMULATOR_CONTROL_TOKEN,PAYMENT_SIMULATOR_PORT server.ts
```

- It listens on **127.0.0.1:59480** only, never on another interface.
  `PAYMENT_SIMULATOR_PORT` (1024–65535) is for tests. The Edge Function
  guard accepts only 59480.
- Without `PAYMENT_SIMULATOR_CONTROL_TOKEN`, only the provider API runs.
  The token must be at least 32 characters of `[A-Za-z0-9_-]`, and it is
  never printed.
- The Edge Functions use it only in simulator mode
  (`supabase/functions/_shared/config.ts`):
  - `PAYMENT_SIMULATOR=local-only`
  - `RAZORPAY_API_BASE=http://host.docker.internal:59480`
  - `RAZORPAY_KEY_ID=rzp_test_LOCALSIMULATORONLY`
  - no real secret, and a local `SUPABASE_URL`.

  `supabase/functions/tests/simulator_stack_e2e_test.ts` and
  `e2e/checkout-browser/` use it this way. On self-hosted Supabase the
  guard only prevents accidental enabling (its gateway is also
  `http://kong:8000`); see `supabase/functions/README.md`.

## Provider API (Basic auth with the simulator placeholder key only)

| Request | Answer |
|---|---|
| `POST /v1/orders` `{amount, currency, receipt, notes}` | an order entity (`status: created`) |
| `GET /v1/orders?receipt=…&count=…` | `{entity: collection, count, items}`: exact receipt only, newest first |
| `GET /v1/payments/{pay_id}` | a payment entity, or 400 "The id provided does not exist" |
| `GET /v1/orders/{order_id}/payments` | that order's payments only |

Request rules:
- The amount must be an integer from 100 to 1,000,000,000 paise.
- The currency must be `INR`.
- The receipt must be 1–40 characters of `[A-Za-z0-9_-]`.
- `notes` may have at most 15 entries of strings.
- Unknown fields and parameters are refused.
- Bodies are limited to 8 KiB.

Every request is also refused unless its `Host` header names this server
(127.0.0.1, localhost or host.docker.internal on its port), and any
request carrying an `Origin` header is refused, so browsers cannot use
it.

The ids look like `order_SIMULATED<RUN><n>` and `pay_SIMULATED<RUN><n>`.
`<RUN>` is a random six-character run id, so ids never repeat across
restarts while the database keeps the old ones.

## Control API (`X-Simulator-Control-Token` header, POST only)

| Request | Effect |
|---|---|
| `/__control/orders/{order_id}/payments` `{outcome, amount?}` | a new payment on that order: `captured`, `authorized` or `failed` |
| `/__control/payments/{pay_id}/authorize` | `failed` → `authorized` (late authorization) |
| `/__control/payments/{pay_id}/capture` | `authorized` → `captured` |
| `/__control/payments/{pay_id}/refund` `{amount?}` | a partial or full refund of a captured payment |
| `/__control/faults` `{operation, mode, delay_ms?, times?}` | the next call(s) to `create_order`, `find_orders`, `fetch_payment` or `order_payments` fail with `server_error` (500) or `rate_limited` (429), with no effect, or succeed but answer only after a `delay` (≤ 30 s), which gives an unknown outcome for the caller |
| `/__control/reset` | forget all orders, payments and faults (ids keep counting) |

## Test

```bash
cd supabase/payment-simulator
deno test --allow-net=127.0.0.1 simulator_test.ts
```

The tests use an ephemeral loopback port and the real client and parsers
from `supabase/functions/_shared/razorpay.ts`. The network permission
limits them to 127.0.0.1.

## Deliberate differences from Razorpay (assumptions, not verified)

- A second capture on a paid order is allowed, so duplicate handling can
  be exercised. Real Razorpay may refuse a second payment on a paid
  order.
- Several orders may share a receipt. The app treats that as a conflict
  and does not choose between them.
- Order-payment lists are never paginated (at most 20 payments an order).
  The client still treats 10 or more items as possibly incomplete.
- Payment list order is creation order, and order lookup by receipt is
  newest first. Neither is verified against Razorpay.
- No webhooks are sent: tests sign webhook events themselves. Nothing here
  talks to any other host.
