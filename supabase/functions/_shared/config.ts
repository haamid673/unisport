// Server-only configuration for the payment Edge Functions.
//
// Every value here comes from the Edge Function environment (Supabase
// local secrets / `supabase functions serve --env-file`), never from a
// VITE_* variable and never from the request. Nothing in this module is
// ever returned to a client or logged, except the PUBLIC key id.

export interface PaymentConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  anonKey: string;
  razorpay: RazorpayCredentials | null;
  webhookSecrets: string[];
  razorpayApiBase: string;
  /** True only in local simulator mode (see readConfig); absent means false. */
  simulator?: boolean;
}

export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
}

export type EnvGetter = (name: string) => string | undefined;

const KEY_ID = /^rzp_(test|live)_[A-Za-z0-9]{1,64}$/;

/** The only provider API the real integration may call. */
export const RAZORPAY_API = 'https://api.razorpay.com';

// ------------------------------------------------------------------
// Local payment simulator mode
// ------------------------------------------------------------------
//
// Enabled ONLY by PAYMENT_SIMULATOR=local-only (exactly; any other
// non-empty value is a misconfiguration and disables payments). Then
// every condition below must hold, or payments are disabled (fail
// closed: razorpay null, so no provider call is made):
//
//   SUPABASE_URL       one of the local gateways in LOCAL_SUPABASE_URL:
//                      http://kong:8000 (what `supabase functions serve`
//                      injects inside the Edge Runtime) or http://127.0.0.1
//                      / http://localhost with an explicit port (a host
//                      process, e.g. tests against the local gateway).
//                      On Supabase Cloud the platform sets
//                      https://<ref>.supabase.co, which never matches. A
//                      SELF-HOSTED Supabase (docker compose) also uses
//                      http://kong:8000, so there this guard only stops
//                      ACCIDENTAL enabling: an operator who deliberately
//                      sets every value below (and runs the simulator on
//                      that host) would enable it. Never do that.
//   RAZORPAY_API_BASE  exactly one of SIMULATOR_API_ORIGINS (plain http,
//                      dedicated port SIMULATOR_PORT): host.docker.internal
//                      is the host as seen from the Edge Runtime container;
//                      127.0.0.1 / localhost from a host process.
//   RAZORPAY_KEY_ID    exactly SIMULATOR_KEY_ID (not a Razorpay key).
//   RAZORPAY_KEY_SECRET unset or exactly SIMULATOR_KEY_SECRET; the
//                      placeholder is what is sent, so a real secret can
//                      never reach the simulator.
//   RAZORPAY_ALLOW_LIVE_KEYS unset.
//
// The placeholder key id is refused outside simulator mode.

export const SIMULATOR_FLAG = 'local-only';
export const SIMULATOR_PORT = 59480;
export const SIMULATOR_API_ORIGINS: readonly string[] = [
  `http://host.docker.internal:${SIMULATOR_PORT}`,
  `http://127.0.0.1:${SIMULATOR_PORT}`,
  `http://localhost:${SIMULATOR_PORT}`,
];
/** Placeholder credentials for the simulator; deliberately not Razorpay-shaped beyond the prefix. */
export const SIMULATOR_KEY_ID = 'rzp_test_LOCALSIMULATORONLY';
export const SIMULATOR_KEY_SECRET = 'local-simulator-placeholder-not-a-secret';

const LOCAL_SUPABASE_URL = /^http:\/\/(?:kong:8000|(?:127\.0\.0\.1|localhost):([1-9][0-9]{0,4}))$/;

function nonEmpty(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

// An origin given in the environment, compared as an exact string (one
// trailing slash tolerated). Anything else (a path, a query, a fragment,
// user info, another spelling of the host) does not match.
function exactOrigin(raw: string, allowed: readonly string[]): boolean {
  return allowed.includes(raw.endsWith('/') ? raw.slice(0, -1) : raw);
}

function isLocalSupabaseUrl(url: string): boolean {
  const m = LOCAL_SUPABASE_URL.exec(url);
  return m !== null && (m[1] === undefined || Number(m[1]) <= 65535);
}

// Razorpay test-mode keys only, unless live keys are explicitly allowed
// for a deployment (this slice never sets that flag).
function readRazorpay(get: EnvGetter): RazorpayCredentials | null {
  const keyId = nonEmpty(get('RAZORPAY_KEY_ID'));
  const keySecret = nonEmpty(get('RAZORPAY_KEY_SECRET'));
  if (!keyId || !keySecret || !KEY_ID.test(keyId)) return null;
  if (keyId === SIMULATOR_KEY_ID) return null;
  if (keyId.startsWith('rzp_live_') && get('RAZORPAY_ALLOW_LIVE_KEYS') !== 'true') return null;
  return { keyId, keySecret };
}

// The real provider API: unset, or exactly https://api.razorpay.com.
// Anything else is refused (null), never silently replaced.
function readApiBase(get: EnvGetter): string | null {
  const raw = nonEmpty(get('RAZORPAY_API_BASE'));
  if (raw === undefined) return RAZORPAY_API;
  return exactOrigin(raw, [RAZORPAY_API]) ? RAZORPAY_API : null;
}

// Simulator mode: every condition, or nothing (see the header above).
function readSimulator(get: EnvGetter, supabaseUrl: string): { credentials: RazorpayCredentials; apiBase: string } | null {
  if (!isLocalSupabaseUrl(supabaseUrl)) return null;
  const apiBase = nonEmpty(get('RAZORPAY_API_BASE'));
  if (apiBase === undefined || !exactOrigin(apiBase, SIMULATOR_API_ORIGINS)) return null;
  if (nonEmpty(get('RAZORPAY_KEY_ID')) !== SIMULATOR_KEY_ID) return null;
  const secret = nonEmpty(get('RAZORPAY_KEY_SECRET'));
  if (secret !== undefined && secret !== SIMULATOR_KEY_SECRET) return null;
  if (get('RAZORPAY_ALLOW_LIVE_KEYS') !== undefined && get('RAZORPAY_ALLOW_LIVE_KEYS') !== '') return null;
  return {
    credentials: { keyId: SIMULATOR_KEY_ID, keySecret: SIMULATOR_KEY_SECRET },
    apiBase: apiBase.endsWith('/') ? apiBase.slice(0, -1) : apiBase,
  };
}

export function readConfig(get: EnvGetter): PaymentConfig {
  const secrets = [get('RAZORPAY_WEBHOOK_SECRET'), get('RAZORPAY_WEBHOOK_SECRET_PREVIOUS')]
    .map(nonEmpty)
    .filter((s): s is string => s !== undefined);
  const supabaseUrl = (nonEmpty(get('SUPABASE_URL')) ?? '').replace(/\/+$/, '');
  const base = {
    supabaseUrl,
    serviceRoleKey: nonEmpty(get('SUPABASE_SERVICE_ROLE_KEY')) ?? '',
    anonKey: nonEmpty(get('SUPABASE_ANON_KEY')) ?? '',
    webhookSecrets: secrets,
  };
  // Payments disabled: no credentials, so no provider call is ever made.
  const disabled: PaymentConfig = { ...base, razorpay: null, razorpayApiBase: RAZORPAY_API, simulator: false };

  const flag = get('PAYMENT_SIMULATOR');
  if (flag === SIMULATOR_FLAG) {
    const sim = readSimulator(get, supabaseUrl);
    return sim ? { ...base, razorpay: sim.credentials, razorpayApiBase: sim.apiBase, simulator: true } : disabled;
  }
  // any other value (a typo, "true", different case or spacing) is not
  // the flag: refuse rather than guess which mode was meant
  if (flag !== undefined && flag !== '') return disabled;

  const apiBase = readApiBase(get);
  if (apiBase === null) return disabled;
  return { ...base, razorpay: readRazorpay(get), razorpayApiBase: apiBase, simulator: false };
}

export function hasDatabase(config: PaymentConfig): boolean {
  return config.supabaseUrl !== '' && config.serviceRoleKey !== '' && config.anonKey !== '';
}
