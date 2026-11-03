import type { AppNotification, NotificationKind } from './notificationRepository';
import { communityPath, ROUTES } from './routes';

/**
 * What a notification says and where it leads. Text is built from the
 * kind and the few facts the database stored in the payload; a missing
 * fact is left out rather than invented.
 */

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** "Kowdiar Court, 2026-11-07 at 18:00" from the payload, whatever is present. */
function slotLine(p: Record<string, unknown>): string {
  const place = text(p.facility_name) ?? 'your venue';
  const date = text(p.booking_date);
  const time = text(p.start_time);
  return [place, date && time ? `${date} at ${time}` : date ?? time].filter(Boolean).join(', ');
}

/** "20:27" in the viewer's own time, from an ISO timestamp. */
function clock(value: unknown): string | null {
  const s = text(value);
  if (!s || Number.isNaN(Date.parse(s))) return null;
  return new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function describeNotification(n: Pick<AppNotification, 'kind' | 'payload'>): { title: string; detail: string } {
  const p = n.payload;
  const until = clock(p.offer_expires_at);

  switch (n.kind) {
    case 'offer_issued':
      return {
        title: 'A slot opened up for you',
        detail: `${slotLine(p)}. Accept it from the slot list${until ? ` before ${until}` : ' soon'}.`
      };
    case 'offer_expiring':
      return {
        title: 'Your offer is about to lapse',
        detail: `${slotLine(p)}${until ? ` is yours until ${until}` : ''}. Accept it now or it goes to the next person.`
      };
    case 'hold_expired':
      return { title: 'Your reservation expired', detail: `${slotLine(p)}. The hold ran out before it was confirmed.` };
    case 'booking_cancelled':
      return { title: 'Reservation cancelled', detail: `${slotLine(p)} was cancelled.` };
    case 'facility_approved':
      return { title: 'Your venue is live', detail: `${text(p.facility_name) ?? 'Your venue'} was approved and players can book it.` };
    case 'facility_rejected':
      return { title: 'Your venue was not approved', detail: `${text(p.facility_name) ?? 'Your venue'} was rejected by an administrator.` };
    case 'facility_suspended':
      return { title: 'Your venue was suspended', detail: `${text(p.facility_name) ?? 'Your venue'} is hidden from players. Existing data is kept.` };
    case 'group_approved':
      return { title: 'Your community was approved', detail: `${text(p.group_name) ?? 'Your community'} is now visible to everyone.` };
    case 'group_rejected':
      return { title: 'Your community was not approved', detail: `${text(p.group_name) ?? 'Your community'} was rejected by an administrator.` };
    case 'event_approved':
      return { title: 'Your event was approved', detail: `${text(p.event_title) ?? 'Your event'} is now visible to its community.` };
    case 'event_rejected':
      return { title: 'Your event was not approved', detail: `${text(p.event_title) ?? 'Your event'} was rejected by an administrator.` };
  }
}

const OWNER_KINDS: readonly NotificationKind[] = ['facility_approved', 'facility_rejected', 'facility_suspended'];

/** The screen a notification leads to, or null when there is nowhere useful. */
export function notificationTarget(n: Pick<AppNotification, 'kind' | 'payload'>): string | null {
  if (OWNER_KINDS.includes(n.kind)) return ROUTES.owner;

  if (n.kind === 'group_approved' || n.kind === 'group_rejected') {
    const id = text(n.payload.group_id);
    return id && n.kind === 'group_approved' ? communityPath(id) : ROUTES.community;
  }
  if (n.kind === 'event_approved' || n.kind === 'event_rejected') {
    const id = text(n.payload.group_id);
    return id ? communityPath(id) : ROUTES.community;
  }

  // offers, holds and bookings live on the player's home
  return ROUTES.home;
}
