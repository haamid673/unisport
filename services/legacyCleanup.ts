import { STORAGE_KEYS } from './storageService';

/**
 * Browser-storage keys written by earlier prototype builds: the
 * simulated login session, seeded demo accounts (with reversible
 * "hashes"), demo venues/slots/groups/events, mock bookings, mock
 * payments and audit logs. None of it is platform data, and the demo
 * accounts must never be honoured, so it is removed on start-up.
 *
 * UI-only profile extras (bio, preferences) are user-entered and are
 * deliberately kept.
 */
export const LEGACY_DEMO_KEYS: readonly string[] = [
  ...Object.values(STORAGE_KEYS),
  'unisport_initialized_v5',
  'unisport_payments'
];

/** Remove legacy demo data. Never throws; storage may be unavailable. */
export function purgeLegacyDemoData(
  storage: Pick<Storage, 'removeItem'> | undefined = typeof localStorage === 'undefined'
    ? undefined
    : localStorage
): void {
  if (!storage) return;

  for (const key of LEGACY_DEMO_KEYS) {
    try {
      storage.removeItem(key);
    } catch {
      // Blocked storage (private mode, disabled cookies): nothing to do.
    }
  }
}
