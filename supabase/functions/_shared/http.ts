// Small HTTP helpers shared by the payment Edge Functions.

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export class BodyTooLarge extends Error {}

// Reads the request body as bytes, refusing more than maxBytes without
// buffering the rest. The exact bytes are returned (the webhook
// signature is verified over them).
export async function readBodyLimited(req: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = req.headers.get('content-length');
  if (declared !== null) {
    const n = Number(declared);
    if (!Number.isFinite(n) || n < 0 || n > maxBytes) throw new BodyTooLarge();
  }
  if (!req.body) return new Uint8Array(0);

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Structured, allow-listed log line. Callers pass only identifiers and
// outcome codes; never credentials, signatures, headers or bodies.
export type LogFields = Record<string, string | number | boolean | null | undefined>;
export type Logger = (event: string, fields?: LogFields) => void;

export const consoleLogger: Logger = (event, fields = {}) => {
  console.log(JSON.stringify({ event, ...fields }));
};
