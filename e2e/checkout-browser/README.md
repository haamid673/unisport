# Local browser checkout run (test only)

This directory drives the **real checkout UI** against the disposable local
stack (`unisport-slice1h`, `http://127.0.0.1:59401`). The backend is the
real Edge Functions (`supabase functions serve`, simulator mode). The
provider is the local payment simulator (`supabase/payment-simulator`).

**Nothing here is Razorpay.**
- No money moves.
- `checkout.razorpay.com` is never loaded.
- No provider is contacted.

| File | Role |
|---|---|
| `vite.config.ts` | Serve-only dev config. It injects `mock-checkout.js` before the app on every page load, binds to 127.0.0.1:3000 (and fails if a `--host` flag would change that), reads its env from outside the repo, and refuses any backend but the disposable stack. It also refuses `vite build` and `vite preview`. |
| `guards.test.ts` | Runs with `npm test`, starting no server and using no network: proves the Vite config's refusals and the harness's refusal of any target but the disposable stack. |
| `mock-checkout.js` | A visible, labelled stand-in for `window.Razorpay`. It records the options the app passes (order, amount, currency, key). It fires the same callbacks the production opener registers: `handler`, `payment.failed`, `modal.ondismiss`, plus `close()`. The payment id it reports is typed in by the operator. |
| `harness.ts` | A Node script run **outside the browser**. It creates run-prefixed fixtures, drives the simulator's control API (the control token never reaches the page), reads persisted state, and prints a cleanup script. |

## Why no browser framework

The project has no Playwright, Puppeteer or Cypress. Adding one means
downloading packages and browser builds and changing the lockfile. This
run used an agent-driven browser instead: the Claude desktop browser pane.
The same steps work by hand in any browser pointed at
`http://127.0.0.1:3000`.

## Run (all secrets in files outside the repo, mode 600)

1. Start the simulator on `127.0.0.1:59480`, with a control token from an
   env file (see `supabase/payment-simulator/README.md`).
2. Serve the functions from the disposable workspace:
   `supabase functions serve --workdir <workspace> --env-file <file>`.
   The env file holds `PAYMENT_SIMULATOR=local-only`,
   `RAZORPAY_API_BASE=http://host.docker.internal:59480`,
   `RAZORPAY_KEY_ID=rzp_test_LOCALSIMULATORONLY`, and a local
   `RAZORPAY_WEBHOOK_SECRET`. Leave `RAZORPAY_KEY_SECRET` unset.
3. Create `<dir outside the repo>/.env.local` with `VITE_SUPABASE_URL`, the
   stack's anon key as `VITE_SUPABASE_PUBLISHABLE_KEY`, and
   `VITE_RAZORPAY_TEST_KEY_ID=rzp_test_LOCALSIMULATORONLY`. Then run:
   `BROWSER_E2E_ENV_DIR=<that dir> npx vite --config e2e/checkout-browser/vite.config.ts`
4. Create a harness env file with `BROWSER_E2E_SUPABASE_URL`,
   `BROWSER_E2E_SERVICE_KEY`, `BROWSER_E2E_CONTROL_TOKEN`,
   `BROWSER_E2E_STATE_FILE` and `BROWSER_E2E_SECRETS_FILE`. Use it with:
   `node --env-file=<file> e2e/checkout-browser/harness.ts setup A s02-success`
   This creates a user and a pending booking. The generated password goes
   to the secrets file.
5. In the browser:
   - Sign in, then press **Pay now**. The mock Checkout opens.
   - `harness.ts pay <booking> captured|authorized|failed` creates the
     provider-side payment.
   - Type its id into the mock and press **Report successful payment**,
     **Report failed payment**, or **Close checkout**.
   - `harness.ts state <booking>` shows the booking, attempts, payments,
     refunds and simulator orders.
6. Cleanup:
   `harness.ts cleanup-sql | docker exec -i supabase_db_unisport-slice1h psql -U postgres -d postgres`
   This removes **unconfirmed** fixtures only, with every guard and
   foreign key in force. A confirmed booking can't be removed without
   disabling `bookings_guard_fulfilment`, which this never does. Those
   fixtures stay, and the script names them.

## Retained fixtures in the disposable stack (do not delete, do not use)

The browser run of 2026-10-17 (run `1f016133`) left **two confirmed
fixture bookings** in the disposable `unisport-slice1h` database. Cleanup
removed everything else it created. These remain because a confirmed
booking's `fulfilled_by_payment_id` is write-once
(`bookings_guard_fulfilment`), and cleanup must never disable that guard:

| Fixture | Booking id | Provider order | Payments (decision) |
|---|---|---|---|
| `s02b-success` | `d28b2654-fbd0-4463-80d7-64e428b29bbc` | `order_SIMULATEDRPDQRI000002` | `pay_SIMULATEDRPDQRI000001` (fulfilled) |
| `s09-duplicate` | `2d9ff55c-121e-4264-8e96-acd8d8a0aa1b` | `order_SIMULATEDRPDQRI000003` | `pay_SIMULATEDRPDQRI000002` (fulfilled), `pay_SIMULATEDRPDQRI000003` (duplicate_capture) |

With them remain:
- their two closed attempts;
- their facilities (`BROWSER 1f016133 s02b-success`, `BROWSER 1f016133 s09-duplicate`) and slots;
- the test user `browser-e2e-1f016133-a@unisport-payments.test`. Its password was generated for the run and has been destroyed.

They are simulated, not real. Don't use them for demonstrations or treat
them as real bookings. Re-running `cleanup-sql` for that run stops with
"fixture set mismatch" (its other rows are gone) and changes nothing.
Removing these two needs a separate, explicitly approved decision: a
reset of the disposable stack, or a reviewed one-off. Never make a
routine guard bypass.

## What it does not show

- **Real Razorpay behaviour:** Checkout's own UI and retries, capture
  settings, list completeness, and webhook delivery.
- **Real callback timing:** the mocked callbacks show how the app
  reacts, not when the real provider would fire them.
