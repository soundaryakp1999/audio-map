import { describe, expect, it } from 'vitest';
import { bearing, pointSeg } from './geo';
import { addCrossings, maneuverText, planRoute, type Maneuver, type Route, type RouteOptions } from './router';
import type { GNode, Segment, Way, World } from './world';

const way = (name: string): Way => ({ id: 1, type: 'residential', name, named: true, bridge: false, tunnel: false, oneway: false, onewayReverse: false, roundabout: false });

// A(0,0) -north-> B(0,100) -east-> C(100,100), plus a spur B -> D(-100,100) so B is a real junction.
// Only the three World members planRoute uses are faked.
function build(): World {
  const oak = way('Oak Street');
  const elm = way('Elm Street');
  const pts: Record<number, [number, number]> = { 1: [0, 0], 2: [0, 100], 3: [100, 100], 4: [-100, 100] };
  const nodes = new Map<number, GNode>();
  for (const [id, [x, y]] of Object.entries(pts)) nodes.set(+id, { id: +id, x, y, edges: [], signals: false });
  const segs: Segment[] = [];
  const link = (a: number, b: number, w: Way) => {
    nodes.get(a)!.edges.push({ to: b, way: w, fwd: true });
    nodes.get(b)!.edges.push({ to: a, way: w, fwd: false });
    segs.push({ ax: pts[a][0], ay: pts[a][1], bx: pts[b][0], by: pts[b][1], a, b, way: w });
  };
  link(1, 2, oak);
  link(2, 3, elm);
  link(2, 4, elm);
  return {
    nodes,
    nearestRoad: (x: number, y: number) => {
      const near = segs.map((seg) => ({ seg, hit: pointSeg(x, y, seg.ax, seg.ay, seg.bx, seg.by), dir: bearing(seg.ax, seg.ay, seg.bx, seg.by) }));
      return near.sort((p, q) => p.hit.dist - q.hit.dist)[0];
    },
    nodesNear: () => [...nodes.values()],
  } as unknown as World;
}

const opts: RouteOptions = { canUse: () => true, obeyOneway: true, costFactor: () => 1, minFactor: 1, uTurnPenalty: 50 };
const start = { x: 0, y: 0, heading: 0 };

describe('planRoute', () => {
  it('finds the L-shaped path and announces a right turn onto Elm Street', () => {
    const r = planRoute(build(), start, { x: 100, y: 100 }, opts)!;
    expect(r.length).toBeCloseTo(200);
    expect(r.partial).toBe(false);
    expect(r.maneuvers).toHaveLength(2);
    const [turn, arrive] = r.maneuvers;
    expect(turn).toMatchObject({ kind: 'turn', onto: 'Elm Street' });
    expect(turn.rel).toBeCloseTo(90);
    expect(turn.d).toBeCloseTo(100);
    expect(arrive.kind).toBe('arrive');
  });
  it('ends partway along a block at the point nearest the destination, not at the far junction', () => {
    const r = planRoute(build(), start, { x: 60, y: 104 }, opts)!; // a door on Elm Street, 60 m along
    expect(r.length).toBeCloseTo(164);
    expect(r.maneuvers.map((m) => m.kind)).toEqual(['turn', 'arrive']);
    expect(r.maneuvers[0]).toMatchObject({ onto: 'Elm Street', d: 100 });
    expect(r.points.at(-2)).toMatchObject({ x: 60, y: 100 });
  });

  it('goes straight along the street when the destination is on the stretch you are on', () => {
    const r = planRoute(build(), start, { x: 0, y: 60 }, opts)!;
    expect(r.length).toBeCloseTo(60);
    expect(r.maneuvers.map((m) => m.kind)).toEqual(['arrive']);
  });

  it('turns left towards the other spur', () => {
    const r = planRoute(build(), start, { x: -100, y: 100 }, opts)!;
    expect(r.maneuvers[0].kind).toBe('turn');
    expect(r.maneuvers[0].rel).toBeCloseTo(-90);
  });
  it('returns null when no road is nearby', () => {
    const w = { ...build(), nearestRoad: () => null } as unknown as World;
    expect(planRoute(w, start, { x: 100, y: 100 }, opts)).toBeNull();
  });
});

describe('addCrossings', () => {
  const m = (d: number, kind: Maneuver['kind'], onto: string, ontoNamed: boolean, rel = 90): Maneuver => ({ x: 0, y: d, d, rel, kind, onto, ontoNamed });
  const route = (): Route => ({
    points: [],
    length: 200,
    partial: false,
    maneuvers: [m(100, 'turn', 'footpath', false, -90), m(120, 'turn', 'path along Mathews Avenue', false), m(200, 'arrive', '', false)],
  });

  it('puts a crossing in order and quietens the unnamed step onto the crosswalk just before it', () => {
    const r = route();
    addCrossings(r, [{ d: 108, x: 0, y: 108, name: 'Mathews Avenue', via: 'at the signals' }]);
    expect(r.maneuvers.map((x) => `${x.kind}:${x.d}`)).toEqual(['turn:100', 'cross:108', 'turn:120', 'arrive:200']);
    expect(r.maneuvers[0].trivial).toBe(true);
    expect(r.maneuvers[2].trivial).toBeUndefined();
    expect(maneuverText(r.maneuvers[1], 'Home')).toBe('cross Mathews Avenue, at the signals');
  });

  it('replaces crossings added before', () => {
    const r = route();
    addCrossings(r, [{ d: 108, x: 0, y: 108, name: 'Mathews Avenue' }]);
    addCrossings(r, [{ d: 150, x: 0, y: 150, name: 'Green Street' }]);
    expect(r.maneuvers.filter((x) => x.kind === 'cross').map((x) => x.onto)).toEqual(['Green Street']);
  });
});
