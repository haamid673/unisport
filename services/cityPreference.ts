import { CityOption, cityKey, collapseCity } from './cityFilter';
import { storageService } from './storageService';

/**
 * The customer's chosen city, remembered across reloads.
 *
 * A UI convenience only: it filters the catalog the customer sees and is
 * never used for an authorization decision. Stored per user id, like the
 * profile extras in userService, under a key of its own. It is
 * deliberately NOT one of STORAGE_KEYS: those belong to the removed demo
 * data and are purged on start-up.
 *
 * Only the city name is stored. Nothing here touches the session, a
 * token, or any other account data.
 */
export const CITY_PREFERENCE_KEY = 'unisport_city_preference_v1';

/** City shown before anything is remembered, as before. */
export const DEFAULT_CITY = 'Trivandrum';

/** Longest stored name accepted back; anything longer is not a city. */
const MAX_CITY_LENGTH = 100;

type PreferenceStore = Pick<typeof storageService, 'get' | 'set'>;

type CityPreferences = Record<string, string>;

const readAll = (store: PreferenceStore): CityPreferences => {
  const raw: unknown = store.get<unknown>(CITY_PREFERENCE_KEY, {});
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as CityPreferences)
    : {};
};

/**
 * The remembered city for this user, or null when there is none or the
 * stored value is not a plausible city name.
 */
export function loadCityPreference(
  userId: string,
  store: PreferenceStore = storageService
): string | null {
  if (!userId) return null;

  const value = readAll(store)[userId];
  if (typeof value !== 'string') return null;

  const name = collapseCity(value);
  return name !== '' && name.length <= MAX_CITY_LENGTH ? name : null;
}

/** Remember the city for this user. Blank names are ignored. */
export function saveCityPreference(
  userId: string,
  cityName: string,
  store: PreferenceStore = storageService
): void {
  const name = collapseCity(cityName);
  if (!userId || name === '' || name.length > MAX_CITY_LENGTH) return;

  store.set(CITY_PREFERENCE_KEY, { ...readAll(store), [userId]: name });
}

/**
 * The city to show once the catalog is known.
 *
 * `options` are the catalog's own cities (no extras). The current
 * selection is kept when the catalog has it. Otherwise the default city
 * if available, otherwise the first available city. An empty catalog
 * leaves the selection alone, so discovery and the empty state are
 * unchanged.
 */
export function resolveSelectedCity(
  options: CityOption[],
  current: string,
  fallback: string = DEFAULT_CITY
): string {
  if (options.length === 0) return current;

  const has = (name: string) => options.some(o => o.key === cityKey(name));
  if (has(current)) return current;

  return options.find(o => o.key === cityKey(fallback))?.label ?? options[0].label;
}
