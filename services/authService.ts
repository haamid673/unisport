import type { SupabaseClient, User as SupabaseUser } from '@supabase/supabase-js';
import { User, UserRole } from '../types';
import { getSupabase } from './supabaseClient';

/**
 * Real authentication on top of Supabase Auth.
 *
 * Identity and role come from exactly two server-side sources:
 *   1. the Supabase Auth session (who the user is), and
 *   2. the user's row in public.profiles, read through Row Level
 *      Security (what role they have).
 *
 * The profile row is created by the database trigger
 * public.handle_new_user() when the auth user is created; the browser
 * never creates it. The role is never taken from user metadata or from
 * anything stored in localStorage. Authorization stays in the database
 * (RLS and the SECURITY DEFINER functions); the role loaded here only
 * decides which screens to show.
 *
 * Nothing in this module logs passwords or tokens.
 */

/** Columns of public.profiles that the browser reads. */
export interface ProfileRow {
  id: string;
  full_name: string | null;
  phone: string | null;
  city: string | null;
  avatar_url: string | null;
  role: string;
  created_at: string;
}

const PROFILE_COLUMNS = 'id, full_name, phone, city, avatar_url, role, created_at';
const KNOWN_ROLES: UserRole[] = ['user', 'owner', 'admin'];

/** A user-facing error. `message` is always safe to display. */
export class AuthFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthFlowError';
  }
}

class ProfileLoadError extends AuthFlowError {
  constructor(message: string, readonly kind: 'missing' | 'fetch') {
    super(message);
    this.name = 'ProfileLoadError';
  }
}

/** Map a profiles row (plus the verified auth email) to the app's User. */
export function profileToUser(profile: ProfileRow, email: string): User {
  const role: UserRole = (KNOWN_ROLES as string[]).includes(profile.role)
    ? (profile.role as UserRole)
    : 'user';

  return {
    id: profile.id,
    email,
    role,
    name: profile.full_name ?? undefined,
    phone: profile.phone ?? undefined,
    avatarUrl: profile.avatar_url ?? undefined,
    createdAt: profile.created_at,
    city: profile.city ?? ''
  };
}

/** Translate a Supabase/network error into a safe, user-facing message. */
export function toAuthMessage(error: unknown): string {
  if (error instanceof AuthFlowError) return error.message;

  const e = error as { code?: string; name?: string; status?: number } | null;
  const code = e?.code;

  switch (code) {
    case 'invalid_credentials':
      return 'Incorrect email or password.';
    case 'email_not_confirmed':
      return 'Please confirm your email address before signing in.';
    case 'user_already_exists':
    case 'email_exists':
      return 'An account with this email already exists. Try signing in.';
    case 'weak_password':
      return 'That password is too weak. Please choose a longer, less common one.';
    case 'signup_disabled':
      return 'New registrations are currently disabled.';
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
      return 'Too many attempts. Please wait a moment and try again.';
    case 'validation_failed':
      return 'Please check the details you entered.';
  }

  if (e?.name === 'AuthRetryableFetchError' || e?.status === 0) {
    return 'Cannot reach the authentication service. Check your connection and try again.';
  }

  return 'Authentication failed. Please try again.';
}

export interface SignUpInput {
  email: string;
  password: string;
  name: string;
  phone: string;
}

export interface SignUpResult {
  /**
   * True when Supabase requires the email address to be confirmed
   * before a session is issued. The user must follow the emailed link.
   */
  needsEmailConfirmation: boolean;
}

export function createAuthService(getClient: () => SupabaseClient) {
  /** Read the signed-in user's profile through RLS and build the app User. */
  async function loadUser(authUser: SupabaseUser): Promise<User> {
    const client = getClient();

    const { data, error } = await client
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .eq('id', authUser.id)
      .maybeSingle();

    if (error) {
      throw new ProfileLoadError(
        'Could not load your profile. Check your connection and reload the page.',
        'fetch'
      );
    }

    if (!data) {
      throw new ProfileLoadError(
        'Your account has no profile. Please contact support.',
        'missing'
      );
    }

    let profile = data as ProfileRow;

    // The signup trigger stores the full name only. If a phone number
    // was supplied at sign-up and has not been saved yet, store it in
    // the user's own (non-privileged) profile field once. This never
    // touches the role.
    if (!profile.phone) {
      const pending = authUser.user_metadata?.phone;
      if (typeof pending === 'string' && pending.trim()) {
        const phone = pending.trim();
        const { error: updateError } = await client
          .from('profiles')
          .update({ phone })
          .eq('id', authUser.id);

        if (!updateError) profile = { ...profile, phone };
      }
    }

    return profileToUser(profile, authUser.email ?? '');
  }

  return {
    /** Create an account. The database trigger creates the profile. */
    async signUp(input: SignUpInput): Promise<SignUpResult> {
      const { data, error } = await getClient().auth.signUp({
        email: input.email.trim().toLowerCase(),
        password: input.password,
        options: {
          data: { full_name: input.name.trim(), phone: input.phone.trim() },
          emailRedirectTo:
            typeof window !== 'undefined' ? window.location.origin : undefined
        }
      });

      if (error) throw new AuthFlowError(toAuthMessage(error));

      // An existing, confirmed address yields a user with no identities
      // and no session (account-enumeration protection).
      return { needsEmailConfirmation: !data.session };
    },

    /**
     * Sign in. The session is delivered through subscribe(), which
     * loads the profile; this resolves once credentials are accepted.
     */
    async signIn(email: string, password: string): Promise<void> {
      const { error } = await getClient().auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password
      });

      if (error) throw new AuthFlowError(toAuthMessage(error));
    },

    /** Sign out of this browser only. */
    async signOut(): Promise<void> {
      const { error } = await getClient().auth.signOut({ scope: 'local' });
      if (error) throw new AuthFlowError(toAuthMessage(error));
    },

    /**
     * Subscribe to authentication state.
     *
     * supabase-js emits INITIAL_SESSION as soon as the stored session
     * has been restored (or found absent), so this single listener also
     * covers page-reload restoration. `onUser` receives the loaded user
     * or null; `onError` receives a safe message when a signed-in
     * session cannot be turned into a user.
     *
     * Returns an unsubscribe function.
     */
    subscribe(
      onUser: (user: User | null) => void,
      onError: (message: string) => void
    ): () => void {
      const client = getClient();
      let latest = 0;
      let disposed = false;

      const { data } = client.auth.onAuthStateChange((event, session) => {
        // Token refresh does not change who the user is.
        if (event === 'TOKEN_REFRESHED' && session) return;

        const mine = ++latest;

        if (!session) {
          onUser(null);
          return;
        }

        // supabase-js must not be awaited inside this callback; defer.
        setTimeout(async () => {
          try {
            const user = await loadUser(session.user);
            if (!disposed && mine === latest) onUser(user);
          } catch (error) {
            if (disposed || mine !== latest) return;

            onError(toAuthMessage(error));

            // A session without a profile cannot be used.
            if (error instanceof ProfileLoadError && error.kind === 'missing') {
              try {
                await client.auth.signOut({ scope: 'local' });
              } catch {
                onUser(null);
              }
            } else {
              onUser(null);
            }
          }
        }, 0);
      });

      return () => {
        disposed = true;
        data.subscription.unsubscribe();
      };
    },

    /**
     * Update the signed-in user's own name and phone. RLS limits the
     * write to their own row, and the role-escalation trigger blocks
     * any role change regardless of what is sent here.
     */
    async updateOwnProfile(updates: { name?: string; phone?: string }): Promise<User> {
      const client = getClient();

      const {
        data: { session }
      } = await client.auth.getSession();

      if (!session) throw new AuthFlowError('You are not signed in.');

      const patch: Record<string, string> = {};
      if (updates.name !== undefined) patch.full_name = updates.name.trim();
      if (updates.phone !== undefined) patch.phone = updates.phone.trim();

      const { data, error } = await client
        .from('profiles')
        .update(patch)
        .eq('id', session.user.id)
        .select(PROFILE_COLUMNS)
        .maybeSingle();

      if (error || !data) {
        throw new AuthFlowError('Failed to update profile.');
      }

      return profileToUser(data as ProfileRow, session.user.email ?? '');
    }
  };
}

/** The application's auth service, bound to the shared Supabase client. */
export const authService = createAuthService(getSupabase);
