import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from './supabaseClient';
import { UUID_PATTERN } from './bookingRepository';

/**
 * In-app notifications, backed by Supabase.
 *
 * Contract (supabase/migrations/20261028100000_notifications.sql): the
 * table is closed to clients. A person reads and marks only their own,
 * through get_my_notifications(p_limit) and mark_notifications_read(p_ids).
 * Notifications are written only by the database. No fallback to local
 * data, ever.
 */

export const NOTIFICATION_KINDS = [
  'offer_issued',
  'offer_expiring',
  'hold_expired',
  'booking_cancelled',
  'facility_approved',
  'facility_rejected',
  'facility_suspended',
  'group_approved',
  'group_rejected',
  'event_approved',
  'event_rejected'
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationList {
  items: AppNotification[];
  unreadCount: number;
}

export class NotificationError extends Error {
  readonly kind: 'unauthenticated' | 'network' | 'unknown';

  constructor(kind: 'unauthenticated' | 'network' | 'unknown', message: string) {
    super(message);
    this.name = 'NotificationError';
    this.kind = kind;
  }
}

export const NOTIFICATION_MESSAGES = {
  unauthenticated: 'Your session has expired. Please sign in again.',
  network: 'Could not reach the service. Notifications will refresh when it is back.',
  loadFailed: 'Could not load notifications.',
  markFailed: 'Could not mark notifications as read.'
} as const;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export function toNotificationError(error: unknown, fallback: string): NotificationError {
  if (error instanceof NotificationError) return error;

  const e = asRecord(error);
  const code = typeof e?.code === 'string' ? e.code : undefined;

  if (code === '28000' || code === '42501' || code === 'PGRST301' || code === 'PGRST302') {
    return new NotificationError('unauthenticated', NOTIFICATION_MESSAGES.unauthenticated);
  }

  const status = typeof e?.status === 'number' ? e.status : undefined;
  const name = typeof e?.name === 'string' ? e.name : '';
  if (
    name === 'AuthRetryableFetchError' ||
    status === 0 ||
    (error instanceof TypeError && /fetch|network/i.test(error.message))
  ) {
    return new NotificationError('network', NOTIFICATION_MESSAGES.network);
  }

  return new NotificationError('unknown', fallback);
}

export function mapNotificationRow(row: unknown): { item: AppNotification; unread: number } {
  const r = asRecord(row);
  const payload = asRecord(r?.payload);
  const unread = r?.unread_count;

  if (
    typeof r?.id !== 'string' ||
    !UUID_PATTERN.test(r.id) ||
    !NOTIFICATION_KINDS.includes(r.kind as NotificationKind) ||
    payload === null ||
    typeof r.created_at !== 'string' ||
    (r.read_at !== null && typeof r.read_at !== 'string') ||
    typeof unread !== 'number' ||
    !Number.isInteger(unread) ||
    unread < 0
  ) {
    throw new NotificationError('unknown', NOTIFICATION_MESSAGES.loadFailed);
  }

  return {
    item: {
      id: r.id,
      kind: r.kind as NotificationKind,
      payload,
      readAt: r.read_at as string | null,
      createdAt: r.created_at
    },
    unread
  };
}

export function createNotificationRepository(getClient: () => SupabaseClient) {
  async function call(fn: string, args: Record<string, unknown>, fallback: string): Promise<unknown> {
    let client: SupabaseClient;
    try {
      client = getClient();
    } catch {
      throw new NotificationError('unknown', fallback);
    }

    let signedIn = false;
    try {
      const { data, error } = await client.auth.getSession();
      signedIn = !error && Boolean(data.session?.user?.id);
    } catch {
      signedIn = false;
    }
    if (!signedIn) throw new NotificationError('unauthenticated', NOTIFICATION_MESSAGES.unauthenticated);

    let result: { data: unknown; error: unknown };
    try {
      result = await client.rpc(fn, args);
    } catch (error) {
      throw toNotificationError(error, fallback);
    }
    if (result.error) throw toNotificationError(result.error, fallback);
    return result.data;
  }

  return {
    /** The person's newest notifications and their total unread count. */
    async load(limit = 30): Promise<NotificationList> {
      const data = await call('get_my_notifications', { p_limit: limit }, NOTIFICATION_MESSAGES.loadFailed);
      if (!Array.isArray(data)) throw new NotificationError('unknown', NOTIFICATION_MESSAGES.loadFailed);

      const mapped = data.map(mapNotificationRow);
      // The count is the same on every row; an empty list has none unread.
      return { items: mapped.map(m => m.item), unreadCount: mapped[0]?.unread ?? 0 };
    },

    /** Mark some (or, with no ids, all) of the person's notifications read. Resolves with how many changed. */
    async markRead(ids?: string[]): Promise<number> {
      if (ids !== undefined && ids.some(id => !UUID_PATTERN.test(id))) {
        throw new NotificationError('unknown', NOTIFICATION_MESSAGES.markFailed);
      }
      const data = await call(
        'mark_notifications_read',
        { p_ids: ids ?? null },
        NOTIFICATION_MESSAGES.markFailed
      );
      if (typeof data !== 'number' || !Number.isInteger(data) || data < 0) {
        throw new NotificationError('unknown', NOTIFICATION_MESSAGES.markFailed);
      }
      return data;
    }
  };
}

export const notificationRepository = createNotificationRepository(getSupabase);
