// Online routing via the public OSRM servers run by FOSSGIS (routing.openstreetmap.de), and for
// street-only walking routes their Valhalla server, which can be told to avoid footpaths.
// Works for any distance without loading map data. Usage policy: light, non-commercial use.

import { bearing, dist, relAngle, type LatLon, type Projection } from './geo';
import { pointAlong, type Maneuver, type Route, type RoutePoint } from './router';
import type { VehicleId } from './settings';
import { isMotor } from './vehicles';

const BASE: Partial<Record<VehicleId, string>> = {
  walker: 'https://routing.openstreetmap.de/routed-foot/route/v1/foot',
  bicycle: 'https://routing.openstreetmap.de/routed-bike/route/v1/bike',
  car: 'https://routing.openstreetmap.de/routed-car/route/v1/driving',
  motorbike: 'https://routing.openstreetmap.de/routed-car/route/v1/driving',
};
const VALHALLA = 'https://valhalla1.openstreetmap.de/route';
const TIMEOUT_MS = 12_000;

/** OSRM direction words as angles; used instead of its bearings, which can be odd at corners. */
const MODIFIER: Record<string, number> = {
  uturn: 180,
  'sharp right': 150,
  right: 90,
  'slight right': 40,
  straight: 0,
  'slight left': -40,
  left: -90,
  'sharp left': -150,
};

interface OsrmStep {
  name: string;
  ref?: string;
  distance: number;
  maneuver: { type: string; modifier?: string; location: [number, number]; exit?: number };
}

interface OsrmResponse {
  code: string;
  routes?: { distance: number; geometry: { coordinates: [number, number][] }; legs: { steps: OsrmStep[] }[] }[];
}

export function hasOnlineRouting(vehicle: VehicleId): boolean {
  return !!BASE[vehicle];
}

/**
 * Route from the traveller to the target. `nameNear` names unnamed steps (separately mapped
 * sidewalks, service roads) after the street they run beside. Null if no route exists.
 */
export async function fetchOnlineRoute(
  vehicle: VehicleId,
  proj: Projection,
  from: { x: number; y: number; heading: number },
  to: { x: number; y: number },
  nameNear: (x: number, y: number, dir: number) => string | null,
  signal?: AbortSignal,
  /** walking: keep to streets and their pavements rather than footpaths, alleys and tracks */
  streets = false,
  /** walking: avoid steps and steep slopes (wheelchair costing) */
  accessible = false,
): Promise<Route | null> {
  const base = BASE[vehicle];
  if (!base) return null;
  const a = proj.toLatLon(from.x, from.y);
  const b = proj.toLatLon(to.x, to.y);
  const json = vehicle === 'walker' && (streets || accessible) ? await valhallaWalk(a, b, streets, accessible, signal) : await osrm(base, vehicle, a, b, from.heading, signal);
  return json && buildRoute(json, vehicle, proj, to, nameNear);
}

async function osrm(base: string, vehicle: VehicleId, a: LatLon, b: LatLon, heading: number, signal?: AbortSignal): Promise<OsrmResponse | null> {
  const coords = `${a.lon.toFixed(6)},${a.lat.toFixed(6)};${b.lon.toFixed(6)},${b.lat.toFixed(6)}`;
  const url = `${base}/${coords}?overview=full&geometries=geojson&steps=true`;
  // cars and motorbikes should set off the way they are facing; fall back to no preference if that can't be matched
  const tries = isMotor(vehicle) ? [`${url}&bearings=${Math.round(heading)},90;`, url] : [url];
  let json: OsrmResponse | null = null;
  for (const u of tries) {
    const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
    const res = await fetch(u, { signal: sig });
    if (!res.ok && res.status !== 400) throw new Error(`Routing server ${res.status}`);
    json = (await res.json()) as OsrmResponse;
    if (json.code === 'Ok' && json.routes?.length) break;
  }
  return json;
}

/**
 * A walking route on Valhalla, for streets only and/or accessible: pedestrian costing with footpaths ("walkways"),
 * alleys, driveways and tracks made costly, so they are used only when there is no sensible
 * street. Answers in OSRM's format, so the same reading applies.
 */
export async function valhallaWalk(a: LatLon, b: LatLon, streets: boolean, accessible: boolean, signal?: AbortSignal): Promise<OsrmResponse | null> {
  const body = {
    locations: [
      { lat: a.lat, lon: a.lon },
      { lat: b.lat, lon: b.lon },
    ],
    costing: 'pedestrian',
    costing_options: {
      pedestrian: {
        ...(streets ? { walkway_factor: 6, sidewalk_factor: 1, alley_factor: 4, driveway_factor: 5, use_tracks: 0 } : {}),
        ...(accessible ? { type: 'wheelchair' } : {}),
      },
    },
    format: 'osrm',
    shape_format: 'geojson',
    directions_options: { units: 'kilometers' },
  };
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(VALHALLA, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, signal: sig });
  if (!res.ok && res.status !== 400) throw new Error(`Routing server ${res.status}`);
  return (await res.json()) as OsrmResponse;
}

function buildRoute(
  json: OsrmResponse,
  vehicle: VehicleId,
  proj: Projection,
  to: { x: number; y: number },
  nameNear: (x: number, y: number, dir: number) => string | null,
): Route | null {
  const route = json.code === 'Ok' ? json.routes?.[0] : undefined;
  if (!route) return null;

  // geometry → local points with distance along the route
  const points: RoutePoint[] = [];
  for (const [lon, lat] of route.geometry.coordinates) {
    const p = proj.toXY(lat, lon);
    const last = points[points.length - 1];
    if (last && dist(last.x, last.y, p.x, p.y) < 0.01) continue;
    points.push({ x: p.x, y: p.y, d: last ? last.d + dist(last.x, last.y, p.x, p.y) : 0 });
  }
  // the router stops at the nearest road; add the last stretch to the destination itself (e.g. a building)
  if (!points.length) return null;
  const tail = points[points.length - 1];
  const gap = dist(tail.x, tail.y, to.x, to.y);
  if (gap > 3 && gap < 300) points.push({ x: to.x, y: to.y, d: tail.d + gap });
  if (points.length < 2) return null;
  const draft: Route = { points, maneuvers: [], length: points[points.length - 1].d, partial: false };

  const steps = route.legs.flatMap((l) => l.steps);
  const out: (Maneuver & { inName: string })[] = [];
  let searchFrom = 0;
  let current = ''; // street we are on
  let currentRaw = ''; // its real name, if it has one
  let arriveRel = 0;
  for (const st of steps) {
    const m = st.maneuver;
    // where along our geometry this manoeuvre happens (its location is one of the vertices)
    const p = proj.toXY(m.location[1], m.location[0]);
    let bi = searchFrom;
    let bd = Infinity;
    for (let i = searchFrom; i < points.length; i++) {
      const dd = dist(points[i].x, points[i].y, p.x, p.y);
      if (dd < bd) {
        bd = dd;
        bi = i;
      }
      if (dd < 0.5) break;
    }
    searchFrom = bi;
    const d = points[bi].d;

    let name = st.name || st.ref || '';
    const named = !!name;
    let nameAt: { x: number; y: number } | undefined;
    let nameDir: number | undefined;
    if (!named) {
      // unnamed sidewalk or path: describe it by the street it runs beside, now or once that area has loaded
      const k = d + Math.min(st.distance / 2, 30);
      nameAt = pointAlong(draft, k);
      nameDir = dirAt(draft, k);
      const along = nameNear(nameAt.x, nameAt.y, nameDir);
      name = along ? `path along ${along}` : isMotor(vehicle) ? 'road' : 'path';
    }
    const from = { fromName: currentRaw, fromAt: pointAlong(draft, d - 15), fromDir: dirAt(draft, d - 15) };

    if (m.type === 'depart') {
      current = name;
      currentRaw = named ? name : '';
      continue;
    }
    if (m.type === 'arrive') {
      arriveRel = MODIFIER[m.modifier ?? 'straight'] ?? 0;
      continue;
    }
    if (['exit roundabout', 'exit rotary', 'notification'].includes(m.type)) continue;

    let rel = MODIFIER[m.modifier ?? 'straight'] ?? 0;
    // "straight" and "slight" can understate a clear bend: check the road's actual angle there
    if (Math.abs(rel) <= 40) {
      const a1 = pointAlong(draft, d - 20);
      const a2 = pointAlong(draft, d + 20);
      const geo = relAngle(bearing(a1.x, a1.y, p.x, p.y), bearing(p.x, p.y, a2.x, a2.y));
      if (Math.abs(geo) >= 25 && Math.abs(geo) > Math.abs(rel)) rel = geo;
    }
    if (m.type === 'roundabout' || m.type === 'rotary' || m.type === 'roundabout turn') {
      out.push({ x: p.x, y: p.y, d, rel, kind: 'roundabout', exit: m.exit, onto: name, ontoNamed: named, nameAt, nameDir, ...from, inName: current });
      current = name;
      currentRaw = named ? name : '';
      continue;
    }
    let mm: Maneuver & { inName: string } = { x: p.x, y: p.y, d, rel, kind: kindFor(rel), onto: name, ontoNamed: named, nameAt, nameDir, ...from, inName: current };
    // steps a few metres apart (stepping across a side street on the sidewalk): one combined manoeuvre
    const last = out[out.length - 1];
    if (last && last.kind !== 'roundabout' && d - last.d < 20) {
      out.pop();
      const r = relAngle(0, last.rel + rel);
      mm = { ...mm, rel: r, kind: kindFor(r), inName: last.inName, fromName: last.fromName, fromAt: last.fromAt, fromDir: last.fromDir };
    }
    current = name;
    currentRaw = named ? name : '';
    // carrying straight on is only worth saying when the street name changes
    if (mm.kind === 'continue' && (!named || mm.onto === mm.inName)) continue;
    out.push(mm);
  }
  const end = points[points.length - 1];
  const maneuvers: Maneuver[] = out.map(({ inName: _, ...m }) => m);
  maneuvers.push({ x: end.x, y: end.y, d: end.d, rel: arriveRel, kind: 'arrive', onto: '', ontoNamed: false });
  return { ...draft, maneuvers };
}

/** Direction of travel around distance d along the route. */
function dirAt(r: Route, d: number): number {
  const a = pointAlong(r, d - 5);
  const b = pointAlong(r, d + 5);
  return bearing(a.x, a.y, b.x, b.y);
}

function kindFor(rel: number): Maneuver['kind'] {
  const a = Math.abs(rel);
  if (a < 25) return 'continue';
  if (a < 60) return 'bear';
  if (a < 135) return 'turn';
  if (a < 170) return 'sharp';
  return 'u-turn';
}
