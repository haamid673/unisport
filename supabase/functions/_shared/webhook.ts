// POST /functions/v1/payments-webhook   (Razorpay webhook receiver)
//
// Order of operations (nothing is trusted before step 2):
//
//   1. read the RAW body (bounded; 413 above MAX_BODY);
//   2. verify X-Razorpay-Signature = HMAC-SHA256(raw body, webhook
//      secret); 401 otherwise. The body is not parsed before this;
//   3. require x-razorpay-event-id (the provider's dedupe key) and a
//      JSON body; 400 otherwise;
//   4. store the event (minimised payload) in payment_events; a
//      redelivery of a processed event is acknowledged without work;
//   5. for payment events, FETCH the payment from the API with the
//      server credential. The webhook body only tells us which payment
//      to look at; its contents are never used as payment facts;
//   6. apply the fetched facts (payment_apply_observation): monotonic
//      merge, identity-checked association, unmatched storage, and
//      settlement of a captured matched payment, marking the event
//      processed in the same transaction.
//
// Responses: 2xx only when the event is durably handled: processed,
// ignored, a duplicate, or a DETERMINISTIC failure that is durably
// classified on the event (processed_at set, process_result = the
// class). A TRANSIENT failure answers 503 so the provider redelivers
// (at-least-once, up to 24 hours); it is recorded on the event
// (attempts, last_error) and the event stays unprocessed, so the next
// delivery reprocesses it. If a deterministic classification cannot be
// written, the answer is 503 too: nothing is acknowledged that is not
// durably recorded.
//
//   transient      provider timeout, network error, 429, 5xx, unreadable
//                  body, 401/403; database errors other than class 22/23
//                  (including 40001 from the concurrent-association race)
//   deterministic  provider 400 (other than "does not exist"), a
//                  well-formed provider response that fails validation,
//                  database class 22/23 rejections, a payment event with
//                  no payment id (missing_payment_id) or one that is not
//                  a provider payment id (unrecognised_payment_id)
//
// Never logged: the body, the signature, any header, any secret.

import type { PaymentConfig } from './config.ts';
import { BodyTooLarge, isRecord, json, readBodyLimited } from './http.ts';
import type { Logger } from './http.ts';
import { applyObservation, isPermanentFetchError } from './observation.ts';
import type { RazorpayClient } from './razorpay.ts';
import { ORDER_ID, parsePayment, PAYMENT_ID } from './razorpay.ts';
import { verifyWebhookSignature } from './signature.ts';
import type { Database } from './supabase.ts';
import { isDeterministicDbError } from './supabase.ts';

export interface WebhookDeps {
  config: PaymentConfig;
  db: Database;
  razorpay: RazorpayClient | null;
  log: Logger;
}

export const MAX_WEBHOOK_BODY = 256 * 1024;

const PAYMENT_EVENTS = new Set(['payment.authorized', 'payment.captured', 'payment.failed', 'order.paid']);
const EVENT_ID = /^[A-Za-z0-9_-]{1,255}$/;
const EVENT_TYPE = /^[a-z_]{1,50}(\.[a-z_]{1,50}){0,3}$/;
// payment_ingest_event accepts event types of 1..100 characters; a longer
// one would be refused by the inbox and could never be stored.
const MAX_EVENT_TYPE = 100;

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

// Audit copy of a claimed value: printable ASCII only, bounded. Keeps
// the inbox payload small and storable (no control characters, no
// NUL that jsonb would refuse) whatever the signed body contains.
function bounded(v: unknown, max = 64): string | null {
  if (typeof v !== 'string') return null;
  const clean = v.replace(/[^\x20-\x7E]/g, '').slice(0, max);
  return clean === '' ? null : clean;
}

// What is kept of the body: identifiers and the facts the event
// claimed (for audit only). No customer contact data, no card/VPA data.
function minimisedPayload(body: Record<string, unknown>, paymentEntity: Record<string, unknown> | null) {
  return {
    event: bounded(body.event, MAX_EVENT_TYPE),
    created_at: typeof body.created_at === 'number' && Number.isSafeInteger(body.created_at) ? body.created_at : null,
    payment: paymentEntity
      ? {
        id: bounded(paymentEntity.id),
        order_id: bounded(paymentEntity.order_id),
        status: bounded(paymentEntity.status, 32),
        amount: typeof paymentEntity.amount === 'number' && Number.isSafeInteger(paymentEntity.amount)
          ? paymentEntity.amount
          : null,
        currency: bounded(paymentEntity.currency, 8),
      }
      : null,
  };
}

export async function handleWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (deps.config.webhookSecrets.length === 0) {
    deps.log('webhook.not_configured');
    return json(503, { error: 'webhook_not_configured' });
  }

  // 1. raw body
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = await readBodyLimited(req, MAX_WEBHOOK_BODY);
  } catch (e) {
    if (e instanceof BodyTooLarge) return json(413, { error: 'request_too_large' });
    return json(400, { error: 'invalid_request' });
  }

  // 2. signature over exactly those bytes
  const valid = await verifyWebhookSignature(raw, req.headers.get('x-razorpay-signature'), deps.config.webhookSecrets);
  if (!valid) {
    deps.log('webhook.invalid_signature');
    return json(401, { error: 'invalid_signature' });
  }

  // 3. event id and body
  const eventId = req.headers.get('x-razorpay-event-id');
  if (!eventId || !EVENT_ID.test(eventId)) return json(400, { error: 'missing_event_id' });

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  if (!isRecord(body) || typeof body.event !== 'string' ||
      body.event.length > MAX_EVENT_TYPE || !EVENT_TYPE.test(body.event)) {
    return json(400, { error: 'invalid_event' });
  }
  const eventType = body.event;

  const payload = isRecord(body.payload) ? body.payload : null;
  const paymentWrap = payload && isRecord(payload.payment) ? payload.payment : null;
  const paymentEntity = paymentWrap && isRecord(paymentWrap.entity) ? paymentWrap.entity : null;
  const claimedPaymentId = paymentEntity && typeof paymentEntity.id === 'string' && PAYMENT_ID.test(paymentEntity.id)
    ? paymentEntity.id
    : null;
  const claimedOrderId = paymentEntity && typeof paymentEntity.order_id === 'string' && ORDER_ID.test(paymentEntity.order_id)
    ? paymentEntity.order_id
    : null;

  // 4. durable inbox (dedupe by event id)
  const ingest = await deps.db.rpc<Record<string, unknown>>('payment_ingest_event', {
    p_provider_event_id: eventId,
    p_event_type: eventType,
    p_provider_payment_id: claimedPaymentId,
    p_provider_order_id: claimedOrderId,
    p_payload: minimisedPayload(body, paymentEntity),
  });
  if (!ingest.ok || !isRecord(ingest.data) || typeof ingest.data.event_id !== 'string') {
    deps.log('webhook.ingest_failed', { event_id: eventId, status: ingest.ok ? 200 : ingest.status });
    // Not stored, so never acknowledged. Input the inbox rejects can
    // never be stored; anything else is retried.
    if (!ingest.ok && isDeterministicDbError(ingest)) return json(400, { error: 'invalid_event' });
    return json(503, { error: 'temporarily_unavailable' });
  }
  const localEventId = ingest.data.event_id;
  if (ingest.data.processed === true) {
    deps.log('webhook.duplicate', { event_id: eventId });
    return json(200, { status: 'duplicate' });
  }

  // error === null: durably classify the event as handled (processed).
  // error !== null: record a transient failure (stays unprocessed).
  const mark = async (result: string, error: string | null): Promise<boolean> => {
    const r = await deps.db.rpc('payment_mark_event', { p_event_id: localEventId, p_result: result, p_error: error });
    return r.ok;
  };
  const retry = () => json(503, { error: 'temporarily_unavailable' });
  // A deterministic outcome is acknowledged only once it is recorded.
  const settle = async (result: string, body: Record<string, string>) =>
    (await mark(result, null)) ? json(200, body) : retry();

  // Refund and other events are recorded and ignored: they never reach
  // the observation/settlement path, even when they embed a payment.
  if (!PAYMENT_EVENTS.has(eventType)) {
    deps.log('webhook.ignored', { event_id: eventId, event_type: eventType });
    return settle('ignored_event_type', { status: 'ignored' });
  }
  // A payment event whose payment id is absent or not a provider payment
  // id cannot be fetched, so it can never be applied: a deterministic
  // outcome, durably classified (the bounded audit payload is stored).
  if (!claimedPaymentId) {
    const result = paymentEntity && paymentEntity.id !== undefined ? 'unrecognised_payment_id' : 'missing_payment_id';
    deps.log('webhook.unusable_payment_event', { event_id: eventId, event_type: eventType, result });
    return settle(result, { status: 'ignored' });
  }

  // 5. fresh, trusted facts from the provider
  if (!deps.razorpay) {
    await mark('not_configured', 'razorpay credentials are not configured');
    deps.log('webhook.not_configured', { event_id: eventId });
    return retry();
  }
  const fetched = await deps.razorpay.fetchPayment(claimedPaymentId);
  if (fetched.kind === 'not_found') {
    // Signed by our webhook secret but unknown to our API key (e.g. a
    // test/live mix-up). Recorded; nothing to retry.
    deps.log('webhook.payment_not_found', { event_id: eventId, payment_id: claimedPaymentId });
    return settle('provider_payment_not_found', { status: 'ignored' });
  }
  if (fetched.kind === 'error') {
    deps.log('webhook.fetch_failed', { event_id: eventId, reason: fetched.reason, status: fetched.status ?? null });
    if (isPermanentFetchError(fetched)) return settle('provider_rejected_request', { status: 'ignored' });
    await mark('fetch_failed', `provider fetch failed: ${fetched.reason}${fetched.status ? ` (${fetched.status})` : ''}`);
    return retry();
  }
  const facts = parsePayment(fetched.payment, claimedPaymentId);
  if (!facts) {
    // A well-formed answer that is not a valid payment entity for this
    // id: retrying cannot change it. Durably classified, not applied.
    deps.log('webhook.invalid_provider_response', { event_id: eventId });
    return settle('invalid_provider_response', { status: 'ignored' });
  }

  // 6. merge + match + settle, and mark the event, atomically
  const applied = await applyObservation(deps.db, localEventId, facts);
  if (!applied.ok || !isRecord(applied.data)) {
    const code = applied.ok ? null : applied.code;
    deps.log('webhook.apply_failed', { event_id: eventId, status: applied.ok ? 200 : applied.status, code });
    if (!applied.ok && isDeterministicDbError(applied)) {
      return settle(`apply_rejected:${(code ?? '').toLowerCase()}`, { status: 'rejected' });
    }
    await mark('apply_failed', `observation failed (${code ?? (applied.ok ? 'invalid result' : applied.status)})`);
    return retry();
  }

  deps.log('webhook.processed', {
    event_id: eventId,
    payment_id: facts.id,
    matched: applied.data.matched === true,
    observation: str(applied.data.observation),
    settlement: str(applied.data.settlement),
  });
  return json(200, { status: 'processed' });
}
