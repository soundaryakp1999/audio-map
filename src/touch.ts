// Touch gestures for phones without a keyboard. They run the same commands as the keys, via Game.run.
import type { ActionId, Binding } from './keymap';

export type Gesture =
  | 'tap'
  | 'two-tap'
  | 'long-press'
  | 'swipe-up'
  | 'swipe-down'
  | 'swipe-left'
  | 'swipe-right'
  | 'two-swipe-left'
  | 'two-swipe-right';

const TAP_MAX = 12;
const SWIPE_MIN = 40;
const LONG_MS = 500;

export function classify(dx: number, dy: number, ms: number, fingers: number): Gesture | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < TAP_MAX && ay < TAP_MAX) return fingers > 1 ? 'two-tap' : ms >= LONG_MS ? 'long-press' : 'tap';
  if (Math.max(ax, ay) < SWIPE_MIN) return null;
  if (ax > ay) return `${fingers > 1 ? 'two-' : ''}swipe-${dx < 0 ? 'left' : 'right'}` as Gesture;
  return fingers > 1 ? null : dy < 0 ? 'swipe-up' : 'swipe-down';
}

/** What a command does: press a key, or start accelerating or braking. */
export type Action = { key: string; shift?: boolean; ctrl?: boolean } | { action: ActionId } | { drive: 'go' | 'brake' };

export interface Driver {
  run(key: string, mods?: { shift?: boolean; ctrl?: boolean }): void;
  keyFor(id: ActionId): Binding;
  hold(code: string, on: boolean): void;
}

const BRAKE_MS = 1500;
let brakeTimer: ReturnType<typeof setTimeout> | undefined;

export function perform(game: Driver, a: Action) {
  if ('action' in a) {
    const b = game.keyFor(a.action);
    return game.run(b.key, b);
  }
  if (!('drive' in a)) return game.run(a.key, a);
  clearTimeout(brakeTimer);
  // press the new key before releasing the old one, so the switch itself is not announced as a stop
  if (a.drive === 'go') {
    game.hold('ArrowUp', true);
    game.hold('Slash', false);
  } else {
    game.hold('Slash', true);
    game.hold('ArrowUp', false);
  }
  // a swipe is momentary, so braking lets go by itself instead of needing a second gesture
  if (a.drive === 'brake') brakeTimer = setTimeout(() => game.hold('Slash', false), BRAKE_MS);
}

export const GESTURES: Record<Gesture, Action> = {
  tap: { action: 'whereAmI' },
  'two-tap': { action: 'menu' },
  'long-press': { action: 'reviewBack' },
  'swipe-up': { drive: 'go' },
  'swipe-down': { drive: 'brake' },
  'swipe-left': { key: 'ArrowLeft', shift: true },
  'swipe-right': { key: 'ArrowRight', shift: true },
  'two-swipe-left': { key: 'ArrowLeft', ctrl: true },
  'two-swipe-right': { key: 'ArrowRight', ctrl: true },
};

/** Only touches on the game surface itself are taken; buttons and form controls keep their own behavior. */
export function setupTouch(stage: HTMLElement, getGame: () => Driver | null) {
  // each finger is measured from where it went down: from one finger to another, a two-finger tap
  // with the fingers apart would read as a swipe
  const starts = new Map<number, { x: number; y: number }>();
  let moved = { dx: 0, dy: 0 };
  let t0 = 0;
  let fingers = 0;
  const own = (e: TouchEvent) => e.target === stage || (e.target as Element).closest('#map, #hud') !== null;

  stage.addEventListener(
    'touchstart',
    (e) => {
      if (!own(e)) return;
      e.preventDefault();
      if (!starts.size) {
        t0 = e.timeStamp;
        fingers = 0;
        moved = { dx: 0, dy: 0 };
      }
      for (const t of Array.from(e.changedTouches)) starts.set(t.identifier, { x: t.clientX, y: t.clientY });
      fingers = Math.max(fingers, e.touches.length);
    },
    { passive: false },
  );
  stage.addEventListener(
    'touchend',
    (e) => {
      let ours = false;
      for (const t of Array.from(e.changedTouches)) {
        const s = starts.get(t.identifier);
        if (!s) continue;
        ours = true;
        starts.delete(t.identifier);
        // the finger that moved furthest says what the gesture was
        const dx = t.clientX - s.x;
        const dy = t.clientY - s.y;
        if (Math.hypot(dx, dy) > Math.hypot(moved.dx, moved.dy)) moved = { dx, dy };
      }
      if (!ours) return;
      e.preventDefault();
      if (starts.size || e.touches.length > 0) return;
      const g = classify(moved.dx, moved.dy, e.timeStamp - t0, fingers);
      const game = getGame();
      if (g && game) perform(game, GESTURES[g]);
    },
    { passive: false },
  );
  stage.addEventListener('touchcancel', () => starts.clear());
}
