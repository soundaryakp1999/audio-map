import { describe, expect, it } from 'vitest';

import { INPUT, STOP_MIN, WALK_MIN, bestScores, cropOf, judge, toTensorData } from './signalModel';

/** A raw output of `boxes` boxes, laid out [cx, cy, w, h, walk, dont_walk, countdown][box], with the given scores on box `at`. */
function output(boxes: number, at: number, scores: [number, number, number]): Float32Array {
  const out = new Float32Array(7 * boxes);
  scores.forEach((s, c) => (out[(4 + c) * boxes + at] = s));
  return out;
}

describe('bestScores', () => {
  it('finds the best walk score on any box', () => expect(bestScores(output(10, 7, [0.9, 0, 0]), 10)).toEqual({ walk: expect.closeTo(0.9), stop: 0 }));
  it('counts a countdown as a stop', () => expect(bestScores(output(10, 2, [0, 0.1, 0.8]), 10).stop).toBeCloseTo(0.8));
  it('does not read box coordinates as scores', () => {
    const out = new Float32Array(7 * 4).fill(0);
    out.fill(900, 0, 4 * 4); // big pixel coordinates
    expect(bestScores(out, 4)).toEqual({ walk: 0, stop: 0 });
  });
});

describe('judge', () => {
  it('says walk only at a high score', () => {
    expect(judge({ walk: WALK_MIN, stop: 0 })).toBe('walk');
    expect(judge({ walk: WALK_MIN - 0.01, stop: 0 })).toBe('none');
  });
  it('says dont walk from a stop', () => expect(judge({ walk: 0, stop: STOP_MIN })).toBe('dontWalk'));
  it('is unsure when walk and stop both show', () => expect(judge({ walk: 0.95, stop: 0.6 })).toBe('unsure'));
  it('lets a weak stop pass a strong walk', () => expect(judge({ walk: 0.95, stop: 0.3 })).toBe('walk'));
});

describe('cropOf', () => {
  it('takes a square half the short side, centred across', () => expect(cropOf(2160, 3840)).toEqual({ sx: 540, sy: 1073, side: 1080 }));
  it('stays inside a wide frame', () => {
    const c = cropOf(1920, 1080);
    expect(c.side).toBe(540);
    expect(c.sy).toBeGreaterThanOrEqual(0);
    expect(c.sy + c.side).toBeLessThanOrEqual(1080);
  });
});

describe('toTensorData', () => {
  it('splits pixels into planar red, green and blue in 0..1', () => {
    const rgba = new Uint8ClampedArray(INPUT * INPUT * 4);
    rgba.set([255, 51, 0, 255], 0);
    const t = toTensorData(rgba);
    const n = INPUT * INPUT;
    expect(t[0]).toBe(1);
    expect(t[n]).toBeCloseTo(0.2);
    expect(t[2 * n]).toBe(0);
    expect(t.length).toBe(3 * n);
  });
});
