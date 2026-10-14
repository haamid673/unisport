import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { loadMyFacilities } = vi.hoisted(() => ({
  loadMyFacilities: vi.fn(() => new Promise(() => {}))
}));

vi.mock('../../services/ownerFacilityRepository', async () => {
  const actual = await vi.importActual<any>('../../services/ownerFacilityRepository');
  return {
    ...actual,
    ownerFacilityRepository: { ...actual.ownerFacilityRepository, loadMyFacilities }
  };
});

import OwnerDashboard from '../OwnerDashboard';
import type { User } from '../../types';

const source = readFileSync(
  fileURLToPath(new URL('../OwnerDashboard.tsx', import.meta.url)),
  'utf8'
);

const owner: User = { id: 'u1', email: 'o@example.com', role: 'owner', city: 'X', name: 'Olivia' };
const player: User = { ...owner, role: 'user' };

describe('OwnerDashboard', () => {
  it('shows a loading state for an owner and no demo venues', () => {
    const html = renderToStaticMarkup(<OwnerDashboard user={owner} />);

    expect(html).toContain('Signed in as Olivia');
    expect(html).toContain('Loading your venues');
    expect(html).not.toMatch(/Padel Club|Elite|owner1|₹\d/);
  });

  it('does not render management controls for a non-owner', () => {
    const html = renderToStaticMarkup(<OwnerDashboard user={player} />);

    expect(html).toContain('owner accounts only');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<form');
    expect(loadMyFacilities).not.toHaveBeenCalled();
  });

  it('reads and writes only through the repository', () => {
    expect(source).toMatch(/ownerFacilityRepository\s*\.loadMyFacilities\(\)/);
    expect(source).toMatch(/ownerFacilityRepository\.createFacility\(/);
    expect(source).toMatch(/ownerFacilityRepository\.updateFacility\(/);
    expect(source).not.toMatch(
      /localStorage|storageService|facilityService|eventService|addFacility|updateFacilityStatus|\.from\(|\.rpc\(/
    );
  });

  it('has no status control, delete action or owner field in the UI', () => {
    expect(source).not.toMatch(/status\s*:\s*['"]/);
    expect(source).not.toMatch(/Delete|Approve|Reject|Suspend|Activate venue/);
    expect(source).not.toMatch(/ownerId|owner_id/);
  });

  it('labels every form field and announces results', () => {
    expect(source).toMatch(/htmlFor=\{id\}/);
    expect(source).toContain('role={notice.type === \'error\' ? \'alert\' : \'status\'}');
    expect(source).toContain("aria-live=\"polite\"");
    expect(source).toContain('aria-invalid');
  });

  it('explains pending approval and has retry, empty and loading states', () => {
    expect(source).toMatch(/pending and become visible to players once an administrator/);
    expect(source).toContain('You have no venues yet.');
    expect(source).toContain('Retry');
    expect(source).toContain('Loading your venues');
  });

  it('guards every submit with a single-flight lock', () => {
    const guards = source.match(/createSingleFlight\(\)/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(3);
    expect(source).toMatch(/if \(guard\.current\.busy\) return;/);
  });
});

describe('owner portal notice lifecycle', () => {
  const activeSource = source
    .split('\n')
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n');

  const body = (name: string) => {
    const start = activeSource.indexOf(`const ${name} = async`);
    expect(start).toBeGreaterThan(-1);
    return activeSource.slice(start, start + 900);
  };

  it('clears the previous finished notice before a create request is sent', () => {
    const create = body('handleCreate');
    const clearAt = create.indexOf('setNotice(null)');
    const requestAt = create.indexOf('await ownerFacilityRepository.createFacility');

    expect(clearAt).toBeGreaterThan(-1);
    expect(requestAt).toBeGreaterThan(clearAt);
  });

  it('clears the previous finished notice before an update request is sent', () => {
    const update = body('handleUpdate');
    const clearAt = update.indexOf('setNotice(null)');
    const requestAt = update.indexOf('await ownerFacilityRepository.updateFacility');

    expect(clearAt).toBeGreaterThan(-1);
    expect(requestAt).toBeGreaterThan(clearAt);
  });

  it('publishes a result only while no newer action has started', () => {
    expect(activeSource).toMatch(/const noticeSequence = useRef\(createActionSequence\(\)\)/);
    expect(body('handleCreate')).toMatch(/isCurrent\(token\)[\s\S]*Venue created\./);
    expect(body('handleUpdate')).toMatch(/isCurrent\(token\)[\s\S]*Venue details saved\./);
  });

  it('never publishes a success from a request that failed', () => {
    // the success notice comes after the awaited repository call, so a
    // thrown error skips it and the form shows its own error alone
    const create = body('handleCreate');
    expect(create.indexOf('await ownerFacilityRepository.createFacility'))
      .toBeLessThan(create.indexOf('Venue created.'));
    const update = body('handleUpdate');
    expect(update.indexOf('await ownerFacilityRepository.updateFacility'))
      .toBeLessThan(update.indexOf('Venue details saved.'));
  });

  it('keeps the existing per-panel behaviour: clear at start, result at the end', () => {
    // hours and slots already clear their own notice when an action begins
    // (the slots panel inline, the hours panel through saveDay's onStarted)
    expect((activeSource.match(/setNotice\(null\);\s*\n\s*\n?\s*try \{/g) ?? []).length)
      .toBeGreaterThanOrEqual(1);
    expect(activeSource).toMatch(/onStarted:\s*\(\)\s*=>\s*setNotice\(null\)/);
  });
});
