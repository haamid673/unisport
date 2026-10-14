import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

import AdminDashboard from '../AdminDashboard';
import OwnerDashboard from '../OwnerDashboard';
import { userService } from '../../services/userService';
import { facilityService } from '../../services/facilityService';
import { eventService } from '../../services/eventService';
import type { User } from '../../types';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/** Application source files (not tests, not build output). */
const sourceFiles = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (['node_modules', 'dist', 'supabase', 'docs', '.git', 'public'].includes(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === '__tests__') continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) {
        out.push(relative(root, full));
      }
    }
  };
  walk(root);
  return out;
};

// The mock services read browser storage; give them an empty in-memory
// one so the assertions describe a first visit.
beforeAll(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear()
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const owner: User = { id: 'u1', email: 'o@example.com', role: 'owner', city: 'X', name: 'Olivia' };

describe('admin console and owner portal', () => {
  it('the admin console renders an honest notice with no actions', () => {
    const html = renderToStaticMarkup(<AdminDashboard />);

    expect(html).toContain('role="status"');
    expect(html).toContain('Not available yet');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<input');
    expect(html).not.toMatch(/LIVE SYNC|REVOKE|Approve|Reject/);
  });

  it('the owner portal greets the owner and invents no data', () => {
    const html = renderToStaticMarkup(<OwnerDashboard user={owner} />);
    expect(html).toContain('Signed in as Olivia');
    expect(html).not.toMatch(/₹|owner1|f\d/);
  });

  it('neither console calls the removed mock functions or local storage', () => {
    for (const file of ['components/AdminDashboard.tsx', 'components/OwnerDashboard.tsx']) {
      const src = read(file);
      expect(src).not.toMatch(/updateFacilityStatus|updateEventStatus|updateGroupStatus|addFacility\(/);
      expect(src).not.toMatch(/localStorage|storageService/);
    }
  });
});

describe('no demo data or credentials in the application', () => {
  it('has no demo seeder and no automatic seeding', () => {
    expect(existsSync(join(root, 'services/demoSeeder.ts'))).toBe(false);
    for (const file of sourceFiles()) {
      expect(read(file), file).not.toMatch(/seedDemoData|resetDemoData|demoSeeder/);
    }
  });

  it('contains no fake credentials, salts or personal emails', () => {
    for (const file of sourceFiles()) {
      const src = read(file);
      expect(src, file).not.toMatch(/_unisport_salt|passwordHash|admin123|owner123|player123|user123/);
      expect(src, file).not.toMatch(/haamid673|@demo\.com|owner@padel|owner@sports|owner@gym|admin@unisport/);
    }
  });

  it('keeps no mock catalog, accounts or community seed in memory', () => {
    expect(facilityService.getAllFacilities(true)).toEqual([]);
    expect(facilityService.getAllSlots()).toEqual([]);
    expect(eventService.getAllGroups(true)).toEqual([]);
    expect(eventService.getAllEvents(true)).toEqual([]);
    expect((userService as Record<string, unknown>).getAllUsers).toBeUndefined();
  });
});

describe('no PII or noise logging', () => {
  it('has no console.log in application code', () => {
    for (const file of sourceFiles()) {
      expect(read(file), file).not.toMatch(/console\.log\(/);
    }
  });

  it('does not log user identity or fake email receipts', () => {
    const payment = read('components/PaymentPage.tsx');
    expect(payment).not.toMatch(/EMAIL SENT|user\.email|user\.name/);
  });
});

describe('no unused AI key injection', () => {
  it('does not inject any key into the browser bundle', () => {
    const config = read('vite.config.ts');
    expect(config).not.toMatch(/GEMINI|API_KEY|process\.env/);
    expect(config).not.toMatch(/define\s*:/);
  });

  it('does not depend on the Gemini SDK', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.dependencies?.['@google/genai']).toBeUndefined();
    for (const file of sourceFiles()) {
      expect(read(file), file).not.toMatch(/@google\/genai|GEMINI_API_KEY/);
    }
  });
});

describe('bundled images', () => {
  it('are served from public/ so builds include them', () => {
    expect(existsSync(join(root, 'public/images'))).toBe(true);
    expect(readdirSync(join(root, 'public/images')).filter(f => f.endsWith('.jpg')).length).toBeGreaterThanOrEqual(4);
  });
});
