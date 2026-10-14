import { describe, it, expect } from 'vitest';
import { purgeLegacyDemoData, LEGACY_DEMO_KEYS } from '../legacyCleanup';

const memoryStorage = (initial: Record<string, string>) => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    removeItem: (k: string) => void data.delete(k)
  };
};

describe('purgeLegacyDemoData', () => {
  it('removes seeded accounts, demo records and the simulated session', () => {
    const storage = memoryStorage({
      unisport_users_v5: '[{"passwordHash":"x"}]',
      unisport_current_user_v5: '{"id":"admin"}',
      unisport_facilities_v5: '[]',
      unisport_slots_v5: '[]',
      unisport_bookings_v5: '[]',
      unisport_groups_v5: '[]',
      unisport_events_v5: '[]',
      unisport_audit_logs_v5: '[]',
      unisport_initialized_v5: 'true',
      unisport_payments: '[]'
    });

    purgeLegacyDemoData(storage);

    expect([...storage.data.keys()]).toEqual([]);
  });

  it('keeps user-entered profile extras and unrelated keys', () => {
    const storage = memoryStorage({
      unisport_profile_extras_v1: '{"u":{"bio":"hi"}}',
      supabase_auth_token: 'keep-me'
    });

    purgeLegacyDemoData(storage);

    expect([...storage.data.keys()].sort()).toEqual([
      'supabase_auth_token',
      'unisport_profile_extras_v1'
    ]);
    expect(LEGACY_DEMO_KEYS).not.toContain('unisport_profile_extras_v1');
  });

  it('never throws when storage is blocked or absent', () => {
    expect(() =>
      purgeLegacyDemoData({
        removeItem: () => {
          throw new Error('SecurityError');
        }
      })
    ).not.toThrow();
    expect(() => purgeLegacyDemoData(undefined)).not.toThrow();
  });
});
