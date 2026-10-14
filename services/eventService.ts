import { CommunityEvent, CommunityGroup, AuditLog, ApprovalStatus } from '../types';
import { storageService, STORAGE_KEYS } from './storageService';
import { userService } from './userService';


/* -------------------------------------------------- */
/* ---------------- SERVICE LOGIC ------------------- */
/* -------------------------------------------------- */

export const eventService = {

 getAllEvents: (includePending = false): CommunityEvent[] => {
  const currentUser = userService.getCurrentUser();
  const events = storageService.get<CommunityEvent[]>(STORAGE_KEYS.EVENTS, []);
  const groups = storageService.get<CommunityGroup[]>(STORAGE_KEYS.GROUPS, []);

  let filtered = includePending
    ? events
    : events.filter(e => e.status === 'approved');

  // If no logged-in user OR user has no city → return approved events
  if (!currentUser || !currentUser.city) {
    return filtered;
  }

  return filtered.filter(event => {
    if (!event.groupId) return true; // allow legacy events

    const group = groups.find(g => g.id === event.groupId);
    if (!group) return false;

    return group.city === currentUser.city;
  });
},
getAllGroups: (includePending = false): CommunityGroup[] => {
  const currentUser = userService.getCurrentUser();
  const groups = storageService.get<CommunityGroup[]>(STORAGE_KEYS.GROUPS, []);

  let filtered = includePending
    ? groups
    : groups.filter(g => g.status === 'approved');

  if (!currentUser || !currentUser.city) return filtered;

  return filtered.filter(group => group.city === currentUser.city);
},

joinGroup: (groupId: string): void => {
  const currentUser = userService.getCurrentUser();
  if (!currentUser) throw new Error("Must be logged in");

  const groups = storageService.get<CommunityGroup[]>(STORAGE_KEYS.GROUPS, []);
  const index = groups.findIndex(g => g.id === groupId);

  if (index === -1) return;

  if (!groups[index].members.includes(currentUser.id)) {
    groups[index].members.push(currentUser.id);
    storageService.set(STORAGE_KEYS.GROUPS, groups);
  }
},

leaveGroup: (groupId: string): void => {
  const currentUser = userService.getCurrentUser();
  if (!currentUser) return;

  const groups = storageService.get<CommunityGroup[]>(STORAGE_KEYS.GROUPS, []);
  const index = groups.findIndex(g => g.id === groupId);

  if (index === -1) return;

  groups[index].members = groups[index].members.filter(
    m => m !== currentUser.id
  );

  storageService.set(STORAGE_KEYS.GROUPS, groups);
},

  createEvent: (event: Omit<CommunityEvent, 'id' | 'participants' | 'status'>): CommunityEvent => {
    const currentUser = userService.getCurrentUser();
    if (!currentUser) throw new Error("Must be logged in");

    const events = storageService.get<CommunityEvent[]>(STORAGE_KEYS.EVENTS, []);

    const newEvent: CommunityEvent = {
      ...event,
      id: `evt_${Date.now()}`,
      participants: [currentUser.id],
      createdBy: currentUser.id,
      status:
        currentUser.role === 'admin'
          ? 'approved'
          : currentUser.role === 'owner'
            ? 'approved'
            : 'pending'
    };

    events.push(newEvent);
    storageService.set(STORAGE_KEYS.EVENTS, events);
    return newEvent;
  },

  joinEvent: (eventId: string): void => {
    const currentUser = userService.getCurrentUser();
    if (!currentUser) throw new Error("Must be logged in");

    const events = storageService.get<CommunityEvent[]>(STORAGE_KEYS.EVENTS, []);
    const groups = storageService.get<CommunityGroup[]>(STORAGE_KEYS.GROUPS, []);

    const index = events.findIndex(e => e.id === eventId);
    if (index === -1) return;

    const event = events[index];
    const group = groups.find(g => g.id === event.groupId);
    if (!group) return;

    if (!group.members.includes(currentUser.id)) {
      throw new Error("Join the community before joining this event.");
    }

    if (event.capacity && event.participants.length >= event.capacity) {
      throw new Error("Event is full.");
    }

    if (!event.participants.includes(currentUser.id)) {
      event.participants.push(currentUser.id);
      storageService.set(STORAGE_KEYS.EVENTS, events);
    }
  },

  leaveEvent: (eventId: string): void => {
  const currentUser = userService.getCurrentUser();
  if (!currentUser) throw new Error("Must be logged in");

  const events = storageService.get<CommunityEvent[]>(STORAGE_KEYS.EVENTS, []);
  const index = events.findIndex(e => e.id === eventId);
  if (index === -1) return;

  const event = events[index];

  event.participants = event.participants.filter(
    id => id !== currentUser.id
  );

  storageService.set(STORAGE_KEYS.EVENTS, events);
},
};