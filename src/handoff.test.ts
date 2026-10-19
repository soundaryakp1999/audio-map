import { describe, expect, it } from 'vitest';
import { mapsUrl } from './handoff';

describe('mapsUrl', () => {
  it('links to directions to the point in the vehicle\'s travel mode', () => {
    expect(mapsUrl(51.5, -0.12, 'walker')).toBe('https://www.google.com/maps/dir/?api=1&destination=51.500000,-0.120000&travelmode=walking');
    expect(mapsUrl(51.5, -0.12, 'bicycle')).toMatch(/travelmode=bicycling$/);
    expect(mapsUrl(51.5, -0.12, 'car')).toMatch(/travelmode=driving$/);
  });
  it('has no link for the helicopter', () => {
    expect(mapsUrl(51.5, -0.12, 'helicopter')).toBeNull();
  });
});
