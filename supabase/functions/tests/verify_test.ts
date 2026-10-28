// Mocked tests for payments-verify. No real Razorpay call.

import { handleVerify } from '../_shared/verify.ts';
import {
  assert,
  assertEquals,
  BOOKING_ID,
  deps,
  FakeNet,
  secretsAbsent,
  testConfig,
  USER_ID,
  USER_TOKEN,
} from './helpers.ts';

const PAY = 'pay_VERIFY0001';
const ORDER_ID = 'order_VERIFY0001';
const ATTEMPT = '77777777-7777-4777-8777-777777777777';

function request(body: unknown = { booking_id: BOOKING_ID, razorpay_payment_id: PAY }, token: string | null = USER_TOKEN) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return new Request('http://edge.test/payments-verify', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const API_PAYMENT = (over: Record<string, unknown> = {}) => ({
  id: PAY,
  entity: 'payment',
  amount: 50000,
  currency: 'INR',
  status: 'captured',
  order_id: ORDER_ID,
  captured: true,
  amount_refunded: 0,
  created_at: 1700000000,
  ...over,
});

interface State {
  booking_status: string;
  fulfils: boolean;
  orders: unknown[];
  found: boolean;
}

// A stateful fake database: applying a captured payment fulfils the
// booking (as payment_apply_observation would for a valid hold).
function verifyNet(opts: { state?: Partial<State>; settlement?: string; fulfilOnCapture?: boolean } = {}) {
  const net = new FakeNet();
  const state: State = {
    booking_status: 'pending_payment',
    fulfils: false,
    orders: [{ attempt_id: ATTEMPT, provider_order_id: ORDER_ID, amount_paise: 50000, currency: 'INR', attempt_state: 'open' }],
    found: true,
    ...opts.state,
  };
  net.rpc.payment_booking_payment_context = () => ({
    status: 200,
    body: state.found
      ? { found: true, booking_status: state.booking_status, fulfilled: state.fulfils, payment_fulfils_booking: state.fulfils, orders: state.orders }
      : { found: false },
  });
  net.rpc.payment_apply_observation = (args) => {
    let settlement = opts.settlement ?? 'none';
    if (!opts.settlement && args.p_status === 'captured') {
      if (state.fulfils) settlement = 'already_fulfilled';
      else if (opts.fulfilOnCapture !== false) {
        state.fulfils = true;
        state.booking_status = 'confirmed';
        settlement = 'fulfilled';
      }
    }
    if (!opts.settlement && args.p_status !== 'captured') settlement = 'not_captured';
    return { status: 200, body: { payment_id: 'p', matched: true, observation: 'merged', settlement } };
  };
  net.razorpay = ({ method, path }) => {
    assertEquals([method, path], ['GET', `/v1/payments/${PAY}`]);
    return { status: 200, body: API_PAYMENT() };
  };
  return { net, state };
}

// ---------------------------------------------------------------
// authentication, input, ownership
// ---------------------------------------------------------------

Deno.test('verify: unauthenticated and forged tokens are rejected before any lookup', async () => {
  const { net } = verifyNet();
  assertEquals((await handleVerify(request(undefined, null), deps(net))).status, 401);
  assertEquals((await handleVerify(request(undefined, 'forged.jwt.token-0000000000000000000'), deps(net))).status, 401);
  assertEquals(net.rpcCalls('payment_booking_payment_context').length, 0);
  assertEquals(net.razorpayCalls().length, 0);
});

Deno.test('verify: a malformed booking id or payment id is rejected (the payment id itself is optional: recovery mode)', async () => {
  for (const body of [
    '{bad',
    {},
    { booking_id: 'nope', razorpay_payment_id: PAY },
    { booking_id: BOOKING_ID, razorpay_payment_id: 42 },
    { booking_id: BOOKING_ID, razorpay_payment_id: 'https://evil.example/x' },
    { booking_id: BOOKING_ID, razorpay_payment_id: 'pay_../../orders' },
  ]) {
    const { net } = verifyNet();
    assertEquals((await handleVerify(request(body), deps(net))).status, 400, JSON.stringify(body));
    assertEquals(net.razorpayCalls().length, 0);
  }
  const { net } = verifyNet();
  assertEquals((await handleVerify(request({ booking_id: BOOKING_ID, razorpay_payment_id: PAY, pad: 'x'.repeat(5000) }), deps(net))).status, 413);
});

Deno.test('verify: another user\'s booking is indistinguishable from a missing one, and nothing is fetched', async () => {
  const { net } = verifyNet({ state: { found: false } });
  const res = await handleVerify(request(), deps(net));
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: 'booking_not_found' });
  assertEquals(net.rpcCalls('payment_booking_payment_context')[0], {
    p_booking_id: BOOKING_ID,
    p_user_id: USER_ID,
    p_provider_payment_id: PAY,
  });
  assertEquals(net.razorpayCalls().length, 0);
  assertEquals(net.rpcCalls('payment_apply_observation').length, 0);
});

Deno.test('verify: a booking with no provider order cannot match any payment', async () => {
  const { net } = verifyNet({ state: { orders: [] } });
  const res = await handleVerify(request(), deps(net));
  assertEquals(res.status, 409);
  assertEquals(net.razorpayCalls().length, 0);
});

Deno.test('verify: without provider credentials nothing is looked up', async () => {
  const { net } = verifyNet();
  const res = await handleVerify(request(), deps(net, testConfig({ razorpay: null })));
  assertEquals(res.status, 503);
  assertEquals(net.calls.filter((c) => c.url.includes('/rest/v1/')).length, 0);
});

// ---------------------------------------------------------------
// the trusted path
// ---------------------------------------------------------------

Deno.test('verify: a legitimate captured payment confirms the booking through the single observation path', async () => {
  const { net } = verifyNet();
  const d = deps(net);
  const res = await handleVerify(request(), d);
  assertEquals(res.status, 200);
  const text = await res.text();
  assertEquals(JSON.parse(text), {
    booking_id: BOOKING_ID,
    booking_status: 'confirmed',
    payment_status: 'captured',
    provider_refund: 'none',
    result: 'confirmed',
  });
  const apply = net.rpcCalls('payment_apply_observation');
  assertEquals(apply.length, 1);
  assertEquals(apply[0].p_event_id, null);
  assertEquals([apply[0].p_provider_order_id, apply[0].p_amount_paise, apply[0].p_currency], [ORDER_ID, 50000, 'INR']);
  secretsAbsent(text);
  secretsAbsent(d.sink.text());
});

Deno.test('verify: browser claims (success flag, signature, amount, status, order) are never used as facts', async () => {
  const { net } = verifyNet();
  net.razorpay = () => ({ status: 200, body: API_PAYMENT({ status: 'authorized', captured: false }) });
  const res = await handleVerify(request({
    booking_id: BOOKING_ID,
    razorpay_payment_id: PAY,
    razorpay_order_id: 'order_FORGED',
    razorpay_signature: 'f'.repeat(64),
    status: 'captured',
    amount: 1,
    success: true,
  }), deps(net));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).result, 'payment_pending', 'the API says authorized');
  const apply = net.rpcCalls('payment_apply_observation')[0];
  assertEquals([apply.p_status, apply.p_amount_paise, apply.p_provider_order_id], ['authorized', 50000, ORDER_ID]);
});

Deno.test('verify: repeated calls are idempotent', async () => {
  const { net } = verifyNet();
  const first = await (await handleVerify(request(), deps(net))).json();
  const second = await (await handleVerify(request(), deps(net))).json();
  assertEquals(first, second);
  assertEquals(second.result, 'confirmed');
});

Deno.test('verify: a non-captured payment does not confirm', async () => {
  for (const [status, result] of [['authorized', 'payment_pending'], ['created', 'payment_pending'], ['failed', 'payment_failed']]) {
    const { net } = verifyNet();
    net.razorpay = () => ({ status: 200, body: API_PAYMENT({ status, captured: false }) });
    const res = await handleVerify(request(), deps(net));
    const body = await res.json();
    assertEquals([res.status, body.result, body.booking_status], [200, result, 'pending_payment'], status);
  }
});

Deno.test('verify: an expired booking or closed attempt is a late capture (not fulfilled)', async () => {
  for (const booking_status of ['expired', 'pending_payment']) {
    const { net } = verifyNet({ state: { booking_status }, settlement: 'late_capture' });
    const res = await handleVerify(request(), deps(net));
    const body = await res.json();
    assertEquals([res.status, body.result, body.booking_status], [200, 'not_fulfilled', booking_status]);
  }
});

// ---------------------------------------------------------------
// identity: fail closed, never attach
// ---------------------------------------------------------------

Deno.test('verify: a payment of another order is not applied (fail closed)', async () => {
  for (const order_id of ['order_SOMEONEELSE', null]) {
    const { net } = verifyNet();
    net.razorpay = () => ({ status: 200, body: API_PAYMENT({ order_id }) });
    const res = await handleVerify(request(), deps(net));
    assertEquals(res.status, 409);
    assertEquals((await res.json()).error, 'payment_not_for_booking');
    assertEquals(net.rpcCalls('payment_apply_observation').length, 0, 'nothing attached');
  }
});

Deno.test('verify: a payment whose amount or currency differs from the attempt is not applied', async () => {
  for (const over of [{ amount: 49999 }, { amount: 50001 }, { currency: 'USD' }]) {
    const { net } = verifyNet();
    net.razorpay = () => ({ status: 200, body: API_PAYMENT(over) });
    const res = await handleVerify(request(), deps(net));
    assertEquals(res.status, 409, JSON.stringify(over));
    assertEquals((await res.json()).error, 'payment_mismatch');
    assertEquals(net.rpcCalls('payment_apply_observation').length, 0);
  }
});

Deno.test('verify: a provider response for a different payment id is rejected', async () => {
  const { net } = verifyNet();
  net.razorpay = () => ({ status: 200, body: API_PAYMENT({ id: 'pay_OTHER0001' }) });
  const res = await handleVerify(request(), deps(net));
  assertEquals(res.status, 502);
  assertEquals(net.rpcCalls('payment_apply_observation').length, 0);
});

Deno.test('verify: unknown, other-order and order-less payments get one identical answer', async () => {
  const bodies: unknown[] = [];
  for (const provider of [
    () => ({ status: 400, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' } } }),
    () => ({ status: 200, body: API_PAYMENT({ order_id: 'order_SOMEONEELSE' }) }),
    () => ({ status: 200, body: API_PAYMENT({ order_id: null }) }),
  ]) {
    const { net } = verifyNet();
    net.razorpay = provider as never;
    const d = deps(net);
    const res = await handleVerify(request(), d);
    assertEquals(res.status, 409);
    bodies.push(await res.json());
    assertEquals(net.rpcCalls('payment_apply_observation').length, 0);
    // the internal log still tells them apart
    assert(/unknown_to_provider|other_order|no_order/.test(d.sink.text()));
  }
  assertEquals(bodies[0], { error: 'payment_not_for_booking' });
  assertEquals(bodies[1], bodies[0]);
  assertEquals(bodies[2], bodies[0]);
});

// ---------------------------------------------------------------
// provider_refund: provider facts, never inferred
// ---------------------------------------------------------------

Deno.test('verify: provider_refund reports the fetched refund facts', async () => {
  const cases: [Record<string, unknown>, string, Partial<{ settlement: string; fulfils: boolean }>, string][] = [
    // captured, nothing refunded, not consumed: unresolved money
    [{}, 'none', { settlement: 'late_capture' }, 'not_fulfilled'],
    // partly refunded before settlement
    [{ amount_refunded: 10000 }, 'partial', { settlement: 'refunded_before_settlement' }, 'not_fulfilled'],
    // fully refunded (status refunded)
    [{ status: 'refunded', amount_refunded: 50000 }, 'full', { settlement: 'refunded_before_settlement' }, 'not_fulfilled'],
    // fulfilled earlier, refunded afterwards: confirmed AND full
    [{ status: 'refunded', amount_refunded: 50000 }, 'full', { settlement: 'already_fulfilled', fulfils: true }, 'confirmed'],
  ];
  for (const [over, refund, opts, result] of cases) {
    const { net } = verifyNet({
      settlement: opts.settlement,
      state: opts.fulfils ? { fulfils: true, booking_status: 'confirmed' } : {},
    });
    net.razorpay = () => ({ status: 200, body: API_PAYMENT(over) });
    const body = await (await handleVerify(request(), deps(net))).json();
    assertEquals([body.provider_refund, body.result], [refund, result], JSON.stringify(over));
  }
});

Deno.test('verify: a non-captured payment reports provider_refund none', async () => {
  const { net } = verifyNet();
  net.razorpay = () => ({ status: 200, body: API_PAYMENT({ status: 'authorized', captured: false }) });
  const body = await (await handleVerify(request(), deps(net))).json();
  assertEquals([body.result, body.provider_refund], ['payment_pending', 'none']);
});

Deno.test('verify: the response carries exactly the five contract fields', async () => {
  const { net } = verifyNet();
  const body = await (await handleVerify(request(), deps(net))).json();
  assertEquals(Object.keys(body).sort(), ['booking_id', 'booking_status', 'payment_status', 'provider_refund', 'result']);
});

Deno.test('verify: a conflicting observation (already decided elsewhere) does not confirm', async () => {
  const { net } = verifyNet({ settlement: 'duplicate_capture', state: { booking_status: 'confirmed' } });
  const body = await (await handleVerify(request(), deps(net))).json();
  assertEquals([body.result, body.booking_status], ['not_fulfilled', 'confirmed']);
});

// ---------------------------------------------------------------
// retryable failures
// ---------------------------------------------------------------

for (const [name, reply] of [
  ['timeout', 'timeout'],
  ['rate limit', { status: 429, body: { error: {} } }],
  ['5xx', { status: 502, body: { error: {} } }],
] as const) {
  Deno.test(`verify: a provider ${name} answers 503 with Retry-After and applies nothing`, async () => {
    const { net } = verifyNet();
    net.razorpay = () => reply as never;
    const res = await handleVerify(request(), deps(net));
    assertEquals(res.status, 503);
    assert(res.headers.get('retry-after') !== null);
    assertEquals(net.rpcCalls('payment_apply_observation').length, 0);
  });
}

Deno.test('verify: a transient database failure (including the association race) is retryable', async () => {
  for (const code of ['40001', '40P01', 'PGRST001']) {
    const { net } = verifyNet();
    net.rpc.payment_apply_observation = () => ({ status: 503, body: { code } });
    const res = await handleVerify(request(), deps(net));
    assertEquals(res.status, 503, code);
  }
  const { net } = verifyNet();
  net.rpc.payment_booking_payment_context = () => 'network';
  assertEquals((await handleVerify(request(), deps(net))).status, 503);
});

Deno.test('verify: a deterministic database rejection is not reported as retryable', async () => {
  const { net } = verifyNet();
  net.rpc.payment_apply_observation = () => ({ status: 400, body: { code: '23514' } });
  const res = await handleVerify(request(), deps(net));
  assertEquals(res.status, 502);
  assertEquals((await res.json()).error, 'verification_failed');
});
