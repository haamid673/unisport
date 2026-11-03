// Guards of the test-only browser checkout tooling. No server is started,
// no network is used: the Vite config function and the harness's start-up
// checks are exercised directly.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Plugin, ResolvedConfig, UserConfig } from 'vite';
import config from './vite.config';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const GOOD = {
  VITE_SUPABASE_URL: 'http://127.0.0.1:59401',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'dummy-anon-key',
  VITE_RAZORPAY_TEST_KEY_ID: 'rzp_test_LOCALSIMULATORONLY',
};

function envDir(vars: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-e2e-guard-'));
  fs.writeFileSync(path.join(dir, '.env.local'), Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n'));
  return dir;
}

type ConfigFn = (env: { command: 'serve' | 'build'; mode: string; isPreview?: boolean }) => UserConfig;
const run = (env: Parameters<ConfigFn>[0]) => (config as unknown as ConfigFn)(env);
// Vite's loadEnv lets ambient VITE_* variables override the env file, and
// vitest loads the repo's own .env.local into process.env. Each test must
// see only the env dir it writes, so ambient VITE_* variables are set aside.
const savedDir = process.env.BROWSER_E2E_ENV_DIR;
const savedVite = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('VITE_')));
beforeEach(() => {
  for (const k of Object.keys(savedVite)) delete process.env[k];
});
afterEach(() => {
  if (savedDir === undefined) delete process.env.BROWSER_E2E_ENV_DIR;
  else process.env.BROWSER_E2E_ENV_DIR = savedDir;
  for (const [k, v] of Object.entries(savedVite)) process.env[k] = v;
});

describe('test-only Vite config', () => {
  it('serves the disposable stack on 127.0.0.1 with the mock injected', () => {
    process.env.BROWSER_E2E_ENV_DIR = envDir(GOOD);
    const c = run({ command: 'serve', mode: 'development' });
    expect(c.server).toMatchObject({ host: '127.0.0.1', port: 3000, strictPort: true });
    const plugin = (c.plugins as Plugin[]).find(p => p && p.name === 'browser-e2e-mock-checkout')!;
    expect(plugin.apply).toBe('serve');
  });

  it('refuses a build, a preview, an env dir inside the repo, another backend or another key', () => {
    process.env.BROWSER_E2E_ENV_DIR = envDir(GOOD);
    expect(() => run({ command: 'build', mode: 'production' })).toThrow(/never a build/);
    expect(() => run({ command: 'serve', mode: 'production', isPreview: true })).toThrow(/never a build or preview/);
    process.env.BROWSER_E2E_ENV_DIR = HERE;
    expect(() => run({ command: 'serve', mode: 'development' })).toThrow(/outside the repository/);
    delete process.env.BROWSER_E2E_ENV_DIR;
    expect(() => run({ command: 'serve', mode: 'development' })).toThrow(/outside the repository/);
    for (const url of ['http://127.0.0.1:54321', 'https://abcdefghijklmnopqrst.supabase.co', 'http://localhost:59401']) {
      process.env.BROWSER_E2E_ENV_DIR = envDir({ ...GOOD, VITE_SUPABASE_URL: url });
      expect(() => run({ command: 'serve', mode: 'development' }), url).toThrow(/VITE_SUPABASE_URL must be/);
    }
    process.env.BROWSER_E2E_ENV_DIR = envDir({ ...GOOD, VITE_RAZORPAY_TEST_KEY_ID: 'rzp_test_DUMMYKEY0001' });
    expect(() => run({ command: 'serve', mode: 'development' })).toThrow(/VITE_RAZORPAY_TEST_KEY_ID must be/);
  });

  it('refuses a CLI host override (the mock-injected app never leaves loopback)', () => {
    process.env.BROWSER_E2E_ENV_DIR = envDir(GOOD);
    const c = run({ command: 'serve', mode: 'development' });
    const plugin = (c.plugins as Plugin[]).find(p => p && p.name === 'browser-e2e-mock-checkout')!;
    const resolved = (host: unknown) => ({ server: { host } }) as unknown as ResolvedConfig;
    const hook = plugin.configResolved as (r: ResolvedConfig) => void;
    expect(() => hook(resolved('127.0.0.1'))).not.toThrow();
    for (const host of ['0.0.0.0', true, 'localhost', '192.168.1.5', undefined]) {
      expect(() => hook(resolved(host)), String(host)).toThrow(/127\.0\.0\.1 only/);
    }
  });
});

describe('harness start-up guard', () => {
  const harness = path.join(HERE, 'harness.ts');
  const runHarness = (env: Record<string, string>) => {
    try {
      execFileSync(process.execPath, [harness, 'ids'], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: 'pipe' });
      return { code: 0, err: '' };
    } catch (e) {
      const x = e as { status: number; stderr: Buffer };
      return { code: x.status, err: x.stderr.toString() };
    }
  };

  it('refuses any target but the disposable stack, before doing anything', () => {
    for (const url of ['http://127.0.0.1:54321', 'https://abcdefghijklmnopqrst.supabase.co', 'http://127.0.0.1:59401/']) {
      const r = runHarness({ BROWSER_E2E_SUPABASE_URL: url, BROWSER_E2E_SERVICE_KEY: 'dummy', BROWSER_E2E_STATE_FILE: '/nonexistent' });
      expect(r.code, url).not.toBe(0);
      expect(r.err, url).toMatch(/must be exactly http:\/\/127\.0\.0\.1:59401/);
    }
    expect(runHarness({}).err).toMatch(/BROWSER_E2E_SUPABASE_URL is not set/);
  });
});
