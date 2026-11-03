// End-to-end tests against a LOCAL Supabase stack (real GoTrue,
// PostgREST and Postgres with the slice 1a/1b migrations), with the
// Razorpay API MOCKED. Skipped unless E2E_SUPABASE_URL points at a
// local address; refuses anything else.
//
//   E2E_SUPABASE_URL=http://127.0.0.1:<api port>
//   E2E_ANON_KEY=<local anon key>   E2E_SERVICE_KEY=<local service key>
//   deno test --allow-net=127.0.0.1 --allow-env tests/local_stack_e2e_test.ts
//
// It creates two throw-away users and fixture rows whose ids/emails are
// prefixed e2e; the caller removes them afterwards (service_role has no
// DELETE on payment tables, by design). No real provider call is made.

import type { PaymentConfig } from '../_shared/config.ts';
import { handleCreateOrder } from '../_shared/create_order.ts';
import { createRazorpayClient } from '../_shared/razorpay.ts';
import { hmacSha256Hex } from '../_shared/signature.ts';
import { createAuth, createDatabase } from '../_shared/supabase.ts';
import { handleVerify } from '../_shared/verify.ts';
import { handleWebhook } from '../_shared/webhook.ts';
import { assert, assertEquals, LogSink, secretsAbsent } from './helpers.ts';

// Without --allow-env the variables are simply absent and the test is
// skipped (a plain `deno test tests/` runs only the mocked suites).
function env(name: string): string {
  if (Deno.permissions.querySync({ name: 'env', variable: name }).state !== 'granted') return '';
  return Deno.env.get(name) ?? '';
}

const URL_ = env('E2E_SUPABASE_URL');
const ANON = env('E2E_ANON_KEY');
const SERVICE = env('E2E_SERVICE_KEY');
const local = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(URL_);
const enabled = local && ANON !== '' && SERVICE !== '';

const RZP = 'https://api.razorpay.e2e';
const KEY_ID = 'rzp_test_E2EPUBLIC';
const KEY_SECRET = 'e2e-key-secret';
const WEBHOOK_SECRET = 'e2e-webhook-secret';
const RUN = crypto.randomUUID().slice(0, 8);

const config: PaymentConfig = {
  supabaseUrl: URL_,
  serviceRoleKey: SERVICE,
  anonKey: ANON,
  razorpay: { keyId: KEY_ID, keySecret: KEY_SECRET },
  webhookSecrets: [WEBHOOK_SECRET],
  razorpayApiBase: RZP,
};

// Razorpay mock behind the real network fetch.
const orders = new Map<string, Record<string, unknown>>();
const payments = new Map<string, Record<string, unknown>>();
let providerCalls = 0;

const fetchWithMock = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(RZP)) return fetch(input, init);
  providerCalls++;
  const u = new URL(url);
  const method = init?.method ?? 'GET';
  const reply = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  if (method === 'POST' && u.pathname === '/v1/orders') {
    const body = JSON.parse(String(init?.body));
    const id = `order_E2E${RUN}${orders.size}`;
    const order = { id, entity: 'order', amount: body.amount, currency: body.currency, receipt: body.receipt, status: 'created' };
    orders.set(id, order);
    return reply(200, order);
  }
  if (method === 'GET' && u.pathname === '/v1/orders') {
    const r = u.searchParams.get('receipt');
    return reply(200, { entity: 'collection', items: [...orders.values()].filter((o) => o.receipt === r) });
  }
  const op = /^\/v1\/orders\/(order_[A-Za-z0-9]+)\/payments$/.exec(u.pathname);
  if (method === 'GET' && op) {
    const items = [...payments.values()].filter((p) => p.order_id === op[1]);
    return reply(200, { entity: 'collection', count: items.length, items });
  }
  const m = /^\/v1\/payments\/(pay_[A-Za-z0-9]+)$/.exec(u.pathname);
  if (method === 'GET' && m) {
    const p = payments.get(m[1]);
    return p ? reply(200, p) : reply(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' } });
  }
  return reply(404, {});
};

const log = new LogSink();
const deps = () => ({
  config,
  db: createDatabase(config, fetchWithMock),
  auth: createAuth(config, fetchWithMock),
  razorpay: createRazorpayClient({ credentials: config.razorpay!, apiBase: RZP, fetch: fetchWithMock }),
  log: log.log,
});

async function rest(path: string, init: RequestInit & { token?: string; key?: string } = {}) {
  const key = init.key ?? SERVICE;
  const res = await fetch(`${URL_}${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${init.token ?? key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function must(res: Promise<{ status: number; body: unknown }>, status: number, label: string) {
  const r = await res;
  assertEquals(r.status, status, `${label}: ${JSON.stringify(r.body)}`);
  return r;
}

async function newUser(n: number): Promise<{ id: string; token: string }> {
  const email = `e2e-${RUN}-${n}@unisport-payments.test`;
  const password = crypto.randomUUID() + 'Aa1!';
  const created = await rest('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  assertEquals(created.status, 200, 'create test user');
  const signin = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const s = await signin.json();
  assert(typeof s.access_token === 'string', 'sign in');
  return { id: created.body.id, token: s.access_token };
}

// One checkout session per test flow (as one browser page would use).
const SESSION = crypto.randomUUID();

function createOrderRequest(token: string | null, bookingId: string, session: string = SESSION) {
  return new Request('http://edge.test/payments-create-order', {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify({ booking_id: bookingId, checkout_session: session, amount: 1 }),
  });
}

async function webhook(eventId: string, paymentId: string, orderId: string | null) {
  const raw = JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id: paymentId, order_id: orderId, amount: 1, currency: 'INR', status: 'captured' } } },
  });
  const sig = await hmacSha256Hex(WEBHOOK_SECRET, new TextEncoder().encode(raw));
  return handleWebhook(
    new Request('http://edge.test/payments-webhook', {
      method: 'POST',
      headers: { 'x-razorpay-signature': sig, 'x-razorpay-event-id': eventId },
      body: raw,
    }),
    deps(),
  );
}

Deno.test({
  name: 'local stack: order creation, webhook settlement and client restrictions end to end',
  ignore: !enabled,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const owner = await newUser(1);
    const other = await newUser(2);

    // fixture: facility, slot, pending booking (service role; the
    // booking RPCs are covered by their own suites)
    const facilityId = crypto.randomUUID();
    const slotId = crypto.randomUUID();
    const bookingId = crypto.randomUUID();
    await must(rest('/rest/v1/facilities', {
      method: 'POST',
      body: JSON.stringify({
        id: facilityId, owner_id: owner.id, name: `E2E ${RUN}`, sport: 'Badminton',
        address: '1 End To End Road', city: 'Testville', status: 'active', base_price: 500,
      }),
    }), 201, 'facility');
    await must(rest('/rest/v1/facility_slots', {
      method: 'POST',
      body: JSON.stringify({ id: slotId, facility_id: facilityId, start_time: '06:00', end_time: '07:00', duration_min: 60, base_price: 500 }),
    }), 201, 'slot');
    const date = new Date(Date.now() + 40 * 86400_000).toISOString().slice(0, 10);
    await must(rest('/rest/v1/bookings', {
      method: 'POST',
      body: JSON.stringify({
        id: bookingId, user_id: owner.id, facility_id: facilityId, slot_id: slotId, booking_date: date,
        start_time: '06:00', end_time: '07:00', amount: 500, status: 'pending_payment',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    }), 201, 'booking');

    // unauthenticated, anon key, another user's booking
    assertEquals((await handleCreateOrder(createOrderRequest(null, bookingId), deps())).status, 401);
    assertEquals((await handleCreateOrder(createOrderRequest(ANON, bookingId), deps())).status, 401);
    assertEquals((await handleCreateOrder(createOrderRequest(other.token, bookingId), deps())).status, 404);
    assertEquals(providerCalls, 0, 'no provider call before authorisation');

    // create, then re-use
    const first = await handleCreateOrder(createOrderRequest(owner.token, bookingId), deps());
    assertEquals(first.status, 200, 'create order');
    const checkout = await first.json();
    assertEquals(Object.keys(checkout).sort(), ['amount_paise', 'attempt_id', 'currency', 'hold_seconds_remaining', 'key_id', 'order_id']);
    assert(checkout.hold_seconds_remaining >= 180 && checkout.hold_seconds_remaining <= 3600, 'the database reports the remaining hold');
    assertEquals([checkout.amount_paise, checkout.currency, checkout.key_id], [50000, 'INR', KEY_ID]);
    const second = await handleCreateOrder(createOrderRequest(owner.token, bookingId), deps());
    assertEquals((await second.json()).order_id, checkout.order_id, 'a retry by the same session re-uses the order');
    assertEquals(orders.size, 1, 'exactly one provider order');
    assertEquals(providerCalls, 2, 'one order creation, then one check that no payment exists on it');

    // another session (tab / device) never gets the order while the lease lasts
    const otherTab = await handleCreateOrder(createOrderRequest(owner.token, bookingId, crypto.randomUUID()), deps());
    const otherBody = await otherTab.json();
    assertEquals([otherTab.status, otherBody.error], [409, 'checkout_in_progress']);
    assert(!JSON.stringify(otherBody).includes(checkout.order_id), 'the order is not handed to a second session');
    assertEquals(providerCalls, 2, 'and no provider call for it');

    const attempt = await rest(`/rest/v1/payment_attempts?id=eq.${checkout.attempt_id}&select=state,provider_order_id`);
    assertEquals(attempt.body, [{ state: 'open', provider_order_id: checkout.order_id }]);

    // the client cannot write payment state or call the settlement functions
    const patch = await rest(`/rest/v1/bookings?id=eq.${bookingId}`, {
      method: 'PATCH', token: owner.token, key: ANON, body: JSON.stringify({ status: 'confirmed' }),
    });
    assert(patch.status === 401 || patch.status === 403, `client PATCH bookings -> ${patch.status}`);
    const insertPay = await rest('/rest/v1/payments', {
      method: 'POST', token: owner.token, key: ANON,
      body: JSON.stringify({ provider_payment_id: 'pay_FORGED', provider_status: 'captured', amount_paise: 50000 }),
    });
    assert(insertPay.status === 401 || insertPay.status === 403, `client INSERT payments -> ${insertPay.status}`);
    for (const fn of ['payment_apply_observation', 'payment_prepare_attempt', 'payment_record_order']) {
      const r = await rest(`/rest/v1/rpc/${fn}`, { method: 'POST', token: owner.token, key: ANON, body: '{}' });
      assert(r.status === 401 || r.status === 403 || r.status === 404, `client RPC ${fn} -> ${r.status}`);
    }

    // the provider reports the payment captured; the webhook settles it
    const payId = `pay_E2E${RUN}A`;
    payments.set(payId, {
      id: payId, entity: 'payment', amount: 50000, currency: 'INR', status: 'captured', captured: true,
      order_id: checkout.order_id, amount_refunded: 0, created_at: Math.floor(Date.now() / 1000),
    });
    const hook = await webhook(`evt_E2E${RUN}1`, payId, checkout.order_id);
    assertEquals(hook.status, 200, 'webhook processed');
    const booking = await rest(`/rest/v1/bookings?id=eq.${bookingId}&select=status,payment_status,fulfilled_by_payment_id`);
    assertEquals(booking.body[0].status, 'confirmed');
    assertEquals(booking.body[0].payment_status, 'paid');
    assert(booking.body[0].fulfilled_by_payment_id !== null);
    const dup = await webhook(`evt_E2E${RUN}1`, payId, checkout.order_id);
    assertEquals((await dup.json()).status, 'duplicate');

    // an unknown payment is stored unmatched and invisible to clients
    const strayId = `pay_E2E${RUN}B`;
    payments.set(strayId, {
      id: strayId, entity: 'payment', amount: 777, currency: 'INR', status: 'captured', captured: true,
      order_id: `order_E2E${RUN}UNKNOWN`, amount_refunded: 0, created_at: Math.floor(Date.now() / 1000),
    });
    assertEquals((await webhook(`evt_E2E${RUN}2`, strayId, `order_E2E${RUN}UNKNOWN`)).status, 200);
    const stray = await rest(`/rest/v1/payments?provider_payment_id=eq.${strayId}&select=booking_id,attempt_id,decision_recorded_at`);
    assertEquals(stray.body, [{ booking_id: null, attempt_id: null, decision_recorded_at: null }]);
    for (const u of [owner, other]) {
      const seen = await rest(`/rest/v1/payments?provider_payment_id=eq.${strayId}&select=id`, { token: u.token, key: ANON });
      assertEquals(seen.body, [], 'unmatched payment invisible to a client');
    }
    const refunds = await rest(`/rest/v1/refunds?select=id&payment_id=in.(${
      (await rest(`/rest/v1/payments?provider_payment_id=eq.${strayId}&select=id`)).body[0].id})`);
    assertEquals(refunds.body, [], 'no automatic refund for an unmatched payment');

    // the owner sees their own payment; the other user sees nothing
    const mine = await rest(`/rest/v1/payments?provider_payment_id=eq.${payId}&select=id`, { token: owner.token, key: ANON });
    assertEquals(mine.body.length, 1);
    const theirs = await rest(`/rest/v1/payments?provider_payment_id=eq.${payId}&select=id`, { token: other.token, key: ANON });
    assertEquals(theirs.body, []);

    secretsAbsent(log.text());
    assert(!log.text().includes(KEY_SECRET) && !log.text().includes(WEBHOOK_SECRET));
    console.log(`e2e run ${RUN}: facility ${facilityId}`);
  },
});

function verifyRequest(token: string | null, bookingId: string, paymentId: string) {
  return new Request('http://edge.test/payments-verify', {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    // browser claims that must be ignored
    body: JSON.stringify({ booking_id: bookingId, razorpay_payment_id: paymentId, status: 'captured', razorpay_signature: 'f'.repeat(64) }),
  });
}

Deno.test({
  name: 'local stack: authenticated verification end to end',
  ignore: !enabled,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const owner = await newUser(3);
    const other = await newUser(4);
    const facilityId = crypto.randomUUID();
    const slotId = crypto.randomUUID();
    const bookingId = crypto.randomUUID();
    await must(rest('/rest/v1/facilities', {
      method: 'POST',
      body: JSON.stringify({
        id: facilityId, owner_id: owner.id, name: `E2E ${RUN} verify`, sport: 'Badminton',
        address: '1 End To End Road', city: 'Testville', status: 'active', base_price: 500,
      }),
    }), 201, 'facility');
    await must(rest('/rest/v1/facility_slots', {
      method: 'POST',
      body: JSON.stringify({ id: slotId, facility_id: facilityId, start_time: '06:00', end_time: '07:00', duration_min: 60, base_price: 500 }),
    }), 201, 'slot');
    const date = new Date(Date.now() + 41 * 86400_000).toISOString().slice(0, 10);
    await must(rest('/rest/v1/bookings', {
      method: 'POST',
      body: JSON.stringify({
        id: bookingId, user_id: owner.id, facility_id: facilityId, slot_id: slotId, booking_date: date,
        start_time: '06:00', end_time: '07:00', amount: 500, status: 'pending_payment',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    }), 201, 'booking');

    const created = await handleCreateOrder(createOrderRequest(owner.token, bookingId), deps());
    assertEquals(created.status, 200);
    const { order_id: orderId } = await created.json();

    const payId = `pay_E2E${RUN}V`;
    // unauthenticated / other user / unknown payment
    assertEquals((await handleVerify(verifyRequest(null, bookingId, payId), deps())).status, 401);
    assertEquals((await handleVerify(verifyRequest(other.token, bookingId, payId), deps())).status, 404);
    const unknown = await handleVerify(verifyRequest(owner.token, bookingId, payId), deps());
    assertEquals([unknown.status, (await unknown.json()).error], [409, 'payment_not_for_booking'], 'unknown to the provider');

    // authorized only: not confirmed
    payments.set(payId, {
      id: payId, entity: 'payment', amount: 50000, currency: 'INR', status: 'authorized', captured: false,
      order_id: orderId, amount_refunded: 0, created_at: Math.floor(Date.now() / 1000),
    });
    const pending = await (await handleVerify(verifyRequest(owner.token, bookingId, payId), deps())).json();
    assertEquals([pending.result, pending.booking_status], ['payment_pending', 'pending_payment']);

    // captured: confirmed, and idempotent
    payments.set(payId, { ...payments.get(payId)!, status: 'captured', captured: true });
    const confirmed = await (await handleVerify(verifyRequest(owner.token, bookingId, payId), deps())).json();
    assertEquals(confirmed, {
      booking_id: bookingId, booking_status: 'confirmed', payment_status: 'captured', provider_refund: 'none', result: 'confirmed',
    });
    const again = await (await handleVerify(verifyRequest(owner.token, bookingId, payId), deps())).json();
    assertEquals(again, confirmed);
    const db = await rest(`/rest/v1/bookings?id=eq.${bookingId}&select=status,payment_status`);
    assertEquals(db.body, [{ status: 'confirmed', payment_status: 'paid' }]);

    // a captured payment of an unknown order is not attached or stored by verification
    const foreign = `pay_E2E${RUN}F`;
    payments.set(foreign, {
      id: foreign, entity: 'payment', amount: 50000, currency: 'INR', status: 'captured', captured: true,
      order_id: `order_E2E${RUN}FOREIGN`, amount_refunded: 0, created_at: Math.floor(Date.now() / 1000),
    });
    const f = await handleVerify(verifyRequest(owner.token, bookingId, foreign), deps());
    assertEquals([f.status, (await f.json()).error], [409, 'payment_not_for_booking']);
    assertEquals((await rest(`/rest/v1/payments?provider_payment_id=eq.${foreign}&select=id`)).body, []);

    secretsAbsent(log.text());
  },
});

// Fixture: a pending booking with an open order, for one user.
async function bookingWithOrder(user: { id: string; token: string }, label: string, dayOffset: number) {
  const facilityId = crypto.randomUUID();
  const slotId = crypto.randomUUID();
  const bookingId = crypto.randomUUID();
  await must(rest('/rest/v1/facilities', {
    method: 'POST',
    body: JSON.stringify({
      id: facilityId, owner_id: user.id, name: `E2E ${RUN} ${label}`, sport: 'Badminton',
      address: '1 End To End Road', city: 'Testville', status: 'active', base_price: 500,
    }),
  }), 201, 'facility');
  await must(rest('/rest/v1/facility_slots', {
    method: 'POST',
    body: JSON.stringify({ id: slotId, facility_id: facilityId, start_time: '06:00', end_time: '07:00', duration_min: 60, base_price: 500 }),
  }), 201, 'slot');
  const date = new Date(Date.now() + dayOffset * 86400_000).toISOString().slice(0, 10);
  await must(rest('/rest/v1/bookings', {
    method: 'POST',
    body: JSON.stringify({
      id: bookingId, user_id: user.id, facility_id: facilityId, slot_id: slotId, booking_date: date,
      start_time: '06:00', end_time: '07:00', amount: 500, status: 'pending_payment',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }),
  }), 201, 'booking');
  const created = await handleCreateOrder(createOrderRequest(user.token, bookingId), deps());
  assertEquals(created.status, 200, `create order (${label})`);
  const { order_id: orderId } = await created.json();
  return { bookingId, orderId };
}

function capturedPayment(id: string, orderId: string, over: Record<string, unknown> = {}) {
  payments.set(id, {
    id, entity: 'payment', amount: 50000, currency: 'INR', status: 'captured', captured: true,
    order_id: orderId, amount_refunded: 0, created_at: Math.floor(Date.now() / 1000), ...over,
  });
}

Deno.test({
  name: 'local stack: verification of a late capture, a duplicate capture and a refund after fulfilment',
  ignore: !enabled,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const user = await newUser(5);

    // ---- expired hold: the order was handed out, then the hold ended ----
    const late = await bookingWithOrder(user, 'late', 42);
    await must(rest(`/rest/v1/bookings?id=eq.${late.bookingId}`, {
      method: 'PATCH',
      body: JSON.stringify({ expires_at: new Date(Date.now() - 1000).toISOString() }),
    }), 200, 'expire the hold by the clock');
    const latePay = `pay_E2E${RUN}L`;
    capturedPayment(latePay, late.orderId);
    const lateRes = await (await handleVerify(verifyRequest(user.token, late.bookingId, latePay), deps())).json();
    assertEquals(lateRes, {
      booking_id: late.bookingId, booking_status: 'pending_payment', payment_status: 'captured',
      provider_refund: 'none', result: 'not_fulfilled',
    }, 'a capture after the hold ended is not a confirmation, and its money is unresolved');
    const lateDb = await rest(`/rest/v1/payments?provider_payment_id=eq.${latePay}&select=attempt_id,decision_recorded_at`);
    assert(lateDb.body[0].attempt_id !== null && lateDb.body[0].decision_recorded_at !== null, 'matched and decided (late capture)');
    const lateBooking = await rest(`/rest/v1/bookings?id=eq.${late.bookingId}&select=fulfilled_by_payment_id`);
    assertEquals(lateBooking.body, [{ fulfilled_by_payment_id: null }]);

    // ---- status expired (as the sweep does) ----
    const swept = await bookingWithOrder(user, 'swept', 43);
    await must(rest(`/rest/v1/bookings?id=eq.${swept.bookingId}`, {
      method: 'PATCH', body: JSON.stringify({ status: 'expired' }),
    }), 200, 'expire the booking by status');
    const sweptPay = `pay_E2E${RUN}S`;
    capturedPayment(sweptPay, swept.orderId);
    const sweptRes = await (await handleVerify(verifyRequest(user.token, swept.bookingId, sweptPay), deps())).json();
    assertEquals([sweptRes.result, sweptRes.booking_status], ['not_fulfilled', 'expired']);

    // ---- duplicate capture: a second payment on an already paid order ----
    const dup = await bookingWithOrder(user, 'dup', 44);
    const firstPay = `pay_E2E${RUN}D1`;
    capturedPayment(firstPay, dup.orderId);
    const first = await (await handleVerify(verifyRequest(user.token, dup.bookingId, firstPay), deps())).json();
    assertEquals(first.result, 'confirmed');
    const secondPay = `pay_E2E${RUN}D2`;
    capturedPayment(secondPay, dup.orderId);
    const second = await (await handleVerify(verifyRequest(user.token, dup.bookingId, secondPay), deps())).json();
    assertEquals(second, {
      booking_id: dup.bookingId, booking_status: 'confirmed', payment_status: 'captured',
      provider_refund: 'none', result: 'not_fulfilled',
    }, 'booking_status confirmed but THIS payment did not confirm it');
    const dupBooking = await rest(`/rest/v1/bookings?id=eq.${dup.bookingId}&select=fulfilled_by_payment_id`);
    const firstRow = await rest(`/rest/v1/payments?provider_payment_id=eq.${firstPay}&select=id`);
    assertEquals(dupBooking.body[0].fulfilled_by_payment_id, firstRow.body[0].id, 'the pointer stays on the first payment');

    // ---- the fulfilling payment is refunded afterwards ----
    capturedPayment(firstPay, dup.orderId, { status: 'refunded', amount_refunded: 50000 });
    const refunded = await (await handleVerify(verifyRequest(user.token, dup.bookingId, firstPay), deps())).json();
    assertEquals([refunded.result, refunded.payment_status, refunded.provider_refund], ['confirmed', 'refunded', 'full'],
      'confirmed (the booking stays fulfilled) but the provider reports the payment refunded');

    // ---- every decision was labelled durably, on the explicit verification path (no webhook event) ----
    const labels = await rest(
      `/rest/v1/payments?provider_payment_id=in.(${latePay},${sweptPay},${firstPay},${secondPay})&select=provider_payment_id,settlement_decision,decision_recorded_at`);
    const byId = Object.fromEntries(labels.body.map((r: Record<string, string>) => [r.provider_payment_id, r]));
    assertEquals(
      [byId[latePay].settlement_decision, byId[sweptPay].settlement_decision, byId[firstPay].settlement_decision, byId[secondPay].settlement_decision],
      ['late_capture', 'late_capture', 'fulfilled', 'duplicate_capture'],
      'late, swept, fulfilling and duplicate payments each carry their decision',
    );
    assert(Object.values(byId).every((r) => (r as Record<string, string | null>).decision_recorded_at !== null));
    // the later refund observation of the fulfilling payment did not relabel it
    assertEquals(byId[firstPay].settlement_decision, 'fulfilled');
    // and observing the duplicate again (now with a refund) does not reclassify it
    capturedPayment(secondPay, dup.orderId, { status: 'refunded', amount_refunded: 50000 });
    await (await handleVerify(verifyRequest(user.token, dup.bookingId, secondPay), deps())).json();
    const again = await rest(`/rest/v1/payments?provider_payment_id=eq.${secondPay}&select=settlement_decision,provider_status`);
    assertEquals(again.body, [{ settlement_decision: 'duplicate_capture', provider_status: 'refunded' }],
      'a refund fact is merged; the decision is not recomputed');

    secretsAbsent(log.text());
  },
});

function recoveryRequest(token: string | null, bookingId: string, session?: string) {
  return new Request('http://edge.test/payments-verify', {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify(session ? { booking_id: bookingId, checkout_session: session } : { booking_id: bookingId }),
  });
}

Deno.test({
  name: 'local stack: booking-based recovery without a payment id',
  ignore: !enabled,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const owner = await newUser(6);
    const other = await newUser(7);
    const b = await bookingWithOrder(owner, 'recovery', 45);

    // ownership first: another user, and no one, learn nothing and cause no provider call
    const before = providerCalls;
    assertEquals((await handleVerify(recoveryRequest(null, b.bookingId), deps())).status, 401);
    const foreign = await handleVerify(recoveryRequest(other.token, b.bookingId), deps());
    assertEquals([foreign.status, (await foreign.json()).error], [404, 'booking_not_found']);
    assertEquals(providerCalls, before, 'no provider call for a booking the caller does not own');

    // nothing paid yet: a complete inspection that found nothing
    const none = await handleVerify(recoveryRequest(owner.token, b.bookingId), deps());
    assertEquals(none.status, 200);
    assertEquals(await none.json(), {
      booking_id: b.bookingId, booking_status: 'pending_payment', mode: 'recovery', complete: true,
      result: 'no_payment_found', razorpay_payment_id: null, payment_status: null, provider_refund: null,
      other_payments: [],
      // the order was handed out under SESSION; this request sent no session id
      checkout_lease: 'other',
    });
    const own = await (await handleVerify(recoveryRequest(owner.token, b.bookingId, SESSION), deps())).json();
    assertEquals([own.result, own.checkout_lease], ['no_payment_found', 'yours'], 'the session that holds the lease is recognised');

    // authorized only: pending, nothing confirmed
    const payId = `pay_E2E${RUN}R`;
    capturedPayment(payId, b.orderId, { status: 'authorized', captured: false });
    const pending = await (await handleVerify(recoveryRequest(owner.token, b.bookingId), deps())).json();
    assertEquals([pending.result, pending.booking_status, pending.razorpay_payment_id], ['payment_pending', 'pending_payment', payId]);

    // a listed payment with the wrong amount is never applied, and makes the answer incomplete
    const wrong = `pay_E2E${RUN}W`;
    capturedPayment(wrong, b.orderId, { amount: 100 });
    const mixed = await (await handleVerify(recoveryRequest(owner.token, b.bookingId), deps())).json();
    assertEquals([mixed.result, mixed.complete], ['payment_pending', false]);
    assertEquals((await rest(`/rest/v1/payments?provider_payment_id=eq.${wrong}&select=id`)).body, [], 'mismatched payment not stored');
    payments.delete(wrong);

    // captured: recovery confirms the booking, and is idempotent
    capturedPayment(payId, b.orderId);
    const confirmed = await (await handleVerify(recoveryRequest(owner.token, b.bookingId), deps())).json();
    assertEquals(confirmed, {
      booking_id: b.bookingId, booking_status: 'confirmed', mode: 'recovery', complete: true,
      result: 'confirmed', razorpay_payment_id: payId, payment_status: 'captured', provider_refund: 'none',
      other_payments: [],
      // fulfilment closed the attempt: nothing is leased or payable any more
      checkout_lease: 'none',
    });
    assertEquals(await (await handleVerify(recoveryRequest(owner.token, b.bookingId), deps())).json(), confirmed);
    const db = await rest(`/rest/v1/bookings?id=eq.${b.bookingId}&select=status,payment_status,fulfilled_by_payment_id`);
    const row = await rest(`/rest/v1/payments?provider_payment_id=eq.${payId}&select=id`);
    assertEquals(db.body, [{ status: 'confirmed', payment_status: 'paid', fulfilled_by_payment_id: row.body[0].id }]);

    // a second capture on the same order: the pointer is not replaced, and recovery still
    // reports the fulfilling payment
    const dup = `pay_E2E${RUN}R2`;
    capturedPayment(dup, b.orderId);
    const after = await (await handleVerify(recoveryRequest(owner.token, b.bookingId), deps())).json();
    assertEquals([after.result, after.razorpay_payment_id], ['confirmed', payId]);
    assertEquals(after.other_payments, [{
      razorpay_payment_id: dup, payment_status: 'captured', provider_refund: 'none', result: 'not_fulfilled', decision: 'duplicate_capture',
    }], 'the additional captured payment is reported with our stored decision');
    assertEquals(
      (await rest(`/rest/v1/payments?provider_payment_id=eq.${dup}&select=settlement_decision`)).body,
      [{ settlement_decision: 'duplicate_capture' }], 'and the label is durable');
    const ptr = await rest(`/rest/v1/bookings?id=eq.${b.bookingId}&select=fulfilled_by_payment_id`);
    assertEquals(ptr.body[0].fulfilled_by_payment_id, row.body[0].id, 'the pointer stays on the first payment');

    // the explicit-id contract is unchanged
    const explicit = await (await handleVerify(verifyRequest(owner.token, b.bookingId, dup), deps())).json();
    assertEquals(explicit, {
      booking_id: b.bookingId, booking_status: 'confirmed', payment_status: 'captured', provider_refund: 'none', result: 'not_fulfilled',
    });

    secretsAbsent(log.text());
  },
});

Deno.test({
  name: 'local stack: Checkout lease across sessions, and a failed payment blocking a new session',
  ignore: !enabled,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const user = await newUser(8);
    const tabA = crypto.randomUUID();
    const tabB = crypto.randomUUID();
    const facilityId = crypto.randomUUID();
    const slotId = crypto.randomUUID();
    const bookingId = crypto.randomUUID();
    await must(rest('/rest/v1/facilities', {
      method: 'POST',
      body: JSON.stringify({
        id: facilityId, owner_id: user.id, name: `E2E ${RUN} lease`, sport: 'Badminton',
        address: '1 End To End Road', city: 'Testville', status: 'active', base_price: 500,
      }),
    }), 201, 'facility');
    await must(rest('/rest/v1/facility_slots', {
      method: 'POST',
      body: JSON.stringify({ id: slotId, facility_id: facilityId, start_time: '06:00', end_time: '07:00', duration_min: 60, base_price: 500 }),
    }), 201, 'slot');
    await must(rest('/rest/v1/bookings', {
      method: 'POST',
      body: JSON.stringify({
        id: bookingId, user_id: user.id, facility_id: facilityId, slot_id: slotId,
        booking_date: new Date(Date.now() + 46 * 86400_000).toISOString().slice(0, 10),
        start_time: '06:00', end_time: '07:00', amount: 500, status: 'pending_payment',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    }), 201, 'booking');

    // two tabs at once: exactly one gets the order
    const [a, b] = await Promise.all([
      handleCreateOrder(createOrderRequest(user.token, bookingId, tabA), deps()),
      handleCreateOrder(createOrderRequest(user.token, bookingId, tabB), deps()),
    ]);
    const answers = [{ tab: tabA, status: a.status, body: await a.json() }, { tab: tabB, status: b.status, body: await b.json() }];
    const served = answers.filter((x) => x.status === 200);
    assertEquals(served.length, 1, `exactly one tab gets the order: ${JSON.stringify(answers.map((x) => [x.status, x.body.error ?? 'order']))}`);
    const refused = answers.find((x) => x.status !== 200)!;
    assertEquals(refused.status, 409);
    assert(['order_creation_in_progress', 'checkout_in_progress'].includes(refused.body.error), refused.body.error);
    assert(!JSON.stringify(refused.body).includes(served[0].body.order_id), 'the refused tab gets no order id');
    const winner = served[0].tab;
    const loser = refused.tab;
    const orderId: string = served[0].body.order_id;
    const lost = await (await handleCreateOrder(createOrderRequest(user.token, bookingId, loser), deps())).json();
    assertEquals(lost.error, 'checkout_in_progress', 'the other tab is refused while the lease lasts');
    const attempt = await rest(`/rest/v1/payment_attempts?booking_id=eq.${bookingId}&select=checkout_lease_hash,checkout_lease_until`);
    assertEquals(attempt.body.length, 1);
    assert(/^[0-9a-f]{64}$/.test(attempt.body[0].checkout_lease_hash), 'only a hash of the session is stored');
    assert(attempt.body[0].checkout_lease_hash !== winner && attempt.body[0].checkout_lease_hash !== loser);

    // recovery tells the sessions apart, and says nothing about payments
    const lease = async (session?: string) => {
      const r = await (await handleVerify(recoveryRequest(user.token, bookingId, session), deps())).json();
      return [r.result, r.complete, r.checkout_lease, r.razorpay_payment_id];
    };
    assertEquals(await lease(winner), ['no_payment_found', true, 'yours', null], 'the holder sees its own lease');
    assertEquals(await lease(loser), ['no_payment_found', true, 'other', null], 'another session sees another session\'s lease');
    assertEquals(await lease(), ['no_payment_found', true, 'other', null], 'no session id: conservative');

    // a FAILED payment on the order: the holder cannot start a new session either
    const failedId = `pay_E2E${RUN}LF`;
    capturedPayment(failedId, orderId, { status: 'failed', captured: false });
    const again = await handleCreateOrder(createOrderRequest(user.token, bookingId, winner), deps());
    assertEquals([again.status, (await again.json()).error], [409, 'payment_may_exist'],
      'a failed payment is not final: no new Checkout session on the order');

    // recovery reports it, but nothing confirmed
    const rec = await (await handleVerify(new Request('http://edge.test/payments-verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ booking_id: bookingId }),
    }), deps())).json();
    assertEquals([rec.result, rec.complete, rec.booking_status], ['payment_failed', true, 'pending_payment']);

    secretsAbsent(log.text());
  },
});
