import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createAuthService,
  profileToUser,
  toAuthMessage,
  AuthFlowError,
  ProfileRow
} from '../authService';

const PROFILE: ProfileRow = {
  id: '11111111-1111-1111-1111-111111111111',
  full_name: 'Test Player',
  phone: '9876543210',
  city: 'Chennai',
  avatar_url: null,
  role: 'user',
  created_at: '2026-10-10T00:00:00Z'
};

const authUser = (overrides: Record<string, unknown> = {}) => ({
  id: PROFILE.id,
  email: 'player@example.com',
  user_metadata: {},
  ...overrides
});

interface FakeOptions {
  profile?: ProfileRow | null;
  profileError?: boolean;
  session?: { user: ReturnType<typeof authUser> } | null;
  signInError?: unknown;
  signUpResult?: { data: any; error: unknown };
}

/** A minimal stand-in for the parts of SupabaseClient the service uses. */
function fakeClient(options: FakeOptions = {}) {
  const updates: Array<Record<string, unknown>> = [];
  let authListener: ((event: string, session: any) => void) | null = null;
  const unsubscribe = vi.fn();

  const profile = 'profile' in options ? options.profile : PROFILE;

  const query = (): any => {
    const q: any = {
      select: () => q,
      update: (patch: Record<string, unknown>) => {
        updates.push(patch);
        return q;
      },
      eq: () => q,
      maybeSingle: async () =>
        options.profileError
          ? { data: null, error: { message: 'boom' } }
          : { data: profile, error: null },
      then: (resolve: any) => resolve({ data: null, error: null })
    };
    return q;
  };

  const auth = {
    signInWithPassword: vi.fn(async () => ({
      data: {},
      error: options.signInError ?? null
    })),
    signUp: vi.fn(async () =>
      options.signUpResult ?? { data: { session: null, user: {} }, error: null }
    ),
    signOut: vi.fn(async () => ({ error: null })),
    getSession: vi.fn(async () => ({
      data: { session: options.session ?? null }
    })),
    onAuthStateChange: vi.fn((cb: any) => {
      authListener = cb;
      return { data: { subscription: { unsubscribe } } };
    })
  };

  const client = { auth, from: vi.fn(() => query()) } as unknown as SupabaseClient;

  return {
    client,
    auth,
    updates,
    unsubscribe,
    emit: (event: string, session: any) => authListener?.(event, session)
  };
}

describe('profileToUser', () => {
  it('takes the role from the database profile', () => {
    expect(profileToUser({ ...PROFILE, role: 'owner' }, 'a@b.c').role).toBe('owner');
    expect(profileToUser({ ...PROFILE, role: 'admin' }, 'a@b.c').role).toBe('admin');
  });

  it('falls back to the least-privileged role for an unknown value', () => {
    expect(profileToUser({ ...PROFILE, role: 'superuser' }, 'a@b.c').role).toBe('user');
  });

  it('uses the verified auth email and tolerates null columns', () => {
    const user = profileToUser(
      { ...PROFILE, full_name: null, phone: null, city: null },
      'verified@example.com'
    );
    expect(user.email).toBe('verified@example.com');
    expect(user.city).toBe('');
    expect(user.name).toBeUndefined();
  });
});

describe('toAuthMessage', () => {
  it('maps known Supabase codes', () => {
    expect(toAuthMessage({ code: 'invalid_credentials' })).toMatch(/incorrect email or password/i);
    expect(toAuthMessage({ code: 'user_already_exists' })).toMatch(/already exists/i);
    expect(toAuthMessage({ code: 'weak_password' })).toMatch(/password/i);
  });

  it('does not leak unknown raw error text', () => {
    const message = toAuthMessage({ message: 'secret internal detail', code: 'x' });
    expect(message).not.toContain('secret internal detail');
  });

  it('describes network failures', () => {
    expect(toAuthMessage({ name: 'AuthRetryableFetchError' })).toMatch(/cannot reach/i);
  });
});

describe('signIn / signOut / signUp', () => {
  it('signs in with a normalised email', async () => {
    const f = fakeClient();
    await createAuthService(() => f.client).signIn('  Player@Example.COM ', 'pw');
    expect(f.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'player@example.com',
      password: 'pw'
    });
  });

  it('raises a safe error for bad credentials', async () => {
    const f = fakeClient({
      signInError: { code: 'invalid_credentials', message: 'Invalid login credentials' }
    });
    const service = createAuthService(() => f.client);
    await expect(service.signIn('a@b.c', 'wrong')).rejects.toBeInstanceOf(AuthFlowError);
    await expect(service.signIn('a@b.c', 'wrong')).rejects.toThrow(/incorrect email or password/i);
  });

  it('signs out of this browser only', async () => {
    const f = fakeClient();
    await createAuthService(() => f.client).signOut();
    expect(f.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('signs up with name and phone metadata and never sends a role', async () => {
    const f = fakeClient();
    const result = await createAuthService(() => f.client).signUp({
      email: 'New@Example.com',
      password: 'pw12345',
      name: ' New User ',
      phone: ' 9876543210 '
    });

    expect(result.needsEmailConfirmation).toBe(true);

    const payload = (f.auth.signUp.mock.calls[0] as any)[0];
    expect(payload.email).toBe('new@example.com');
    expect(payload.options.data).toEqual({
      full_name: 'New User',
      phone: '9876543210'
    });
    expect(JSON.stringify(payload)).not.toMatch(/role/i);
  });

  it('reports no confirmation needed when a session is issued', async () => {
    const f = fakeClient({
      signUpResult: { data: { session: { access_token: 'x' }, user: {} }, error: null }
    });
    const result = await createAuthService(() => f.client).signUp({
      email: 'a@b.c', password: 'pw12345', name: 'A', phone: '9876543210'
    });
    expect(result.needsEmailConfirmation).toBe(false);
  });
});

describe('subscribe (session restoration and auth-state changes)', () => {
  it('reports no user when there is no stored session', () => {
    const f = fakeClient();
    const onUser = vi.fn();
    createAuthService(() => f.client).subscribe(onUser, vi.fn());

    f.emit('INITIAL_SESSION', null);
    expect(onUser).toHaveBeenCalledWith(null);
  });

  it('restores a session and loads the profile from the database', async () => {
    const f = fakeClient({ profile: { ...PROFILE, role: 'owner' } });
    const onUser = vi.fn();
    createAuthService(() => f.client).subscribe(onUser, vi.fn());

    f.emit('INITIAL_SESSION', { user: authUser() });

    await vi.waitFor(() => expect(onUser).toHaveBeenCalledTimes(1));
    const user = onUser.mock.calls[0][0];
    expect(user.id).toBe(PROFILE.id);
    expect(user.role).toBe('owner');
    expect(user.email).toBe('player@example.com');
  });

  it('ignores a role claimed in user metadata', async () => {
    const f = fakeClient({ profile: { ...PROFILE, role: 'user' } });
    const onUser = vi.fn();
    createAuthService(() => f.client).subscribe(onUser, vi.fn());

    f.emit('SIGNED_IN', {
      user: authUser({ user_metadata: { role: 'admin' }, app_metadata: { role: 'admin' } })
    });

    await vi.waitFor(() => expect(onUser).toHaveBeenCalled());
    expect(onUser.mock.calls[0][0].role).toBe('user');
  });

  it('clears the user on sign-out', () => {
    const f = fakeClient();
    const onUser = vi.fn();
    createAuthService(() => f.client).subscribe(onUser, vi.fn());

    f.emit('SIGNED_OUT', null);
    expect(onUser).toHaveBeenCalledWith(null);
  });

  it('does not reload the profile on token refresh', async () => {
    const f = fakeClient();
    const onUser = vi.fn();
    createAuthService(() => f.client).subscribe(onUser, vi.fn());

    f.emit('TOKEN_REFRESHED', { user: authUser() });
    await new Promise((r) => setTimeout(r, 10));

    expect(onUser).not.toHaveBeenCalled();
    expect(f.client.from).not.toHaveBeenCalled();
  });

  it('signs out and reports an error when the profile is missing', async () => {
    const f = fakeClient({ profile: null });
    const onUser = vi.fn();
    const onError = vi.fn();
    createAuthService(() => f.client).subscribe(onUser, onError);

    f.emit('SIGNED_IN', { user: authUser() });

    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0][0]).toMatch(/no profile/i);
    expect(f.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(onUser).not.toHaveBeenCalledWith(expect.objectContaining({ id: PROFILE.id }));
  });

  it('reports a fetch failure without exposing the raw error', async () => {
    const f = fakeClient({ profileError: true });
    const onError = vi.fn();
    createAuthService(() => f.client).subscribe(vi.fn(), onError);

    f.emit('SIGNED_IN', { user: authUser() });

    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0][0]).not.toContain('boom');
  });

  it('stops listening when unsubscribed', () => {
    const f = fakeClient();
    const stop = createAuthService(() => f.client).subscribe(vi.fn(), vi.fn());
    stop();
    expect(f.unsubscribe).toHaveBeenCalled();
  });

  it('saves a signup phone number once, touching only the phone column', async () => {
    const f = fakeClient({ profile: { ...PROFILE, phone: null } });
    const onUser = vi.fn();
    createAuthService(() => f.client).subscribe(onUser, vi.fn());

    f.emit('SIGNED_IN', {
      user: authUser({ user_metadata: { phone: '9123456789', role: 'admin' } })
    });

    await vi.waitFor(() => expect(onUser).toHaveBeenCalled());
    expect(f.updates).toEqual([{ phone: '9123456789' }]);
    expect(onUser.mock.calls[0][0].phone).toBe('9123456789');
    expect(onUser.mock.calls[0][0].role).toBe('user');
  });
});

describe('updateOwnProfile', () => {
  it('writes only name and phone', async () => {
    const f = fakeClient({ session: { user: authUser() } });
    await createAuthService(() => f.client).updateOwnProfile({
      name: ' New Name ',
      phone: '9000000000',
      // a caller attempting to smuggle a role must have no effect
      ...({ role: 'admin' } as object)
    });

    expect(f.updates).toEqual([{ full_name: 'New Name', phone: '9000000000' }]);
  });

  it('requires a signed-in session', async () => {
    const f = fakeClient({ session: null });
    await expect(
      createAuthService(() => f.client).updateOwnProfile({ name: 'x' })
    ).rejects.toThrow(/not signed in/i);
  });
});
