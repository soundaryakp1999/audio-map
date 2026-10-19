import { describe, expect, it } from 'vitest';
import { ShakeDetector } from './shake';

describe('ShakeDetector', () => {
  it('fires on three hard jolts within a second, then rests', () => {
    const d = new ShakeDetector();
    expect([d.feed(30, 0), d.feed(30, 200), d.feed(30, 400)]).toEqual([false, false, true]);
    expect([d.feed(30, 600), d.feed(30, 800), d.feed(30, 1000)]).toEqual([false, false, false]);
    expect([d.feed(30, 3500), d.feed(30, 3700), d.feed(30, 3900)]).toEqual([false, false, true]);
  });

  it('ignores gentle movement, a single knock, and jolts spread too far apart', () => {
    const d = new ShakeDetector();
    expect([d.feed(12, 0), d.feed(15, 100), d.feed(20, 200)]).toEqual([false, false, false]);
    expect([d.feed(40, 1000), d.feed(40, 3000), d.feed(40, 5000)]).toEqual([false, false, false]);
  });

  it('counts one long jolt once', () => {
    const d = new ShakeDetector();
    expect([d.feed(40, 0), d.feed(41, 20), d.feed(42, 40), d.feed(43, 60)]).toEqual([false, false, false, false]);
  });
});
