// End-to-end tests of the SERVED payment Edge Functions (supabase
// functions serve, simulator mode) against the disposable local stack,
// with the local payment simulator (supabase/payment-simulator) as the
// only provider. Nothing here is mocked: requests go through the local
// gateway to the Edge Runtime, which calls the simulator.
//
// Skipped unless every variable below is set; refuses any gateway other
// than the disposable stack http://127.0.0.1:59401.
//
//   SIM_E2E_SUPABASE_URL=http://127.0.0.1:59401
//   SIM_E2E_ANON_KEY / SIM_E2E_SERVICE_KEY   that stack's local keys
//   SIM_E2E_CONTROL_TOKEN                    the simulator's control token
//   SIM_E2E_WEBHOOK_SECRET                   the served functions' local webhook secret
//   SIM_E2E_FIXTURES_FILE                    where created fixture ids are recorded (for cleanup)
//
//   deno test --allow-net=127.0.0.1:59401,127.0.0.1:59480 \
//     --allow-env=SIM_E2E_SUPABASE_URL,SIM_E2E_ANON_KEY,SIM_E2E_SERVICE_KEY,SIM_E2E_CONTROL_TOKEN,SIM_E2E_WEBHOOK_SECRET,SIM_E2E_FIXTURES_FILE \
//     --allow-write=<fixtures file> tests/simulator_stack_e2e_test.ts
//
// It creates throw-away users, facilities, slots and bookings (ids are
// recorded in the fixtures file before use). It removes nothing itself:
// service_role has no DELETE on payment tables, by design.

import { SIMULATOR_KEY_ID, SIMULATOR_KEY_SECRET } from '../_shared/config.ts';
import { hmacSha256Hex } from '../_shared/signature.ts';
import { assert, assertEquals } from './helpers.ts';

const AUTHORITATIVE_GATEWAY = 'http://127.0.0.1:59401';
const SIM = 'http://127.0.0.1:59480';

function env(name: string): string {
  if (Deno.permissions.querySync({ name: 'env', variable: name }).state !== 'granted') return '';
  return Deno.env.get(name) ?? '';
}

const API = env('SIM_E2E_SUPABASE_URL');
const ANON = env('SIM_E2E_ANON_KEY');
const SERVICE = env('SIM_E2E_SERVICE_KEY');
const CONTROL = env('SIM_E2E_CONTROL_TOKEN');
const WEBHOOK_SECRET = env('SIM_E2E_WEBHOOK_SECRET');
const FIXTURES = env('SIM_E2E_FIXTURES_FILE');
const configured = [API, ANON, SERVICE, CONTROL, WEBHOOK_SECRET, FIXTURES].every((v) => v !== '');
if (configured && API !== AUTHORITATIVE_GATEWAY) {
  throw new Error(`refusing to run: SIM_E2E_SUPABASE_URL must be exactly ${AUTHORITATIVE_GATEWAY}`);
}
const enabled = configured;

const RUN = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
const SIM_ORDER = /^order_SIMULATED[A-Z0-9]{6}[0-9]{6}$/;
const SIM_PAYMENT = /^pay_SIMULATED[A-Z0-9]{6}[0-9]{6}$/;
const PROVIDER_AUTH = 'Basic ' + btoa(`${SIMULATOR_KEY_ID}:${SIMULATOR_KEY_SECRET}`);

// ---------------------------------------------------------------
// fixture registry (written before each use, so cleanup survives a failure)
// ---------------------------------------------------------------

const fixtures = {
  run: RUN,
  users: [] as string[],
  facilities: [] as string[],
  slots: [] as string[],
  bookings: [] as string[],
  provider_payment_ids: [] as string[],
  provider_event_ids: [] as string[],
};
function record<K extends keyof typeof fixtures>(kind: K, id: string) {
  (fixtures[kind] as string[]).push(id);
  Deno.writeTextFileSync(FIXTURES, JSON.stringify(fixtures, null, 2));
}

// ---------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------

type Json = Record<string, unknown> & { [k: string]: unknown };
interface Reply {
  status: number;
  // deno-lint-ignore no-explicit-any
  body: any;
  headers: Headers;
}

async function call(url: string, init: RequestInit): Promise<Reply> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch { /* keep text */ }
  return { status: res.status, body, headers: res.headers };
}

// service-role PostgREST / GoTrue (fixture setup and state reads)
function rest(path: string, init: RequestInit & { token?: string; key?: string } = {}): Promise<Reply> {
  const key = init.key ?? SERVICE;
  return call(`${API}${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${init.token ?? key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers ?? {}),
    },
  });
}

// a served Edge Function, as the browser calls it
function edge(name: string, body: unknown, token: string | null): Promise<Reply> {
  return call(`${API}/functions/v1/${name}`, {
    method: 'POST',
    headers: { apikey: ANON, ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// the simulator's control API ("what the customer did")
async function control(path: string, body: Json = {}): Promise<Reply> {
  const r = await call(`${SIM}${path}`, {
    method: 'POST',
    headers: { 'X-Simulator-Control-Token': CONTROL, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r;
}

// the simulator's provider API (harness-only reads and a stray order)
function provider(method: string, path: string, body?: unknown): Promise<Reply> {
  return call(`${SIM}${path}`, {
    method,
    headers: { Authorization: PROVIDER_AUTH, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function simPayment(orderId: string, outcome: 'captured' | 'authorized' | 'failed', amount?: number): Promise<string> {
  const r = await control(`/__control/orders/${orderId}/payments`, amount === undefined ? { outcome } : { outcome, amount });
  assertEquals(r.status, 200, `simulator payment ${outcome}: ${JSON.stringify(r.body)}`);
  const id = r.body.payment.id as string;
  assert(SIM_PAYMENT.test(id), 'simulator payment id shape');
  record('provider_payment_ids', id);
  return id;
}

async function webhook(eventId: string, event: string, paymentId: string, orderId: string | null, opts: { badSignature?: boolean } = {}) {
  record('provider_event_ids', eventId);
  const raw = JSON.stringify({
    entity: 'event',
    event,
    payload: { payment: { entity: { id: paymentId, order_id: orderId, amount: 1, currency: 'INR', status: 'captured' } } },
  });
  const sig = opts.badSignature ? 'f'.repeat(64) : await hmacSha256Hex(WEBHOOK_SECRET, new TextEncoder().encode(raw));
  return call(`${API}/functions/v1/payments-webhook`, {
    method: 'POST',
    headers: { 'x-razorpay-signature': sig, 'x-razorpay-event-id': eventId, 'Content-Type': 'application/json' },
    body: raw,
  });
}

// ---------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------

let userSeq = 0;
async function newUser(): Promise<{ id: string; token: string }> {
  const email = `sim-e2e-${RUN}-${++userSeq}@unisport-payments.test`;
  const password = crypto.randomUUID() + 'Aa1!';
  const created = await rest('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, password, email_confirm: true }) });
  assertEquals(created.status, 200, 'create test user');
  record('users', created.body.id);
  const signin = await call(`${API}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert(typeof signin.body.access_token === 'string', 'sign in');
  return { id: created.body.id, token: signin.body.access_token };
}

let bookingSeq = 0;
async function newBooking(user: { id: string }): Promise<string> {
  const facilityId = crypto.randomUUID();
  const slotId = crypto.randomUUID();
  const bookingId = crypto.randomUUID();
  record('facilities', facilityId);
  record('slots', slotId);
  record('bookings', bookingId);
  const n = ++bookingSeq;
  const f = await rest('/rest/v1/facilities', {
    method: 'POST',
    body: JSON.stringify({
      id: facilityId, owner_id: user.id, name: `SIM E2E ${RUN} ${n}`, sport: 'Badminton',
      address: '1 Simulator Road', city: 'Testville', status: 'active', base_price: 500,
    }),
  });
  assertEquals(f.status, 201, `facility: ${JSON.stringify(f.body)}`);
  const s = await rest('/rest/v1/facility_slots', {
    method: 'POST',
    body: JSON.stringify({ id: slotId, facility_id: facilityId, start_time: '06:00', end_time: '07:00', duration_min: 60, base_price: 500 }),
  });
  assertEquals(s.status, 201, `slot: ${JSON.stringify(s.body)}`);
  const date = new Date(Date.now() + (30 + n) * 86400_000).toISOString().slice(0, 10);
  const b = await rest('/rest/v1/bookings', {
    method: 'POST',
    body: JSON.stringify({
      id: bookingId, user_id: user.id, facility_id: facilityId, slot_id: slotId, booking_date: date,
      start_time: '06:00', end_time: '07:00', amount: 500, status: 'pending_payment',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }),
  });
  assertEquals(b.status, 201, `booking: ${JSON.stringify(b.body)}`);
  return bookingId;
}

async function createOrder(user: { token: string }, bookingId: string, session: string): Promise<Reply> {
  return await edge('payments-create-order', { booking_id: bookingId, checkout_session: session }, user.token);
}

async function orderFor(user: { token: string }, bookingId: string, session: string): Promise<{ orderId: string; attemptId: string }> {
  const r = await createOrder(user, bookingId, session);
  assertEquals(r.status, 200, `create order: ${JSON.stringify(r.body)}`);
  assert(SIM_ORDER.test(r.body.order_id), `order id issued by the simulator: ${r.body.order_id}`);
  return { orderId: r.body.order_id, attemptId: r.body.attempt_id };
}

const verify = (user: { token: string }, bookingId: string, paymentId: string) =>
  edge('payments-verify', { booking_id: bookingId, razorpay_payment_id: paymentId }, user.token);
const recover = (user: { token: string }, bookingId: string, session: string) =>
  edge('payments-verify', { booking_id: bookingId, checkout_session: session }, user.token);

// ---------------------------------------------------------------
// persisted state (service role reads)
// ---------------------------------------------------------------

async function bookingRow(id: string) {
  const r = await rest(`/rest/v1/bookings?id=eq.${id}&select=status,payment_status,fulfilled_by_payment_id,confirmed_at,expires_at`);
  assertEquals(r.body.length, 1, 'booking row');
  return r.body[0];
}
async function attemptRows(bookingId: string) {
  return (await rest(`/rest/v1/payment_attempts?booking_id=eq.${bookingId}&select=id,state,provider_order_id,closed_reason,checkout_lease_hash&order=created_at`)).body;
}
async function paymentRows(providerPaymentId: string) {
  return (await rest(`/rest/v1/payments?provider_payment_id=eq.${providerPaymentId}&select=id,booking_id,attempt_id,provider_order_id,provider_status,amount_paise,provider_amount_refunded_paise,decision_recorded_at,settlement_decision,unmatched_disposition,error_code`)).body;
}
async function paymentsForBooking(bookingId: string) {
  return (await rest(`/rest/v1/payments?booking_id=eq.${bookingId}&select=id,provider_payment_id,settlement_decision`)).body;
}
async function eventRows(providerEventId: string) {
  return (await rest(`/rest/v1/payment_events?provider_event_id=eq.${providerEventId}&select=id,processed_at,process_result,attempts,last_error,provider_payment_id`)).body;
}
async function refundsFor(paymentRowId: string) {
  return (await rest(`/rest/v1/refunds?payment_id=eq.${paymentRowId}&select=id`)).body;
}
async function simOrdersByReceipt(receipt: string) {
  const r = await provider('GET', `/v1/orders?receipt=${receipt}&count=100`);
  assertEquals(r.status, 200, 'simulator lookup');
  return r.body.items as { id: string }[];
}

const T = { ignore: !enabled, sanitizeResources: false, sanitizeOps: false };

// ---------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------

Deno.test({
  ...T,
  name: 'sim e2e 1: order creation through the simulator, re-use by the same session, refusal for another',
  async fn() {
    const user = await newUser();
    const booking = await newBooking(user);
    const session = crypto.randomUUID();
    const first = await createOrder(user, booking, session);
    assertEquals(first.status, 200, JSON.stringify(first.body));
    assertEquals(Object.keys(first.body).sort(), ['amount_paise', 'attempt_id', 'currency', 'hold_seconds_remaining', 'key_id', 'order_id']);
    assertEquals([first.body.key_id, first.body.amount_paise, first.body.currency], [SIMULATOR_KEY_ID, 50000, 'INR']);
    assert(SIM_ORDER.test(first.body.order_id), 'order issued by the simulator');
    const again = await createOrder(user, booking, session);
    assertEquals([again.status, again.body.order_id], [200, first.body.order_id], 're-used by the same session');
    const otherTab = await createOrder(user, booking, crypto.randomUUID());
    assertEquals([otherTab.status, otherTab.body.error], [409, 'checkout_in_progress']);
    // persisted: one open attempt with that order and a lease; one provider order for its receipt
    const attempts = await attemptRows(booking);
    assertEquals(attempts.length, 1);
    assertEquals([attempts[0].id, attempts[0].state, attempts[0].provider_order_id], [first.body.attempt_id, 'open', first.body.order_id]);
    assert(typeof attempts[0].checkout_lease_hash === 'string', 'lease recorded');
    assertEquals((await simOrdersByReceipt(first.body.attempt_id)).map((o) => o.id), [first.body.order_id]);
    assertEquals((await bookingRow(booking)).status, 'pending_payment');
  },
});

Deno.test({
  ...T,
  name: 'sim e2e 2: a captured payment confirms the booking; repeated verification and recovery are idempotent',
  async fn() {
    const user = await newUser();
    const booking = await newBooking(user);
    const session = crypto.randomUUID();
    const { orderId, attemptId } = await orderFor(user, booking, session);
    const pay = await simPayment(orderId, 'captured');
    const v = await verify(user, booking, pay);
    assertEquals([v.status, v.body], [200, {
      booking_id: booking, booking_status: 'confirmed', payment_status: 'captured', provider_refund: 'none', result: 'confirmed',
    }]);
    const [p] = await paymentRows(pay);
    assertEquals([p.booking_id, p.attempt_id, p.provider_order_id, p.provider_status, p.amount_paise, p.settlement_decision], [
      booking, attemptId, orderId, 'captured', 50000, 'fulfilled',
    ]);
    assert(p.decision_recorded_at !== null, 'decision recorded');
    const b = await bookingRow(booking);
    assertEquals([b.status, b.payment_status, b.fulfilled_by_payment_id], ['confirmed', 'paid', p.id]);
    assert(b.confirmed_at !== null, 'confirmed_at');
    assertEquals(await refundsFor(p.id), [], 'no refund created');

    // idempotency: the same answers, no new rows, the decision untouched
    const v2 = await verify(user, booking, pay);
    assertEquals([v2.status, v2.body], [v.status, v.body]);
    const r1 = await recover(user, booking, session);
    const r2 = await recover(user, booking, session);
    assertEquals(r1.status, 200);
    assertEquals([r1.body.result, r1.body.razorpay_payment_id, r1.body.complete, r1.body.other_payments], ['confirmed', pay, true, []]);
    assertEquals(r2.body, r1.body, 'repeated recovery answers identically');
    const [p2] = await paymentRows(pay);
    assertEquals([p2.id, p2.decision_recorded_at, p2.settlement_decision], [p.id, p.decision_recorded_at, 'fulfilled']);
    assertEquals((await paymentsForBooking(booking)).length, 1, 'exactly one payment row');
    assertEquals((await bookingRow(booking)).fulfilled_by_payment_id, p.id);
  },
});

Deno.test({
  ...T,
  name: 'sim e2e 3: a failed payment does not confirm and blocks a new Checkout session',
  async fn() {
    const user = await newUser();
    const booking = await newBooking(user);
    const session = crypto.randomUUID();
    const { orderId, attemptId } = await orderFor(user, booking, session);
    const pay = await simPayment(orderId, 'failed');
    const v = await verify(user, booking, pay);
    assertEquals([v.status, v.body.result, v.body.booking_status, v.body.payment_status], [200, 'payment_failed', 'pending_payment', 'failed']);
    const [p] = await paymentRows(pay);
    assertEquals([p.booking_id, p.attempt_id, p.provider_status, p.decision_recorded_at, p.settlement_decision, p.error_code], [
      booking, attemptId, 'failed', null, null, 'BAD_REQUEST_ERROR',
    ]);
    const b = await bookingRow(booking);
    assertEquals([b.status, b.fulfilled_by_payment_id], ['pending_payment', null]);
    // the lease holder asking again: the provider lists a (failed) payment, so no new Checkout
    const holder = await createOrder(user, booking, session);
    assertEquals([holder.status, holder.body.error], [409, 'payment_may_exist']);
    // any other session is refused while the lease lasts
    const otherTab = await createOrder(user, booking, crypto.randomUUID());
    assertEquals([otherTab.status, otherTab.body.error], [409, 'checkout_in_progress']);
    assertEquals((await attemptRows(booking)).length, 1, 'no second attempt');
  },
});

Deno.test({
  ...T,
  name: 'sim e2e 4: an authorized payment stays pending; after capture, recovery confirms it',
  async fn() {
    const user = await newUser();
    const booking = await newBooking(user);
    const session = crypto.randomUUID();
    const { orderId } = await orderFor(user, booking, session);
    const pay = await simPayment(orderId, 'authorized');
    const v = await verify(user, booking, pay);
    assertEquals([v.status, v.body.result, v.body.booking_status, v.body.payment_status], [200, 'payment_pending', 'pending_payment', 'authorized']);
    let [p] = await paymentRows(pay);
    assertEquals([p.provider_status, p.decision_recorded_at, p.settlement_decision], ['authorized', null, null]);
    const r1 = await recover(user, booking, session);
    assertEquals([r1.status, r1.body.result, r1.body.razorpay_payment_id, r1.body.complete], [200, 'payment_pending', pay, true]);
    assertEquals((await bookingRow(booking)).status, 'pending_payment');

    // the status changes at the provider between two recoveries
    assertEquals((await control(`/__control/payments/${pay}/capture`)).status, 200);
    const r2 = await recover(user, booking, session);
    assertEquals([r2.status, r2.body.result, r2.body.razorpay_payment_id, r2.body.booking_status], [200, 'confirmed', pay, 'confirmed']);
    [p] = await paymentRows(pay);
    assertEquals([p.provider_status, p.settlement_decision], ['captured', 'fulfilled']);
    const b = await bookingRow(booking);
    assertEquals([b.status, b.fulfilled_by_payment_id], ['confirmed', p.id]);
  },
});

Deno.test({
  ...T,
  name: 'sim e2e 5: an order created behind a provider timeout is adopted by receipt, never duplicated',
  async fn() {
    const user = await newUser();
    const booking = await newBooking(user);
    const session = crypto.randomUUID();
    // the provider creates the order but answers after the Edge client's 10 s timeout
    assertEquals((await control('/__control/faults', { operation: 'create_order', mode: 'delay', delay_ms: 12_000 })).status, 200);
    const first = await createOrder(user, booking, session);
    assertEquals(first.status, 503, `ambiguous outcome is retryable: ${JSON.stringify(first.body)}`);
    let attempts = await attemptRows(booking);
    assertEquals(attempts.length, 1);
    assertEquals([attempts[0].state, attempts[0].provider_order_id], ['creating', null], 'recoverable, no order recorded');
    const atProvider = await simOrdersByReceipt(attempts[0].id);
    assertEquals(atProvider.length, 1, 'the provider did create it');

    // retry (honouring Retry-After while the creating lease lasts) adopts it
    let retried: Reply | null = null;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      retried = await createOrder(user, booking, session);
      if (retried.status !== 409 && retried.status !== 503) break;
      const after = Number(retried.headers.get('retry-after') ?? '5');
      await new Promise((r) => setTimeout(r, Math.min(Math.max(after, 1), 15) * 1000));
    }
    assert(retried !== null);
    assertEquals(retried.status, 200, `adopted: ${JSON.stringify(retried.body)}`);
    assertEquals(retried.body.order_id, atProvider[0].id, 'the existing provider order is adopted');
    attempts = await attemptRows(booking);
    assertEquals(attempts.map((a: Json) => [a.state, a.provider_order_id]), [['open', atProvider[0].id]]);
    assertEquals((await simOrdersByReceipt(attempts[0].id)).length, 1, 'still exactly one provider order');
  },
});

Deno.test({
  ...T,
  name: 'sim e2e 6: identity mismatches are rejected and nothing is applied',
  async fn() {
    const user = await newUser();
    const other = await newUser();
    const bookingA = await newBooking(user);
    const bookingB = await newBooking(user);
    const a = await orderFor(user, bookingA, crypto.randomUUID());
    const b = await orderFor(user, bookingB, crypto.randomUUID());
    // a payment of booking B's order, presented for booking A
    const payB = await simPayment(b.orderId, 'captured');
    const wrongBooking = await verify(user, bookingA, payB);
    assertEquals([wrongBooking.status, wrongBooking.body.error], [409, 'payment_not_for_booking']);
    // a payment on A's order with the wrong amount
    const short = await simPayment(a.orderId, 'captured', 49_999);
    const mismatch = await verify(user, bookingA, short);
    assertEquals([mismatch.status, mismatch.body.error], [409, 'payment_mismatch']);
    // another user cannot verify this booking at all
    const foreign = await verify(other, bookingA, short);
    assertEquals([foreign.status, foreign.body.error], [404, 'booking_not_found']);
    // persisted: nothing applied anywhere
    assertEquals(await paymentRows(payB), [], 'the cross-booking payment was not stored by verification');
    assertEquals(await paymentRows(short), [], 'the mismatched payment was not stored');
    for (const id of [bookingA, bookingB]) {
      const row = await bookingRow(id);
      assertEquals([row.status, row.fulfilled_by_payment_id], ['pending_payment', null]);
    }
    assertEquals(await paymentsForBooking(bookingA), []);
  },
});

Deno.test({
  ...T,
  name: 'sim e2e 7: an unmatched payment (unknown order) is stored unattached and never refunded automatically',
  async fn() {
    // an order the provider has but our database never recorded
    const stray = await provider('POST', '/v1/orders', { amount: 77_700, currency: 'INR', receipt: `stray-${RUN}`, notes: {} });
    assertEquals(stray.status, 200);
    const pay = await simPayment(stray.body.id, 'captured');
    const eventId = `evt_SIME2E${RUN}stray`;
    const hook = await webhook(eventId, 'payment.captured', pay, stray.body.id);
    assertEquals([hook.status, hook.body], [200, { status: 'processed' }]);
    const [p] = await paymentRows(pay);
    assertEquals([p.booking_id, p.attempt_id, p.decision_recorded_at, p.settlement_decision, p.provider_status, p.amount_paise], [
      null, null, null, null, 'captured', 77_700,
    ]);
    assertEquals(await refundsFor(p.id), [], 'no automatic refund');
    const [e] = await eventRows(eventId);
    assert(e.processed_at !== null, 'event processed');
    assertEquals(e.provider_payment_id, pay);
  },
});

Deno.test({
  ...T,
  name: 'sim e2e 8: webhook signature is enforced and duplicate deliveries do nothing',
  async fn() {
    const user = await newUser();
    const booking = await newBooking(user);
    const { orderId } = await orderFor(user, booking, crypto.randomUUID());
    const pay = await simPayment(orderId, 'captured');
    const forged = `evt_SIME2E${RUN}forged`;
    const bad = await webhook(forged, 'payment.captured', pay, orderId, { badSignature: true });
    assertEquals([bad.status, bad.body.error], [401, 'invalid_signature']);
    assertEquals(await eventRows(forged), [], 'a forged event is never stored');
    assertEquals(await paymentRows(pay), [], 'nor applied');

    const eventId = `evt_SIME2E${RUN}hook`;
    const ok = await webhook(eventId, 'payment.captured', pay, orderId);
    assertEquals([ok.status, ok.body], [200, { status: 'processed' }]);
    const [e1] = await eventRows(eventId);
    assert(e1.processed_at !== null, 'processed');
    const [p] = await paymentRows(pay);
    assertEquals([p.booking_id, p.settlement_decision], [booking, 'fulfilled']);
    const b = await bookingRow(booking);
    assertEquals([b.status, b.fulfilled_by_payment_id], ['confirmed', p.id]);

    const dup = await webhook(eventId, 'payment.captured', pay, orderId);
    assertEquals([dup.status, dup.body], [200, { status: 'duplicate' }]);
    const events = await eventRows(eventId);
    assertEquals(events.length, 1, 'one inbox row per provider event id');
    assertEquals(events[0].processed_at, e1.processed_at, 'not processed again');
    // a different event for the same payment (order.paid) changes nothing
    const paid = await webhook(`evt_SIME2E${RUN}paid`, 'order.paid', pay, orderId);
    assertEquals(paid.status, 200);
    const [p2] = await paymentRows(pay);
    assertEquals([p2.id, p2.decision_recorded_at, p2.settlement_decision], [p.id, p.decision_recorded_at, 'fulfilled']);
    assertEquals((await bookingRow(booking)).fulfilled_by_payment_id, p.id);
  },
});

Deno.test({
  ...T,
  name: 'sim e2e 9: a transient provider failure leaves the webhook event retryable, and redelivery settles it',
  async fn() {
    const user = await newUser();
    const booking = await newBooking(user);
    const { orderId } = await orderFor(user, booking, crypto.randomUUID());
    const pay = await simPayment(orderId, 'captured');
    assertEquals((await control('/__control/faults', { operation: 'fetch_payment', mode: 'server_error' })).status, 200);
    const eventId = `evt_SIME2E${RUN}transient`;
    const first = await webhook(eventId, 'payment.captured', pay, orderId);
    assertEquals([first.status, first.body.error], [503, 'temporarily_unavailable']);
    const [e1] = await eventRows(eventId);
    assertEquals([e1.processed_at, e1.process_result], [null, 'fetch_failed'], 'stored, not processed');
    assert(typeof e1.last_error === 'string' && e1.last_error.includes('500'), 'the transient error is recorded');
    assertEquals(await paymentRows(pay), [], 'nothing applied yet');
    assertEquals((await bookingRow(booking)).status, 'pending_payment');

    const again = await webhook(eventId, 'payment.captured', pay, orderId);
    assertEquals([again.status, again.body], [200, { status: 'processed' }]);
    const [e2] = await eventRows(eventId);
    assert(e2.processed_at !== null, 'processed on redelivery');
    const [p] = await paymentRows(pay);
    assertEquals(p.settlement_decision, 'fulfilled');
    assertEquals((await bookingRow(booking)).fulfilled_by_payment_id, p.id);
  },
});

Deno.test({
  ...T,
  name: 'sim e2e 10: two captured payments never confirm a booking twice',
  async fn() {
    const user = await newUser();
    const booking = await newBooking(user);
    const session = crypto.randomUUID();
    const { orderId } = await orderFor(user, booking, session);
    const p1 = await simPayment(orderId, 'captured');
    const p2 = await simPayment(orderId, 'captured');
    assertEquals((await verify(user, booking, p1)).body.result, 'confirmed');
    const second = await verify(user, booking, p2);
    assertEquals([second.status, second.body.result, second.body.booking_status], [200, 'not_fulfilled', 'confirmed']);
    const [row1] = await paymentRows(p1);
    const [row2] = await paymentRows(p2);
    assertEquals([row1.settlement_decision, row2.settlement_decision], ['fulfilled', 'duplicate_capture']);
    assertEquals([row2.booking_id, row2.provider_status], [booking, 'captured']);
    assertEquals((await bookingRow(booking)).fulfilled_by_payment_id, row1.id, 'fulfilled once, by the first');
    const r = await recover(user, booking, session);
    assertEquals([r.body.result, r.body.razorpay_payment_id], ['confirmed', p1]);
    assertEquals(r.body.other_payments.map((o: Json) => [o.razorpay_payment_id, o.result, o.decision]), [[p2, 'not_fulfilled', 'duplicate_capture']]);
    assertEquals(await refundsFor(row2.id), [], 'no automatic refund of the duplicate');
  },
});

Deno.test({
  ...T,
  name: 'sim e2e 11 (harness): a capture observed after the hold ended is a late capture',
  async fn() {
    const user = await newUser();
    const booking = await newBooking(user);
    const { orderId } = await orderFor(user, booking, crypto.randomUUID());
    const pay = await simPayment(orderId, 'authorized');
    assertEquals((await verify(user, booking, pay)).body.result, 'payment_pending');
    // end the hold of THIS fixture booking only
    const ended = await rest(`/rest/v1/bookings?id=eq.${booking}`, {
      method: 'PATCH', body: JSON.stringify({ expires_at: new Date(Date.now() - 1000).toISOString() }),
    });
    assertEquals([ended.status, ended.body.length], [200, 1], 'exactly one fixture row updated');
    assertEquals((await control(`/__control/payments/${pay}/capture`)).status, 200);
    const v = await verify(user, booking, pay);
    assertEquals([v.status, v.body.result, v.body.payment_status], [200, 'not_fulfilled', 'captured']);
    const [p] = await paymentRows(pay);
    assertEquals([p.provider_status, p.settlement_decision], ['captured', 'late_capture']);
    assert(p.decision_recorded_at !== null, 'decided');
    assertEquals((await bookingRow(booking)).fulfilled_by_payment_id, null);
    assertEquals(await refundsFor(p.id), []);
  },
});

Deno.test({
  ...T,
  name: 'sim e2e 12 (harness): a full or partial provider refund before settlement never confirms',
  async fn() {
    for (const [label, refund, status, refunded] of [
      ['full', undefined, 'refunded', 50_000],
      ['partial', 20_000, 'captured', 20_000],
    ] as const) {
      const user = await newUser();
      const booking = await newBooking(user);
      const { orderId } = await orderFor(user, booking, crypto.randomUUID());
      const pay = await simPayment(orderId, 'captured');
      // refunded at the provider before our first observation
      const r = await control(`/__control/payments/${pay}/refund`, refund === undefined ? {} : { amount: refund });
      assertEquals(r.status, 200, label);
      const v = await verify(user, booking, pay);
      assertEquals([v.status, v.body.result, v.body.provider_refund], [200, 'not_fulfilled', label], label);
      const [p] = await paymentRows(pay);
      assertEquals([p.provider_status, p.provider_amount_refunded_paise, p.settlement_decision], [status, refunded, 'refunded_before_settlement'], label);
      const b = await bookingRow(booking);
      assertEquals([b.status, b.fulfilled_by_payment_id], ['pending_payment', null], label);
      assertEquals(await refundsFor(p.id), [], `${label}: no refund row invented`);
    }
  },
});
