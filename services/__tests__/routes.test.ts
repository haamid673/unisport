import { describe, it, expect } from 'vitest';
import {
  ROUTES,
  canAccess,
  communityPath,
  homePath,
  pathForTab,
  redirectFor,
  tabForPath
} from '../routes';

const roles = ['user', 'owner', 'admin'] as const;

describe('route table', () => {
  it('gives every role its own stable home', () => {
    expect(homePath('user')).toBe('/');
    expect(homePath('owner')).toBe('/owner');
    expect(homePath('admin')).toBe('/admin');
  });

  it('maps every primary path to a tab and nothing else', () => {
    expect(tabForPath('/')).toBe('dashboard');
    expect(tabForPath('/owner')).toBe('dashboard');
    expect(tabForPath('/admin')).toBe('dashboard');
    expect(tabForPath('/community')).toBe('community');
    expect(tabForPath('/community/abc')).toBe('community');
    expect(tabForPath('/profile')).toBe('profile');
    expect(tabForPath('/profile/')).toBe('profile');
    expect(tabForPath('/nope')).toBeNull();
    expect(tabForPath('/community/a/b')).toBeNull();
    expect(tabForPath('/payment')).toBeNull();
  });

  it('opens a tab at the path of the role', () => {
    expect(pathForTab('dashboard', 'owner')).toBe('/owner');
    expect(pathForTab('dashboard', 'user')).toBe('/');
    expect(pathForTab('community', 'user')).toBe('/community');
    expect(pathForTab('profile', 'user')).toBe('/profile');
  });

  it('encodes a group id into the path', () => {
    expect(communityPath('g 1/2')).toBe('/community/g%201%2F2');
    expect(tabForPath(communityPath('g 1/2'))).toBe('community');
  });
});

describe('who may open what', () => {
  it('lets only players use community and profile', () => {
    for (const path of ['/community', '/community/x', '/profile']) {
      expect(canAccess('user', path)).toBe(true);
      expect(canAccess('owner', path)).toBe(false);
      expect(canAccess('admin', path)).toBe(false);
    }
  });

  it('lets only an owner open /owner and only an admin open /admin', () => {
    expect(roles.filter(r => canAccess(r, '/owner'))).toEqual(['owner']);
    expect(roles.filter(r => canAccess(r, '/admin'))).toEqual(['admin']);
  });

  it('refuses an unknown path for every role', () => {
    for (const r of roles) expect(canAccess(r, '/nope')).toBe(false);
  });
});

describe('redirectFor', () => {
  it('never redirects a role away from a page it can use', () => {
    expect(redirectFor('user', '/')).toBeNull();
    expect(redirectFor('user', '/community/x')).toBeNull();
    expect(redirectFor('owner', '/owner')).toBeNull();
    expect(redirectFor('admin', '/admin')).toBeNull();
  });

  it('sends a wrong role to its own home', () => {
    expect(redirectFor('user', '/admin')).toBe('/');
    expect(redirectFor('user', '/owner')).toBe('/');
    expect(redirectFor('owner', '/admin')).toBe('/owner');
    expect(redirectFor('admin', '/profile')).toBe('/admin');
    expect(redirectFor('owner', '/community')).toBe('/owner');
  });

  it('moves owners and admins from the root to their dashboard', () => {
    expect(redirectFor('owner', '/')).toBe('/owner');
    expect(redirectFor('admin', '/')).toBe('/admin');
  });

  it('sends a signed-in person away from /auth, and leaves unknown paths to the 404 page', () => {
    expect(redirectFor('user', ROUTES.auth)).toBe('/');
    expect(redirectFor('admin', ROUTES.auth)).toBe('/admin');
    expect(redirectFor('user', '/nope')).toBeNull();
  });
});
