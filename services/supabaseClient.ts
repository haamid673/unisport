import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * The single Supabase client for the browser.
 *
 * Configuration comes from Vite environment variables:
 *
 *   VITE_SUPABASE_URL
 *   VITE_SUPABASE_PUBLISHABLE_KEY
 *
 * Only the publishable (anon) key belongs in the browser. Every
 * variable prefixed VITE_ is embedded in the shipped JavaScript, so a
 * service-role or secret key must never be configured here; this
 * module refuses to start if it recognises one.
 */

export const SUPABASE_ENV_HELP =
  'Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.local ' +
  '(see .env.example), then restart the dev server.';

export type SupabaseConfigResult =
  | { ok: true; url: string; key: string }
  | { ok: false; reason: string };

/** Decode a JWT payload without verifying it (only used to refuse privileged keys). */
function decodeJwtRole(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return typeof payload?.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

/**
 * Validate the values read from the environment. Pure so it can be
 * tested without a browser or a running Supabase.
 */
export function validateSupabaseConfig(
  rawUrl: unknown,
  rawKey: unknown
): SupabaseConfigResult {
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  const key = typeof rawKey === 'string' ? rawKey.trim() : '';

  if (!url || !key) {
    const missing = [
      !url ? 'VITE_SUPABASE_URL' : null,
      !key ? 'VITE_SUPABASE_PUBLISHABLE_KEY' : null
    ].filter(Boolean).join(' and ');

    return {
      ok: false,
      reason: `Supabase is not configured: ${missing} ${
        missing.includes(' and ') ? 'are' : 'is'
      } missing. ${SUPABASE_ENV_HELP}`
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      reason: `VITE_SUPABASE_URL is not a valid URL. ${SUPABASE_ENV_HELP}`
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: `VITE_SUPABASE_URL must start with http:// or https://. ${SUPABASE_ENV_HELP}`
    };
  }

  // Refuse privileged keys: anything in a VITE_* variable is public.
  if (key.startsWith('sb_secret_') || decodeJwtRole(key) === 'service_role') {
    return {
      ok: false,
      reason:
        'VITE_SUPABASE_PUBLISHABLE_KEY contains a secret or service-role key. ' +
        'Those must never reach the browser. Use the publishable (anon) key instead.'
    };
  }

  return { ok: true, url: parsed.toString().replace(/\/$/, ''), key };
}

const config = validateSupabaseConfig(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
);

/** Null when configuration is valid; otherwise a human-readable reason. */
export const supabaseConfigError: string | null =
  'reason' in config ? config.reason : null;

const client: SupabaseClient | null = 'url' in config
  ? createClient(config.url, config.key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    })
  : null;

/**
 * The shared client. Throws a clear error when Supabase is not
 * configured; callers that render UI should check
 * `supabaseConfigError` first and show it instead.
 */
export function getSupabase(): SupabaseClient {
  if (!client) {
    throw new Error(supabaseConfigError ?? `Supabase is not configured. ${SUPABASE_ENV_HELP}`);
  }
  return client;
}
