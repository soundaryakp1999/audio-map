import './style.css';
import { AudioEngine } from './audio/audio';
import { setupBackup } from './backup';
import { Game } from './game';
import type { LatLon } from './geo';
import { MapView } from './mapview';
import { loadFavorites, removeFavorite } from './favorites';
import { loadRecents } from './recents';
import { geocode, type GeocodeResult } from './osm';
import { addBackButtons, backClosesDialogs, goBack } from './back';
import { UNMATCHED, byTierThenDistance, matchTier, mergeHits, type Hit } from './search';
import { loadSettings, saveSettings, type Settings } from './settings';
import { initPreview, stopPreview } from './preview';
import { startBackground, stopBackground } from './background';
import type { ActionId } from './keymap';
import type { PlaceGroup } from './world';
import { Speech } from './speech';
import { Tutorial } from './tutorial';
import { bindRoutes } from './routesui';
import { initManage } from './manage';
import { REBIND_NAME, setupPalette } from './palette';
import { setupRebind } from './rebind';
import { setupTouch } from './touch';
import { setupVoice } from './voice';
import { postOsmNote } from './osmnotes';
import { Phone, beaconText, isPhone } from './phone';
import { requestCompass } from './gps';
import { requestMotion, startShake } from './shake';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const settings = loadSettings();
const speech = new Speech(settings.speechMode, settings.voiceRate);

interface Selected extends LatLon {
  name: string;
}

const PLACE_KEY = 'audio-map-place';
let selected: Selected = loadPlace() ?? { name: 'Times Square, New York', lat: 40.758, lon: -73.9855 };

/** A shared link: #from=lat,lon,name[&to=lat,lon,name] starts there and sets the destination. */
function parseShared(): { from: Selected; to?: Selected } | null {
  const pt = (v: string | null): Selected | undefined => {
    const [lat, lon, ...rest] = (v ?? '').split(',');
    const p = { lat: Number(lat), lon: Number(lon), name: rest.join(',') || 'Shared place' };
    return lat && lon && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 ? p : undefined;
  };
  try {
    const q = new URLSearchParams(location.hash.slice(1));
    const from = pt(q.get('from'));
    return from ? { from, to: pt(q.get('to')) } : null;
  } catch {
    return null;
  }
}

let shared = parseShared();
if (shared) selected = shared.from;

const stage = $<HTMLDivElement>('stage');
const menu = $<HTMLDialogElement>('menu');
const startBtn = $<HTMLButtonElement>('start-btn');
const resumeBtn = $<HTMLButtonElement>('resume-btn');

applyDisplay();
const map = new MapView($('map'), selected, settings.display === 'highContrast');
map.headingUp = settings.headingUpMap;
let game: Game | null = null;
let tutorial: Tutorial | null = null;

// ---------- settings form ----------

function bindSettings() {
  for (const name of ['vehicle', 'speechMode', 'display', 'walkRoute', 'soundProfile', 'soundTheme'] as const) {
    for (const r of document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) {
      r.checked = r.value === settings[name];
      r.addEventListener('change', () => {
        if (r.checked) update({ [name]: r.value } as Partial<Settings>);
      });
    }
  }
  for (const id of ['announceStreets', 'announcePlaces', 'announceHazards', 'haptics', 'announceHeadingAfterTurn', 'compassTicks', 'roadAssist', 'proximityBeeps', 'turnByTurn', 'beaconSound', 'headingUpMap', 'accessibleRoute'] as const) {
    const el = $<HTMLInputElement>(id);
    el.checked = settings[id];
    el.addEventListener('change', () => update({ [id]: el.checked }));
  }
  for (const el of document.querySelectorAll<HTMLInputElement>('input[data-group]')) {
    const group = el.dataset.group as PlaceGroup;
    el.checked = !settings.mutedGroups.includes(group);
    el.addEventListener('change', () =>
      update({ mutedGroups: el.checked ? settings.mutedGroups.filter((g) => g !== group) : [...settings.mutedGroups, group] }),
    );
  }
  for (const id of ['voiceRate', 'volume'] as const) {
    const el = $<HTMLInputElement>(id);
    el.value = String(settings[id]);
    el.addEventListener('input', () => update({ [id]: parseFloat(el.value) }));
  }
  const places = $<HTMLSelectElement>('customPlaces');
  const side = $<HTMLInputElement>('customSideStreets');
  const extras = $<HTMLInputElement>('customExtras');
  places.value = settings.customSound.places;
  side.checked = settings.customSound.sideStreets;
  extras.checked = settings.customSound.extras;
  const custom = () => update({ customSound: { places: places.value as Settings['customSound']['places'], sideStreets: side.checked, extras: extras.checked } });
  for (const el of [places, side, extras]) el.addEventListener('change', custom);
  const units = $<HTMLSelectElement>('units');
  units.value = settings.units;
  units.addEventListener('change', () => update({ units: units.value as Settings['units'], unitsChosen: true }));
}

function update(patch: Partial<Settings>) {
  Object.assign(settings, patch);
  // a profile chosen with a vehicle is remembered for it, and comes back with it
  if (patch.soundProfile) settings.vehicleProfiles = { ...settings.vehicleProfiles, [settings.vehicle]: patch.soundProfile };
  else if (patch.vehicle && settings.vehicleProfiles[patch.vehicle]) settings.soundProfile = settings.vehicleProfiles[patch.vehicle]!;
  saveSettings(settings);
  speech.configure(settings.speechMode, settings.voiceRate);
  map.headingUp = settings.headingUpMap;
  applyDisplay();
  map.setHighContrast(settings.display === 'highContrast');
  game?.applySettings(settings);
  syncVehicleRadios();
}

/** High contrast mode restyles the whole page (larger text, high contrast) through a root attribute. */
function applyDisplay() {
  if (settings.display === 'highContrast') document.documentElement.dataset.display = 'high-contrast';
  else delete document.documentElement.dataset.display;
}

/** settings that can also change by key (vehicle 1–5, walking routes D twice) */
function syncVehicleRadios() {
  for (const name of ['vehicle', 'walkRoute', 'soundProfile', 'soundTheme'] as const) {
    for (const r of document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) r.checked = r.value === settings[name];
  }
}

// ---------- location selection ----------

function select(p: Selected, announce = true) {
  selected = p;
  try {
    localStorage.setItem(PLACE_KEY, JSON.stringify(p));
  } catch {
    // ignore
  }
  // the line is a live region for choosing in the menu; a jump says where you are anyway
  const line = $('selected-place');
  if (!announce) line.removeAttribute('aria-live');
  line.textContent = `Selected: ${p.name}`;
  if (!announce) setTimeout(() => line.setAttribute('aria-live', 'polite'), 0);
  startBtn.textContent = game ? 'Go there' : 'Start';
}

function loadPlace(): Selected | null {
  try {
    const raw = localStorage.getItem(PLACE_KEY);
    const p = raw ? (JSON.parse(raw) as Selected) : null;
    // stored data is untrusted: a place without coordinates would stop the map from loading
    return p && typeof p.name === 'string' && Number.isFinite(p.lat) && Number.isFinite(p.lon) ? p : null;
  } catch {
    return null;
  }
}

let searchSeq = 0;
async function runSearch() {
  const q = $<HTMLInputElement>('search').value.trim();
  const status = $('search-status');
  const list = $<HTMLUListElement>('results');
  if (!q) return;
  const seq = ++searchSeq;
  status.textContent = 'Searching…';
  list.replaceChildren();
  let results: GeocodeResult[] = [];
  try {
    results = await geocode(q);
  } catch {
    if (seq !== searchSeq) return;
    status.textContent = 'Search failed. Check your connection and try again.';
    return;
  }
  if (seq !== searchSeq) return;
  if (!results.length) {
    status.textContent = 'No results found.';
    return;
  }
  status.textContent = `${results.length} results. Choose one below.`;
  for (const r of results) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = r.name;
    b.addEventListener('click', () => {
      select({ name: shortName(r.name), lat: r.lat, lon: r.lon });
      startBtn.focus();
    });
    li.appendChild(b);
    list.appendChild(li);
  }
  (list.querySelector('button') as HTMLButtonElement | null)?.focus();
}

function shortName(full: string) {
  return full.split(',').slice(0, 3).join(',').trim();
}

$('search-btn').addEventListener('click', runSearch);
$<HTMLInputElement>('search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void runSearch();
  }
});

for (const b of document.querySelectorAll<HTMLButtonElement>('.preset')) {
  b.addEventListener('click', () => {
    select({ name: b.textContent!.trim(), lat: parseFloat(b.dataset.lat!), lon: parseFloat(b.dataset.lon!) });
    startBtn.focus();
  });
}

$('geo-btn').addEventListener('click', () => {
  const status = $('search-status');
  if (!navigator.geolocation) {
    status.textContent = 'Location is not available in this browser.';
    return;
  }
  status.textContent = 'Finding your location…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      status.textContent = 'Location found.';
      select({ name: 'My location', lat: pos.coords.latitude, lon: pos.coords.longitude });
      startBtn.focus();
    },
    () => {
      status.textContent = 'Could not get your location. Permission may have been denied.';
    },
    { enableHighAccuracy: true, timeout: 10000 },
  );
});

// ---------- menu / game flow ----------

function openMenu(focus: 'main' | 'search' | 'settings') {
  game?.pause();
  resumeBtn.hidden = !game;
  startBtn.textContent = game ? 'Go there' : 'Start';
  syncVehicleRadios();
  if (!menu.open) menu.showModal();
  if (focus === 'search') {
    $<HTMLInputElement>('search').focus();
  } else if (focus === 'settings') {
    const box = $('display-settings');
    box.scrollIntoView({ block: 'start' });
    box.querySelector<HTMLInputElement>('input:checked')?.focus();
  } else {
    (game ? resumeBtn : startBtn).focus();
  }
}

function closeMenu() {
  if (menu.open) menu.close();
  if (game) {
    game.resume();
    refocus();
  }
}

/** Back to where the player was: the phone screen, or the explorer. */
function refocus() {
  if (phone.active) $('ph-dirs').focus();
  else game?.focus(stage);
}

// ---------- phone mode ----------

let wakeLock: { release(): Promise<void> } | null = null;
async function keepAwake() {
  try {
    wakeLock = (await (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen')) ?? null;
  } catch {
    wakeLock = null; // not allowed (battery saver, or not supported): the screen may lock
  }
}
// the browser drops the lock when the page is hidden; take it again on return. iOS can also leave
// the sound interrupted after the lock screen, so it is resumed then and on the next tap
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !phone.active) return;
  if (wakeLock) void keepAwake();
  game?.wakeAudio();
});
$('phone').addEventListener('pointerdown', () => game?.wakeAudio());

let stopShake: (() => void) | null = null;
/** Listen for shakes only while the phone screen is up and the player has asked for it. */
function applyShake() {
  stopShake?.();
  stopShake = null;
  if (!settings.shake || !phone.active) return;
  stopShake = startShake(() => {
    const b = game?.keyFor('whereAmI');
    if (b) game?.run(b.key, b);
  });
}
const shakeLabel = () => `Shake for address: ${settings.shake ? 'on' : 'off'}`;
const beaconLabel = () => beaconText(settings.beaconSound);
const voiceLabel = () => (settings.speechMode === 'voice' ? 'Speech: built-in voice' : 'Speech: screen reader');
const phone = new Phone($('phone'), () => game, {
  openSearch: () => openNav('navigate'),
  openMenu: () => openMenu('main'),
  toggleVoice: () => {
    update({ speechMode: settings.speechMode === 'voice' ? 'screenreader' : 'voice' });
    speech.say(settings.speechMode === 'voice' ? 'Built-in voice.' : 'Screen reader speech.', 'high');
    return voiceLabel();
  },
  voiceLabel,
  toggleListen: () => toggleVoice?.() ?? false,
  shakeLabel,
  toggleShake: () => {
    update({ shake: !settings.shake });
    if (settings.shake) {
      // asked from this tap (iOS asks only inside a gesture); if refused, shaking could never work
      void requestMotion().then((ok) => {
        if (ok || !settings.shake) return;
        update({ shake: false });
        applyShake();
        $('ph-shake').textContent = shakeLabel();
        speech.say('Motion access was not allowed, so shake is off. It can be allowed in the browser settings for this site.', 'high');
      });
    }
    applyShake();
    speech.say(settings.shake ? 'Shake the phone to hear where you are.' : 'Shake is off.', 'high');
    return shakeLabel();
  },
  beaconLabel,
  toggleBeacon: () => {
    update({ beaconSound: !settings.beaconSound });
    speech.say(settings.beaconSound ? 'Beacon sound on.' : 'Beacon sound off. Directions and turn cues carry on.', 'high');
    return beaconLabel();
  },
  guide: () => {
    // the beacon stays as chosen: some walk by the directions alone
    if (!settings.turnByTurn) update({ turnByTurn: true });
    void keepAwake();
    const act = (id: ActionId) => {
      const b = game?.keyFor(id);
      if (b) game?.run(b.key, b);
    };
    startBackground({ next: () => act('instructions'), previous: () => act('whereAmI') }, 'Walking guidance');
  },
});

/**
 * Phone mode: explore mode around where you are, from one location reading. Travel mode, which
 * follows you, is chosen from its button: from a browser it is not reliable enough to be the default.
 */
function startPhone() {
  rememberPhone(true);
  stopPreview(speech);
  void requestCompass(); // from this tap: iOS asks for the compass only in a user gesture
  if (settings.vehicle !== 'walker') update({ vehicle: 'walker' }); // live GPS on a phone means walking
  const g = ensureGame();
  g.touch = true;
  if (menu.open) menu.close();
  $('app').inert = true; // the keyboard explorer underneath stays out of the screen reader's way
  phone.show('explore');
  applyShake();
  const elsewhere = (why: string) => {
    speech.say(`${why} Exploring ${selected.name} instead.`, 'high');
    if (!g.isStarted) void g.start(selected, selected.name);
  };
  if (!navigator.geolocation) return elsewhere('Location is not available in this browser.');
  speech.say('Phone mode. Explore mode, north up. Finding your location.', 'high');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const here = { name: 'Your location', lat: pos.coords.latitude, lon: pos.coords.longitude };
      select(here, false);
      void g.start(here, 'your location');
    },
    () => elsewhere('Could not get your location; location permission may be off.'),
    { enableHighAccuracy: true, timeout: 15000 },
  );
}

function leavePhone() {
  phone.hide();
  $('app').inert = false;
  void wakeLock?.release().catch(() => {});
  wakeLock = null;
  stopBackground();
  applyShake();
}

$('phone-btn').addEventListener('click', startPhone);
$('ph-begin').addEventListener('click', startPhone);
// Chrome offers installing only after its own checks pass; the button appears when it does
type InstallEvent = Event & { prompt(): Promise<unknown> };
let installEvent: InstallEvent | null = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e as InstallEvent;
  $('ph-install').hidden = false;
});
window.addEventListener('appinstalled', () => ($('ph-install').hidden = true));
$('ph-install').addEventListener('click', async () => {
  await installEvent?.prompt();
  installEvent = null;
  $('ph-install').hidden = true;
});

$('ph-fullmenu').addEventListener('click', () => {
  leavePhone();
  openMenu('main');
});

/** Which first screen to show: the last one chosen (Phone mode or Start), else phone mode on a phone. */
const PHONE_KEY = 'audio-map-phone';
function rememberPhone(on: boolean) {
  try {
    localStorage.setItem(PHONE_KEY, on ? 'on' : 'off');
  } catch {
    // ignore
  }
}
function prefersPhone(): boolean {
  let pref: string | null = null;
  try {
    pref = localStorage.getItem(PHONE_KEY);
  } catch {
    pref = null;
  }
  if (pref === 'on' || pref === 'off') return pref === 'on';
  return isPhone(matchMedia('(pointer: coarse)').matches, Math.min(screen.width, screen.height));
}

/** The game, created on first use (on a user gesture, so the browser allows sound). */
function ensureGame(): Game {
  if (!game) {
    const audio = new AudioEngine(settings.volume, settings.soundTheme); // created on a user gesture so the browser allows sound
    game = new Game(settings, speech, audio, map);
    game.onMenu = openMenu;
    game.onNavigate = () => openNav('navigate');
    game.onJump = () => openNav('jump');
    game.onNote = () => {
      game?.pause();
      $<HTMLInputElement>('note-text').value = '';
      noteDlg.showModal();
      $('note-text').focus();
    };
    game.onOsmNote = (at) => {
      game?.pause();
      osmAt = at;
      showOsmStep(false);
      $<HTMLInputElement>('osmnote-text').value = '';
      osmDlg.showModal();
      $('osmnote-text').focus();
    };
    tutorial = new Tutorial(speech, audio, () => game!.snap, () => game!.exitGrid());
    game.onKey = (c) => tutorial!.onKey(c);
    bindRoutes(game, stage);
    game.onHud = (h) => {
      $('hud-street').textContent = h.street || '—';
      $('hud-speed').textContent = h.speed;
      $('hud-heading').textContent = h.heading;
      $('hud-area').textContent = h.area;
      const dest = $('hud-dest');
      dest.hidden = !h.destination;
      dest.textContent = h.destination ? `→ ${h.destination}` : '';
      $('hud-status').textContent = h.status;
    };
    game.onUnits = (u) => ($<HTMLSelectElement>('units').value = u);
  }
  return game;
}

function startGame(learn = false) {
  rememberPhone(false);
  stopPreview(speech);
  const game = ensureGame();
  leavePhone();
  game.touch = false;
  if (menu.open) menu.close();
  game.focus(stage);
  const to = shared?.to;
  shared = null; // only the first start follows the link
  void game.start(selected, selected.name).then(() => {
    if (to) game?.setTargetLatLon(to.name, to.lat, to.lon);
    if (learn) tutorial!.begin();
  });
}

startBtn.addEventListener('click', () => startGame());
$('learn-btn').addEventListener('click', () => startGame(true));

resumeBtn.addEventListener('click', closeMenu);

menu.addEventListener('cancel', (e) => {
  // Escape inside the menu resumes the game; before the first start there is nothing to resume.
  e.preventDefault();
  if (game) closeMenu();
});

// ---------- destination search (beacon) ----------

const nav = $<HTMLDialogElement>('nav');
/** the same search serves Control + D (set a destination) and Control + J (jump there) */
let navMode: 'navigate' | 'jump' = 'navigate';

function openNav(mode: 'navigate' | 'jump') {
  if (!game) return;
  navMode = mode;
  const jump = mode === 'jump';
  $('nav-title').textContent = jump ? 'Jump to' : 'Navigate to';
  $('nav-hint').textContent = jump
    ? 'Search for a place, address or area to move there. Any destination you have set is kept. Escape to cancel.'
    : 'Search for a place, address or area. Turn-by-turn directions and a beacon will guide you there. Escape to cancel.';
  $('nav-label').textContent = jump ? 'Where do you want to jump to?' : 'Where do you want to go?';
  game.pause();
  $<HTMLInputElement>('nav-q').value = '';
  showFavorites();
  if (!nav.open) nav.showModal();
  const q = $<HTMLInputElement>('nav-q');
  q.select();
  q.focus();
}

function closeNav() {
  if (nav.open) nav.close();
  if (game) {
    game.resume();
    refocus();
  }
}

function pickDestination(name: string, lat: number, lon: number, radius: number) {
  closeNav();
  if (navMode === 'jump') {
    select({ name, lat, lon }, false); // also where the next visit starts
    void game?.jumpTo(name, lat, lon);
  } else game?.setTargetLatLon(name, lat, lon, radius);
}

/** Saved places (key Y), each with a button to remove it; shown when the search is empty. */
function showFavorites() {
  const list = $<HTMLUListElement>('nav-results');
  list.replaceChildren();
  const favs = loadFavorites();
  const recents = loadRecents();
  $('nav-status').textContent =
    favs.length || recents.length
      ? `${recents.length} recent, ${favs.length} saved places. Choose one, or search.`
      : 'No saved places yet. Press Y in the explorer to save one.';
  for (const f of recents) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `Recent: ${f.name}, ${game?.describeFromHere(f.lat, f.lon) ?? ''}`;
    b.addEventListener('click', () => pickDestination(f.name, f.lat, f.lon, 0));
    li.append(b);
    list.appendChild(li);
  }
  for (const f of favs) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${f.name}, ${game?.describeFromHere(f.lat, f.lon) ?? ''}`;
    b.addEventListener('click', () => pickDestination(f.name, f.lat, f.lon, 0));
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = 'Remove';
    rm.setAttribute('aria-label', `Remove ${f.name}`);
    rm.addEventListener('click', () => {
      removeFavorite(f);
      showFavorites();
      $<HTMLInputElement>('nav-q').focus();
    });
    li.append(b, rm);
    list.appendChild(li);
  }
}

interface NavHit extends Hit {
  name: string;
  label: string;
  radius: number;
}

/** Wider search results ranked like nearby places: best word match, then nearest. */
function rankGeocode(q: string, found: GeocodeResult[]): NavHit[] {
  return found
    .map((r) => {
      const name = shortName(r.name);
      const title = r.title || name;
      const d = game?.position ? game.distanceFromHere(r.lat, r.lon) : 0;
      return { ...r, name, title, label: `${name}, ${game?.describeFromHere(r.lat, r.lon) ?? ''}`, tier: matchTier(q, [title, r.kind]) ?? UNMATCHED, d };
    })
    .sort(byTierThenDistance);
}

let navSeq = 0;
async function runNavSearch() {
  if (!game) return;
  const seq = ++navSeq;
  const q = $<HTMLInputElement>('nav-q').value.trim();
  if (!q) return showFavorites();
  const status = $('nav-status');
  const list = $<HTMLUListElement>('nav-results');
  const show = (hits: NavHit[]) =>
    list.replaceChildren(
      ...hits.map((h) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = h.label;
        b.addEventListener('click', () => pickDestination(h.name, h.lat, h.lon, h.radius));
        li.appendChild(b);
        return li;
      }),
    );
  // places already loaded around you show at once; a wider search biased toward where you are
  // then joins them, best word match first and nearest first within that
  const near: NavHit[] = game.findPlaces(q).map((m) => ({ ...m, title: m.name, label: `${m.name}, ${m.detail}`, radius: 0 }));
  show(near);
  status.textContent = 'Searching…';
  try {
    const found = await geocode(q, game.position ?? undefined);
    if (seq !== navSeq) return;
    show(mergeHits(near, rankGeocode(q, found)).slice(0, 12));
  } catch {
    // keep any nearby matches
  }
  if (seq !== navSeq) return;
  const n = list.children.length;
  status.textContent = n ? `${n} results. Choose one to ${navMode === 'jump' ? 'jump' : 'navigate'} there.` : 'No results found.';
  (list.querySelector('button') as HTMLButtonElement | null)?.focus();
}

$('nav-btn').addEventListener('click', runNavSearch);
$<HTMLInputElement>('nav-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void runNavSearch();
  }
});
nav.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeNav();
});

// ---------- spot notes ----------

const noteDlg = $<HTMLDialogElement>('note');

function closeNote() {
  if (noteDlg.open) noteDlg.close();
  if (game) {
    game.resume();
    game.focus(stage);
  }
}

$('note-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $<HTMLInputElement>('note-text').value.trim();
  if (text) game?.addNote(text);
  closeNote();
});
noteDlg.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeNote();
});

// ---------- report to OpenStreetMap ----------

const osmDlg = $<HTMLDialogElement>('osmnote');
let osmAt: LatLon | null = null;
let osmSending = false;

function closeOsm() {
  if (osmDlg.open) osmDlg.close();
  if (game) {
    game.resume();
    game.focus(stage);
  }
}

function showOsmStep(confirm: boolean) {
  $('osmnote-edit').hidden = confirm;
  $('osmnote-confirm').hidden = !confirm;
}

// Public and irreversible, so sending takes a second, spoken and visible step.
$('osmnote-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $<HTMLInputElement>('osmnote-text').value.trim();
  if (!text || !osmAt || osmSending) return;
  if (!$('osmnote-edit').hidden) {
    const msg = `You are about to send this note publicly to OpenStreetMap: ${text}. Choose Send publicly, or Back to change it. Escape cancels.`;
    $('osmnote-summary').textContent = msg;
    showOsmStep(true);
    $('osmnote-send').focus();
    speech.say(msg, 'high');
    return;
  }
  osmSending = true;
  try {
    await postOsmNote(osmAt, text);
    speech.say('Note sent to OpenStreetMap. Thank you.', 'high');
  } catch {
    speech.say('Could not send the note to OpenStreetMap. Check your connection and try again.', 'high');
  } finally {
    osmSending = false;
    closeOsm();
  }
});
$('osmnote-back').addEventListener('click', () => {
  showOsmStep(false);
  $('osmnote-text').focus();
});
osmDlg.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeOsm();
});

const manage = initManage({
  map,
  canGo: () => !!game,
  go: (name, lat, lon) => {
    manage.close();
    closeMenu();
    game?.setTargetLatLon(name, lat, lon, 0);
  },
  notesChanged: () => game?.loadNotes(),
});

$('menu-btn').addEventListener('click', () => openMenu('main'));

stage.addEventListener('focus', () => {
  if (game && !menu.open) game.focus(stage);
});

window.addEventListener('resize', () => map.resize());

// Control + comma: settings, from anywhere outside the explorer (the explorer handles it itself)
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === ',' && document.activeElement !== stage) {
    e.preventDefault();
    openMenu('settings');
  }
});

// Control Shift P works everywhere: key events from the explorer bubble up to the document too
const openPalette = setupPalette(
  () => settings.keyBindings,
  () => {
    if (!game) {
      speech.say('Start the explorer first.', 'high');
      return false;
    }
    if (document.querySelector('dialog[open]')) return false;
    game.pause();
    return true;
  },
  () => {
    game?.resume();
    game?.focus(stage);
  },
  (x) => {
    // the palette has just closed and focus is moving back to the stage; NVDA drops a message spoken in that moment
    if (x.key.startsWith('theme:')) setTimeout(() => game?.setTheme(x.key.slice(6) as Settings['soundTheme']), 300);
    else if (x.name === REBIND_NAME) {
      game?.pause();
      openRebind();
    } else game?.run(x.key, x);
  },
);
const openRebind = setupRebind(
  () => settings.keyBindings,
  (keyBindings) => update({ keyBindings }),
  (t) => speech.say(t, 'high'),
  () => {
    game?.resume();
    game?.focus(stage);
  },
);
// capture phase, so the game never sees the P
document.addEventListener(
  'keydown',
  (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyP') {
      e.preventDefault();
      e.stopPropagation();
      openPalette();
    }
  },
  true,
);

setupTouch(stage, () => game);

const voiceBtn = $<HTMLButtonElement>('voice-btn');
const toggleVoice = setupVoice(
  () => game,
  (s) => speech.say(s, 'high'),
  (on) => {
    voiceBtn.setAttribute('aria-pressed', String(on));
    $('ph-listen').setAttribute('aria-pressed', String(on));
  },
  async (t) => {
    if (!game) return;
    if ('last' in t) {
      const r = loadRecents()[0];
      if (!r) return speech.say('No last destination yet.', 'high');
      return game.setTargetLatLon(r.name, r.lat, r.lon, 0);
    }
    speech.say(`Searching for ${t.query}.`, 'normal');
    try {
      const hit = rankGeocode(t.query, await geocode(t.query, game.position ?? undefined))[0];
      if (hit) game.setTargetLatLon(hit.name, hit.lat, hit.lon, 0);
      else speech.say(`No results for ${t.query}.`, 'high');
    } catch {
      speech.say('Search failed. Check your connection.', 'high');
    }
  },
);
if (toggleVoice) {
  voiceBtn.addEventListener('click', toggleVoice);
} else {
  voiceBtn.hidden = true;
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'F4') return;
  e.preventDefault();
  if (toggleVoice) toggleVoice();
  else speech.say('Voice commands are not supported in this browser.', 'high');
});

bindSettings();
initPreview(() => settings, speech);
setupBackup(update);
select(selected);
// a shared link says where to start, so it opens the menu; otherwise phones begin in phone mode
if (!shared && prefersPhone()) {
  $('app').inert = true;
  phone.welcome();
} else openMenu('main');

// the dev server must not serve stale files from a worker
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  // opened on a weak signal, the saved app came up; once the new one is in, switch to it, but only
  // on the home screen: never mid-walk, and not over a search being typed
  navigator.serviceWorker.addEventListener('message', (e) => {
    if ((e.data as { type?: string } | null)?.type !== 'updated' || game) return;
    const el = document.activeElement;
    if (el instanceof HTMLInputElement && el.value) return;
    location.reload();
  });
  void navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// Buttons for the dialogs that otherwise close only with Escape (touch); they cancel the way Escape does.
for (const b of document.querySelectorAll<HTMLButtonElement>('dialog [data-cancel]')) {
  b.addEventListener('click', () => goBack(b.closest('dialog')!));
}
// Back at the top of each dialog, so it is the first thing a screen reader finds; the menu has Resume
addBackButtons(document, ['menu', 'osmnote']); // the map error report has its own Back between steps
backClosesDialogs(document);
// Shaken while typed text can still be undone, as when walking with the phone in a pocket after
// typing a destination, iOS offers "Undo Typing". Setting the text from code leaves that history,
// but WebKit drops the page's whole undo history whenever a frame is unloaded, so a blank frame is
// added and removed straight away each time a dialog closes.
function forgetTyping() {
  const f = document.createElement('iframe');
  f.hidden = true;
  document.body.appendChild(f);
  f.remove();
}
for (const dlg of document.querySelectorAll<HTMLDialogElement>('dialog')) dlg.addEventListener('close', forgetTyping);
