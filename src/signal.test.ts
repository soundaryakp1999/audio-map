import { describe, expect, it } from 'vitest';
import { CONFIRM, Confirmer } from './signal';

describe('Confirmer', () => {
  const feed = (c: Confirmer, states: Parameters<Confirmer['add']>[0][]) => states.map((s) => c.add(s));

  it(`changes state only after ${CONFIRM} matching readings`, () => {
    const c = new Confirmer();
    expect(feed(c, ['walk', 'walk', 'walk'])).toEqual([null, null, 'walk']);
    expect(c.state).toBe('walk');
  });
  it('ignores one odd reading', () => {
    const c = new Confirmer();
    feed(c, ['walk', 'walk', 'walk']);
    expect(feed(c, ['dontWalk', 'walk', 'walk'])).toEqual([null, null, null]);
    expect(c.state).toBe('walk');
  });
  it('does not repeat a state it already holds', () => {
    const c = new Confirmer();
    feed(c, ['dontWalk', 'dontWalk', 'dontWalk']);
    expect(feed(c, ['dontWalk', 'dontWalk'])).toEqual([null, null]);
  });
  it('goes quiet after the signal is lost for a while', () => {
    const c = new Confirmer();
    feed(c, ['walk', 'walk', 'walk']);
    expect(feed(c, ['none', 'none', 'none'])).toEqual([null, null, 'none']);
  });
  it('restarts the count when the readings disagree', () => {
    const c = new Confirmer();
    expect(feed(c, ['walk', 'walk', 'dontWalk', 'walk', 'walk', 'walk'])).toEqual([null, null, null, null, null, 'walk']);
  });
});
