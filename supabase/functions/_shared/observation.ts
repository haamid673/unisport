// The single path by which provider payment facts reach the database:
// payment_apply_observation (merge, identity-checked match, settlement
// under the booking -> attempt -> payment lock order, READ COMMITTED).
// Used by the webhook and by the verification endpoint, so there is
// exactly one settlement implementation.

import type { RazorpayPaymentFacts } from './razorpay.ts';
import type { Database, RpcResult } from './supabase.ts';

export function applyObservation(
  db: Database,
  eventId: string | null,
  facts: RazorpayPaymentFacts,
): Promise<RpcResult<Record<string, unknown>>> {
  return db.rpc<Record<string, unknown>>('payment_apply_observation', {
    p_event_id: eventId,
    p_provider_payment_id: facts.id,
    p_provider_order_id: facts.order_id,
    p_status: facts.status,
    p_amount_paise: facts.amount,
    p_currency: facts.currency,
    p_amount_refunded_paise: facts.amount_refunded,
    p_provider_created_at: facts.created_at === null ? null : new Date(facts.created_at * 1000).toISOString(),
    p_error_code: facts.error_code,
    p_error_description: facts.error_description,
  });
}

// A provider fetch error is permanent only when the provider rejected
// the request itself (HTTP 400 other than "does not exist", which is
// classified separately). Timeouts, network errors, 429, 5xx, an
// unreadable body and credential errors (401/403: a configuration
// problem that an operator fixes) are all retried.
export function isPermanentFetchError(err: { reason: string; status?: number }): boolean {
  return err.status === 400;
}
