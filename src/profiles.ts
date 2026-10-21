// Sound profiles: how much ambient sound plays, scaled to the vehicle. Full is every place and
// junction; Simple drops minor places and side-street junctions as the vehicle gets faster;
// Minimal keeps only landmarks and main-road junctions. Custom is set by hand. Route turns and
// warnings always play.

import type { Junction, Place } from './world';
import type { Settings, VehicleId } from './settings';

export type SoundProfile = 'full' | 'simple' | 'minimal' | 'custom';

/** the hand-set profile, the same for every vehicle */
export interface CustomSound {
  places: 'all' | 'notable' | 'landmarks' | 'none';
  sideStreets: boolean;
  extras: boolean;
}

type Pick_ = Pick<Settings, 'soundProfile' | 'customSound' | 'mutedGroups'>;
type Preset = Exclude<SoundProfile, 'custom'>;

type ByVehicle<T> = Record<VehicleId, T>;

const MIN_TIER: Record<Preset, ByVehicle<number>> = {
  full: { walker: 0, bicycle: 0, car: 0, motorbike: 0, helicopter: 0 },
  simple: { walker: 0, bicycle: 1, car: 2, motorbike: 2, helicopter: 2 },
  minimal: { walker: 2, bicycle: 2, car: 3, motorbike: 3, helicopter: 3 },
};

const MAJOR_ONLY: Record<Preset, ByVehicle<boolean>> = {
  full: { walker: false, bicycle: false, car: false, motorbike: false, helicopter: false },
  simple: { walker: false, bicycle: false, car: true, motorbike: true, helicopter: true },
  minimal: { walker: false, bicycle: true, car: true, motorbike: true, helicopter: true },
};

/** intersection beeps and compass ticks */
const EXTRAS: Record<Preset, ByVehicle<boolean>> = {
  full: { walker: true, bicycle: true, car: true, motorbike: true, helicopter: true },
  simple: { walker: true, bicycle: true, car: false, motorbike: false, helicopter: false },
  minimal: { walker: false, bicycle: false, car: false, motorbike: false, helicopter: false },
};

export const PROFILE_TEXT: Record<SoundProfile, string> = {
  full: 'Full sound: every place and intersection.',
  simple: 'Simple sound: fewer places and side streets as you go faster.',
  minimal: 'Minimal sound: landmarks and main roads only.',
  custom: 'Custom sound, as set in settings.',
};

const CUSTOM_TIER = { all: 0, notable: 1, landmarks: 2, none: 3 };

const PROFILES: SoundProfile[] = ['full', 'simple', 'minimal', 'custom'];

export const nextProfile = (p: SoundProfile): SoundProfile => PROFILES[(PROFILES.indexOf(p) + 1) % PROFILES.length];

/** 2 landmark, 1 notable, 0 everyday (cafes, shops, bus stops) */
export function placeTier(p: Place): number {
  if (p.group === 'culture' || p.group === 'nature' || p.category === 'station' || p.category === 'hospital') return 2;
  if (p.group === 'health' || (p.group === 'transport' && !['bus stop', 'platform'].includes(p.category))) return 1;
  return 0;
}

export const placeWanted = (s: Pick_, v: VehicleId, p: Place) =>
  !s.mutedGroups.includes(p.group) &&
  placeTier(p) >= (s.soundProfile === 'custom' ? CUSTOM_TIER[s.customSound.places] : MIN_TIER[s.soundProfile][v]);

export const extrasWanted = (s: Pick_, v: VehicleId) => (s.soundProfile === 'custom' ? s.customSound.extras : EXTRAS[s.soundProfile][v]);

const MAIN = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link']);

/** Whether ambient sounds should skip this junction: a side-street junction in a profile that wants main roads only. */
export function junctionQuiet(s: Pick_, v: VehicleId, j: Junction): boolean {
  if (s.soundProfile === 'custom' ? s.customSound.sideStreets : !MAJOR_ONLY[s.soundProfile][v]) return false;
  return !(j.signals || j.exits.some((e) => MAIN.has(e.edge.way.type) || e.edge.way.roundabout));
}
