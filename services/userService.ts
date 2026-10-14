import { User } from '../types';
import { storageService } from './storageService';
import { authService } from './authService';

// -- Authenticated identity --------------------------------------------
//
// The signed-in user comes from the Supabase session and the database
// profile (see authService / App.tsx). It is held in memory only: it is
// NOT read from or written to localStorage, so editing localStorage
// cannot change who the app thinks you are.
//
// The mock-backed services (events, facilities, ...) still ask
// userService.getCurrentUser() for the identity, which is why it is
// kept here.
let authenticatedUser: User | null = null;

// UI-only profile fields the database has no columns for yet. Stored
// locally per user id; never used for any authorization decision.
const PROFILE_EXTRAS_KEY = 'unisport_profile_extras_v1';

interface ProfileExtras {
  bio?: string;
  preferences?: string[];
}

const readExtras = (userId: string): ProfileExtras => {
  const all = storageService.get<Record<string, ProfileExtras>>(PROFILE_EXTRAS_KEY, {});
  return all[userId] ?? {};
};

const writeExtras = (userId: string, extras: ProfileExtras) => {
  const all = storageService.get<Record<string, ProfileExtras>>(PROFILE_EXTRAS_KEY, {});
  all[userId] = { ...all[userId], ...extras };
  storageService.set(PROFILE_EXTRAS_KEY, all);
};

export const userService = {
  getCurrentUser: (): User | null => authenticatedUser,

  /**
   * Called by App.tsx when the Supabase session changes. Returns the
   * user with the local UI-only extras merged in.
   */
  setCurrentUser: (user: User | null): User | null => {
    authenticatedUser = user ? { ...user, ...readExtras(user.id) } : null;
    return authenticatedUser;
  },

  /**
   * Update the signed-in user's profile. name and phone are persisted
   * to public.profiles (RLS: own row only); bio and preferences have no
   * database columns yet and are kept locally.
   */
  updateProfile: async (updates: Partial<User>): Promise<User> => {
    const currentUser = authenticatedUser;
    if (!currentUser) throw new Error("Not logged in");

    const saved = await authService.updateOwnProfile({
      name: updates.name,
      phone: updates.phone
    });

    const extras: ProfileExtras = {};
    if (updates.bio !== undefined) extras.bio = updates.bio;
    if (updates.preferences !== undefined) extras.preferences = updates.preferences;
    writeExtras(currentUser.id, extras);

    // Keep the database as the source of the role and email.
    authenticatedUser = { ...currentUser, ...saved, ...readExtras(currentUser.id) };

    return authenticatedUser;
  }
};
