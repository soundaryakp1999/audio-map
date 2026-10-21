// Phone mode: a touch map that works with VoiceOver and TalkBack instead of overriding them.
// The map is a 7 by 7 grid of buttons; a screen reader reads each square as the finger moves over
// it, and without one the app speaks it and plays its ground sound. Travel mode follows your real
// location with "up" the street you face; explore mode is north up and pans by buttons.

import type { AreaSound } from './areas';
import { compass8, dist } from './geo';
import type { ActionId, Binding } from './keymap';
import type { PlaceGroup } from './world';
import type { Units } from './settings';

export const N = 7;
const MID = (N - 1) / 2;
/** sizes of a square, in metres or yards */
export const SQUARES = [10, 20, 50];

export interface PhoneGame {
  readonly pose: { x: number; y: number; heading: number; live: boolean; ready: boolean; loadFailed: boolean; mapVersion: number; units: Units };
  readonly hasDestination: boolean;
  readonly beaconOn: boolean;
  describeAt(x: number, y: number): Promise<{ text: string; sound: AreaSound; named: boolean } | null>;
  hoodAt(x: number, y: number): Promise<string | null>;
  areaCue(sound: AreaSound): void;
  streetUp(heading: number): { dir: number; street?: string };
  directionsText(): string;
  /** the next few steps of the route, nearest first */
  routeSteps(max?: number): string[];
  announce(text: string): void;
  setTarget(t: { name: string; x: number; y: number }): void;
  nearbyList(group: PlaceGroup | null): { id: string; text: string }[];
  pickPlace(id: string): boolean;
  startLive(): void;
  run(key: string, mods?: { shift?: boolean; ctrl?: boolean }): void;
  keyFor(id: ActionId): Binding;
}

export interface PhoneHooks {
  openSearch(): void;
  openMenu(): void;
  /** switch between the screen reader and the built-in voice; returns the button's new label */
  toggleVoice(): string;
  voiceLabel(): string;
  /** turn spoken commands on or off; false when the browser cannot do them */
  toggleListen(): boolean;
  shakeLabel(): string;
  /** turn shake-for-address on or off; returns the button's new label */
  toggleShake(): string;
  beaconLabel(): string;
  /** turn the destination beacon sound on or off; returns the button's new label */
  toggleBeacon(): string;
  /** turn on turn by turn, and keep the screen awake */
  guide(): void;
  /** start or stop watching the camera for a crossing signal; returns whether it is on */
  toggleSignal(): Promise<boolean>;
}

/** The beacon button's label. */
export const beaconText = (on: boolean) => `Beacon sound: ${on ? 'on' : 'off'}`;

/** The kinds of place the Nearby list can show. */
const NEAR_KINDS: [PlaceGroup | null, string][] = [
  [null, 'All'],
  ['food', 'Food'],
  ['shop', 'Shops'],
  ['transport', 'Transport'],
  ['health', 'Health'],
  ['culture', 'Culture'],
  ['nature', 'Parks'],
  ['service', 'Services'],
];

// a new key: the first one stored "shown" on every visit, so a hidden default would never take hold
const MAP_KEY = 'audio-map-phone-map-v2';

/** Whether the touch map is wanted in travel mode: hidden unless Show map was chosen. */
function loadMapShown(): boolean {
  try {
    return localStorage.getItem(MAP_KEY) === 'shown';
  } catch {
    return false;
  }
}

/** A phone, not a tablet or touch laptop: a touch screen whose shorter side is at most 600 CSS pixels. */
export function isPhone(coarsePointer: boolean, shortSide: number): boolean {
  return coarsePointer && shortSide <= 600;
}

/** Metres in one unit of distance. */
const unitM = (u: Units) => (u === 'imperial' ? 0.9144 : 1);

/** The centre of square (row, col): rows count down from the top, which faces `up` degrees. */
export function cellPoint(cx: number, cy: number, up: number, size: number, row: number, col: number): { x: number; y: number } {
  const right = (col - MID) * size;
  const ahead = (MID - row) * size;
  const r = (up * Math.PI) / 180;
  return { x: cx + right * Math.cos(r) + ahead * Math.sin(r), y: cy - right * Math.sin(r) + ahead * Math.cos(r) };
}

/** The square (row * N + col) holding point (x, y) on a map drawn by cellPoint; -1 when it is off the map. */
export function cellOf(cx: number, cy: number, up: number, size: number, x: number, y: number): number {
  const r = (up * Math.PI) / 180;
  const dx = x - cx;
  const dy = y - cy;
  const col = Math.round((dx * Math.cos(r) - dy * Math.sin(r)) / size + MID);
  const row = Math.round(MID - (dx * Math.sin(r) + dy * Math.cos(r)) / size);
  return row < 0 || row >= N || col < 0 || col >= N ? -1 : row * N + col + 0; // + 0: rounding just below zero gives -0
}

/** "40 metres ahead, 20 metres right" (travel) or "40 metres north, 20 metres east" (explore); '' for the centre. */
export function offsetText(row: number, col: number, n: number, units: Units, travel: boolean): string {
  const unit = units === 'imperial' ? 'yard' : 'metre';
  const amount = (k: number) => `${Math.abs(k) * n} ${unit}${Math.abs(k) * n === 1 ? '' : 's'}`;
  const fwd = MID - row;
  const side = col - MID;
  const parts: string[] = [];
  if (fwd) parts.push(`${amount(fwd)} ${travel ? (fwd > 0 ? 'ahead' : 'behind') : fwd > 0 ? 'north' : 'south'}`);
  if (side) parts.push(`${amount(side)} ${travel ? (side > 0 ? 'right' : 'left') : side > 0 ? 'east' : 'west'}`);
  return parts.join(', ');
}

export interface UpState {
  dir: number;
  street?: string;
  pending?: { dir: number; street?: string; since: number };
}

/**
 * Settle on which way is up: a new direction must hold for a second before the map turns, so a
 * wobbling compass or a glance aside does not spin it. Returns the state and whether it turned.
 */
export function nextUp(prev: UpState | null, seen: { dir: number; street?: string }, now: number): { state: UpState; turned: boolean } {
  if (!prev) return { state: { dir: seen.dir, street: seen.street }, turned: true };
  if (seen.dir === prev.dir) return { state: { dir: prev.dir, street: seen.street ?? prev.street }, turned: false };
  if (!prev.pending || prev.pending.dir !== seen.dir) return { state: { ...prev, pending: { ...seen, since: now } }, turned: false };
  if (now - prev.pending.since < 1000) return { state: prev, turned: false };
  return { state: { dir: seen.dir, street: seen.street }, turned: true };
}

interface Cell {
  x: number;
  y: number;
  text: string;
  sound: AreaSound;
  named: boolean;
  label: string;
}

export class Phone {
  mode: 'travel' | 'explore' = 'travel';
  private sizeIdx = 1;
  private centre: { x: number; y: number } | null = null;
  private up: UpState | null = null;
  private frame: { cx: number; cy: number; up: number; size: number; units: Units; mode: string; ver: number } | null = null;
  private cells: (Cell | null)[] = [];
  private buttons: HTMLButtonElement[] = [];
  /** the square last double tapped; kept when the map moves on, so Set as destination still means it */
  private chosen: Cell | null = null;
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private touching = false;
  /** the square marked as where you are, or -1 */
  private meIdx = -1;
  private lastHover = -1;
  private started = false;

  constructor(
    private root: HTMLElement,
    private getGame: () => PhoneGame | null,
    private hooks: PhoneHooks,
  ) {
    const grid = this.el('ph-grid');
    for (let i = 0; i < N * N; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cell';
      b.dataset.i = String(i);
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => void this.choose(i));
      grid.appendChild(b);
      this.buttons.push(b);
    }
    // without a screen reader: sliding a finger speaks each square and plays its sound.
    // With one, the screen reader takes the touches itself and reads each square's label.
    grid.addEventListener('pointerdown', (e) => {
      this.touching = true;
      this.hover(e);
    });
    grid.addEventListener('pointermove', (e) => this.touching && this.hover(e));
    const lift = () => {
      this.touching = false;
      this.lastHover = -1;
    };
    // on the whole page: a mouse let go outside the map would otherwise leave every later move over it spoken
    document.addEventListener('pointerup', lift);
    document.addEventListener('pointercancel', lift);

    this.el('ph-dirs').addEventListener('click', () => this.game((g) => g.announce(this.el('ph-dirs').textContent ?? '')));
    this.el('ph-where').addEventListener('click', () => this.hooks.openSearch());
    this.el('ph-start').addEventListener('click', () => this.start());
    this.el('ph-here').addEventListener('click', () => this.action('whereAmI'));
    this.el('ph-listen').addEventListener('click', () => {
      const on = this.hooks.toggleListen();
      this.el('ph-listen').setAttribute('aria-pressed', String(on));
    });
    this.el('ph-sos').addEventListener('click', () => this.action('sos'));
    this.el('ph-offline').addEventListener('click', () => this.action('saveOffline'));
    this.el('ph-maps').addEventListener('click', () => this.action('openInMaps'));
    this.el('ph-farther').addEventListener('click', () => this.action('radiusUp'));
    this.el('ph-nearer').addEventListener('click', () => this.action('radiusDown'));
    this.el('ph-look').addEventListener('click', () => this.action('lookAround'));
    this.el('ph-ahead').addEventListener('click', () => this.action('lookAhead'));
    this.el('ph-shake').addEventListener('click', () => (this.el('ph-shake').textContent = this.hooks.toggleShake()));
    this.el('ph-beacon').addEventListener('click', () => (this.el('ph-beacon').textContent = this.hooks.toggleBeacon()));
    this.el('ph-signal').addEventListener('click', async () => {
      const b = this.el('ph-signal');
      b.setAttribute('aria-pressed', String(await this.hooks.toggleSignal()));
    });
    this.el('ph-nearby').addEventListener('click', () => this.openNearby());
    const kinds = this.el('ph-near-kinds');
    for (const [group, label] of NEAR_KINDS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => this.listNearby(group, label));
      kinds.appendChild(b);
    }
    this.el('ph-near-close').addEventListener('click', () => this.el<HTMLDialogElement>('ph-near').close());
    this.el('ph-end').addEventListener('click', () => {
      this.started = false;
      this.action('clearDestination');
    });
    const pan = (dx: number, dy: number, word: string) => () => this.pan(dx, dy, word);
    this.el('ph-north').addEventListener('click', pan(0, 1, 'north'));
    this.el('ph-south').addEventListener('click', pan(0, -1, 'south'));
    this.el('ph-west').addEventListener('click', pan(-1, 0, 'west'));
    this.el('ph-east').addEventListener('click', pan(1, 0, 'east'));
    this.el('ph-smaller').addEventListener('click', () => this.zoom(-1));
    this.el('ph-larger').addEventListener('click', () => this.zoom(1));
    this.el('ph-centre').addEventListener('click', () => {
      this.centre = null;
      this.game((g) => g.announce('Centred on you.'));
    });
    this.el('ph-dest').addEventListener('click', () => this.setDestination());
    this.el('ph-voice').addEventListener('click', () => (this.el('ph-voice').textContent = this.hooks.toggleVoice()));
    this.el('ph-menu').addEventListener('click', () => this.hooks.openMenu());
    this.el('ph-map').addEventListener('click', () => {
      this.mapShown = !this.mapShown;
      try {
        localStorage.setItem(MAP_KEY, this.mapShown ? 'shown' : 'hidden');
      } catch {
        // ignore
      }
      this.applyMap();
      this.game((g) => g.announce(this.mapShown ? 'Map shown.' : 'Map hidden. The directions and buttons stay.'));
    });
    this.el('ph-steps').addEventListener('click', () => {
      this.stepsOpen = !this.stepsOpen;
      this.applyMap();
      this.showSteps();
      if (this.stepsOpen && !this.el('ph-route').children.length) this.game((g) => g.announce('No route yet. Choose a destination: tap Where to.'));
    });
    this.el('ph-mode').addEventListener('click', () => this.setMode(this.mode === 'travel' ? 'explore' : 'travel', true));
  }

  get active(): boolean {
    return !this.root.hidden;
  }

  /**
   * Whether travel mode shows the touch map; off until Show map is chosen, then remembered.
   * Hidden, the directions and buttons have the room. Explore mode is the map, so it always shows it.
   */
  private mapShown = loadMapShown();

  /** the list of next turns, shown in place of the map when it is hidden */
  private stepsOpen = false;

  private get gridOn(): boolean {
    return this.mode === 'explore' || this.mapShown;
  }

  private applyMap() {
    const on = this.gridOn;
    const grid = this.el('ph-grid');
    if (on && grid.hidden) this.frame = null; // it was not kept up to date while hidden
    grid.hidden = !on;
    this.el('ph-dest').hidden = !on; // squares are chosen on the map
    this.el('ph-status').hidden = !on; // which way is up and the square size: about the map
    this.el('ph-map').hidden = this.mode === 'explore';
    this.el('ph-map').textContent = this.mapShown ? 'Hide map' : 'Show map';
    this.root.classList.toggle('no-map', !on);
    const steps = this.el('ph-steps');
    steps.hidden = on || this.mode !== 'travel';
    steps.setAttribute('aria-expanded', String(this.stepsOpen));
    steps.textContent = this.stepsOpen ? 'Hide next turns' : 'Show next turns';
    this.el('ph-route').hidden = steps.hidden || !this.stepsOpen;
    this.root.classList.toggle('steps-open', !this.el('ph-route').hidden);
  }

  /**
   * Keep the list of next turns current. Rows change in place, and only when their words do, so a
   * screen reader resting on one is not thrown back to the top as you walk.
   */
  private showSteps() {
    const list = this.el('ph-route');
    if (list.hidden) return;
    const lines = this.getGame()?.routeSteps(5) ?? [];
    while (list.children.length > lines.length) list.lastElementChild!.remove();
    lines.forEach((text, i) => {
      let li = list.children[i] as HTMLLIElement | undefined;
      if (!li) li = list.appendChild(document.createElement('li'));
      if (li.textContent !== text) li.textContent = text;
    });
  }

  /** The first screen on a phone: Begin (which, being a tap, may start sound, speech and location) or the full menu. */
  welcome() {
    this.root.hidden = false;
    this.root.classList.add('welcome');
    this.el('ph-begin').focus();
  }

  show(mode: 'travel' | 'explore') {
    this.root.hidden = false;
    this.root.classList.remove('welcome');
    this.el('ph-voice').textContent = this.hooks.voiceLabel();
    this.el('ph-shake').textContent = this.hooks.shakeLabel();
    this.el('ph-beacon').textContent = this.hooks.beaconLabel();
    this.chosen = null; // a fresh start: squares were chosen on the last map
    this.select(-1);
    this.setMode(mode, false);
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 250);
    this.tick();
    this.el('ph-dirs').focus();
  }

  hide() {
    this.root.hidden = true;
    this.root.classList.remove('welcome');
    clearInterval(this.timer);
  }

  setMode(mode: 'travel' | 'explore', announce: boolean) {
    this.mode = mode;
    const travel = mode === 'travel';
    if (!travel) this.centre = null; // explore starts around you, not where it was last panned to
    this.el('ph-travel').hidden = !travel;
    this.el('ph-explore').hidden = travel;
    this.el('ph-mode').textContent = travel ? 'Travel mode. Switch to explore' : 'Explore mode. Switch to travel';
    this.frame = null; // draw afresh for the new mode
    this.up = null;
    this.applyMap();
    if (announce)
      this.game((g) =>
        g.announce(
          travel
            ? this.mapShown
              ? 'Travel mode. The map follows you, with up the street you face. Touch a square to hear what is there.'
              : 'Travel mode. Directions and buttons; Show map adds a touch map around you.'
            : 'Explore mode. North is up. Pan and zoom with the buttons below the map.',
        ),
      );
  }

  /** Every quarter second: follow the traveller and compass, and keep the directions current. */
  private tick() {
    const g = this.getGame();
    const status = this.el('ph-status');
    if (!g || !g.pose.ready) {
      // the directions line too: with the map hidden it is the only line about the map that shows
      const wait = g?.pose.loadFailed ? 'Could not load the map. Trying again shortly.' : 'Loading the map…';
      status.textContent = wait;
      const d = this.el('ph-dirs');
      if (d.textContent !== wait) d.textContent = wait;
      return;
    }
    const p = g.pose;
    const travel = this.mode === 'travel';
    const units = p.units;
    const size = SQUARES[this.sizeIdx] * unitM(units);
    let cx = p.x;
    let cy = p.y;
    let up = 0;
    if (travel) {
      // no announcement when up changes: the traveller knows they turned, and the status line shows it
      const r = nextUp(this.up, g.streetUp(p.heading), performance.now());
      this.up = r.state;
      up = r.state.dir;
    } else {
      this.centre ??= { x: p.x, y: p.y };
      cx = this.centre.x;
      cy = this.centre.y;
    }
    const f = this.frame;
    // a newly arrived map can fill in squares that were not loaded, or correct them
    const moved = !f || f.up !== up || f.size !== size || f.units !== units || f.mode !== this.mode || dist(f.cx, f.cy, cx, cy) > size / 2;
    if (moved || f.ver !== p.mapVersion) {
      this.frame = { cx, cy, up, size, units, mode: this.mode, ver: p.mapVersion };
      void this.render();
    }
    // where you are: the centre in travel mode; in explore mode wherever the panning has left you, if on the map
    const fr = this.frame!;
    const me = cellOf(fr.cx, fr.cy, fr.up, fr.size, p.x, p.y);
    if (me !== this.meIdx) {
      this.buttons[this.meIdx]?.classList.remove('me');
      this.buttons[me]?.classList.add('me');
      this.meIdx = me;
    }
    const n = SQUARES[this.sizeIdx];
    const unit = units === 'imperial' ? 'yard' : 'metre';
    status.textContent = travel ? `Up: ${this.up?.street ? `${this.up.street}, ` : ''}${compass8(up)} · squares of ${n} ${unit}s` : `North up · squares of ${n} ${unit}s`;
    const dirs = travel ? g.directionsText() || (g.hasDestination ? '' : 'Choose a destination: tap Where to.') : 'Exploring. Touch the map, or pan with the buttons.';
    const d = this.el('ph-dirs');
    if (dirs && d.textContent !== dirs) d.textContent = dirs;
    // B or a voice command can change the beacon too
    const beacon = beaconText(g.beaconOn);
    if (this.el('ph-beacon').textContent !== beacon) this.el('ph-beacon').textContent = beacon;
    this.showSteps();
  }

  /** Work out what every square holds and label it. */
  private async render() {
    const g = this.getGame();
    const f = this.frame;
    if (!g || !f || !this.gridOn) return;
    const seq = ++this.seq;
    const travel = f.mode === 'travel';
    const n = SQUARES[this.sizeIdx];
    const found = await Promise.all(
      this.buttons.map(async (_b, i) => {
        const row = Math.floor(i / N);
        const col = i % N;
        const at = cellPoint(f.cx, f.cy, f.up, f.size, row, col);
        const d = await g.describeAt(at.x, at.y);
        if (!d) return null;
        const off = offsetText(row, col, n, f.units, travel);
        const label = off ? `${d.text}, ${off}` : `${travel ? 'You are here' : 'Centre'}: ${d.text}`;
        return { ...at, ...d, label };
      }),
    );
    if (seq !== this.seq) return; // a newer frame has replaced this one
    this.cells = found;
    this.select(-1);
    found.forEach((c, i) => {
      const b = this.buttons[i];
      if (!c) {
        b.textContent = '';
        b.setAttribute('aria-label', 'Not loaded yet');
        delete b.dataset.sound;
        return;
      }
      b.textContent = c.text.split(',')[0];
      b.setAttribute('aria-label', c.label);
      b.dataset.sound = c.sound;
    });
  }

  private hover(e: PointerEvent) {
    const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('.cell');
    const i = el ? Number(el.dataset.i) : -1;
    if (i < 0 || i === this.lastHover) return;
    this.lastHover = i;
    const c = this.cells[i];
    const g = this.getGame();
    if (!c || !g) return;
    g.areaCue(c.sound);
    g.announce(c.label);
  }

  /** A double tap (or a tap without a screen reader) on a square: say more, and offer it as a destination. */
  private async choose(i: number) {
    const c = this.cells[i];
    const g = this.getGame();
    if (!c || !g) return;
    this.select(i);
    const hood = c.named ? null : await g.hoodAt(c.x, c.y);
    g.announce(`${c.label}.${hood ? ` Near ${hood}.` : ''} Set as destination is below the map.`);
  }

  /** Mark square i (-1: none) as chosen. Redrawing the map unmarks the squares but keeps the choice. */
  private select(i: number) {
    this.buttons.forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
    if (this.cells[i]) this.chosen = this.cells[i];
    const dest = this.el<HTMLButtonElement>('ph-dest');
    const c = this.chosen;
    dest.disabled = !c;
    dest.textContent = c ? `Set as destination: ${c.text.split(',')[0]}` : 'Set as destination';
  }

  private setDestination() {
    const c = this.chosen;
    this.game((g) => {
      if (!c) return g.announce('Double tap a square on the map first.');
      g.setTarget({ name: c.text.split(',')[0], x: c.x, y: c.y });
      if (this.mode === 'travel' && !this.started) g.announce('Tap Start to be guided there.');
    });
  }

  /** Nearby: the places around you, nearest first; choosing one sets it as the destination. */
  private openNearby() {
    const d = this.el<HTMLDialogElement>('ph-near');
    if (!d.open) d.showModal();
    this.listNearby(null, 'All');
  }

  private listNearby(group: PlaceGroup | null, label: string) {
    const g = this.getGame();
    const list = this.el('ph-near-list');
    list.replaceChildren();
    const items = g?.nearbyList(group) ?? [];
    this.el('ph-near-status').textContent = items.length
      ? `${label}: ${items.length} nearby, nearest first. Choose one to go there.`
      : `No ${label === 'All' ? '' : `${label.toLowerCase()} `}places within 500 metres.`;
    for (const it of items) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = it.text;
      b.addEventListener('click', () => {
        this.el<HTMLDialogElement>('ph-near').close();
        if (!g?.pickPlace(it.id)) return;
        if (this.mode === 'travel' && !this.started) g.announce('Tap Start to be guided there.');
      });
      li.appendChild(b);
      list.appendChild(li);
    }
    (list.querySelector('button') as HTMLButtonElement | null)?.focus();
  }

  private start() {
    this.game((g) => {
      if (!g.hasDestination) return g.announce('Choose a destination first: tap Where to, or double tap a square and Set as destination.');
      this.started = true;
      this.hooks.guide();
      g.startLive(); // from this tap, so iOS can ask for the compass
      g.announce(`Starting. The directions are at the top of the screen${g.beaconOn ? '; follow the beacon' : ''}. The map turns with you.`);
    });
  }

  private pan(dx: number, dy: number, word: string) {
    const g = this.getGame();
    if (!g?.pose.ready) return;
    const p = g.pose;
    const c = (this.centre ??= { x: p.x, y: p.y });
    const step = N * SQUARES[this.sizeIdx] * unitM(p.units);
    c.x += dx * step;
    c.y += dy * step;
    g.announce(`Moved ${word} ${N * SQUARES[this.sizeIdx]} ${p.units === 'imperial' ? 'yards' : 'metres'}.`);
  }

  private zoom(d: 1 | -1) {
    const i = Math.max(0, Math.min(SQUARES.length - 1, this.sizeIdx + d));
    const g = this.getGame();
    const unit = g?.pose.units === 'imperial' ? 'yards' : 'metres';
    const lead = i === this.sizeIdx ? (d > 0 ? 'Largest squares' : 'Smallest squares') : 'Squares';
    this.sizeIdx = i;
    g?.announce(`${lead} of ${SQUARES[i]} ${unit}; the map shows ${N * SQUARES[i]} ${unit} across.`);
  }

  private action(id: ActionId) {
    this.game((g) => {
      const b = g.keyFor(id);
      g.run(b.key, b);
    });
  }

  private game(fn: (g: PhoneGame) => void) {
    const g = this.getGame();
    if (g) fn(g);
  }

  private el<T extends HTMLElement = HTMLElement>(id: string): T {
    return document.getElementById(id) as T;
  }
}
