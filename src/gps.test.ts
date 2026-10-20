import { describe, expect, it } from 'vitest';
import { coast, compassHeading, easeAngle, heldToPoint, fuse, motionBase, motionBetween, pickHeading, snapRadius, type Estimate } from './gps';

describe('compassHeading', () => {
  it('uses the iOS compass heading directly', () => {
    expect(compassHeading({ webkitCompassHeading: 90 })).toBe(90);
  });
  it('converts absolute alpha (counter-clockwise) to a compass heading', () => {
    expect(compassHeading({ absolute: true, alpha: 90 })).toBe(270);
    expect(compassHeading({ absolute: true, alpha: 0 })).toBe(0);
  });
  it('ignores relative orientation, which is not north-referenced', () => {
    expect(compassHeading({ absolute: false, alpha: 90 })).toBeNull();
    expect(compassHeading({ absolute: true, alpha: null })).toBeNull();
  });
});

describe('heldToPoint', () => {
  it('is true held flat or tilted toward you, false upright or on its side as in a pocket', () => {
    expect(heldToPoint({ beta: 5, gamma: -3 })).toBe(true);
    expect(heldToPoint({ beta: 50, gamma: 0 })).toBe(true);
    expect(heldToPoint({ beta: 88, gamma: 2 })).toBe(false);
    expect(heldToPoint({ beta: -85, gamma: 0 })).toBe(false);
    expect(heldToPoint({ beta: 10, gamma: 80 })).toBe(false);
    expect(heldToPoint({})).toBe(true);
  });
});

describe('pickHeading', () => {
  it('follows the way you walk while moving, wherever the phone points', () => {
    expect(pickHeading(10, 200, 1.4)).toBe(200);
  });
  it('uses the compass when standing still or without a course', () => {
    expect(pickHeading(10, 200, 0.3)).toBe(10);
    expect(pickHeading(10, null, 1.4)).toBe(10);
    expect(pickHeading(null, 200, 0.2)).toBeNull();
    expect(pickHeading(null, null, 5)).toBeNull();
  });
});

describe('motionBase', () => {
  it('measures from a position a few seconds back, so GPS wander does not look like walking', () => {
    const track = [{ t: 0 }, { t: 1000 }, { t: 2000 }, { t: 3000 }];
    expect(motionBase(track, 4000)).toEqual({ t: 1000 }); // the newest at least 2.5 s old
    expect(motionBase(track.slice(2), 4000)).toEqual({ t: 2000 }); // none old enough: the oldest
    expect(motionBase([], 4000)).toBeNull();
  });
});

describe('easeAngle', () => {
  it('goes the short way across north', () => {
    expect(easeAngle(350, 10, 0.5)).toBe(0);
    expect(easeAngle(10, 350, 0.5)).toBe(0);
  });
  it('clamps the fraction', () => {
    expect(easeAngle(0, 90, 2)).toBe(90);
    expect(easeAngle(0, 90, -1)).toBe(0);
  });
});

describe('fuse', () => {
  it('starts from the first fix', () => {
    expect(fuse(null, 5, 6, 20, 0, 0)).toEqual({ x: 5, y: 6, acc: 20, t: 0, vx: 0, vy: 0 });
  });
  it('moves most of the way to a more accurate fix', () => {
    const e = fuse({ x: 0, y: 0, acc: 50, t: 0, vx: 0, vy: 0 }, 100, 0, 5, 1, 0);
    expect(e.x).toBeGreaterThan(90);
    expect(e.acc).toBeLessThan(5);
  });
  it('barely moves for a much worse fix', () => {
    const e = fuse({ x: 0, y: 0, acc: 5, t: 0, vx: 0, vy: 0 }, 100, 0, 80, 1, 0);
    expect(e.x).toBeLessThan(5);
  });
  it('trusts a new fix more after a long gap or fast travel', () => {
    const slow = fuse({ x: 0, y: 0, acc: 10, t: 0, vx: 0, vy: 0 }, 50, 0, 10, 1, 0);
    const fast = fuse({ x: 0, y: 0, acc: 10, t: 0, vx: 0, vy: 0 }, 50, 0, 10, 30, 5);
    expect(fast.x).toBeGreaterThan(slow.x);
  });
});

describe('fuse while walking', () => {
  // walking north at 1.4 m/s with a fix each second
  const walk = (acc: number, course: number | null) => {
    let e: Estimate | null = null;
    for (let t = 0; t <= 60; t++) e = fuse(e, 0, 1.4 * t, acc, t, 1.4, course);
    return 1.4 * 60 - e!.y;
  };
  it('keeps up with a walker instead of trailing behind', () => {
    // without the course, a 10 m fix leaves the estimate about 9 m behind
    expect(walk(10, null)).toBeGreaterThan(8);
    expect(Math.abs(walk(10, 0))).toBeLessThan(0.5);
    expect(Math.abs(walk(20, 0))).toBeLessThan(0.5);
  });
  it('coasts on between fixes at the last pace, for at most two seconds', () => {
    const e = fuse(null, 0, 0, 5, 10, 1.4, 90);
    expect(coast(e, 10.5).x).toBeCloseTo(0.7);
    expect(coast(e, 10.5).y).toBeCloseTo(0);
    expect(coast(e, 30).x).toBeCloseTo(2.8);
    expect(coast(fuse(null, 0, 0, 5, 10, 0, 90), 11)).toEqual({ x: 0, y: 0 });
  });
});

describe('snapRadius', () => {
  it('snaps only when the fix is good, with a minimum radius', () => {
    expect(snapRadius(5)).toBe(10);
    expect(snapRadius(25)).toBe(25);
    expect(snapRadius(31)).toBe(0);
  });
});

describe('motionBetween', () => {
  it('gives speed and course from two fixes', () => {
    // about 111 m north in 10 s
    const m = motionBetween({ lat: 51, lon: 0, t: 0 }, { lat: 51.001, lon: 0, t: 10_000 })!;
    expect(m.speed).toBeCloseTo(11.1, 0);
    expect(m.heading).toBeCloseTo(0, 0);
    expect(motionBetween({ lat: 51, lon: 0, t: 0 }, { lat: 51, lon: 0.001, t: 10_000 })!.heading).toBeCloseTo(90, 0);
  });
  it('is null when the fixes are too close in time', () => {
    expect(motionBetween({ lat: 51, lon: 0, t: 0 }, { lat: 51.001, lon: 0, t: 100 })).toBeNull();
  });
});

describe('fuse with bad input', () => {
  it('stays finite for a zero accuracy, NaN speed or NaN position', () => {
    const prev = { x: 0, y: 0, acc: 0, t: 1, vx: 0, vy: 0 };
    for (const e of [fuse(prev, 5, 5, 0, 1, 0), fuse(prev, 5, 5, 10, 2, NaN), fuse(prev, NaN, 5, 10, 2, 1)]) {
      expect(Object.values(e).every(Number.isFinite)).toBe(true);
    }
  });
});

describe('motionBetween across the dateline', () => {
  it('measures the short way round', () => {
    const m = motionBetween({ lat: 0, lon: 179.9995, t: 0 }, { lat: 0, lon: -179.9995, t: 10_000 })!;
    expect(m.speed).toBeLessThan(30);
  });
});
