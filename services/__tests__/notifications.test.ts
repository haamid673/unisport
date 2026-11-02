import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createNotificationRepository,
  mapNotificationRow,
  NotificationError,
  NOTIFICATION_KINDS,
  NOTIFICATION_MESSAGES,
  toNotificationError
} from '../notificationRepository';
import { describeNotification, notificationTarget } from '../notificationText';

// Stand-in client. The rules (who gets what, exactly once, only their own)
// are proven by supabase/tests/database/notifications_test.sql.

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

function fakeClient(options: { session?: { user: { id: string } } | null; rpc?: { data?: unknown; error?: unknown } | (() => never) } = {}) {
  const session = 'session' in options ? options.session : { user: { id: 'u' } };
  const rpc = vi.fn(async (..._a: unknown[]) => {
    if (typeof options.rpc === 'function') return options.rpc();
    return { data: options.rpc && 'data' in options.rpc ? options.rpc.data : null, error: options.rpc?.error ?? null };
  });
  const from = vi.fn();
  const client = {
    auth: { getSession: vi.fn(async () => ({ data: { session }, error: null })) },
    rpc,
    from
  } as unknown as SupabaseClient;
  return { repo: createNotificationRepository(() => client), rpc, from };
}

const failure = async (p: Promise<unknown>): Promise<NotificationError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof NotificationError) return e;
    throw e;
  }
  throw new Error('expected a rejection');
};

const row = (over: Record<string, unknown> = {}) => ({
  id: ID, kind: 'offer_issued', payload: { facility_name: 'Court' }, read_at: null,
  created_at: '2026-11-02T10:00:00Z', unread_count: 3, ...over
});

describe('notification repository', () => {
  it('loads through the function, never the table, and reports the unread count', async () => {
    const { repo, rpc, from } = fakeClient({ rpc: { data: [row(), row({ id: ID2, read_at: '2026-11-02T11:00:00Z' })] } });
    const list = await repo.load();
    expect(list.unreadCount).toBe(3);
    expect(list.items.map(i => i.id)).toEqual([ID, ID2]);
    expect(list.items[1].readAt).toBe('2026-11-02T11:00:00Z');
    expect(rpc).toHaveBeenCalledWith('get_my_notifications', { p_limit: 30 });
    expect(from).not.toHaveBeenCalled();
  });

  it('an empty list has nothing unread', async () => {
    expect(await fakeClient({ rpc: { data: [] } }).repo.load()).toEqual({ items: [], unreadCount: 0 });
  });

  it('rejects malformed rows and a non-array answer', async () => {
    for (const bad of [row({ kind: 'surprise' }), row({ id: 'x' }), row({ payload: null }), row({ unread_count: -1 }), row({ read_at: 5 })]) {
      expect(() => mapNotificationRow(bad)).toThrow(NotificationError);
    }
    expect((await failure(fakeClient({ rpc: { data: null } }).repo.load())).message).toBe(NOTIFICATION_MESSAGES.loadFailed);
  });

  it('marks some or all as read and returns the count the database changed', async () => {
    const some = fakeClient({ rpc: { data: 2 } });
    await expect(some.repo.markRead([ID, ID2])).resolves.toBe(2);
    expect(some.rpc).toHaveBeenCalledWith('mark_notifications_read', { p_ids: [ID, ID2] });
    const all = fakeClient({ rpc: { data: 5 } });
    await all.repo.markRead();
    expect(all.rpc).toHaveBeenCalledWith('mark_notifications_read', { p_ids: null });
  });

  it('never reports success for a bad count, and refuses bad ids before any request', async () => {
    for (const data of [null, '2', -1, 1.5]) {
      expect((await failure(fakeClient({ rpc: { data } }).repo.markRead())).message).toBe(NOTIFICATION_MESSAGES.markFailed);
    }
    const { repo, rpc } = fakeClient();
    expect((await failure(repo.markRead(['nope']))).kind).toBe('unknown');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('needs a session and keeps raw server text out of messages', async () => {
    const none = fakeClient({ session: null });
    expect((await failure(none.repo.load())).kind).toBe('unauthenticated');
    expect(none.rpc).not.toHaveBeenCalled();
    const odd = await failure(fakeClient({ rpc: { error: { code: 'XX000', message: 'relation "notifications" secret' } } }).repo.load());
    expect(odd.message).toBe(NOTIFICATION_MESSAGES.loadFailed);
    expect(toNotificationError(new TypeError('Failed to fetch'), 'x').kind).toBe('network');
    expect(toNotificationError({ code: '28000' }, 'x').kind).toBe('unauthenticated');
  });
});

describe('notification text and targets', () => {
  const slot = { facility_name: 'Kowdiar Court', booking_date: '2026-11-07', start_time: '18:00' };

  it('says something specific for every kind', () => {
    for (const kind of NOTIFICATION_KINDS) {
      const { title, detail } = describeNotification({ kind, payload: { ...slot, group_name: 'Smashers', event_title: 'Doubles' } });
      expect(title.length).toBeGreaterThan(5);
      expect(detail.length).toBeGreaterThan(5);
    }
  });

  it('names the venue, date and time for booking events', () => {
    expect(describeNotification({ kind: 'hold_expired', payload: slot }).detail).toContain('Kowdiar Court, 2026-11-07 at 18:00');
    expect(describeNotification({ kind: 'booking_cancelled', payload: slot }).title).toBe('Reservation cancelled');
    expect(describeNotification({ kind: 'offer_issued', payload: { ...slot, offer_expires_at: '2026-11-07T14:57:00Z' } }).detail).toMatch(/before \d/);
  });

  it('leaves out what the payload lacks instead of inventing it', () => {
    const d = describeNotification({ kind: 'facility_approved', payload: {} }).detail;
    expect(d).toContain('Your venue');
    expect(describeNotification({ kind: 'offer_issued', payload: {} }).detail).toContain('your venue');
    expect(describeNotification({ kind: 'offer_issued', payload: {} }).detail).not.toMatch(/undefined|null|Invalid/);
  });

  it('leads each kind to a screen that exists', () => {
    expect(notificationTarget({ kind: 'offer_issued', payload: {} })).toBe('/');
    expect(notificationTarget({ kind: 'hold_expired', payload: {} })).toBe('/');
    expect(notificationTarget({ kind: 'facility_rejected', payload: {} })).toBe('/owner');
    expect(notificationTarget({ kind: 'group_approved', payload: { group_id: 'g1' } })).toBe('/community/g1');
    expect(notificationTarget({ kind: 'group_rejected', payload: { group_id: 'g1' } })).toBe('/community');
    expect(notificationTarget({ kind: 'event_approved', payload: { group_id: 'g1' } })).toBe('/community/g1');
    expect(notificationTarget({ kind: 'event_approved', payload: {} })).toBe('/community');
  });
});
