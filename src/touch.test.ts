import { describe, expect, it, vi } from 'vitest';
import { bindingsOf } from './keymap';
import { GESTURES, classify, perform, setupTouch } from './touch';

describe('classify', () => {
  it('tells taps from long presses', () => {
    expect(classify(2, 3, 100, 1)).toBe('tap');
    expect(classify(2, 3, 600, 1)).toBe('long-press');
    expect(classify(0, 0, 100, 2)).toBe('two-tap');
  });
  it('reads swipe direction by the dominant axis', () => {
    expect(classify(5, -80, 200, 1)).toBe('swipe-up');
    expect(classify(5, 80, 200, 1)).toBe('swipe-down');
    expect(classify(-90, 20, 200, 1)).toBe('swipe-left');
    expect(classify(90, 20, 200, 1)).toBe('swipe-right');
  });
  it('ignores small drifts and vertical two-finger swipes', () => {
    expect(classify(25, 0, 200, 1)).toBeNull();
    expect(classify(0, -90, 200, 2)).toBeNull();
    expect(classify(-90, 0, 200, 2)).toBe('two-swipe-left');
  });
});

describe('perform with rebound keys', () => {
  it('runs the key currently bound to the gesture action', () => {
    const run = vi.fn();
    perform({ run, hold: vi.fn(), keyFor: (id) => bindingsOf(id, { whereAmI: { key: 'k' } })[0] }, GESTURES.tap);
    expect(run).toHaveBeenCalledWith('k', expect.objectContaining({ key: 'k' }));
  });
});

describe('setupTouch', () => {
  type Pt = { id: number; x: number; y: number };
  function stage() {
    const on: Record<string, (e: unknown) => void> = {};
    const el = { addEventListener: (type: string, f: (e: unknown) => void) => (on[type] = f) };
    const run = vi.fn();
    const hold = vi.fn();
    setupTouch(el as unknown as HTMLElement, () => ({ run, hold, keyFor: (id) => bindingsOf(id, {})[0] }));
    const list = (ps: Pt[]) => ps.map((p) => ({ identifier: p.id, clientX: p.x, clientY: p.y }));
    const fire = (type: string, changed: Pt[], down: Pt[], t: number) =>
      on[type]({ target: el, changedTouches: list(changed), touches: list(down), timeStamp: t, preventDefault() {} });
    return { fire, run, hold };
  }

  it('reads two fingers apart, tapped and lifted one after the other, as a two-finger tap', () => {
    const { fire, run } = stage();
    const a = { id: 1, x: 100, y: 300 };
    const b = { id: 2, x: 260, y: 300 };
    fire('touchstart', [a], [a], 0);
    fire('touchstart', [b], [a, b], 20);
    fire('touchend', [a], [b], 120);
    fire('touchend', [b], [], 140);
    expect(run).toHaveBeenCalledWith(bindingsOf('menu', {})[0].key, expect.anything());
  });

  it('still reads a two-finger swipe, and a one-finger swipe', () => {
    const { fire, run, hold } = stage();
    fire('touchstart', [{ id: 1, x: 300, y: 300 }], [{ id: 1, x: 300, y: 300 }], 0);
    fire('touchstart', [{ id: 2, x: 300, y: 380 }], [{ id: 1, x: 300, y: 300 }, { id: 2, x: 300, y: 380 }], 10);
    fire('touchend', [{ id: 2, x: 200, y: 380 }], [{ id: 1, x: 200, y: 300 }], 200);
    fire('touchend', [{ id: 1, x: 205, y: 300 }], [], 210);
    expect(run).toHaveBeenLastCalledWith('ArrowLeft', expect.objectContaining({ ctrl: true }));
    fire('touchstart', [{ id: 3, x: 200, y: 400 }], [{ id: 3, x: 200, y: 400 }], 1000);
    fire('touchend', [{ id: 3, x: 205, y: 300 }], [], 1200);
    expect(hold).toHaveBeenCalledWith('ArrowUp', true);
  });
});
