import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Source-shape checks for how App uses the route table. The table itself
// (who may open what, redirects) is tested in services/__tests__/routes.test.ts;
// refresh, back/forward and the sub-path build were verified in a real browser.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const app = read('../../App.tsx');
const index = read('../../index.tsx');
const navbar = read('../Navbar.tsx');

describe('App routing', () => {
  it('keeps the base path in the router, so a sub-path deployment works', () => {
    expect(index).toMatch(/basename=\{import\.meta\.env\.BASE_URL/);
  });

  it('has a route for every primary screen and a catch-all not-found page', () => {
    for (const r of ['ROUTES.home', 'ROUTES.owner', 'ROUTES.admin', 'ROUTES.community', 'ROUTES.communityGroup', 'ROUTES.profile']) {
      expect(app).toContain(`path={${r}}`);
    }
    expect(app).toMatch(/<Route path="\*" element=\{<NotFound/);
  });

  it('derives the active tab from the address and navigates instead of keeping tab state', () => {
    expect(app).not.toMatch(/useState\('dashboard'\)/);
    expect(app).toMatch(/tabForPath\(location\.pathname\)/);
    expect(app).toMatch(/navigate\(pathForTab\(/);
  });

  it('sends a wrong role or /auth to the role\'s home', () => {
    expect(app).toMatch(/redirectFor\(user\.role, location\.pathname\)/);
    expect(app).toMatch(/<Navigate to=\{redirect\} replace \/>/);
  });

  it('does not reset the address on sign-in, so a deep link survives the login', () => {
    const subscribe = app.slice(app.indexOf('authService.subscribe'), app.indexOf('(message) =>'));
    expect(subscribe).not.toMatch(/navigate\(|setActiveTab/);
  });

  it('shows the player-only menu entries to players only, on mobile as on desktop', () => {
    const mobile = navbar.slice(navbar.indexOf('{/* Mobile Menu */}'));
    expect(mobile).toMatch(/user\.role === 'user' && \(\s*<>/);
  });
});
