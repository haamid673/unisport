// Database and auth access for the payment Edge Functions, over plain
// HTTP (PostgREST RPC and GoTrue), so no client library is needed.
//
// rpc() uses the service_role key: the slice 1b SQL functions are
// executable by service_role only. getUserId() validates the CALLER's
// JWT with GoTrue; the Edge Function never trusts a user id from the
// request body.

import type { PaymentConfig } from './config.ts';
import { isRecord, UUID } from './http.ts';
import type { FetchFn } from './razorpay.ts';

export type RpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string | null };

export interface Database {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>>;
}

export interface Auth {
  getUserId(accessToken: string): Promise<string | null>;
}

export function createDatabase(config: PaymentConfig, fetch: FetchFn): Database {
  return {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>> {
      let res: Response;
      try {
        res = await fetch(`${config.supabaseUrl}/rest/v1/rpc/${fn}`, {
          method: 'POST',
          headers: {
            apikey: config.serviceRoleKey,
            Authorization: `Bearer ${config.serviceRoleKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        return { ok: false, status: 0, code: 'network' };
      }
      const text = await res.text();
      let body: unknown;
      try {
        body = text === '' ? null : JSON.parse(text);
      } catch {
        return { ok: false, status: res.status, code: 'invalid_json' };
      }
      if (!res.ok) {
        const code = isRecord(body) && typeof body.code === 'string' ? body.code : null;
        return { ok: false, status: res.status, code };
      }
      return { ok: true, data: body as T };
    },
  };
}

export function createAuth(config: PaymentConfig, fetch: FetchFn): Auth {
  return {
    async getUserId(accessToken: string): Promise<string | null> {
      let res: Response;
      try {
        res = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
          headers: { apikey: config.anonKey, Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        return null;
      }
      if (res.status !== 200) {
        await res.body?.cancel();
        return null;
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return null;
      }
      if (!isRecord(body) || typeof body.id !== 'string' || !UUID.test(body.id)) return null;
      return body.id;
    },
  };
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const m = /^Bearer\s+([A-Za-z0-9._~+/=_-]{20,4096})$/.exec(header.trim());
  return m ? m[1] : null;
}

// Failure classes for an RPC that did not succeed.
//
//   deterministic  the database rejected the INPUT or a constraint:
//                  SQLSTATE class 22 (data exception, including our
//                  22023 invalid-parameter checks) and class 23
//                  (integrity constraint violation). Retrying the same
//                  call cannot succeed.
//   transient      everything else: network errors, PostgREST
//                  connection errors, serialization failures (40001,
//                  including the concurrent-association race), deadlocks
//                  (40P01), lock/statement timeouts, server errors, and
//                  unknown codes. Payment facts are never dropped on an
//                  error we cannot positively classify as permanent.
export function isDeterministicDbError(result: { ok: false; status: number; code: string | null }): boolean {
  return result.code !== null && /^(22|23)[0-9A-Z]{3}$/.test(result.code);
}
