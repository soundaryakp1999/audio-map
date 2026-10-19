import { describe, expect, it } from 'vitest';
import { INSIDE, PREFIX, UNMATCHED, WHOLE, matchTier, mergeHits, words } from './search';

describe('words', () => {
  it('drops case, accents and apostrophes', () => {
    expect(words("McDonald's Café, 5th Ave")).toEqual(['mcdonalds', 'cafe', '5th', 'ave']);
  });
});

describe('matchTier', () => {
  it('ranks whole words over word starts over anywhere', () => {
    expect(matchTier('bar', ["Joe's Bar", 'pub'])).toBe(WHOLE);
    expect(matchTier('bar', ['Barber Shop'])).toBe(PREFIX);
    expect(matchTier('bucks', ['Starbucks'])).toBe(INSIDE);
    expect(matchTier('zoo', ['Starbucks'])).toBeNull();
  });

  it('matches every word, in any order, against name or category', () => {
    expect(matchTier('cafe blue', ['Blue Cafe'])).toBe(WHOLE);
    expect(matchTier('blue cafe', ['Blue Bottle', 'cafe'])).toBe(WHOLE);
    expect(matchTier('blue cafe', ['Blue Bottle', 'restaurant'])).toBeNull();
    expect(matchTier('cafe', ['Café Rouge'])).toBe(WHOLE);
    expect(matchTier('mcdonalds', ["McDonald's"])).toBe(WHOLE);
    expect(matchTier('star bucks', ['Starbucks'])).toBe(INSIDE);
  });

  it('is null for a blank query', () => {
    expect(matchTier('  ', ['Blue Cafe'])).toBeNull();
  });
});

describe('mergeHits', () => {
  const hit = (title: string, tier: number, d: number, lat = 0, lon = 0) => ({ title, tier, d, lat, lon });

  it('sorts by match, then nearest', () => {
    const near = [hit('Barber Shop', PREFIX, 10)];
    const wide = [hit('Bar Italia', WHOLE, 900, 1), hit('The Bar', WHOLE, 300, 2), hit('Somewhere', UNMATCHED, 5, 3)];
    expect(mergeHits(near, wide).map((h) => h.title)).toEqual(['The Bar', 'Bar Italia', 'Barber Shop', 'Somewhere']);
  });

  it('drops a wider result that is the same nearby place', () => {
    const near = [hit('Blue Cafe', WHOLE, 50, 51.5, -0.1)];
    const wide = [hit('Blue Café', WHOLE, 52, 51.5002, -0.1001), hit('Blue Cafe', WHOLE, 4000, 51.53, -0.1)];
    expect(mergeHits(near, wide).map((h) => h.d)).toEqual([50, 4000]);
  });
});
