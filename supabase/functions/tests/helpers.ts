// Test helpers: a scripted fake network (PostgREST RPC, GoTrue user,
// Razorpay API) behind ONE fetch function, so the real HTTP adapters in
// _shared/ are exercised. No real network call is ever made: any URL
// the script does not know fails the test.

import type { PaymentConfig } from '../_shared/config.ts';
import type { LogFields } from '../_shared/http.ts';
import { createRazorpayClient } from '../_shared/razorpay.ts';
import { createAuth, createDatabase } from '../_shared/supabase.ts';

export const SUPABASE_URL = 'http://supabase.test';
export const RAZORPAY_BASE = 'https://api.razorpay.test';
export const KEY_ID = 'rzp_test_PUBLICKEYID01';
export const KEY_SECRET = 'test-key-secret-NEVER-EXPOSE';
export const SERVICE_KEY = 'service-role-key-NEVER-EXPOSE';
export const ANON_KEY = 'anon-key-public';
export const WEBHOOK_SECRET = 'webhook-secret-NEVER-EXPOSE';
export const USER_TOKEN = 'user.jwt.token-for-tests-000000000000';
export const USER_ID = '11111111-1111-4111-8111-111111111111';
export const BOOKING_ID = '22222222-2222-4222-8222-222222222222';
export const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';

export function assert(cond: unknown, msg = 'assertion failed'): asserts cond {
  if (!cond) throw new Error(msg);
}

export function assertEquals(actual: unknown, expected: unknown, msg = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected: ${e}\n  actual:   ${a}`);
}

export function testConfig(overrides: Partial<PaymentConfig> = {}): PaymentConfig {
  return {
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_KEY,
    anonKey: ANON_KEY,
    razorpay: { keyId: KEY_ID, keySecret: KEY_SECRET },
    webhookSecrets: [WEBHOOK_SECRET],
    razorpayApiBase: RAZORPAY_BASE,
    ...overrides,
  };
}

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status: number; body?: unknown } | 'timeout' | 'network';
export type RpcHandler = (args: Record<string, unknown>) => Reply;
export type RazorpayHandler = (req: { method: string; path: string; body: unknown }) => Reply;

export class FakeNet {
  calls: Call[] = [];
  rpc: Record<string, RpcHandler> = {};
  users: Record<string, string> = { [USER_TOKEN]: USER_ID };
  razorpay: RazorpayHandler = () => {
    throw new Error('unexpected Razorpay call');
  };

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const text = typeof init?.body === 'string' ? init.body : undefined;
    const body = text === undefined ? undefined : JSON.parse(text);
    this.calls.push({ url, method, headers, body });

    let reply: Reply;
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/rpc/`)) {
      const fn = url.slice(`${SUPABASE_URL}/rest/v1/rpc/`.length);
      const h = this.rpc[fn];
      if (!h) throw new Error(`unexpected RPC ${fn}`);
      if (headers['authorization'] !== `Bearer ${SERVICE_KEY}`) throw new Error('RPC without service role');
      reply = h(body as Record<string, unknown>);
    } else if (url === `${SUPABASE_URL}/auth/v1/user`) {
      const token = (headers['authorization'] ?? '').replace(/^Bearer /, '');
      const id = this.users[token];
      reply = id ? { status: 200, body: { id, role: 'authenticated' } } : { status: 401, body: { msg: 'invalid JWT' } };
    } else if (url.startsWith(RAZORPAY_BASE)) {
      const u = new URL(url);
      reply = this.razorpay({ method, path: u.pathname + u.search, body });
    } else {
      throw new Error(`unexpected URL ${url}`);
    }
    await Promise.resolve();
    if (reply === 'timeout') throw new DOMException('The signal has been aborted', 'TimeoutError');
    if (reply === 'network') throw new TypeError('error sending request');
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  rpcCalls(fn: string): Record<string, unknown>[] {
    return this.calls
      .filter((c) => c.url === `${SUPABASE_URL}/rest/v1/rpc/${fn}`)
      .map((c) => c.body as Record<string, unknown>);
  }

  razorpayCalls(): Call[] {
    return this.calls.filter((c) => c.url.startsWith(RAZORPAY_BASE));
  }
}

export class LogSink {
  lines: string[] = [];
  log = (event: string, fields: LogFields = {}) => {
    this.lines.push(JSON.stringify({ event, ...fields }));
  };
  text() {
    return this.lines.join('\n');
  }
}

export function deps(net: FakeNet, config = testConfig(), log = new LogSink()) {
  return {
    config,
    db: createDatabase(config, net.fetch),
    auth: createAuth(config, net.fetch),
    razorpay: config.razorpay
      ? createRazorpayClient({ credentials: config.razorpay, apiBase: config.razorpayApiBase, fetch: net.fetch, timeoutMs: 50 })
      : null,
    log: log.log,
    sink: log,
  };
}

export function secretsAbsent(text: string) {
  for (const s of [KEY_SECRET, SERVICE_KEY, WEBHOOK_SECRET, USER_TOKEN]) {
    assert(!text.includes(s), `a secret leaked: ${s}`);
  }
}
