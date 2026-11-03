// Edge Function entry point: trusted Razorpay order creation.
// All logic is in ../_shared/create_order.ts (unit-tested with mocks).

import { readConfig } from '../_shared/config.ts';
import { handleCreateOrder } from '../_shared/create_order.ts';
import { consoleLogger } from '../_shared/http.ts';
import { createRazorpayClient } from '../_shared/razorpay.ts';
import { createAuth, createDatabase } from '../_shared/supabase.ts';

const config = readConfig((name) => Deno.env.get(name));

Deno.serve((req) =>
  handleCreateOrder(req, {
    config,
    db: createDatabase(config, fetch),
    auth: createAuth(config, fetch),
    razorpay: config.razorpay
      ? createRazorpayClient({ credentials: config.razorpay, apiBase: config.razorpayApiBase, fetch })
      : null,
    log: consoleLogger,
  })
);
