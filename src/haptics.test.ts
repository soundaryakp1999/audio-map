import { afterEach, describe, expect, it, vi } from 'vitest';
import { buzz, pattern } from './haptics';

afterEach(() => vi.unstubAllGlobals());

describe('haptics', () => {
  it('gives every cue its own pattern', () => {
    const kinds = ['left', 'right', 'Steps', 'Pedestrian crossing', 'Crossing with signals', 'Railway crossing', 'Unlit path', 'wrongWay', 'deadEnd', 'arrival'];
    const seen = kinds.map((k) => JSON.stringify(pattern(k)));
    expect(seen.every((s) => s !== undefined && s !== 'undefined')).toBe(true);
    expect(new Set(seen).size).toBe(kinds.length);
  });

  it('vibrates with the pattern, ignores unknown cues, and survives a browser without vibrate', () => {
    const vibrate = vi.fn();
    vi.stubGlobal('navigator', { vibrate });
    buzz('left');
    buzz('nothing');
    expect(vibrate).toHaveBeenCalledOnce();
    expect(vibrate).toHaveBeenCalledWith([250]);
    vi.stubGlobal('navigator', {});
    expect(() => buzz('left')).not.toThrow();
  });
});
