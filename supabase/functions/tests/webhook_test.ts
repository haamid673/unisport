// Mocked tests for payments-webhook. No real Razorpay call.

import { hmacSha256Hex, timingSafeEqual, verifyWebhookSignature } from '../_shared/signature.ts';
import { MAX_WEBHOOK_BODY, handleWebhook } from '../_shared/webhook.ts';
import { assert, assertEquals, deps, FakeNet, secretsAbsent, testConfig, WEBHOOK_SECRET } from './helpers.ts';

const EVENT_ID = 'evt_TEST0001';
const LOCAL_EVENT = '44444444-4444-4444-8444-444444444444';

const enc = new TextEncoder();

function capturedBody(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    entity: 'event',
    event: 'payment.captured',
    created_at: 1700000000,
    payload: {
      payment: {
        entity: {
          id: 'pay_TEST0001',
          entity: 'payment',
          order_id: 'order_TEST0001',
          status: 'captured',
          // what the WEBHOOK claims; the handler must use the API instead
          amount: 1,
          currency: 'INR',
          email: 'customer@example.com',
          contact: '+919999999999',
          ...over,
        },
      },
    },
  });
}

async function signed(raw: string, secret = WEBHOOK_SECRET, headers: Record<string, string> = {}) {
  const sig = await hmacSha256Hex(secret, enc.encode(raw));
  return new Request('http://edge.test/payments-webhook', {
    method: 'POST',
    headers: { 'x-razorpay-signature': sig, 'x-razorpay-event-id': EVENT_ID, ...headers },
    body: raw,
  });
}

const API_PAYMENT = (over: Record<string, unknown> = {}) => ({
  id: 'pay_TEST0001',
  entity: 'payment',
  amount: 50000,
  currency: 'INR',
  status: 'captured',
  order_id: 'order_TEST0001',
  captured: true,
  amount_refunded: 0,
  refund_status: null,
  created_at: 1700000000,
  error_code: null,
  error_description: null,
  ...over,
});

function readyNet(opts: { processed?: boolean } = {}) {
  const net = new FakeNet();
  net.rpc.payment_ingest_event = () => ({
    status: 200,
    body: { event_id: LOCAL_EVENT, inserted: !opts.processed, processed: opts.processed === true },
  });
  net.rpc.payment_mark_event = () => ({ status: 200, body: { outcome: 'ignored' } });
  net.rpc.payment_apply_observation = () => ({
    status: 200,
    body: { payment_id: '55555555-5555-4555-8555-555555555555', matched: true, observation: 'inserted', settlement: 'fulfilled' },
  });
  net.razorpay = ({ method, path }) => {
    assertEquals([method, path], ['GET', '/v1/payments/pay_TEST0001']);
    return { status: 200, body: API_PAYMENT() };
  };
  return net;
}

// ---------------------------------------------------------------
// signature
// ---------------------------------------------------------------

Deno.test('signature helper: constant-time comparison semantics', () => {
  assert(timingSafeEqual('abc', 'abc'));
  assert(!timingSafeEqual('abc', 'abd'));
  assert(!timingSafeEqual('abc', 'abcd'));
});

Deno.test('signature is verified over the exact raw bytes', async () => {
  const raw = capturedBody();
  const sig = await hmacSha256Hex(WEBHOOK_SECRET, enc.encode(raw));
  assert(await verifyWebhookSignature(enc.encode(raw), sig, [WEBHOOK_SECRET]));
  // semantically identical JSON with different bytes does not verify
  const reserialised = JSON.stringify(JSON.parse(raw), null, 1);
  assert(!(await verifyWebhookSignature(enc.encode(reserialised), sig, [WEBHOOK_SECRET])));
  assert(!(await verifyWebhookSignature(enc.encode(raw + ' '), sig, [WEBHOOK_SECRET])));
  assert(!(await verifyWebhookSignature(enc.encode(raw), sig, ['another-secret'])));
  assert(!(await verifyWebhookSignature(enc.encode(raw), 'not-hex', [WEBHOOK_SECRET])));
  assert(!(await verifyWebhookSignature(enc.encode(raw), null, [WEBHOOK_SECRET])));
});

Deno.test('a missing or invalid signature is rejected before anything is stored', async () => {
  const net = readyNet();
  const raw = capturedBody();
  const noSig = new Request('http://edge.test/w', { method: 'POST', headers: { 'x-razorpay-event-id': EVENT_ID }, body: raw });
  assertEquals((await handleWebhook(noSig, deps(net))).status, 401);
  assertEquals((await handleWebhook(await signed(raw, 'wrong-secret'), deps(net))).status, 401);
  // a signature computed over different bytes
  const req = await signed(raw);
  const tampered = new Request('http://edge.test/w', {
    method: 'POST',
    headers: req.headers,
    body: raw.replace('"amount":1', '"amount":2'),
  });
  assertEquals((await handleWebhook(tampered, deps(net))).status, 401);
  assertEquals(net.calls.length, 0);
});

Deno.test('the previous secret is accepted during a rotation', async () => {
  const net = readyNet();
  const res = await handleWebhook(
    await signed(capturedBody(), 'old-secret'),
    deps(net, testConfig({ webhookSecrets: [WEBHOOK_SECRET, 'old-secret'] })),
  );
  assertEquals(res.status, 200);
});

Deno.test('without a configured webhook secret every request is refused (503)', async () => {
  const net = readyNet();
  const res = await handleWebhook(await signed(capturedBody()), deps(net, testConfig({ webhookSecrets: [] })));
  assertEquals(res.status, 503);
  assertEquals(net.calls.length, 0);
});

// ---------------------------------------------------------------
// malformed and oversized requests
// ---------------------------------------------------------------

Deno.test('oversized bodies are refused (declared and streamed)', async () => {
  const net = readyNet();
  const big = 'x'.repeat(MAX_WEBHOOK_BODY + 1);
  const declared = new Request('http://edge.test/w', {
    method: 'POST',
    headers: { 'content-length': String(big.length) },
    body: big,
  });
  assertEquals((await handleWebhook(declared, deps(net))).status, 413);
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(big));
      c.close();
    },
  });
  const streamed = new Request('http://edge.test/w', { method: 'POST', body: stream });
  assertEquals((await handleWebhook(streamed, deps(net))).status, 413);
  assertEquals(net.calls.length, 0);
});

Deno.test('a signed but malformed body or a missing event id is a 400', async () => {
  const net = readyNet();
  assertEquals((await handleWebhook(await signed('{not json'), deps(net))).status, 400);
  assertEquals((await handleWebhook(await signed(JSON.stringify({ event: 7 })), deps(net))).status, 400);
  assertEquals((await handleWebhook(await signed(capturedBody(), WEBHOOK_SECRET, { 'x-razorpay-event-id': '' }), deps(net))).status, 400);
  assertEquals((await handleWebhook(await signed(capturedBody(), WEBHOOK_SECRET, { 'x-razorpay-event-id': 'bad id!' }), deps(net))).status, 400);
  assertEquals(net.calls.length, 0);
  const get = new Request('http://edge.test/w', { method: 'GET' });
  assertEquals((await handleWebhook(get, deps(net))).status, 405);
});

// ---------------------------------------------------------------
// ingestion, dedupe, trusted facts
// ---------------------------------------------------------------

Deno.test('the stored payload is minimised (no customer contact data, no raw body)', async () => {
  const net = readyNet();
  await handleWebhook(await signed(capturedBody()), deps(net));
  const ingest = net.rpcCalls('payment_ingest_event')[0];
  assertEquals(ingest.p_provider_event_id, EVENT_ID);
  assertEquals(ingest.p_event_type, 'payment.captured');
  const stored = JSON.stringify(ingest.p_payload);
  assert(!stored.includes('customer@example.com') && !stored.includes('+919999999999'), 'contact data stored');
});

Deno.test('a duplicate delivery of a processed event does no work', async () => {
  const net = readyNet({ processed: true });
  const res = await handleWebhook(await signed(capturedBody()), deps(net));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).status, 'duplicate');
  assertEquals(net.razorpayCalls().length, 0);
  assertEquals(net.rpcCalls('payment_apply_observation').length, 0);
});

Deno.test('payment facts come from the provider API, never from the webhook body', async () => {
  const net = readyNet();
  net.razorpay = () => ({ status: 200, body: API_PAYMENT({ status: 'authorized', captured: false }) });
  const res = await handleWebhook(await signed(capturedBody()), deps(net));
  assertEquals(res.status, 200);
  const args = net.rpcCalls('payment_apply_observation')[0];
  assertEquals(args.p_event_id, LOCAL_EVENT);
  assertEquals(args.p_status, 'authorized', 'the webhook said captured; the API says authorized');
  assertEquals(args.p_amount_paise, 50000, 'the webhook said 1; the API says 50000');
  assertEquals(args.p_provider_order_id, 'order_TEST0001');
});

Deno.test('event types this slice does not act on are recorded as ignored', async () => {
  const net = readyNet();
  const raw = JSON.stringify({ event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_X' } } } });
  const res = await handleWebhook(await signed(raw), deps(net));
  assertEquals(res.status, 200);
  assertEquals(net.rpcCalls('payment_mark_event')[0].p_result, 'ignored_event_type');
  assertEquals(net.razorpayCalls().length, 0);
});

Deno.test('a failed provider fetch is recorded and answered 503 for redelivery', async () => {
  const net = readyNet();
  net.razorpay = () => 'timeout';
  const res = await handleWebhook(await signed(capturedBody()), deps(net));
  assertEquals(res.status, 503);
  const mark = net.rpcCalls('payment_mark_event')[0];
  assertEquals(mark.p_result, 'fetch_failed');
  assert(typeof mark.p_error === 'string');
  assertEquals(net.rpcCalls('payment_apply_observation').length, 0);
});

Deno.test('a provider response for another payment id is never applied and is durably classified', async () => {
  const net = readyNet();
  net.razorpay = () => ({ status: 200, body: API_PAYMENT({ id: 'pay_SOMEONEELSE' }) });
  const res = await handleWebhook(await signed(capturedBody()), deps(net));
  // deterministic: retrying cannot change it -> recorded as processed, 200
  assertEquals(res.status, 200);
  const mark = net.rpcCalls('payment_mark_event')[0];
  assertEquals([mark.p_result, mark.p_error], ['invalid_provider_response', null]);
  assertEquals(net.rpcCalls('payment_apply_observation').length, 0);
});

Deno.test('a payment unknown to our API key is recorded and not retried', async () => {
  const net = readyNet();
  net.razorpay = () => ({ status: 400, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' } } });
  const res = await handleWebhook(await signed(capturedBody()), deps(net));
  assertEquals(res.status, 200);
  assertEquals(net.rpcCalls('payment_mark_event')[0].p_result, 'provider_payment_not_found');
});

Deno.test('a database failure while applying is recorded and answered 503', async () => {
  const net = readyNet();
  net.rpc.payment_apply_observation = () => ({ status: 500, body: { code: 'XX000' } });
  const res = await handleWebhook(await signed(capturedBody()), deps(net));
  assertEquals(res.status, 503);
  assertEquals(net.rpcCalls('payment_mark_event')[0].p_result, 'apply_failed');
});

Deno.test('without Razorpay credentials a payment event is recorded as not processed (503)', async () => {
  const net = readyNet();
  const res = await handleWebhook(await signed(capturedBody()), deps(net, testConfig({ razorpay: null })));
  assertEquals(res.status, 503);
  assertEquals(net.rpcCalls('payment_mark_event')[0].p_result, 'not_configured');
});

Deno.test('an unmatched (unknown order) payment is applied as-is; no refund is requested', async () => {
  const net = readyNet();
  net.rpc.payment_apply_observation = () => ({
    status: 200,
    body: { payment_id: '66666666-6666-4666-8666-666666666666', matched: false, observation: 'inserted', unmatched_reason: 'unknown_order', settlement: 'none' },
  });
  const res = await handleWebhook(await signed(capturedBody()), deps(net));
  assertEquals(res.status, 200);
  // nothing but the inbox, the fetch and the observation happened
  assertEquals(
    net.calls.map((c) => new URL(c.url).pathname),
    ['/rest/v1/rpc/payment_ingest_event', '/v1/payments/pay_TEST0001', '/rest/v1/rpc/payment_apply_observation'],
  );
});

Deno.test('logs never contain the body, the signature or a secret', async () => {
  const net = readyNet();
  const d = deps(net);
  const req = await signed(capturedBody());
  const sig = req.headers.get('x-razorpay-signature')!;
  await handleWebhook(req, d);
  const logs = d.sink.text();
  secretsAbsent(logs);
  assert(!logs.includes(sig), 'signature logged');
  assert(!logs.includes('customer@example.com'), 'body logged');
});

// ---------------------------------------------------------------
// failure classification (slice 1b.2)
// ---------------------------------------------------------------

for (const [name, reply] of [
  ['a provider timeout', 'timeout'],
  ['a provider rate limit', { status: 429, body: { error: { code: 'TOO_MANY_REQUESTS' } } }],
  ['a provider 5xx', { status: 503, body: { error: {} } }],
  ['an unreadable provider body', { status: 200, body: undefined }],
  ['a credential problem', { status: 401, body: { error: {} } }],
] as const) {
  Deno.test(`webhook: ${name} is transient: recorded, NOT processed, 503`, async () => {
    const net = readyNet();
    net.razorpay = () => reply as never;
    const res = await handleWebhook(await signed(capturedBody()), deps(net));
    assertEquals(res.status, 503);
    const mark = net.rpcCalls('payment_mark_event')[0];
    assertEquals(mark.p_result, 'fetch_failed');
    assert(typeof mark.p_error === 'string', 'a failure (p_error) keeps the event unprocessed');
    assertEquals(net.rpcCalls('payment_apply_observation').length, 0);
  });
}

Deno.test('webhook: a provider 400 rejection is deterministic: durably classified, 200', async () => {
  const net = readyNet();
  net.razorpay = () => ({ status: 400, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'invalid request' } } });
  const res = await handleWebhook(await signed(capturedBody()), deps(net));
  assertEquals(res.status, 200);
  const mark = net.rpcCalls('payment_mark_event')[0];
  assertEquals([mark.p_result, mark.p_error], ['provider_rejected_request', null]);
});

for (const [name, code, status] of [
  ['the concurrent-association race (40001)', '40001', 500],
  ['a deadlock (40P01)', '40P01', 500],
  ['a lock timeout (55P03)', '55P03', 500],
  ['an unknown error', 'XX000', 500],
  ['a PostgREST connection error', 'PGRST001', 503],
] as const) {
  Deno.test(`webhook: ${name} while applying is transient: event left unprocessed, 503`, async () => {
    const net = readyNet();
    net.rpc.payment_apply_observation = () => ({ status, body: { code } });
    const res = await handleWebhook(await signed(capturedBody()), deps(net));
    assertEquals(res.status, 503);
    const mark = net.rpcCalls('payment_mark_event')[0];
    assertEquals(mark.p_result, 'apply_failed');
    assert(typeof mark.p_error === 'string' && mark.p_error.includes(code));
  });
}

Deno.test('webhook: a network failure while applying is transient', async () => {
  const net = readyNet();
  net.rpc.payment_apply_observation = () => 'network';
  const res = await handleWebhook(await signed(capturedBody()), deps(net));
  assertEquals(res.status, 503);
});

for (const code of ['23514', '22023'] as const) {
  Deno.test(`webhook: a deterministic database rejection (${code}) is durably classified and acknowledged`, async () => {
    const net = readyNet();
    net.rpc.payment_apply_observation = () => ({ status: 400, body: { code } });
    const res = await handleWebhook(await signed(capturedBody()), deps(net));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).status, 'rejected');
    const mark = net.rpcCalls('payment_mark_event')[0];
    assertEquals([mark.p_result, mark.p_error], [`apply_rejected:${code}`, null]);
  });
}

Deno.test('webhook: a deterministic outcome that cannot be recorded is NOT acknowledged', async () => {
  const net = readyNet();
  net.rpc.payment_apply_observation = () => ({ status: 400, body: { code: '23514' } });
  net.rpc.payment_mark_event = () => ({ status: 503, body: { code: 'PGRST001' } });
  const res = await handleWebhook(await signed(capturedBody()), deps(net));
  assertEquals(res.status, 503);
});

Deno.test('webhook: an ignored event whose classification cannot be recorded is NOT acknowledged', async () => {
  const net = readyNet();
  net.rpc.payment_mark_event = () => 'network';
  const raw = JSON.stringify({ event: 'refund.created', payload: { refund: { entity: { id: 'rfnd_X' } } } });
  const res = await handleWebhook(await signed(raw), deps(net));
  assertEquals(res.status, 503);
});

Deno.test('webhook: nothing is acknowledged before the inbox write succeeds', async () => {
  const transient = readyNet();
  transient.rpc.payment_ingest_event = () => ({ status: 503, body: { code: 'PGRST001' } });
  assertEquals((await handleWebhook(await signed(capturedBody()), deps(transient))).status, 503);
  assertEquals(transient.razorpayCalls().length, 0);
  const rejected = readyNet();
  rejected.rpc.payment_ingest_event = () => ({ status: 400, body: { code: '22023' } });
  assertEquals((await handleWebhook(await signed(capturedBody()), deps(rejected))).status, 400);
  assertEquals(rejected.razorpayCalls().length, 0);
});

Deno.test('webhook: a stored but unprocessed event is reprocessed on redelivery', async () => {
  const net = readyNet();
  // the inbox already holds the event from a failed first delivery
  net.rpc.payment_ingest_event = () => ({ status: 200, body: { event_id: LOCAL_EVENT, inserted: false, processed: false } });
  const res = await handleWebhook(await signed(capturedBody()), deps(net));
  assertEquals(res.status, 200);
  assertEquals(net.razorpayCalls().length, 1);
  assertEquals(net.rpcCalls('payment_apply_observation')[0].p_event_id, LOCAL_EVENT);
});

for (const event of ['refund.created', 'refund.processed', 'refund.failed', 'payment.dispute.created']) {
  Deno.test(`webhook: ${event} never reaches observation or settlement, even with an embedded payment`, async () => {
    const net = readyNet();
    const raw = JSON.stringify({
      event,
      payload: {
        refund: { entity: { id: 'rfnd_TEST0001', payment_id: 'pay_TEST0001', amount: 50000 } },
        payment: { entity: { id: 'pay_TEST0001', order_id: 'order_TEST0001', status: 'captured', amount: 50000 } },
      },
    });
    const res = await handleWebhook(await signed(raw), deps(net));
    assertEquals(res.status, 200);
    assertEquals(net.rpcCalls('payment_mark_event')[0].p_result, 'ignored_event_type');
    assertEquals(net.razorpayCalls().length, 0);
    assertEquals(net.rpcCalls('payment_apply_observation').length, 0);
  });
}

// ---------------------------------------------------------------
// event validation and payment-id classification (hardening)
// ---------------------------------------------------------------

Deno.test('webhook: an event type longer than the inbox limit (100) is refused before storage', async () => {
  const net = readyNet();
  const longType = 'a'.repeat(50) + '.' + 'b'.repeat(50); // 101 characters, pattern-valid
  const res = await handleWebhook(await signed(JSON.stringify({ event: longType })), deps(net));
  assertEquals(res.status, 400);
  assertEquals(net.calls.length, 0);
  const atLimit = 'a'.repeat(49) + '.' + 'b'.repeat(50); // exactly 100
  const ok = await handleWebhook(await signed(JSON.stringify({ event: atLimit })), deps(net));
  assertEquals(ok.status, 200);
  assertEquals(net.rpcCalls('payment_ingest_event')[0].p_event_type, atLimit);
});

for (const [name, entity, result] of [
  ['an unrecognisable payment id', { id: 'not-a-payment-id', order_id: 'order_TEST0001', status: 'captured' }, 'unrecognised_payment_id'],
  ['an overlong payment id', { id: 'pay_' + 'A'.repeat(60), status: 'captured' }, 'unrecognised_payment_id'],
  ['no payment id', { order_id: 'order_TEST0001', status: 'captured' }, 'missing_payment_id'],
  ['no payment entity', null, 'missing_payment_id'],
] as const) {
  Deno.test(`webhook: a payment event with ${name} is durably classified as ${result}, not as an ignored event type`, async () => {
    const net = readyNet();
    const raw = JSON.stringify({ event: 'payment.captured', payload: entity ? { payment: { entity } } : {} });
    const res = await handleWebhook(await signed(raw), deps(net));
    assertEquals(res.status, 200);
    const mark = net.rpcCalls('payment_mark_event')[0];
    assertEquals([mark.p_result, mark.p_error], [result, null]);
    assertEquals(net.razorpayCalls().length, 0);
    assertEquals(net.rpcCalls('payment_apply_observation').length, 0);
  });
}

Deno.test('webhook: an unusable payment event whose classification cannot be recorded is NOT acknowledged', async () => {
  const net = readyNet();
  net.rpc.payment_mark_event = () => ({ status: 503, body: { code: 'PGRST001' } });
  const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'bogus' } } } });
  assertEquals((await handleWebhook(await signed(raw), deps(net))).status, 503);
});

Deno.test('webhook: the stored audit payload is bounded printable text whatever the signed body holds', async () => {
  const net = readyNet();
  const raw = JSON.stringify({
    event: 'payment.captured',
    created_at: 1700000000,
    payload: {
      payment: {
        entity: {
          id: 'pay_TEST0001',
          order_id: 'order_TEST0001\u0000\u001b[31m' + 'x'.repeat(500),
          status: 'captured\u0000',
          amount: 50000,
          currency: 'INR',
        },
      },
    },
  });
  const res = await handleWebhook(await signed(raw), deps(net));
  assertEquals(res.status, 200);
  const stored = net.rpcCalls('payment_ingest_event')[0].p_payload as Record<string, Record<string, string>>;
  assertEquals(stored.payment.status, 'captured');
  assert(stored.payment.order_id.length <= 64 && !/[^\x20-\x7E]/.test(stored.payment.order_id));
});
