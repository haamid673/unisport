// Configuration guard: Razorpay API pinning and the local simulator
// mode. Pure: no network, no environment access. Every value here is
// an obvious dummy.

import {
  type PaymentConfig,
  RAZORPAY_API,
  readConfig,
  SIMULATOR_API_ORIGINS,
  SIMULATOR_KEY_ID,
  SIMULATOR_KEY_SECRET,
} from '../_shared/config.ts';
import { createRazorpayClient } from '../_shared/razorpay.ts';
import { assert, assertEquals } from './helpers.ts';

const env = (vars: Record<string, string | undefined>) => (k: string) => vars[k];

const DUMMY_KEY_ID = 'rzp_test_DUMMYKEY0001';
const DUMMY_SECRET = 'dummy-key-secret-not-real';

// A real-mode (Razorpay test keys) environment that is valid.
const REAL = {
  SUPABASE_URL: 'http://kong:8000',
  SUPABASE_SERVICE_ROLE_KEY: 'dummy-service-role',
  SUPABASE_ANON_KEY: 'dummy-anon',
  RAZORPAY_KEY_ID: DUMMY_KEY_ID,
  RAZORPAY_KEY_SECRET: DUMMY_SECRET,
  RAZORPAY_WEBHOOK_SECRET: 'dummy-webhook-secret',
};

// A simulator environment that satisfies every condition (the control
// case: each refusal test below changes exactly one variable of it).
const SIM = {
  ...REAL,
  PAYMENT_SIMULATOR: 'local-only',
  RAZORPAY_API_BASE: 'http://host.docker.internal:59480',
  RAZORPAY_KEY_ID: SIMULATOR_KEY_ID,
  RAZORPAY_KEY_SECRET: SIMULATOR_KEY_SECRET,
};

function isSimulator(c: PaymentConfig): boolean {
  return c.simulator === true && c.razorpay?.keyId === SIMULATOR_KEY_ID &&
    c.razorpay.keySecret === SIMULATOR_KEY_SECRET && SIMULATOR_API_ORIGINS.includes(c.razorpayApiBase);
}

// Fail closed: no credentials (so no provider call can be made), never
// simulator, and the base left at the real API rather than anything given.
function isDisabled(c: PaymentConfig): boolean {
  return c.razorpay === null && c.simulator === false && c.razorpayApiBase === RAZORPAY_API;
}

function assertDisabled(vars: Record<string, string | undefined>, label: string) {
  const c = readConfig(env(vars));
  assert(isDisabled(c), `expected payments disabled: ${label}`);
}

// ---------------------------------------------------------------
// simulator mode
// ---------------------------------------------------------------

Deno.test('simulator: disabled by default (no flag), real mode unchanged', () => {
  const c = readConfig(env(REAL));
  assertEquals([c.simulator, c.razorpay?.keyId, c.razorpayApiBase], [false, DUMMY_KEY_ID, RAZORPAY_API]);
  const empty = readConfig(env({}));
  assertEquals([empty.simulator, empty.razorpay], [false, null]);
});

Deno.test('simulator: the complete local configuration enables it, with placeholder credentials only', () => {
  const c = readConfig(env(SIM));
  assert(isSimulator(c), 'control case must enable the simulator');
  assertEquals(c.razorpayApiBase, 'http://host.docker.internal:59480');
  // the other fields are read as usual
  assertEquals([c.supabaseUrl, c.webhookSecrets], ['http://kong:8000', ['dummy-webhook-secret']]);
  // the secret may be omitted: the placeholder is used either way
  assert(isSimulator(readConfig(env({ ...SIM, RAZORPAY_KEY_SECRET: undefined }))), 'secret omitted');
});

Deno.test('simulator: every documented local Supabase URL and simulator origin is accepted', () => {
  for (const url of ['http://kong:8000', 'http://kong:8000/', 'http://127.0.0.1:59401', 'http://localhost:54321', 'http://127.0.0.1:65535']) {
    assert(isSimulator(readConfig(env({ ...SIM, SUPABASE_URL: url }))), `supabase ${url}`);
  }
  for (const origin of [...SIMULATOR_API_ORIGINS, 'http://host.docker.internal:59480/']) {
    const c = readConfig(env({ ...SIM, RAZORPAY_API_BASE: origin }));
    assert(isSimulator(c), `api ${origin}`);
    assertEquals(c.razorpayApiBase, origin.replace(/\/$/, ''));
  }
});

Deno.test('simulator: only the exact flag enables it; any other value disables payments entirely', () => {
  for (const flag of ['true', '1', 'yes', 'on', 'LOCAL-ONLY', 'Local-Only', ' local-only', 'local-only ', 'local-only\n', 'localonly', 'local_only', 'local', 'simulator']) {
    assertDisabled({ ...SIM, PAYMENT_SIMULATOR: flag }, `flag ${JSON.stringify(flag)}`);
    // not a silent fall-back to real mode either
    assertDisabled({ ...REAL, PAYMENT_SIMULATOR: flag }, `real env + flag ${JSON.stringify(flag)}`);
  }
  // an empty value is the same as unset: real mode
  const c = readConfig(env({ ...REAL, PAYMENT_SIMULATOR: '' }));
  assertEquals([c.simulator, c.razorpay?.keyId], [false, DUMMY_KEY_ID]);
  // and without the flag the simulator configuration is not a simulator
  assertDisabled({ ...SIM, PAYMENT_SIMULATOR: undefined }, 'no flag');
});

Deno.test('simulator: refused with a hosted, remote or non-allow-listed Supabase URL', () => {
  for (const url of [
    'https://abcdefghijklmnopqrst.supabase.co',
    'http://abcdefghijklmnopqrst.supabase.co',
    'https://127.0.0.1:59401',
    'https://kong:8000',
    'http://kong:8001',
    'http://kong',
    'http://api.supabase.internal:8000',
    'http://127.0.0.1',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
    'http://127.0.0.1.evil.example:59401',
    'http://localhost.evil.example:59401',
    'http://kong:8000.evil.example',
    'http://kong:8000@evil.example',
    'http://kong:8000:80',
    'http://127.0.0.1:59401:1',
    'http://user:pw@127.0.0.1:59401',
    'http://127.0.0.1:59401/rest/v1',
    'http://127.0.0.1:59401?x=1',
    'http://127.0.0.1:59401#x',
    'http://10.0.0.5:59401',
    'http://192.168.1.10:54321',
    'http://172.17.0.1:8000',
    'http://[::1]:59401',
    'http://host.docker.internal:54321',
    'HTTP://KONG:8000',
  ]) {
    assertDisabled({ ...SIM, SUPABASE_URL: url }, `supabase ${url}`);
  }
  assertDisabled({ ...SIM, SUPABASE_URL: undefined }, 'supabase unset');
});

Deno.test('simulator: refused with the real API, a remote host, or any non-exact simulator origin', () => {
  for (const base of [
    RAZORPAY_API,
    'https://evil.example',
    'http://evil.example:59480',
    'http://10.0.0.5:59480',
    'http://192.168.1.2:59480',
    'http://172.17.0.1:59480',
    'http://host.docker.internal:59481',
    'http://host.docker.internal',
    'http://host.docker.internal:59480/v1',
    'http://host.docker.internal:59480?x=1',
    'http://host.docker.internal:59480#x',
    'http://u:p@host.docker.internal:59480',
    'https://host.docker.internal:59480',
    'http://host.docker.internal.evil.example:59480',
    'http://127.0.0.1:59480.evil.example',
    'http://evil.example/http://127.0.0.1:59480',
    'HTTP://HOST.DOCKER.INTERNAL:59480',
    'http://127.1:59480',
    'not a url',
  ]) {
    assertDisabled({ ...SIM, RAZORPAY_API_BASE: base }, `api ${base}`);
  }
  // the simulator never defaults to anything
  assertDisabled({ ...SIM, RAZORPAY_API_BASE: undefined }, 'api unset');
});

Deno.test('simulator: refused with a real-shaped key id or a non-placeholder secret (a real secret is never sent)', () => {
  for (const keyId of [DUMMY_KEY_ID, 'rzp_live_DUMMYKEY0001', `${SIMULATOR_KEY_ID}X`, undefined]) {
    assertDisabled({ ...SIM, RAZORPAY_KEY_ID: keyId }, `key id ${keyId}`);
  }
  for (const secret of [DUMMY_SECRET, `${SIMULATOR_KEY_SECRET}x`]) {
    assertDisabled({ ...SIM, RAZORPAY_KEY_SECRET: secret }, 'non-placeholder secret');
  }
});

Deno.test('simulator: refused whenever the live-key override is set', () => {
  for (const v of ['true', 'TRUE', '1', 'false']) {
    assertDisabled({ ...SIM, RAZORPAY_ALLOW_LIVE_KEYS: v }, `allow live ${v}`);
  }
});

Deno.test('simulator: requests go to the simulator origin with the placeholder credentials only', async () => {
  const c = readConfig(env(SIM));
  assert(c.razorpay !== null);
  const seen: { url: string; auth: string }[] = [];
  const client = createRazorpayClient({
    credentials: c.razorpay,
    apiBase: c.razorpayApiBase,
    fetch: (input, init) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') ?? '' });
      return Promise.resolve(new Response('{}', { status: 404 }));
    },
  });
  await client.fetchPayment('pay_DUMMY0001');
  assertEquals(seen.length, 1);
  assert(seen[0].url.startsWith('http://host.docker.internal:59480/v1/'), 'simulator origin');
  assertEquals(seen[0].auth, 'Basic ' + btoa(`${SIMULATOR_KEY_ID}:${SIMULATOR_KEY_SECRET}`));
});

// ---------------------------------------------------------------
// real Razorpay API pinning (simulator off)
// ---------------------------------------------------------------

Deno.test('pinning: unset or exactly https://api.razorpay.com; requests go only there', async () => {
  for (const base of [undefined, RAZORPAY_API, `${RAZORPAY_API}/`]) {
    const c = readConfig(env({ ...REAL, RAZORPAY_API_BASE: base }));
    assertEquals([c.razorpay?.keyId, c.razorpayApiBase, c.simulator], [DUMMY_KEY_ID, RAZORPAY_API, false], `base ${base}`);
  }
  const c = readConfig(env(REAL));
  assert(c.razorpay !== null);
  const urls: string[] = [];
  const client = createRazorpayClient({
    credentials: c.razorpay,
    apiBase: c.razorpayApiBase,
    fetch: (input) => {
      urls.push(String(input));
      return Promise.resolve(new Response('{}', { status: 404 }));
    },
  });
  await client.fetchPayment('pay_DUMMY0001');
  await client.fetchOrderPayments('order_DUMMY0001');
  assert(urls.length === 2 && urls.every((u) => new URL(u).origin === RAZORPAY_API), 'pinned origin');
});

Deno.test('pinning: arbitrary or ambiguous https bases disable payments (never silently replaced)', () => {
  for (const base of [
    'https://evil.example',
    'https://api.razorpay.com.evil.example',
    'https://api.razorpay.co',
    'https://evil.example/api.razorpay.com',
    'https://api.razorpay.com@evil.example',
    'https://user:pw@api.razorpay.com',
    'https://api.razorpay.com/v1',
    'https://api.razorpay.com?x=1',
    'https://api.razorpay.com#x',
    'https://api.razorpay.com:443',
    'https://api.razorpay.com:8443',
    'https://API.RAZORPAY.COM',
    'https://api.razorpay.com//',
    'not a url',
  ]) {
    assertDisabled({ ...REAL, RAZORPAY_API_BASE: base }, `base ${base}`);
  }
});

Deno.test('pinning: plain http is refused, remote or local, outside simulator mode', () => {
  for (const base of [
    'http://api.razorpay.com',
    'http://evil.example',
    'http://10.0.0.1:8080',
    // a local mock only in simulator mode, with placeholder credentials
    'http://127.0.0.1:59480',
    'http://host.docker.internal:59480',
    'http://localhost:9999',
  ]) {
    assertDisabled({ ...REAL, RAZORPAY_API_BASE: base }, `base ${base}`);
  }
});

Deno.test('pinning: the simulator placeholder key is refused outside simulator mode', () => {
  const c = readConfig(env({ ...REAL, RAZORPAY_KEY_ID: SIMULATOR_KEY_ID, RAZORPAY_KEY_SECRET: SIMULATOR_KEY_SECRET }));
  assertEquals([c.razorpay, c.simulator], [null, false]);
});

Deno.test('local dev setup: functions serve with test keys keeps real mode, and the live-key refusal is unchanged', () => {
  // what `supabase functions serve` provides plus a test-key env file
  const c = readConfig(env(REAL));
  assertEquals([c.supabaseUrl, c.simulator, c.razorpay?.keyId, c.razorpayApiBase], ['http://kong:8000', false, DUMMY_KEY_ID, RAZORPAY_API]);
  // a host process against the local gateway
  assertEquals(readConfig(env({ ...REAL, SUPABASE_URL: 'http://127.0.0.1:59401/' })).supabaseUrl, 'http://127.0.0.1:59401');
  // live keys: refused unless explicitly allowed (unchanged behaviour)
  assertEquals(readConfig(env({ ...REAL, RAZORPAY_KEY_ID: 'rzp_live_DUMMYKEY0001' })).razorpay, null);
  assertEquals(readConfig(env({ ...REAL, RAZORPAY_KEY_ID: 'rzp_live_DUMMYKEY0001', RAZORPAY_ALLOW_LIVE_KEYS: 'yes' })).razorpay, null);
  assertEquals(
    readConfig(env({ ...REAL, RAZORPAY_KEY_ID: 'rzp_live_DUMMYKEY0001', RAZORPAY_ALLOW_LIVE_KEYS: 'true' })).razorpay?.keyId,
    'rzp_live_DUMMYKEY0001',
  );
});

Deno.test('disabled payments keep the database and webhook settings (the webhook still verifies and records)', () => {
  const c = readConfig(env({ ...REAL, RAZORPAY_API_BASE: 'https://evil.example' }));
  assert(isDisabled(c));
  assertEquals([c.supabaseUrl, c.serviceRoleKey, c.anonKey, c.webhookSecrets], [
    'http://kong:8000', 'dummy-service-role', 'dummy-anon', ['dummy-webhook-secret'],
  ]);
});
