import { describe, expect, it } from 'vitest';
import { ShakeDetector } from './shake';

describe('ShakeDetector', () => {
  it('fires on four hard jolts within 0.8 s, then rests', () => {
    const d = new ShakeDetector();
    expect([0, 150, 300, 450].map((t) => d.feed(30, t))).toEqual([false, false, false, true]);
    expect([600, 750, 900, 1050].map((t) => d.feed(30, t))).toEqual([false, false, false, false]);
    expect([3500, 3650, 3800, 3950].map((t) => d.feed(30, t))).toEqual([false, false, false, true]);
  });

  it('ignores hard footsteps, walking or running, with the phone in a pocket', () => {
    const walk = new ShakeDetector();
    expect(Array.from({ length: 20 }, (_, i) => walk.feed(30, i * 500)).some(Boolean)).toBe(false);
    const run = new ShakeDetector();
    expect(Array.from({ length: 30 }, (_, i) => run.feed(35, i * 330)).some(Boolean)).toBe(false);
  });

  it('ignores gentle movement, a single knock, and jolts spread too far apart', () => {
    const d = new ShakeDetector();
    expect([d.feed(12, 0), d.feed(15, 150), d.feed(20, 300), d.feed(24, 450)]).toEqual([false, false, false, false]);
    expect([d.feed(40, 1000), d.feed(40, 3000), d.feed(40, 5000)]).toEqual([false, false, false]);
  });

  it('counts one long jolt once', () => {
    const d = new ShakeDetector();
    expect([d.feed(40, 0), d.feed(41, 20), d.feed(42, 40), d.feed(43, 60)]).toEqual([false, false, false, false]);
  });
});
