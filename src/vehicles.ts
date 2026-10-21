import type { VehicleId } from './settings';

export interface VehicleProfile {
  id: VehicleId;
  name: string;
  /** m/s */
  maxSpeed: number;
  /** m/s² while holding up arrow */
  accel: number;
  /** m/s² while holding down arrow */
  decel: number;
  /** m/s² while holding the brake key */
  brake: number;
  /** degrees per second while a turn key is held */
  turnRate: number;
  /** max speed when not on a road (null = no restriction) */
  offRoadMax: number | null;
  /** radius of map data to load around the traveller, metres */
  loadRadius: number;
  /** how close a place must be to announce it while passing, metres */
  passRadius: number;
  /** radius used by the sonar sweep and "what's around", metres */
  scanRadius: number;
  /** roads this vehicle can travel on (anything else counts as off road) */
  canUse: (way: { type: string }) => boolean;
  /** road types this vehicle cares about for intersection announcements */
  roadFilter: (way: { type: string; named: boolean; service?: string }) => boolean;
}

const DRIVABLE = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified',
  'residential', 'living_street', 'service',
]);
const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
const FOOT = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'track']);

const notDriveway = (w: { service?: string }) =>
  !w.service || !['driveway', 'parking_aisle', 'drive-through'].includes(w.service);

export const VEHICLES: Record<VehicleId, VehicleProfile> = {
  walker: {
    id: 'walker',
    name: 'Walker',
    maxSpeed: 3,
    accel: 1.2,
    decel: 1.5,
    brake: 5,
    turnRate: 60,
    offRoadMax: null,
    loadRadius: 900,
    passRadius: 25,
    scanRadius: 150,
    canUse: (w) => !w.type.startsWith('motorway') && w.type !== 'trunk',
    roadFilter: (w) =>
      (DRIVABLE.has(w.type) && w.type !== 'motorway' && w.type !== 'motorway_link' && (w.type !== 'service' || w.named)) ||
      (FOOT.has(w.type) && w.named),
  },
  bicycle: {
    id: 'bicycle',
    name: 'Bicycle',
    maxSpeed: 9,
    accel: 1.5,
    decel: 2,
    brake: 6,
    turnRate: 60,
    offRoadMax: 3,
    loadRadius: 1300,
    passRadius: 35,
    scanRadius: 250,
    canUse: (w) => !w.type.startsWith('motorway') && w.type !== 'steps' && w.type !== 'footway',
    roadFilter: (w) =>
      (DRIVABLE.has(w.type) && !w.type.startsWith('motorway') && notDriveway(w)) || w.type === 'cycleway',
  },
  car: {
    id: 'car',
    name: 'Car',
    maxSpeed: 33,
    accel: 3,
    decel: 4,
    brake: 9,
    turnRate: 45,
    offRoadMax: 4,
    loadRadius: 1800,
    passRadius: 40,
    scanRadius: 400,
    canUse: (w) => DRIVABLE.has(w.type),
    roadFilter: (w) => DRIVABLE.has(w.type) && notDriveway(w) && (w.type !== 'service' || w.named),
  },
  motorbike: {
    id: 'motorbike',
    name: 'Motorbike',
    maxSpeed: 36,
    accel: 4.5,
    decel: 4,
    brake: 9,
    turnRate: 55,
    offRoadMax: 5,
    loadRadius: 1800,
    passRadius: 40,
    scanRadius: 400,
    canUse: (w) => DRIVABLE.has(w.type),
    roadFilter: (w) => DRIVABLE.has(w.type) && notDriveway(w) && (w.type !== 'service' || w.named),
  },
  helicopter: {
    id: 'helicopter',
    name: 'Helicopter',
    maxSpeed: 70,
    accel: 5,
    decel: 5,
    brake: 10,
    turnRate: 40,
    offRoadMax: null,
    loadRadius: 2600,
    passRadius: 150,
    scanRadius: 1000,
    canUse: () => true,
    roadFilter: (w) => MAJOR.has(w.type),
  },
};

/** Drives on the roads with traffic: keeps to one-way streets and takes motorways. */
export const isMotor = (id: VehicleId) => id === 'car' || id === 'motorbike';

/** Half width of a road for edge / off-road detection, metres. */
export function roadHalfWidth(type: string): number {
  switch (type) {
    case 'motorway':
    case 'trunk':
      return 12;
    case 'primary':
      return 9;
    case 'secondary':
      return 7.5;
    case 'tertiary':
      return 6.5;
    case 'motorway_link':
    case 'trunk_link':
    case 'primary_link':
    case 'secondary_link':
    case 'tertiary_link':
    case 'residential':
    case 'unclassified':
    case 'living_street':
      return 5;
    case 'service':
      return 3.5;
    case 'pedestrian':
      return 5;
    default:
      return 2;
  }
}

/** A look for a vehicle on the visual map; models change nothing but the drawing. */
export interface VehicleModel {
  id: string;
  name: string;
  /** main paint or clothing colour */
  body: string;
  /** stripe, trim, roof or second colour */
  trim: string;
}

export const VEHICLE_MODELS: Record<VehicleId, VehicleModel[]> = {
  walker: [
    { id: 'blue', name: 'Blue jacket', body: '#1e88e5', trim: '#0d47a1' },
    { id: 'red', name: 'Red jacket', body: '#e53935', trim: '#7f0000' },
    { id: 'green', name: 'Green hiker', body: '#43a047', trim: '#8d6e63' },
  ],
  bicycle: [
    { id: 'road', name: 'Road bike', body: '#e53935', trim: '#212121' },
    { id: 'mountain', name: 'Mountain bike', body: '#43a047', trim: '#ff9800' },
    { id: 'city', name: 'City bike', body: '#1e88e5', trim: '#795548' },
  ],
  car: [
    { id: 'sedan', name: 'Sedan', body: '#1e88e5', trim: '#0d47a1' },
    { id: 'sports', name: 'Sports car', body: '#e53935', trim: '#ffffff' },
    { id: 'taxi', name: 'Taxi', body: '#fdd835', trim: '#212121' },
    { id: 'pickup', name: 'Pickup truck', body: '#607d8b', trim: '#37474f' },
  ],
  motorbike: [
    { id: 'sport', name: 'Sport bike', body: '#e53935', trim: '#212121' },
    { id: 'cruiser', name: 'Cruiser', body: '#212121', trim: '#cfd8dc' },
    { id: 'dirt', name: 'Dirt bike', body: '#ff9800', trim: '#fafafa' },
    { id: 'scooter', name: 'Scooter', body: '#26a69a', trim: '#eceff1' },
  ],
  helicopter: [
    { id: 'tour', name: 'Tour helicopter', body: '#1e88e5', trim: '#ffffff' },
    { id: 'rescue', name: 'Rescue helicopter', body: '#e53935', trim: '#ffffff' },
    { id: 'news', name: 'News helicopter', body: '#fafafa', trim: '#ff6f00' },
  ],
};

/** The chosen model for a vehicle, falling back to its first. */
export function modelFor(vehicle: VehicleId, chosen: Partial<Record<VehicleId, string>>): VehicleModel {
  const list = VEHICLE_MODELS[vehicle];
  return list.find((m) => m.id === chosen[vehicle]) ?? list[0];
}

/** The model after the chosen one, wrapping round. */
export function nextModel(vehicle: VehicleId, chosen: Partial<Record<VehicleId, string>>): VehicleModel {
  const list = VEHICLE_MODELS[vehicle];
  return list[(list.indexOf(modelFor(vehicle, chosen)) + 1) % list.length];
}
