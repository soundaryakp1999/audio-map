import type { KeyOverrides } from './keymap';
import type { CustomSound, SoundProfile } from './profiles';
import type { PlaceGroup } from './world';
import { SOUND_THEMES, type SoundTheme } from './audio/themes';
import { validate } from './backup';

export type SpeechMode = 'screenreader' | 'voice';
export type Units = 'metric' | 'imperial';
export type VehicleId = 'walker' | 'bicycle' | 'car' | 'helicopter';
/** high contrast with larger text, roads and markers (the default), or the standard map look */
export type DisplayMode = 'highContrast' | 'standard';
/** walking routes: shortest (any footpath) or along streets and their pavements */
export type WalkRoute = 'shortest' | 'streets';

export interface Settings {
  vehicle: VehicleId;
  speechMode: SpeechMode;
  voiceRate: number;
  /** how far places are announced and listed, as a multiple of the vehicle's usual reach */
  radiusScale: number;
  units: Units;
  /** the player picked the units; until then they follow the country (imperial in the US) */
  unitsChosen: boolean;
  announcePlaces: boolean;
  announceHazards: boolean;
  /** shake the phone to hear where you are */
  shake: boolean;
  /** vibrate for turns, hazards, wrong way and arrival (phones that support it) */
  haptics: boolean;
  announceStreets: boolean;
  announceHeadingAfterTurn: boolean;
  compassTicks: boolean;
  roadAssist: boolean;
  proximityBeeps: boolean;
  turnByTurn: boolean;
  beaconSound: boolean;
  headingUpMap: boolean;
  display: DisplayMode;
  walkRoute: WalkRoute;
  /** walking routes avoid steps and steep slopes */
  accessibleRoute: boolean;
  soundProfile: SoundProfile;
  soundTheme: SoundTheme;
  customSound: CustomSound;
  /** the profile last chosen while using each vehicle */
  vehicleProfiles: Partial<Record<VehicleId, SoundProfile>>;
  /** the look chosen for each vehicle on the visual map, by model id */
  vehicleModels: Partial<Record<VehicleId, string>>;
  volume: number;
  /** place groups silenced while moving; on-demand lookups ignore this */
  mutedGroups: PlaceGroup[];
  /** keys the player moved away from the defaults, by action */
  keyBindings: KeyOverrides;
}

const DEFAULTS: Settings = {
  vehicle: 'walker',
  speechMode: 'screenreader',
  voiceRate: 1.3,
  radiusScale: 1,
  units: 'metric',
  unitsChosen: false,
  announcePlaces: true,
  announceHazards: true,
  shake: false,
  haptics: true,
  announceStreets: true,
  announceHeadingAfterTurn: true,
  compassTicks: true,
  roadAssist: true,
  proximityBeeps: true,
  turnByTurn: true,
  beaconSound: true,
  headingUpMap: true,
  display: 'highContrast',
  walkRoute: 'shortest',
  accessibleRoute: false,
  soundProfile: 'simple',
  soundTheme: 'classic',
  customSound: { places: 'notable', sideStreets: true, extras: true },
  vehicleProfiles: {},
  vehicleModels: {},
  volume: 0.8,
  mutedGroups: [],
  keyBindings: {},
};

const KEY = 'audio-map-settings';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      // stored values are untrusted: keep only well-typed ones, so corrupt or old data falls back to defaults
      const s = { ...DEFAULTS, ...validate({ app: 'audio-map', settings: JSON.parse(raw) }).settings } as Settings;
      // earlier names: 'default' (never chosen, just the old default) and 'lowVision'
      if (s.display !== 'standard') s.display = 'highContrast';
      if (!Array.isArray(s.mutedGroups)) s.mutedGroups = [];
      if (!SOUND_THEMES.includes(s.soundTheme)) s.soundTheme = 'classic';
      if (typeof s.keyBindings !== 'object' || !s.keyBindings) s.keyBindings = {};
      return s;
    }
  } catch {
    // storage unavailable: fall through to defaults
  }
  return { ...DEFAULTS, mutedGroups: [], keyBindings: {} };
}


export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

export function fmtDistance(m: number, units: Units): string {
  m = Math.max(0, m); // progress along a route can overshoot its end
  if (units === 'imperial') {
    const ft = m * 3.28084;
    if (ft < 1000) return `${roundTo(ft, ft < 100 ? 10 : 50)} feet`;
    const mi = m / 1609.34;
    return `${mi.toFixed(mi < 10 ? 1 : 0)} miles`;
  }
  if (m < 1000) return `${roundTo(m, m < 50 ? 5 : m < 200 ? 10 : 50)} metres`;
  const km = m / 1000;
  return `${km.toFixed(km < 10 ? 1 : 0)} kilometres`;
}

export function fmtSpeed(mps: number, units: Units): string {
  if (units === 'imperial') return `${Math.round(mps * 2.23694)} miles per hour`;
  return `${Math.round(mps * 3.6)} kilometres per hour`;
}

export function fmtSpeedShort(mps: number, units: Units): string {
  return units === 'imperial' ? `${Math.round(mps * 2.23694)} mph` : `${Math.round(mps * 3.6)} km/h`;
}

function roundTo(v: number, step: number): number {
  return Math.max(step, Math.round(v / step) * step);
}
