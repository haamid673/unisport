import { describe, it, expect, vi, afterEach } from 'vitest';
import { validateSupabaseConfig } from '../supabaseClient';

/** Build an unsigned JWT-shaped string with the given role claim. */
const jwtWithRole = (role: string) => {
  const b64 = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role })}.signature`;
};

/** The project is not `strict`, so narrow with `in` rather than `ok`. */
const reasonOf = (result: ReturnType<typeof validateSupabaseConfig>) =>
  'reason' in result ? result.reason : '';

describe('validateSupabaseConfig', () => {
  it('rejects a missing URL and key, naming both variables', () => {
    const result = validateSupabaseConfig(undefined, undefined);
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('VITE_SUPABASE_URL');
    expect(reasonOf(result)).toContain('VITE_SUPABASE_PUBLISHABLE_KEY');
    expect(reasonOf(result)).toContain('.env.local');
  });

  it('rejects a missing key only', () => {
    const result = validateSupabaseConfig('http://127.0.0.1:54321', '  ');
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('VITE_SUPABASE_PUBLISHABLE_KEY');
    expect(reasonOf(result)).not.toContain('VITE_SUPABASE_URL is missing');
  });

  it('rejects a malformed URL and non-http protocols', () => {
    expect(validateSupabaseConfig('not a url', 'sb_publishable_x').ok).toBe(false);
    expect(validateSupabaseConfig('ftp://example.com', 'sb_publishable_x').ok).toBe(false);
  });

  it('refuses a secret key', () => {
    const result = validateSupabaseConfig('http://127.0.0.1:54321', 'sb_secret_abc123');
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/secret|service-role/i);
  });

  it('refuses a service_role JWT but accepts an anon JWT', () => {
    expect(
      validateSupabaseConfig('http://127.0.0.1:54321', jwtWithRole('service_role')).ok
    ).toBe(false);
    expect(
      validateSupabaseConfig('http://127.0.0.1:54321', jwtWithRole('anon')).ok
    ).toBe(true);
  });

  it('accepts a publishable key and normalises the URL', () => {
    const result = validateSupabaseConfig(
      ' https://project.supabase.co/ ',
      'sb_publishable_abc'
    );
    expect(result).toEqual({
      ok: true,
      url: 'https://project.supabase.co',
      key: 'sb_publishable_abc'
    });
  });

  it('never echoes the key in its error messages', () => {
    const result = validateSupabaseConfig('bad url', 'sb_secret_TOPSECRETVALUE');
    expect(JSON.stringify(result)).not.toContain('TOPSECRETVALUE');
  });
});

describe('module with no environment configured', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('exposes a clear error and refuses to hand out a client', async () => {
    // Hermetic: a developer's real .env.local must not change the result.
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', '');
    vi.resetModules();

    const fresh = await import('../supabaseClient');

    expect(fresh.supabaseConfigError).toContain('VITE_SUPABASE_URL');
    expect(() => fresh.getSupabase()).toThrow(/not configured/i);
  });
});
