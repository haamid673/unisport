import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from './supabaseClient';
import { UUID_PATTERN, isCalendarDate } from './bookingRepository';

/**
 * Community groups and events, backed by Supabase.
 *
 * Contract (supabase/migrations/20261027100000_community.sql): the four
 * community tables are closed to clients; everything goes through
 *
 *   create_group, join_group, leave_group, create_event, join_event,
 *   leave_event, get_community_groups, get_community_events
 *
 * The database decides every rule (approval, membership, capacity,
 * venue/city match, dates). This module sends the request and reports
 * what the database answered; a malformed answer is a failure. There is
 * no fallback to local or demo data.
 */

export type ApprovalState = 'pending' | 'approved' | 'rejected';

export type CommunityFailureKind =
  | 'unauthenticated'
  | 'not_found'
  /** Join the group first. */
  | 'not_member'
  | 'full'
  /** Not open: group or event not approved, or the date has passed. */
  | 'closed'
  /** Too many items already waiting for approval. */
  | 'limit'
  | 'duplicate'
  | 'invalid'
  | 'network'
  | 'unknown';

export class CommunityError extends Error {
  readonly kind: CommunityFailureKind;

  constructor(kind: CommunityFailureKind, message: string) {
    super(message);
    this.name = 'CommunityError';
    this.kind = kind;
  }
}

export interface CommunityGroupView {
  id: string;
  name: string;
  sport: string;
  city: string;
  description: string | null;
  status: ApprovalState;
  createdBy: string;
  memberCount: number;
  isMember: boolean;
  createdAt: string;
}

export interface CommunityEventView {
  id: string;
  groupId: string;
  groupName: string;
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM */
  time: string;
  facilityId: string;
  facilityName: string;
  city: string;
  capacity: number | null;
  status: ApprovalState;
  createdBy: string;
  participantCount: number;
  isParticipant: boolean;
  createdAt: string;
}

export interface NewGroup {
  name: string;
  sport: string;
  city: string;
  description?: string;
}

export interface NewEvent {
  groupId: string;
  title: string;
  date: string;
  /** HH:MM */
  time: string;
  facilityId: string;
  capacity?: number | null;
}

export const COMMUNITY_MESSAGES = {
  unauthenticated: 'Your session has expired. Please sign in again.',
  notFound: 'That community or event is no longer available.',
  notMember: 'Join the community first.',
  full: 'This event is full.',
  closed: 'This is not open for joining.',
  limitGroup: 'You already have several communities waiting for approval. Wait for a decision before creating another.',
  limitEvent: 'You already have several events waiting for approval. Wait for a decision before creating another.',
  duplicate: 'A community with that name already exists in this city.',
  invalid: 'Those details are not valid. Check them and try again.',
  pastDate: 'Choose today or a later date.',
  notApprovedGroup: 'This community has not been approved yet.',
  network: 'Could not reach the service. Check the current state before trying again.',
  unknown: 'That did not work. Check the current state before trying again.',
  loadFailed: 'Could not load communities. Please try again.'
} as const;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

/** Map a PostgREST/Postgres error to a safe CommunityError. Never leaks raw text. */
export function toCommunityError(error: unknown): CommunityError {
  if (error instanceof CommunityError) return error;

  const e = asRecord(error);
  const code = typeof e?.code === 'string' ? e.code : undefined;
  const raw = typeof e?.message === 'string' ? e.message : '';

  switch (code) {
    case '28000':
    case '42501':
    case 'PGRST301':
    case 'PGRST302':
      return new CommunityError('unauthenticated', COMMUNITY_MESSAGES.unauthenticated);
    case 'P0002':
      return new CommunityError('not_found', COMMUNITY_MESSAGES.notFound);
    case 'UC001':
      return new CommunityError('not_member', COMMUNITY_MESSAGES.notMember);
    case 'UC002':
      return new CommunityError('full', COMMUNITY_MESSAGES.full);
    case 'UC003':
      return new CommunityError(
        'closed',
        /group is not approved/i.test(raw) ? COMMUNITY_MESSAGES.notApprovedGroup : COMMUNITY_MESSAGES.closed
      );
    case 'UC004':
      return new CommunityError('limit', /events/i.test(raw) ? COMMUNITY_MESSAGES.limitEvent : COMMUNITY_MESSAGES.limitGroup);
    case 'UC005':
      return new CommunityError('duplicate', COMMUNITY_MESSAGES.duplicate);
    case '22007':
      return new CommunityError('invalid', COMMUNITY_MESSAGES.pastDate);
    case '22023':
    case '22P02':
      return new CommunityError('invalid', COMMUNITY_MESSAGES.invalid);
  }

  const status = typeof e?.status === 'number' ? e.status : undefined;
  const name = typeof e?.name === 'string' ? e.name : '';

  if (
    name === 'AuthRetryableFetchError' ||
    status === 0 ||
    (error instanceof TypeError && /fetch|network/i.test(error.message))
  ) {
    return new CommunityError('network', COMMUNITY_MESSAGES.network);
  }

  return new CommunityError('unknown', COMMUNITY_MESSAGES.unknown);
}

const STATES: readonly ApprovalState[] = ['pending', 'approved', 'rejected'];

const asCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

export function mapGroupRow(row: unknown): CommunityGroupView {
  const r = asRecord(row);
  const memberCount = asCount(r?.member_count);

  if (
    typeof r?.id !== 'string' ||
    typeof r.name !== 'string' ||
    typeof r.sport !== 'string' ||
    typeof r.city !== 'string' ||
    typeof r.created_by !== 'string' ||
    typeof r.created_at !== 'string' ||
    typeof r.is_member !== 'boolean' ||
    memberCount === null ||
    !STATES.includes(r.status as ApprovalState)
  ) {
    throw new CommunityError('unknown', COMMUNITY_MESSAGES.loadFailed);
  }

  return {
    id: r.id,
    name: r.name,
    sport: r.sport,
    city: r.city,
    description: typeof r.description === 'string' ? r.description : null,
    status: r.status as ApprovalState,
    createdBy: r.created_by,
    memberCount,
    isMember: r.is_member,
    createdAt: r.created_at
  };
}

/** "18:30:00" -> "18:30". */
const shortTime = (value: string): string => value.slice(0, 5);

export function mapEventRow(row: unknown): CommunityEventView {
  const r = asRecord(row);
  const participantCount = asCount(r?.participant_count);
  const capacity = r?.capacity === null ? null : asCount(r?.capacity);

  if (
    typeof r?.id !== 'string' ||
    typeof r.group_id !== 'string' ||
    typeof r.group_name !== 'string' ||
    typeof r.title !== 'string' ||
    typeof r.event_date !== 'string' ||
    typeof r.event_time !== 'string' ||
    typeof r.facility_id !== 'string' ||
    typeof r.facility_name !== 'string' ||
    typeof r.city !== 'string' ||
    typeof r.created_by !== 'string' ||
    typeof r.created_at !== 'string' ||
    typeof r.is_participant !== 'boolean' ||
    participantCount === null ||
    capacity === undefined ||
    !STATES.includes(r.status as ApprovalState)
  ) {
    throw new CommunityError('unknown', COMMUNITY_MESSAGES.loadFailed);
  }

  return {
    id: r.id,
    groupId: r.group_id,
    groupName: r.group_name,
    title: r.title,
    date: r.event_date,
    time: shortTime(r.event_time),
    facilityId: r.facility_id,
    facilityName: r.facility_name,
    city: r.city,
    capacity,
    status: r.status as ApprovalState,
    createdBy: r.created_by,
    participantCount,
    isParticipant: r.is_participant,
    createdAt: r.created_at
  };
}

const TIME_INPUT = /^([01]\d|2[0-3]):[0-5]\d$/;

/** True when an event has a place left (always true without a capacity). */
export const hasPlace = (e: Pick<CommunityEventView, 'capacity' | 'participantCount'>): boolean =>
  e.capacity === null || e.participantCount < e.capacity;

export function createCommunityRepository(getClient: () => SupabaseClient) {
  async function requireClient(): Promise<SupabaseClient> {
    let client: SupabaseClient;
    try {
      client = getClient();
    } catch {
      throw new CommunityError('unknown', 'The service is not configured. Please contact support.');
    }

    let signedIn = false;
    try {
      const { data, error } = await client.auth.getSession();
      signedIn = !error && Boolean(data.session?.user?.id);
    } catch {
      signedIn = false;
    }

    if (!signedIn) throw new CommunityError('unauthenticated', COMMUNITY_MESSAGES.unauthenticated);
    return client;
  }

  async function call(fn: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const client = await requireClient();

    let result: { data: unknown; error: unknown };
    try {
      result = await client.rpc(fn, args);
    } catch (error) {
      throw toCommunityError(error);
    }
    if (result.error) throw toCommunityError(result.error);
    return result.data;
  }

  const requireId = (value: string) => {
    if (!UUID_PATTERN.test(value)) throw new CommunityError('invalid', COMMUNITY_MESSAGES.invalid);
  };

  const requireId2 = (data: unknown): string => {
    if (typeof data !== 'string' || !UUID_PATTERN.test(data)) {
      throw new CommunityError('unknown', COMMUNITY_MESSAGES.unknown);
    }
    return data;
  };

  const requireBoolean = (data: unknown): boolean => {
    if (typeof data !== 'boolean') throw new CommunityError('unknown', COMMUNITY_MESSAGES.unknown);
    return data;
  };

  const rows = (data: unknown): unknown[] => {
    if (!Array.isArray(data)) throw new CommunityError('unknown', COMMUNITY_MESSAGES.loadFailed);
    return data;
  };

  const asLoadError = (err: unknown): never => {
    const mapped = toCommunityError(err);
    throw mapped.kind === 'unknown' ? new CommunityError('unknown', COMMUNITY_MESSAGES.loadFailed) : mapped;
  };

  return {
    /** Approved groups plus the caller's own pending ones. */
    async loadGroups(): Promise<CommunityGroupView[]> {
      try {
        return rows(await call('get_community_groups')).map(mapGroupRow);
      } catch (err) {
        return asLoadError(err);
      }
    },

    /** Events of one group, or (onlyMine) every event the caller takes part in. */
    async loadEvents(options: { groupId?: string; onlyMine?: boolean } = {}): Promise<CommunityEventView[]> {
      if (options.groupId !== undefined) requireId(options.groupId);
      try {
        return rows(
          await call('get_community_events', {
            p_group_id: options.groupId ?? null,
            p_only_mine: options.onlyMine === true
          })
        ).map(mapEventRow);
      } catch (err) {
        return asLoadError(err);
      }
    },

    /** Resolves with the new group's id. It starts pending unless the caller is an administrator. */
    async createGroup(group: NewGroup): Promise<string> {
      const name = group.name.trim();
      const sport = group.sport.trim();
      const city = group.city.trim();
      if (name.length < 2 || name.length > 100 || sport.length < 2 || sport.length > 50 || city.length < 2 || city.length > 100) {
        throw new CommunityError('invalid', COMMUNITY_MESSAGES.invalid);
      }
      return requireId2(
        await call('create_group', {
          p_name: name,
          p_sport: sport,
          p_city: city,
          p_description: group.description?.trim() ? group.description.trim() : null
        })
      );
    },

    /** Resolves true when newly joined, false when already a member. */
    async joinGroup(groupId: string): Promise<boolean> {
      requireId(groupId);
      return requireBoolean(await call('join_group', { p_group_id: groupId }));
    },

    /** Also leaves the group's events. Resolves true when the person was a member. */
    async leaveGroup(groupId: string): Promise<boolean> {
      requireId(groupId);
      return requireBoolean(await call('leave_group', { p_group_id: groupId }));
    },

    /** Resolves with the new event's id. It starts pending unless the caller is an administrator. */
    async createEvent(event: NewEvent): Promise<string> {
      const title = event.title.trim();
      requireId(event.groupId);
      requireId(event.facilityId);
      if (
        title.length < 2 ||
        title.length > 150 ||
        !isCalendarDate(event.date) ||
        !TIME_INPUT.test(event.time) ||
        (event.capacity != null && (!Number.isInteger(event.capacity) || event.capacity < 1 || event.capacity > 500))
      ) {
        throw new CommunityError('invalid', COMMUNITY_MESSAGES.invalid);
      }
      return requireId2(
        await call('create_event', {
          p_group_id: event.groupId,
          p_title: title,
          p_event_date: event.date,
          p_event_time: event.time,
          p_facility_id: event.facilityId,
          p_capacity: event.capacity ?? null
        })
      );
    },

    /** Resolves true when newly joined, false when already taking part. */
    async joinEvent(eventId: string): Promise<boolean> {
      requireId(eventId);
      return requireBoolean(await call('join_event', { p_event_id: eventId }));
    },

    async leaveEvent(eventId: string): Promise<boolean> {
      requireId(eventId);
      return requireBoolean(await call('leave_event', { p_event_id: eventId }));
    }
  };
}

export const communityRepository = createCommunityRepository(getSupabase);
