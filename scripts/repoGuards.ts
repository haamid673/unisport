/**
 * Repository guards: cheap checks that fail CI before a mistake ships.
 *
 *   migrations   file names are well formed and strictly increasing
 *   secrets      no private keys or live/secret keys in tracked files
 *   hosted       nothing links to, pushes to or repairs a hosted project
 *   env          no VITE_ variable name suggests a secret
 *   dist         (after a build) no third-party CDN style or script
 *
 * The pure functions here are unit-tested (scripts/repoGuards.test.ts);
 * scripts/repo-guards.ts only reads the repository and reports.
 */

export interface Finding {
  guard: string;
  file: string;
  message: string;
}

// -- migrations ---------------------------------------------------------

const MIGRATION_NAME = /^(\d{14})_[a-z0-9_]+\.sql$/;

export function checkMigrationNames(names: string[]): Finding[] {
  const findings: Finding[] = [];
  const sorted = [...names].sort();
  let previous = '';

  for (const name of sorted) {
    const m = MIGRATION_NAME.exec(name);
    if (!m) {
      findings.push({ guard: 'migrations', file: name, message: 'name must be <14-digit timestamp>_<snake_case>.sql' });
      continue;
    }
    if (m[1] === previous) {
      findings.push({ guard: 'migrations', file: name, message: `timestamp ${m[1]} is used by more than one migration` });
    }
    previous = m[1];
  }
  return findings;
}

/**
 * A migration that was already on the base branch must not be edited, and a
 * new one must sort after every existing one. `baseNames` are the
 * migrations on the base; `names` the ones now.
 */
export function checkMigrationAppendOnly(baseNames: string[], names: string[]): Finding[] {
  const findings: Finding[] = [];
  const now = new Set(names);

  for (const base of baseNames) {
    if (!now.has(base)) {
      findings.push({ guard: 'migrations', file: base, message: 'an existing migration was removed or renamed' });
    }
  }

  const newest = [...baseNames].sort().pop() ?? '';
  for (const name of names) {
    if (!baseNames.includes(name) && name <= newest) {
      findings.push({ guard: 'migrations', file: name, message: `a new migration must sort after the latest existing one (${newest})` });
    }
  }
  return findings;
}

// -- secrets ------------------------------------------------------------

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'Supabase secret key', re: /\bsb_secret_[A-Za-z0-9_-]{10,}/ },
  { name: 'live Razorpay key', re: /\brzp_live_[A-Za-z0-9]{6,}/ },
  { name: 'live Stripe-style secret key', re: /\bsk_live_[A-Za-z0-9]{10,}/ }
];

/** The role claim of a JWT-shaped string, or null. Never throws. */
export function jwtRole(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const role = (JSON.parse(json) as { role?: unknown }).role;
    return typeof role === 'string' ? role : null;
  } catch {
    return null;
  }
}

/** Files that legitimately mention these patterns (they test that they are refused). */
export const SECRET_SCAN_EXEMPT = [
  /(^|\/)scripts\/repoGuards\.(test\.)?ts$/,
  /(^|\/)__tests__\//,
  /\.test\.[cm]?[tj]sx?$/,
  /_test\.[tj]s$/,
  /(^|\/)supabase\/(tests|functions\/tests)\//,
  /^docs\//,
  /\.md$/,
  /(^|\/)package-lock\.json$/
];

export function scanForSecrets(file: string, content: string): Finding[] {
  if (SECRET_SCAN_EXEMPT.some(re => re.test(file))) return [];

  const findings: Finding[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(content)) findings.push({ guard: 'secrets', file, message: `looks like a ${name}` });
  }
  for (const token of content.match(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g) ?? []) {
    if (jwtRole(token) === 'service_role') {
      findings.push({ guard: 'secrets', file, message: 'contains a service_role JWT' });
      break;
    }
  }
  return findings;
}

// -- hosted -------------------------------------------------------------

const HOSTED_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: '"supabase link"', re: /supabase\s+link\b/ },
  { name: '"--linked"', re: /--linked\b/ },
  { name: '"db push"', re: /supabase\s+db\s+push\b|\bdb\s+push\b/ },
  { name: '"migration repair"', re: /migration\s+repair\b/ },
  { name: '"--project-ref"', re: /--project-ref\b/ }
];

/** Where an operational command would actually run: workflows, scripts, package.json. */
export const HOSTED_SCAN_INCLUDE = [/^\.github\/workflows\//, /^scripts\//, /^package\.json$/, /^supabase\/dev\//];
export const HOSTED_SCAN_EXEMPT = [/(^|\/)scripts\/repoGuards\.(test\.)?ts$/, /(^|\/)scripts\/repo-guards\.ts$/];

export function scanForHostedCommands(file: string, content: string): Finding[] {
  if (!HOSTED_SCAN_INCLUDE.some(re => re.test(file)) || HOSTED_SCAN_EXEMPT.some(re => re.test(file))) return [];

  // Comments may say what is forbidden; only code and commands count.
  const code = content
    .split('\n')
    .filter(line => !/^\s*(#|--|\/\/|\*)/.test(line))
    .join('\n');

  return HOSTED_PATTERNS.filter(p => p.re.test(code)).map(p => ({
    guard: 'hosted',
    file,
    message: `${p.name} must never run from the repository's automation (it can touch a hosted project)`
  }));
}

export function checkTrackedFiles(files: string[]): Finding[] {
  return files
    .filter(f => /^supabase\/\.temp\//.test(f) || /(^|\/)\.env(\.[^/]*)?$/.test(f) && !/\.env\.example$/.test(f))
    .map(f => ({ guard: 'hosted', file: f, message: 'must not be tracked (project link or environment file)' }));
}

// -- env ----------------------------------------------------------------

export function checkEnvExample(content: string): Finding[] {
  const findings: Finding[] = [];
  for (const line of content.split('\n')) {
    const m = /^\s*(VITE_[A-Z0-9_]*)\s*=/.exec(line);
    if (m && /SECRET|SERVICE|PRIVATE|PASSWORD|TOKEN/.test(m[1])) {
      findings.push({ guard: 'env', file: '.env.example', message: `${m[1]} is shipped to browsers; a secret must never use a VITE_ name` });
    }
  }
  return findings;
}

// -- dist ---------------------------------------------------------------

/** Hosts a built page must never depend on for styles, scripts, fonts or images. */
export const FORBIDDEN_DIST_HOSTS = ['cdn.tailwindcss.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'unpkg.com', 'cdn.jsdelivr.net', 'images.unsplash.com'];

export function scanBuiltFile(file: string, content: string): Finding[] {
  return FORBIDDEN_DIST_HOSTS.filter(h => content.includes(h)).map(h => ({
    guard: 'dist',
    file,
    message: `the built output references ${h}`
  }));
}
