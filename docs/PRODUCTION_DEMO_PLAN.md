# Plan: a hosted, public demo with Razorpay test-mode payments

Status: **plan only. Nothing here has been done.** Every step that touches a
hosted service is a gate that needs the owner's explicit approval at that
moment (see `DEPLOYMENT_RUNBOOK.md`, which this plan builds on).

Goal: a real URL anyone can open to try UniSport end to end, including paying
for a booking, **with no real money ever moving**.

## 1. The payment question: use Razorpay *test mode*, not ₹1 live payments

| Option | Money moves? | Needs | Verdict |
|---|---|---|---|
| **Razorpay test mode** (test API keys `rzp_test_…`, test cards/UPI) | **No, never.** Payments are simulated by Razorpay and appear only in the dashboard's Test Mode | A free Razorpay account (test keys are available immediately) | **Recommended.** Real Razorpay Checkout, real orders, real signatures and webhooks; zero financial risk |
| Live mode with ₹1 payments | **Yes, real ₹1 each**, and refunds are not implemented here | Completed business KYC, live keys on a public site, a refund/dispute process | Rejected. It breaks our own rule (no live keys), invites abuse (anyone can charge you), and adds nothing a demo needs |

Test mode is not a mock: the code path is the production path (create order →
Checkout → verify → webhook → settle). The only difference is the key. In
test mode any amount works, so existing prices stay (₹500, ₹1,200); making
them ₹1 gains nothing.

What a visitor does: pick a slot → *Pay now (test mode)* → Razorpay's real
Checkout opens → pays with a published test card (e.g. `4111 1111 1111 1111`,
any future expiry, any CVV, OTP step skipped/`1234` per Razorpay's test
docs) or the test UPI id → booking turns **Confirmed**. A failing test card
shows the failure path. A visible banner says "Demo: payments run in Razorpay
test mode. No money is charged."

**Honest caveat:** the payment code has only ever run against our local
simulator. Real Razorpay may differ in details (pagination, status timing,
webhook retries). Phase C below verifies it against Razorpay's real **test**
API on a local stack *before* anything is hosted, so surprises are cheap.

## 2. Target architecture (all free-tier friendly)

```
Visitor browser ──► Static host (SPA, HTTPS, SPA fallback)
       │                    │ build has only the publishable key + the TEST key id
       ├── Supabase Auth / PostgREST / RPC  (hosted project, pg_cron on)
       ├── Supabase Edge Functions: payments-create-order, payments-verify, payments-webhook
       └── checkout.razorpay.com (Razorpay's own Checkout script, test mode)

Razorpay (test mode) ──webhook (HMAC)──► payments-webhook on the hosted project
```

- **Frontend host:** Cloudflare Pages, Netlify or Vercel (any works; all free
  for this size), deployed from GitHub. Needs `index.html` fallback and a
  Content-Security-Policy that allows exactly `checkout.razorpay.com` (script,
  frame) and the Supabase origin. Recommendation: **Cloudflare Pages** or
  **Netlify** (simple `_redirects` + `_headers` files, no config UI maze).
- **Backend:** a **new, empty hosted Supabase project** dedicated to the demo
  (not the project linked during development).
- **Secrets:** `RAZORPAY_KEY_ID` (test), `RAZORPAY_KEY_SECRET` (test),
  `RAZORPAY_WEBHOOK_SECRET` live only as Supabase Edge Function secrets, set
  by you in the dashboard (or by you via the CLI). They never enter the repo,
  a `VITE_*` variable, chat or my context. The browser gets only the public
  test key *id*.

## 3. Phases

### Phase A: decisions and accounts (you; ~30 min)

You decide or create, and tell me the *names only* (never keys or passwords):

1. Frontend host (recommend Cloudflare Pages or Netlify) and whether you want a
   custom domain (optional; a `*.pages.dev` / `*.netlify.app` URL is fine).
2. A new hosted Supabase project (free tier) for the demo; note its project
   reference. Keep the database password in your password manager.
3. A free Razorpay account, staying in **Test Mode**. Create test API keys and
   keep them private. (No KYC needed for test mode.)
4. Email for password reset and (optionally) sign-up confirmation: either
   Supabase's built-in sender (very low hourly limit, fine for a few demos) or
   a free provider such as Resend/Brevo with SMTP credentials. Recommendation:
   built-in sender, confirmations **off**, reset links on for the owner's own
   accounts only; upgrade to Resend if you expect many visitors.
5. Push access: the branch must reach GitHub (a push and a pull request),
   which I will only do when you say so.

### Phase B: code work, no hosted contact (me; ~2–3 days)

| # | Work | Why |
|---|---|---|
| B1 | **Demo banner + test-mode copy** in the Pay panel and footer ("Razorpay test mode, no money moves", with the test card to use, one tap to copy) | honesty; visitors know how to pay without guessing |
| B2 | **Password reset** (request link, set new password; no account enumeration) using Supabase Auth | backlog B-05; accounts must be recoverable |
| B3 | **Demo accounts and data**: a documented, idempotent *hosted* seed procedure (SQL for you to run) creating one demo owner, one demo player, 2–3 venues with slots and hours, a community and an event; the admin credentials are **not** public | a visitor sees a living product on first open |
| B4 | **Self-cleaning demo**: a `pg_cron` job (migration) that cancels stale unpaid holds already (exists) plus trims demo noise nightly (optional: delete test communities older than N days, never touching seed rows) | keep the demo presentable without manual care |
| B5 | **Abuse limits** suited to a public demo: per-user caps already exist; add Auth rate limits and (optional) Cloudflare Turnstile on sign-up | free-tier safety |
| B6 | **Static host files**: `_redirects`/`_headers` (SPA fallback, CSP, caching, nosniff, referrer policy), `VITE_BASE_PATH` check, production `.env` template | deploy-ready build |
| B7 | **Admin audit trail** (`admin_actions` table written by the admin functions, shown in the console) | credibility for an "admin" demo; backlog item |
| B8 | **Cleanup**: remove the unused prototype files (backlog B-14) | smaller bundle, nothing misleading |
| B9 | **Deno job in CI** for the payment functions (pin a verified action) and a **browser smoke test** script (Playwright, run on demand) covering sign-in → book → pay (against the mock) → cancel | regression safety before and after deploy |
| B10 | Terms/privacy one-pager ("demo, test payments, data may be reset") linked from the footer | expectation setting |

### Phase C: verify payments against Razorpay's real *test* API, locally (me + your test keys; ~1 day)

Still no hosted project. Run the real Edge Functions on the local stack
with your **test** keys in a git-ignored env file *outside the repo*, and
exercise with the real Test-Mode API:

1. Create order → Checkout (real Razorpay Checkout in the browser) with the
   success card → verify → booking **Confirmed**.
2. Failure card → failure path; retry rules (a failed payment is never
   treated as final, per the design).
3. Close Checkout without paying; reload mid-flow; second tab (lease rules).
4. Webhook: expose the local function through a tunnel (Cloudflare Tunnel or
   ngrok) so Razorpay can call it; verify signature handling and that a
   webhook-only payment settles; replay/duplicate delivery is idempotent.
5. Late capture (hold ended) lands in the reconciliation record.
6. Compare real responses with the simulator's shapes; fix any difference in
   `_shared/razorpay.ts` and add a test for each.

Exit criterion: every scenario in `supabase/functions/README.md` observed
against the real test API at least once.

### Phase D: hosted rollout (gated; ~1 day, with you present)

Follows `DEPLOYMENT_RUNBOOK.md` exactly, each item a gate:

1. Read-only check that the new project is empty (you run the queries).
2. Enable `pg_cron`; set Auth URL configuration and rate limits.
3. Apply the 40+ migrations in order (your hands or my command with your
   approval at that moment); verify counts, RLS and the three cron jobs.
4. Deploy the three Edge Functions with `verify_jwt` as in `config.toml`
   (create/verify true, webhook false); set the three test secrets yourself.
5. Register the Razorpay **test** webhook (URL of the hosted `payments-webhook`,
   events `payment.authorized`, `payment.captured`, `payment.failed`,
   `order.paid`, `refund.*` if used) with the webhook secret.
6. Bootstrap the first admin (manual statement from the runbook), then demo
   seed (B3).
7. Build with the production variables, deploy the static site, set DNS if
   any. Rule: **I never run `db push`, `--linked` or `migration repair`**; the
   repo guards enforce it.

### Phase E: prove it works as a public site (me; ~0.5 day)

- Smoke test on the live URL as player, owner, admin (the demo script), with a
  real test-mode payment and a failed one; confirm the Razorpay dashboard
  (test mode) shows the payments.
- Check no third-party requests except Supabase and Razorpay Checkout; CSP
  works; deep links and refresh work; mobile layout reviewed.
- Basic ops: uptime ping on the site and on a health query, Supabase email
  alerts, a documented "reset the demo" procedure and rollback (previous
  static build; forward-fix migrations).
- README gets the live URL, the demo accounts, the test card, and an honest
  "test-mode demo" note.

## 4. Risks and how the plan handles them

| Risk | Handling |
|---|---|
| Payment code behaves differently on real Razorpay | Phase C before any hosting |
| Someone floods the public demo | per-user caps, Auth rate limits, optional Turnstile, nightly cleanup, free-tier ceilings accepted |
| Test keys or secrets leak | secrets only in Supabase dashboard/your env files; `npm run guards` already scans for live keys and service-role JWTs; test keys are low-risk by nature |
| A visitor assumes it is real | banner, footer, README, terms page |
| Hosted migration mistake | runbook gates, backup/PITR first, forward-fix only |
| Free-tier pausing (Supabase pauses idle free projects) | uptime ping; note to wake it before a presentation |
| Public admin account abuse | admin credentials not public; role changes are admin-only and audited (B7) |

## 5. What I need from you to start

1. Pick the frontend host (or say "your recommendation": Cloudflare Pages).
2. Confirm **Razorpay test mode** (not live ₹1) as the payment approach.
3. Confirm the email approach for reset (built-in now, Resend later) or give a
   preferred provider.
4. OK to start Phase B (local code work only; I will commit locally and ask
   before any push).
5. When we reach C: put your Razorpay **test** keys in a file outside the repo
   (I will give the exact file and variable names); I will never ask you to
   paste a secret into chat.

## 6. Rough timeline

A: 0.5 day (you) · B: 2–3 days · C: 1 day · D: 1 day · E: 0.5 day.
About one working week, mostly sequential; B can begin immediately.
