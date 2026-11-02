import { describe, it, expect } from 'vitest';
import {
  checkEnvExample,
  checkMigrationAppendOnly,
  checkMigrationNames,
  checkTrackedFiles,
  jwtRole,
  scanBuiltFile,
  scanForHostedCommands,
  scanForSecrets
} from './repoGuards';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (role: string) => `${b64({ alg: 'HS256' })}.${b64({ role })}.${'x'.repeat(20)}`;

describe('migration guards', () => {
  it('accepts well-formed, increasing names', () => {
    expect(checkMigrationNames(['20261008135629_foundation.sql', '20261010175500_x.sql'])).toEqual([]);
  });

  it('flags a malformed name and a duplicated timestamp', () => {
    const f = checkMigrationNames(['foundation.sql', '20261008135629_a.sql', '20261008135629_b.sql', '2026_c.sql']);
    expect(f.map(x => x.file).sort()).toEqual(['20261008135629_b.sql', '2026_c.sql', 'foundation.sql']);
  });

  it('is append-only against the base: no removal, rename or back-dated addition', () => {
    const base = ['20261008135629_a.sql', '20261010175500_b.sql'];
    expect(checkMigrationAppendOnly(base, [...base, '20261011000000_c.sql'])).toEqual([]);
    expect(checkMigrationAppendOnly(base, ['20261008135629_a.sql'])[0].message).toMatch(/removed or renamed/);
    expect(checkMigrationAppendOnly(base, [...base, '20261009000000_c.sql'])[0].message).toMatch(/sort after the latest/);
  });
});

describe('secret scan', () => {
  it('flags private keys, secret keys, live keys and service_role JWTs', () => {
    expect(scanForSecrets('a.ts', '-----BEGIN PRIVATE KEY-----\nabc')).toHaveLength(1);
    expect(scanForSecrets('a.ts', 'const k = "sb_secret_abcdefghij1234"')).toHaveLength(1);
    expect(scanForSecrets('a.ts', 'key: rzp_live_AbC123xyz9')).toHaveLength(1);
    expect(scanForSecrets('a.ts', `const t = "${jwt('service_role')}"`)).toHaveLength(1);
  });

  it('allows an anon JWT, test keys and ordinary text', () => {
    expect(scanForSecrets('a.ts', `const t = "${jwt('anon')}"`)).toEqual([]);
    expect(scanForSecrets('a.ts', 'rzp_test_LOCALSIMULATORONLY')).toEqual([]);
    expect(scanForSecrets('a.ts', 'service_role is a Postgres role')).toEqual([]);
  });

  it('exempts tests and docs that mention the patterns to assert they are refused', () => {
    expect(scanForSecrets('services/__tests__/x.test.ts', 'rzp_live_AbC123xyz9')).toEqual([]);
    expect(scanForSecrets('supabase/payment-simulator/simulator_test.ts', 'rzp_live_AbC123xyz9')).toEqual([]);
    expect(scanForSecrets('docs/x.md', 'sb_secret_abcdefghij1234')).toEqual([]);
  });

  it('jwtRole never throws on junk', () => {
    expect(jwtRole('nope')).toBeNull();
    expect(jwtRole('a.b.c')).toBeNull();
    expect(jwtRole(jwt('anon'))).toBe('anon');
  });
});

describe('hosted guard', () => {
  it('flags commands that can reach a hosted project, in workflows, scripts and package.json', () => {
    expect(scanForHostedCommands('.github/workflows/ci.yml', 'run: supabase link --project-ref abc')).toHaveLength(2);
    expect(scanForHostedCommands('.github/workflows/ci.yml', 'run: supabase db push')).toHaveLength(1);
    expect(scanForHostedCommands('scripts/x.sh', 'supabase test db --linked')).toHaveLength(1);
    expect(scanForHostedCommands('package.json', '"x": "supabase migration repair 1"')).toHaveLength(1);
  });

  it('ignores comments that say what is forbidden, other files, and its own source', () => {
    expect(scanForHostedCommands('.github/workflows/ci.yml', '# never run supabase db push here\nrun: npm ci')).toEqual([]);
    expect(scanForHostedCommands('README.md', 'supabase link')).toEqual([]);
    expect(scanForHostedCommands('scripts/repoGuards.ts', 'supabase link')).toEqual([]);
  });

  it('flags a tracked project link or env file, but not .env.example', () => {
    expect(checkTrackedFiles(['supabase/.temp/project-ref', '.env.local', '.env', 'src/a.ts']).map(f => f.file))
      .toEqual(['supabase/.temp/project-ref', '.env.local', '.env']);
    expect(checkTrackedFiles(['.env.example'])).toEqual([]);
  });
});

describe('env and dist guards', () => {
  it('flags a secret-looking VITE_ name', () => {
    expect(checkEnvExample('VITE_SUPABASE_URL=x\n# VITE_RAZORPAY_TEST_KEY_ID=rzp_test\n')).toEqual([]);
    expect(checkEnvExample('VITE_SERVICE_ROLE_KEY=abc')).toHaveLength(1);
    expect(checkEnvExample('VITE_API_TOKEN=abc')).toHaveLength(1);
  });

  it('flags a built file that depends on a third-party CDN', () => {
    expect(scanBuiltFile('dist/index.html', '<script src="https://cdn.tailwindcss.com"></script>')).toHaveLength(1);
    expect(scanBuiltFile('dist/a.css', '@import url(https://fonts.googleapis.com/css2?x)')).toHaveLength(1);
    expect(scanBuiltFile('dist/a.js', 'src:"https://images.unsplash.com/photo-1"')).toHaveLength(1);
    expect(scanBuiltFile('dist/index.html', '<script src="/assets/index-abc.js"></script>')).toEqual([]);
  });
});
