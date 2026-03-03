




// Centralized storage service for local persistence
export const STORAGE_KEYS = {
  USERS: 'unisport_users_v5',
  FACILITIES: 'unisport_facilities_v5',
  SLOTS: 'unisport_slots_v5',
  BOOKINGS: 'unisport_bookings_v5',
  EVENTS: 'unisport_events_v5',
  GROUPS: 'unisport_groups_v5',
  CURRENT_USER: 'unisport_current_user_v5',
  AUDIT_LOGS: 'unisport_audit_logs_v5',
  COMMUNITIES: 'unisport_communities_v1',
  COMMUNITY_REQUESTS: 'unisport_community_requests_v1',
};

export const storageService = {
  get: <T>(key: string, initialValue: T): T => {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.error(`Error reading from storage key "${key}":`, error);
      return initialValue;
    }
  },

  set: <T>(key: string, value: T): void => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.error(`Error writing to storage key "${key}":`, error);
    }
  },

  remove: (key: string): void => {
    localStorage.removeItem(key);
  },

  clear: (): void => {
    localStorage.clear();
  }
};
