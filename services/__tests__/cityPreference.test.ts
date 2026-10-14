import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CITY_PREFERENCE_KEY,
  DEFAULT_CITY,
  loadCityPreference,
  resolveSelectedCity,
  saveCityPreference
} from '../cityPreference';
import { cityKey, deriveCityOptions, filterByCity, inCity } from '../cityFilter';
import { LEGACY_DEMO_KEYS } from '../legacyCleanup';
import { STORAGE_KEYS } from '../storageService';

const USER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

/** In-memory stand-in for storageService (same get/set contract). */
const memoryStore = (initial: Record<string, unknown> = {}) => {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    get: <T,>(key: string, fallback: T): T =>
      (data.has(key) ? (data.get(key) as T) : fallback),
    set: <T,>(key: string, value: T) => void data.set(key, value)
  };
};

const catalog = [
  { city: 'Trivandrum' },
  { city: 'Kochi' },
  { city: ' kochi ' },
  { city: 'Kozhikode' }
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('saving the selected city', () => {
  it('persists the selection under its own key, per user', () => {
    const store = memoryStore();

    saveCityPreference(USER, 'Kochi', store);

    expect(store.data.has(CITY_PREFERENCE_KEY)).toBe(true);
    expect(loadCityPreference(USER, store)).toBe('Kochi');
    // another account in the same browser is unaffected
    expect(loadCityPreference(OTHER, store)).toBeNull();

    saveCityPreference(OTHER, 'Kozhikode', store);
    expect(loadCityPreference(USER, store)).toBe('Kochi');
    expect(loadCityPreference(OTHER, store)).toBe('Kozhikode');
  });

  it('stores only the city name', () => {
    const store = memoryStore();

    saveCityPreference(USER, '  New   Delhi ', store);

    expect(store.data.get(CITY_PREFERENCE_KEY)).toEqual({ [USER]: 'New Delhi' });
  });

  it('ignores a blank city and keeps the earlier choice', () => {
    const store = memoryStore();
    saveCityPreference(USER, 'Kochi', store);

    saveCityPreference(USER, '   ', store);

    expect(loadCityPreference(USER, store)).toBe('Kochi');
  });

  it('uses a key the start-up demo-data purge does not remove', () => {
    expect(LEGACY_DEMO_KEYS).not.toContain(CITY_PREFERENCE_KEY);
    expect(Object.values(STORAGE_KEYS)).not.toContain(CITY_PREFERENCE_KEY);
  });
});

describe('restoring the saved city', () => {
  it('restores a saved city that the catalog has', () => {
    const store = memoryStore();
    saveCityPreference(USER, 'Kochi', store);

    const saved = loadCityPreference(USER, store) ?? DEFAULT_CITY;
    const shown = resolveSelectedCity(deriveCityOptions(catalog), saved);

    expect(shown).toBe('Kochi');
  });

  it('matches the saved city however it was spelled', () => {
    const options = deriveCityOptions(catalog);

    expect(resolveSelectedCity(options, 'KOCHI')).toBe('KOCHI');
    expect(cityKey(resolveSelectedCity(options, 'kochi'))).toBe('kochi');
  });

  it('starts at the default when nothing was saved', () => {
    expect(loadCityPreference(USER, memoryStore())).toBeNull();
    expect(
      resolveSelectedCity(deriveCityOptions(catalog), loadCityPreference(USER, memoryStore()) ?? DEFAULT_CITY)
    ).toBe('Trivandrum');
  });
});

describe('a saved city that is no longer available', () => {
  it('falls back to the default city when the catalog has it', () => {
    const options = deriveCityOptions(catalog);

    expect(resolveSelectedCity(options, 'Mumbai')).toBe('Trivandrum');
  });

  it('falls back to the first available city when the default is gone too', () => {
    const options = deriveCityOptions([{ city: 'Kozhikode' }, { city: 'Kochi' }]);

    expect(resolveSelectedCity(options, 'Mumbai')).toBe('Kochi');
  });

  it('keeps discovery working: the fallback city lists its venues', () => {
    const venues = [
      { id: 'a', city: 'Kochi' },
      { id: 'b', city: 'Kozhikode' }
    ];
    const options = deriveCityOptions(venues);

    const shown = resolveSelectedCity(options, 'Mumbai');

    expect(filterByCity(venues, cityKey(shown)).length).toBeGreaterThan(0);
  });

  it('does not forget the saved city just because it was unavailable once', () => {
    const store = memoryStore();
    saveCityPreference(USER, 'Mumbai', store);

    resolveSelectedCity(deriveCityOptions(catalog), 'Mumbai');

    expect(loadCityPreference(USER, store)).toBe('Mumbai');
  });
});

describe('empty and unusable input', () => {
  it('leaves the selection alone when the catalog has no cities', () => {
    expect(resolveSelectedCity(deriveCityOptions([]), 'Kochi')).toBe('Kochi');
    expect(resolveSelectedCity([], DEFAULT_CITY)).toBe(DEFAULT_CITY);
    // facilities that have no city give no options either
    expect(
      resolveSelectedCity(deriveCityOptions([{ city: null }, {}, { city: '  ' }]), 'Kochi')
    ).toBe('Kochi');
  });

  it('treats corrupt stored data as no preference', () => {
    const bad: unknown[] = [null, 'Kochi', 42, ['Kochi'], { [USER]: 7 }, { [USER]: '' }, {
      [USER]: 'x'.repeat(500)
    }];

    for (const value of bad) {
      const store = memoryStore({ [CITY_PREFERENCE_KEY]: value });
      expect(() => loadCityPreference(USER, store)).not.toThrow();
      expect(loadCityPreference(USER, store)).toBeNull();
    }
  });

  it('survives unavailable browser storage', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const blocked = () => {
      throw new Error('storage blocked');
    };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked });

    expect(loadCityPreference(USER)).toBeNull();
    expect(() => saveCityPreference(USER, 'Kochi')).not.toThrow();
  });

  it('works through the real storage service', () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
      setItem: (k: string, v: string) => void data.set(k, String(v))
    });

    saveCityPreference(USER, 'Kochi');

    expect(JSON.parse(data.get(CITY_PREFERENCE_KEY)!)).toEqual({ [USER]: 'Kochi' });
    expect(loadCityPreference(USER)).toBe('Kochi');
  });
});

describe('existing city normalisation and filtering are unchanged', () => {
  const venues = [
    { id: '1', city: 'Trivandrum' },
    { id: '2', city: 'kochi' },
    { id: '3', city: ' Kochi ' },
    { id: '4', city: null }
  ];

  it('still merges spellings into one option', () => {
    expect(deriveCityOptions(venues).map(o => o.key)).toEqual(['kochi', 'trivandrum']);
  });

  it('still filters by the normalised key', () => {
    expect(filterByCity(venues, 'Kochi').map(v => v.id)).toEqual(['2', '3']);
    expect(inCity(venues[0], 'TRIVANDRUM')).toBe(true);
    expect(inCity(venues[3], '')).toBe(false);
  });

  it('keeps an unavailable selection visible without inventing a venue', () => {
    const options = deriveCityOptions(venues, 'Mumbai');

    expect(options.some(o => o.key === 'mumbai')).toBe(true);
    expect(filterByCity(venues, 'Mumbai')).toEqual([]);
  });
});

describe('UserDashboard wiring', () => {
  const source = readFileSync(
    join(__dirname, '../../components/UserDashboard.tsx'),
    'utf8'
  )
    .split('\n')
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n');

  it('starts from the remembered city rather than a literal', () => {
    expect(source).toMatch(/useState<string>\(\s*\(\)\s*=>\s*loadCityPreference\(user\.id\)\s*\?\?\s*DEFAULT_CITY/);
    expect(source).not.toMatch(/useState<string>\(\s*'Trivandrum'\s*\)/);
  });

  it('saves only on an explicit selection', () => {
    const matches = source.match(/saveCityPreference\(/g) ?? [];
    // import is a name, not a call; exactly one call site: the selector
    expect(matches).toHaveLength(1);
    expect(source).toMatch(/aria-label="City"[\s\S]{0,700}saveCityPreference\(user\.id, name\)/);
  });

  it('validates against the catalog when it loads, not before', () => {
    expect(source).toMatch(
      /setFacilities\(catalog\.facilities\);[\s\S]{0,400}resolveSelectedCity\(deriveCityOptions\(catalog\.facilities\), current\)/
    );
    // the failure branch must not touch the selection
    const failure = source.slice(source.indexOf('.catch(err => {'));
    expect(failure.slice(0, 500)).not.toMatch(/setSelectedCityName/);
  });

  it('does not touch browser storage directly', () => {
    expect(source).not.toMatch(/localStorage|storageService/);
  });
});
