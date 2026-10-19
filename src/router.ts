// Turn-by-turn routing on the loaded road graph (A*), and turning the path into manoeuvres.

import { bearing, dist, relAngle } from './geo';
import { isRingExit, type GNode, type Way, type World } from './world';

export interface RoutePoint {
  x: number;
  y: number;
  /** distance along the route, metres */
  d: number;
}

export interface Maneuver {
  x: number;
  y: number;
  d: number;
  /** turn angle, degrees: negative left, positive right */
  rel: number;
  kind: 'continue' | 'bear' | 'turn' | 'sharp' | 'u-turn' | 'roundabout' | 'arrive' | 'cross';
  /** for a crossing: how it is controlled, e.g. "at the signals, audible signal" */
  via?: string;
  /** for a crossing: metres from the kerb to the street's centre line, where d is measured */
  kerb?: number;
  onto: string;
  ontoNamed: boolean;
  /** roundabout exit number */
  exit?: number;
  /** for unnamed paths: a point on them and their direction, so the street they run beside can be named later */
  nameAt?: { x: number; y: number };
  nameDir?: number;
  /** the road before the manoeuvre: its name if named, else a point and direction on it */
  fromName?: string;
  fromAt?: { x: number; y: number };
  fromDir?: number;
  /** cached: just moving between a street and its own sidewalk (not announced) */
  trivial?: boolean;
}

export interface Route {
  points: RoutePoint[];
  maneuvers: Maneuver[];
  length: number;
  /** the destination is beyond the loaded map; the route stops at the closest reachable point */
  partial: boolean;
}

export interface RouteOptions {
  canUse: (w: Way) => boolean;
  obeyOneway: boolean;
  /** cost per metre on this road relative to distance (lower = preferred) */
  costFactor: (w: Way) => number;
  /** smallest value costFactor can return (keeps the A* estimate admissible) */
  minFactor: number;
  /** extra cost, in metres, for setting off in the opposite direction to the current heading */
  uTurnPenalty: number;
}

const MAX_EXPANSIONS = 300_000;
/** Search key for the goal itself, a point on a street rather than a node of the graph. */
const GOAL = Number.MIN_SAFE_INTEGER;

export function planRoute(
  w: World,
  from: { x: number; y: number; heading: number },
  to: { x: number; y: number; radius?: number },
  o: RouteOptions,
): Route | null {
  const hit = w.nearestRoad(from.x, from.y, 60, o.canUse);
  if (!hit) return null;

  const allowed = (wy: Way, fwd: boolean) => !o.obeyOneway || !wy.oneway || fwd !== wy.onewayReverse;

  // goal: the point on a usable street closest to the target, reached from either end of its
  // segment. Ending at the nearest node instead could run on past a door partway along a block
  // to the next junction, and come back.
  const near = w.nearestRoad(to.x, to.y, 300, o.canUse);
  let foot: { x: number; y: number; way: Way | null };
  /** nodes the goal is reached from, with the cost of the last stretch */
  const entries = new Map<number, number>();
  if (near) {
    foot = { x: near.hit.px, y: near.hit.py, way: near.seg.way };
    const cf = o.costFactor(near.seg.way);
    for (const [id, fwd] of [
      [near.seg.a, true],
      [near.seg.b, false],
    ] as const) {
      const n = w.nodes.get(id);
      if (n && allowed(near.seg.way, fwd)) entries.set(id, dist(n.x, n.y, foot.x, foot.y) * cf);
    }
  } else {
    // no street near the target: the usable node closest to it
    let best: GNode | null = null;
    let bestD = Infinity;
    for (const n of w.nodes.values()) {
      if (!n.edges.some((e) => o.canUse(e.way))) continue;
      const d = dist(n.x, n.y, to.x, to.y);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    if (!best) return null;
    foot = { x: best.x, y: best.y, way: null };
    entries.set(best.id, 0);
  }
  const estimate = (x: number, y: number) => dist(x, y, foot.x, foot.y) * o.minFactor;

  // start on both ends of the current segment, penalising the one behind us
  const g = new Map<number, number>();
  const prev = new Map<number, number>();
  const via = new Map<number, Way>();
  const heap = new MinHeap();
  const seg = hit.seg;
  const forwards = Math.abs(relAngle(from.heading, hit.dir)) <= 90;
  for (const [id, alongWay] of [
    [seg.b, true],
    [seg.a, false],
  ] as const) {
    if (!allowed(seg.way, alongWay)) continue;
    const n = w.nodes.get(id)!;
    const behind = alongWay !== forwards;
    const cost = dist(hit.hit.px, hit.hit.py, n.x, n.y) * o.costFactor(seg.way) + (behind ? o.uTurnPenalty : 0);
    if (cost < (g.get(id) ?? Infinity)) {
      g.set(id, cost);
      via.set(id, seg.way);
      heap.push(cost + estimate(n.x, n.y), id);
    }
  }
  // already on the goal's own stretch of street: straight along it, if that way is allowed
  if (near && near.seg.a === seg.a && near.seg.b === seg.b) {
    const alongWay = near.hit.t >= hit.hit.t;
    if (allowed(seg.way, alongWay)) {
      const cost = dist(hit.hit.px, hit.hit.py, foot.x, foot.y) * o.costFactor(seg.way) + (alongWay !== forwards ? o.uTurnPenalty : 0);
      g.set(GOAL, cost);
      heap.push(cost, GOAL);
    }
  }

  // if the goal can't be reached (isolated road, one-way trap), fall back to the closest reachable node
  const closed = new Set<number>();
  let reached = false;
  let closest: GNode | null = null;
  let closestD = Infinity;
  for (let i = 0; i < MAX_EXPANSIONS && heap.size; i++) {
    const id = heap.pop()!;
    if (closed.has(id)) continue;
    closed.add(id);
    if (id === GOAL) {
      reached = true;
      break;
    }
    const n = w.nodes.get(id)!;
    const dn = dist(n.x, n.y, to.x, to.y);
    if (dn < closestD) {
      closestD = dn;
      closest = n;
    }
    const gn = g.get(id)!;
    const last = entries.get(id);
    if (last !== undefined && gn + last < (g.get(GOAL) ?? Infinity)) {
      g.set(GOAL, gn + last);
      prev.set(GOAL, id);
      heap.push(gn + last, GOAL);
    }
    for (const e of n.edges) {
      if (!o.canUse(e.way) || !allowed(e.way, e.fwd) || closed.has(e.to)) continue;
      const m = w.nodes.get(e.to)!;
      const cost = gn + dist(n.x, n.y, m.x, m.y) * o.costFactor(e.way);
      if (cost < (g.get(e.to) ?? Infinity)) {
        g.set(e.to, cost);
        prev.set(e.to, id);
        via.set(e.to, e.way);
        heap.push(cost + estimate(m.x, m.y), e.to);
      }
    }
  }
  const end = reached ? (prev.has(GOAL) ? w.nodes.get(prev.get(GOAL)!)! : null) : closest;
  if (!reached && !end) return null;
  const endPt = reached ? foot : end!;
  const endD = dist(endPt.x, endPt.y, to.x, to.y);
  const partial = endD > Math.max(150, (to.radius ?? 0) + 100);

  const path: GNode[] = [];
  for (let id: number | undefined = end?.id; id !== undefined; id = prev.get(id)) path.push(w.nodes.get(id)!);
  path.reverse();

  const points: RoutePoint[] = [{ x: hit.hit.px, y: hit.hit.py, d: 0 }];
  const ways: (Way | null)[] = [null];
  const push = (x: number, y: number, way: Way | null) => {
    const last = points[points.length - 1];
    points.push({ x, y, d: last.d + dist(last.x, last.y, x, y) });
    ways.push(way);
  };
  for (const n of path) push(n.x, n.y, via.get(n.id) ?? null);
  // along the goal's street to the point nearest the target (unless that is the node itself)
  const lastPt = points[points.length - 1];
  if (reached && foot.way && dist(lastPt.x, lastPt.y, foot.x, foot.y) > 0.5) push(foot.x, foot.y, foot.way);
  if (!partial && endD > 3) push(to.x, to.y, null); // last stretch to the door

  return { points, maneuvers: maneuvers(path, points, ways, o), length: points[points.length - 1].d, partial };
}

/** Bearing of the route around point i, measured over ~15 m behind (dir -1) or ahead (dir +1). */
function routeBearing(points: RoutePoint[], i: number, dir: -1 | 1): number {
  const p = points[i];
  let j = i;
  while (j + dir >= 0 && j + dir < points.length) {
    j += dir;
    if (Math.abs(points[j].d - p.d) >= 15) break;
  }
  const q = points[j];
  return dir < 0 ? bearing(q.x, q.y, p.x, p.y) : bearing(p.x, p.y, q.x, q.y);
}

/** A U-turn only when doubling back along the same road; other very sharp turns are "sharp". */
function classify(rel: number, sameRoad: boolean): Maneuver['kind'] {
  const a = Math.abs(rel);
  if (a < 25) return 'continue';
  if (a < 60) return 'bear';
  if (a < 135) return 'turn';
  if (a < 170 || !sameRoad) return 'sharp';
  return 'u-turn';
}

function maneuvers(path: GNode[], points: RoutePoint[], ways: (Way | null)[], o: RouteOptions): Maneuver[] {
  const out: (Maneuver & { inName: string; kStart: number })[] = [];
  // points[k] is path[k - 1]; ways[k] is the road used to reach points[k]
  // up to the path's last node too: the route may turn there onto the destination's own street
  for (let k = 1; k <= path.length; k++) {
    const node = path[k - 1];
    const inWay = ways[k];
    const outWay = ways[k + 1];
    if (!inWay || !outWay) continue;
    if (outWay.roundabout && !inWay.roundabout) {
      // entering a roundabout: one instruction, counting the exits passed on the way round
      let exits = 0;
      let kx = k + 1;
      for (; kx < path.length && ways[kx + 1]?.roundabout; kx++) {
        exits += path[kx - 1].edges.filter((e) => isRingExit(e, o.canUse)).length;
      }
      const exitWay = ways[kx + 1];
      if (exitWay) {
        const rel = relAngle(routeBearing(points, k, -1), routeBearing(points, kx, 1));
        const p = points[k];
        out.push({ x: p.x, y: p.y, d: p.d, rel, kind: 'roundabout', exit: exits + 1, onto: exitWay.name, ontoNamed: exitWay.named, inName: inWay.name, kStart: k });
        k = kx; // carry on from the exit
        continue;
      }
    }
    if (inWay.roundabout && outWay.roundabout) continue; // going round
    const rel = relAngle(routeBearing(points, k, -1), routeBearing(points, k, 1));
    const choice = node.edges.filter((e) => o.canUse(e.way)).length >= 3;
    if (!choice && Math.abs(rel) < 60) continue; // the road just curves
    const p = points[k];
    let m = { x: p.x, y: p.y, d: p.d, rel, kind: classify(rel, inWay === outWay), onto: outWay.name, ontoNamed: outWay.named, inName: inWay.name, kStart: k };
    // turn points close together (crossing a divided road, a crosswalk node beside the junction):
    // one manoeuvre, measured once from before the first point to after the last. Adding the two
    // angles would count the same turn twice, since each is measured over a 15 m window.
    const last = out[out.length - 1];
    if (last && last.kind !== 'roundabout' && m.d - last.d < 15) {
      out.pop();
      const r = relAngle(routeBearing(points, last.kStart, -1), routeBearing(points, k, 1));
      m = { ...m, rel: r, kind: classify(r, false), inName: last.inName, kStart: last.kStart };
    }
    // going straight on is only worth saying at a junction where the street name changes
    if (m.kind === 'continue' && (!choice || !m.ontoNamed || m.onto === m.inName)) continue;
    out.push(m);
  }
  const end = points[points.length - 1];
  const res: Maneuver[] = out.map(({ inName: _i, kStart: _k, ...m }) => m);
  res.push({ x: end.x, y: end.y, d: end.d, rel: 0, kind: 'arrive', onto: '', ontoNamed: false });
  return res;
}

/** Spoken form: "turn left onto Oak Street", "bear right onto the footpath", "make a U-turn". */
export function maneuverText(m: Maneuver, destName: string): string {
  const side = m.rel < 0 ? 'left' : 'right';
  if (m.kind === 'cross') return `cross ${m.onto}${m.via ? `, ${m.via}` : ''}`;
  if (m.kind === 'arrive') return `arrive at ${destName}${Math.abs(m.rel) >= 25 ? `, on your ${side}` : ''}`;
  if (m.kind === 'u-turn') return 'make a U-turn';
  const onto = m.ontoNamed ? m.onto : `the ${m.onto}`;
  if (m.kind === 'roundabout') {
    const a = Math.abs(m.rel);
    const way = a < 30 ? 'straight on' : a >= 150 ? 'back the way you came' : `to the ${side}`;
    return `at the roundabout, take the ${ordinal(m.exit ?? 1)} exit, ${way}, onto ${onto}`;
  }
  if (m.kind === 'continue') return `continue onto ${onto}`;
  const verb = m.kind === 'bear' ? 'bear' : m.kind === 'sharp' ? 'turn sharp' : 'turn';
  return `${verb} ${side} onto ${onto}`;
}

/** A place where a walking route crosses a named street, at distance d along it. */
export interface StreetCrossing {
  d: number;
  x: number;
  y: number;
  name: string;
  via?: string;
  /** metres from the kerb to the centre line */
  kerb?: number;
}

/**
 * Put "cross <street>" steps into a walking route where it crosses a street, so a turn on the far
 * side is announced only once across ("cross Mathews Avenue, then turn right"), not as a bare
 * "turn right" from the near side. Routers fold a straight-on crosswalk into the walk along the
 * street, and give a crosswalk taken with a turn as "turn onto the footpath": that unnamed step
 * just before a crossing is quietened in favour of it. Replaces crossings added before.
 */
export function addCrossings(r: Route, crossings: StreetCrossing[]) {
  const kept = r.maneuvers.filter((m) => m.kind !== 'cross');
  for (const c of crossings) {
    for (const m of kept) {
      if (m.kind === 'arrive' || m.kind === 'roundabout' || m.ontoNamed) continue;
      if (m.d <= c.d && c.d - m.d <= 15) m.trivial = true; // the step onto the crosswalk itself
    }
    kept.push({ x: c.x, y: c.y, d: c.d, rel: 0, kind: 'cross', onto: c.name, ontoNamed: true, via: c.via, kerb: c.kerb, trivial: false });
  }
  r.maneuvers = kept.sort((a, b) => a.d - b.d);
}

export function ordinal(n: number): string {
  return ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'][n - 1] ?? `number ${n}`;
}

/** Point at distance d along the route. */
export function pointAlong(r: Route, d: number): { x: number; y: number } {
  const pts = r.points;
  if (d <= 0) return pts[0];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].d >= d) {
      const a = pts[i - 1];
      const b = pts[i];
      const t = b.d > a.d ? (d - a.d) / (b.d - a.d) : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
  }
  return pts[pts.length - 1];
}

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size() {
    return this.keys.length;
  }

  push(key: number, val: number) {
    const k = this.keys;
    const v = this.vals;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }

  pop(): number | undefined {
    const k = this.keys;
    const v = this.vals;
    if (!k.length) return undefined;
    const top = v[0];
    const lk = k.pop()!;
    const lv = v.pop()!;
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}
