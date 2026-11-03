import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from './supabaseClient';
import { UUID_PATTERN, toAmount } from './bookingRepository';
import type { FacilityRecordStatus } from './ownerFacilityRepository';

/**
 * Administrator operations, backed by Supabase.
 *
 * Contract (supabase/migrations/20261026100000_admin_functions.sql):
 *
 *   admin_set_facility_status(p_facility_id uuid, p_status facility_status)
 *   admin_find_user_by_email(p_email text)  -> 0 or 1 row
 *   admin_set_user_role(p_user_id uuid, p_role user_role)
 *
 * Every one is refused by the database unless the caller is an
 * administrator; hiding the console from other roles is a convenience,
 * not the security boundary. Venues are read with a plain SELECT, which
 * the facilities policy already opens to administrators.
 *
 * Success is reported only when the database answered with the value
 * that was asked for; a malformed answer is a failure. No fallback to
 * local or demo data, ever.
 */

export const SET_FACILITY_STATUS_RPC = 'admin_set_facility_status';
export const FIND_USER_RPC = 'admin_find_user_by_email';
export const SET_USER_ROLE_RPC = 'admin_set_user_role';
export const LIST_GROUPS_RPC = 'admin_list_community_groups';
export const LIST_EVENTS_RPC = 'admin_list_community_events';
export const SET_GROUP_STATUS_RPC = 'admin_set_group_status';
export const SET_EVENT_STATUS_RPC = 'admin_set_event_status';
export const LIST_ACTIONS_RPC = 'admin_list_actions';

export type ApprovalDecision = 'pending' | 'approved' | 'rejected';
const APPROVAL_DECISIONS: readonly ApprovalDecision[] = ['pending', 'approved', 'rejected'];

export const ADMIN_FACILITY_LIMIT = 200;

export type AdminFailureKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  /** The database refused on a rule (own role, last administrator). */
  | 'rule'
  | 'invalid'
  | 'network'
  | 'unknown';

export class AdminError extends Error {
  readonly kind: AdminFailureKind;

  constructor(kind: AdminFailureKind, message: string) {
    super(message);
    this.name = 'AdminError';
    this.kind = kind;
  }
}

export type UserRole = 'user' | 'owner' | 'admin';
export const USER_ROLES: readonly UserRole[] = ['user', 'owner', 'admin'];
export const FACILITY_STATUSES: readonly FacilityRecordStatus[] = [
  'pending',
  'active',
  'suspended',
  'rejected'
];

export interface AdminFacility {
  id: string;
  name: string;
  sport: string;
  address: string;
  city: string;
  basePrice: number;
  status: FacilityRecordStatus;
  createdAt: string;
}

export interface AdminUser {
  id: string;
  email: string;
  fullName: string | null;
  role: UserRole;
}

export interface AdminGroup {
  id: string;
  name: string;
  sport: string;
  city: string;
  description: string | null;
  status: ApprovalDecision;
  createdByEmail: string | null;
  memberCount: number;
  createdAt: string;
}

export interface AdminEvent {
  id: string;
  groupName: string;
  groupStatus: ApprovalDecision;
  title: string;
  date: string;
  time: string;
  facilityName: string;
  capacity: number | null;
  status: ApprovalDecision;
  createdByEmail: string | null;
  createdAt: string;
}

/** One recorded administrator action, newest first. */
export interface AdminAction {
  id: string;
  adminEmail: string | null;
  targetType: 'facility' | 'group' | 'event' | 'user';
  targetLabel: string | null;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
}

export const ADMIN_MESSAGES = {
  unauthenticated: 'Your session has expired. Please sign in again.',
  forbidden: 'Only administrators can do this.',
  facilityNotFound: 'That venue no longer exists. Refresh the list.',
  userNotFound: 'That account no longer exists.',
  ownRole: 'You cannot change your own role. Ask another administrator.',
  lastAdmin: 'The last administrator cannot be removed.',
  invalid: 'That request is not valid.',
  network: 'Could not reach the service. Check the current state before trying again.',
  unknown: 'That did not work. Check the current state before trying again.',
  loadFailed: 'Could not load the venues. Please try again.',
  communityLoadFailed: 'Could not load the community requests. Please try again.',
  actionsLoadFailed: 'Could not load the recent actions. Please try again.',
  groupNotFound: 'That community no longer exists. Refresh the list.',
  eventNotFound: 'That event no longer exists. Refresh the list.',
  groupNameTaken: 'Another community with that name already exists in this city, so this one cannot be approved.',
  emailRequired: 'Enter the full email address of the account.'
} as const;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

/** Map a PostgREST/Postgres error to a safe AdminError. Never leaks raw text. */
export function toAdminError(
  error: unknown,
  subject: 'facility' | 'user' | 'group' | 'event' = 'facility'
): AdminError {
  if (error instanceof AdminError) return error;

  const e = asRecord(error);
  const code = typeof e?.code === 'string' ? e.code : undefined;

  switch (code) {
    case '28000':
    case 'PGRST301':
    case 'PGRST302':
      return new AdminError('unauthenticated', ADMIN_MESSAGES.unauthenticated);
    case '42501':
      return new AdminError('forbidden', ADMIN_MESSAGES.forbidden);
    case 'P0002':
      return new AdminError(
        'not_found',
        subject === 'user'
          ? ADMIN_MESSAGES.userNotFound
          : subject === 'group'
          ? ADMIN_MESSAGES.groupNotFound
          : subject === 'event'
          ? ADMIN_MESSAGES.eventNotFound
          : ADMIN_MESSAGES.facilityNotFound
      );
    case 'UB007':
      return new AdminError('rule', ADMIN_MESSAGES.ownRole);
    case 'UB008':
      return new AdminError('rule', ADMIN_MESSAGES.lastAdmin);
    case 'UC005':
      return new AdminError('rule', ADMIN_MESSAGES.groupNameTaken);
    case '22023':
    case '22P02':
      return new AdminError('invalid', ADMIN_MESSAGES.invalid);
  }

  const status = typeof e?.status === 'number' ? e.status : undefined;
  const name = typeof e?.name === 'string' ? e.name : '';

  if (
    name === 'AuthRetryableFetchError' ||
    status === 0 ||
    (error instanceof TypeError && /fetch|network/i.test(error.message))
  ) {
    return new AdminError('network', ADMIN_MESSAGES.network);
  }

  return new AdminError('unknown', ADMIN_MESSAGES.unknown);
}

/** Columns read for the venue list. Exactly what the console displays. */
export const ADMIN_FACILITY_COLUMNS =
  'id, name, sport, address, city, base_price, status, created_at';

export function mapAdminFacility(row: unknown): AdminFacility {
  const r = asRecord(row);
  const basePrice = toAmount(r?.base_price);

  if (
    typeof r?.id !== 'string' ||
    typeof r.name !== 'string' ||
    typeof r.sport !== 'string' ||
    typeof r.address !== 'string' ||
    typeof r.city !== 'string' ||
    typeof r.created_at !== 'string' ||
    basePrice === null ||
    !FACILITY_STATUSES.includes(r.status as FacilityRecordStatus)
  ) {
    throw new AdminError('unknown', ADMIN_MESSAGES.loadFailed);
  }

  return {
    id: r.id,
    name: r.name,
    sport: r.sport,
    address: r.address,
    city: r.city,
    basePrice,
    status: r.status as FacilityRecordStatus,
    createdAt: r.created_at
  };
}

/** The lookup answers with zero or one row; anything else is malformed. */
export function parseAdminUser(data: unknown): AdminUser | null {
  if (!Array.isArray(data)) throw new AdminError('unknown', ADMIN_MESSAGES.unknown);
  if (data.length === 0) return null;
  if (data.length > 1) throw new AdminError('unknown', ADMIN_MESSAGES.unknown);

  const r = asRecord(data[0]);
  if (
    typeof r?.user_id !== 'string' ||
    !UUID_PATTERN.test(r.user_id) ||
    typeof r.email !== 'string' ||
    !USER_ROLES.includes(r.role as UserRole)
  ) {
    throw new AdminError('unknown', ADMIN_MESSAGES.unknown);
  }

  return {
    id: r.user_id,
    email: r.email,
    fullName: typeof r.full_name === 'string' ? r.full_name : null,
    role: r.role as UserRole
  };
}

const asCount = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;

export function mapAdminGroup(row: unknown): AdminGroup {
  const r = asRecord(row);
  const memberCount = asCount(r?.member_count);
  if (
    typeof r?.id !== 'string' ||
    typeof r.name !== 'string' ||
    typeof r.sport !== 'string' ||
    typeof r.city !== 'string' ||
    typeof r.created_at !== 'string' ||
    memberCount === null ||
    !APPROVAL_DECISIONS.includes(r.status as ApprovalDecision)
  ) {
    throw new AdminError('unknown', ADMIN_MESSAGES.communityLoadFailed);
  }
  return {
    id: r.id,
    name: r.name,
    sport: r.sport,
    city: r.city,
    description: typeof r.description === 'string' ? r.description : null,
    status: r.status as ApprovalDecision,
    createdByEmail: typeof r.created_by_email === 'string' ? r.created_by_email : null,
    memberCount,
    createdAt: r.created_at
  };
}

export function mapAdminEvent(row: unknown): AdminEvent {
  const r = asRecord(row);
  const capacity = r?.capacity === null ? null : asCount(r?.capacity);
  if (
    typeof r?.id !== 'string' ||
    typeof r.group_name !== 'string' ||
    typeof r.title !== 'string' ||
    typeof r.event_date !== 'string' ||
    typeof r.event_time !== 'string' ||
    typeof r.facility_name !== 'string' ||
    typeof r.created_at !== 'string' ||
    capacity === undefined ||
    !APPROVAL_DECISIONS.includes(r.status as ApprovalDecision) ||
    !APPROVAL_DECISIONS.includes(r.group_status as ApprovalDecision)
  ) {
    throw new AdminError('unknown', ADMIN_MESSAGES.communityLoadFailed);
  }
  return {
    id: r.id,
    groupName: r.group_name,
    groupStatus: r.group_status as ApprovalDecision,
    title: r.title,
    date: r.event_date,
    time: r.event_time.slice(0, 5),
    facilityName: r.facility_name,
    capacity,
    status: r.status as ApprovalDecision,
    createdByEmail: typeof r.created_by_email === 'string' ? r.created_by_email : null,
    createdAt: r.created_at
  };
}

const ACTION_TARGETS: readonly AdminAction['targetType'][] = ['facility', 'group', 'event', 'user'];
const textOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function mapAdminAction(row: unknown): AdminAction {
  const r = asRecord(row);
  if (
    typeof r?.id !== 'string' ||
    typeof r.created_at !== 'string' ||
    !ACTION_TARGETS.includes(r.target_type as AdminAction['targetType'])
  ) {
    throw new AdminError('unknown', ADMIN_MESSAGES.actionsLoadFailed);
  }
  return {
    id: r.id,
    adminEmail: textOrNull(r.admin_email),
    targetType: r.target_type as AdminAction['targetType'],
    targetLabel: textOrNull(r.target_label),
    oldValue: textOrNull(r.old_value),
    newValue: textOrNull(r.new_value),
    createdAt: r.created_at
  };
}

export function createAdminRepository(getClient: () => SupabaseClient) {
  async function requireClient(): Promise<SupabaseClient> {
    let client: SupabaseClient;
    try {
      client = getClient();
    } catch {
      throw new AdminError('unknown', 'The service is not configured. Please contact support.');
    }

    let signedIn = false;
    try {
      const { data, error } = await client.auth.getSession();
      signedIn = !error && Boolean(data.session?.user?.id);
    } catch {
      signedIn = false;
    }

    if (!signedIn) throw new AdminError('unauthenticated', ADMIN_MESSAGES.unauthenticated);
    return client;
  }

  async function call(
    client: SupabaseClient,
    fn: string,
    args: Record<string, unknown>,
    subject: 'facility' | 'user' | 'group' | 'event'
  ): Promise<unknown> {
    let result: { data: unknown; error: unknown };
    try {
      result = await client.rpc(fn, args);
    } catch (error) {
      throw toAdminError(error, subject);
    }
    if (result.error) throw toAdminError(result.error, subject);
    return result.data;
  }

  return {
    /** Every venue, newest first. Read through the administrators' SELECT policy. */
    async loadFacilities(): Promise<AdminFacility[]> {
      const client = await requireClient();

      let result: { data: unknown; error: unknown };
      try {
        result = await client
          .from('facilities')
          .select(ADMIN_FACILITY_COLUMNS)
          .order('created_at', { ascending: false })
          .limit(ADMIN_FACILITY_LIMIT);
      } catch (error) {
        throw toAdminError(error);
      }

      if (result.error) {
        const mapped = toAdminError(result.error);
        throw mapped.kind === 'unknown' ? new AdminError('unknown', ADMIN_MESSAGES.loadFailed) : mapped;
      }
      if (!Array.isArray(result.data)) throw new AdminError('unknown', ADMIN_MESSAGES.loadFailed);

      return result.data.map(mapAdminFacility);
    },

    /** Resolves with the status the database now holds, which must be the one asked for. */
    async setFacilityStatus(
      facilityId: string,
      status: FacilityRecordStatus
    ): Promise<FacilityRecordStatus> {
      if (!UUID_PATTERN.test(facilityId) || !FACILITY_STATUSES.includes(status)) {
        throw new AdminError('invalid', ADMIN_MESSAGES.invalid);
      }
      const client = await requireClient();
      const data = await call(
        client,
        SET_FACILITY_STATUS_RPC,
        { p_facility_id: facilityId, p_status: status },
        'facility'
      );
      if (data !== status) throw new AdminError('unknown', ADMIN_MESSAGES.unknown);
      return status;
    },

    /** One account by its full email address, or null when there is none. */
    async findUserByEmail(email: string): Promise<AdminUser | null> {
      const trimmed = email.trim();
      if (trimmed === '' || !trimmed.includes('@')) {
        throw new AdminError('invalid', ADMIN_MESSAGES.emailRequired);
      }
      const client = await requireClient();
      return parseAdminUser(await call(client, FIND_USER_RPC, { p_email: trimmed }, 'user'));
    },

    /** Communities awaiting a decision (or every status when none is given). */
    async loadCommunityGroups(status: ApprovalDecision | null = 'pending'): Promise<AdminGroup[]> {
      const client = await requireClient();
      try {
        const data = await call(client, LIST_GROUPS_RPC, { p_status: status }, 'group');
        if (!Array.isArray(data)) throw new AdminError('unknown', ADMIN_MESSAGES.communityLoadFailed);
        return data.map(mapAdminGroup);
      } catch (err) {
        const mapped = toAdminError(err, 'group');
        throw mapped.kind === 'unknown' ? new AdminError('unknown', ADMIN_MESSAGES.communityLoadFailed) : mapped;
      }
    },

    /** Events awaiting a decision (or every status when none is given). */
    async loadCommunityEvents(status: ApprovalDecision | null = 'pending'): Promise<AdminEvent[]> {
      const client = await requireClient();
      try {
        const data = await call(client, LIST_EVENTS_RPC, { p_status: status }, 'event');
        if (!Array.isArray(data)) throw new AdminError('unknown', ADMIN_MESSAGES.communityLoadFailed);
        return data.map(mapAdminEvent);
      } catch (err) {
        const mapped = toAdminError(err, 'event');
        throw mapped.kind === 'unknown' ? new AdminError('unknown', ADMIN_MESSAGES.communityLoadFailed) : mapped;
      }
    },

    async setGroupStatus(groupId: string, status: ApprovalDecision): Promise<ApprovalDecision> {
      if (!UUID_PATTERN.test(groupId) || !APPROVAL_DECISIONS.includes(status)) {
        throw new AdminError('invalid', ADMIN_MESSAGES.invalid);
      }
      const client = await requireClient();
      const data = await call(client, SET_GROUP_STATUS_RPC, { p_group_id: groupId, p_status: status }, 'group');
      if (data !== status) throw new AdminError('unknown', ADMIN_MESSAGES.unknown);
      return status;
    },

    async setEventStatus(eventId: string, status: ApprovalDecision): Promise<ApprovalDecision> {
      if (!UUID_PATTERN.test(eventId) || !APPROVAL_DECISIONS.includes(status)) {
        throw new AdminError('invalid', ADMIN_MESSAGES.invalid);
      }
      const client = await requireClient();
      const data = await call(client, SET_EVENT_STATUS_RPC, { p_event_id: eventId, p_status: status }, 'event');
      if (data !== status) throw new AdminError('unknown', ADMIN_MESSAGES.unknown);
      return status;
    },

    /** The audit trail, newest first. */
    async loadActions(limit = 20): Promise<AdminAction[]> {
      const client = await requireClient();
      try {
        const data = await call(client, LIST_ACTIONS_RPC, { p_limit: limit }, 'facility');
        if (!Array.isArray(data)) throw new AdminError('unknown', ADMIN_MESSAGES.actionsLoadFailed);
        return data.map(mapAdminAction);
      } catch (err) {
        const mapped = toAdminError(err);
        throw mapped.kind === 'unknown' ? new AdminError('unknown', ADMIN_MESSAGES.actionsLoadFailed) : mapped;
      }
    },

    /** Resolves with the role the database now holds, which must be the one asked for. */
    async setUserRole(userId: string, role: UserRole): Promise<UserRole> {
      if (!UUID_PATTERN.test(userId) || !USER_ROLES.includes(role)) {
        throw new AdminError('invalid', ADMIN_MESSAGES.invalid);
      }
      const client = await requireClient();
      const data = await call(client, SET_USER_ROLE_RPC, { p_user_id: userId, p_role: role }, 'user');
      if (data !== role) throw new AdminError('unknown', ADMIN_MESSAGES.unknown);
      return role;
    }
  };
}

export const adminRepository = createAdminRepository(getSupabase);
