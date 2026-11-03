// Tests for the local payment simulator. Real HTTP on an ephemeral
// 127.0.0.1 port; the provider calls go through the REAL client and
// parsers of supabase/functions/_shared/razorpay.ts. Run with
//   deno test --allow-net=127.0.0.1 supabase/payment-simulator/
// (the permission makes any other network access fail).

import { SIMULATOR_KEY_ID, SIMULATOR_KEY_SECRET } from '../functions/_shared/config.ts';
import { createRazorpayClient, parsePayment, validateOrder } from '../functions/_shared/razorpay.ts';
import { assert, assertEquals } from '../functions/tests/helpers.ts';
import { HOSTNAME, parsePort, startSimulator } from './server.ts';
import { controlTokenProblem, createSimulator, DEFAULT_PORT, MAX_BODY_BYTES, MAX_PAYMENTS_PER_ORDER } from './simulator.ts';

const TOKEN = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
const RUN = 'TEST01';
const PROVIDER_AUTH = 'Basic ' + btoa(`${SIMULATOR_KEY_ID}:${SIMULATOR_KEY_SECRET}`);
const RECEIPT = '33333333-3333-4333-8333-333333333333';
const NOTES = { attempt_id: RECEIPT, booking_id: '22222222-2222-4222-8222-222222222222' };

// Decoded JSON response bodies, read loosely in assertions.
// deno-lint-ignore no-explicit-any
type Json = any;

interface Ctx {
  base: string;
  port: number;
  logs: string[];
  client: ReturnType<typeof createRazorpayClient>;
  provider(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: Json }>;
  control(path: string, body?: unknown, token?: string | null): Promise<{ status: number; body: Json }>;
}

async function withSim(fn: (c: Ctx) => Promise<void>, opts: { controlToken?: string | null; timeoutMs?: number } = {}) {
  const logs: string[] = [];
  const s = startSimulator({
    port: 0,
    controlToken: opts.controlToken === undefined ? TOKEN : opts.controlToken,
    runId: RUN,
    log: (l) => logs.push(JSON.stringify(l)),
  });
  const base = `http://${HOSTNAME}:${s.port}`;
  const send = async (method: string, path: string, body: unknown, headers: Record<string, string>) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch { /* keep text */ }
    return { status: res.status, body: parsed as Json };
  };
  const ctx: Ctx = {
    base,
    port: s.port,
    logs,
    client: createRazorpayClient({
      credentials: { keyId: SIMULATOR_KEY_ID, keySecret: SIMULATOR_KEY_SECRET },
      apiBase: base,
      fetch,
      timeoutMs: opts.timeoutMs ?? 2000,
    }),
    provider: (method, path, body, headers = {}) =>
      send(method, path, body, { Authorization: PROVIDER_AUTH, 'Content-Type': 'application/json', ...headers }),
    control: (path, body = {}, token = TOKEN) =>
      send('POST', path, body, { 'Content-Type': 'application/json', ...(token === null ? {} : { 'X-Simulator-Control-Token': token }) }),
  };
  try {
    await fn(ctx);
  } finally {
    await s.shutdown();
  }
}

const orderInput = (over: Record<string, unknown> = {}) => ({ amount: 50000, currency: 'INR', receipt: RECEIPT, notes: NOTES, ...over });

async function newOrder(c: Ctx, over: Record<string, unknown> = {}): Promise<string> {
  const r = await c.client.createOrder(orderInput(over) as never);
  assert(r.kind === 'created', `order not created: ${JSON.stringify(r)}`);
  const v = validateOrder(r.order, { amount: (over.amount as number) ?? 50000, currency: 'INR', receipt: (over.receipt as string) ?? RECEIPT });
  assert(v !== null, 'order shape must pass the real validateOrder');
  return v.id;
}

async function pay(c: Ctx, orderId: string, outcome: string, extra: Record<string, unknown> = {}): Promise<Json> {
  const r = await c.control(`/__control/orders/${orderId}/payments`, { outcome, ...extra });
  assertEquals(r.status, 200, `pay ${outcome}`);
  return r.body.payment;
}

// A raw HTTP/1.1 request (fetch cannot set Host or a forged Origin).
async function rawRequest(port: number, head: string): Promise<number> {
  const conn = await Deno.connect({ hostname: '127.0.0.1', port });
  try {
    await conn.write(new TextEncoder().encode(head));
    const buf = new Uint8Array(4096);
    let text = '';
    for (;;) {
      const n = await conn.read(buf);
      if (n === null) break;
      text += new TextDecoder().decode(buf.subarray(0, n));
      if (text.includes('\r\n\r\n')) break;
    }
    return Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0);
  } finally {
    conn.close();
  }
}

// ---------------------------------------------------------------
// startup, binding, configuration
// ---------------------------------------------------------------

Deno.test('server: listens on 127.0.0.1 only, on an ephemeral port in tests', async () => {
  assertEquals(HOSTNAME, '127.0.0.1');
  await withSim(async (c) => {
    assert(c.base.startsWith('http://127.0.0.1:') && c.port > 0, 'loopback base');
    const r = await fetch(`${c.base}/health`);
    assertEquals([r.status, await r.json()], [200, { status: 'ok', simulator: 'local-only' }]);
  });
});

Deno.test('server: the port is validated strictly (default 59480)', () => {
  assertEquals([parsePort(undefined), parsePort(''), DEFAULT_PORT], [59480, 59480, 59480]);
  assertEquals([parsePort('1024'), parsePort('59480'), parsePort('65535')], [1024, 59480, 65535]);
  for (const bad of ['0', '80', '1023', '65536', '99999', '059480', '59480 ', ' 59480', '-1', '1e4', '0x1000', 'abc', '5948.0']) {
    assertEquals(parsePort(bad), null, `port ${JSON.stringify(bad)}`);
  }
});

Deno.test('server: a weak or reused control token, or a bad run id, is refused at startup', () => {
  assert(controlTokenProblem('short') !== null, 'short');
  assert(controlTokenProblem('x'.repeat(31)) !== null, '31 chars');
  assert(controlTokenProblem('a'.repeat(40) + ' ') !== null, 'whitespace');
  assert(controlTokenProblem('a'.repeat(40) + '!') !== null, 'punctuation');
  assert(controlTokenProblem(SIMULATOR_KEY_SECRET) !== null, 'the provider placeholder secret');
  assertEquals(controlTokenProblem(TOKEN), null);
  const make = (token: string | null, runId: string) => () => createSimulator({ port: () => 1, controlToken: token, runId });
  for (const [token, runId] of [['short', 'TEST01'], [TOKEN, 'test01'], [TOKEN, 'TEST0'], [TOKEN, 'TEST01X']] as const) {
    let threw = false;
    try {
      make(token, runId)();
    } catch {
      threw = true;
    }
    assert(threw, `must refuse token/runId ${runId}`);
  }
});

Deno.test('health: GET only, no query, no credentials needed, reveals no state', async () => {
  await withSim(async (c) => {
    await newOrder(c);
    const h = await fetch(`${c.base}/health`);
    assertEquals(await h.json(), { status: 'ok', simulator: 'local-only' });
    const post = await fetch(`${c.base}/health`, { method: 'POST' });
    await post.body?.cancel();
    assertEquals(post.status, 405);
    const q = await fetch(`${c.base}/health?x=1`);
    await q.body?.cancel();
    assertEquals(q.status, 400);
  });
});

// ---------------------------------------------------------------
// provider authentication
// ---------------------------------------------------------------

Deno.test('provider auth: only the placeholder key; missing, real-shaped or other credentials are 401', async () => {
  await withSim(async (c) => {
    for (const auth of [
      undefined,
      'Basic ' + btoa('rzp_test_DUMMYKEY0001:dummy-secret-not-real'),
      'Basic ' + btoa(`${SIMULATOR_KEY_ID}:wrong`),
      'Basic ' + btoa(`rzp_live_DUMMYKEY0001:${SIMULATOR_KEY_SECRET}`),
      `Bearer ${TOKEN}`,
      // (trailing header whitespace is stripped by HTTP itself, so it is not a distinct credential)
      'Basic ' + btoa(`${SIMULATOR_KEY_ID}:${SIMULATOR_KEY_SECRET}x`),
      'Basic ' + btoa(`${SIMULATOR_KEY_ID}:${SIMULATOR_KEY_SECRET}:extra`),
      PROVIDER_AUTH.toLowerCase(),
    ]) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (auth !== undefined) headers.Authorization = auth;
      const res = await fetch(`${c.base}/v1/orders`, { method: 'POST', headers, body: JSON.stringify(orderInput()) });
      const body = await res.json();
      assertEquals(res.status, 401, `auth ${auth?.slice(0, 12)}`);
      assertEquals(typeof body.error.description, 'string');
    }
    // nothing was created by the refused requests
    const found = await c.client.findOrdersByReceipt(RECEIPT);
    assertEquals(found, { kind: 'ok', orders: [] });
    // the control token is not a provider credential either
    const r = await c.provider('GET', '/v1/payments/pay_SIMULATEDTEST01000001', undefined, { Authorization: TOKEN });
    assertEquals(r.status, 401);
  });
});

// ---------------------------------------------------------------
// POST /v1/orders
// ---------------------------------------------------------------

Deno.test('orders: creation answers an order the real client accepts, with deterministic fake ids', async () => {
  await withSim(async (c) => {
    const r = await c.client.createOrder(orderInput() as never);
    assert(r.kind === 'created');
    const o = r.order as Record<string, unknown>;
    assertEquals(o.id, 'order_SIMULATEDTEST01000001');
    assertEquals([o.entity, o.amount, o.amount_paid, o.amount_due, o.currency, o.receipt, o.status, o.attempts], [
      'order', 50000, 0, 50000, 'INR', RECEIPT, 'created', 0,
    ]);
    assertEquals(o.notes, NOTES);
    assert(typeof o.created_at === 'number', 'created_at');
    assert(validateOrder(o, { amount: 50000, currency: 'INR', receipt: RECEIPT }) !== null, 'validateOrder');
    assertEquals(await newOrder(c, { receipt: 'other-receipt-1' }), 'order_SIMULATEDTEST01000002');
  });
});

Deno.test('orders: malformed JSON, wrong types and invalid amount/currency/receipt/notes are 400 and create nothing', async () => {
  await withSim(async (c) => {
    const bad: [string, unknown][] = [
      ['malformed', '{"amount": 50000,'],
      ['array', '[]'],
      ['string', '"x"'],
      ['empty', ''],
      ['amount 0', orderInput({ amount: 0 })],
      ['amount 99', orderInput({ amount: 99 })],
      ['amount fraction', orderInput({ amount: 500.5 })],
      ['amount string', orderInput({ amount: '50000' })],
      ['amount negative', orderInput({ amount: -100 })],
      ['amount huge', orderInput({ amount: 1e12 })],
      ['amount missing', { currency: 'INR', receipt: RECEIPT }],
      ['currency USD', orderInput({ currency: 'USD' })],
      ['currency lower', orderInput({ currency: 'inr' })],
      ['currency missing', { amount: 50000, receipt: RECEIPT }],
      ['receipt empty', orderInput({ receipt: '' })],
      ['receipt 41', orderInput({ receipt: 'r'.repeat(41) })],
      ['receipt space', orderInput({ receipt: 'a b' })],
      ['receipt path', orderInput({ receipt: '../x' })],
      ['receipt number', orderInput({ receipt: 7 })],
      ['receipt missing', { amount: 50000, currency: 'INR' }],
      ['notes array', orderInput({ notes: [] })],
      ['notes too many', orderInput({ notes: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, 'v'])) })],
      ['notes bad key', orderInput({ notes: { 'Bad-Key': 'v' } })],
      ['notes non-string', orderInput({ notes: { k: 1 } })],
      ['notes long value', orderInput({ notes: { k: 'v'.repeat(257) } })],
      ['unknown field', orderInput({ partial_payment: true })],
    ];
    for (const [label, body] of bad) {
      const r = await c.provider('POST', '/v1/orders', body);
      assertEquals(r.status, 400, label);
      assertEquals(typeof r.body?.error?.description, 'string', label);
    }
    const noType = await c.provider('POST', '/v1/orders', orderInput(), { 'Content-Type': 'text/plain' });
    assertEquals(noType.status, 400, 'content-type');
    const query = await c.provider('POST', '/v1/orders?receipt=x', orderInput());
    assertEquals(query.status, 400, 'query on POST');
    // the real client classifies a 400 as a definitive rejection
    const r = await c.client.createOrder(orderInput({ amount: 1 }) as never);
    assertEquals(r, { kind: 'rejected', status: 400 });
    assertEquals(await c.client.findOrdersByReceipt(RECEIPT), { kind: 'ok', orders: [] });
  });
});

Deno.test('orders: an oversized body is 413 (declared or not)', async () => {
  assertEquals(MAX_BODY_BYTES, 8 * 1024);
  await withSim(async (c) => {
    // a fixed size just over 8 KiB, independent of the constant
    const big = JSON.stringify(orderInput({ notes: { k: 'v'.repeat(200) }, pad: 'x'.repeat(8300) }));
    const r = await c.provider('POST', '/v1/orders', big);
    assertEquals(r.status, 413);
    // streamed without a content-length
    const stream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(big));
        ctrl.close();
      },
    });
    const res = await fetch(`${c.base}/v1/orders`, {
      method: 'POST',
      headers: { Authorization: PROVIDER_AUTH, 'Content-Type': 'application/json' },
      body: stream,
    });
    await res.body?.cancel();
    assertEquals(res.status, 413);
  });
});

// ---------------------------------------------------------------
// GET /v1/orders?receipt=
// ---------------------------------------------------------------

Deno.test('orders by receipt: exact receipt only, newest first, bounded by count', async () => {
  await withSim(async (c) => {
    const a = await newOrder(c);
    await newOrder(c, { receipt: `${RECEIPT.slice(0, 35)}9` });
    await newOrder(c, { receipt: 'prefix' });
    const b = await newOrder(c);
    const r = await c.client.findOrdersByReceipt(RECEIPT);
    assert(r.kind === 'ok');
    assertEquals(r.orders.map((o) => (o as { id: string }).id), [b, a]);
    assertEquals((await c.client.findOrdersByReceipt('pre')).kind === 'ok' && (await c.client.findOrdersByReceipt('pre')), { kind: 'ok', orders: [] });
    const one = await c.provider('GET', `/v1/orders?receipt=${RECEIPT}&count=1`);
    assertEquals([one.status, one.body.entity, one.body.count, one.body.items.length], [200, 'collection', 1, 1]);
  });
});

Deno.test('orders by receipt: missing/invalid receipt, bad count, unknown or repeated parameters are 400', async () => {
  await withSim(async (c) => {
    for (const q of [
      '', '?count=10', '?receipt=', '?receipt=a%20b', `?receipt=${'r'.repeat(41)}`,
      `?receipt=${RECEIPT}&count=0`, `?receipt=${RECEIPT}&count=101`, `?receipt=${RECEIPT}&count=abc`, `?receipt=${RECEIPT}&count=-1`,
      `?receipt=${RECEIPT}&skip=1`, `?receipt=${RECEIPT}&receipt=${RECEIPT}`, `?receipt=${RECEIPT}&expand[]=payments`,
    ]) {
      const r = await c.provider('GET', `/v1/orders${q}`);
      assertEquals(r.status, 400, `query ${q}`);
    }
  });
});

// ---------------------------------------------------------------
// GET /v1/payments/{id} and GET /v1/orders/{id}/payments
// ---------------------------------------------------------------

Deno.test('payments: captured, failed and authorized payments parse with the real parser; ids are stable', async () => {
  await withSim(async (c) => {
    const order = await newOrder(c);
    const cap = await pay(c, order, 'captured');
    const fail = await pay(c, order, 'failed');
    const auth = await pay(c, order, 'authorized');
    assertEquals([cap.id, fail.id, auth.id], ['pay_SIMULATEDTEST01000001', 'pay_SIMULATEDTEST01000002', 'pay_SIMULATEDTEST01000003']);
    for (const [p, status, captured] of [[cap, 'captured', true], [fail, 'failed', false], [auth, 'authorized', false]] as const) {
      const r = await c.client.fetchPayment(p.id);
      assert(r.kind === 'ok');
      const facts = parsePayment(r.payment, p.id);
      assert(facts !== null, `parsePayment ${status}`);
      assertEquals([facts.id, facts.order_id, facts.status, facts.amount, facts.currency, facts.amount_refunded], [
        p.id, order, status, 50000, 'INR', 0,
      ]);
      assertEquals((r.payment as { captured: boolean }).captured, captured);
    }
    const failed = parsePayment((await c.client.fetchPayment(fail.id) as { payment: unknown }).payment, fail.id)!;
    assertEquals([failed.error_code, failed.error_description], ['BAD_REQUEST_ERROR', 'Simulated payment failure']);
    // no customer contact data is ever invented
    const rawPay = (await c.provider('GET', `/v1/payments/${cap.id}`)).body;
    assert(!('email' in rawPay) && !('contact' in rawPay), 'no contact fields');
  });
});

Deno.test('payments: unknown or malformed ids are "does not exist" (the client reports not_found)', async () => {
  await withSim(async (c) => {
    assertEquals(await c.client.fetchPayment('pay_SIMULATEDTEST01999999'), { kind: 'not_found' });
    assertEquals(await c.client.fetchPayment('pay_NOTREAL'), { kind: 'not_found' });
    for (const id of ['pay_', 'nope', 'pay_a-b', 'order_SIMULATEDTEST01000001', 'pay_%2E%2E']) {
      const r = await c.provider('GET', `/v1/payments/${id}`);
      assertEquals(r.status, 400, id);
      assert(/does not exist/.test(r.body.error.description), id);
    }
    const q = await c.provider('GET', '/v1/payments/pay_SIMULATEDTEST01000001?expand[]=card');
    assertEquals(q.status, 400);
  });
});

Deno.test('order payments: an order lists only its own payments (cross-order isolation)', async () => {
  await withSim(async (c) => {
    const a = await newOrder(c);
    const b = await newOrder(c, { receipt: 'second-receipt' });
    const pa = await pay(c, a, 'captured');
    const pb1 = await pay(c, b, 'failed');
    const pb2 = await pay(c, b, 'authorized');
    const la = await c.client.fetchOrderPayments(a);
    const lb = await c.client.fetchOrderPayments(b);
    assert(la.kind === 'ok' && lb.kind === 'ok');
    assertEquals(la.items.map((p) => (p as { id: string }).id), [pa.id]);
    assertEquals(lb.items.map((p) => (p as { id: string }).id), [pb1.id, pb2.id]);
    assert(la.complete && lb.complete, 'short lists are complete');
    assert(la.items.every((p) => (p as { order_id: string }).order_id === a), 'order ids');
    // each listed item parses for its own id
    for (const item of lb.items) assert(parsePayment(item, (item as { id: string }).id) !== null, 'listed item parses');
    // an order with no payments
    const empty = await newOrder(c, { receipt: 'third-receipt' });
    assertEquals(await c.client.fetchOrderPayments(empty), { kind: 'ok', items: [], complete: true });
  });
});

Deno.test('order payments: unknown or malformed order ids are refused; a list of 10+ is reported incomplete by the client', async () => {
  await withSim(async (c) => {
    const unknown = await c.client.fetchOrderPayments('order_SIMULATEDTEST01999999');
    assertEquals(unknown.kind, 'error');
    for (const id of ['order_', 'x', 'order_a-b', 'pay_SIMULATEDTEST01000001']) {
      const r = await c.provider('GET', `/v1/orders/${id}/payments`);
      assertEquals(r.status, 400, id);
    }
    const order = await newOrder(c);
    for (let i = 0; i < 10; i++) await pay(c, order, 'failed');
    const l = await c.client.fetchOrderPayments(order);
    assert(l.kind === 'ok');
    assertEquals([l.items.length, l.complete], [10, false]);
  });
});

// ---------------------------------------------------------------
// control API: authentication and validation
// ---------------------------------------------------------------

Deno.test('control: disabled without a token; wrong, missing or provider credentials are refused', async () => {
  await withSim(async (c) => {
    const r = await c.control('/__control/reset', {}, TOKEN);
    assertEquals([r.status, r.body.error], [403, 'control_disabled']);
  }, { controlToken: null });
  await withSim(async (c) => {
    const order = await newOrder(c);
    for (const token of [null, '', 'x'.repeat(64), TOKEN.slice(0, -1), TOKEN + 'x', PROVIDER_AUTH]) {
      const r = await c.control(`/__control/orders/${order}/payments`, { outcome: 'captured' }, token);
      assertEquals(r.status, 401, `token ${token === null ? 'missing' : 'wrong'}`);
    }
    // the provider Basic credentials do not unlock the control API
    const res = await fetch(`${c.base}/__control/reset`, {
      method: 'POST', headers: { Authorization: PROVIDER_AUTH, 'Content-Type': 'application/json' }, body: '{}',
    });
    await res.body?.cancel();
    assertEquals(res.status, 401);
    // nothing happened
    assertEquals(await c.client.fetchOrderPayments(order), { kind: 'ok', items: [], complete: true });
    // GET, query strings and unknown control routes
    const get = await fetch(`${c.base}/__control/reset`, { headers: { 'X-Simulator-Control-Token': TOKEN } });
    await get.body?.cancel();
    assertEquals(get.status, 405);
    assertEquals((await c.control('/__control/reset?x=1')).status, 400);
    assertEquals((await c.control('/__control/orders')).status, 404);
    assertEquals((await c.control('/__control/anything')).status, 404);
  });
});

Deno.test('control: payments only for existing orders, with validated outcome/amount and a per-order limit', async () => {
  await withSim(async (c) => {
    const order = await newOrder(c);
    assertEquals((await c.control('/__control/orders/order_SIMULATEDTEST01999999/payments', { outcome: 'captured' })).status, 404);
    assertEquals((await c.control('/__control/orders/../payments', { outcome: 'captured' })).status, 404);
    assertEquals((await c.control('/__control/orders/not-an-order/payments', { outcome: 'captured' })).status, 404);
    for (const body of [
      {}, { outcome: 'refunded' }, { outcome: 'CAPTURED' }, { outcome: 'captured', amount: 0 }, { outcome: 'captured', amount: '1' },
      { outcome: 'captured', id: 'pay_CHOSENBYCALLER' }, { outcome: 'captured', order_id: 'order_OTHER' }, { outcome: 'captured', currency: 'USD' },
    ]) {
      assertEquals((await c.control(`/__control/orders/${order}/payments`, body)).status, 400, JSON.stringify(body));
    }
    const malformed = await fetch(`${c.base}/__control/orders/${order}/payments`, {
      method: 'POST', headers: { 'X-Simulator-Control-Token': TOKEN, 'Content-Type': 'application/json' }, body: '{"outcome":',
    });
    await malformed.body?.cancel();
    assertEquals(malformed.status, 400);
    // an explicit amount (e.g. to exercise an amount mismatch) keeps the order's currency
    const odd = await pay(c, order, 'captured', { amount: 49999 });
    assertEquals([odd.amount, odd.currency, odd.order_id], [49999, 'INR', order]);
    for (let i = 1; i < MAX_PAYMENTS_PER_ORDER; i++) await pay(c, order, 'failed');
    assertEquals((await c.control(`/__control/orders/${order}/payments`, { outcome: 'failed' })).status, 409);
  });
});

// ---------------------------------------------------------------
// state transitions
// ---------------------------------------------------------------

Deno.test('transitions: authorize -> capture; the order becomes paid; identity never changes', async () => {
  await withSim(async (c) => {
    const order = await newOrder(c);
    const p = await pay(c, order, 'authorized');
    let o = (await c.client.findOrdersByReceipt(RECEIPT) as { orders: Record<string, unknown>[] }).orders[0];
    assertEquals([o.status, o.attempts, o.amount_paid], ['attempted', 1, 0]);
    const cap = await c.control(`/__control/payments/${p.id}/capture`);
    assertEquals([cap.status, cap.body.payment.id, cap.body.payment.order_id, cap.body.payment.status, cap.body.payment.captured], [
      200, p.id, order, 'captured', true,
    ]);
    o = (await c.client.findOrdersByReceipt(RECEIPT) as { orders: Record<string, unknown>[] }).orders[0];
    assertEquals([o.id, o.status, o.amount_paid, o.amount_due], [order, 'paid', 50000, 0]);
    // capture is not repeatable
    assertEquals((await c.control(`/__control/payments/${p.id}/capture`)).status, 409);
  });
});

Deno.test('transitions: a failed payment can be authorized late and then captured (same id)', async () => {
  await withSim(async (c) => {
    const order = await newOrder(c);
    const p = await pay(c, order, 'failed');
    assertEquals((await c.control(`/__control/payments/${p.id}/capture`)).status, 409);
    const a = await c.control(`/__control/payments/${p.id}/authorize`);
    assertEquals([a.status, a.body.payment.status, a.body.payment.error_code], [200, 'authorized', null]);
    assertEquals((await c.control(`/__control/payments/${p.id}/authorize`)).status, 409);
    await c.control(`/__control/payments/${p.id}/capture`);
    const facts = parsePayment((await c.client.fetchPayment(p.id) as { payment: unknown }).payment, p.id)!;
    assertEquals([facts.id, facts.order_id, facts.status, facts.error_code], [p.id, order, 'captured', null]);
  });
});

Deno.test('transitions: partial then full refund of a captured payment; never more than captured', async () => {
  await withSim(async (c) => {
    const order = await newOrder(c);
    const p = await pay(c, order, 'captured');
    assertEquals((await c.control(`/__control/payments/${p.id}/refund`, { amount: 50001 })).status, 400);
    assertEquals((await c.control(`/__control/payments/${p.id}/refund`, { amount: 0 })).status, 400);
    const part = await c.control(`/__control/payments/${p.id}/refund`, { amount: 20000 });
    assertEquals([part.body.payment.status, part.body.payment.amount_refunded, part.body.payment.refund_status], ['captured', 20000, 'partial']);
    const rest = await c.control(`/__control/payments/${p.id}/refund`);
    assertEquals([rest.body.payment.status, rest.body.payment.amount_refunded, rest.body.payment.refund_status], ['refunded', 50000, 'full']);
    assertEquals((await c.control(`/__control/payments/${p.id}/refund`)).status, 409);
    const facts = parsePayment((await c.client.fetchPayment(p.id) as { payment: unknown }).payment, p.id)!;
    assertEquals([facts.status, facts.amount_refunded], ['refunded', 50000]);
    // only captured payments can be refunded
    const f = await pay(c, order, 'failed');
    assertEquals((await c.control(`/__control/payments/${f.id}/refund`)).status, 409);
    // unknown payment ids, unsupported fields
    assertEquals((await c.control('/__control/payments/pay_SIMULATEDTEST01999999/capture')).status, 404);
    assertEquals((await c.control('/__control/payments/not-a-payment/capture')).status, 404);
    assertEquals((await c.control(`/__control/payments/${f.id}/authorize`, { status: 'captured' })).status, 400);
  });
});

Deno.test('duplicate captures on one order are both reported; the order keeps its first paid amount', async () => {
  await withSim(async (c) => {
    const order = await newOrder(c);
    const first = await pay(c, order, 'captured');
    const second = await pay(c, order, 'captured');
    const l = await c.client.fetchOrderPayments(order);
    assert(l.kind === 'ok');
    assertEquals(l.items.map((p) => [(p as { id: string }).id, (p as { status: string }).status]), [[first.id, 'captured'], [second.id, 'captured']]);
    const o = (await c.client.findOrdersByReceipt(RECEIPT) as { orders: Record<string, unknown>[] }).orders[0];
    assertEquals([o.status, o.amount_paid, o.attempts], ['paid', 50000, 2]);
  });
});

// ---------------------------------------------------------------
// faults: provider errors and ambiguous (late) answers
// ---------------------------------------------------------------

Deno.test('faults: a server error or rate limit is ambiguous to the client and creates nothing', async () => {
  await withSim(async (c) => {
    assertEquals((await c.control('/__control/faults', { operation: 'create_order', mode: 'server_error' })).status, 200);
    assertEquals(await c.client.createOrder(orderInput() as never), { kind: 'ambiguous', reason: 'server_error', status: 500 });
    assertEquals(await c.client.findOrdersByReceipt(RECEIPT), { kind: 'ok', orders: [] });
    await c.control('/__control/faults', { operation: 'create_order', mode: 'rate_limited' });
    assertEquals(await c.client.createOrder(orderInput() as never), { kind: 'ambiguous', reason: 'rate_limited', status: 429 });
    // consumed once: the next call succeeds
    assertEquals((await c.client.createOrder(orderInput() as never)).kind, 'created');
    // the other operations can fail too
    await c.control('/__control/faults', { operation: 'find_orders', mode: 'server_error' });
    assertEquals((await c.client.findOrdersByReceipt(RECEIPT)).kind, 'error');
    await c.control('/__control/faults', { operation: 'order_payments', mode: 'server_error' });
    assertEquals((await c.client.fetchOrderPayments('order_SIMULATEDTEST01000001')).kind, 'error');
  });
});

Deno.test('faults: a delayed order creation times out at the client, yet the order exists (unknown outcome)', async () => {
  await withSim(async (c) => {
    await c.control('/__control/faults', { operation: 'create_order', mode: 'delay', delay_ms: 400 });
    assertEquals(await c.client.createOrder(orderInput() as never), { kind: 'ambiguous', reason: 'timeout' });
    // the provider already created it (only the answer is late): a
    // lookup by receipt while that answer is still pending finds exactly one
    const found = await c.client.findOrdersByReceipt(RECEIPT);
    await new Promise((r) => setTimeout(r, 450));
    assert(found.kind === 'ok');
    assertEquals(found.orders.length, 1);
    // a delayed payment fetch is a client timeout as well
    const order = (found.orders[0] as { id: string }).id;
    const p = await pay(c, order, 'captured');
    await c.control('/__control/faults', { operation: 'fetch_payment', mode: 'delay', delay_ms: 400 });
    assertEquals(await c.client.fetchPayment(p.id), { kind: 'error', reason: 'timeout' });
    await new Promise((r) => setTimeout(r, 450));
  }, { timeoutMs: 100 });
});

Deno.test('faults: invalid specifications are refused and bounded', async () => {
  await withSim(async (c) => {
    for (const body of [
      {}, { operation: 'refund', mode: 'server_error' }, { operation: 'create_order', mode: 'drop' },
      { operation: 'create_order', mode: 'delay' }, { operation: 'create_order', mode: 'delay', delay_ms: 0 },
      { operation: 'create_order', mode: 'delay', delay_ms: 30_001 }, { operation: 'create_order', mode: 'server_error', delay_ms: 10 },
      { operation: 'create_order', mode: 'server_error', times: 0 }, { operation: 'create_order', mode: 'server_error', times: 11 },
      { operation: 'create_order', mode: 'server_error', url: 'http://example.com' },
    ]) {
      assertEquals((await c.control('/__control/faults', body)).status, 400, JSON.stringify(body));
    }
    assertEquals((await c.control('/__control/faults', { operation: 'fetch_payment', mode: 'server_error', times: 10 })).body, { pending_faults: 10 });
    assertEquals((await c.control('/__control/faults', { operation: 'fetch_payment', mode: 'server_error' })).status, 400);
  });
});

Deno.test('reset: forgets orders, payments and faults; ids are never reused', async () => {
  await withSim(async (c) => {
    const order = await newOrder(c);
    await pay(c, order, 'captured');
    await c.control('/__control/faults', { operation: 'create_order', mode: 'server_error' });
    assertEquals((await c.control('/__control/reset', { all: true })).status, 400);
    assertEquals((await c.control('/__control/reset')).body, { reset: true });
    assertEquals(await c.client.findOrdersByReceipt(RECEIPT), { kind: 'ok', orders: [] });
    assertEquals(await c.client.fetchPayment('pay_SIMULATEDTEST01000001'), { kind: 'not_found' });
    // the fault was cleared and the id sequence continues
    assertEquals(await newOrder(c), 'order_SIMULATEDTEST01000002');
  });
});

// ---------------------------------------------------------------
// routing, hosts, browsers, logging
// ---------------------------------------------------------------

Deno.test('routing: unsupported paths and methods are refused, never silently accepted', async () => {
  await withSim(async (c) => {
    for (const [method, path, status] of [
      ['GET', '/', 404], ['GET', '/v1', 404], ['GET', '/v1/', 404], ['GET', '/v1/orders/', 404], ['GET', '//v1/orders', 404],
      ['GET', '/v1/refunds', 404], ['GET', '/v1/orders/order_SIMULATEDTEST01000001', 404], ['GET', '/v1/payments', 404],
      ['GET', '/v1/payments/pay_SIMULATEDTEST01000001/refunds', 404], ['POST', '/v1/payments/pay_SIMULATEDTEST01000001/capture', 404],
      ['PUT', '/v1/orders', 405], ['DELETE', '/v1/orders', 405], ['PATCH', '/v1/orders', 405],
      ['POST', '/v1/payments/pay_SIMULATEDTEST01000001', 405], ['DELETE', '/v1/orders/order_SIMULATEDTEST01000001/payments', 405],
      ['GET', '/proxy?url=http://example.com', 404],
    ] as const) {
      const r = await c.provider(method, path, method === 'GET' || method === 'DELETE' ? undefined : '{}');
      assertEquals(r.status, status, `${method} ${path}`);
    }
  });
});

Deno.test('hosts and browsers: a foreign Host header (DNS rebinding) or any Origin is refused', async () => {
  await withSim(async (c) => {
    const req = (host: string, extra = '') =>
      `GET /health HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`;
    assertEquals(await rawRequest(c.port, req(`127.0.0.1:${c.port}`)), 200);
    assertEquals(await rawRequest(c.port, req(`localhost:${c.port}`)), 200);
    assertEquals(await rawRequest(c.port, req(`host.docker.internal:${c.port}`)), 200);
    for (const host of ['evil.example', `evil.example:${c.port}`, `127.0.0.1:${c.port + 1}`, '127.0.0.1', `192.168.1.5:${c.port}`]) {
      assertEquals(await rawRequest(c.port, req(host)), 421, `host ${host}`);
    }
    assertEquals(await rawRequest(c.port, req(`127.0.0.1:${c.port}`, 'Origin: http://localhost:3000\r\n')), 403);
    assertEquals(await rawRequest(c.port, req(`127.0.0.1:${c.port}`, 'Origin: null\r\n')), 403);
  });
});

Deno.test('logs: method, route template and status only (no credentials, token, receipt or body)', async () => {
  await withSim(async (c) => {
    const order = await newOrder(c);
    await pay(c, order, 'captured');
    await c.control('/__control/orders/x/payments', { outcome: 'captured' }, 'wrong-token-value-0000000000000000000');
    await c.client.findOrdersByReceipt(RECEIPT);
    const text = c.logs.join('\n');
    for (const secret of [TOKEN, PROVIDER_AUTH, btoa(`${SIMULATOR_KEY_ID}:${SIMULATOR_KEY_SECRET}`), SIMULATOR_KEY_SECRET, 'wrong-token-value', RECEIPT, NOTES.booking_id]) {
      assert(!text.includes(secret), 'a sensitive value reached the log');
    }
    for (const line of c.logs) assertEquals(Object.keys(JSON.parse(line)).sort(), ['event', 'method', 'route', 'status']);
    assert(c.logs.some((l) => l.includes('"/v1/orders/{id}/payments"') || l.includes('"/__control/orders/{id}/payments"')), 'templated routes');
  });
});
