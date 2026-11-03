// Mocked tests for payments-create-order. No real Razorpay call.

import { readConfig } from '../_shared/config.ts';
import { handleCreateOrder } from '../_shared/create_order.ts';
import {
  assert,
  assertEquals,
  ATTEMPT_ID,
  BOOKING_ID,
  deps,
  FakeNet,
  KEY_ID,
  KEY_SECRET,
  secretsAbsent,
  testConfig,
  USER_ID,
  USER_TOKEN,
} from './helpers.ts';

const SESSION = '44444444-4444-4444-8444-444444444444';

function request(body: unknown = { booking_id: BOOKING_ID, checkout_session: SESSION }, token: string | null = USER_TOKEN, method = 'POST') {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return new Request('http://edge.test/payments-create-order', {
    method,
    headers,
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
}

const ORDER = (over: Record<string, unknown> = {}) => ({
  id: 'order_TESTORDER001',
  entity: 'order',
  amount: 50000,
  amount_paid: 0,
  currency: 'INR',
  receipt: ATTEMPT_ID,
  status: 'created',
  ...over,
});

const GRANTED = (over: Record<string, unknown> = {}) => ({
  outcome: 'granted', resumed: false, provider_order_id: 'order_TESTORDER001',
  amount_paise: 50000, currency: 'INR', hold_seconds_remaining: 400, ...over,
});

function preparedNet(action: Record<string, unknown>, lease: Record<string, unknown> = GRANTED()) {
  const net = new FakeNet();
  net.rpc.payment_prepare_attempt = () => ({ status: 200, body: action });
  net.rpc.payment_record_order = () => ({ status: 200, body: { outcome: 'recorded' } });
  net.rpc.payment_close_attempt = () => ({ status: 200, body: { outcome: 'closed' } });
  net.rpc.payment_acquire_checkout_lease = () => ({ status: 200, body: lease });
  return net;
}

const REUSE = { action: 'reuse', attempt_id: ATTEMPT_ID, provider_order_id: 'order_TESTORDER001', amount_paise: 50000, currency: 'INR' };

const CREATE = { action: 'create', attempt_id: ATTEMPT_ID, amount_paise: 50000, currency: 'INR', receipt: ATTEMPT_ID, hold_seconds_remaining: 400 };
const RECOVER = { ...CREATE, action: 'recover' };

// ---------------------------------------------------------------
// authentication, request validation, configuration
// ---------------------------------------------------------------

Deno.test('preflight and method handling', async () => {
  const net = new FakeNet();
  const opt = await handleCreateOrder(request(undefined, null, 'OPTIONS'), deps(net));
  assertEquals(opt.status, 204);
  assert(opt.headers.get('access-control-allow-origin') === '*');
  const get = await handleCreateOrder(request(undefined, USER_TOKEN, 'GET'), deps(net));
  assertEquals(get.status, 405);
  assertEquals(net.calls.length, 0);
});

Deno.test('missing authentication is rejected before any database or provider call', async () => {
  const net = new FakeNet();
  const res = await handleCreateOrder(request(undefined, null), deps(net));
  assertEquals(res.status, 401);
  assertEquals(net.calls.length, 0);
});

Deno.test('an invalid token is rejected', async () => {
  const net = new FakeNet();
  const res = await handleCreateOrder(request(undefined, 'forged.jwt.token-000000000000000000'), deps(net));
  assertEquals(res.status, 401);
  assertEquals(net.rpcCalls('payment_prepare_attempt').length, 0);
});

Deno.test('malformed, incomplete and oversized bodies are rejected', async () => {
  for (const body of [
    '{not json', {}, { booking_id: 'not-a-uuid' }, { booking_id: 7 }, [],
    { booking_id: BOOKING_ID }, { booking_id: BOOKING_ID, checkout_session: 'not-a-uuid' },
    { booking_id: BOOKING_ID, checkout_session: 7 },
  ]) {
    const net = preparedNet(CREATE);
    const res = await handleCreateOrder(request(body), deps(net));
    assertEquals(res.status, 400, `body ${JSON.stringify(body)}`);
    assertEquals(net.rpcCalls('payment_prepare_attempt').length, 0);
  }
  const net = preparedNet(CREATE);
  const res = await handleCreateOrder(request({ booking_id: BOOKING_ID, checkout_session: SESSION, pad: 'x'.repeat(5000) }), deps(net));
  assertEquals(res.status, 413);
});

Deno.test('without Razorpay credentials nothing is written and no provider call is made', async () => {
  const net = preparedNet(CREATE);
  const res = await handleCreateOrder(request(), deps(net, testConfig({ razorpay: null })));
  assertEquals(res.status, 503);
  assertEquals((await res.json()).error, 'payments_unavailable');
  assertEquals(net.rpcCalls('payment_prepare_attempt').length, 0);
  assertEquals(net.razorpayCalls().length, 0);
});

Deno.test('configuration refuses live keys and malformed keys unless explicitly allowed', () => {
  const env = (vars: Record<string, string>) => (k: string) => vars[k];
  assertEquals(readConfig(env({ RAZORPAY_KEY_ID: 'rzp_live_ABC', RAZORPAY_KEY_SECRET: 's' })).razorpay, null);
  assertEquals(readConfig(env({ RAZORPAY_KEY_ID: 'not-a-key', RAZORPAY_KEY_SECRET: 's' })).razorpay, null);
  assertEquals(readConfig(env({ RAZORPAY_KEY_ID: 'rzp_test_ABC' })).razorpay, null);
  assertEquals(readConfig(env({ RAZORPAY_KEY_ID: 'rzp_test_ABC', RAZORPAY_KEY_SECRET: 's' })).razorpay?.keyId, 'rzp_test_ABC');
  // any provider base other than the real API disables payments (a local
  // mock only in simulator mode, see config_test.ts)
  const valid = { RAZORPAY_KEY_ID: 'rzp_test_ABC', RAZORPAY_KEY_SECRET: 's' };
  for (const base of ['http://evil.example', 'http://127.0.0.1:9999']) {
    const c = readConfig(env({ ...valid, RAZORPAY_API_BASE: base }));
    assertEquals([c.razorpay, c.razorpayApiBase], [null, 'https://api.razorpay.com'], base);
  }
});

// ---------------------------------------------------------------
// ownership, eligibility, server-derived amount
// ---------------------------------------------------------------

Deno.test('the verified user id (not the body) is passed for the ownership check', async () => {
  const net = preparedNet({ action: 'not_found' });
  const res = await handleCreateOrder(request({ booking_id: BOOKING_ID, checkout_session: SESSION, user_id: '99999999-9999-4999-8999-999999999999' }), deps(net));
  assertEquals(res.status, 404);
  assertEquals(net.rpcCalls('payment_prepare_attempt')[0], { p_booking_id: BOOKING_ID, p_user_id: USER_ID });
  assertEquals(net.razorpayCalls().length, 0);
});

Deno.test('non-payable and free bookings get 409 without a provider call', async () => {
  for (const action of ['not_payable', 'free_booking']) {
    const net = preparedNet({ action });
    const res = await handleCreateOrder(request(), deps(net));
    assertEquals(res.status, 409);
    assertEquals(net.razorpayCalls().length, 0);
  }
});

Deno.test('order creation uses the database amount and currency, ignoring client-supplied values', async () => {
  const net = preparedNet(CREATE);
  net.razorpay = ({ method, path }) => {
    assertEquals([method, path], ['POST', '/v1/orders']);
    return { status: 200, body: ORDER() };
  };
  const res = await handleCreateOrder(
    request({ booking_id: BOOKING_ID, checkout_session: SESSION, amount: 1, amount_paise: 1, currency: 'USD', order_id: 'order_EVIL' }),
    deps(net),
  );
  assertEquals(res.status, 200);
  const sent = net.razorpayCalls()[0];
  assertEquals(sent.body, {
    amount: 50000,
    currency: 'INR',
    receipt: ATTEMPT_ID,
    notes: { attempt_id: ATTEMPT_ID, booking_id: BOOKING_ID },
  });
  assertEquals(sent.headers['authorization'], 'Basic ' + btoa(`${KEY_ID}:${KEY_SECRET}`));
  assertEquals(net.rpcCalls('payment_record_order')[0], {
    p_attempt_id: ATTEMPT_ID,
    p_provider_order_id: 'order_TESTORDER001',
    p_amount_paise: 50000,
    p_currency: 'INR',
    p_receipt: ATTEMPT_ID,
  });
});

Deno.test('the response carries only the safe checkout fields', async () => {
  const net = preparedNet(CREATE);
  net.razorpay = () => ({ status: 200, body: ORDER() });
  const d = deps(net);
  const res = await handleCreateOrder(request(), d);
  const text = await res.text();
  assertEquals(JSON.parse(text), {
    attempt_id: ATTEMPT_ID,
    order_id: 'order_TESTORDER001',
    amount_paise: 50000,
    currency: 'INR',
    key_id: KEY_ID,
    hold_seconds_remaining: 400,
  });
  secretsAbsent(text);
  secretsAbsent(d.sink.text());
});

Deno.test('a retried request re-uses the open order without a provider call', async () => {
  const net = preparedNet(REUSE);
  const res = await handleCreateOrder(request(), deps(net));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).order_id, 'order_TESTORDER001');
  assertEquals(net.razorpayCalls().length, 0);
});

Deno.test('a concurrent creation in progress answers 409 with Retry-After', async () => {
  const net = preparedNet({ action: 'in_progress', attempt_id: ATTEMPT_ID, retry_after_seconds: 42 });
  const res = await handleCreateOrder(request(), deps(net));
  assertEquals(res.status, 409);
  assertEquals(res.headers.get('retry-after'), '42');
  assertEquals(net.razorpayCalls().length, 0);
});

// ---------------------------------------------------------------
// ambiguous outcomes: never close, never re-create blindly
// ---------------------------------------------------------------

for (const [name, reply] of [
  ['a timeout', 'timeout'],
  ['a network error', 'network'],
  ['a provider 5xx', { status: 502, body: { error: {} } }],
  ['a rate limit', { status: 429, body: { error: {} } }],
  ['an unreadable success', { status: 200, body: undefined }],
] as const) {
  Deno.test(`${name} leaves the attempt recoverable (no close, no record, 503)`, async () => {
    const net = preparedNet(CREATE);
    net.razorpay = () => reply as never;
    const d = deps(net);
    const res = await handleCreateOrder(request(), d);
    assertEquals(res.status, 503);
    assertEquals(net.rpcCalls('payment_close_attempt').length, 0);
    assertEquals(net.rpcCalls('payment_record_order').length, 0);
    assertEquals(net.razorpayCalls().length, 1, 'exactly one creation attempt');
    assert(d.sink.text().includes('create_order.ambiguous'));
  });
}

Deno.test('recovery looks the order up by receipt and adopts it without creating another', async () => {
  const net = preparedNet(RECOVER);
  net.razorpay = ({ method, path }) => {
    assertEquals(method, 'GET', 'only a lookup is allowed');
    assert(path.startsWith('/v1/orders?') && path.includes(`receipt=${ATTEMPT_ID}`));
    return { status: 200, body: { entity: 'collection', count: 1, items: [ORDER()] } };
  };
  const res = await handleCreateOrder(request(), deps(net));
  assertEquals(res.status, 200);
  assertEquals(net.rpcCalls('payment_record_order').length, 1);
});

Deno.test('recovery creates with the SAME receipt only when no order exists', async () => {
  const net = preparedNet(RECOVER);
  net.razorpay = ({ method, body }) => {
    if (method === 'GET') return { status: 200, body: { entity: 'collection', count: 0, items: [] } };
    assertEquals((body as Record<string, unknown>).receipt, ATTEMPT_ID);
    return { status: 200, body: ORDER() };
  };
  const res = await handleCreateOrder(request(), deps(net));
  assertEquals(res.status, 200);
  assertEquals(net.razorpayCalls().map((c) => c.method), ['GET', 'POST']);
});

Deno.test('the receipt filter is matched exactly (the provider documents "contains")', async () => {
  const net = preparedNet(RECOVER);
  net.razorpay = ({ method }) => {
    if (method === 'GET') {
      return { status: 200, body: { items: [ORDER({ id: 'order_OTHER0001', receipt: `${ATTEMPT_ID}-x` })] } };
    }
    return { status: 400, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'Duplicate request. This request has already been processed.' } } };
  };
  const res = await handleCreateOrder(request(), deps(net));
  // the near-match is not adopted; the duplicate cannot be read -> ambiguous
  assertEquals(res.status, 503);
  assertEquals(net.rpcCalls('payment_record_order').length, 0);
});

Deno.test('a lookup failure during recovery is ambiguous, not a reason to create', async () => {
  const net = preparedNet(RECOVER);
  net.razorpay = () => 'timeout';
  const res = await handleCreateOrder(request(), deps(net));
  assertEquals(res.status, 503);
  assertEquals(net.razorpayCalls().length, 1);
  assertEquals(net.razorpayCalls()[0].method, 'GET');
});

Deno.test('a duplicate-receipt response is resolved by looking the order up', async () => {
  const net = preparedNet(CREATE);
  net.razorpay = ({ method }) =>
    method === 'POST'
      ? { status: 400, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'Duplicate request. This request has already been processed.' } } }
      : { status: 200, body: { items: [ORDER()] } };
  const res = await handleCreateOrder(request(), deps(net));
  assertEquals(res.status, 200);
  assertEquals(net.rpcCalls('payment_record_order').length, 1);
});

// ---------------------------------------------------------------
// definitive failures and validation of the provider response
// ---------------------------------------------------------------

for (const [what, order] of [
  ['amount', ORDER({ amount: 49999 })],
  ['currency', ORDER({ currency: 'USD' })],
  ['receipt', ORDER({ receipt: 'another-receipt' })],
  ['entity', ORDER({ entity: 'payment' })],
  ['order id', ORDER({ id: 'pay_NOTANORDER' })],
] as const) {
  Deno.test(`a provider response with a different ${what} is never recorded`, async () => {
    const net = preparedNet(CREATE);
    net.razorpay = () => ({ status: 200, body: order });
    const res = await handleCreateOrder(request(), deps(net));
    assertEquals(res.status, 502);
    assertEquals(net.rpcCalls('payment_record_order').length, 0);
    assertEquals(net.rpcCalls('payment_close_attempt')[0], { p_attempt_id: ATTEMPT_ID, p_reason: 'order_response_mismatch' });
  });
}

Deno.test('a definitive rejection closes the attempt so the next request starts fresh', async () => {
  const net = preparedNet(CREATE);
  net.razorpay = ({ method }) =>
    method === 'POST'
      ? { status: 400, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'The amount must be at least INR 1.00' } } }
      : { status: 200, body: { items: [] } };
  const res = await handleCreateOrder(request(), deps(net));
  assertEquals(res.status, 502);
  assertEquals(net.rpcCalls('payment_close_attempt')[0].p_reason, 'order_create_rejected');
});

Deno.test('a credential rejection closes the attempt without logging the credentials', async () => {
  const net = preparedNet(CREATE);
  net.razorpay = () => ({ status: 401, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } } });
  const d = deps(net);
  const res = await handleCreateOrder(request(), d);
  assertEquals(res.status, 502);
  assertEquals(net.rpcCalls('payment_close_attempt')[0].p_reason, 'provider_auth_failed');
  secretsAbsent(d.sink.text());
  secretsAbsent(await res.text());
});

Deno.test('a write-once conflict in the database is not handed to the client', async () => {
  const net = preparedNet(CREATE);
  net.rpc.payment_record_order = () => ({ status: 200, body: { outcome: 'conflict' } });
  net.razorpay = () => ({ status: 200, body: ORDER() });
  const res = await handleCreateOrder(request(), deps(net));
  assertEquals(res.status, 502);
  assert(!(await res.text()).includes('order_TESTORDER001'));
});

Deno.test('an attempt closed meanwhile yields 409 and no order', async () => {
  const net = preparedNet(CREATE);
  net.rpc.payment_record_order = () => ({ status: 200, body: { outcome: 'attempt_closed' } });
  net.razorpay = () => ({ status: 200, body: ORDER() });
  const res = await handleCreateOrder(request(), deps(net));
  assertEquals(res.status, 409);
});

Deno.test('a database failure while recording keeps the attempt recoverable', async () => {
  const net = preparedNet(CREATE);
  net.rpc.payment_record_order = () => ({ status: 503, body: { code: 'PGRST000' } });
  net.razorpay = () => ({ status: 200, body: ORDER() });
  const res = await handleCreateOrder(request(), deps(net));
  assertEquals(res.status, 503);
  assertEquals(net.rpcCalls('payment_close_attempt').length, 0);
});

Deno.test('a database failure in prepare is an internal error without a provider call', async () => {
  const net = new FakeNet();
  net.rpc.payment_prepare_attempt = () => ({ status: 500, body: { code: 'XX000' } });
  const res = await handleCreateOrder(request(), deps(net));
  assertEquals(res.status, 500);
  assertEquals(net.razorpayCalls().length, 0);
});

// ---------------------------------------------------------------
// payment window (slice 1b.1)
// ---------------------------------------------------------------

for (const reason of ['hold_expired', 'hold_too_short', 'booking_not_pending'] as const) {
  Deno.test(`an unpayable booking (${reason}) gets a machine-readable 409 and no provider call`, async () => {
    const net = preparedNet({ action: 'not_payable', reason, booking_status: 'pending_payment' });
    const res = await handleCreateOrder(request(), deps(net));
    assertEquals(res.status, 409);
    assertEquals(await res.json(), { error: 'booking_not_payable', reason });
    assertEquals(net.razorpayCalls().length, 0);
    assertEquals(net.rpcCalls('payment_record_order').length, 0);
  });
}

Deno.test('an unknown not-payable reason from the database is not passed through verbatim', async () => {
  const net = preparedNet({ action: 'not_payable', reason: 'something <internal>' });
  const res = await handleCreateOrder(request(), deps(net));
  assertEquals(await res.json(), { error: 'booking_not_payable', reason: 'booking_not_pending' });
});

Deno.test('a hold that ends while the provider call is in flight: order recorded, not handed out', async () => {
  const net = preparedNet(CREATE);
  net.rpc.payment_record_order = () => ({ status: 200, body: { outcome: 'booking_not_payable', reason: 'hold_expired' } });
  net.razorpay = () => ({ status: 200, body: ORDER() });
  const d = deps(net);
  const res = await handleCreateOrder(request(), d);
  assertEquals(res.status, 409);
  const text = await res.text();
  assertEquals(JSON.parse(text), { error: 'booking_not_payable', reason: 'hold_expired' });
  assert(!text.includes('order_TESTORDER001'), 'the order must not reach the client');
  // the order was recorded (durable) and nothing marked it as a provider failure
  assertEquals(net.rpcCalls('payment_record_order').length, 1);
  assertEquals(net.rpcCalls('payment_close_attempt').length, 0);
  assertEquals(net.razorpayCalls().length, 1, 'no second order is created');
});

Deno.test('a recovered order on a booking that expired meanwhile is not handed out either', async () => {
  const net = preparedNet(RECOVER);
  net.rpc.payment_record_order = () => ({ status: 200, body: { outcome: 'booking_not_payable', reason: 'hold_expired' } });
  net.razorpay = ({ method }) => {
    assertEquals(method, 'GET');
    return { status: 200, body: { items: [ORDER()] } };
  };
  const res = await handleCreateOrder(request(), deps(net));
  assertEquals(res.status, 409);
  assertEquals((await res.json()).reason, 'hold_expired');
  assertEquals(net.rpcCalls('payment_close_attempt').length, 0);
});

Deno.test('an attempt closed for another reason is reported as attempt_closed', async () => {
  const net = preparedNet(CREATE);
  net.rpc.payment_record_order = () => ({ status: 200, body: { outcome: 'attempt_closed' } });
  net.razorpay = () => ({ status: 200, body: ORDER() });
  const res = await handleCreateOrder(request(), deps(net));
  assertEquals(await res.json(), { error: 'booking_not_payable', reason: 'attempt_closed' });
});

Deno.test('the remaining hold (measured when the lease was granted) is passed through and never increased', async () => {
  const net = preparedNet(REUSE, GRANTED({ hold_seconds_remaining: 250 }));
  const body = await (await handleCreateOrder(request(), deps(net))).json();
  assert(body.hold_seconds_remaining <= 250 && body.hold_seconds_remaining >= 249);
});

Deno.test('a database without the field yields null, not an invented value', async () => {
  for (const hold of [undefined, 'soon', Number.NaN]) {
    const net = preparedNet(REUSE, GRANTED({ hold_seconds_remaining: hold }));
    const body = await (await handleCreateOrder(request(), deps(net))).json();
    assertEquals(body.hold_seconds_remaining, null);
  }
});

// ---------------------------------------------------------------
// Checkout lease (20261023190000)
// ---------------------------------------------------------------

Deno.test('lease: the order is handed out only with a lease, for the caller and the (lower-cased) session', async () => {
  const net = preparedNet(REUSE);
  const res = await handleCreateOrder(request({ booking_id: BOOKING_ID, checkout_session: SESSION }), deps(net));
  assertEquals(res.status, 200);
  assertEquals(net.rpcCalls('payment_acquire_checkout_lease'), [{
    p_booking_id: BOOKING_ID, p_user_id: USER_ID, p_attempt_id: ATTEMPT_ID, p_session: SESSION, p_no_payments_verified: false,
  }]);
  assertEquals(net.razorpayCalls().length, 0, 'a first grant needs no provider call');
});

Deno.test('lease: a freshly created order is also handed out only through the lease', async () => {
  const net = preparedNet(CREATE, { outcome: 'held', retry_after_seconds: 300 });
  net.razorpay = () => ({ status: 200, body: ORDER() });
  const res = await handleCreateOrder(request(), deps(net));
  assertEquals(res.status, 409);
  const text = await res.text();
  assertEquals(JSON.parse(text), { error: 'checkout_in_progress', retry_after_seconds: 300 });
  assert(!text.includes('order_TESTORDER001'), 'the order must not reach a second session');
});

Deno.test('lease: another session gets 409 checkout_in_progress without the order and without a provider call', async () => {
  const net = preparedNet(REUSE, { outcome: 'held', retry_after_seconds: 420 });
  const res = await handleCreateOrder(request(), deps(net));
  assertEquals(res.status, 409);
  const text = await res.text();
  assertEquals(JSON.parse(text).error, 'checkout_in_progress');
  assert(!text.includes('order_'));
  assertEquals(res.headers.get('retry-after'), null, 'not an automatic-retry answer');
  assertEquals(net.razorpayCalls().length, 0);
});

Deno.test('lease: the holding session again: handed out only when the provider lists no payment', async () => {
  const net = preparedNet(REUSE);
  let n = 0;
  net.rpc.payment_acquire_checkout_lease = (args) => {
    n++;
    return { status: 200, body: args.p_no_payments_verified ? GRANTED({ resumed: true }) : { outcome: 'verify_required', provider_order_id: 'order_TESTORDER001' } };
  };
  net.razorpay = ({ method, path }) => {
    assertEquals([method, path], ['GET', '/v1/orders/order_TESTORDER001/payments']);
    return { status: 200, body: { entity: 'collection', count: 0, items: [] } };
  };
  const res = await handleCreateOrder(request(), deps(net));
  assertEquals(res.status, 200);
  assertEquals(n, 2);
  assertEquals(net.rpcCalls('payment_acquire_checkout_lease').map((a) => a.p_no_payments_verified), [false, true]);
});

for (const [label, status] of [['a failed', 'failed'], ['an authorized', 'authorized'], ['a captured', 'captured']] as const) {
  Deno.test(`lease: ${label} payment on the order blocks a new Checkout session (409 payment_may_exist)`, async () => {
    const net = preparedNet(REUSE, { outcome: 'verify_required', provider_order_id: 'order_TESTORDER001' });
    net.razorpay = () => ({
      status: 200,
      body: { entity: 'collection', count: 1, items: [{ id: 'pay_EARLIER0001', entity: 'payment', status, order_id: 'order_TESTORDER001', amount: 50000, currency: 'INR' }] },
    });
    const res = await handleCreateOrder(request(), deps(net));
    assertEquals(res.status, 409);
    const text = await res.text();
    assertEquals(JSON.parse(text), { error: 'payment_may_exist', reason: 'payment_on_order' });
    assert(!text.includes('order_') && !text.includes('pay_'), 'no provider data reaches the client');
    assertEquals(net.rpcCalls('payment_acquire_checkout_lease').length, 1, 'never re-acquired as verified');
  });
}

Deno.test('lease: a provider failure or an incomplete list during the check is retryable, never a grant', async () => {
  for (const reply of ['timeout', { status: 500, body: {} }, { status: 200, body: { entity: 'collection', count: 2, items: [] } }] as const) {
    const net = preparedNet(REUSE, { outcome: 'verify_required', provider_order_id: 'order_TESTORDER001' });
    net.razorpay = () => reply as never;
    const res = await handleCreateOrder(request(), deps(net));
    assertEquals(res.status, 503);
    assert(!(await res.text()).includes('order_'));
    assertEquals(net.rpcCalls('payment_acquire_checkout_lease').length, 1);
  }
});

Deno.test('lease: an ended lease is never re-granted and never means "no payment"', async () => {
  const net = preparedNet(REUSE, { outcome: 'ended' });
  const res = await handleCreateOrder(request(), deps(net));
  assertEquals(res.status, 409);
  assertEquals(await res.json(), { error: 'payment_may_exist', reason: 'checkout_session_ended' });
  assertEquals(net.razorpayCalls().length, 0);
});

Deno.test('lease: a database failure while acquiring is retryable and hands nothing out', async () => {
  const net = preparedNet(REUSE);
  net.rpc.payment_acquire_checkout_lease = () => ({ status: 503, body: { code: 'PGRST000' } });
  const res = await handleCreateOrder(request(), deps(net));
  assertEquals(res.status, 503);
  assert(!(await res.text()).includes('order_'));
});

Deno.test('lease: the booking stopping being payable at the lease is a 409 with the reason', async () => {
  for (const [lease, reason] of [
    [{ outcome: 'not_payable', reason: 'hold_too_short' }, 'hold_too_short'],
    [{ outcome: 'not_payable', reason: 'hold_expired' }, 'hold_expired'],
    [{ outcome: 'attempt_not_open', state: 'closed' }, 'attempt_closed'],
  ] as const) {
    const net = preparedNet(REUSE, lease);
    const res = await handleCreateOrder(request(), deps(net));
    assertEquals(res.status, 409);
    assertEquals(await res.json(), { error: 'booking_not_payable', reason });
  }
});
