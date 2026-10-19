// The explorable world: road graph, spatial indexes and named places in local metres.

import { Projection, bearing, dist, pointSeg, relAngle, type LatLon, type SegHit } from './geo';
import type { AccessKind, RawPlaces, RawRoads } from './osm';

export interface Way {
  id: number;
  type: string;
  name: string;
  /** true if the name came from OSM rather than being a generic description */
  named: boolean;
  service?: string;
  surface?: string;
  bridge: boolean;
  tunnel: boolean;
  /** traffic may only travel one way along this road */
  oneway: boolean;
  /** the permitted direction is against the order of the way's nodes (oneway=-1) */
  onewayReverse: boolean;
  /** part of a roundabout's ring */
  roundabout: boolean;
}

export interface Edge {
  to: number;
  way: Way;
  /** true if this edge runs in the order of the way's nodes */
  fwd: boolean;
}

export interface GNode {
  id: number;
  x: number;
  y: number;
  edges: Edge[];
  signals: boolean;
  /** the road goes on here, but beyond the loaded map */
  cut?: boolean;
}

export interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** node ids at each end */
  a: number;
  b: number;
  way: Way;
}

export interface RoadWalk {
  /** the junction (or dead end) reached */
  node: GNode;
  /** distance travelled along the road, metres */
  dist: number;
  /** direction of travel over the last ~15 m into the node, degrees */
  arrival: number;
  deadEnd: boolean;
  /** name of the road we arrive on */
  arriveName: string;
  /** the "dead end" is only where the loaded map stops */
  mapEdge?: boolean;
}

export interface Place {
  id: string;
  name: string;
  category: string;
  /** coarse group used for sound choice */
  group: PlaceGroup;
  x: number;
  y: number;
  /** OSM details that help find the exact spot: stop letters, lines, address */
  info?: PlaceInfo;
  /** doors of a place mapped as a building; aim for these rather than its middle */
  entrances?: Entrance[];
}

export interface PlaceInfo {
  /** stop letter, bay or position at the stop, e.g. "K", "2" or "NW Far Side" */
  localRef?: string;
  /** lines calling here, e.g. "5;12;22" */
  routeRef?: string;
  /** compass direction buses leave in (UK NaPTAN), e.g. "NW" */
  bearing?: string;
  /** the OSM node, for looking up the lines that call here */
  osmNode?: number;
  /** house number and street */
  address?: string;
}

export interface Entrance {
  x: number;
  y: number;
  main: boolean;
  /** its name or reference, e.g. "Exit B" */
  label?: string;
  wheelchair?: string;
}

/** Something to warn about when walking towards it. */
export interface Hazard {
  text: string;
  x: number;
  y: number;
  /** e.g. "audible signal", "island in the middle" */
  extras?: string[];
}

/** Paths for walking or cycling rather than streets. */
export const MINOR = new Set(['footway', 'path', 'steps', 'cycleway', 'track', 'pedestrian', 'bridleway', 'corridor']);

/** Categories of stops and stations, the places X steps through. */
export const TRANSIT = new Set(['bus stop', 'tram stop', 'station', 'bus station', 'station entrance']);

export interface Junction {
  nodes: GNode[];
  exits: { from: GNode; edge: Edge }[];
  signals: boolean;
}

export type PlaceGroup = 'food' | 'shop' | 'transport' | 'culture' | 'nature' | 'health' | 'service' | 'other';

export interface RoadHit {
  seg: Segment;
  hit: SegHit;
  /** direction of the segment, a→b, degrees */
  dir: number;
}

class Grid<T> {
  private cells = new Map<string, T[]>();
  constructor(private readonly size: number) {}

  private key(cx: number, cy: number) {
    return `${cx},${cy}`;
  }

  insertBox(item: T, minX: number, minY: number, maxX: number, maxY: number) {
    const s = this.size;
    for (let cx = Math.floor(minX / s); cx <= Math.floor(maxX / s); cx++) {
      for (let cy = Math.floor(minY / s); cy <= Math.floor(maxY / s); cy++) {
        const k = this.key(cx, cy);
        let arr = this.cells.get(k);
        if (!arr) this.cells.set(k, (arr = []));
        arr.push(item);
      }
    }
  }

  query(x: number, y: number, r: number): Set<T> {
    const out = new Set<T>();
    const s = this.size;
    for (let cx = Math.floor((x - r) / s); cx <= Math.floor((x + r) / s); cx++) {
      for (let cy = Math.floor((y - r) / s); cy <= Math.floor((y + r) / s); cy++) {
        const arr = this.cells.get(this.key(cx, cy));
        if (arr) for (const it of arr) out.add(it);
      }
    }
    return out;
  }
}

const TYPE_NAMES: Record<string, string> = {
  footway: 'footpath',
  path: 'path',
  pedestrian: 'pedestrian street',
  steps: 'steps',
  cycleway: 'cycle path',
  track: 'track',
  service: 'service road',
  motorway: 'motorway',
  motorway_link: 'motorway ramp',
  trunk_link: 'slip road',
  primary_link: 'slip road',
  secondary_link: 'slip road',
  tertiary_link: 'slip road',
};

export function humanize(v: string): string {
  return v.replace(/_/g, ' ').replace(/;/g, ', ');
}

function groupFor(tags: Record<string, string>): { category: string; group: PlaceGroup } {
  const a = tags.amenity;
  if (tags.highway === 'bus_stop') return { category: 'bus stop', group: 'transport' };
  if (tags.railway === 'tram_stop') return { category: 'tram stop', group: 'transport' };
  if (tags.railway === 'subway_entrance' || tags.railway === 'train_station_entrance') return { category: 'station entrance', group: 'transport' };
  if (tags.railway === 'platform') return { category: 'platform', group: 'transport' };
  if (tags.railway === 'station' || tags.public_transport === 'station') return { category: 'station', group: 'transport' };
  if (a) {
    if (['restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'ice_cream', 'food_court', 'biergarten'].includes(a))
      return { category: humanize(a), group: 'food' };
    if (['hospital', 'clinic', 'pharmacy', 'doctors', 'dentist', 'veterinary'].includes(a))
      return { category: humanize(a), group: 'health' };
    if (['bus_station', 'parking', 'fuel', 'taxi', 'bicycle_rental', 'ferry_terminal', 'charging_station'].includes(a))
      return { category: humanize(a), group: 'transport' };
    if (['theatre', 'cinema', 'library', 'arts_centre', 'place_of_worship', 'community_centre', 'museum'].includes(a))
      return { category: humanize(a), group: 'culture' };
    if (a === 'fountain') return { category: 'fountain', group: 'nature' };
    return { category: humanize(a), group: 'service' };
  }
  if (tags.shop) return { category: tags.shop === 'yes' ? 'shop' : `${humanize(tags.shop)} shop`, group: 'shop' };
  if (tags.tourism) {
    const t = tags.tourism;
    return { category: humanize(t), group: ['museum', 'gallery', 'artwork', 'attraction', 'viewpoint'].includes(t) ? 'culture' : 'service' };
  }
  if (tags.leisure) {
    const l = tags.leisure;
    return { category: humanize(l), group: ['park', 'garden', 'nature_reserve', 'playground', 'dog_park'].includes(l) ? 'nature' : 'other' };
  }
  if (tags.historic) return { category: `historic ${humanize(tags.historic)}`, group: 'culture' };
  return { category: 'place', group: 'other' };
}


function placeInfo(id: string, t: Record<string, string>): PlaceInfo | undefined {
  const info: PlaceInfo = {};
  const indicator = /^stop\s+(\S+)$/i.exec(t['naptan:Indicator'] ?? '')?.[1];
  const entrance = t.railway === 'subway_entrance' || t.railway === 'train_station_entrance';
  const localRef = t.local_ref ?? indicator ?? (entrance ? t.ref : undefined);
  if (localRef) info.localRef = localRef;
  if (t.route_ref) info.routeRef = t.route_ref;
  if (t['naptan:Bearing']) info.bearing = t['naptan:Bearing'];
  if (t.highway === 'bus_stop' || t.railway === 'tram_stop') {
    const n = /^n(\d+)$/.exec(id);
    if (n) info.osmNode = Number(n[1]);
  }
  if (t['addr:housenumber'] && t['addr:street']) info.address = `${t['addr:housenumber']} ${t['addr:street']}`;
  return Object.keys(info).length ? info : undefined;
}

export class World {
  readonly nodes = new Map<number, GNode>();
  readonly ways: Way[] = [];
  readonly places: Place[] = [];
  readonly facilities: { kind: string; x: number; y: number }[] = [];
  readonly access: { kind: AccessKind; name?: string; x: number; y: number }[] = [];
  private segGrid = new Grid<Segment>(60);
  private nodeGrid = new Grid<GNode>(80);
  private placeGrid = new Grid<Place>(100);
  private hazardGrid = new Grid<Hazard>(50);
  /** the loaded area in local metres, if known */
  private bounds: { minX: number; minY: number; maxX: number; maxY: number } | null = null;

  constructor(readonly proj: Projection, raw: RawRoads) {
    if (raw.box) {
      const [s, w, n, e] = raw.box;
      const sw = proj.toXY(s, w);
      const ne = proj.toXY(n, e);
      this.bounds = { minX: sw.x, minY: sw.y, maxX: ne.x, maxY: ne.y };
    }
    for (const rw of raw.ways) {
      const t = rw.tags;
      const type = t.highway;
      const nm = t.name ?? t.ref;
      const roundabout = t.junction === 'roundabout' || t.junction === 'circular';
      const way: Way = {
        id: rw.id,
        type,
        name: nm ?? (roundabout ? 'roundabout' : TYPE_NAMES[type] ?? 'unnamed road'),
        named: !!nm,
        service: t.service,
        surface: t.surface,
        bridge: !!t.bridge && t.bridge !== 'no',
        tunnel: !!t.tunnel && t.tunnel !== 'no',
        oneway: t.oneway === 'yes' || t.oneway === '1' || t.oneway === '-1' || (t.junction === 'roundabout' && t.oneway !== 'no'),
        onewayReverse: t.oneway === '-1',
        roundabout,
      };
      this.ways.push(way);

      let prev: GNode | null = null;
      for (const nid of rw.nodes) {
        const ll = raw.nodes.get(nid);
        if (!ll) {
          if (prev) prev.cut = true; // the way carries on outside the loaded area
          prev = null;
          continue;
        }
        let n = this.nodes.get(nid);
        if (!n) {
          const p = proj.toXY(ll.lat, ll.lon);
          n = { id: nid, x: p.x, y: p.y, edges: [], signals: false };
          this.nodes.set(nid, n);
          this.nodeGrid.insertBox(n, n.x, n.y, n.x, n.y);
        }
        if (!prev && rw.nodes[0] !== nid) n.cut = true; // the way came in from outside the loaded area
        if (prev && prev !== n) {
          prev.edges.push({ to: n.id, way, fwd: true });
          n.edges.push({ to: prev.id, way, fwd: false });
          const seg: Segment = { ax: prev.x, ay: prev.y, bx: n.x, by: n.y, a: prev.id, b: n.id, way };
          this.segGrid.insertBox(
            seg,
            Math.min(seg.ax, seg.bx),
            Math.min(seg.ay, seg.by),
            Math.max(seg.ax, seg.bx),
            Math.max(seg.ay, seg.by),
          );
        }
        prev = n;
      }
      if (type === 'steps') for (const nid of [rw.nodes[0], rw.nodes[rw.nodes.length - 1]]) this.addHazard('Steps', raw.nodes.get(nid));
    }
  }

  private addHazard(text: string, ll?: LatLon, extras?: string[]) {
    if (!ll) return;
    const p = this.proj.toXY(ll.lat, ll.lon);
    // crossings are often mapped on each side of the road
    for (const h of this.hazardGrid.query(p.x, p.y, 12)) {
      if (h.text !== text || dist(h.x, h.y, p.x, p.y) >= 12) continue;
      if (extras?.length && !h.extras?.length) h.extras = extras; // keep the better-described one
      return;
    }
    const h: Hazard = { text, x: p.x, y: p.y, extras: extras?.length ? extras : undefined };
    this.hazardGrid.insertBox(h, p.x, p.y, p.x, p.y);
  }

  hazardsNear(x: number, y: number, r: number): { hazard: Hazard; d: number }[] {
    const out: { hazard: Hazard; d: number }[] = [];
    for (const h of this.hazardGrid.query(x, y, r)) {
      const d = dist(x, y, h.x, h.y);
      if (d <= r) out.push({ hazard: h, d });
    }
    return out.sort((a, b) => a.d - b.d);
  }

  /** Places arrive separately from roads so travel can start sooner. */
  addPlaces(raw: RawPlaces) {
    // Signals are often mapped on each approach a few metres before the junction node.
    for (const id of raw.signals) {
      const n = this.nodes.get(id);
      if (!n) continue;
      n.signals = true;
      for (const m of this.nodesNear(n.x, n.y, 30)) if (m.edges.length >= 3) m.signals = true;
    }
    for (const c of raw.crossings ?? []) this.addHazard(c.text, c, c.extras);
    for (const u of raw.unlit ?? []) this.addHazard('Unlit path', u);
    const proj = this.proj;
    for (const f of raw.facilities ?? []) this.facilities.push({ kind: f.kind, ...proj.toXY(f.lat, f.lon) });
    for (const a of raw.access ?? []) this.access.push({ kind: a.kind, name: a.name, ...proj.toXY(a.lat, a.lon) });
    const seen = new Set<string>();
    for (const rp of raw.places) {
      const key = `${rp.tags.name}|${rp.lat.toFixed(4)}|${rp.lon.toFixed(4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const p = proj.toXY(rp.lat, rp.lon);
      const { category, group } = groupFor(rp.tags);
      const place: Place = { id: rp.id, name: rp.tags.name ?? 'Station entrance', category, group, x: p.x, y: p.y };
      const info = placeInfo(rp.id, rp.tags);
      if (info) place.info = info;
      if (rp.entrances?.length) {
        place.entrances = rp.entrances.map((e) => {
          const q = proj.toXY(e.lat, e.lon);
          const label = e.tags.name ?? (e.tags.ref ? `entrance ${e.tags.ref}` : undefined);
          return { x: q.x, y: q.y, main: e.tags.entrance === 'main', label, wheelchair: e.tags.wheelchair };
        });
      }
      this.places.push(place);
      this.placeGrid.insertBox(place, p.x, p.y, p.x, p.y);
    }
    // an unnamed entrance takes the name of the station it leads to
    for (const p of this.places) {
      if (p.category !== 'station entrance' || p.name !== 'Station entrance') continue;
      const st = this.placesNear(p.x, p.y, 300).find((n) => n.place.category === 'station');
      if (st) p.name = st.place.name;
    }
  }

  get isEmpty(): boolean {
    return this.ways.length === 0;
  }

  /** Nearest road segment within maxDist. Named roads win close ties so sidewalks don't hide the street. */
  nearestRoad(x: number, y: number, maxDist: number, filter?: (w: Way) => boolean): RoadHit | null {
    let best: RoadHit | null = null;
    let bestScore = Infinity;
    for (const seg of this.segGrid.query(x, y, maxDist)) {
      if (filter && !filter(seg.way)) continue;
      const hit = pointSeg(x, y, seg.ax, seg.ay, seg.bx, seg.by);
      if (hit.dist > maxDist) continue;
      const score = hit.dist - (seg.way.named ? 4 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = { seg, hit, dir: bearing(seg.ax, seg.ay, seg.bx, seg.by) };
      }
    }
    return best;
  }

  /**
   * The road you are on and facing: of the roads within a few metres of the nearest, the one that
   * runs closest to your heading. At a junction, that is the road you have turned to face.
   */
  roadFacing(x: number, y: number, maxDist: number, heading: number, filter?: (w: Way) => boolean): RoadHit | null {
    const near = this.nearestRoad(x, y, maxDist, filter);
    if (!near) return null;
    let best = near;
    let bestScore = Infinity;
    for (const seg of this.segGrid.query(x, y, near.hit.dist + 3)) {
      if (filter && !filter(seg.way)) continue;
      const hit = pointSeg(x, y, seg.ax, seg.ay, seg.bx, seg.by);
      if (hit.dist > near.hit.dist + 3) continue;
      const dir = bearing(seg.ax, seg.ay, seg.bx, seg.by);
      const off = Math.abs(relAngle(heading, dir));
      const score = Math.min(off, 180 - off) + hit.dist * 8;
      if (score < bestScore) {
        bestScore = score;
        best = { seg, hit, dir };
      }
    }
    return best;
  }

  /** Nearest road within maxDist that runs within tol degrees of dir (in either direction along it). */
  nearestRoadAlong(x: number, y: number, maxDist: number, dir: number, tol: number, filter?: (w: Way) => boolean): RoadHit | null {
    let best: RoadHit | null = null;
    for (const seg of this.segGrid.query(x, y, maxDist)) {
      if (filter && !filter(seg.way)) continue;
      const sd = bearing(seg.ax, seg.ay, seg.bx, seg.by);
      const a = Math.abs(relAngle(dir, sd));
      if (a > tol && a < 180 - tol) continue;
      const hit = pointSeg(x, y, seg.ax, seg.ay, seg.bx, seg.by);
      if (hit.dist <= maxDist && (!best || hit.dist < best.hit.dist)) best = { seg, hit, dir: sd };
    }
    return best;
  }

  /**
   * The named streets (not footpaths) that the line a–b cuts across: where, how far along it (t,
   * 0..1), and which street. Touching at an end does not count.
   */
  streetsCrossed(ax: number, ay: number, bx: number, by: number): { x: number; y: number; t: number; name: string; type: string }[] {
    const out: { x: number; y: number; t: number; name: string; type: string }[] = [];
    const rx = bx - ax;
    const ry = by - ay;
    const half = Math.hypot(rx, ry) / 2;
    for (const s of this.segGrid.query(ax + rx / 2, ay + ry / 2, half + 1)) {
      if (!s.way.named || MINOR.has(s.way.type) || s.way.type === 'service') continue; // not paths, driveways or car parks
      const sx = s.bx - s.ax;
      const sy = s.by - s.ay;
      const den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-9) continue; // parallel: walking along it, not across
      const t = ((s.ax - ax) * sy - (s.ay - ay) * sx) / den;
      const u = ((s.ax - ax) * ry - (s.ay - ay) * rx) / den;
      if (t <= 0.001 || t >= 0.999 || u < 0 || u > 1) continue;
      out.push({ x: ax + t * rx, y: ay + t * ry, t, name: s.way.name, type: s.way.type });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  nodesNear(x: number, y: number, r: number): GNode[] {
    const out: GNode[] = [];
    for (const n of this.nodeGrid.query(x, y, r)) if (dist(x, y, n.x, n.y) <= r) out.push(n);
    return out;
  }

  placesNear(x: number, y: number, r: number): { place: Place; d: number }[] {
    const out: { place: Place; d: number }[] = [];
    for (const p of this.placeGrid.query(x, y, r)) {
      const d = dist(x, y, p.x, p.y);
      if (d <= r) out.push({ place: p, d });
    }
    out.sort((a, b) => a.d - b.d);
    return out;
  }

  /** Edges at a node that matter for the given filter (deduplicated by direction). */
  relevantEdges(n: GNode, filter: (w: Way) => boolean): Edge[] {
    return n.edges.filter((e) => filter(e.way));
  }

  isIntersection(n: GNode, filter: (w: Way) => boolean): boolean {
    return this.relevantEdges(n, filter).length >= 3;
  }

  /**
   * Group intersection nodes that form one junction (dual carriageways, complex crossings)
   * and list the roads leaving it.
   */
  junction(seed: GNode, filter: (w: Way) => boolean, radius: number): Junction {
    const members = new Map<number, GNode>([[seed.id, seed]]);
    const queue = [seed];
    while (queue.length) {
      const n = queue.pop()!;
      for (const e of n.edges) {
        if (!filter(e.way) || members.has(e.to)) continue;
        const m = this.nodes.get(e.to)!;
        if (dist(seed.x, seed.y, m.x, m.y) > radius) continue;
        members.set(m.id, m);
        queue.push(m);
      }
    }
    const exits: { from: GNode; edge: Edge }[] = [];
    let signals = false;
    for (const n of members.values()) {
      signals ||= n.signals;
      for (const e of n.edges) if (filter(e.way) && !members.has(e.to)) exits.push({ from: n, edge: e });
    }
    return { nodes: [...members.values()], exits, signals };
  }

  /**
   * Follow the road from prev→cur until a node where isStop() holds, or the road ends.
   * At forks that are not stops it keeps to the same street name and the straightest continuation.
   */
  followRoad(
    prev: GNode,
    cur: GNode,
    startDist: number,
    name: string,
    canUse: (w: Way) => boolean,
    isStop: (n: GNode) => boolean,
    maxDist: number,
  ): RoadWalk | null {
    const trail: GNode[] = [prev];
    let d = startDist;
    let arriveName = name;
    for (let guard = 0; guard < 5000 && d <= maxDist; guard++) {
      trail.push(cur);
      if (isStop(cur)) return { node: cur, dist: d, arrival: arrivalBearing(trail), deadEnd: false, arriveName };
      const best = this.continuation(prev, cur, name, canUse);
      if (!best) return { node: cur, dist: d, arrival: arrivalBearing(trail), deadEnd: true, arriveName, mapEdge: this.atMapEdge(cur) };
      d += dist(cur.x, cur.y, best.node.x, best.node.y);
      arriveName = best.way.name;
      prev = cur;
      cur = best.node;
    }
    return null;
  }

  /** The way on from prev→cur: same street name first, then the straightest. */
  private continuation(prev: GNode, cur: GNode, name: string, canUse: (w: Way) => boolean): { node: GNode; way: Way } | null {
    const heading = bearing(prev.x, prev.y, cur.x, cur.y);
    let best: { node: GNode; way: Way } | null = null;
    let bestScore = Infinity;
    for (const e of cur.edges) {
      if (e.to === prev.id || !canUse(e.way)) continue;
      const nn = this.nodes.get(e.to)!;
      const turn = Math.abs(relAngle(heading, bearing(cur.x, cur.y, nn.x, nn.y)));
      const score = turn + (e.way.name === name ? 0 : 45);
      if (score < bestScore) {
        bestScore = score;
        best = { node: nn, way: e.way };
      }
    }
    return best;
  }

  /**
   * The line of the road ahead, starting at (x, y) on segment prev→cur, as far as maxDist or the
   * first node where isStop() holds (included). d is the distance along the road from (x, y).
   * deadEnd: the road ended before either.
   */
  roadLine(
    x: number,
    y: number,
    prev: GNode,
    cur: GNode,
    name: string,
    canUse: (w: Way) => boolean,
    isStop: (n: GNode) => boolean,
    maxDist: number,
  ): { pts: { x: number; y: number; d: number }[]; stopped: boolean; deadEnd: boolean; mapEdge?: boolean } {
    const pts = [{ x, y, d: 0 }];
    let d = 0;
    for (let guard = 0; guard < 2000; guard++) {
      const last = pts[pts.length - 1];
      d += dist(last.x, last.y, cur.x, cur.y);
      pts.push({ x: cur.x, y: cur.y, d });
      if (isStop(cur)) return { pts, stopped: true, deadEnd: false };
      if (d >= maxDist) break;
      const next = this.continuation(prev, cur, name, canUse);
      if (!next) return { pts, stopped: false, deadEnd: true, mapEdge: this.atMapEdge(cur) };
      prev = cur;
      cur = next.node;
    }
    return { pts, stopped: false, deadEnd: false };
  }

  /** Does the road only seem to end here because the loaded map stops (or is about to)? */
  atMapEdge(n: GNode): boolean {
    if (n.cut) return true;
    const b = this.bounds;
    if (!b) return false;
    const margin = 30;
    return n.x < b.minX + margin || n.x > b.maxX - margin || n.y < b.minY + margin || n.y > b.maxY - margin;
  }

  /** Is this node on a roundabout's ring? */
  onRing(n: GNode): boolean {
    return n.edges.some((e) => e.way.roundabout);
  }

  /** The ring through n, in the direction traffic flows, starting at n. Closed tells whether it came back round. */
  ring(n: GNode): { nodes: GNode[]; closed: boolean } {
    const nodes = [n];
    const seen = new Set([n.id]);
    let cur = n;
    for (let guard = 0; guard < 500; guard++) {
      const e = cur.edges.find((x) => x.way.roundabout && (x.way.oneway ? x.fwd !== x.way.onewayReverse : x.fwd));
      if (!e) break;
      if (e.to === n.id) return { nodes, closed: true };
      if (seen.has(e.to)) break;
      cur = this.nodes.get(e.to)!;
      seen.add(cur.id);
      nodes.push(cur);
    }
    return { nodes, closed: false };
  }

  /**
   * Exits from a roundabout, in the order you reach them going round from the entry node (the
   * entry node's own exits, i.e. back the way you came, last). Paths and driveways are not counted,
   * nor roads that only lead in.
   */
  ringExits(entry: GNode, canUse: (w: Way) => boolean): { nodes: GNode[]; exits: { node: GNode; edge: Edge }[]; clockwise: boolean } {
    const { nodes, closed } = this.ring(entry);
    const order = closed ? [...nodes.slice(1), nodes[0]] : nodes.slice(1);
    const exits: { node: GNode; edge: Edge }[] = [];
    for (const n of order) for (const e of n.edges) if (isRingExit(e, canUse)) exits.push({ node: n, edge: e });
    // shoelace: positive area = anticlockwise (x east, y north)
    let area = 0;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const b = nodes[(i + 1) % nodes.length];
      area += a.x * b.y - b.x * a.y;
    }
    return { nodes, exits, clockwise: area < 0 };
  }

  /** Bearing leaving node n along edge e, measured over ~15 m so short kinks don't mislead. */
  edgeBearing(n: GNode, e: Edge): number {
    let from = n;
    let cur = this.nodes.get(e.to)!;
    let travelled = dist(from.x, from.y, cur.x, cur.y);
    // follow the same way through degree-2 nodes until far enough
    while (travelled < 15) {
      const next = cur.edges.find((x) => x.way === e.way && x.to !== from.id);
      if (!next || cur.edges.length > 2) break;
      const nn = this.nodes.get(next.to)!;
      travelled += dist(cur.x, cur.y, nn.x, nn.y);
      from = cur;
      cur = nn;
    }
    return bearing(n.x, n.y, cur.x, cur.y);
  }
}

/** A road leaving a roundabout that counts as one of its exits. */
export function isRingExit(e: Edge, canUse: (w: Way) => boolean): boolean {
  const w = e.way;
  if (w.roundabout || !canUse(w) || MINOR.has(w.type)) return false;
  if (w.type === 'service' && !w.named) return false;
  return !w.oneway || e.fwd !== w.onewayReverse; // a one-way road into the roundabout is not an exit
}

/** Direction of travel over roughly the last 15 m of a path. */
function arrivalBearing(trail: GNode[]): number {
  const end = trail[trail.length - 1];
  let back = 0;
  for (let i = trail.length - 2; i >= 0; i--) {
    back += dist(trail[i].x, trail[i].y, trail[i + 1].x, trail[i + 1].y);
    if (back >= 15 || i === 0) return bearing(trail[i].x, trail[i].y, end.x, end.y);
  }
  return 0;
}
