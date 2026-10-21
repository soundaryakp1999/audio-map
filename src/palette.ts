// Command palette (Control Shift P): every key command reachable by searching its name.

import { bindingsOf, describeBinding, type ActionId, type KeyOverrides } from './keymap';

export interface Action {
  name: string;
  /** spoken/shown key, e.g. "Shift P" */
  label: string;
  key: string;
  shift?: boolean;
  ctrl?: boolean;
  /** set for actions whose key the player can change */
  id?: ActionId;
}

const f = (name: string, label: string, key: string, shift = false, ctrl = false): Action => ({ name, label, key, shift, ctrl });
const a = (name: string, id: ActionId): Action => ({ ...f(name, '', ''), id });

export const REBIND_NAME = 'Change key bindings';

/** Fills in each changeable action's current key. */
const withKeys = (x: Action, o: KeyOverrides): Action => {
  if (!x.id) return x;
  const b = bindingsOf(x.id, o)[0];
  return { ...x, key: b.key, shift: !!b.shift, ctrl: !!b.ctrl, label: describeBinding(b) };
};

export const ACTIONS: Action[] = [
  a('Align with the road', 'align'),
  a('Heading', 'heading'),
  a('Headphone check', 'calibrate'),
  a('Speed', 'speed'),
  a('Location', 'location'),
  a('Toggle live GPS and compass', 'toggleLive'),
  a('Next intersection', 'nextIntersection'),
  a('Last intersection behind you', 'prevIntersection'),
  a('Step forward through intersections', 'stepForward'),
  a('Step back through intersections', 'stepBack'),
  a('Toggle intersection proximity beeps', 'proximityBeeps'),
  a("What's around", 'whatsAround'),
  a('Weather and daylight', 'conditions'),
  a('Sonar sweep', 'sonar'),
  a('Toggle grid mode', 'toggleGrid'),
  a('Jump to a place', 'jump'),
  a('Save route', 'saveRoute'),
  a('Saved routes', 'routes'),
  a('Search for a destination', 'navigate'),
  a('Distance to go', 'distance'),
  a('Toggle turn-by-turn directions', 'turnByTurn'),
  a('Next instruction', 'instructions'),
  a('Toggle destination beacon', 'beacon'),
  a('Next nearby place', 'nextPlace'),
  a('Previous nearby place', 'prevPlace'),
  a('Set browsed place as destination', 'setDestination'),
  a('Destination distance and direction', 'destinationInfo'),
  a('Clear destination', 'clearDestination'),
  a('Filter kind of place', 'filter'),
  a('Leave a spoken note', 'note'),
  a('Delete note here', 'deleteNote'),
  a('Report a map error to OpenStreetMap', 'osmNote'),
  a('Copy share link', 'share'),
  a('Save the route as a GPX file', 'exportRoute'),
  a('Save this area for offline use', 'saveOffline'),
  a('Trip summary', 'tripSummary'),
  a('Where am I', 'whereAmI'),
  a('Look around: hear what is where you point', 'lookAround'),
  a('Look ahead: hear what is the way you are walking', 'lookAhead'),
  a('Open the destination in my maps app', 'openInMaps'),
  a('Hear places from farther away', 'radiusUp'),
  a('Hear places from nearer', 'radiusDown'),
  a('Emergency: say and share my location', 'sos'),
  a('Preview route', 'preview'),
  a('Next bus stop or station', 'transit'),
  a('Nearest entrances, platforms and lifts', 'nearestAccess'),
  a('Next departures at a stop', 'departures'),
  a('Nearest toilets, benches and other facilities', 'facilities'),
  a('Save this place', 'saveFavorite'),
  a('Walker', 'walker'),
  a('Bicycle', 'bicycle'),
  a('Car', 'car'),
  a('Helicopter', 'helicopter'),
  a('Motorbike', 'motorbike'),
  a('Horn, bell or whistle', 'horn'),
  a('Toggle road assist', 'roadAssist'),
  a('Toggle accessible walking routes', 'accessibleRoute'),
  a('Toggle place announcements', 'announcePlaces'),
  a('Switch sound profile', 'soundProfile'),
  f('Sound theme: Classic', 'no key', 'theme:classic'),
  f('Sound theme: Soft', 'no key', 'theme:soft'),
  f('Sound theme: Distinct', 'no key', 'theme:distinct'),
  a('Toggle map rotation', 'mapRotation'),
  a('Previous spoken message', 'reviewBack'),
  a('Next spoken message', 'reviewNext'),
  a('Stop speech', 'stopSpeech'),
  a('Volume up', 'volumeUp'),
  a('Volume down', 'volumeDown'),
  a('Search for a new location', 'search'),
  a('Open settings', 'settings'),
  f('Learn the keys', 'Shift F1', 'F1', true),
  f('Spoken help', 'F1', 'F1'),
  f('Menu', 'Escape', 'Escape'),
  f(REBIND_NAME, 'opens a dialog', ''),
];

/** Case-insensitive; every typed word must appear in the name. */
export function filterActions(q: string, o: KeyOverrides = {}): Action[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return ACTIONS.map((x) => withKeys(x, o)).filter((x) => words.every((w) => x.name.toLowerCase().includes(w)));
}

/** Wires the dialog and returns the opener. `run` is called after the dialog has closed. */
export function setupPalette(getKeys: () => KeyOverrides, canOpen: () => boolean, onClose: () => void, run: (x: Action) => void) {
  const dlg = document.getElementById('palette') as HTMLDialogElement;
  const q = document.getElementById('palette-q') as HTMLInputElement;
  const list = document.getElementById('palette-list') as HTMLUListElement;
  const status = document.getElementById('palette-status') as HTMLElement;
  let shown: Action[] = [];
  let active = 0;

  const mark = () => {
    list.querySelectorAll('li').forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
    q.setAttribute('aria-activedescendant', shown.length ? `palette-opt-${active}` : '');
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  };
  const choose = (x: Action) => {
    dlg.close();
    onClose();
    run(x);
  };
  const render = () => {
    shown = filterActions(q.value, getKeys());
    active = 0;
    list.replaceChildren(
      ...shown.map((x, i) => {
        const li = document.createElement('li');
        li.id = `palette-opt-${i}`;
        li.setAttribute('role', 'option');
        li.textContent = `${x.name}, ${x.label}`;
        li.addEventListener('click', () => choose(x));
        return li;
      }),
    );
    status.textContent = shown.length === 1 ? '1 action.' : `${shown.length} actions.`;
    mark();
  };

  q.addEventListener('input', render);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!shown.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
      mark();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[active]) choose(shown[active]);
    }
  });
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    dlg.close();
    onClose();
  });

  return () => {
    if (dlg.open || !canOpen()) return;
    q.value = '';
    render();
    dlg.showModal();
    q.focus();
  };
}
