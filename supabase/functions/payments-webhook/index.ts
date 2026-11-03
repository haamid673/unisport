// Edge Function entry point: verified Razorpay webhook receiver.
// All logic is in ../_shared/webhook.ts (unit-tested with mocks).
// JWT verification is disabled for this function in config.toml: the
// caller is Razorpay, authenticated by the webhook signature instead.

import { readConfig } from '../_shared/config.ts';
import { consoleLogger } from '../_shared/http.ts';
import { createRazorpayClient } from '../_shared/razorpay.ts';
import { createDatabase } from '../_shared/supabase.ts';
import { handleWebhook } from '../_shared/webhook.ts';

const config = readConfig((name) => Deno.env.get(name));

Deno.serve((req) =>
  handleWebhook(req, {
    config,
    db: createDatabase(config, fetch),
    razorpay: config.razorpay
      ? createRazorpayClient({ credentials: config.razorpay, apiBase: config.razorpayApiBase, fetch })
      : null,
    log: consoleLogger,
  })
);
