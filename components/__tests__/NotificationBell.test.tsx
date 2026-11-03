import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const bell = read('../NotificationBell.tsx');
const navbar = read('../Navbar.tsx');

describe('notification bell', () => {
  it('reads and marks only through the notification repository, never local data', () => {
    expect(bell).toContain("from '../services/notificationRepository'");
    expect(bell).not.toMatch(/localStorage|sessionStorage|storageService|\.rpc\(|\.from\(/);
  });

  it('polls at the same bounded cadence as the waitlist and skips hidden tabs', () => {
    expect(bell).toMatch(/NOTIFICATION_POLL_MS = 60_000/);
    expect(bell).toMatch(/document\.visibilityState !== 'hidden'/);
    expect(bell).toMatch(/clearInterval\(timer\)/);
  });

  it('shows the unread count accessibly, and loading, error-with-Retry and empty states', () => {
    expect(bell).toMatch(/Notifications, \$\{unread\} unread/);
    expect(bell).toContain('Retry');
    expect(bell).toContain('You have no notifications yet.');
    expect(bell).toMatch(/phase: 'loading'/);
  });

  it('keeps what it shows when a background refresh fails', () => {
    expect(bell).toMatch(/prev\.phase === 'ready'\s*\?\s*prev/);
  });

  it('marks one as read on opening it and all on request, then re-reads', () => {
    expect(bell).toMatch(/markRead\(\[n\.id\]\)/);
    expect(bell).toMatch(/markRead\(\)\.then\(afterMark, afterMark\)/);
  });

  it('closes on outside click and Escape', () => {
    expect(bell).toContain("e.key === 'Escape'");
    expect(bell).toMatch(/addEventListener\('mousedown'/);
  });

  it('is in the navigation for signed-in people, on desktop and mobile', () => {
    expect((navbar.match(/<NotificationBell userId=\{user\.id\} \/>/g) ?? []).length).toBe(2);
  });

  it('tells every bell to re-read after marking, so the two in the navigation agree', () => {
    expect(bell).toContain("NOTIFICATIONS_CHANGED = 'unisport:notifications-changed'");
    expect(bell).toMatch(/window\.addEventListener\(NOTIFICATIONS_CHANGED, refresh\)/);
    expect(bell).toMatch(/window\.dispatchEvent\(new Event\(NOTIFICATIONS_CHANGED\)\)/);
  });
});
