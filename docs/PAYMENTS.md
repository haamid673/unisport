# Payments

**Status: built, tested against a local simulator, and switched off.** In the
demo and by default there is no online payment: a reservation is a 10-minute
unpaid hold that expires on its own, and the UI says "payment is not available
yet". No live Razorpay key is used anywhere, and no request has ever been sent
to Razorpay from this repository. Decision D6: demos use the simulator only.

This document is the overview. The detailed contract (order creation and
recovery, the payment window, checkout leases, verification, webhooks,
reconciliation) is in `supabase/functions/README.md`, and the simulator is
described in `supabase/payment-simulator/README.md`.

## Principles

1. **The browser is never trusted with money.** It never talks to the
   Razorpay API and never sees a server credential. The only public value it
   holds is the test key **id** (`rzp_test_…`); live keys (`rzp_live_…`) are
   refused.
2. **The database decides.** Amount, ownership and eligibility come from the
   booking row under a lock. Anything the browser sends (amount, user, order
   id, "success") is ignored.
3. **Facts come from the provider, server-side.** A payment is always fetched
   from the Razorpay API with the server key. A webhook body only says which
   payment to fetch, after its HMAC-SHA256 signature is verified.
4. **Settlement happens in one place.** Only `payment_apply_observation`
   confirms a booking, on the facts just fetched. A created order, an
   authorized payment, or a webhook alone never confirms anything.
5. **Never two orders for one attempt.** The attempt row is written before the
   provider call and its id is the order `receipt`; recovery looks the order
   up by receipt before ever creating one.
6. **No double checkout.** A checkout lease allows one honest Checkout session
   per hold; a failed payment is never treated as final.

## Flow (when enabled)

1. The player holds a slot (`create_booking`), then chooses Pay now.
2. `payments-create-order` (JWT required) prepares an attempt, creates or
   recovers the provider order, and returns the order under a lease. It
   refuses unless at least 180 seconds of the hold remain.
3. The browser opens Razorpay Checkout (loaded from `checkout.razorpay.com`
   only at that moment) and ends it 60 seconds before the hold ends.
4. After Checkout, `payments-verify` fetches the payment, checks it belongs to
   this booking's own order with the expected amount and currency, and settles
   through the same path as the webhook. `payments-webhook` (HMAC-verified)
   settles payments the browser never reported.
5. A payment that arrives after the hold ended is recorded as a **late
   capture** (`payment_status` and a reconciliation record) rather than
   silently confirming or losing money.
6. Refunds are out of scope: a confirmed booking cannot be cancelled in the
   app (`cancel_booking` refuses it).

## Switching it on or off

Payment is on only when `VITE_RAZORPAY_TEST_KEY_ID` is set to a test key id
(`services/razorpayCheckout.ts`). Unset, which is the default, the Pay and
Check payment controls never render and the Edge Functions are not needed.
Edge Function secrets (`RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`) live
only in the functions' environment, never in `VITE_*` and never in the repo.

## The simulator

`supabase/payment-simulator` is a local, in-memory stand-in for the four
Razorpay endpoints the functions call, bound to 127.0.0.1:59480, outside
`supabase/functions` so it can never be deployed. It lets the real Edge
Function code run end to end against scripted provider answers, including
timeouts, duplicates, mismatches and late captures. It proves nothing about
Razorpay's real behaviour. The browser run in `e2e/checkout-browser/` drives
the real checkout UI against it with a labelled mock Checkout.

## What is verified, and what is not

| Verified (automatically) | Not verified |
|---|---|
| Schema, settlement, recovery, lease and lock order (pgTAP, including multi-session) | Real Razorpay pagination, consistency, capture and refund behaviour |
| Edge Function logic against the simulator (Deno) | A live or test-mode Razorpay account, real webhooks, real Checkout |
| Checkout UI states with a mock Checkout (Vitest and a manual local run) | Refunds and chargebacks (not implemented) |

Resuming payments (Phase 8 of the completion plan) would start with a
Razorpay **test-mode** account, deploying the three functions to the project,
configuring the webhook, and repeating the simulator scenarios against the
real test API before any further step.
