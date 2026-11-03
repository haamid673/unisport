import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Source-shape checks, like the other screens. The rules (approval,
// membership, capacity, venue/city) are proven by community_test.sql and
// community_concurrency_test.sql; the repository by communityRepository.test.ts.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const community = read('../Community.tsx');
const detail = read('../CommunityDetail.tsx');
const profile = read('../UserProfile.tsx');

describe('community screens', () => {
  it('read and write only through the community repository, never local data', () => {
    for (const src of [community, detail]) {
      expect(src).toContain("from '../services/communityRepository'");
      expect(src).not.toMatch(/localStorage|storageService|eventService|\.rpc\(|\.from\(/);
    }
  });

  it('the Profile reads the person\'s events from the database', () => {
    expect(profile).toMatch(/communityRepository\s*\.loadEvents\(\{ onlyMine: true \}\)/);
    expect(profile).not.toMatch(/eventService/);
  });

  it('have loading, error-with-Retry and empty states', () => {
    for (const src of [community, detail]) {
      expect(src).toMatch(/phase: 'loading'/);
      expect(src).toMatch(/phase: 'error'/);
      expect(src).toContain('Retry');
    }
    expect(community).toContain('No communities yet.');
    expect(detail).toContain('No events yet in this community.');
  });

  it('create a group and an event through the repository, with a single-flight guard', () => {
    expect(community).toMatch(/communityRepository\.createGroup\(/);
    expect(detail).toMatch(/communityRepository\.createEvent\(/);
    expect(community).toMatch(/createSingleFlight\(\)/);
    expect(detail).toMatch(/createSingleFlight\(\)/);
    expect(detail).toMatch(/if \(guard\.current\.busy\) return;/);
  });

  it('say that new items are reviewed, and show the awaiting-approval state honestly', () => {
    expect(community).toContain('reviewed by an administrator');
    expect(detail).toContain('reviewed by an administrator');
    expect(community).toContain('Awaiting approval');
    expect(detail).toContain('Awaiting approval');
  });

  it('report success only from the database answer and re-read afterwards', () => {
    expect(detail).toMatch(/finally \{\s*setBusy\(null\);\s*setReloadKey\(k => k \+ 1\);/);
    expect(community).toMatch(/finally \{\s*setSubmitting\(false\);\s*setReloadKey\(k => k \+ 1\);/);
  });

  it('use no alert() for errors', () => {
    expect(detail).not.toMatch(/\balert\(/);
    expect(community).not.toMatch(/\balert\(/);
  });

  it('only offer event actions to members of an approved group, and never join a full or ended event', () => {
    expect(detail).toMatch(/const canAct = group\.isMember && approved && group\.status === 'approved'/);
    expect(detail).toMatch(/\(isFull \|\| ended\)/);
  });

  it('treat an address that is not a group id as not found, without a request', () => {
    expect(detail).toMatch(/!UUID_PATTERN\.test\(groupId\)/);
    expect(detail).toContain('Group not found');
  });
});
