/** Anything with an optional city: a customer Facility or a plain row. */
export interface HasCity {
  city?: string | null;
}

/**
 * City discovery for the customer catalog.
 *
 * The catalog used to offer a hardcoded list of cities and match with
 * `facility.location.includes(city)`. Owners can enter any city, so a
 * valid venue outside that list could never be found, and the substring
 * match also depended on the free-text address.
 *
 * Now the options come from the catalog itself and matching uses the
 * structured `city` column. Both sides go through the same
 * normalisation, so casing and whitespace never decide visibility:
 * "trivandrum", " Trivandrum " and "Trivandrum" are the same city.
 *
 * Pure and framework-free so the rules are testable. Nothing here
 * invents a facility or a city; an empty catalog gives no options.
 */

/** Comparison key: Unicode-normalised, trimmed, single-spaced, case-folded. */
export function cityKey(city: string | null | undefined): string {
  return (city ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
}

/**
 * Display and storage form: trimmed and single-spaced, with the casing
 * and characters the owner wrote. (Only the comparison key is Unicode
 * normalised, so stored text is never rewritten beyond whitespace.)
 */
export function collapseCity(city: string | null | undefined): string {
  return (city ?? '').trim().replace(/\s+/g, ' ');
}

export interface CityOption {
  /** Stable value for the selector; equal for every spelling of a city. */
  key: string;
  /** What the user sees. */
  label: string;
}

/**
 * Selector options from the real catalog, one per distinct city,
 * sorted by label.
 *
 * When one city is spelled several ways the most common spelling is
 * shown (ties resolved by code unit, capitalised first, so the label is
 * the same on every render and in every locale).
 *
 * `ensure` adds the current selection when the catalog has no venue
 * there, so the selector never displays a value it cannot hold.
 */
export function deriveCityOptions(
  facilities: HasCity[],
  ensure?: string
): CityOption[] {
  const spellings = new Map<string, Map<string, number>>();

  const note = (raw: string | null | undefined) => {
    const key = cityKey(raw);
    if (!key) return;
    const label = collapseCity(raw);
    const counts = spellings.get(key) ?? new Map<string, number>();
    counts.set(label, (counts.get(label) ?? 0) + 1);
    spellings.set(key, counts);
  };

  facilities.forEach(f => note(f.city));

  const options: CityOption[] = [];

  spellings.forEach((counts, key) => {
    // Most common spelling wins. A tie goes to the first by code unit,
    // which puts "Kochi" ahead of "kochi" and never depends on locale.
    const [label] = [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    )[0];
    options.push({ key, label });
  });

  const wanted = cityKey(ensure);
  if (wanted && !spellings.has(wanted)) {
    options.push({ key: wanted, label: collapseCity(ensure) });
  }

  return options.sort((a, b) => a.label.localeCompare(b.label));
}

/** True when the facility is in the selected city. */
export function inCity(
  facility: HasCity,
  selectedKey: string
): boolean {
  const wanted = cityKey(selectedKey);
  return wanted !== '' && cityKey(facility.city) === wanted;
}

/** Facilities in the selected city, in their original order. */
export function filterByCity<T extends HasCity>(
  facilities: T[],
  selectedKey: string
): T[] {
  return facilities.filter(f => inCity(f, selectedKey));
}

/** Label for a key: the option's label, else the key itself. */
export function labelForCity(options: CityOption[], key: string): string {
  return options.find(o => o.key === cityKey(key))?.label ?? collapseCity(key);
}
