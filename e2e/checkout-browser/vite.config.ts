// TEST-ONLY Vite dev-server config for the local browser checkout run
// (see README.md). It serves the real app with one addition: the mock
// Checkout (mock-checkout.js) is injected before the app on EVERY page
// load, so the app's loader never fetches checkout.razorpay.com.
//
// Refuses to build, refuses any backend but the disposable stack, binds
// to 127.0.0.1 only. Env comes from BROWSER_E2E_ENV_DIR (outside the repo).

import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const ROOT = path.resolve(__dirname, '../..');
const DISPOSABLE_STACK = 'http://127.0.0.1:59401';
const SIMULATOR_KEY_ID = 'rzp_test_LOCALSIMULATORONLY';

export default defineConfig(({ command, mode, isPreview }) => {
  if (command !== 'serve' || isPreview) {
    throw new Error('e2e/checkout-browser/vite.config.ts is for the local dev server only (never a build or preview)');
  }
  const envDir = process.env.BROWSER_E2E_ENV_DIR;
  if (!envDir || path.resolve(envDir).startsWith(ROOT)) {
    throw new Error('BROWSER_E2E_ENV_DIR must point to a directory outside the repository');
  }
  const env = loadEnv(mode, envDir, 'VITE_');
  if (env.VITE_SUPABASE_URL !== DISPOSABLE_STACK) throw new Error(`VITE_SUPABASE_URL must be ${DISPOSABLE_STACK}`);
  if (env.VITE_RAZORPAY_TEST_KEY_ID !== SIMULATOR_KEY_ID) throw new Error(`VITE_RAZORPAY_TEST_KEY_ID must be ${SIMULATOR_KEY_ID}`);

  const mock = fs.readFileSync(path.join(__dirname, 'mock-checkout.js'), 'utf8');
  const injectMock: Plugin = {
    name: 'browser-e2e-mock-checkout',
    apply: 'serve',
    // A CLI flag (--host, --host 0.0.0.0) overrides server.host; refuse
    // anything but loopback so the mock-injected app is never on the LAN.
    configResolved(resolved) {
      if (resolved.server.host !== '127.0.0.1') {
        throw new Error(`the browser E2E server must bind to 127.0.0.1 only (got ${String(resolved.server.host)})`);
      }
    },
    transformIndexHtml: {
      order: 'pre',
      handler: () => [{ tag: 'script', children: mock, injectTo: 'head-prepend' }],
    },
  };

  return {
    root: ROOT,
    envDir,
    base: '/',
    server: { host: '127.0.0.1', port: 3000, strictPort: true },
    plugins: [injectMock, react()],
    resolve: { alias: { '@': ROOT } },
  };
});
