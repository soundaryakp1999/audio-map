// Key bindings: each action has default keys, and a player's overrides replace them one action at a time.

export interface Binding {
  /** KeyboardEvent.key, lower-cased when it is a single character */
  key: string;
  shift?: boolean;
  ctrl?: boolean;
}
export type KeyOverrides = Partial<Record<ActionId, Binding>>;

const k = (key: string, shift = false, ctrl = false): Binding => ({ key, shift, ctrl });

export const DEFAULT_KEYS = {
  menu: [k('Escape')],
  help: [k('F1'), k('k')],
  heading: [k('h')],
  calibrate: [k('h', true)],
  speed: [k('s')],
  location: [k('l')],
  toggleLive: [k('l', true)],
  nextIntersection: [k('n')],
  prevIntersection: [k('n', true)],
  stepForward: [k('.')],
  stepBack: [k(',')],
  settings: [k(',', false, true)],
  proximityBeeps: [k('b', true)],
  beacon: [k('b')],
  turnByTurn: [k('t')],
  instructions: [k('i')],
  whatsAround: [k('w')],
  conditions: [k('w', true)],
  sonar: [k(' ')],
  toggleGrid: [k('F3')],
  nextPlace: [k('Tab')],
  prevPlace: [k('Tab', true)],
  setDestination: [k('Enter')],
  destinationInfo: [k('g')],
  clearDestination: [k('g', true), k('Backspace')],
  filter: [k('c')],
  note: [k('v')],
  deleteNote: [k('v', true)],
  osmNote: [k('v', false, true)],
  share: [k('z')],
  exportRoute: [k('z', true)],
  saveOffline: [k('s', true)],
  tripSummary: [k('u')],
  whereAmI: [k('e')],
  lookAround: [k('e', true)],
  lookAhead: [k('i', true)],
  openInMaps: [k('m', true)],
  radiusUp: [k(']', false, true)],
  radiusDown: [k('[', false, true)],
  sos: [k('k', true)],
  preview: [k('o')],
  facilities: [k('o', true)],
  transit: [k('x')],
  nearestAccess: [k('x', true)],
  departures: [k('t', true)],
  saveFavorite: [k('y')],
  align: [k('r')],
  search: [k('f')],
  jump: [k('j', false, true)],
  saveRoute: [k('q', true)],
  routes: [k('q')],
  navigate: [k('d', false, true)],
  distance: [k('d')],
  mapRotation: [k('m')],
  roadAssist: [k('a')],
  accessibleRoute: [k('a', true)],
  announcePlaces: [k('p')],
  soundProfile: [k('p', true)],
  reviewBack: [k('[')],
  reviewNext: [k(']')],
  walker: [k('1')],
  bicycle: [k('2')],
  car: [k('3')],
  helicopter: [k('4')],
  horn: [k('j')],
  volumeUp: [k('PageUp')],
  volumeDown: [k('PageDown')],
  stopSpeech: [k('Control')],
} satisfies Record<string, Binding[]>;

export type ActionId = keyof typeof DEFAULT_KEYS;
export const ACTION_IDS = Object.keys(DEFAULT_KEYS) as ActionId[];
/** the menu and help keys stay put so a mistake can always be undone */
export const REBINDABLE = ACTION_IDS.filter((id) => id !== 'menu' && id !== 'help');

/** Escape and F1 open the menu and help, Control Shift P the palette; arrows and slash are handled before actions; the rest belong to the browser and screen readers. */
const RESERVED = ['Escape', 'F1', 'F2', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '/', 'Shift', 'Alt', 'Meta', 'Insert', 'CapsLock'];
const BROWSER_CTRL = ['r', 'l', 't', 'w', 'n'];

export const isReserved = (b: Binding) =>
  RESERVED.includes(b.key) || (!!b.ctrl && BROWSER_CTRL.includes(b.key)) || (!!b.ctrl && !!b.shift && b.key.toLowerCase() === 'p');

export function bindingsOf(id: ActionId, o: KeyOverrides): Binding[] {
  return o[id] ? [o[id]!] : DEFAULT_KEYS[id];
}

const same = (a: Binding, b: Binding) => a.key === b.key && !!a.shift === !!b.shift && !!a.ctrl === !!b.ctrl;

/** An exact modifier match wins; otherwise a plain binding still fires with extra modifiers held, as it always has. */
export function lookup(c: { key: string; shift: boolean; ctrl: boolean }, o: KeyOverrides): ActionId | undefined {
  const key = c.key.length === 1 ? c.key.toLowerCase() : c.key;
  let loose: ActionId | undefined;
  for (const id of ACTION_IDS) {
    for (const b of bindingsOf(id, o)) {
      if (b.key !== key) continue;
      if (same(b, { key, shift: c.shift, ctrl: c.ctrl })) return id;
      if (!b.shift && !b.ctrl) loose ??= id;
    }
  }
  return loose;
}

/** The other action already using this key, if any. */
export function conflict(id: ActionId, b: Binding, o: KeyOverrides): ActionId | undefined {
  return ACTION_IDS.find((x) => x !== id && bindingsOf(x, o).some((y) => same(y, b)));
}

const KEY_NAMES: Record<string, string> = { ' ': 'Space', '.': 'Period', ',': 'Comma', '[': 'Left bracket', ']': 'Right bracket' };

export function describeBinding(b: Binding): string {
  const name = KEY_NAMES[b.key] ?? (b.key.length === 1 ? b.key.toUpperCase() : b.key.replace(/([a-z])([A-Z])/g, '$1 $2'));
  return [b.ctrl && 'Control', b.shift && 'Shift', name].filter(Boolean).join(' ');
}
