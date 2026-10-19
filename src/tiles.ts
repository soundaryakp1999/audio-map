// Roads and places from OpenFreeMap vector tiles: the same OpenStreetMap data as Overpass, but
// served from a CDN, so an area loads in a second or two instead of tens of seconds.
//
// Tiles store simplified, clipped and merged lines without node ids, so the road graph is rebuilt:
// shared vertices become junctions, lines cut at tile edges are rejoined, road ends that touch
// another road are connected to it, and names come from a separate label layer. Roundabouts and
// traffic signals are not in the tiles; the fuller Overpass data that follows adds them.

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type { LatLon } from './geo';
import { HIGHWAYS, type RawPlace, type RawPlaces, type RawRoads, type RawWay } from './osm';

const TILEJSON = 'https://tiles.openfreemap.org/planet';
export const Z = 14; // the most detailed level, where every road and place is present
export const EXTENT = 4096;
const HIGHWAY_SET = new Set(HIGHWAYS.split('|'));
/** how close (in tile units, ~0.4–0.6 m) a road end must be to another road to count as joined */
const SNAP = 1.6;

const KEPT = 'audio-map-tiles-v1';
/** a tile is tens of kilobytes, so this keeps the cache to a few tens of megabytes */
const KEPT_MAX = 600;

async function keep(url: string, res: Response) {
  const c = await caches.open(KEPT);
  await c.put(url, res);
  const keys = await c.keys(); // oldest first
  for (const k of keys.slice(0, Math.max(0, keys.length - KEPT_MAX))) await c.delete(k);
}

/** Network first, keeping what arrives; offline, a tile or tile list seen before is served instead. */
export async function fetchKept(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    const r = await fetch(url, init);
    if (r.ok && typeof caches !== 'undefined') {
      void keep(url, r.clone()).catch(() => undefined);
    }
    return r;
  } catch (e) {
    if (init.signal?.aborted || typeof caches === 'undefined') throw e;
    const hit = await caches.match(url, { cacheName: KEPT }).catch(() => undefined);
    if (hit) return hit;
    throw e;
  }
}

let tileUrl: Promise<string> | null = null;

/** The current tile URL template (it changes when the map data is updated). */
// Shared by every caller, so it must not be tied to one caller's abort signal.
function template(): Promise<string> {
  tileUrl ??= fetchKept(TILEJSON, { signal: AbortSignal.timeout(15_000) })
    .then((r) => {
      if (!r.ok) throw new Error(`TileJSON ${r.status}`);
      return r.json();
    })
    .then((j: { tiles: string[] }) => j.tiles[0]);
  tileUrl.catch(() => (tileUrl = null)); // try again next time
  return tileUrl;
}

const MAX_LAT = 85.0511; // the Web Mercator limit
export const tileX = (lon: number) => ((lon + 180) / 360) * 2 ** Z;
export const tileY = (lat: number) => {
  const r = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** Z;
};
/** global tile-unit coordinates (x right, y down) to lat/lon */
function toLatLon(gx: number, gy: number): LatLon {
  const n = 2 ** Z * EXTENT;
  const lon = (gx / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / n))) * 180) / Math.PI;
  return { lat, lon };
}

/** One tile at zoom Z. */
export async function fetchTile(tx: number, ty: number, signal?: AbortSignal): Promise<VectorTile> {
  const url = await template();
  // tiles past the dateline wrap round to the other side of the map
  const wx = ((tx % 2 ** Z) + 2 ** Z) % 2 ** Z;
  const r = await fetchKept(url.replace('{z}', String(Z)).replace('{x}', String(wx)).replace('{y}', String(ty)), { signal });
  if (!r.ok) throw new Error(`Tile ${tx},${ty}: ${r.status}`);
  return new VectorTile(new PbfReader(new Uint8Array(await r.arrayBuffer())));
}

interface Pt {
  x: number;
  y: number;
}

/** Road type in OSM terms, or null for things we don't travel on (rail, ferries, construction). */
function highwayType(p: Record<string, unknown>): string | null {
  const cls = String(p.class ?? '');
  const sub = String(p.subclass ?? '');
  let t: string;
  if (['motorway', 'trunk', 'primary', 'secondary', 'tertiary'].includes(cls)) t = p.ramp ? `${cls}_link` : cls;
  else if (cls === 'minor') t = 'residential';
  else if (cls === 'service' || cls === 'track') t = cls;
  else if (cls === 'path') t = sub || 'path';
  else return null;
  return HIGHWAY_SET.has(t) ? t : null;
}

/** Cut a polyline to the square [x0,x1]×[y0,y1]; points made on the edge are marked. */
function clip(line: Pt[], x0: number, y0: number, x1: number, y1: number): (Pt & { edge?: boolean })[][] {
  const inside = (p: Pt) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
  const out: (Pt & { edge?: boolean })[][] = [];
  let cur: (Pt & { edge?: boolean })[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    // Liang–Barsky
    let t0 = 0;
    let t1 = 1;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let ok = true;
    for (const [p, q] of [
      [-dx, a.x - x0],
      [dx, x1 - a.x],
      [-dy, a.y - y0],
      [dy, y1 - a.y],
    ]) {
      if (p === 0) {
        if (q < 0) ok = false;
      } else {
        const r = q / p;
        if (p < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
      }
    }
    if (!ok || t0 > t1) {
      if (cur.length > 1) out.push(cur);
      cur = [];
      continue;
    }
    const pa = t0 > 0 ? { x: a.x + dx * t0, y: a.y + dy * t0, edge: true } : a;
    const pb = t1 < 1 ? { x: a.x + dx * t1, y: a.y + dy * t1, edge: true } : b;
    if (!cur.length) cur.push(pa);
    cur.push(pb);
    if (t1 < 1 || !inside(b)) {
      if (cur.length > 1) out.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

class SegGrid {
  private cells = new Map<string, number[]>();
  constructor(private size: number) {}
  add(i: number, a: Pt, b: Pt) {
    const s = this.size;
    for (let cx = Math.floor(Math.min(a.x, b.x) / s); cx <= Math.floor(Math.max(a.x, b.x) / s); cx++)
      for (let cy = Math.floor(Math.min(a.y, b.y) / s); cy <= Math.floor(Math.max(a.y, b.y) / s); cy++) {
        const k = `${cx},${cy}`;
        const arr = this.cells.get(k);
        if (arr) arr.push(i);
        else this.cells.set(k, [i]);
      }
  }
  near(p: Pt, r: number): Set<number> {
    const s = this.size;
    const out = new Set<number>();
    for (let cx = Math.floor((p.x - r) / s); cx <= Math.floor((p.x + r) / s); cx++)
      for (let cy = Math.floor((p.y - r) / s); cy <= Math.floor((p.y + r) / s); cy++) for (const i of this.cells.get(`${cx},${cy}`) ?? []) out.add(i);
    return out;
  }
}

/** Where segments a1–a2 and b1–b2 cross strictly inside both (t along a, u along b), if they do. */
function crossing(a1: Pt, a2: Pt, b1: Pt, b2: Pt): (Pt & { t: number; u: number }) | null {
  const rx = a2.x - a1.x;
  const ry = a2.y - a1.y;
  const sx = b2.x - b1.x;
  const sy = b2.y - b1.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((b1.x - a1.x) * sy - (b1.y - a1.y) * sx) / den;
  const u = ((b1.x - a1.x) * ry - (b1.y - a1.y) * rx) / den;
  if (t <= 0.001 || t >= 0.999 || u <= 0.001 || u >= 0.999) return null;
  return { x: a1.x + t * rx, y: a1.y + t * ry, t, u };
}

function segDist(p: Pt, a: Pt, b: Pt): { d: number; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return { d: Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy), t };
}

interface RoadLine {
  pts: number[]; // node ids
  tags: Record<string, string>;
  /** roads at the same level (not bridges or tunnels) that cross must meet there */
  level: string | null;
  /** name per segment (pts.length - 1) */
  names: (string | undefined)[];
}

/** Roads and places for the tiles covering a square of `radius` metres around `center`. */
export async function fetchTileArea(center: LatLon, radius: number, signal: AbortSignal): Promise<{ roads: RawRoads; places: RawPlaces }> {
  const dLat = radius / 110_540;
  const dLon = radius / (111_320 * Math.cos((center.lat * Math.PI) / 180));
  const tx0 = Math.floor(tileX(center.lon - dLon));
  const tx1 = Math.floor(tileX(center.lon + dLon));
  const ty0 = Math.floor(tileY(center.lat + dLat));
  const ty1 = Math.floor(tileY(center.lat - dLat));
  const jobs: Promise<{ tx: number; ty: number; vt: VectorTile }>[] = [];
  for (let tx = tx0; tx <= tx1; tx++)
    for (let ty = ty0; ty <= ty1; ty++) {
      jobs.push(fetchTile(tx, ty, signal).then((vt) => ({ tx, ty, vt })));
    }
  const tiles = await Promise.all(jobs);

  // ---- vertices -> node ids (tiles share exact integer vertices; edge cuts are matched by position)
  const coords: Pt[] = [];
  const keyToId = new Map<string, number>();
  const nodeId = (p: Pt & { edge?: boolean }): number => {
    const key = p.edge ? `e${Math.round(p.x)},${Math.round(p.y)}` : `${p.x},${p.y}`;
    let id = keyToId.get(key);
    if (id === undefined) {
      id = coords.length;
      coords.push({ x: p.x, y: p.y });
      keyToId.set(key, id);
    }
    return id;
  };

  const lines: RoadLine[] = [];
  const nameSegs: { a: Pt; b: Pt; name: string }[] = [];
  const nameGrid = new SegGrid(64);
  const places: RawPlace[] = [];
  for (const { tx, ty, vt } of tiles) {
    const ox = tx * EXTENT;
    const oy = ty * EXTENT;
    const glob = (line: Pt[]) => line.map((q) => ({ x: q.x + ox, y: q.y + oy }));
    const tr = vt.layers.transportation;
    for (let i = 0; i < (tr?.length ?? 0); i++) {
      const f = tr.feature(i);
      if (f.type !== 2) continue;
      const p = f.properties;
      const type = highwayType(p);
      if (!type) continue;
      const tags: Record<string, string> = { highway: type };
      if (p.oneway === 1) tags.oneway = 'yes';
      else if (p.oneway === -1) tags.oneway = '-1';
      if (p.brunnel === 'bridge') tags.bridge = 'yes';
      if (p.brunnel === 'tunnel') tags.tunnel = 'yes';
      if (p.surface === 'unpaved') tags.surface = 'unpaved';
      if (p.service) tags.service = String(p.service);
      const level = p.brunnel === 'bridge' || p.brunnel === 'tunnel' ? null : String(p.layer ?? 0);
      for (const part of f.loadGeometry()) {
        // each tile keeps only what lies on it, so neighbouring tiles' overlaps don't double up
        for (const piece of clip(glob(part), ox, oy, ox + EXTENT, oy + EXTENT)) {
          const ids = piece.map(nodeId).filter((id, j, arr) => j === 0 || id !== arr[j - 1]);
          if (ids.length > 1) lines.push({ pts: ids, tags, level, names: [] });
        }
      }
    }
    const tn = vt.layers.transportation_name;
    for (let i = 0; i < (tn?.length ?? 0); i++) {
      const f = tn.feature(i);
      const name = (f.properties.name ?? f.properties.ref) as string | undefined;
      if (f.type !== 2 || !name) continue;
      for (const part of f.loadGeometry()) {
        const g = glob(part);
        for (let j = 0; j + 1 < g.length; j++) {
          nameGrid.add(nameSegs.length, g[j], g[j + 1]);
          nameSegs.push({ a: g[j], b: g[j + 1], name });
        }
      }
    }
    const poi = vt.layers.poi;
    for (let i = 0; i < (poi?.length ?? 0); i++) {
      const f = poi.feature(i);
      const p = f.properties;
      if (f.type !== 1) continue;
      const q = f.loadGeometry()[0]?.[0];
      if (!q || q.x < 0 || q.y < 0 || q.x >= EXTENT || q.y >= EXTENT) continue; // owned by the neighbouring tile
      const tags = placeTags(String(p.class ?? ''), String(p.subclass ?? ''), p.name as string | undefined);
      if (!tags) continue;
      const ll = toLatLon(q.x + ox, q.y + oy);
      places.push({ id: `t${q.x + ox},${q.y + oy}`, lat: ll.lat, lon: ll.lon, tags });
    }
  }

  // ---- join road ends that stop on (or right beside) another road: simplification drops the
  // shared vertex where a side street meets a straight road, and edge cuts can land a hair apart
  const segs: { line: number; i: number }[] = [];
  const grid = new SegGrid(32);
  lines.forEach((l, li) => {
    for (let i = 0; i + 1 < l.pts.length; i++) {
      grid.add(segs.length, coords[l.pts[i]], coords[l.pts[i + 1]]);
      segs.push({ line: li, i });
    }
  });
  const degree = new Map<number, number>();
  for (const l of lines) for (let i = 0; i < l.pts.length; i++) degree.set(l.pts[i], (degree.get(l.pts[i]) ?? 0) + (i === 0 || i === l.pts.length - 1 ? 1 : 2));
  const splits = new Map<number, { t: number; id: number }[]>(); // segment index -> nodes to insert
  const remap = new Map<number, number>();
  // a joined end can itself be joined onward later, so follow the chain (bounded, in case of a loop)
  const resolve = (id: number) => {
    for (let i = 0; i < 8 && remap.has(id); i++) id = remap.get(id)!;
    return id;
  };
  for (const l of lines) {
    for (const end of [l.pts[0], l.pts[l.pts.length - 1]]) {
      if (degree.get(end) !== 1 || remap.has(end)) continue;
      const p = coords[end];
      let best: { seg: number; d: number; t: number } | null = null;
      for (const s of grid.near(p, SNAP)) {
        const sg = segs[s];
        const ln = lines[sg.line];
        const a = ln.pts[sg.i];
        const b = ln.pts[sg.i + 1];
        if (a === end || b === end) continue;
        const h = segDist(p, coords[a], coords[b]);
        if (h.d <= SNAP && (!best || h.d < best.d)) best = { seg: s, d: h.d, t: h.t };
      }
      if (!best) continue;
      const sg = segs[best.seg];
      const ln = lines[sg.line];
      // onto an existing vertex, or a new one inserted into that segment
      if (best.t < 0.02 || best.t > 0.98) {
        const v = ln.pts[best.t < 0.5 ? sg.i : sg.i + 1];
        const target = remap.get(v) ?? v; // two loose ends meeting: the second joins the first, not swap places
        if (target !== end) remap.set(end, target);
      } else {
        const list = splits.get(best.seg) ?? [];
        list.push({ t: best.t, id: end });
        splits.set(best.seg, list);
      }
    }
  }
  // roads crossing at the same level without a shared vertex (both straight, so simplification
  // dropped it): they meet at the crossing point
  for (let s = 0; s < segs.length; s++) {
    const sa = segs[s];
    const la = lines[sa.line];
    if (la.level === null) continue;
    const a1 = coords[la.pts[sa.i]];
    const a2 = coords[la.pts[sa.i + 1]];
    const mid = { x: (a1.x + a2.x) / 2, y: (a1.y + a2.y) / 2 };
    for (const o of grid.near(mid, Math.hypot(a2.x - a1.x, a2.y - a1.y) / 2 + 1)) {
      if (o <= s) continue;
      const sb = segs[o];
      const lb = lines[sb.line];
      if (lb.level !== la.level) continue;
      const ids = [la.pts[sa.i], la.pts[sa.i + 1], lb.pts[sb.i], lb.pts[sb.i + 1]];
      if (new Set(ids).size < 4) continue; // already joined
      const b1 = coords[lb.pts[sb.i]];
      const b2 = coords[lb.pts[sb.i + 1]];
      const x = crossing(a1, a2, b1, b2);
      if (!x) continue;
      const id = coords.length;
      coords.push({ x: x.x, y: x.y });
      for (const [seg, t] of [
        [s, x.t],
        [o, x.u],
      ] as const) {
        const list = splits.get(seg) ?? [];
        list.push({ t, id });
        splits.set(seg, list);
      }
    }
  }
  for (const [s, list] of splits) {
    const { line, i } = segs[s];
    const l = lines[line];
    (l as RoadLine & { inserts?: Map<number, number[]> }).inserts ??= new Map();
    (l as RoadLine & { inserts?: Map<number, number[]> }).inserts!.set(i, list.sort((a, b) => a.t - b.t).map((x) => x.id));
  }
  for (const l of lines as (RoadLine & { inserts?: Map<number, number[]> })[]) {
    const pts: number[] = [];
    l.pts.forEach((id, i) => {
      pts.push(resolve(id));
      for (const extra of l.inserts?.get(i) ?? []) pts.push(extra);
    });
    l.pts = pts.filter((id, j) => j === 0 || id !== pts[j - 1]);
  }

  // ---- merge points less than ~half a metre apart: lines often overshoot a junction by a few
  // centimetres, leaving a stub that would read as a dead end
  const parent = new Map<number, number>();
  const find = (id: number): number => {
    let r = id;
    while (parent.has(r)) r = parent.get(r)!;
    if (r !== id) parent.set(id, r);
    return r;
  };
  for (const l of lines)
    for (let i = 0; i + 1 < l.pts.length; i++) {
      const a = find(l.pts[i]);
      const b = find(l.pts[i + 1]);
      if (a !== b && Math.hypot(coords[a].x - coords[b].x, coords[a].y - coords[b].y) < 1.2) parent.set(b, a);
    }
  for (const l of lines) {
    const pts = l.pts.map(find);
    l.pts = pts.filter((id, j) => j === 0 || id !== pts[j - 1]);
  }
  const roadLines = lines.filter((l) => l.pts.length > 1);

  // ---- names: the label line running along each segment
  for (const l of roadLines) {
    for (let i = 0; i + 1 < l.pts.length; i++) {
      const a = coords[l.pts[i]];
      const b = coords[l.pts[i + 1]];
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      let best: { d: number; name: string } | null = null;
      for (const s of nameGrid.near(m, 3)) {
        const ns = nameSegs[s];
        const h = segDist(m, ns.a, ns.b);
        if (h.d > 3) continue;
        const nl = Math.hypot(ns.b.x - ns.a.x, ns.b.y - ns.a.y) || 1;
        const sin = Math.abs((b.x - a.x) * (ns.b.y - ns.a.y) - (b.y - a.y) * (ns.b.x - ns.a.x)) / (len * nl);
        if (sin > 0.35) continue; // crossing, not running along
        if (!best || h.d < best.d) best = { d: h.d, name: ns.name };
      }
      l.names[i] = best?.name;
    }
  }

  // ---- ways: one per stretch with the same name. Roundabouts are not marked: tiles don't say, and
  // guessing from shape mistook one-way loops round buildings for them. Overpass data fills them in.
  const ways: RawWay[] = [];
  let wayId = -1;
  for (const l of roadLines) {
    let start = 0;
    for (let i = 1; i <= l.pts.length - 1; i++) {
      if (i < l.pts.length - 1 && l.names[i] === l.names[start]) continue;
      const tags = { ...l.tags };
      const name = l.names[start];
      if (name) tags.name = name;
      ways.push({ id: wayId--, nodes: l.pts.slice(start, i + 1), tags });
      start = i;
    }
  }

  const nodes = new Map<number, LatLon>();
  for (const w of ways) for (const id of w.nodes) if (!nodes.has(id)) nodes.set(id, toLatLon(coords[id].x, coords[id].y));
  const sw = toLatLon(tx0 * EXTENT, (ty1 + 1) * EXTENT);
  const ne = toLatLon((tx1 + 1) * EXTENT, ty0 * EXTENT);
  return { roads: { nodes, ways, box: [sw.lat, sw.lon, ne.lat, ne.lon] }, places: { places, signals: new Set() } };
}

const SHOP_CLASSES = new Set([
  'shop', 'grocery', 'alcohol_shop', 'bakery', 'butcher', 'clothing_store', 'hardware', 'furniture', 'jewelry', 'music',
  'florist', 'garden_centre', 'mobile_phone', 'laundry', 'optician', 'pet', 'shoe', 'stationery', 'toys', 'books', 'electronics',
  'gift', 'beauty', 'hairdresser', 'car', 'bicycle', 'convenience', 'supermarket', 'department_store', 'deli', 'doityourself',
]);
const LEISURE = new Set(['park', 'garden', 'playground', 'pitch', 'stadium', 'sports_centre', 'swimming_pool', 'dog_park', 'nature_reserve']);
const TOURISM = new Set(['museum', 'art_gallery', 'attraction', 'viewpoint', 'lodging', 'zoo', 'information', 'campsite']);
const SKIP = new Set(['bicycle_parking', 'gate', 'bollard', 'waste_basket', 'telephone', 'post', 'bench', 'motorcycle_parking', 'entrance', 'recycling', 'shelter', 'toilets', 'drinking_water', 'atm', 'vending']);

/** OSM-style tags for a tile POI, in the form the place grouping expects; null to leave it out. */
function placeTags(cls: string, sub: string, name: string | undefined): Record<string, string> | null {
  if (cls === 'bus' && sub === 'bus_stop') return { highway: 'bus_stop', name: name ?? 'Bus stop' };
  if (!name || SKIP.has(cls)) return null;
  if (cls === 'railway' && /station|halt/.test(sub)) return { railway: 'station', name };
  if (SHOP_CLASSES.has(cls)) return { shop: sub || cls, name };
  if (LEISURE.has(cls)) return { leisure: sub || cls, name };
  if (TOURISM.has(cls)) return { tourism: sub === 'artwork' ? 'artwork' : sub || cls, name };
  if (cls === 'monument' || cls === 'castle' || cls === 'memorial') return { historic: sub || cls, name };
  return { amenity: sub || cls, name };
}
