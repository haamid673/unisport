import { describe, it, expect } from 'vitest';
import {
  cityKey,
  collapseCity,
  deriveCityOptions,
  filterByCity,
  inCity,
  labelForCity
} from '../cityFilter';
import { mapFacilityRow, FacilityRow } from '../facilityRepository';

const row = (overrides: Partial<FacilityRow> = {}): FacilityRow => ({
  id: 'f1',
  name: 'Arena',
  sport: 'Badminton',
  address: '1 Test Road',
  city: 'Trivandrum',
  latitude: null,
  longitude: null,
  base_price: 500,
  status: 'active',
  ...overrides
});

describe('cityKey', () => {
  it('ignores casing and surrounding or repeated whitespace', () => {
    const spellings = ['Trivandrum', 'trivandrum', 'TRIVANDRUM', '  Trivandrum ', 'Trivandrum\t'];
    for (const s of spellings) expect(cityKey(s)).toBe('trivandrum');

    expect(cityKey('New   Delhi')).toBe('new delhi');
    expect(cityKey(' new delhi ')).toBe('new delhi');
  });

  it('treats missing values as no city', () => {
    expect(cityKey(null)).toBe('');
    expect(cityKey(undefined)).toBe('');
    expect(cityKey('   ')).toBe('');
  });
});

describe('collapseCity', () => {
  it('trims and single-spaces without changing casing', () => {
    expect(collapseCity('  New   Delhi ')).toBe('New Delhi');
    expect(collapseCity('KOCHI')).toBe('KOCHI');
  });
});

describe('deriveCityOptions', () => {
  it('lists cities that were never in the old hardcoded list', () => {
    const options = deriveCityOptions([{ city: 'Kochi' }, { city: 'Trivandrum' }]);

    expect(options.map(o => o.label)).toEqual(['Kochi', 'Trivandrum']);
    expect(options.map(o => o.key)).toEqual(['kochi', 'trivandrum']);
  });

  it('merges spellings of one city into a single option', () => {
    const options = deriveCityOptions([
      { city: 'kochi' },
      { city: 'Kochi' },
      { city: ' Kochi ' },
      { city: 'KOCHI' }
    ]);

    expect(options).toHaveLength(1);
    expect(options[0].key).toBe('kochi');
    // "Kochi" is the most common spelling (two of four)
    expect(options[0].label).toBe('Kochi');
  });

  it('chooses the label deterministically when spellings tie', () => {
    const a = deriveCityOptions([{ city: 'kochi' }, { city: 'Kochi' }]);
    const b = deriveCityOptions([{ city: 'Kochi' }, { city: 'kochi' }]);

    expect(a[0].label).toBe(b[0].label);
    // the capitalised spelling is preferred on a tie
    expect(a[0].label).toBe('Kochi');
  });

  it('derives nothing from an empty catalog and invents no cities', () => {
    expect(deriveCityOptions([])).toEqual([]);
    expect(deriveCityOptions([{ city: '' }, { city: null }, {}])).toEqual([]);
  });

  it('keeps the current selection selectable when the catalog has no venue there', () => {
    const options = deriveCityOptions([{ city: 'Kochi' }], 'trivandrum');

    expect(options.map(o => o.key)).toContain('trivandrum');
    expect(options.map(o => o.key)).toContain('kochi');
  });

  it('does not duplicate the selection when the catalog already has it', () => {
    const options = deriveCityOptions([{ city: 'Kochi' }], 'KOCHI ');

    expect(options).toHaveLength(1);
    expect(options[0].label).toBe('Kochi');
  });
});

describe('filterByCity', () => {
  const facilities = [
    { id: 'a', city: 'Trivandrum', location: 'Kowdiar, Trivandrum' },
    { id: 'b', city: 'Kochi', location: 'Marine Drive, Kochi' },
    { id: 'c', city: ' kochi ', location: 'Edappally, kochi' },
    // address text mentions another city; the city column decides
    { id: 'd', city: 'Kochi', location: 'Near Chennai Road, Kochi' }
  ];

  it('finds venues in a city that was previously unsupported', () => {
    expect(filterByCity(facilities, 'kochi').map(f => f.id)).toEqual(['b', 'c', 'd']);
  });

  it('is consistent for any casing or whitespace in the selection', () => {
    for (const selection of ['Kochi', 'KOCHI', ' kochi ']) {
      expect(filterByCity(facilities, selection).map(f => f.id)).toEqual(['b', 'c', 'd']);
    }
  });

  it('keeps intentional filtering: other cities are excluded', () => {
    expect(filterByCity(facilities, 'trivandrum').map(f => f.id)).toEqual(['a']);
    expect(filterByCity(facilities, 'mumbai')).toEqual([]);
  });

  it('matches the structured city, not text inside the address', () => {
    // the old location.includes("Chennai") matched venue d
    expect(filterByCity(facilities, 'chennai')).toEqual([]);
  });

  it('does not match partial city names', () => {
    expect(filterByCity(facilities, 'koch')).toEqual([]);
    expect(filterByCity(facilities, 'kochi city')).toEqual([]);
  });

  it('matches nothing for an empty selection or a venue without a city', () => {
    expect(filterByCity(facilities, '')).toEqual([]);
    expect(inCity({ city: null }, 'kochi')).toBe(false);
    expect(inCity({}, 'kochi')).toBe(false);
  });
});

describe('labelForCity', () => {
  it('shows the catalog spelling, falling back to the collapsed key', () => {
    const options = deriveCityOptions([{ city: 'Kochi' }]);

    expect(labelForCity(options, 'kochi')).toBe('Kochi');
    expect(labelForCity(options, 'ADOOR  ')).toBe('ADOOR');
  });
});

describe('end to end with the catalog mapper', () => {
  it('an owner-created venue in an unsupported city is discoverable', () => {
    // exactly what the database returns for an owner-entered city
    const catalog = [
      mapFacilityRow(row({ id: 'f1', city: 'Trivandrum' })),
      mapFacilityRow(row({ id: 'f2', city: 'Kochi ', address: '3 Test Road' })),
      mapFacilityRow(row({ id: 'f3', city: 'pondicherry' }))
    ];

    const options = deriveCityOptions(catalog, 'trivandrum');
    expect(options.map(o => o.key)).toEqual(['kochi', 'pondicherry', 'trivandrum']);

    expect(filterByCity(catalog, 'kochi').map(f => f.id)).toEqual(['f2']);
    expect(filterByCity(catalog, 'pondicherry').map(f => f.id)).toEqual(['f3']);
  });
});
