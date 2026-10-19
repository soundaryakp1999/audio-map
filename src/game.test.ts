import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Game, corridorSpots, crossingAdvice, minutesText, paceScale } from './game';
import { loadNotes, saveNotes } from './notes';
import { Projection } from './geo';
import { loadSettings } from './settings';
import { World, type Place } from './world';
import { fetchCountry, fetchNamedAreas, fetchPlaces, fetchRoads, fetchRoadsBox, fetchStopRoutes, reverseGeocode } from './osm';
import { fetchTileArea } from './tiles';
import type { RawPlaces, RawRoads } from './osm';

vi.mock('./onlineRouter', () => ({ hasOnlineRouting: () => false, fetchOnlineRoute: vi.fn() }));
vi.mock('./osm', async (orig) => ({ ...(await orig<typeof import('./osm')>()), fetchRoads: vi.fn(), fetchPlaces: vi.fn(), fetchRoadsBox: vi.fn(), reverseGeocode: vi.fn(), fetchStopRoutes: vi.fn(), fetchNamedAreas: vi.fn(), fetchCountry: vi.fn(async () => null) }));
vi.mock('./tiles', () => ({ fetchTileArea: vi.fn() }));
vi.stubGlobal('requestAnimationFrame', () => 0);

const memory = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
});

vi.stubGlobal('window', { dispatchEvent: () => true });

const proj = new Projection({ lat: 51, lon: 0 });
const ll = (x: number, y: number) => proj.toLatLon(x, y);

// Oak Street runs north from (0,0) to (0,400); Elm Street crosses it at (0,200). A cafe sits beside Oak at (20,100).
function rawRoads(): RawRoads {
  const pts: [number, number, number][] = [[1, 0, 0], [2, 0, 200], [3, 0, 400], [4, -200, 200], [5, 200, 200]];
  const nodes = new Map(pts.map(([id, x, y]) => [id, ll(x, y)]));
  return {
    nodes,
    ways: [
      { id: 10, nodes: [1, 2, 3], tags: { highway: 'residential', name: 'Oak Street' } },
      { id: 11, nodes: [4, 2, 5], tags: { highway: 'residential', name: 'Elm Street' } },
    ],
  };
}

function buildWorld(): World {
  const world = new World(proj, rawRoads());
  const cafe = ll(20, 100);
  const places: RawPlaces = { places: [{ id: 'n1', lat: cafe.lat, lon: cafe.lon, tags: { amenity: 'cafe', name: 'Blue Cafe' } }], signals: new Set() };
  world.addPlaces(places);
  return world;
}

interface Harness {
  game: Game;
  said: string[];
  g: any; // private state is poked directly: Game has no injection seams
}

function setup(vehicle: 'walker' | 'car' = 'walker'): Harness {
  const said: string[] = [];
  const speech = { say: (t: string) => void said.push(t), stop() {}, review() {}, configure() {}, onSpeakingChange: undefined };
  const quiet = new Proxy({}, { get: (_t, p) => (p === 'now' ? 0 : p === 'ctx' ? { suspend: async () => {} } : () => {}) });
  const settings = { ...loadSettings(), vehicle, announcePlaces: true, roadAssist: false, units: 'metric' as const };
  const game = new Game(settings, speech as any, quiet as any, quiet as any);
  const g = game as any;
  g.proj = proj;
  g.world = buildWorld();
  g.x = 0;
  g.y = 50;
  g.heading = 0;
  return { game, said, g };
}

beforeEach(() => {
  memory.clear();
  vi.mocked(fetchRoads).mockReset().mockImplementation(async () => rawRoads());
  vi.mocked(fetchPlaces).mockReset().mockResolvedValue({ places: [], signals: new Set<number>() });
  vi.mocked(reverseGeocode).mockReset().mockResolvedValue('Testville');
  vi.mocked(fetchTileArea).mockReset().mockRejectedValue(new Error('no tiles'));
  vi.mocked(fetchStopRoutes).mockReset().mockResolvedValue([]);
  vi.mocked(fetchNamedAreas).mockReset().mockResolvedValue([]);
});

describe('commands', () => {
  it('names the rebound key in the no-destination hint', () => {
    const { game, said, g } = setup();
    g.settings.keyBindings = { navigate: { key: 'k', ctrl: true } };
    game.run('i');
    expect(said.at(-1)).toBe('No destination. Press Control K to choose one.');
  });

  it('H reports compass heading', () => {
    const { game, said, g } = setup();
    g.heading = 90;
    game.run('h');
    expect(said.at(-1)).toBe('Facing east, 90 degrees.');
  });

  it('S says stopped, then the speed', () => {
    const { game, said, g } = setup();
    game.run('s');
    expect(said.at(-1)).toBe('Stopped.');
    g.speed = 5;
    game.run('s');
    expect(said.at(-1)).not.toBe('Stopped.');
  });

  it('toggles road assist and place announcements, and persists them', () => {
    const { game, said, g } = setup();
    game.run('a');
    expect(g.settings.roadAssist).toBe(true);
    expect(said.at(-1)).toBe('Road assist on.');
    game.run('p');
    expect(said.at(-1)).toBe('Place announcements off.');
    expect(JSON.parse(memory.get([...memory.keys()][0])!).announcePlaces).toBe(false);
  });

  it('number keys switch vehicle', () => {
    const { game, g } = setup();
    game.run('3');
    expect(g.vehicle.id).toBe('car');
  });

  it('refuses commands before a map is loaded', () => {
    const { game, said, g } = setup();
    g.world = null;
    game.run('h');
    expect(said.at(-1)).toMatch(/No map loaded|Still loading/);
  });

  it('PageUp / PageDown clamp volume to 0..1', () => {
    const { game, g } = setup();
    g.settings.volume = 0.95;
    game.run('PageUp');
    expect(g.settings.volume).toBe(1);
    g.settings.volume = 0.05;
    game.run('PageDown');
    game.run('PageDown');
    expect(g.settings.volume).toBe(0);
  });
});

describe('movement', () => {
  it('moves north when facing north and accelerating', () => {
    const { g } = setup();
    g.input.isDown = (c: string) => c === 'ArrowUp';
    for (let i = 0; i < 120; i++) g.step(1 / 60);
    expect(g.speed).toBeGreaterThan(0);
    expect(g.y).toBeGreaterThan(50);
    expect(Math.abs(g.x)).toBeLessThan(0.01);
  });

  it('never exceeds the vehicle top speed', () => {
    const { g } = setup('car');
    g.input.isDown = (c: string) => c === 'ArrowUp';
    for (let i = 0; i < 60 * 60; i++) g.step(1 / 60);
    expect(g.speed).toBeLessThanOrEqual(g.vehicle.maxSpeed);
  });

  it('turn wraps heading into 0..360', () => {
    const { g } = setup();
    g.turn(-10);
    expect(g.heading).toBeCloseTo(350);
    g.turn(20);
    expect(g.heading).toBeCloseTo(10);
  });
});

describe('road awareness', () => {
  it('names the street being walked along', () => {
    const { g } = setup();
    g.updateRoad(true);
    expect(g.onRoad).toBe(true);
    expect(g.road.name).toBe('Oak Street');
  });

  it('goes off road far from any street', () => {
    const { g } = setup();
    g.x = 500;
    g.updateRoad(true);
    expect(g.onRoad).toBe(false);
  });

  it('announces a nearby place once, not again within the repeat window', () => {
    const { g, said } = setup();
    g.y = 90; // inside the walker's pass radius
    g.speed = 1.3;
    g.clock = 10;
    g.checkPlaces();
    expect(said.filter((s) => s.startsWith('Blue Cafe'))).toHaveLength(1);
    g.clock = 20;
    g.checkPlaces();
    expect(said.filter((s) => s.startsWith('Blue Cafe'))).toHaveLength(1);
  });

  it('stays quiet about places when announcements are off or stopped', () => {
    const { g, said } = setup();
    g.y = 90;
    g.speed = 0;
    g.clock = 10;
    g.checkPlaces();
    g.speed = 1.3;
    g.settings.announcePlaces = false;
    g.checkPlaces();
    expect(said).toHaveLength(0);
  });
});

describe('destination', () => {
  it('setTarget speaks distance and direction', () => {
    const { g, said } = setup();
    g.settings.turnByTurn = false;
    g.setTarget({ name: 'Blue Cafe', x: 20, y: 100 });
    expect(said.at(-1)).toMatch(/^Destination Blue Cafe, .* at \d+ o'clock\. Follow the beacon\.$/);
    expect(g.dest.name).toBe('Blue Cafe');
  });

  it('refuses a destination you are already standing at', () => {
    const { g, said } = setup();
    g.setTarget({ name: 'Here', x: 0, y: 50 });
    expect(said.at(-1)).toBe('You are already at Here.');
    expect(g.dest).toBeNull();
  });

  it('D with no destination says so; with one, reports straight-line distance', () => {
    const { game, g, said } = setup();
    game.run('d');
    expect(said.at(-1)).toMatch(/No destination/);
    g.settings.turnByTurn = false;
    g.setTarget({ name: 'Elm', x: 0, y: 200 });
    g.lastDPress = -Infinity;
    g.clock = 1;
    game.run('d');
    expect(said.at(-1)).toMatch(/^Elm: .* in a straight line, north\.$/);
  });

  it('Backspace clears the destination', () => {
    const { game, g } = setup();
    g.settings.turnByTurn = false;
    g.setTarget({ name: 'Elm', x: 0, y: 200 });
    game.run('Backspace');
    expect(g.dest).toBeNull();
  });
});

describe('places', () => {
  it('findPlaces matches by name or category, nearest first, empty for blank query', () => {
    const { game } = setup();
    expect(game.findPlaces('blue')).toHaveLength(1);
    expect(game.findPlaces('cafe')[0].name).toBe('Blue Cafe');
    expect(game.findPlaces('zzz')).toEqual([]);
    expect(game.findPlaces('  ')).toEqual([]);
  });

  it('Tab browses nearby places and Enter sets one as destination', () => {
    const { game, g, said } = setup();
    g.settings.turnByTurn = false;
    game.run('Tab', {});
    expect(said.at(-1)).toMatch(/^Blue Cafe, cafe, .* 1 of 1$/);
    game.run('Enter');
    expect(g.dest.name).toBe('Blue Cafe');
  });

  it('Enter without browsing prompts for Tab', () => {
    const { game, said } = setup();
    game.run('Enter');
    expect(said.at(-1)).toBe('Press Tab to choose a place first.');
  });
});

describe('notes', () => {
  it('addNote saves, announces when near, and Shift+V deletes it', () => {
    const { game, g, said } = setup();
    game.addNote('loose paving');
    expect(g.notes).toHaveLength(1);
    g.clock = 5;
    g.checkNotes();
    expect(said.at(-1)).toBe('Note: loose paving');
    game.run('v', { shift: true });
    expect(said.at(-1)).toBe('Note deleted.');
    expect(g.notes).toHaveLength(0);
  });

  it('Shift+V deletes the right note after another tab added one', () => {
    const { game } = setup();
    game.addNote('here');
    saveNotes([{ text: 'elsewhere', lat: 10, lon: 10 }, ...loadNotes()]);
    game.run('v', { shift: true });
    expect(loadNotes().map((n) => n.text)).toEqual(['elsewhere']);
  });

  it('Shift+V far from any note reports none', () => {
    const { game, said } = setup();
    game.run('v', { shift: true });
    expect(said.at(-1)).toBe('No note within 25 metres.');
  });
});

describe('E where am I', () => {
  it('speaks the full text with the area once the lookup returns', async () => {
    const { game, said } = setup();
    game.run('e');
    await vi.waitFor(() => expect(said.length).toBe(1));
    expect(said[0]).toContain('Testville');
    expect(said[0]).toContain('Nearest landmark: Blue Cafe');
  });

  it('still speaks the full text after 2.5 s when the lookup hangs', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(reverseGeocode).mockReturnValue(new Promise(() => {}));
      const { game, said } = setup();
      game.run('e');
      await vi.advanceTimersByTimeAsync(2499);
      expect(said).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(said.length).toBe(1);
      expect(said[0]).toContain('Nearest landmark: Blue Cafe');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('position helpers', () => {
  it('position and toXY round-trip', () => {
    const { game, g } = setup();
    g.x = 30;
    g.y = 70;
    const p = game.toXY(game.position!);
    expect(p.x).toBeCloseTo(30, 1);
    expect(p.y).toBeCloseTo(70, 1);
  });

  it('describeFromHere gives distance and compass point', () => {
    const { game } = setup();
    const p = ll(0, 250); // 200 m north of the start at y=50
    expect(game.describeFromHere(p.lat, p.lon)).toBe('200 metres north');
  });

  it('currentTrip is null without a destination', () => {
    expect(setup().game.currentTrip()).toBeNull();
  });
});

describe('turn-by-turn', () => {
  const route = (dest: { name: string; x: number; y: number }) => {
    const h = setup();
    h.g.settings.turnByTurn = true;
    h.g.setTarget(dest);
    return h;
  };

  it('plans a route on the loaded map and announces it', () => {
    const { g, said } = route({ name: 'Far End', x: 0, y: 380 });
    expect(g.route).not.toBeNull();
    expect(g.route.length).toBeGreaterThan(300);
    // straight along Oak Street through the Elm Street intersection: crossing Elm comes first
    expect(said.at(-1)).toMatch(/^Route .*In 150 metres, cross Elm Street/);
  });

  it('says a crossing on the approach with what follows, and the signals there', () => {
    const { g, said } = route({ name: 'Far End', x: 0, y: 380 });
    g.world.addPlaces({ signals: new Set(), places: [], crossings: [{ ...ll(0, 205), text: 'Crossing with signals', extras: ['audible signal'] }] });
    g.markCrossings();
    const cross = g.route.maneuvers.find((m: { kind: string }) => m.kind === 'cross');
    expect(cross).toMatchObject({ onto: 'Elm Street', via: 'at the signals, audible signal' });
    g.y = cross.y - 24; // walking north up Oak Street toward Elm
    g.updateRoute();
    expect(said.at(-1)).toBe('In 25 metres, cross Elm Street, at the signals, audible signal.');
    const n = said.length;
    g.y = cross.y - 10; // closer: not said again
    g.updateRoute();
    expect(said.length).toBe(n);
  });

  it('does not count turning onto a street as crossing it', () => {
    const { g } = route({ name: 'East End', x: 190, y: 200 });
    expect(g.route.maneuvers.some((m: { kind: string }) => m.kind === 'cross')).toBe(false);
  });

  it('announces a right turn onto Elm Street', () => {
    const { said } = route({ name: 'East End', x: 190, y: 200 });
    expect(said.at(-1)).toMatch(/right/i);
    expect(said.at(-1)).toMatch(/Elm Street/);
  });

  it('says the destination is too far to plan offline beyond the corridor limit', () => {
    const { g, said } = route({ name: 'Faraway', x: 0, y: 9000 });
    expect(g.route).toBeNull();
    expect(said.at(-1)).toMatch(/too far to plan offline/);
  });

  it('loads a corridor for a distant destination, then plans a partial route as far as the streets go', async () => {
    vi.mocked(fetchRoadsBox).mockResolvedValue({ ...rawRoads(), box: undefined });
    const { g, said } = route({ name: 'Island', x: 3000, y: 3000 });
    expect(said.at(-1)).toMatch(/^Loading the streets toward the destination/);
    await vi.waitFor(() => expect(g.route).not.toBeNull());
    expect(g.route.partial).toBe(true);
    expect(said.at(-1)).toMatch(/as far as the map has loaded/);
  });

  it('turn by turn off clears the route; helicopter never gets one', () => {
    const { game, g, said } = route({ name: 'Far End', x: 0, y: 380 });
    game.run('t');
    expect(g.route).toBeNull();
    expect(said.at(-1)).toMatch(/^Turn by turn off/);
    g.setVehicle('helicopter', false);
    game.run('t');
    expect(said.at(-1)).toMatch(/not available in the helicopter/);
  });

  it('re-plans after being off the route for a few seconds', () => {
    const { g, said } = route({ name: 'Far End', x: 0, y: 380 });
    g.x = 120;
    g.clock = 100;
    g.updateRoute();
    expect(said.at(-1)).not.toBe('Off route. Recalculating.');
    g.clock = 104;
    g.updateRoute();
    expect(said).toContain('Off route. Recalculating.');
  });

  it('warns when travelling back along the route', () => {
    const { g, said } = route({ name: 'Far End', x: 0, y: 380 });
    g.speed = 1.3;
    g.y = 300;
    g.updateRoute();
    g.y = 200;
    g.clock = 50;
    g.updateRoute();
    expect(said.at(-1)).toBe('Wrong way. Turn around.');
  });

  it('arriving clears destination and route and summarises the trip', () => {
    const { g, said } = route({ name: 'Far End', x: 0, y: 380 });
    g.y = 375;
    g.updateDestination();
    expect(said.at(-1)).toMatch(/^Arrived at Far End\./);
    expect(g.dest).toBeNull();
    expect(g.route).toBeNull();
    expect(g.lastTrip).toMatch(/^Last trip to Far End/);
  });

  it('speaks distance milestones on the way', () => {
    const { g, said } = route({ name: 'Far End', x: 0, y: 380 });
    g.y = 250;
    g.updateRoute();
    g.updateDestination();
    expect(said.some((t) => /^Far End, .* to go\.$/.test(t))).toBe(true);
  });
});

describe('start / load', () => {
  it('loads the map, snaps onto the nearest road and says ready', async () => {
    const { game, g, said } = setup();
    g.world = null;
    await game.start({ lat: 51, lon: 0 }, 'Testville');
    expect(said[0]).toBe('Loading map data for Testville. Please wait.');
    expect(g.world).not.toBeNull();
    expect(g.streetName).toBe('Oak Street');
    expect(said.at(-1)).toMatch(/^Ready\. .*On Oak Street, facing .*Testville\..* 2 roads/);
    game.pause();
  });

  it('reports failure when roads and tiles both fail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fetchRoads).mockRejectedValue(new Error('busy'));
    const { game, g, said } = setup();
    g.world = null;
    await game.start({ lat: 51, lon: 0 });
    expect(g.world).toBeNull();
    expect(said.at(-1)).toMatch(/^Could not load map data/);
    expect(g.nextLoadTry).toBeGreaterThan(g.clock);
    game.pause();
  });

  it('says so when the area has no roads', async () => {
    vi.mocked(fetchRoads).mockResolvedValue({ nodes: new Map(), ways: [] });
    const { game, g, said } = setup();
    g.world = null;
    await game.start({ lat: 51, lon: 0 });
    expect(said.some((t) => t.startsWith('No roads found here'))).toBe(true);
    game.pause();
  });

  it('start clears the previous destination and route', async () => {
    const { game, g } = setup();
    g.setTarget({ name: 'Elm', x: 0, y: 200 });
    await game.start({ lat: 51, lon: 0 });
    expect(g.dest).toBeNull();
    expect(g.route).toBeNull();
    game.pause();
  });
});

describe('roundabouts', () => {
  // Ring of radius 25 about the origin, one-way clockwise, with a road leaving north and another south.
  function ringWorld(): World {
    const R = 25;
    const ring = Array.from({ length: 8 }, (_, i) => {
      const a = (i * Math.PI) / 4;
      return [100 + i, Math.sin(a) * R, Math.cos(a) * R] as [number, number, number];
    });
    const nodes = new Map<number, { lat: number; lon: number }>(ring.map(([id, x, y]) => [id, ll(x, y)]));
    nodes.set(1, ll(0, 200));
    nodes.set(2, ll(0, -200));
    return new World(proj, {
      nodes,
      ways: [
        { id: 20, nodes: [...ring.map(([id]) => id), 100], tags: { highway: 'residential', junction: 'roundabout' } },
        { id: 21, nodes: [100, 1], tags: { highway: 'residential', name: 'North Road' } },
        { id: 22, nodes: [104, 2], tags: { highway: 'residential', name: 'South Road' } },
      ],
    });
  }

  it('enters ring state on the roundabout and leaves it after moving away', () => {
    const { g } = setup('car');
    g.world = ringWorld();
    g.x = 25;
    g.y = 0;
    g.heading = 180;
    g.speed = 5;
    g.updateRoad(true);
    g.updateRing();
    expect(g.ring).not.toBeNull();
    expect(g.ring.exits.length).toBeGreaterThan(0);
    g.x = 0;
    g.y = 150;
    g.updateRoad(true);
    for (let i = 0; i < 400; i++) {
      g.clock += 1 / 60;
      g.updateRing();
    }
    expect(g.ring).toBeNull();
  });

  it('keeps the ring through a brief swerve off it', () => {
    const { g } = setup('car');
    g.world = ringWorld();
    g.x = 25;
    g.y = 0;
    g.heading = 180;
    g.speed = 5;
    g.updateRoad(true);
    g.updateRing();
    g.x = 0;
    g.y = 150;
    g.updateRoad(true);
    for (let i = 0; i < 3; i++) {
      g.clock += 1 / 60;
      g.updateRing();
    }
    expect(g.ring).not.toBeNull();
  });
});

describe('grid mode', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  function gridSetup() {
    const h = setup();
    const at = vi.fn(async () => ({ key: 'park1', kind: 'park', name: 'Oak Park', sound: 'green' }));
    h.g.areas = { at, has: () => true };
    h.g.loadCenter = { x: 0, y: 0 };
    return { ...h, at };
  }

  it('F3 turns it on and says what is here; F3 again turns it off', async () => {
    const { game, said, g } = gridSetup();
    game.run('F3');
    await flush();
    expect(g.grid).not.toBeNull();
    expect(said.at(-1)).toMatch(/^Grid mode, up is north\. .*Oak Street\.$/);
    game.run('F3');
    expect(g.grid).toBeNull();
    expect(said.at(-1)).toMatch(/^Grid mode off/);
  });

  it('arrows step by compass direction, whatever the heading', async () => {
    const { game, g } = gridSetup();
    g.heading = 90;
    game.run('F3');
    game.run('ArrowUp');
    expect(g.x).toBeCloseTo(0);
    expect(g.y).toBeCloseTo(60);
    game.run('ArrowRight');
    expect(g.x).toBeCloseTo(10);
    game.run('ArrowDown');
    game.run('ArrowLeft');
    expect(g.x).toBeCloseTo(0);
    expect(g.y).toBeCloseTo(50);
    expect(g.speed).toBe(0);
  });

  it('speaks where you are on every step, even in the same area; Space repeats it', async () => {
    const { game, said, g } = gridSetup();
    game.run('F3');
    await flush();
    game.run('ArrowRight'); // off Oak Street into the park
    await flush();
    expect(said.at(-1)).toBe('Oak Park.');
    const n = said.length;
    game.run('ArrowRight'); // still in the park
    await flush();
    expect(said.length).toBe(n + 1);
    expect(said.at(-1)).toBe('Oak Park.');
    game.run(' ');
    await flush();
    expect(said.at(-1)).toBe('Oak Park.');
    expect(g.grid.key).toBe('park1');
  });

  it('parks the vehicle: its engine sound stops in grid mode and starts again after', () => {
    const { game, g } = gridSetup();
    const engine: boolean[] = [];
    g.audio = new Proxy({}, { get: (_t, p) => (p === 'setEngine' ? (on: boolean) => engine.push(on) : p === 'now' ? 0 : () => {}) });
    game.run('3'); // car
    game.run('F3');
    game.run('F3');
    expect(engine).toEqual([false, true]);
  });

  it('stays north-up whatever moves you, and R says so', () => {
    const { game, said, g } = gridSetup();
    game.run('F3');
    g.jump(1); // N twice: along Oak Street to Elm Street
    expect(g.y).toBeGreaterThan(150);
    expect(g.heading).toBe(0);
    game.run('ArrowRight');
    game.run('r');
    expect(said.at(-1)).toBe('Grid mode always faces north. F3 leaves it.');
    expect(g.heading).toBe(0);
  });

  it('leaving on a road faces along it, the way nearest north', () => {
    const { game, said, g } = gridSetup();
    g.heading = 180;
    game.run('F3');
    game.run('F3');
    expect(g.heading).toBe(0);
    expect(said.at(-1)).toBe('Grid mode off. On Oak Street, facing north.');
  });

  it('counts grid steps in the trip distance', () => {
    const { game, g } = gridSetup();
    game.setTarget({ name: 'Far', x: 2000, y: 2000 });
    game.run('F3');
    game.run('=');
    game.run('ArrowRight');
    expect(g.trip.meters).toBe(100);
  });

  it('keeps facing north, so the beacon is a compass: east of you stays on the right', () => {
    const { game, g } = gridSetup();
    const rels: number[] = [];
    g.audio = new Proxy({}, { get: (_t, p) => (p === 'beacon' ? (rel: number) => rels.push(rel) : p === 'now' ? 0 : () => {}) });
    game.setTarget({ name: 'East Point', x: 300, y: 50 });
    game.run('F3');
    for (const key of ['ArrowDown', 'ArrowLeft', 'ArrowUp']) {
      game.run(key);
      expect(g.heading).toBe(0);
      g.nextBeacon = 0;
      g.updateDestination();
    }
    // from (−10, 50) the destination is due east of the last step
    expect(rels.at(-1)).toBeCloseTo(90, 0);
    expect(rels.every((r) => r > 60 && r < 120)).toBe(true);
  });

  it('minus and equals change the step between 1 and 1000', () => {
    const { game, said, g } = gridSetup();
    game.run('F3');
    game.run('=');
    expect(said.at(-1)).toBe('Step 100 metres.');
    game.run('=');
    game.run('=');
    expect(said.at(-1)).toBe('Largest step, 1000 metres.');
    for (let i = 0; i < 4; i++) game.run('-');
    expect(said.at(-1)).toBe('Smallest step, 1 metre.');
    game.run('ArrowUp');
    expect(g.y).toBeCloseTo(51);
  });

  it('uses yards with imperial units', () => {
    const { game, said, g } = gridSetup();
    g.settings.units = 'imperial';
    game.run('F3');
    game.run('=');
    expect(said.at(-1)).toBe('Step 100 yards.');
    game.run('ArrowUp');
    expect(g.y).toBeCloseTo(50 + 91.44);
  });

  it('cannot start while live GPS is on', () => {
    const { game, said, g } = gridSetup();
    g.live = {};
    game.run('F3');
    expect(g.grid).toBeNull();
    expect(said.at(-1)).toMatch(/Live GPS is on/);
  });
});

describe('stops, entrances and crossings', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const at = (x: number, y: number) => ll(x, y);
  const destSaid = (said: string[]) => [...said].reverse().find((t) => t.startsWith('Destination'));
  // Oak Street runs north at x = 0 and Elm Street east at y = 200 (see rawRoads)
  function withStops() {
    const h = setup();
    const p = (id: string, x: number, y: number, tags: Record<string, string>) => ({ id, ...at(x, y), tags });
    h.g.world.addPlaces({
      signals: new Set(),
      places: [
        p('n101', -8, 192, { highway: 'bus_stop', name: 'Oak & Elm' }),
        p('n102', 30, 200, { highway: 'bus_stop', name: 'Elm Street Stop' }),
        p('n103', 8, 215, { highway: 'bus_stop', name: 'Oak & Elm', local_ref: 'K' }),
      ],
    });
    return h;
  }

  it('X keeps the stops of one intersection together and says which corner', () => {
    const { game, said, g } = withStops();
    game.run('x');
    expect(g.dest.placeId).toBe('n101');
    expect(destSaid(said)).toMatch(/^Destination Oak & Elm, south-west corner of (Oak Street and Elm Street|Elm Street and Oak Street), buses probably head/);
    game.run('x');
    expect(g.dest.placeId).toBe('n103'); // the other Oak & Elm stop, though Elm Street Stop is nearer
    expect(destSaid(said)).toMatch(/north-east corner .*stop K/);
    game.run('x');
    expect(g.dest.placeId).toBe('n102');
  });

  it('looks up the lines at a chosen stop and repeats them with G', async () => {
    vi.mocked(fetchStopRoutes).mockResolvedValue([{ ref: '5E', to: 'Lincoln Square' }]);
    const { game, said } = withStops();
    game.run('x');
    await flush();
    expect(fetchStopRoutes).toHaveBeenCalledWith(101);
    expect(said).toContain('Lines here: 5E to Lincoln Square.');
    game.run('g');
    expect(said.at(-1)).toMatch(/Lines here: 5E to Lincoln Square\.$/);
  });

  it('guides to the main door of a place mapped as a building', () => {
    const { game, said, g } = setup();
    g.world.addPlaces({
      signals: new Set(),
      places: [
        {
          id: 'w9',
          ...at(40, 100),
          tags: { amenity: 'library', name: 'Oak Library' },
          entrances: [
            { ...at(60, 110), tags: { entrance: 'yes' } },
            { ...at(10, 100), tags: { entrance: 'main', wheelchair: 'yes' } },
          ],
        },
      ],
    });
    const lib = g.world.places.find((p: Place) => p.name === 'Oak Library');
    game.setTarget(g.targetFor(lib));
    expect(g.dest.x).toBeCloseTo(10, 0);
    expect(destSaid(said)).toMatch(/^Destination Oak Library, main entrance on Oak Street, wheelchair accessible,/);
  });

  it('names the street a crossing goes over and what it offers', () => {
    const { said, g } = setup();
    g.world.addPlaces({ signals: new Set(), places: [], crossings: [{ ...at(0, 180), text: 'Crossing with signals', extras: ['audible signal', 'push button'] }] });
    g.y = 160;
    g.speed = 1;
    g.checkHazards();
    expect(said.at(-1)).toBe('Crossing with signals ahead, 20 metres, over Oak Street, south of Elm Street. Audible signal, push button');
  });
});

describe('minutesText', () => {
  it('pluralises hours and minutes and drops zero minutes', () => {
    expect([1, 59, 60, 61, 120, 121, 181].map(minutesText)).toEqual(['1 minute', '59 minutes', '1 hour', '1 hour 1 minute', '2 hours', '2 hours 1 minute', '3 hours 1 minute']);
  });
});

describe('hold (touch and voice)', () => {
  it('announces the speed change when a held brake lets go', () => {
    const { game, said, g } = setup();
    g.speed = 5;
    game.hold('Slash', true);
    g.speed = 0;
    game.hold('Slash', false);
    expect(said.at(-1)).toBe('Stopped.');
  });
});

describe('grid mode and destinations', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  // Oak Street runs north at x = 0, Elm Street east at y = 200; the destination is on Elm, east of Oak
  async function routed() {
    const h = setup();
    h.g.areas = { at: vi.fn(async () => ({ key: 'open', kind: 'open ground', sound: 'open' })), has: () => true };
    h.g.loadCenter = { x: 0, y: 0 };
    h.game.setTarget({ name: 'Elm End', x: 150, y: 200 });
    await flush();
    h.game.run('F3');
    await flush();
    return h;
  }

  it('N finds the nearest intersection in grid terms; twice steps onto it', async () => {
    const { game, said, g } = await routed();
    game.run('n');
    expect(said.at(-1)).toBe('Oak Street and Elm Street, 150 metres north. Press N twice to step onto it.');
    g.lastNPress = performance.now(); // as if pressed a moment ago
    game.run('n');
    await flush();
    expect(g.y).toBeCloseTo(200);
    expect(g.heading).toBe(0);
    expect(said.at(-1)).toMatch(/^Oak Street and Elm Street\./);
  });

  it('N looks the way the last arrow went, Shift N the other way', async () => {
    const { game, said, g } = await routed();
    // Oak Street (x = 0) crossed by Pine Street (y = -150) and Elm Street (y = 200); Ash Street at x = 300
    const pts: [number, number, number][] = [
      [1, 0, -300], [2, 0, -150], [3, 0, 200], [4, 0, 400],
      [5, -200, 200], [6, 300, 200], [7, -200, -150], [8, 300, -150], [9, 300, -300], [10, 300, 400],
    ];
    g.world = new World(proj, {
      nodes: new Map(pts.map(([id, x, y]) => [id, ll(x, y)])),
      ways: [
        { id: 1, nodes: [1, 2, 3, 4], tags: { highway: 'residential', name: 'Oak Street' } },
        { id: 2, nodes: [5, 3, 6], tags: { highway: 'residential', name: 'Elm Street' } },
        { id: 3, nodes: [7, 2, 8], tags: { highway: 'residential', name: 'Pine Street' } },
        { id: 4, nodes: [9, 8, 6, 10], tags: { highway: 'residential', name: 'Ash Street' } },
      ],
    });
    g.x = 0;
    g.y = 50;
    game.run('n'); // no arrow yet: nearest of all
    expect(said.at(-1)).toBe('Oak Street and Elm Street, 150 metres north. Press N twice to step onto it.');
    game.run('ArrowRight');
    g.lastNPress = -Infinity;
    game.run('n');
    expect(said.at(-1)).toBe('East: Elm Street and Ash Street, 150 metres north and 290 metres east. Press N twice to step onto it.');
    g.lastNPress = -Infinity;
    game.run('ArrowUp');
    game.run('n');
    expect(said.at(-1)).toMatch(/^North: Oak Street and Elm Street, 140 metres north and 10 metres west\./);
    g.lastNPress = -Infinity;
    game.run('N', { shift: true });
    expect(said.at(-1)).toMatch(/^South: Oak Street and Pine Street, 210 metres south and 10 metres west\. Press Shift N twice/);
    g.lastNPress = -Infinity;
    g.x = -150;
    g.y = 300;
    game.run('ArrowUp'); // nothing to the north from here
    g.lastNPress = -Infinity;
    game.run('n');
    expect(said.at(-1)).toMatch(/^No intersection to the north within 500 metres\. Nearest: Oak Street and Elm Street/);
  });

  it('lists places by compass direction rather than clock', async () => {
    const { game, said } = await routed();
    game.run('w');
    expect(said.at(-1)).toBe('Blue Cafe, cafe, 50 metres north.');
  });

  it('steps say where you are, not route turns', async () => {
    const { game, said, g } = await routed();
    expect(g.route).not.toBeNull(); // planned before grid mode
    game.run('ArrowUp');
    await flush();
    expect(said.at(-1)).toBe('Oak Street.');
  });

  it('I says turn by turn pauses, and where the destination is', async () => {
    const { game, said } = await routed();
    game.run('i');
    expect(said.at(-1)).toBe('Turn by turn pauses in grid mode. Elm End is 150 metres north and 150 metres east; follow the beacon.');
  });

  it('a destination chosen in grid mode plans no route until grid mode ends', async () => {
    const h = setup();
    h.g.areas = { at: vi.fn(async () => ({ key: 'open', kind: 'open ground', sound: 'open' })), has: () => true };
    h.g.loadCenter = { x: 0, y: 0 };
    h.game.run('F3');
    await flush();
    h.game.setTarget({ name: 'Elm End', x: 150, y: 200 });
    await flush();
    expect(h.g.route).toBeNull();
    expect(h.said).toContain('Destination Elm End, 150 metres north and 150 metres east. Follow the beacon.');
    expect(h.said.join(' ')).not.toMatch(/Route \d|Turn around|turn (left|right)|o'clock/);
    h.game.run('F3');
    await flush();
    expect(h.g.route).not.toBeNull();
    expect(h.said.join(' ')).toMatch(/Grid mode off\..*Route \d+ metres/);
  });

  it('G gives the destination in yards with imperial units', async () => {
    const { game, said, g } = await routed();
    g.settings.units = 'imperial';
    game.run('g');
    expect(said.at(-1)).toContain('Elm End, 160 yards north and 160 yards east');
  });
});

describe('grid mode names', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const sq = (x0: number, y0: number, x1: number, y1: number) => [ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1)];
  // the traveller steps 10 m east of Oak Street, off the road, into whatever the tiles say is there
  async function at(area: Record<string, unknown>, hood: string | null = 'Kala Ghoda') {
    const h = setup();
    h.g.areas = { at: vi.fn(async () => ({ key: 'a1', sound: 'commercial', kind: 'commercial area', ...area })), has: () => true, hood: vi.fn(async () => hood) };
    h.g.loadCenter = { x: 0, y: 0 };
    h.game.run('F3');
    await flush();
    await flush();
    h.game.run('ArrowRight');
    await flush();
    await flush();
    return h;
  }

  it('says the neighbourhood of an unnamed area when asked, not on every step', async () => {
    const { game, said } = await at({});
    expect(said.at(-1)).toBe('Commercial area.'); // a step: the same neighbourhood as before
    game.run(' ');
    await flush();
    await flush();
    expect(said.at(-1)).toBe('Commercial area near Kala Ghoda.');
  });

  it('says "now near" once on crossing into another neighbourhood, named place or not', async () => {
    const { game, said, g } = await at({});
    g.areas.hood = vi.fn(async () => 'Fort');
    g.areas.at = vi.fn(async () => ({ key: 'b9', sound: 'building', kind: 'building', name: 'Beryl House' }));
    game.run('ArrowRight');
    await flush();
    await flush();
    expect(said.at(-1)).toBe('Beryl House, building. Now near Fort.');
    game.run('ArrowRight');
    await flush();
    await flush();
    expect(said.at(-1)).toBe('Beryl House, building.');
  });

  it('never says a place is near itself', async () => {
    const { game, said, g } = await at({ sound: 'building', kind: 'building', name: 'Ashoka Hotel' }, 'Ashoka Hotel');
    expect(said.join(' ')).not.toMatch(/near Ashoka Hotel/);
    g.areas.hood = vi.fn(async () => 'Colaba');
    game.run(' ');
    await flush();
    await flush();
    expect(said.at(-1)).toBe('Ashoka Hotel, building.'); // a named place is not given a neighbourhood when asked
  });

  it('leaves out a neighbourhood whose name the area already says', async () => {
    const { said } = await at({ kind: 'cuffe parade promenade' }, 'Cuffe Parade');
    expect(said.at(-1)).toBe('Cuffe parade promenade.');
  });

  it('says nothing more when no neighbourhood is near', async () => {
    const { said } = await at({}, null);
    expect(said.at(-1)).toBe('Commercial area.');
  });

  it("gives an unnamed building its house number and street", async () => {
    const { said } = await at({ sound: 'building', kind: 'building', number: '12' });
    expect(said.at(-1)).toBe('Building number 12 on Oak Street.');
  });

  it("uses OpenStreetMap's own names for buildings and grounds the tiles leave unnamed", async () => {
    vi.mocked(fetchNamedAreas).mockResolvedValue([
      { name: 'Beryl House', building: true, ring: sq(5, 40, 30, 70) },
      { name: 'Cama Garden', building: false, kind: 'park', ring: sq(-50, 0, 100, 150) },
    ]);
    const b = await at({ sound: 'building', kind: 'building', number: '12' });
    expect(b.said.at(-1)).toBe('Beryl House, building.');
    const g = await at({});
    expect(g.said.at(-1)).toBe('Cama Garden, park.');
    vi.mocked(fetchNamedAreas).mockResolvedValue([{ name: 'Navy Accounts Office', building: false, ring: sq(-50, 0, 100, 150) }]);
    const o = await at({ sound: 'open', kind: 'open ground', key: 'open' });
    expect(o.said.at(-1)).toBe('Navy Accounts Office, grounds.');
  });
});

describe('phone screen', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('snaps "up" to the street within 30 degrees, else to the nearest compass point', () => {
    const { game } = setup(); // on Oak Street, which runs north
    expect(game.streetUp(10)).toEqual({ dir: 0, street: 'Oak Street' });
    expect(game.streetUp(165)).toEqual({ dir: 180, street: 'Oak Street' });
    expect(game.streetUp(60)).toEqual({ dir: 45 });
  });

  it('describes any point: the road there, or what the tiles and OpenStreetMap say', async () => {
    const { game, g } = setup();
    g.areas = { at: vi.fn(async () => ({ key: 'b1', sound: 'building', kind: 'building', number: '12' })), hood: vi.fn(async () => 'Kala Ghoda') };
    expect(await game.describeAt(0, 100)).toEqual({ text: 'Oak Street', sound: 'road', named: true });
    expect(await game.describeAt(20, 100)).toEqual({ text: 'building number 12 on Oak Street', sound: 'building', named: true });
    expect(await game.hoodAt(20, 100)).toBe('Kala Ghoda');
  });

  it('gives the next instruction as text for the directions panel', async () => {
    const { game } = setup();
    expect(game.directionsText()).toBe('');
    game.setTarget({ name: 'Elm End', x: 150, y: 200 });
    await flush();
    expect(game.directionsText()).toMatch(/^In 150 metres, .*turn right onto Elm Street\.$/);
  });

  it('Shift Z saves the planned route as a GPX file', async () => {
    const saved: { download?: string } = {};
    vi.stubGlobal('document', { createElement: () => ({ click() {}, set download(v: string) { saved.download = v; } }) });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const { game, said } = setup();
    game.run('Z', { shift: true });
    expect(said.at(-1)).toBe('No route to save. Set a destination first.');
    game.setTarget({ name: 'Elm End', x: 150, y: 200 });
    await flush();
    game.run('Z', { shift: true });
    expect(saved.download).toBe('Elm End.gpx');
    expect(said.at(-1)).toBe('Route to Elm End saved as a GPX file.');
    delete (globalThis as { document?: unknown }).document;
    vi.mocked(URL.createObjectURL).mockRestore();
    vi.mocked(URL.revokeObjectURL).mockRestore();
  });

  it('warns about an unlit path ahead only when it is dark', () => {
    const { g, said } = setup();
    const start = ll(0, 70);
    g.world.addPlaces({ places: [], signals: new Set<number>(), unlit: [start] });
    g.speed = 1.4;
    g.darkCheckedAt = g.clock;
    g.dark = false;
    g.checkHazards();
    expect(said).toEqual([]);
    g.dark = true;
    g.checkHazards();
    expect(said.at(-1)).toMatch(/^Unlit path ahead, 20 metres/);
  });

  it('vibrates for a hazard, and not when haptics are off', () => {
    const vibrate = vi.fn();
    vi.stubGlobal('navigator', { vibrate });
    const { g } = setup();
    g.world.addPlaces({ places: [], signals: new Set<number>(), unlit: [ll(0, 70)] });
    g.speed = 1.4;
    g.dark = true;
    g.darkCheckedAt = g.clock;
    g.checkHazards();
    expect(vibrate).toHaveBeenCalledWith([500]);
    vibrate.mockClear();
    g.announcedHazards.clear();
    g.settings.haptics = false;
    g.checkHazards();
    expect(vibrate).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('window', { dispatchEvent: () => true });
    vi.stubGlobal('localStorage', { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) });
  });

  it('Shift S fetches the map here and at the destination, and says so when it fails', async () => {
    vi.mocked(fetchTileArea).mockResolvedValue({ roads: rawRoads(), places: { places: [], signals: new Set<number>() } });
    vi.mocked(fetchPlaces).mockResolvedValue({ places: [], signals: new Set<number>() });
    const { game, said, g } = setup();
    g.dest = { name: 'Elm End', x: 150, y: 200 };
    game.run('S', { shift: true });
    await flush();
    expect(vi.mocked(fetchRoads)).toHaveBeenCalledTimes(2);
    expect(said.at(-1)).toBe('Saved the map around here and the destination for offline use.');
    vi.mocked(fetchRoads).mockRejectedValue(new Error('offline'));
    game.run('S', { shift: true });
    await flush();
    expect(said.at(-1)).toBe('Could not save the area. Check your connection.');
  });

  it('Shift O says the nearest of each kind of facility', () => {
    const { game, said, g } = setup();
    game.run('O', { shift: true });
    expect(said.at(-1)).toBe('No toilets, benches or other facilities on the loaded map.');
    g.world.addPlaces({
      places: [],
      signals: new Set<number>(),
      facilities: [{ ...ll(0, 90), kind: 'bench' }, { ...ll(0, 300), kind: 'bench' }, { ...ll(0, 250), kind: 'toilets' }],
    });
    game.run('O', { shift: true });
    expect(said.at(-1)).toBe("Bench, 40 metres at 12 o'clock. Toilets, 200 metres at 12 o'clock.");
  });

  it('E says the way back when you have left the route, and a weak GPS fix', async () => {
    const { game, said, g } = setup();
    g.route = { points: [{ x: 100, y: 50, d: 0 }, { x: 100, y: 450, d: 400 }], maneuvers: [], length: 400, partial: false };
    g.live = true;
    g.gpsEst = { x: 0, y: 50, acc: 60, t: 0 };
    game.run('e');
    await flush();
    expect(said.at(-1)).toMatch(/You are 100 metres from your route\. The way back is at 3 o'clock\./);
    expect(said.at(-1)).toMatch(/only accurate to about 60 metres/);
    g.route = { points: [{ x: 10, y: 50, d: 0 }, { x: 10, y: 450, d: 400 }], maneuvers: [], length: 400, partial: false };
    g.gpsEst = { x: 0, y: 50, acc: 5, t: 0 };
    game.run('e');
    await flush();
    expect(said.at(-1)).not.toMatch(/from your route|only accurate/);
  });

  it('Shift K says the address and shares a map link, and falls back to the clipboard', async () => {
    const share = vi.fn(async () => {});
    vi.stubGlobal('navigator', { share });
    const { game, said } = setup();
    game.run('K', { shift: true });
    await flush();
    expect(said[0]).toMatch(/Oak Street.*Coordinates 51\.\d+, -?0\.\d+\. Sharing your location now\.$/);
    expect(share).toHaveBeenCalledOnce();
    const sent = (share.mock.calls[0] as unknown as [{ text: string }])[0].text;
    expect(sent).toMatch(/^I need help\. .*Oak Street.* Map: https:\/\/www\.openstreetmap\.org\/\?mlat=51\./);
    expect(said.at(-1)).toBe('Location shared.');
    const write = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText: write } });
    game.run('K', { shift: true });
    await flush();
    expect(write).toHaveBeenCalledOnce();
    expect(said.at(-1)).toBe('Message copied. Paste it into a message to someone you trust.');
    vi.unstubAllGlobals();
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('window', { dispatchEvent: () => true });
    vi.stubGlobal('localStorage', { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) });
  });

  it('Shift S also fetches along the planned route', async () => {
    vi.mocked(fetchTileArea).mockResolvedValue({ roads: rawRoads(), places: { places: [], signals: new Set<number>() } });
    const { game, said, g } = setup();
    g.route = { points: [{ x: 0, y: 50, d: 0 }, { x: 0, y: 450, d: 400 }, { x: 0, y: 850, d: 800 }], maneuvers: [], length: 800, partial: false };
    const radius = g.vehicle.loadRadius;
    game.run('S', { shift: true });
    await flush();
    const fetched = vi.mocked(fetchRoads).mock.calls.length;
    expect(fetched).toBe(1 + corridorSpots(g.route.points, radius * 1.5, 12).length);
    expect(fetched).toBeGreaterThan(1);
    expect(said.at(-1)).toBe('Saved the map around here and along the route for offline use.');
  });

  it('picks units by country until the player chooses: imperial in the US, metric in India', async () => {
    const units: string[] = [];
    vi.mocked(fetchCountry).mockResolvedValueOnce('us').mockResolvedValueOnce('in');
    const { g } = setup();
    g.onUnits = (u: string) => units.push(u);
    await g.autoUnits({ lat: 40.1, lon: -88.2 });
    expect(g.settings.units).toBe('imperial');
    await g.autoUnits({ lat: 18.9, lon: 72.8 });
    expect(g.settings.units).toBe('metric');
    expect(units).toEqual(['imperial', 'metric']);
    g.settings.unitsChosen = true;
    vi.mocked(fetchCountry).mockResolvedValueOnce('us');
    await g.autoUnits({ lat: 40.1, lon: -88.2 });
    expect(g.settings.units).toBe('metric');
  });
});

describe('nearby list', () => {
  it('lists places nearest first with distance and which way, filtered by kind', () => {
    const { game } = setup(); // at (0, 50) facing north; Blue Cafe is at (20, 100)
    expect(game.nearbyList(null)).toEqual([{ id: 'n1', text: 'Blue Cafe, cafe, 50 metres, ahead right' }]);
    expect(game.nearbyList('food')).toHaveLength(1);
    expect(game.nearbyList('shop')).toEqual([]);
  });

  it('choosing one makes it the destination', () => {
    const { game, said, g } = setup();
    expect(game.pickPlace('n1')).toBe(true);
    expect(g.dest.name).toBe('Blue Cafe');
    expect(said.join(' ')).toMatch(/Destination Blue Cafe/);
    expect(game.pickPlace('nope')).toBe(false);
  });
});

describe('named buildings while walking', () => {
  const poly = (name: string, x0: number, y0: number, x1: number, y1: number, building = true) => ({
    name,
    building,
    ring: [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ],
    minX: x0,
    minY: y0,
    maxX: x1,
    maxY: y1,
    size: (x1 - x0) * (y1 - y0),
  });
  function walking(items: ReturnType<typeof poly>[]) {
    const h = setup(); // walker on Oak Street at (0, 50), facing north
    h.g.named = { at: { x: 0, y: 50 }, items };
    h.g.speed = 1.2;
    h.g.clock = 100; // well after any earlier announcement
    return h;
  }

  it('says a named building within 20 metres, on its side, once', () => {
    const { said, g } = walking([poly('Beryl House', 5, 40, 30, 70)]);
    g.checkPlaces();
    expect(said.at(-1)).toBe('Beryl House, building, on your right');
    g.clock += 10;
    g.checkPlaces();
    expect(said.filter((t) => t.startsWith('Beryl House'))).toHaveLength(1);
  });

  it('leaves out buildings further than 20 metres, the one you are in, and when driving', () => {
    expect(walking([poly('Far Hall', 40, 40, 60, 70)]).said).toEqual([]);
    const far = walking([poly('Far Hall', 40, 40, 60, 70)]);
    far.g.checkPlaces();
    expect(far.said).toEqual([]);
    const inside = walking([poly('Mall', -20, 30, 20, 80)]);
    inside.g.checkPlaces();
    expect(inside.said).toEqual([]);
    const shop = walking([poly('Blue Cafe', 5, 85, 30, 115)]); // the cafe at (20, 100) is announced as a place instead
    shop.g.announcedPlaces.set('n1', shop.g.clock);
    shop.g.y = 95;
    shop.g.checkPlaces();
    expect(shop.said.join(' ')).not.toMatch(/Blue Cafe, building/);
    const car = walking([poly('Beryl House', 5, 40, 30, 70)]);
    car.game.run('3');
    car.g.speed = 1.2;
    car.said.length = 0;
    car.g.checkPlaces();
    expect(car.said.join(' ')).not.toMatch(/Beryl House/);
  });
});

describe('live GPS sound', () => {
  it('silences the footsteps while live GPS moves you, and brings them back without it', () => {
    const { g } = setup();
    const engine: boolean[] = [];
    g.audio = new Proxy({}, { get: (_t, p) => (p === 'setEngine' ? (on: boolean) => engine.push(on) : p === 'now' ? 0 : () => {}) });
    g.syncEngine();
    g.live = { compass: null, stop() {} };
    g.syncEngine(); // waiting for a first fix: the keyboard still moves you
    g.liveFix = { lat: 0, lon: 0, speed: 1.3, heading: 0, accuracy: 5 };
    g.syncEngine();
    g.live = null;
    g.liveFix = null;
    g.syncEngine();
    expect(engine).toEqual([true, true, false, true]);
  });
});

describe('live GPS walking', () => {
  it('takes "ahead" from the way you walk, not where the phone points', () => {
    const { g } = setup();
    g.heading = 90;
    g.live = { compass: 90, stop() {} }; // phone pointing east
    g.liveFix = { lat: 0, lon: 0, speed: 1.3, heading: 0, accuracy: 5 }; // walking north
    g.gpsEst = { x: 0, y: 60, acc: 5, t: 0 };
    for (let i = 0; i < 60; i++) g.followGps(1 / 60);
    expect(Math.abs(((g.heading + 180) % 360) - 180)).toBeLessThan(5);
    expect(g.speed).toBeCloseTo(1.3);
  });

  it('uses the compass when standing still', () => {
    const { g } = setup();
    g.heading = 0;
    g.live = { compass: 90, stop() {} };
    g.liveFix = { lat: 0, lon: 0, speed: 0, heading: null, accuracy: 5 };
    g.gpsEst = { x: 0, y: 50, acc: 5, t: 0 };
    for (let i = 0; i < 120; i++) g.followGps(1 / 60);
    expect(g.heading).toBeGreaterThan(85);
  });
});

describe('turn reminder distances', () => {
  it('paceScale stays 1 when stopped, grows with speed to double, and shrinks to 0.7', () => {
    expect(paceScale(0, 1.4)).toBe(1);
    expect(paceScale(1.4, 1.4)).toBe(1);
    expect(paceScale(2.1, 1.4)).toBeCloseTo(1.5);
    expect(paceScale(9, 1.4)).toBe(2);
    expect(paceScale(0.5, 1.4)).toBe(0.7);
  });

  it('a fast walker hears turns earlier than a slow one', () => {
    const { g } = setup();
    g.speed = 0.7;
    const slow = g.stepThresholds;
    g.speed = 2.8;
    const fast = g.stepThresholds;
    expect(slow[0]).toBeCloseTo(42);
    expect(fast[0]).toBeCloseTo(120);
    expect(fast[2]).toBeGreaterThan(slow[2]);
  });
});

describe('arrival hint', () => {
  it('names the nearest entrance and which side it is on', () => {
    const { g } = setup();
    const door = ll(15, 50);
    const rp = { id: 'w1', lat: ll(30, 50).lat, lon: ll(30, 50).lon, tags: { amenity: 'library', name: 'Library' }, entrances: [{ ...door, tags: { entrance: 'main' } }] };
    g.world.addPlaces({ places: [rp], signals: new Set<number>() });
    const t = { name: 'Library', x: 30, y: 50, placeId: 'w1' };
    expect(g.arrivalHint(t)).toBe(' The main entrance is 15 metres on your right.');
    expect(g.arrivalHint({ name: 'Shop', x: 0, y: 70 })).toBe(' It is 20 metres ahead.');
    expect(g.arrivalHint({ name: 'Here', x: 0, y: 51 })).toBe('');
  });

  it('adds the hint to the arrival announcement', () => {
    const { g, said } = setup();
    g.dest = { name: 'Shop', x: 2, y: 55 };
    g.updateDestination();
    expect(said.at(-1)).toMatch(/^Arrived at Shop\. It is 5 metres ahead right\./);
  });
});

describe('recent destinations', () => {
  it('records each destination set', () => {
    const { g } = setup();
    g.setTarget({ name: 'Elm End', x: 150, y: 200 });
    expect(JSON.parse(memory.get('audio-map-recents')!)[0].name).toBe('Elm End');
  });
});

describe('crossing advice', () => {
  it('says what to wait for from how the crossing is mapped', () => {
    expect(crossingAdvice('Crossing with signals', ['push button', 'audible signal'])).toBe('At the signal crossing. Press the button. Wait for the audible signal, then check for traffic before crossing.');
    expect(crossingAdvice('Crossing with signals', [])).toMatch(/No audible signal is mapped here/);
    expect(crossingAdvice('Crossing with signals', ['flush kerb, no edge to feel'])).toMatch(/flush/);
    expect(crossingAdvice('Pedestrian crossing', [])).toMatch(/uncontrolled crossing/);
    expect(crossingAdvice('Steps', [])).toBe('');
  });

  it('speaks once when a walker stops at a crossing', () => {
    const { g, said } = setup();
    const at = ll(0, 52);
    g.world.addPlaces({ places: [], signals: new Set<number>(), crossings: [{ ...at, text: 'Crossing with signals', extras: ['audible signal'] }] });
    g.speed = 0;
    g.checkAtCrossing();
    g.checkAtCrossing();
    expect(said).toEqual(['At the signal crossing. Wait for the audible signal, then check for traffic before crossing.']);
    g.speed = 1.4;
    g.announcedHazards.clear();
    g.checkAtCrossing();
    expect(said).toHaveLength(1);
  });
});

describe('corridorSpots', () => {
  const line = Array.from({ length: 11 }, (_, i) => ({ x: 0, y: i * 100, d: i * 100 }));

  it('picks a point about every spacing and ends on the last point', () => {
    expect(corridorSpots(line, 300, 12).map((p) => p.d)).toEqual([300, 600, 900, 1000]);
  });

  it('thins to the limit and keeps both ends', () => {
    const spots = corridorSpots(line, 100, 3);
    expect(spots.map((p) => p.d)).toEqual([100, 600, 1000]);
  });

  it('is empty for an empty route', () => {
    expect(corridorSpots([], 300, 12)).toEqual([]);
  });
});

describe('look around', () => {
  it('says the places and the intersection in the direction pointed', () => {
    const { g } = setup();
    g.y = 60;
    expect(g.lookText(0)).toBe('North: Blue Cafe, cafe, 45 metres. Oak Street and Elm Street, 140 metres.');
    expect(g.lookText(180)).toBe('South: nothing mapped within 150 metres.');
  });

  it('speaks once the phone is held still on a new direction, and not again for the same one', () => {
    const { game, said, g } = setup();
    game.run('E', { shift: true });
    expect(said.at(-1)).toMatch(/^Look around on/);
    g.heading = 0;
    g.clock = 10;
    g.checkLookAround(); // starts holding
    g.clock = 10.5;
    g.checkLookAround();
    expect(said).toHaveLength(1);
    g.clock = 11.2;
    g.checkLookAround();
    expect(said).toHaveLength(2);
    expect(said.at(-1)).toMatch(/^North:/);
    g.clock = 13;
    g.checkLookAround();
    expect(said).toHaveLength(2);
    g.heading = 90;
    g.clock = 14;
    g.checkLookAround();
    g.clock = 15.2;
    g.checkLookAround();
    expect(said.at(-1)).toMatch(/^East:/);
    game.run('E', { shift: true });
    expect(said.at(-1)).toBe('Look around off.');
  });

  it('Shift I says what lies the way you are heading, without the mode on', () => {
    const { game, said, g } = setup();
    g.y = 60;
    game.run('I', { shift: true });
    expect(said.at(-1)).toMatch(/^North: Blue Cafe/);
    g.heading = 180;
    game.run('I', { shift: true });
    expect(said.at(-1)).toBe('South: nothing mapped within 150 metres.');
  });
});

describe('announce radius', () => {
  it('steps the walker reach farther and nearer, and stops at the ends', () => {
    const { game, said, g } = setup();
    game.run(']', { ctrl: true });
    expect(g.settings.radiusScale).toBe(2);
    expect(said.at(-1)).toBe('Hearing places within 300 metres.');
    game.run(']', { ctrl: true });
    game.run(']', { ctrl: true });
    expect(said.at(-1)).toBe('Already at the farthest.');
    for (let i = 0; i < 4; i++) game.run('[', { ctrl: true });
    expect(g.settings.radiusScale).toBe(0.5);
    expect(said.at(-1)).toBe('Already at the nearest.');
  });

  it('narrows what W lists', () => {
    const { game, said, g } = setup();
    g.settings.radiusScale = 0.5; // 75 m reach (said as 80): the cafe at about 51 m is in
    game.run('w');
    expect(said.at(-1)).toMatch(/Blue Cafe/);
    g.y = 400;
    game.run('w');
    expect(said.at(-1)).toBe('No places within 80 metres.');
  });
});

describe('open in maps app', () => {
  it('hands the destination to the maps app and turns its own directions off', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { dispatchEvent: () => true, open });
    const { game, said, g } = setup();
    game.run('M', { shift: true });
    expect(said.at(-1)).toMatch(/^No destination/);
    g.dest = { name: 'Elm End', x: 150, y: 200 };
    g.settings.turnByTurn = true;
    game.run('M', { shift: true });
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0][0]).toMatch(/^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=51\.\d+,-?0\.\d+&travelmode=walking$/);
    expect(g.settings.turnByTurn).toBe(false);
    expect(said.at(-1)).toMatch(/^Opening Elm End in your maps app\. Turn by turn here is off/);
    vi.stubGlobal('window', { dispatchEvent: () => true });
  });
});
