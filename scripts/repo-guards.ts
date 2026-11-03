import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkEnvExample,
  checkMigrationAppendOnly,
  checkMigrationNames,
  checkTrackedFiles,
  scanBuiltFile,
  scanForHostedCommands,
  scanForSecrets,
  type Finding
} from './repoGuards';

// Usage:  npm run guards            (repository checks)
//         npm run guards -- --dist  (also the built output; run after a build)
//         BASE_REF=origin/main npm run guards   (migrations are append-only vs that ref)

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const tracked = git('ls-files').split('\n').filter(Boolean);
const findings: Finding[] = [];

findings.push(...checkTrackedFiles(tracked));

const migrations = tracked
  .filter(f => /^supabase\/migrations\/[^/]+$/.test(f))
  .map(f => f.split('/').pop() as string);
findings.push(...checkMigrationNames(migrations));

const baseRef = process.env.BASE_REF;
if (baseRef) {
  const baseNames = git('ls-tree', '--name-only', baseRef, 'supabase/migrations/')
    .split('\n')
    .filter(Boolean)
    .map(f => f.split('/').pop() as string);
  findings.push(...checkMigrationAppendOnly(baseNames, migrations));
}

for (const file of tracked) {
  if (!existsSync(file) || statSync(file).size > 2_000_000) continue;
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (content.includes('\u0000')) continue; // binary

  findings.push(...scanForSecrets(file, content));
  findings.push(...scanForHostedCommands(file, content));
}

if (existsSync('.env.example')) findings.push(...checkEnvExample(readFileSync('.env.example', 'utf8')));

if (process.argv.includes('--dist')) {
  if (!existsSync('dist')) {
    findings.push({ guard: 'dist', file: 'dist', message: 'no build output found; run `npm run build` first' });
  } else {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap(name => {
        const p = join(dir, name);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    for (const file of walk('dist').filter(f => /\.(html|css|js|mjs)$/.test(f))) {
      findings.push(...scanBuiltFile(file, readFileSync(file, 'utf8')));
    }
  }
}

if (findings.length > 0) {
  for (const f of findings) console.error(`[${f.guard}] ${f.file}: ${f.message}`);
  console.error(`\n${findings.length} guard finding(s).`);
  process.exit(1);
}

process.stdout.write(`Repository guards passed (${tracked.length} tracked files${process.argv.includes('--dist') ? ', build output checked' : ''}).\n`);
