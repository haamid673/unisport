// Local-only payment provider simulator: an in-memory stand-in for the
// four Razorpay endpoints the payment Edge Functions call
// (supabase/functions/_shared/razorpay.ts), plus a token-protected
// control API that decides what "the customer" did.
//
// It is NOT Razorpay. It answers in the shapes our client parses and
// nothing more; it proves nothing about the real API's pagination,
// consistency, capture or refund semantics. No outbound request is ever
// made from here, and no state is persisted.
//
// Provider API (HTTP Basic auth with the simulator placeholder key only):
//   POST /v1/orders                        { amount, currency, receipt, notes }
//   GET  /v1/orders?receipt=…&count=…      orders with exactly that receipt
//   GET  /v1/payments/{pay_id}             one payment
//   GET  /v1/orders/{order_id}/payments    that order's payments only
//
// Control API (header X-Simulator-Control-Token; disabled without a token):
//   POST /__control/orders/{order_id}/payments  { outcome, amount? }
//   POST /__control/payments/{pay_id}/authorize  failed -> authorized (late authorization)
//   POST /__control/payments/{pay_id}/capture    authorized -> captured
//   POST /__control/payments/{pay_id}/refund     { amount? } captured -> partly or fully refunded
//   POST /__control/faults                       { operation, mode, delay_ms?, times? }
//   POST /__control/reset                        forget all orders, payments and faults
//
//   GET  /health                                 liveness only (no state)

import { SIMULATOR_KEY_ID, SIMULATOR_KEY_SECRET } from '../functions/_shared/config.ts';
import { BodyTooLarge, readBodyLimited } from '../functions/_shared/http.ts';
import { timingSafeEqual } from '../functions/_shared/signature.ts';

export const DEFAULT_PORT = 59480;
export const MAX_BODY_BYTES = 8 * 1024;
export const MAX_ORDERS = 1000;
export const MAX_PAYMENTS_PER_ORDER = 20;
export const MAX_LIST_COUNT = 100;
export const MAX_DELAY_MS = 30_000;
export const MAX_FAULTS = 10;
const MIN_AMOUNT = 100; // paise: Razorpay's documented minimum order amount
const MAX_AMOUNT = 1_000_000_000;
const MAX_NOTES = 15;
const MIN_CONTROL_TOKEN = 32;

const ORDER_ID = /^order_[A-Za-z0-9]{1,40}$/;
const PAYMENT_ID = /^pay_[A-Za-z0-9]{1,40}$/;
const RECEIPT = /^[A-Za-z0-9_-]{1,40}$/;
const NOTE_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const RUN_ID = /^[A-Z0-9]{6}$/;
const CONTROL_TOKEN = /^[A-Za-z0-9_-]+$/;

export type Outcome = 'captured' | 'authorized' | 'failed';
export type Operation = 'create_order' | 'find_orders' | 'fetch_payment' | 'order_payments';
export type FaultMode = 'delay' | 'server_error' | 'rate_limited';

interface Order {
  id: string;
  entity: 'order';
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string;
  offer_id: null;
  status: 'created' | 'attempted' | 'paid';
  attempts: number;
  notes: Record<string, string>;
  created_at: number;
}

interface Payment {
  id: string;
  entity: 'payment';
  amount: number;
  currency: string;
  status: 'authorized' | 'captured' | 'failed' | 'refunded';
  order_id: string;
  method: 'card';
  amount_refunded: number;
  refund_status: null | 'partial' | 'full';
  captured: boolean;
  description: string;
  notes: Record<string, string>;
  error_code: string | null;
  error_description: string | null;
  error_source: string | null;
  error_step: string | null;
  error_reason: string | null;
  created_at: number;
}

interface Fault {
  operation: Operation;
  mode: FaultMode;
  delayMs: number;
}

export interface SimulatorOptions {
  /** Port the server listens on (for the Host header check). */
  port: () => number;
  /** Control API token; null disables the control API. Never logged. */
  controlToken: string | null;
  /** Six upper-case letters/digits embedded in every id, so ids never repeat across runs. */
  runId: string;
  /** Unix seconds. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: Record<string, unknown>) => void;
}

/** Why a control token is unusable, or null when it is acceptable. */
export function controlTokenProblem(token: string): string | null {
  if (token.length < MIN_CONTROL_TOKEN) return `must be at least ${MIN_CONTROL_TOKEN} characters`;
  if (!CONTROL_TOKEN.test(token)) return 'may contain only letters, digits, "-" and "_"';
  if (token === SIMULATOR_KEY_SECRET) return 'must differ from the provider placeholder secret';
  return null;
}

/** A fresh random run id (six upper-case letters/digits). */
export function newRunId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

const PROVIDER_AUTH = 'Basic ' + btoa(`${SIMULATOR_KEY_ID}:${SIMULATOR_KEY_SECRET}`);

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  });
}

// Razorpay-style error body (the client reads error.description only).
function providerError(status: number, description: string): Response {
  return json(status, { error: { code: status >= 500 ? 'SERVER_ERROR' : 'BAD_REQUEST_ERROR', description } });
}

function controlError(status: number, error: string): Response {
  return json(status, { error });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isAmount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= MIN_AMOUNT && v <= MAX_AMOUNT;
}

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(body).every((k) => allowed.includes(k));
}

class BadBody extends Error {}

export function createSimulator(options: SimulatorOptions) {
  if (!RUN_ID.test(options.runId)) throw new Error('runId must be six upper-case letters or digits');
  if (options.controlToken !== null) {
    const problem = controlTokenProblem(options.controlToken);
    if (problem) throw new Error(`control token ${problem}`);
  }
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = options.log ?? (() => {});

  const orders = new Map<string, Order>();
  const payments = new Map<string, Payment>();
  const orderPayments = new Map<string, string[]>();
  let faults: Fault[] = [];
  // Never reset: an id is never handed out twice by one process.
  let orderSeq = 0;
  let paymentSeq = 0;

  const nextOrderId = () => `order_SIMULATED${options.runId}${String(++orderSeq).padStart(6, '0')}`;
  const nextPaymentId = () => `pay_SIMULATED${options.runId}${String(++paymentSeq).padStart(6, '0')}`;

  function allowedHost(host: string | null): boolean {
    const port = options.port();
    return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `host.docker.internal:${port}`;
  }

  async function readJsonBody(req: Request, allowEmpty: boolean): Promise<Record<string, unknown>> {
    const type = req.headers.get('content-type') ?? '';
    const raw = await readBodyLimited(req, MAX_BODY_BYTES);
    if (raw.byteLength === 0) {
      if (allowEmpty) return {};
      throw new BadBody('a JSON body is required');
    }
    if (!/^application\/json(\s*;\s*charset=utf-8)?$/i.test(type.trim())) throw new BadBody('content-type must be application/json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } catch {
      throw new BadBody('the body is not valid JSON');
    }
    if (!isRecord(parsed)) throw new BadBody('the body must be a JSON object');
    return parsed;
  }

  // A pending fault for this operation, consumed once.
  function takeFault(operation: Operation): Fault | null {
    const i = faults.findIndex((f) => f.operation === operation);
    if (i === -1) return null;
    const [f] = faults.splice(i, 1);
    return f;
  }

  // Applies a fault around an operation: errors replace the operation
  // (nothing happens); a delay lets it happen and answers late.
  async function withFault(operation: Operation, run: () => Response | Promise<Response>): Promise<Response> {
    const fault = takeFault(operation);
    if (fault?.mode === 'server_error') return providerError(500, 'Simulated provider error');
    if (fault?.mode === 'rate_limited') return providerError(429, 'Simulated rate limit');
    const res = await run();
    if (fault?.mode === 'delay') await sleep(fault.delayMs);
    return res;
  }

  // ---------------------------------------------------------------
  // provider API
  // ---------------------------------------------------------------

  async function createOrder(req: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req, false);
    } catch (e) {
      if (e instanceof BodyTooLarge) return providerError(413, 'Request body too large');
      return providerError(400, e instanceof BadBody ? e.message : 'Invalid request');
    }
    if (!onlyKeys(body, ['amount', 'currency', 'receipt', 'notes'])) return providerError(400, 'Unsupported field in request');
    const { amount, currency, receipt, notes } = body;
    if (!isAmount(amount)) return providerError(400, `amount must be an integer from ${MIN_AMOUNT} to ${MAX_AMOUNT} (paise)`);
    if (currency !== 'INR') return providerError(400, 'currency must be INR');
    if (typeof receipt !== 'string' || !RECEIPT.test(receipt)) return providerError(400, 'receipt must be 1-40 letters, digits, "-" or "_"');
    const cleanNotes: Record<string, string> = {};
    if (notes !== undefined) {
      if (!isRecord(notes) || Object.keys(notes).length > MAX_NOTES) return providerError(400, `notes must be an object of at most ${MAX_NOTES} entries`);
      for (const [k, v] of Object.entries(notes)) {
        if (!NOTE_KEY.test(k) || typeof v !== 'string' || v.length > 256) return providerError(400, 'notes must map short keys to strings of at most 256 characters');
        cleanNotes[k] = v;
      }
    }
    return withFault('create_order', () => {
      if (orders.size >= MAX_ORDERS) return providerError(400, 'Simulator order limit reached; reset it');
      const order: Order = {
        id: nextOrderId(),
        entity: 'order',
        amount,
        amount_paid: 0,
        amount_due: amount,
        currency,
        receipt,
        offer_id: null,
        status: 'created',
        attempts: 0,
        notes: cleanNotes,
        created_at: now(),
      };
      orders.set(order.id, order);
      orderPayments.set(order.id, []);
      return json(200, order);
    });
  }

  function findOrders(url: URL): Promise<Response> {
    const keys = [...url.searchParams.keys()];
    if (keys.some((k) => k !== 'receipt' && k !== 'count') || new Set(keys).size !== keys.length) {
      return Promise.resolve(providerError(400, 'Only receipt and count are supported, once each'));
    }
    const receipt = url.searchParams.get('receipt');
    if (receipt === null || !RECEIPT.test(receipt)) return Promise.resolve(providerError(400, 'A valid receipt is required'));
    const countRaw = url.searchParams.get('count') ?? '10';
    if (!/^[1-9][0-9]{0,2}$/.test(countRaw) || Number(countRaw) > MAX_LIST_COUNT) {
      return Promise.resolve(providerError(400, `count must be 1-${MAX_LIST_COUNT}`));
    }
    return withFault('find_orders', () => {
      const items = [...orders.values()].filter((o) => o.receipt === receipt).reverse().slice(0, Number(countRaw));
      return json(200, { entity: 'collection', count: items.length, items });
    });
  }

  function fetchPayment(id: string): Promise<Response> {
    return withFault('fetch_payment', () => {
      const p = payments.get(id);
      return p ? json(200, p) : providerError(400, 'The id provided does not exist');
    });
  }

  function listOrderPayments(id: string): Promise<Response> {
    return withFault('order_payments', () => {
      const ids = orderPayments.get(id);
      if (!ids) return providerError(400, 'The id provided does not exist');
      // only payments that belong to THIS order
      const items = ids.map((pid) => payments.get(pid)).filter((p): p is Payment => p?.order_id === id);
      return json(200, { entity: 'collection', count: items.length, items });
    });
  }

  // ---------------------------------------------------------------
  // control API
  // ---------------------------------------------------------------

  function createPayment(orderId: string, body: Record<string, unknown>): Response {
    if (!onlyKeys(body, ['outcome', 'amount'])) return controlError(400, 'unsupported_field');
    const { outcome, amount } = body;
    if (outcome !== 'captured' && outcome !== 'authorized' && outcome !== 'failed') return controlError(400, 'invalid_outcome');
    const order = orders.get(orderId);
    if (!order) return controlError(404, 'order_not_found');
    if (amount !== undefined && !isAmount(amount)) return controlError(400, 'invalid_amount');
    const list = orderPayments.get(orderId)!;
    if (list.length >= MAX_PAYMENTS_PER_ORDER) return controlError(409, 'payment_limit_reached');
    const failed = outcome === 'failed';
    const payment: Payment = {
      id: nextPaymentId(),
      entity: 'payment',
      amount: amount ?? order.amount,
      currency: order.currency,
      status: outcome,
      order_id: order.id,
      method: 'card',
      amount_refunded: 0,
      refund_status: null,
      captured: outcome === 'captured',
      description: 'UniSport simulated payment (no money moves)',
      notes: {},
      error_code: failed ? 'BAD_REQUEST_ERROR' : null,
      error_description: failed ? 'Simulated payment failure' : null,
      error_source: failed ? 'customer' : null,
      error_step: failed ? 'payment_authorization' : null,
      error_reason: failed ? 'payment_failed' : null,
      created_at: now(),
    };
    payments.set(payment.id, payment);
    list.push(payment.id);
    order.attempts += 1;
    if (order.status === 'created') order.status = 'attempted';
    if (outcome === 'captured') markPaid(order, payment);
    return json(200, { payment });
  }

  function markPaid(order: Order, payment: Payment) {
    // A second capture on a paid order is permitted on purpose, so that
    // duplicate handling can be exercised; real Razorpay may refuse it.
    if (order.status !== 'paid') {
      order.status = 'paid';
      order.amount_paid = payment.amount;
      order.amount_due = Math.max(0, order.amount - payment.amount);
    }
  }

  function transition(paymentId: string, action: 'authorize' | 'capture' | 'refund', body: Record<string, unknown>): Response {
    if (!onlyKeys(body, action === 'refund' ? ['amount'] : [])) return controlError(400, 'unsupported_field');
    const p = payments.get(paymentId);
    if (!p) return controlError(404, 'payment_not_found');
    const order = orders.get(p.order_id)!;
    if (action === 'authorize') {
      if (p.status !== 'failed') return controlError(409, 'invalid_transition');
      Object.assign(p, {
        status: 'authorized', error_code: null, error_description: null, error_source: null, error_step: null, error_reason: null,
      });
    } else if (action === 'capture') {
      if (p.status !== 'authorized') return controlError(409, 'invalid_transition');
      p.status = 'captured';
      p.captured = true;
      markPaid(order, p);
    } else {
      if (p.status !== 'captured') return controlError(409, 'invalid_transition');
      const remaining = p.amount - p.amount_refunded;
      const amount = body.amount ?? remaining;
      if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1 || amount > remaining) {
        return controlError(400, 'invalid_amount');
      }
      p.amount_refunded += amount;
      p.refund_status = p.amount_refunded === p.amount ? 'full' : 'partial';
      if (p.amount_refunded === p.amount) p.status = 'refunded';
    }
    return json(200, { payment: p });
  }

  function addFault(body: Record<string, unknown>): Response {
    if (!onlyKeys(body, ['operation', 'mode', 'delay_ms', 'times'])) return controlError(400, 'unsupported_field');
    const { operation, mode, delay_ms, times } = body;
    if (!['create_order', 'find_orders', 'fetch_payment', 'order_payments'].includes(operation as string)) {
      return controlError(400, 'invalid_operation');
    }
    if (mode !== 'delay' && mode !== 'server_error' && mode !== 'rate_limited') return controlError(400, 'invalid_mode');
    let delayMs = 0;
    if (mode === 'delay') {
      if (typeof delay_ms !== 'number' || !Number.isSafeInteger(delay_ms) || delay_ms < 1 || delay_ms > MAX_DELAY_MS) {
        return controlError(400, 'invalid_delay');
      }
      delayMs = delay_ms;
    } else if (delay_ms !== undefined) return controlError(400, 'invalid_delay');
    const n = times ?? 1;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || faults.length + n > MAX_FAULTS) return controlError(400, 'invalid_times');
    for (let i = 0; i < n; i++) faults.push({ operation: operation as Operation, mode, delayMs });
    return json(200, { pending_faults: faults.length });
  }

  async function control(req: Request, path: string): Promise<Response> {
    if (options.controlToken === null) return controlError(403, 'control_disabled');
    const given = req.headers.get('x-simulator-control-token');
    if (given === null || !timingSafeEqual(given, options.controlToken)) return controlError(401, 'invalid_control_token');
    if (req.method !== 'POST') return controlError(405, 'method_not_allowed');
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req, true);
    } catch (e) {
      if (e instanceof BodyTooLarge) return controlError(413, 'body_too_large');
      return controlError(400, 'invalid_body');
    }
    let m: RegExpExecArray | null;
    if ((m = /^\/__control\/orders\/([^/]+)\/payments$/.exec(path))) {
      return ORDER_ID.test(m[1]) ? createPayment(m[1], body) : controlError(404, 'order_not_found');
    }
    if ((m = /^\/__control\/payments\/([^/]+)\/(authorize|capture|refund)$/.exec(path))) {
      return PAYMENT_ID.test(m[1])
        ? transition(m[1], m[2] as 'authorize' | 'capture' | 'refund', body)
        : controlError(404, 'payment_not_found');
    }
    if (path === '/__control/faults') return addFault(body);
    if (path === '/__control/reset') {
      if (Object.keys(body).length !== 0) return controlError(400, 'unsupported_field');
      orders.clear();
      payments.clear();
      orderPayments.clear();
      faults = [];
      return json(200, { reset: true });
    }
    return controlError(404, 'not_found');
  }

  // ---------------------------------------------------------------
  // routing
  // ---------------------------------------------------------------

  function route(req: Request): Response | Promise<Response> {
    // DNS rebinding and browser use: only our own host names, no Origin
    if (!allowedHost(req.headers.get('host'))) return controlError(421, 'host_not_allowed');
    if (req.headers.has('origin')) return controlError(403, 'browser_requests_not_allowed');

    const url = new URL(req.url);
    const path = url.pathname;
    if (path.startsWith('/__control/')) {
      if (url.search !== '') return controlError(400, 'query_not_allowed');
      return control(req, path);
    }
    if (path === '/health') {
      if (req.method !== 'GET') return controlError(405, 'method_not_allowed');
      if (url.search !== '') return controlError(400, 'query_not_allowed');
      return json(200, { status: 'ok', simulator: 'local-only' });
    }
    if (!path.startsWith('/v1/')) return controlError(404, 'not_found');

    const auth = req.headers.get('authorization');
    if (auth === null || !timingSafeEqual(auth, PROVIDER_AUTH)) return providerError(401, 'Authentication failed');

    if (path === '/v1/orders') {
      if (req.method === 'POST') {
        if (url.search !== '') return providerError(400, 'Query parameters are not supported here');
        return createOrder(req);
      }
      if (req.method === 'GET') return findOrders(url);
      return providerError(405, 'Method not allowed');
    }
    let m: RegExpExecArray | null;
    if ((m = /^\/v1\/payments\/([^/]+)$/.exec(path))) {
      if (req.method !== 'GET') return providerError(405, 'Method not allowed');
      if (url.search !== '') return providerError(400, 'Query parameters are not supported here');
      return PAYMENT_ID.test(m[1]) ? fetchPayment(m[1]) : providerError(400, 'The id provided does not exist');
    }
    if ((m = /^\/v1\/orders\/([^/]+)\/payments$/.exec(path))) {
      if (req.method !== 'GET') return providerError(405, 'Method not allowed');
      if (url.search !== '') return providerError(400, 'Query parameters are not supported here');
      return ORDER_ID.test(m[1]) ? listOrderPayments(m[1]) : providerError(400, 'The id provided does not exist');
    }
    return providerError(404, 'The requested URL was not found on the server.');
  }

  return {
    async handle(req: Request): Promise<Response> {
      let res: Response;
      try {
        res = await route(req);
      } catch {
        res = controlError(500, 'internal_error');
      }
      // method, path template and status only: never headers, bodies or tokens
      log({ event: 'simulator.request', method: req.method, route: routeName(new URL(req.url).pathname), status: res.status });
      return res;
    },
  };
}

function routeName(path: string): string {
  if (path === '/health' || path === '/v1/orders' || path === '/__control/faults' || path === '/__control/reset') return path;
  if (/^\/v1\/payments\/[^/]+$/.test(path)) return '/v1/payments/{id}';
  if (/^\/v1\/orders\/[^/]+\/payments$/.test(path)) return '/v1/orders/{id}/payments';
  if (/^\/__control\/orders\/[^/]+\/payments$/.test(path)) return '/__control/orders/{id}/payments';
  if (/^\/__control\/payments\/[^/]+\/(authorize|capture|refund)$/.test(path)) return path.replace(/\/payments\/[^/]+\//, '/payments/{id}/');
  return 'other';
}
