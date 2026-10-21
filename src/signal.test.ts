import { describe, expect, it } from 'vitest';
import { LOST_MS, SignalTracker, styleWarning, type SignalState } from './signal';

describe('SignalTracker', () => {
  // one reading a second unless times are given
  const feed = (c: SignalTracker, states: SignalState[], t0 = 0) => states.map((s, i) => c.add(s, t0 + i * 1000));

  it('sounds and says a walk on its first reading', () => {
    const c = new SignalTracker();
    expect(c.add('walk', 0)).toEqual({ state: 'walk', say: true });
  });
  it('switches straight back when the next reading differs', () => {
    const c = new SignalTracker();
    expect(feed(c, ['walk', 'dontWalk', 'walk'])).toEqual([
      { state: 'walk', say: true },
      { state: 'dontWalk', say: true },
      { state: 'walk', say: true },
    ]);
  });
  it('does not repeat a state it already holds', () => {
    const c = new SignalTracker();
    expect(feed(c, ['dontWalk', 'dontWalk'])).toEqual([{ state: 'dontWalk', say: true }, null]);
  });
  it('stops the walk sound at once when walk is no longer seen, without saying lost', () => {
    const c = new SignalTracker();
    expect(feed(c, ['walk', 'none'])).toEqual([{ state: 'walk', say: true }, { state: 'none', say: false }]);
    // seen again: sounded, but not said again
    expect(c.add('walk', 2000)).toEqual({ state: 'walk', say: false });
  });
  it("holds don't walk through a flashing hand", () => {
    const c = new SignalTracker();
    expect(feed(c, ['dontWalk', 'none', 'dontWalk', 'none', 'none', 'dontWalk'])).toEqual([{ state: 'dontWalk', say: true }, null, null, null, null, null]);
    expect(c.state).toBe('dontWalk');
  });
  it('says lost only after no signal for a while', () => {
    const c = new SignalTracker();
    c.add('dontWalk', 0);
    expect(c.add('none', LOST_MS - 1)).toBeNull();
    expect(c.add('none', LOST_MS)).toEqual({ state: 'none', say: true });
    expect(c.add('none', LOST_MS + 1000)).toBeNull();
  });
  it('says lost after a walk that went quiet', () => {
    const c = new SignalTracker();
    feed(c, ['walk', 'none']);
    expect(c.add('none', LOST_MS)).toEqual({ state: 'none', say: true });
  });
  it('has nothing to lose before any signal is seen', () => {
    const c = new SignalTracker();
    expect(feed(c, ['none', 'none'], 0)).toEqual([null, null]);
    expect(c.add('none', LOST_MS * 2)).toBeNull();
  });
});

describe('styleWarning', () => {
  it('says nothing where signals look like the training photos', () => {
    expect(styleWarning('us')).toBe('');
    expect(styleWarning('ca')).toBe('');
  });
  it('warns elsewhere', () => expect(styleWarning('in')).toMatch(/US-style signals/));
  it('says nothing while the country is unknown', () => expect(styleWarning(null)).toBe(''));
});
