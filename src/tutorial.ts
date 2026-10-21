// Guided practice of the keys on the real map. Watches key presses through Game.onKey; never blocks other keys.

import type { AudioEngine } from './audio/audio';
import type { Command } from './input';
import type { Speech } from './speech';

/** What the tutorial may observe of the game, to tell whether a key press did what the step asks. */
export interface Snap {
  ready: boolean;
  speed: number;
  heading: number;
  vehicle: string;
  hasDest: boolean;
}

interface Step {
  say: string;
  /** codes to press: in this order, or any one of them when `any` is set */
  seq: string[];
  any?: boolean;
  /** passes only once this holds against the state at the step's start or at any of its key presses; without it the key press is enough */
  ok?: (then: Snap, now: Snap) => boolean;
  hint?: string;
}

/** how long after the keys are pressed the effect is awaited, in ms */
const SETTLE = 2000;
const hasDest = (_: Snap, s: Snap) => s.hasDest;
const turned = (a: Snap, b: Snap) => Math.abs(((b.heading - a.heading + 540) % 360) - 180) > 0.5;

const STEPS: Step[] = [
  { say: 'Hold the up arrow to move. Try it now.', seq: ['ArrowUp'], ok: (_, s) => s.speed > 0.3, hint: 'You are not moving yet. Keep holding the up arrow.' },
  { say: 'Hold the slash key to brake, or the down arrow to slow down.', seq: ['Slash', 'ArrowDown'], any: true, ok: (a, s) => a.speed > 0.3 && s.speed < a.speed, hint: 'Hold the up arrow to get moving, then brake.' },
  { say: 'Press the left arrow, then the right arrow, to turn. Hold Shift for bigger turns.', seq: ['ArrowLeft', 'ArrowRight'], ok: turned, hint: 'Your heading did not change. Try the arrows again.' },
  { say: 'Press H to hear your heading.', seq: ['KeyH'] },
  { say: 'Press S to hear your speed.', seq: ['KeyS'] },
  { say: 'Press L to hear where you are.', seq: ['KeyL'] },
  { say: 'Press N to hear the next intersection.', seq: ['KeyN'] },
  { say: 'Press W to hear what is around you.', seq: ['KeyW'] },
  { say: 'Press Tab to browse a nearby place, then Enter to set it as your destination.', seq: ['Tab', 'Enter'], ok: hasDest, hint: 'No destination was set. Press Tab to pick a place, then Enter.' },
  { say: 'Press D to hear the distance to your destination.', seq: ['KeyD'], ok: hasDest, hint: 'You need a destination first. Press Tab, then Enter.' },
  { say: 'Press I for the next turn-by-turn instruction.', seq: ['KeyI'], ok: hasDest, hint: 'You need a destination first. Press Tab, then Enter.' },
  { say: 'Press 1, 2, 3, 4 or 5 to change vehicle.', seq: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'], any: true, ok: (a, s) => s.vehicle !== a.vehicle, hint: 'The vehicle did not change. Press a different number.' },
  { say: 'Press Escape to open the menu.', seq: ['Escape'] },
];

export class Tutorial {
  private step = -1;
  private pos = 0;
  /** the state when the step began and at each of its key presses, before the game acted on the key */
  private marks: Snap[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private speech: Speech,
    private audio: AudioEngine,
    private probe: () => Snap,
    /** called as practice starts, e.g. to leave grid mode, where the arrows step instead of drive */
    private onBegin?: () => void,
  ) {}

  begin() {
    this.onBegin?.();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.step = 0;
    this.pos = 0;
    this.marks = [this.probe()];
    this.speech.say('Learning the keys. Backslash skips a step. Delete exits.', 'high');
    this.speech.say(STEPS[0].say);
  }

  /** returns true when the key was consumed, so the game ignores it */
  onKey(c: Command): boolean {
    if (this.step < 0) {
      if (c.code !== 'F1' || !c.shift) return false;
      if (!c.repeat) this.begin();
      return true;
    }
    if (c.repeat) return c.code === 'Delete' || c.code === 'Backslash';
    if (this.timer) return c.code === 'Delete' || c.code === 'Backslash' ? this.control(c) : false;
    if (c.code === 'Delete' || c.code === 'Backslash') return this.control(c);
    const { seq, any } = STEPS[this.step];
    const hit = any ? seq.includes(c.code) : c.code === seq[this.pos];
    if (!hit) return false;
    this.marks.push(this.probe());
    if (any || ++this.pos === seq.length) this.settle(this.step);
    return false;
  }

  private control(c: Command): boolean {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (c.code === 'Delete') this.end('Tutorial finished. Back to normal play.');
    else this.next('Skipped.');
    return true;
  }

  /** The keys were pressed: pass once the game shows the effect, else give the hint after a while. */
  private settle(step: number, waited = 0) {
    const { ok, hint } = STEPS[step];
    const now = this.probe();
    if (now.ready && (!ok || this.marks.some((m) => ok(m, now)))) {
      this.timer = undefined;
      this.audio.loaded();
      return this.next('Good.');
    }
    if (waited >= SETTLE) {
      this.timer = undefined;
      this.pos = 0;
      return this.speech.say(now.ready ? (hint ?? 'That did not work. Try again.') : 'The map has not loaded yet.');
    }
    this.timer = setTimeout(() => this.settle(step, waited + 200), 200);
  }

  private next(said: string) {
    const step = ++this.step;
    this.pos = 0;
    this.marks = [this.probe()];
    if (step >= STEPS.length) return this.end('Good. You know the keys. Press Shift F1 to practise again.');
    // the game answers the key at high priority first; speak after it so it is not cut off
    setTimeout(() => {
      if (this.step !== step) return;
      this.speech.say(said);
      this.speech.say(STEPS[step].say);
    }, 700);
  }

  private end(text: string) {
    this.step = -1;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.speech.say(text, 'high');
  }
}
