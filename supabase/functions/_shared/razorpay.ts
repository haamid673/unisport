// Minimal Razorpay REST client (direct HTTPS; no SDK).
//
// Endpoints used (official API, HTTP Basic auth with key id/secret):
//   POST /v1/orders                 create an order
//   GET  /v1/orders?receipt=...     fetch orders by receipt (recovery)
//   GET  /v1/payments/{id}          fetch one payment (trusted facts)
//   GET  /v1/orders/{id}/payments   payments of one order (recovery)
//
// Every call has a timeout. Results are CLASSIFIED rather than thrown,
// because "the provider did not answer" must never be mistaken for
// "the provider did not create an order".

import type { RazorpayCredentials } from './config.ts';
import { isRecord } from './http.ts';

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface RazorpayOrder {
  id: string;
  entity: string;
  amount: number;
  currency: string;
  receipt: string | null;
  status: string;
}

export interface RazorpayPaymentFacts {
  id: string;
  order_id: string | null;
  status: 'created' | 'authorized' | 'captured' | 'failed' | 'refunded';
  amount: number;
  currency: string;
  amount_refunded: number;
  created_at: number | null;
  error_code: string | null;
  error_description: string | null;
}

export type CreateOrderResult =
  | { kind: 'created'; order: unknown }
  // The provider says an order with this receipt already exists.
  | { kind: 'duplicate_receipt' }
  // A definitive refusal: the order was NOT created.
  | { kind: 'rejected'; status: number }
  // Unknown outcome: the order may or may not exist.
  | { kind: 'ambiguous'; reason: 'timeout' | 'network' | 'server_error' | 'rate_limited' | 'invalid_response'; status?: number };

export type LookupResult =
  | { kind: 'ok'; orders: unknown[] }
  | { kind: 'error'; reason: string; status?: number };

export type OrderPaymentsResult =
  // `complete` is true only when the provider's own count equals the
  // number of items returned AND the list is shorter than 10, the
  // default page size of Razorpay's other documented collections (GET
  // /v1/orders, GET /v1/payments). No pagination parameter is documented
  // for this endpoint, so a list that might be truncated is reported as
  // incomplete, never as exhaustive.
  | { kind: 'ok'; items: unknown[]; complete: boolean }
  | { kind: 'error'; reason: string; status?: number };

export const ORDER_PAYMENTS_SAFE_PAGE = 10;

export type FetchPaymentResult =
  | { kind: 'ok'; payment: unknown }
  | { kind: 'not_found' }
  | { kind: 'error'; reason: string; status?: number };

export interface RazorpayClient {
  createOrder(input: { amount: number; currency: string; receipt: string; notes: Record<string, string> }): Promise<CreateOrderResult>;
  findOrdersByReceipt(receipt: string): Promise<LookupResult>;
  fetchPayment(paymentId: string): Promise<FetchPaymentResult>;
  fetchOrderPayments(orderId: string): Promise<OrderPaymentsResult>;
}

export const ORDER_ID = /^order_[A-Za-z0-9]{1,40}$/;
export const PAYMENT_ID = /^pay_[A-Za-z0-9]{1,40}$/;

const DUPLICATE_RECEIPT = /already been processed|same\s+`?receipt|duplicate/i;

function basicAuth(creds: RazorpayCredentials): string {
  return 'Basic ' + btoa(`${creds.keyId}:${creds.keySecret}`);
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorDescription(body: unknown): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.description === 'string') {
    return body.error.description;
  }
  return '';
}

export function createRazorpayClient(options: {
  credentials: RazorpayCredentials;
  apiBase: string;
  fetch: FetchFn;
  timeoutMs?: number;
}): RazorpayClient {
  const { credentials, apiBase, fetch } = options;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const headers = {
    Authorization: basicAuth(credentials),
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  async function call(method: string, path: string, body?: unknown):
    Promise<{ ok: true; res: Response } | { ok: false; reason: 'timeout' | 'network' }> {
    try {
      const res = await fetch(`${apiBase}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { ok: true, res };
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      return { ok: false, reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' };
    }
  }

  return {
    async createOrder(input) {
      const r = await call('POST', '/v1/orders', input);
      if (!r.ok) return { kind: 'ambiguous', reason: r.reason };
      const { res } = r;
      if (res.status >= 200 && res.status < 300) {
        const body = await readJson(res);
        // A success status without a readable order: it may exist.
        if (body === undefined) return { kind: 'ambiguous', reason: 'invalid_response', status: res.status };
        return { kind: 'created', order: body };
      }
      const body = await readJson(res);
      if (res.status === 400 && DUPLICATE_RECEIPT.test(errorDescription(body))) {
        return { kind: 'duplicate_receipt' };
      }
      if (res.status === 429) return { kind: 'ambiguous', reason: 'rate_limited', status: res.status };
      if (res.status >= 500) return { kind: 'ambiguous', reason: 'server_error', status: res.status };
      return { kind: 'rejected', status: res.status };
    },

    async findOrdersByReceipt(receipt) {
      const q = new URLSearchParams({ receipt, count: '100' });
      const r = await call('GET', `/v1/orders?${q.toString()}`);
      if (!r.ok) return { kind: 'error', reason: r.reason };
      const body = await readJson(r.res);
      if (r.res.status !== 200 || !isRecord(body) || !Array.isArray(body.items)) {
        return { kind: 'error', reason: 'unexpected_response', status: r.res.status };
      }
      return { kind: 'ok', orders: body.items };
    },

    async fetchOrderPayments(orderId) {
      if (!ORDER_ID.test(orderId)) return { kind: 'error', reason: 'invalid_order_id' };
      const r = await call('GET', `/v1/orders/${encodeURIComponent(orderId)}/payments`);
      if (!r.ok) return { kind: 'error', reason: r.reason };
      const body = await readJson(r.res);
      if (r.res.status !== 200 || !isRecord(body) || body.entity !== 'collection' || !Array.isArray(body.items)) {
        return { kind: 'error', reason: 'unexpected_response', status: r.res.status };
      }
      const items = body.items;
      const complete = typeof body.count === 'number' && body.count === items.length &&
        items.length < ORDER_PAYMENTS_SAFE_PAGE;
      return { kind: 'ok', items, complete };
    },

    async fetchPayment(paymentId) {
      if (!PAYMENT_ID.test(paymentId)) return { kind: 'not_found' };
      const r = await call('GET', `/v1/payments/${encodeURIComponent(paymentId)}`);
      if (!r.ok) return { kind: 'error', reason: r.reason };
      const body = await readJson(r.res);
      if (r.res.status === 200 && body !== undefined) return { kind: 'ok', payment: body };
      if (r.res.status === 400 && /does not exist/i.test(errorDescription(body))) return { kind: 'not_found' };
      return { kind: 'error', reason: 'unexpected_response', status: r.res.status };
    },
  };
}

// ------------------------------------------------------------
// Validation of what the provider returned
// ------------------------------------------------------------

// An order response must be exactly what we asked for.
export function validateOrder(
  order: unknown,
  expected: { amount: number; currency: string; receipt: string },
): RazorpayOrder | null {
  if (!isRecord(order)) return null;
  const { id, entity, amount, currency, receipt, status } = order;
  if (typeof id !== 'string' || !ORDER_ID.test(id)) return null;
  if (entity !== 'order') return null;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount !== expected.amount) return null;
  if (currency !== expected.currency) return null;
  if (receipt !== expected.receipt) return null;
  if (typeof status !== 'string' || !['created', 'attempted', 'paid'].includes(status)) return null;
  return { id, entity, amount, currency, receipt, status };
}

const STATUSES = new Set(['created', 'authorized', 'captured', 'failed', 'refunded']);

function optionalString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
}

// Facts from GET /v1/payments/{id}; null when the response is not a
// well-formed payment entity for exactly the requested id.
export function parsePayment(payment: unknown, expectedId: string): RazorpayPaymentFacts | null {
  if (!isRecord(payment)) return null;
  const { id, entity, status, amount, currency, amount_refunded, order_id, created_at } = payment;
  if (entity !== 'payment' || id !== expectedId || typeof id !== 'string' || !PAYMENT_ID.test(id)) return null;
  if (typeof status !== 'string' || !STATUSES.has(status)) return null;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) return null;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return null;
  const refunded = amount_refunded ?? 0;
  if (typeof refunded !== 'number' || !Number.isSafeInteger(refunded) || refunded < 0 || refunded > amount) return null;
  if (order_id !== null && order_id !== undefined && (typeof order_id !== 'string' || !ORDER_ID.test(order_id))) {
    return null;
  }
  return {
    id,
    order_id: typeof order_id === 'string' ? order_id : null,
    status: status as RazorpayPaymentFacts['status'],
    amount,
    currency,
    amount_refunded: refunded,
    created_at: typeof created_at === 'number' && Number.isSafeInteger(created_at) ? created_at : null,
    error_code: optionalString(payment.error_code, 255),
    error_description: optionalString(payment.error_description, 1000),
  };
}
