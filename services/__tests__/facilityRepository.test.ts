import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createFacilityRepository,
  FacilityLoadError,
  FACILITY_COLUMNS,
  SLOT_COLUMNS,
  formatTime,
  formatSlotTime,
  mapFacilityStatus,
  mapFacilityRow,
  mapSlotRow,
  FacilityRow
} from '../facilityRepository';
import { getSportImage } from '../sportImages';

const ROW: FacilityRow = {
  id: 'd0000000-0000-4000-8000-000000000001',
  name: 'Kowdiar Badminton Hub',
  sport: 'Badminton',
  address: 'Kowdiar Junction Road',
  city: 'Trivandrum',
  latitude: 8.519,
  longitude: '76.9610',
  base_price: '900.00',
  status: 'active',
  facility_slots: [
    {
      id: 'd1000000-0000-4000-8000-000000000101',
      facility_id: 'd0000000-0000-4000-8000-000000000001',
      start_time: '18:00:00',
      end_time: '19:00:00',
      base_price: '1100.00',
      is_active: true
    }
  ]
};

interface Recorded {
  from?: string;
  select?: string;
  eq: Array<[string, unknown]>;
  order: Array<[string, unknown]>;
}

/** Fake client that records the query and returns a canned result. */
function fakeClient(result: { data: unknown; error: unknown }) {
  const recorded: Recorded = { eq: [], order: [] };

  const builder: any = {
    select: (columns: string) => {
      recorded.select = columns;
      return builder;
    },
    eq: (column: string, value: unknown) => {
      recorded.eq.push([column, value]);
      return builder;
    },
    order: (column: string, options: unknown) => {
      recorded.order.push([column, options]);
      return builder;
    },
    then: (resolve: any) => resolve(result)
  };

  const client = {
    from: (table: string) => {
      recorded.from = table;
      return builder;
    }
  } as unknown as SupabaseClient;

  return { client, recorded };
}

describe('formatTime / formatSlotTime', () => {
  it('matches the existing "06:00 PM - 07:00 PM" display', () => {
    expect(formatSlotTime('18:00:00', '19:00:00')).toBe('06:00 PM - 07:00 PM');
    expect(formatSlotTime('06:00:00', '07:30:00')).toBe('06:00 AM - 07:30 AM');
  });

  it('handles midnight and noon', () => {
    expect(formatTime('00:00:00')).toBe('12:00 AM');
    expect(formatTime('12:00:00')).toBe('12:00 PM');
    expect(formatTime('12:30:00')).toBe('12:30 PM');
    expect(formatTime('23:59:00')).toBe('11:59 PM');
  });

  it('does not invent a time for unrecognised input', () => {
    expect(formatTime('not a time')).toBe('not a time');
    expect(formatTime('25:00:00')).toBe('25:00:00');
  });
});

describe('mapFacilityStatus', () => {
  it('maps database statuses to the UI representation', () => {
    expect(mapFacilityStatus('active')).toBe('approved');
    expect(mapFacilityStatus('pending')).toBe('pending');
    expect(mapFacilityStatus('rejected')).toBe('rejected');
    expect(mapFacilityStatus('suspended')).toBe('rejected');
  });

  it('never presents an unknown status as approved', () => {
    expect(mapFacilityStatus('something_new')).toBe('pending');
  });
});

describe('record mapping', () => {
  it('maps a facility row to the existing Facility type', () => {
    const facility = mapFacilityRow(ROW);

    expect(facility).toMatchObject({
      id: ROW.id,                                  // UUID stays a string
      name: 'Kowdiar Badminton Hub',
      sport: 'Badminton',
      location: 'Kowdiar Junction Road, Trivandrum',
      address: 'Kowdiar Junction Road',
      city: 'Trivandrum',
      basePrice: 900,                              // numeric string -> number
      latitude: 8.519,
      longitude: 76.961,                           // numeric string -> number
      status: 'approved',
      imageUrl: getSportImage('Badminton')
    });
    expect(typeof facility.basePrice).toBe('number');
  });

  it('keeps the city filter working on the composed location', () => {
    expect(mapFacilityRow(ROW).location.includes('Trivandrum')).toBe(true);
  });

  it('leaves null coordinates undefined instead of inventing values', () => {
    const facility = mapFacilityRow({ ...ROW, latitude: null, longitude: null });
    expect(facility.latitude).toBeUndefined();
    expect(facility.longitude).toBeUndefined();
  });

  it('maps a slot row, converting price and time', () => {
    const slot = mapSlotRow(ROW.facility_slots![0]);

    expect(slot).toEqual({
      id: 'd1000000-0000-4000-8000-000000000101',
      facilityId: ROW.id,
      time: '06:00 PM - 07:00 PM',
      price: 1100,
      isActive: true
    });
  });
});

describe('loadCustomerCatalog', () => {
  it('reads active facilities with active slots, selecting only needed columns', async () => {
    const { client, recorded } = fakeClient({ data: [ROW], error: null });
    const catalog = await createFacilityRepository(() => client).loadCustomerCatalog();

    expect(recorded.from).toBe('facilities');
    expect(recorded.select).toBe(
      `${FACILITY_COLUMNS}, facility_slots(${SLOT_COLUMNS})`
    );
    expect(recorded.eq).toContainEqual(['status', 'active']);
    expect(recorded.eq).toContainEqual(['facility_slots.is_active', true]);

    // never asks for the owner
    expect(recorded.select).not.toContain('owner_id');
    expect(catalog.facilities[0].ownerId).toBe('');

    expect(catalog.facilities).toHaveLength(1);
    expect(catalog.slots).toHaveLength(1);
    expect(catalog.slots[0].facilityId).toBe(catalog.facilities[0].id);
  });

  it('orders facilities and slots deterministically', async () => {
    const { client, recorded } = fakeClient({ data: [], error: null });
    await createFacilityRepository(() => client).loadCustomerCatalog();

    expect(recorded.order[0][0]).toBe('name');
    expect(recorded.order[1][0]).toBe('start_time');
    expect(recorded.order[1][1]).toMatchObject({ referencedTable: 'facility_slots' });
  });

  it('returns an empty catalog when the database returns no rows', async () => {
    const { client } = fakeClient({ data: [], error: null });
    await expect(
      createFacilityRepository(() => client).loadCustomerCatalog()
    ).resolves.toEqual({ facilities: [], slots: [] });
  });

  it('keeps a facility that has no active slots', async () => {
    const { client } = fakeClient({
      data: [{ ...ROW, facility_slots: [] }, { ...ROW, id: 'x', facility_slots: null }],
      error: null
    });
    const catalog = await createFacilityRepository(() => client).loadCustomerCatalog();
    expect(catalog.facilities).toHaveLength(2);
    expect(catalog.slots).toHaveLength(0);
  });

  it('never surfaces an inactive slot, even if the filter were ignored', async () => {
    const inactive = { ...ROW.facility_slots![0], id: 'inactive', is_active: false };
    const { client } = fakeClient({
      data: [{ ...ROW, facility_slots: [ROW.facility_slots![0], inactive] }],
      error: null
    });
    const catalog = await createFacilityRepository(() => client).loadCustomerCatalog();
    expect(catalog.slots.map(s => s.id)).not.toContain('inactive');
  });

  it('throws FacilityLoadError for a Supabase error, without leaking details', async () => {
    const { client } = fakeClient({
      data: null,
      error: { message: 'relation "x" internal detail', code: '42P01' }
    });

    const promise = createFacilityRepository(() => client).loadCustomerCatalog();
    await expect(promise).rejects.toBeInstanceOf(FacilityLoadError);
    await expect(promise).rejects.not.toThrow(/internal detail/);
  });

  it('treats a missing result as a failure, not as an empty catalog', async () => {
    const { client } = fakeClient({ data: null, error: null });
    await expect(
      createFacilityRepository(() => client).loadCustomerCatalog()
    ).rejects.toBeInstanceOf(FacilityLoadError);
  });

  it('throws FacilityLoadError when the client is not configured', async () => {
    const repo = createFacilityRepository(() => {
      throw new Error('Supabase is not configured');
    });
    await expect(repo.loadCustomerCatalog()).rejects.toBeInstanceOf(FacilityLoadError);
  });
});

describe('no LocalStorage fallback', () => {
  afterEach(() => {
    delete (globalThis as any).localStorage;
  });

  /** A localStorage whose every access is recorded. */
  function spyStorage() {
    const touched: string[] = [];
    const trap = (name: string) => () => {
      touched.push(name);
      return null;
    };
    (globalThis as any).localStorage = {
      getItem: trap('getItem'),
      setItem: trap('setItem'),
      removeItem: trap('removeItem'),
      clear: trap('clear')
    };
    return touched;
  }

  it('does not touch localStorage on success', async () => {
    const touched = spyStorage();
    const { client } = fakeClient({ data: [ROW], error: null });
    await createFacilityRepository(() => client).loadCustomerCatalog();
    expect(touched).toEqual([]);
  });

  it('does not touch localStorage, nor return mock data, on failure', async () => {
    const touched = spyStorage();
    const { client } = fakeClient({ data: null, error: { message: 'down' } });

    await expect(
      createFacilityRepository(() => client).loadCustomerCatalog()
    ).rejects.toBeInstanceOf(FacilityLoadError);

    expect(touched).toEqual([]);
  });

  it('does not import facilityService or storageService', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../facilityRepository.ts', import.meta.url)),
      'utf8'
    );
    const imports = source.split('\n').filter(l => /^\s*import\b/.test(l)).join('\n');

    expect(imports).not.toMatch(/facilityService/);
    expect(imports).not.toMatch(/storageService/);

    // code only: comments may legitimately describe the rule
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/localStorage|sessionStorage/);
  });
});
