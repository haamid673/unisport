// Razorpay webhook signature: HMAC-SHA256 of the RAW request body with
// the webhook secret, hex-encoded, in the X-Razorpay-Signature header.
// The body must not be parsed or re-serialised before verification.

const encoder = new TextEncoder();

export async function hmacSha256Hex(secret: string, data: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

// SHA-256 of a UTF-8 string, lower-case hex (the form the database stores).
export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time comparison of two strings of equal length.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const HEX_SIGNATURE = /^[0-9a-f]{64}$/;

// True when the signature matches the raw body under any configured
// secret (the current one, or the previous one during a rotation).
export async function verifyWebhookSignature(
  rawBody: Uint8Array<ArrayBuffer>,
  signatureHeader: string | null,
  secrets: string[],
): Promise<boolean> {
  if (!signatureHeader || secrets.length === 0) return false;
  const given = signatureHeader.trim().toLowerCase();
  if (!HEX_SIGNATURE.test(given)) return false;
  let ok = false;
  for (const secret of secrets) {
    const expected = await hmacSha256Hex(secret, rawBody);
    // Evaluate every secret; no early exit on a match.
    ok = timingSafeEqual(expected, given) || ok;
  }
  return ok;
}
