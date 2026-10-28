// Edge Function entry point: authenticated payment verification.
// All logic is in ../_shared/verify.ts (unit-tested with mocks).

import { readConfig } from '../_shared/config.ts';
import { consoleLogger } from '../_shared/http.ts';
import { createRazorpayClient } from '../_shared/razorpay.ts';
import { createAuth, createDatabase } from '../_shared/supabase.ts';
import { handleVerify } from '../_shared/verify.ts';

const config = readConfig((name) => Deno.env.get(name));

Deno.serve((req) =>
  handleVerify(req, {
    config,
    db: createDatabase(config, fetch),
    auth: createAuth(config, fetch),
    razorpay: config.razorpay
      ? createRazorpayClient({ credentials: config.razorpay, apiBase: config.razorpayApiBase, fetch })
      : null,
    log: consoleLogger,
  })
);
