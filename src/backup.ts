import { REBINDABLE, conflict, isReserved, type Binding, type KeyOverrides } from './keymap';
import type { Settings } from './settings';
import { isModel } from './cloudSignal';

export interface BackupPlace {
  name: string;
  lat: number;
  lon: number;
}
export interface BackupNote {
  lat: number;
  lon: number;
  text: string;
}
export interface Backup {
  places: BackupPlace[];
  notes: BackupNote[];
  settings: Partial<Settings>;
}

const PLACES_KEY = 'audio-map-favorites';
const NOTES_KEY = 'audio-map-notes';
const SETTINGS_KEY = 'audio-map-settings';
const MAX_PLACES = 500;
const MAX_NOTES = 2000;
const MAX_TEXT = 2000;
const MAX_FILE_BYTES = 1_000_000;

const ENUMS: Record<string, readonly string[]> = {
  vehicle: ['walker', 'bicycle', 'car', 'helicopter'],
  speechMode: ['screenreader', 'voice'],
  units: ['metric', 'imperial'],
  display: ['highContrast', 'standard'],
  walkRoute: ['shortest', 'streets'],
  soundProfile: ['full', 'simple', 'minimal', 'custom'],
  soundTheme: ['classic', 'soft', 'distinct'],
};
const BOOLS = ['unitsChosen', 'announcePlaces', 'announceHazards', 'haptics', 'shake', 'announceStreets', 'announceHeadingAfterTurn', 'compassTicks', 'roadAssist', 'proximityBeeps', 'turnByTurn', 'beaconSound', 'headingUpMap', 'accessibleRoute', 'cloudWalk', 'forgetKey'];
const GROUPS = ['food', 'shop', 'transport', 'culture', 'nature', 'health', 'service', 'other'];
const VEHICLES = ENUMS.vehicle;
const PROFILES = ENUMS.soundProfile;
const CUSTOM_PLACES = ['all', 'notable', 'landmarks', 'none'];
const RANGES: Record<string, [number, number]> = { voiceRate: [0.5, 3], volume: [0, 1], radiusScale: [0.5, 3] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const coord = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max;
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);

/** Treats the input as untrusted: keeps only well-formed entries and known keys, throws if it is not a backup at all. */
export function validate(raw: unknown): Backup {
  if (!isObj(raw) || raw.app !== 'audio-map') throw new Error('This is not an Audio Map Explorer backup.');
  const places: BackupPlace[] = [];
  for (const p of list(raw.places, MAX_PLACES)) {
    if (!isObj(p)) continue;
    const name = str(p.name, 200);
    if (name && coord(p.lat, 90) && coord(p.lon, 180)) places.push({ name, lat: p.lat, lon: p.lon });
  }
  const notes: BackupNote[] = [];
  for (const n of list(raw.notes, MAX_NOTES)) {
    if (!isObj(n)) continue;
    const text = str(n.text, MAX_TEXT);
    if (text && coord(n.lat, 90) && coord(n.lon, 180)) notes.push({ lat: n.lat, lon: n.lon, text });
  }
  const settings: Record<string, unknown> = {};
  const s = isObj(raw.settings) ? raw.settings : {};
  for (const [k, allowed] of Object.entries(ENUMS)) if (typeof s[k] === 'string' && allowed.includes(s[k])) settings[k] = s[k];
  for (const k of BOOLS) if (typeof s[k] === 'boolean') settings[k] = s[k];
  if (isModel(s.geminiModel)) settings.geminiModel = s.geminiModel;
  if (Array.isArray(s.mutedGroups)) settings.mutedGroups = [...new Set(s.mutedGroups.filter((g): g is string => typeof g === 'string' && GROUPS.includes(g)))];
  const cs = s.customSound;
  if (isObj(cs) && typeof cs.places === 'string' && CUSTOM_PLACES.includes(cs.places) && typeof cs.sideStreets === 'boolean' && typeof cs.extras === 'boolean') {
    settings.customSound = { places: cs.places, sideStreets: cs.sideStreets, extras: cs.extras };
  }
  if (isObj(s.vehicleProfiles)) {
    const vp: Record<string, string> = {};
    for (const v of VEHICLES) {
      const p = s.vehicleProfiles[v];
      if (typeof p === 'string' && PROFILES.includes(p)) vp[v] = p;
    }
    settings.vehicleProfiles = vp;
  }
  if (isObj(s.keyBindings)) {
    const kb: KeyOverrides = {};
    for (const id of REBINDABLE) {
      const b = s.keyBindings[id];
      if (!isObj(b) || typeof b.key !== 'string' || !b.key || b.key.length > 20) continue;
      const bind: Binding = { key: b.key, shift: b.shift === true, ctrl: b.ctrl === true };
      if (!isReserved(bind) && !conflict(id, bind, kb)) kb[id] = bind;
    }
    settings.keyBindings = kb;
  }
  for (const [k, [lo, hi]] of Object.entries(RANGES)) {
    const v = s[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi) settings[k] = v;
  }
  return { places, notes, settings: settings as Partial<Settings> };
}

const key = (a: number, b: number, t: string) => `${a.toFixed(5)},${b.toFixed(5)},${t.toLowerCase()}`;

/** Adds incoming entries that are not already present; returns the merged list and how many were new. */
export function merge<T extends { lat: number; lon: number }>(have: T[], incoming: T[], text: (x: T) => string, cap: number): { all: T[]; added: number } {
  const seen = new Set(have.map((x) => key(x.lat, x.lon, text(x))));
  const all = have.slice();
  let added = 0;
  for (const x of incoming) {
    const k = key(x.lat, x.lon, text(x));
    if (seen.has(k) || all.length >= cap) continue;
    seen.add(k);
    all.push(x);
    added++;
  }
  return { all, added };
}

function read(k: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(k) ?? 'null');
  } catch {
    return null;
  }
}

/** The user's own saved entries, uncapped: validate()'s caps are for untrusted files and would delete data here. */
function keep<T>(k: string, textKey: string): T[] {
  const v = read(k);
  return (Array.isArray(v) ? v : []).filter((x) => isObj(x) && typeof x[textKey] === 'string' && coord(x.lat, 90) && coord(x.lon, 180));
}

function stored(): Backup {
  return { places: keep(PLACES_KEY, 'name'), notes: keep(NOTES_KEY, 'text'), settings: validate({ app: 'audio-map', settings: read(SETTINGS_KEY) }).settings };
}

/** Reflects imported settings in the settings form, which otherwise only reads settings at start-up. */
function syncForm(patch: Record<string, unknown>) {
  const muted = patch.mutedGroups;
  if (Array.isArray(muted)) for (const el of document.querySelectorAll<HTMLInputElement>('input[data-group]')) el.checked = !muted.includes(el.dataset.group);
  const cs = patch.customSound as { places: string; sideStreets: boolean; extras: boolean } | undefined;
  if (cs) {
    (document.getElementById('customPlaces') as HTMLSelectElement).value = cs.places;
    (document.getElementById('customSideStreets') as HTMLInputElement).checked = cs.sideStreets;
    (document.getElementById('customExtras') as HTMLInputElement).checked = cs.extras;
  }
  for (const [k, v] of Object.entries(patch)) {
    for (const r of document.querySelectorAll<HTMLInputElement>(`input[name="${k}"]`)) r.checked = r.value === v;
    const el = document.getElementById(k) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) continue;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = v === true;
    else el.value = String(v);
  }
}

export function setupBackup(applySettings: (patch: Partial<Settings>) => void): void {
  const status = document.getElementById('backup-status')!;
  document.getElementById('export-btn')!.addEventListener('click', () => {
    const b = stored();
    const data = { app: 'audio-map', version: 1, ...b };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = 'audio-map-backup.json';
    a.click();
    URL.revokeObjectURL(a.href);
    status.textContent = `Exported ${b.places.length} places, ${b.notes.length} notes and your settings.`;
  });

  const input = document.getElementById('import-file') as HTMLInputElement;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error('That file is too large to be a backup.');
      let raw: unknown;
      try {
        raw = JSON.parse(await file.text());
      } catch {
        throw new Error('That file is not valid JSON.');
      }
      const inc = validate(raw);
      const have = stored();
      const p = merge(have.places, inc.places, (x) => x.name, MAX_PLACES);
      const n = merge(have.notes, inc.notes, (x) => x.text, MAX_NOTES);
      // loaded here so the pure validate/merge above stay runnable without the browser
      const [{ saveFavorites }, { saveNotes }] = await Promise.all([import('./favorites'), import('./notes')]);
      // through the stores, so the map markers and the running game pick the imports up
      saveFavorites(p.all);
      saveNotes(n.all);
      const changed = Object.keys(inc.settings).length > 0;
      if (changed) {
        applySettings(inc.settings);
        syncForm(inc.settings);
      }
      status.textContent = `Imported ${p.added} places, ${n.added} notes${changed ? ' and settings' : ''}.`;
    } catch (e) {
      status.textContent = `Import failed. ${e instanceof Error ? e.message : ''}`;
    }
  });
}
