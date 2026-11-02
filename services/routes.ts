import type { User } from '../types';

/**
 * The application's URLs, one per primary screen, and who may open them.
 *
 * Route guards here are a convenience (a wrong role is sent home instead
 * of seeing a page it cannot use). They are not a security boundary: the
 * database enforces every permission regardless of the URL.
 */

type Role = User['role'];

export const ROUTES = {
  home: '/',
  owner: '/owner',
  admin: '/admin',
  community: '/community',
  communityGroup: '/community/:groupId',
  profile: '/profile',
  auth: '/auth',
  resetPassword: '/reset-password',
  about: '/about'
} as const;

export type Tab = 'dashboard' | 'community' | 'profile';

/** Where each role lands: its own dashboard. */
export const homePath = (role: Role): string =>
  role === 'admin' ? ROUTES.admin : role === 'owner' ? ROUTES.owner : ROUTES.home;

export const communityPath = (groupId: string): string =>
  `${ROUTES.community}/${encodeURIComponent(groupId)}`;

/** Which navigation tab a path belongs to, or null for an unknown path. */
export function tabForPath(pathname: string): Tab | null {
  const path = normalise(pathname);
  if (path === ROUTES.home || path === ROUTES.owner || path === ROUTES.admin) return 'dashboard';
  if (path === ROUTES.community || /^\/community\/[^/]+$/.test(path)) return 'community';
  if (path === ROUTES.profile) return 'profile';
  return null;
}

/** The path a navigation tab opens for a role. */
export function pathForTab(tab: Tab, role: Role): string {
  switch (tab) {
    case 'community':
      return ROUTES.community;
    case 'profile':
      return ROUTES.profile;
    default:
      return homePath(role);
  }
}

/**
 * Whether a role may open a path. Players have the community and profile
 * screens; owners and administrators have their one dashboard each.
 */
export function canAccess(role: Role, pathname: string): boolean {
  const path = normalise(pathname);
  const tab = tabForPath(path);
  if (tab === null) return false;

  if (path === ROUTES.owner) return role === 'owner';
  if (path === ROUTES.admin) return role === 'admin';
  if (path === ROUTES.home) return true;
  return role === 'user';
}

/** A path the signed-in role should be sent to instead, or null to stay. */
export function redirectFor(role: Role, pathname: string): string | null {
  const path = normalise(pathname);

  if (path === ROUTES.auth) return homePath(role);
  // The root is the player's home; owners and administrators have their own URL.
  if (path === ROUTES.home && role !== 'user') return homePath(role);
  if (tabForPath(path) !== null && !canAccess(role, path)) return homePath(role);
  return null;
}

/** One trailing slash is the same page. */
function normalise(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}
