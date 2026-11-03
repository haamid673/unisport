// Mocked tests for payments-verify RECOVERY mode ({ booking_id } only).
// No real Razorpay call.

import { sha256Hex } from '../_shared/signature.ts';
import { handleVerify, MAX_OTHER_PAYMENTS, MAX_PROVIDER_CALLS, MAX_RECOVERY_ORDERS } from '../_shared/verify.ts';
import { assert, assertEquals, BOOKING_ID, deps, FakeNet, USER_ID, USER_TOKEN } from './helpers.ts';

interface Order {
  provider_order_id: string;
  amount_paise: number;
  currency: string;
}

const SESSION = '44444444-4444-4444-8444-444444444444';
const OTHER_SESSION = '55555555-5555-4555-8555-555555555555';

function request(body: unknown = { booking_id: BOOKING_ID }) {
  return new Request('http://edge.test/payments-verify', {
    method: 'POST',
    headers: { Authorization: `Bearer ${USER_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const payment = (id: string, order: string, over: Record<string, unknown> = {}) => ({
  id,
  entity: 'payment',
  amount: 50000,
  currency: 'INR',
  status: 'captured',
  order_id: order,
  captured: true,
  amount_refunded: 0,
  created_at: 1700000000,
  ...over,
});

// A stateful fake: applying a captured payment fulfils the booking if it
// is still unfulfilled and `fulfilOnCapture` holds (as settlement would
// for a valid hold); a second captured payment is then a duplicate.
function recoveryNet(opts: {
  orders?: Order[];
  lists?: Record<string, { items: unknown[]; count?: number } | 'timeout' | 'error500'>;
  payments?: Record<string, unknown>;
  found?: boolean;
  fulfilOnCapture?: boolean;
  bookingStatus?: string;
  // already fulfilled before this request (payment id, its order)
  fulfilled?: { id: string; order: string };
  // the open attempt's Checkout lease as the database reports it:
  // { state, hash }, null (no open attempt), or 'missing' (an old database)
  lease?: { state: 'none' | 'active' | 'ended'; hash: string | null } | null | 'missing';
} = {}) {
  const net = new FakeNet();
  const state = {
    fulfilledBy: (opts.fulfilled?.id ?? null) as string | null,
    fulfilledOrder: (opts.fulfilled?.order ?? null) as string | null,
    bookingStatus: opts.bookingStatus ?? (opts.fulfilled ? 'confirmed' : 'pending_payment'),
    // write-once settlement labels, as payment_settle_locked stores them
    decisions: {} as Record<string, string>,
  };
  if (opts.fulfilled) state.decisions[opts.fulfilled.id] = 'fulfilled';
  const orders = opts.orders ?? [{ provider_order_id: 'order_A', amount_paise: 50000, currency: 'INR' }];
  net.rpc.payment_booking_payment_context = (args) => {
    if (opts.found === false) return { status: 200, body: { found: false } };
    const lease = opts.lease === undefined ? { state: 'none' } : opts.lease;
    return {
      status: 200,
      body: {
        found: true,
        ...(lease === 'missing' ? {} : { checkout_lease: lease }),
        payment_decision: args.p_provider_payment_id ? state.decisions[args.p_provider_payment_id as string] ?? null : null,
        booking_status: state.bookingStatus,
        fulfilled: state.fulfilledBy !== null,
        payment_fulfils_booking: args.p_provider_payment_id !== null && args.p_provider_payment_id === state.fulfilledBy,
        fulfilling_payment: state.fulfilledBy === null
          ? null
          : { provider_payment_id: state.fulfilledBy, provider_order_id: state.fulfilledOrder },
        orders: orders.map((o, i) => ({ attempt_id: `att${i}`, attempt_state: 'open', ...o })),
      },
    };
  };
  net.rpc.payment_apply_observation = (args) => {
    let settlement = 'none';
    if (args.p_status === 'captured') {
      if (state.fulfilledBy === null && opts.fulfilOnCapture !== false) {
        state.fulfilledBy = args.p_provider_payment_id as string;
        state.fulfilledOrder = args.p_provider_order_id as string;
        state.bookingStatus = 'confirmed';
        settlement = 'fulfilled';
      } else {
        settlement = state.fulfilledBy === args.p_provider_payment_id ? 'already_fulfilled' : 'late_capture';
      }
      // the first decision is kept: observing a payment again never relabels it
      const label = settlement === 'late_capture' && state.fulfilledBy !== null ? 'duplicate_capture' : settlement;
      if (['fulfilled', 'late_capture', 'duplicate_capture'].includes(label)) {
        state.decisions[args.p_provider_payment_id as string] ??= label;
      }
    }
    return { status: 200, body: { matched: true, observation: 'merged', settlement } };
  };
  net.razorpay = ({ method, path }) => {
    assertEquals(method, 'GET');
    const list = /^\/v1\/orders\/(order_[A-Za-z0-9]+)\/payments$/.exec(path);
    if (list) {
      const entry = opts.lists?.[list[1]] ?? { items: [] };
      if (entry === 'timeout') return 'timeout';
      if (entry === 'error500') return { status: 500, body: { error: {} } };
      return { status: 200, body: { entity: 'collection', count: entry.count ?? entry.items.length, items: entry.items } };
    }
    const one = /^\/v1\/payments\/(pay_[A-Za-z0-9]+)$/.exec(path);
    if (one && opts.payments?.[one[1]]) return { status: 200, body: opts.payments[one[1]] };
    throw new Error(`unexpected provider path ${path}`);
  };
  return { net, state };
}

const listCalls = (net: FakeNet) => net.razorpayCalls().filter((c) => c.url.includes('/payments') && c.url.includes('/orders/'));

// ---------------------------------------------------------------

Deno.test('recovery 1: a captured payment found by booking confirms it, with its id', async () => {
  const { net } = recoveryNet({ lists: { order_A: { items: [payment('pay_A1', 'order_A')] } } });
  const res = await handleVerify(request(), deps(net));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    booking_id: BOOKING_ID,
    booking_status: 'confirmed',
    mode: 'recovery',
    complete: true,
    result: 'confirmed',
    razorpay_payment_id: 'pay_A1',
    payment_status: 'captured',
    provider_refund: 'none',
    other_payments: [],
    checkout_lease: 'none',
  });
  assertEquals(net.rpcCalls('payment_booking_payment_context')[0], { p_booking_id: BOOKING_ID, p_user_id: USER_ID, p_provider_payment_id: null });
  assertEquals(net.rpcCalls('payment_apply_observation')[0].p_event_id, null);
  assertEquals(listCalls(net).length, 1);
});

Deno.test('recovery 2: an authorized payment is pending', async () => {
  const { net } = recoveryNet({ lists: { order_A: { items: [payment('pay_A1', 'order_A', { status: 'authorized', captured: false })] } } });
  const body = await (await handleVerify(request(), deps(net))).json();
  assertEquals([body.result, body.razorpay_payment_id, body.complete], ['payment_pending', 'pay_A1', true]);
});

Deno.test('recovery 3: a late capture is not a confirmation', async () => {
  const { net } = recoveryNet({ fulfilOnCapture: false, bookingStatus: 'expired', lists: { order_A: { items: [payment('pay_A1', 'order_A')] } } });
  const body = await (await handleVerify(request(), deps(net))).json();
  assertEquals([body.result, body.booking_status, body.provider_refund], ['not_fulfilled', 'expired', 'none']);
});

Deno.test('recovery 4: with a duplicate capture the fulfilling payment is reported as confirmed, never replaced', async () => {
  const { net, state } = recoveryNet({
    lists: { order_A: { items: [payment('pay_A1', 'order_A'), payment('pay_A2', 'order_A')] } },
  });
  const body = await (await handleVerify(request(), deps(net))).json();
  assertEquals(state.fulfilledBy, 'pay_A1');
  assertEquals([body.result, body.razorpay_payment_id], ['confirmed', 'pay_A1']);
  assertEquals(net.rpcCalls('payment_apply_observation').map((a) => a.p_provider_payment_id), ['pay_A1', 'pay_A2']);
});

Deno.test('recovery 4b: a duplicate alone (booking fulfilled by a payment not listed) is not_fulfilled', async () => {
  const { net, state } = recoveryNet({ lists: { order_A: { items: [payment('pay_A2', 'order_A')] } } });
  state.fulfilledBy = 'pay_ELSEWHERE';
  state.bookingStatus = 'confirmed';
  const body = await (await handleVerify(request(), deps(net))).json();
  assertEquals([body.result, body.booking_status], ['not_fulfilled', 'confirmed']);
});

for (const [name, entry] of [['timeout', 'timeout'], ['5xx', 'error500']] as const) {
  Deno.test(`recovery 5: a provider ${name} is retryable and never means "no payment"`, async () => {
    const { net } = recoveryNet({ lists: { order_A: entry } });
    const res = await handleVerify(request(), deps(net));
    assertEquals(res.status, 503);
    assertEquals((await res.json()).error, 'payment_provider_unavailable');
    assertEquals(net.rpcCalls('payment_apply_observation').length, 0);
  });
}

Deno.test('recovery 6a: a possibly truncated list with nothing usable is incomplete, not "no payment"', async () => {
  // count says more exist than were returned
  const { net } = recoveryNet({ lists: { order_A: { items: [], count: 3 } } });
  const res = await handleVerify(request(), deps(net));
  assertEquals(res.status, 503);
  assertEquals((await res.json()).error, 'recovery_incomplete');
});

Deno.test('recovery 6b: a full page (10 items) is treated as possibly truncated', async () => {
  const items = Array.from({ length: 10 }, (_, i) => payment(`pay_F${i}`, 'order_A', { status: 'failed', captured: false }));
  const { net } = recoveryNet({ lists: { order_A: { items } } });
  const body = await (await handleVerify(request(), deps(net))).json();
  assertEquals([body.result, body.complete], ['payment_failed', false]);
});

Deno.test('recovery 6c: list items without a usable entity are fetched individually, within the call bound', async () => {
  const bare = (id: string) => ({ id, status: 'captured', order_id: 'order_A', amount: 50000, currency: 'INR' }); // no entity
  const ids = Array.from({ length: MAX_PROVIDER_CALLS + 2 }, (_, i) => `pay_B${i}`);
  const payments = Object.fromEntries(ids.map((id) => [id, payment(id, 'order_A', { status: 'failed', captured: false })]));
  const { net } = recoveryNet({ lists: { order_A: { items: ids.map(bare) } }, payments });
  const body = await (await handleVerify(request(), deps(net))).json();
  assert(net.razorpayCalls().length <= MAX_PROVIDER_CALLS, `provider calls ${net.razorpayCalls().length}`);
  assertEquals(body.complete, false, 'items beyond the bound make the answer incomplete');
});

Deno.test('recovery 7: another user\'s booking: 404, no provider call', async () => {
  const { net } = recoveryNet({ found: false });
  const res = await handleVerify(request(), deps(net));
  assertEquals(res.status, 404);
  assertEquals(net.razorpayCalls().length, 0);
});

Deno.test('recovery 8: a listed payment with the wrong order or amount is never applied, and blocks "no payment found"', async () => {
  for (const bad of [payment('pay_W1', 'order_OTHER'), payment('pay_W2', 'order_A', { amount: 49999 }), payment('pay_W3', 'order_A', { currency: 'USD' })]) {
    const { net } = recoveryNet({ lists: { order_A: { items: [bad] } } });
    const res = await handleVerify(request(), deps(net));
    assertEquals(net.rpcCalls('payment_apply_observation').length, 0, JSON.stringify(bad));
    assertEquals(res.status, 503, 'a conflicting payment exists: never "no payment found"');
    assertEquals((await res.json()).error, 'recovery_incomplete');
  }
});

Deno.test('recovery 9: several trusted orders are inspected, newest first', async () => {
  const { net } = recoveryNet({
    orders: [
      { provider_order_id: 'order_OLD', amount_paise: 50000, currency: 'INR' },
      { provider_order_id: 'order_NEW', amount_paise: 50000, currency: 'INR' },
    ],
    lists: {
      order_OLD: { items: [payment('pay_OLD1', 'order_OLD')] },
      order_NEW: { items: [payment('pay_NEW1', 'order_NEW', { status: 'failed', captured: false })] },
    },
  });
  const body = await (await handleVerify(request(), deps(net))).json();
  assertEquals(listCalls(net).map((c) => new URL(c.url).pathname), ['/v1/orders/order_NEW/payments', '/v1/orders/order_OLD/payments']);
  assertEquals([body.result, body.razorpay_payment_id, body.complete], ['confirmed', 'pay_OLD1', true]);
});

Deno.test('recovery 9b: more orders than the bound are reported as incomplete', async () => {
  const orders = Array.from({ length: MAX_RECOVERY_ORDERS + 1 }, (_, i) => ({ provider_order_id: `order_N${i}`, amount_paise: 50000, currency: 'INR' }));
  const { net } = recoveryNet({ orders, lists: { [`order_N${MAX_RECOVERY_ORDERS}`]: { items: [payment('pay_P1', `order_N${MAX_RECOVERY_ORDERS}`, { status: 'authorized', captured: false })] } } });
  const body = await (await handleVerify(request(), deps(net))).json();
  assertEquals(listCalls(net).length, MAX_RECOVERY_ORDERS);
  assertEquals([body.result, body.complete], ['payment_pending', false]);
});

Deno.test('recovery 15: a booking fulfilled by a payment of an OLDER order (outside the bound) reports that payment', async () => {
  const orders = Array.from({ length: MAX_RECOVERY_ORDERS + 1 }, (_, i) => ({ provider_order_id: `order_N${i}`, amount_paise: 50000, currency: 'INR' }));
  const newest = `order_N${MAX_RECOVERY_ORDERS}`;
  const { net } = recoveryNet({
    orders,
    fulfilled: { id: 'pay_OLD1', order: 'order_N0' },
    lists: { [newest]: { items: [payment('pay_F1', newest, { status: 'failed', captured: false })] } },
    payments: { pay_OLD1: payment('pay_OLD1', 'order_N0') },
  });
  const body = await (await handleVerify(request(), deps(net))).json();
  assertEquals(
    [body.result, body.razorpay_payment_id, body.booking_status, body.payment_status],
    ['confirmed', 'pay_OLD1', 'confirmed', 'captured'],
    'never "only failed payments" for a fulfilled booking',
  );
  assertEquals(body.complete, false, 'older orders were not all listed');
  assert(net.razorpayCalls().some((c) => c.url.endsWith('/v1/payments/pay_OLD1')), 'the fulfilling payment is fetched');
  assert(net.razorpayCalls().length <= MAX_PROVIDER_CALLS);
});

Deno.test('recovery 15b: a fulfilling payment already in the listing is not fetched again', async () => {
  const { net } = recoveryNet({
    fulfilled: { id: 'pay_A1', order: 'order_A' },
    lists: { order_A: { items: [payment('pay_A1', 'order_A')] } },
  });
  const body = await (await handleVerify(request(), deps(net))).json();
  assertEquals([body.result, body.razorpay_payment_id, body.complete], ['confirmed', 'pay_A1', true]);
  assertEquals(net.razorpayCalls().length, 1);
});

Deno.test('recovery 15c: when the fulfilling payment cannot be fetched the answer is retryable', async () => {
  const { net } = recoveryNet({
    fulfilled: { id: 'pay_OLD1', order: 'order_A' },
    lists: { order_A: { items: [] } },
  });
  net.razorpay = ({ path }) => path.startsWith('/v1/payments/') ? 'timeout' : { status: 200, body: { entity: 'collection', count: 0, items: [] } };
  const res = await handleVerify(request(), deps(net));
  assertEquals(res.status, 503);
});

Deno.test('recovery 10: repeated recovery is idempotent', async () => {
  const { net } = recoveryNet({ lists: { order_A: { items: [payment('pay_A1', 'order_A')] } } });
  const first = await (await handleVerify(request(), deps(net))).json();
  const second = await (await handleVerify(request(), deps(net))).json();
  assertEquals(first, second);
});

Deno.test('recovery: no order ever created means no payment can exist (complete, no provider call)', async () => {
  const { net } = recoveryNet({ orders: [] });
  const body = await (await handleVerify(request(), deps(net))).json();
  assertEquals([body.result, body.complete, body.razorpay_payment_id], ['no_payment_found', true, null]);
  assertEquals(net.razorpayCalls().length, 0);
});

Deno.test('recovery: an empty, complete list is "no payment found"', async () => {
  const { net } = recoveryNet({ lists: { order_A: { items: [] } } });
  const body = await (await handleVerify(request(), deps(net))).json();
  assertEquals([body.result, body.complete], ['no_payment_found', true]);
});

Deno.test('recovery 14: the explicit-payment-id request still returns the original five-field contract', async () => {
  const { net } = recoveryNet({ payments: { pay_A1: payment('pay_A1', 'order_A') } });
  const res = await handleVerify(request({ booking_id: BOOKING_ID, razorpay_payment_id: 'pay_A1' }), deps(net));
  const body = await res.json();
  assertEquals(Object.keys(body).sort(), ['booking_id', 'booking_status', 'payment_status', 'provider_refund', 'result']);
  assertEquals(body.result, 'confirmed');
  assertEquals(listCalls(net).length, 0);
});

// ---------------------------------------------------------------
// additional / non-fulfilling captures
// ---------------------------------------------------------------

Deno.test('recovery 16: a confirmed booking with an additional captured payment reports both, pointer unchanged', async () => {
  const { net, state } = recoveryNet({
    lists: { order_A: { items: [payment('pay_A1', 'order_A'), payment('pay_A2', 'order_A')] } },
  });
  const body = await (await handleVerify(request(), deps(net))).json();
  assertEquals([body.result, body.razorpay_payment_id, body.booking_status, body.complete], ['confirmed', 'pay_A1', 'confirmed', true]);
  assertEquals(body.other_payments, [{
    razorpay_payment_id: 'pay_A2',
    payment_status: 'captured',
    provider_refund: 'none',
    result: 'not_fulfilled',
    decision: 'duplicate_capture',
  }]);
  assertEquals(state.fulfilledBy, 'pay_A1', 'the fulfilment pointer is untouched');
  // each payment went through the single observation path, once
  assertEquals(net.rpcCalls('payment_apply_observation').map((a) => a.p_provider_payment_id), ['pay_A1', 'pay_A2']);
});

Deno.test('recovery 16b: the same after a reload: still reported, idempotent, decisions not relabelled', async () => {
  const { net, state } = recoveryNet({
    lists: { order_A: { items: [payment('pay_A1', 'order_A'), payment('pay_A2', 'order_A')] } },
  });
  const first = await (await handleVerify(request(), deps(net))).json();
  const second = await (await handleVerify(request(), deps(net))).json();
  assertEquals(first, second);
  assertEquals(state.decisions, { pay_A1: 'fulfilled', pay_A2: 'duplicate_capture' });
});

Deno.test('recovery 16c: a refund reported by the provider is a provider fact, never an invented completed refund', async () => {
  const { net } = recoveryNet({
    lists: {
      order_A: {
        items: [
          payment('pay_A1', 'order_A'),
          payment('pay_A2', 'order_A', { amount_refunded: 20000 }),
          payment('pay_A3', 'order_A', { status: 'refunded', amount_refunded: 50000 }),
        ],
      },
    },
  });
  const body = await (await handleVerify(request(), deps(net))).json();
  assertEquals(
    body.other_payments.map((o: Record<string, unknown>) => [o.razorpay_payment_id, o.payment_status, o.provider_refund, o.result]),
    [['pay_A2', 'captured', 'partial', 'not_fulfilled'], ['pay_A3', 'refunded', 'full', 'not_fulfilled']],
  );
  assert(!JSON.stringify(body).includes('refund_completed'));
});

Deno.test('recovery 16d: other payments are reported most significant first, with pending and failed ones too', async () => {
  const { net } = recoveryNet({
    lists: {
      order_A: {
        items: [
          payment('pay_A9', 'order_A', { status: 'failed', captured: false }),
          payment('pay_A1', 'order_A'),
          payment('pay_A5', 'order_A', { status: 'authorized', captured: false }),
          payment('pay_A2', 'order_A'),
        ],
      },
    },
  });
  const body = await (await handleVerify(request(), deps(net))).json();
  assertEquals(
    body.other_payments.map((o: Record<string, unknown>) => [o.razorpay_payment_id, o.result, o.decision]),
    [['pay_A2', 'not_fulfilled', 'duplicate_capture'], ['pay_A5', 'payment_pending', null], ['pay_A9', 'payment_failed', null]],
  );
});

Deno.test('recovery 16e: payments on several orders are all reported', async () => {
  const orders = [
    { provider_order_id: 'order_A', amount_paise: 50000, currency: 'INR' },
    { provider_order_id: 'order_B', amount_paise: 50000, currency: 'INR' },
  ];
  const { net } = recoveryNet({
    orders,
    lists: { order_A: { items: [payment('pay_A1', 'order_A')] }, order_B: { items: [payment('pay_B1', 'order_B')] } },
  });
  const body = await (await handleVerify(request(), deps(net))).json();
  const ids = [body.razorpay_payment_id, ...body.other_payments.map((o: Record<string, unknown>) => o.razorpay_payment_id)].sort();
  assertEquals(ids, ['pay_A1', 'pay_B1']);
});

Deno.test('recovery 16f: an incomplete list never claims there are no additional payments', async () => {
  // 10 items = a possibly cut-short page: the confirmed payment is reported, complete is false
  const items = Array.from({ length: 10 }, (_, i) => payment(i === 0 ? 'pay_A1' : `pay_X${i}`, 'order_A', i === 0 ? {} : { status: 'failed', captured: false }));
  const { net } = recoveryNet({ lists: { order_A: { items } } });
  const body = await (await handleVerify(request(), deps(net))).json();
  assertEquals([body.result, body.complete, body.other_payments.length], ['confirmed', false, 9]);
});

Deno.test('recovery 16g: a confirmed booking whose older orders were not listed is incomplete, not "no other payments"', async () => {
  const orders = Array.from({ length: MAX_RECOVERY_ORDERS + 1 }, (_, i) => ({ provider_order_id: `order_N${i}`, amount_paise: 50000, currency: 'INR' }));
  const newest = `order_N${MAX_RECOVERY_ORDERS}`;
  const { net } = recoveryNet({ orders, lists: { [newest]: { items: [payment('pay_N9', newest)] } } });
  const body = await (await handleVerify(request(), deps(net))).json();
  assertEquals([body.result, body.complete, body.other_payments], ['confirmed', false, []]);
});

Deno.test('recovery 16h: more other payments than the report bound make the answer incomplete', async () => {
  const items = [payment('pay_A0', 'order_A'), ...Array.from({ length: MAX_OTHER_PAYMENTS + 1 }, (_, i) => payment(`pay_Z${i}`, 'order_A', { status: 'failed', captured: false }))];
  // a long list is also over the provider's page size, which is incomplete as well; both must hold
  const { net } = recoveryNet({ lists: { order_A: { items } } });
  const body = await (await handleVerify(request(), deps(net))).json();
  assertEquals(body.complete, false);
  assertEquals(body.other_payments.length, MAX_OTHER_PAYMENTS);
});

Deno.test('recovery 16i: an unreadable payment makes the answer incomplete and is not reported as a payment', async () => {
  const { net } = recoveryNet({
    lists: { order_A: { items: [payment('pay_A1', 'order_A'), { id: 'pay_A2', entity: 'payment', status: 'weird' }] } },
    payments: { pay_A2: { id: 'pay_A2', entity: 'payment', status: 'weird' } },
  });
  const body = await (await handleVerify(request(), deps(net))).json();
  assertEquals([body.result, body.complete, body.other_payments], ['confirmed', false, []]);
});

Deno.test('recovery 16j: the response carries only the contracted fields (no provider payload)', async () => {
  const { net } = recoveryNet({ lists: { order_A: { items: [payment('pay_A1', 'order_A'), payment('pay_A2', 'order_A', { email: 'a@b.c', card: { last4: '1111' } })] } } });
  const text = await (await handleVerify(request(), deps(net))).text();
  assert(!text.includes('a@b.c') && !text.includes('1111') && !text.includes('order_A'));
  const body = JSON.parse(text);
  assertEquals(Object.keys(body).sort(), [
    'booking_id', 'booking_status', 'checkout_lease', 'complete', 'mode', 'other_payments',
    'payment_status', 'provider_refund', 'razorpay_payment_id', 'result',
  ]);
  assertEquals(Object.keys(body.other_payments[0]).sort(), ['decision', 'payment_status', 'provider_refund', 'razorpay_payment_id', 'result']);
});

// ---------------------------------------------------------------
// Checkout lease as seen by recovery
// ---------------------------------------------------------------

const withSession = (session: unknown) => request({ booking_id: BOOKING_ID, checkout_session: session });

Deno.test('recovery 17: no_payment_found while ANOTHER session holds the lease says so (and still no payment)', async () => {
  const { net } = recoveryNet({ lease: { state: 'active', hash: await sha256Hex(OTHER_SESSION) } });
  const body = await (await handleVerify(withSession(SESSION), deps(net))).json();
  assertEquals([body.result, body.complete, body.checkout_lease], ['no_payment_found', true, 'other']);
  assertEquals(body.razorpay_payment_id, null, 'no payment is inferred from the lease');
});

Deno.test('recovery 17b: the caller\'s own session is recognised (by SHA-256, case-insensitively)', async () => {
  const { net } = recoveryNet({ lease: { state: 'active', hash: await sha256Hex(SESSION) } });
  for (const s of [SESSION, SESSION.toUpperCase()]) {
    const body = await (await handleVerify(withSession(s), deps(net))).json();
    assertEquals(body.checkout_lease, 'yours');
  }
});

Deno.test('recovery 17c: without a session id an active lease is "other" (conservative)', async () => {
  const { net } = recoveryNet({ lease: { state: 'active', hash: await sha256Hex(SESSION) } });
  assertEquals((await (await handleVerify(request(), deps(net))).json()).checkout_lease, 'other');
});

Deno.test('recovery 17d: a lease held by nobody (an order handed out before leases existed) is "other"', async () => {
  const { net } = recoveryNet({ lease: { state: 'active', hash: null } });
  assertEquals((await (await handleVerify(withSession(SESSION), deps(net))).json()).checkout_lease, 'other');
});

Deno.test('recovery 17e: an ended lease is "ended", never "none"', async () => {
  const { net } = recoveryNet({ lease: { state: 'ended', hash: await sha256Hex(SESSION) } });
  const body = await (await handleVerify(withSession(SESSION), deps(net))).json();
  assertEquals([body.result, body.checkout_lease], ['no_payment_found', 'ended']);
});

Deno.test('recovery 17f: nothing handed out (never leased, or no open attempt) is "none"', async () => {
  for (const lease of [{ state: 'none' as const, hash: null }, null]) {
    const { net } = recoveryNet({ lease });
    assertEquals((await (await handleVerify(withSession(SESSION), deps(net))).json()).checkout_lease, 'none');
  }
});

Deno.test('recovery 17g: a database that does not report the lease fails closed ("other")', async () => {
  const { net } = recoveryNet({ lease: 'missing' });
  assertEquals((await (await handleVerify(withSession(SESSION), deps(net))).json()).checkout_lease, 'other');
});

Deno.test('recovery 17h: a malformed checkout_session is a 400, before any database or provider call', async () => {
  for (const bad of ['nope', 7, {}, ['x']]) {
    const { net } = recoveryNet();
    const res = await handleVerify(withSession(bad), deps(net));
    assertEquals(res.status, 400);
    assertEquals(net.calls.filter((c) => !c.url.includes('/auth/v1/')).length, 0);
  }
});

Deno.test('recovery 17i: the session id and its hash never appear in the response or the log', async () => {
  const { net } = recoveryNet({ lease: { state: 'active', hash: await sha256Hex(SESSION) } });
  const d = deps(net);
  const text = await (await handleVerify(withSession(SESSION), d)).text();
  const hash = await sha256Hex(SESSION);
  for (const hay of [text, d.sink.text()]) assert(!hay.includes(SESSION) && !hay.includes(hash));
});

Deno.test('recovery 17j: the lease is reported with every kind of result', async () => {
  const { net } = recoveryNet({
    lease: { state: 'active', hash: await sha256Hex(OTHER_SESSION) },
    lists: { order_A: { items: [payment('pay_A1', 'order_A', { status: 'authorized', captured: false })] } },
  });
  const body = await (await handleVerify(withSession(SESSION), deps(net))).json();
  assertEquals([body.result, body.checkout_lease], ['payment_pending', 'other']);
});

Deno.test('explicit verification: logs the stored decision and keeps the five-field contract', async () => {
  const { net } = recoveryNet({ payments: { pay_A1: payment('pay_A1', 'order_A') } });
  const d = deps(net);
  const body = await (await handleVerify(request({ booking_id: BOOKING_ID, razorpay_payment_id: 'pay_A1' }), d)).json();
  assertEquals(Object.keys(body).sort(), ['booking_id', 'booking_status', 'payment_status', 'provider_refund', 'result']);
  const done = d.sink.text().split('\n').find((l) => l.includes('verify.done')) ?? '';
  assert(/"decision":\s*"fulfilled"/.test(done), `verify.done log: ${done}`);
});
