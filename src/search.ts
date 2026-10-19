// Ranks search results: how well the words match first, then nearest first.

/** Lower case words, without accents or apostrophes: "McDonald's Café" -> ["mcdonalds", "cafe"]. */
export function words(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Every query word is a whole word of the place */
export const WHOLE = 0;
/** Every query word starts a word of the place ("star" for "Starbucks") */
export const PREFIX = 1;
/** Every query word appears somewhere in the place ("bucks" for "Starbucks") */
export const INSIDE = 2;

/**
 * How well a query matches a place's fields (name, category...): WHOLE, PREFIX or INSIDE, the
 * weakest of its words. null if some query word is not there at all.
 */
export function matchTier(q: string, fields: string[]): number | null {
  const want = words(q);
  if (!want.length) return null;
  const have = fields.flatMap(words);
  const joined = have.join(' ');
  const squashed = have.join('');
  let tier = WHOLE;
  for (const w of want) {
    if (have.includes(w)) continue;
    if (have.some((h) => h.startsWith(w))) tier = Math.max(tier, PREFIX);
    else if (joined.includes(w) || squashed.includes(w)) tier = INSIDE;
    else return null;
  }
  return tier;
}

/** Best match first; within a tier, nearest first. */
export function byTierThenDistance(a: { tier: number; d: number }, b: { tier: number; d: number }): number {
  return a.tier - b.tier || a.d - b.d;
}

/** For a wider search result that none of the query words match (the geocoder knew another name). */
export const UNMATCHED = 3;

export interface Hit {
  title: string;
  lat: number;
  lon: number;
  tier: number;
  /** metres away */
  d: number;
}

/**
 * Places loaded nearby and wider search results as one list, best first. A wider result with
 * the same name within about 100 m of a nearby one is the same place, so it is left out.
 */
export function mergeHits<T extends Hit>(near: T[], wide: T[]): T[] {
  const key = (h: Hit) => words(h.title).join(' ');
  const same = (a: Hit, b: Hit) => key(a) === key(b) && Math.abs(a.lat - b.lat) < 0.001 && Math.abs(a.lon - b.lon) < 0.0015;
  return [...near, ...wide.filter((w) => !near.some((n) => same(n, w)))].sort(byTierThenDistance);
}
