import { defineConfig } from '@playwright/test';

// On-demand browser smoke test (see smoke.pw.ts). It uses the Chrome already
// installed on the machine, so no browser is downloaded. Not part of `npm test`.
export default defineConfig({
  testDir: '.',
  testMatch: '*.pw.ts',
  timeout: 90_000,
  workers: 1,
  reporter: 'list',
  outputDir: '/tmp/unisport-smoke-results',
  use: {
    channel: 'chrome',
    baseURL: process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3000',
    viewport: { width: 1280, height: 900 }
  }
});
