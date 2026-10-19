// Game loop: vehicle physics, road awareness, announcements and keyboard commands.

import { AreaMap, areaText, inRings, type Area, type AreaSound } from './areas';
import { AudioEngine } from './audio/audio';
import { cueLevelScale, duckGain, placeSpeech, placeSpeechGap } from './audio/tuning';
import { Input, type Command } from './input';
import { bindingsOf, describeBinding, lookup, type ActionId, type Binding } from './keymap';
import { MapView } from './mapview';
import { HIGHWAYS, fetchPlaces, fetchRoads, fetchCountry, fetchNamedAreas, fetchRoadsBox, fetchStopRoutes, reverseGeocode, type NamedArea, type RawPlaces, type RawRoads } from './osm';
import { downloadGpx, routeToGpx } from './gpx';
import { buzz } from './haptics';
import { mapsUrl } from './handoff';
import { crossingLeg, drivesOnLeft, locate, routesText, spotText, stopDetail } from './placeinfo';
import { fetchTileArea } from './tiles';
import { Projection, alongLine, bearing as bearingTo, findBend, pointSeg, clockDir, compass8, dist, normDeg, relAngle, sideWord, type LatLon } from './geo';
import { addFavorite } from './favorites';
import { addRecent } from './recents';
import { DEFAULT_ACCURACY, LiveGps, MIN_COURSE_SPEED, POOR_ACCURACY, easeAngle, fuse, pickHeading, snapRadius, type Estimate, type GpsFix } from './gps';
import { loadNotes, saveNotes } from './notes';
import { fmtDistance, fmtSpeed, fmtSpeedShort, saveSettings, type Settings, type VehicleId } from './settings';
import type { SoundTheme } from './audio/themes';
import { extrasWanted, junctionQuiet, nextProfile, placeTier, placeWanted, PROFILE_TEXT } from './profiles';
import { Speech } from './speech';
import { addCrossings, maneuverText, ordinal, planRoute, pointAlong, type Maneuver, type Route, type RouteOptions, type StreetCrossing } from './router';
import { fetchOnlineRoute, hasOnlineRouting } from './onlineRouter';
import { VEHICLES, roadHalfWidth, type VehicleProfile } from './vehicles';
import { conditionsReport, isDark } from './weather';
import { departuresReport, transitous } from './transit';
import { byTierThenDistance, matchTier } from './search';
import { MINOR, TRANSIT, World, type Edge, type GNode, type Junction, type Place, type PlaceGroup, type RoadHit, type Way } from './world';

const STEP = 1 / 60;
/** No animation frame for this long (ms) means the screen is off or the page hidden. */
const IDLE_AFTER = 400;
/** Seconds before a phone tries a failed first map load again. */
const LOAD_RETRY = 20;
/** seconds off the ring before the roundabout counts as left */
const RING_EXIT_DELAY = 0.5;
export function minutesText(minutes: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  const h = Math.floor(minutes / 60);
  if (!h) return plural(minutes, 'minute');
  return minutes % 60 ? `${plural(h, 'hour')} ${plural(minutes % 60, 'minute')}` : plural(h, 'hour');
}

const FILTER_NAMES: Record<PlaceGroup, string> = {
  food: 'food and drink',
  shop: 'shops',
  transport: 'transport',
  culture: 'culture',
  nature: 'parks and nature',
  health: 'health',
  service: 'services',
  other: 'other places',
};
const FILTERS: (PlaceGroup | null)[] = [null, 'food', 'shop', 'transport', 'health', 'culture', 'nature', 'service'];
/** distances (m) at which progress toward the destination is spoken */
const MILESTONES = [50, 100, 200, 500, 1000, 2000, 5000];
/** Closer than this (metres), GPS cannot place you any better: say "now", not a distance. */
const HERE = 8;
/** grid mode step sizes, in metres (yards with imperial units) */
const GRID_STEPS = [1, 10, 100, 1000];
const GRID_MOVES: Record<string, [number, number]> = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
/** places whose exact spot (corner, side of the street) is always spoken */
const STOPS = new Set(['bus stop', 'tram stop', 'station entrance']);

const CAR_ROADS =
  'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|' +
  'tertiary|tertiary_link|unclassified|residential|living_street';

/**
 * For destinations beyond the loaded map, the streets between here and there are loaded for routing.
 * Furthest straight-line distance (m) for which that is attempted, and the road types fetched.
 */
const CORRIDOR: Record<VehicleId, { max: number; types: string }> = {
  walker: { max: 5000, types: HIGHWAYS },
  bicycle: { max: 10000, types: HIGHWAYS.replace('motorway|motorway_link|', '') },
  car: { max: 15000, types: CAR_ROADS },
  helicopter: { max: 0, types: '' },
};
const ROUGH = new Set(['gravel', 'dirt', 'unpaved', 'ground', 'grass', 'sand', 'cobblestone', 'sett', 'compacted', 'fine_gravel', 'mud', 'pebblestone', 'wood']);

export interface Hud {
  street: string;
  speed: string;
  heading: string;
  area: string;
  destination: string;
  status: string;
}

interface Target {
  name: string;
  x: number;
  y: number;
  /** size of the target area; you arrive when within this distance (or the vehicle's usual radius) */
  radius?: number;
  /** where exactly, e.g. "north-west corner of Goodwin Avenue and Green Street" or "main entrance on Green Street" */
  detail?: string;
  /** the loaded place it was chosen from */
  placeId?: string;
  /** bus or tram lines calling there, once looked up */
  lines?: string;
}

export interface PlaceMatch {
  name: string;
  detail: string;
  lat: number;
  lon: number;
  /** how well it matched the search (see search.ts) */
  tier: number;
  /** metres away */
  d: number;
}

interface StepEntry {
  ahead: Ahead;
  key: number;
  /** distance along the road beyond the first (next) intersection */
  cum: number;
  /** street travelled to reach it */
  via: string;
}

/** A roundabout's ring, its exits in the order you reach them, and the node you enter at. */
interface Roundabout {
  nodes: GNode[];
  exits: { node: GNode; edge: Edge }[];
  clockwise: boolean;
  entry: GNode;
}

/** A roundabout the traveller is driving round. */
interface RingState {
  nodes: GNode[];
  /** distance round the ring from the entry to each of nodes */
  cum: number[];
  /** length of the ring */
  length: number;
  closed: boolean;
  entry: GNode;
  exits: { node: GNode; edge: Edge; at: number }[];
  clockwise: boolean;
  /** next exit not yet passed */
  next: number;
  /** last exit announced as coming up */
  warned: number;
  /** last exit whose bell has played */
  rung: number;
  /** distance round the ring at the last update */
  prog: number;
  offSince: number;
}

interface Ahead {
  node: GNode;
  /** distance along the road (straight-line distance for the off-road fallback) */
  forward: number;
  /** direction of travel when arriving at the node */
  arrival: number;
  deadEnd: boolean;
  /** the road only seems to end there because the loaded map stops */
  mapEdge?: boolean;
  /** street we arrive on */
  arriveName: string;
}

export class Game {
  private proj!: Projection;
  private world: World | null = null;
  private loadCenter = { x: 0, y: 0 };
  private loading = false;
  private nextLoadTry = 0;
  /** the first map of a start failed to load (cleared when it is tried again) */
  private loadFailed = false;
  private loadRetry: ReturnType<typeof setTimeout> | undefined;
  private loadAbort: AbortController | null = null;
  private areaName = '';

  private x = 0;
  private y = 0;
  private heading = 0;
  private speed = 0;
  /** live GPS mode: once a fix has arrived, the device, not the keyboard, moves the traveller */
  private live: LiveGps | null = null;
  private liveFix: GpsFix | null = null;
  private gpsEst: Estimate | null = null;
  private gpsPoor = false;
  private restartingForGps = false;
  /** grid mode: arrows step north, south, west and east and say what kind of ground you are on */
  /** key: the area last spoken; dir: the way the last arrow stepped, where N looks */
  /** key: the area last spoken; dir: the way the last arrow stepped, where N looks; hood: the neighbourhood last said */
  private grid: { key: string | null; req: number; dir?: number; hood?: string | null } | null = null;
  private gridStepIdx = 1;
  private areas = new AreaMap();
  /** named buildings and grounds from OpenStreetMap, for grid mode (the tiles carry none), fetched around `at` */
  private named: { at: { x: number; y: number }; items: NamedPoly[] } | null = null;
  private namedLoading = false;
  private namedRetry = 0;
  /** what to say about each place's exact spot, worked out on first use (reset with the map) */
  private details = new Map<string, { short: string; long: string }>();
  /** lines calling at a stop, by OSM node, once looked up */
  private stopLines = new Map<number, string>();
  private throttle = 0;
  private vehicle: VehicleProfile;

  private running = false;
  private paused = false;
  private lastFrame = 0;
  private acc = 0;
  private clock = 0;

  // road state
  private road: Way | null = null;
  private onRoad = false;
  private candName: string | null = null;
  private candSince = 0;
  private streetName: string | null = null;
  private wasOffRoad = false;

  // announcements
  private ahead: Ahead | null = null;
  private announcedNodes = new Map<number, number>();
  private announcedPlaces = new Map<string, number>();
  private announcedHazards = new Map<string, number>();
  private nextPlaceCheck = 0;
  private nextAheadCheck = 0;
  /** member nodes of the junction the traveller is standing in, if any */
  private inJunction: Set<number> | null = null;
  /** junction last described by N, so repeats can be short */
  private lastN: number | null = null;
  /** intersections stepped through with period / comma */
  private stepCursor: { list: StepEntry[]; idx: number } | null = null;
  private aheadAt = 0;
  private nextProxBeep = 0;
  private lastPlaceSpoken = 0;
  /** roundabout being driven round */
  private ring: RingState | null = null;
  /** bends already announced (keys of their corner points), with the time */
  private announcedBends = new Map<string, number>();
  private cuedBends = new Set<string>();
  /** N / Shift+N double press */
  private lastNPress = -Infinity;
  private lastNShift = false;
  /** the bend the last jump stopped at, so the next jump goes past it */
  private jumpBend = new Set<string>();
  private jumpHinted = false;

  // turning
  private turnHold: { dir: -1 | 1; since: number } | null = null;
  private turnedDuringHold = false;
  private lastManualTurn = -10;
  private speedAtPress = 0;

  // destination / place browsing
  private dest: Target | null = null;
  private nextBeacon = 0;

  // turn-by-turn
  private route: Route | null = null;
  private routeIdx = 0;
  private routeProg = 0;
  private nextMan = 0;
  private spokenSteps = new Set<number>();
  private offRouteSince = -1;
  private lastRouteCalc = -1e9;
  private nextRouteCheck = 0;
  private lastIPress = -Infinity;
  private lastDPress = -Infinity;
  /** furthest along the route we have been, to notice going back along it */
  private furthestProg = 0;
  private lastWrongWay = -1e9;
  /** streets loaded between the traveller and a distant destination, used only for routing */
  private routeWorld: { world: World; vehicle: VehicleId; minX: number; minY: number; maxX: number; maxY: number } | null = null;
  private corridorAbort: AbortController | null = null;
  private corridorLoading = false;
  private routeTooFar = false;
  /** id of the latest route request, so slower earlier answers are ignored */
  private routeReq = 0;
  private routePending = false;
  private destMilestone = Infinity;
  private trip: { t0: number; meters: number; streets: string[] } | null = null;
  private lastTrip = '';
  private notes: { x: number; y: number; text: string }[] = [];
  private placeFilter: PlaceGroup | null = null;
  private browse: { list: Place[]; idx: number; x: number; y: number } | null = null;

  private nextHud = 0;
  private nextMap = 0;

  readonly input = new Input();
  onHud?: (h: Hud) => void;
  onMenu?: (focus: 'main' | 'search' | 'settings') => void;
  onNavigate?: () => void;
  onJump?: () => void;
  onNote?: () => void;
  onOsmNote?: (at: LatLon) => void;
  /** units changed to suit the country (see autoUnits) */
  onUnits?: (u: 'metric' | 'imperial') => void;
  /** played on a touch screen: leave out keyboard hints */
  touch = false;
  /** sees every key first; returning true consumes it */
  onKey?: (c: Command) => boolean;
  onSaveRoute?: () => void;
  onRoutes?: () => void;

  constructor(
    private settings: Settings,
    private speech: Speech,
    private audio: AudioEngine,
    private map: MapView,
  ) {
    this.vehicle = VEHICLES[settings.vehicle];
    this.input.onCommand = (c) => this.command(c);
    this.input.onKeyUp = (code) => this.keyUp(code);
    this.speech.onSpeakingChange = (s) => {
      this.speaking = s;
      this.audio.duck(s, duckGain(this.speed));
    };
  }

  // ---------------- lifecycle ----------------

  async start(center: LatLon, placeName?: string) {
    // going somewhere else by search or jump ends live GPS, which would only pull you back
    const liveOff = !this.restartingForGps && !!this.live;
    if (!this.restartingForGps) this.stopLive();
    this.loadAbort?.abort();
    clearTimeout(this.loadRetry);
    this.proj = new Projection(center);
    this.loadNotes();
    this.x = 0;
    this.y = 0;
    this.speed = 0;
    this.world = null;
    this.road = null;
    this.streetName = null;
    this.dest = null;
    this.trip = null;
    this.browse = null;
    this.exitGrid();
    this.named = null;
    this.details.clear();
    this.announcedNodes.clear();
    this.announcedPlaces.clear();
    this.announcedHazards.clear();
    this.inJunction = null;
    this.ring = null;
    this.announcedBends.clear();
    this.cuedBends.clear();
    this.lastN = null;
    this.stepCursor = null;
    this.dropCorridor();
    this.clearRoute();
    this.map.resetTrail();
    this.map.setDestination(null);
    this.audio.setVehicle(this.vehicle.id);
    this.audio.resume();
    this.paused = false;
    if (!this.running) {
      this.running = true;
      this.lastFrame = performance.now();
      requestAnimationFrame(this.frame);
      setInterval(this.idle, 500);
    }

    this.speech.say(`${liveOff ? 'Live GPS off. ' : ''}Loading map data${placeName ? ` for ${placeName}` : ''}. Please wait.`, 'high');
    void this.autoUnits(center);
    await this.firstLoad();
  }

  /**
   * Load the map for a fresh start, then put the traveller on the nearest road. On a phone, where
   * there is no Escape to start again, a failed load tries again by itself until it works.
   */
  private async firstLoad() {
    const proj = this.proj;
    this.loadFailed = false;
    const stopHeartbeat = this.loadingHeartbeat();
    const ok = await this.load(true);
    stopHeartbeat();
    const world = this.world as World | null; // assigned during load()
    if (!ok || !world) {
      if (this.touch && this.loadFailed && this.proj === proj) {
        this.loadRetry = setTimeout(() => {
          if (this.proj !== proj || this.world) return; // started somewhere else meanwhile
          // live GPS may have moved you while the map was missing
          if (this.liveFix && this.gpsEst) {
            this.x = this.gpsEst.x;
            this.y = this.gpsEst.y;
          }
          void this.firstLoad();
        }, LOAD_RETRY * 1000);
      }
      return;
    }

    // put the traveller on the nearest suitable road, facing along it
    if (this.vehicle.id !== 'helicopter') {
      const hit =
        world.nearestRoad(this.x, this.y, 400, this.filter) ?? world.nearestRoad(this.x, this.y, 400);
      if (hit) {
        this.x = hit.hit.px;
        this.y = hit.hit.py;
        this.heading = Math.round(hit.dir);
      }
    }
    this.updateRoad(true);
    this.audio.loaded();
    const where = this.streetName ? `On ${this.streetName}` : 'Not on a road';
    this.speech.say(
      `Ready. ${this.vehicle.name}. ${where}, facing ${compass8(this.heading)}.` +
        `${this.areaName ? ` ${this.areaName}.` : ''} ${world.ways.length} roads${world.places.length ? ` and ${world.places.length} places` : ''} loaded.` +
        (this.touch ? '' : ` Hold up arrow to move. Press F1 for help.`),
      'normal',
    );
  }

  /** Units by country, until the player picks them in settings: imperial in the United States, metric elsewhere. */
  private async autoUnits(center: LatLon) {
    if (this.settings.unitsChosen) return;
    const cc = await fetchCountry(center);
    if (!cc || this.settings.unitsChosen) return;
    const units = IMPERIAL_COUNTRIES.has(cc) ? 'imperial' : 'metric';
    if (units === this.settings.units) return;
    this.settings.units = units;
    saveSettings(this.settings);
    this.details.clear();
    this.onUnits?.(units);
  }

  /** Soft pulse and occasional spoken update so a long load is never silent. */
  private loadingHeartbeat(): () => void {
    let beats = 0;
    const id = setInterval(() => {
      beats++;
      this.audio.tone(392, { dur: 0.08, level: 0.04, type: 'sine' });
      if (beats % 10 === 0) this.speech.say('Still loading map data.', 'normal');
    }, 1500);
    return () => clearInterval(id);
  }

  /**
   * Load the roads and places around the traveller. Map tiles arrive in a second or two and are
   * used first; the fuller Overpass data (roundabouts, traffic signals, exact junctions) follows in
   * the background and quietly replaces them. Away from the start, where the current map still
   * covers you, Overpass gets a few seconds' head start so you keep its details when it is quick.
   */
  private async load(initial: boolean): Promise<boolean> {
    this.loading = true;
    const center = this.proj.toLatLon(this.x, this.y);
    const at = { x: this.x, y: this.y };
    const radius = this.vehicle.loadRadius;
    const abort = (this.loadAbort = new AbortController());
    let installed = false;
    let warned = false;
    const onRetry = () => {
      if (initial && !warned && !installed) {
        warned = true;
        this.speech.say('The map server is busy. Still trying.', 'normal');
      }
    };
    const quiet = <T,>(p: Promise<T>) => (p.catch(() => undefined), p);
    const areaP = quiet(reverseGeocode(center));
    const tilesP = quiet(fetchTileArea(center, radius, abort.signal));
    const roadsP = quiet(fetchRoads(center, radius, abort.signal, onRetry));
    const placesP = quiet(fetchPlaces(center, radius, abort.signal, onRetry));
    try {
      const full = async () => ({ world: new World(this.proj, await roadsP), full: true });
      const fromTiles = async (delay: number) => {
        const t = await tilesP;
        // give Overpass a head start, unless it has already failed
        if (delay) await Promise.race([new Promise((r) => setTimeout(r, delay)), roadsP.then(() => new Promise(() => undefined), () => undefined)]);
        const w = new World(this.proj, t.roads);
        w.addPlaces(t.places);
        return { world: w, full: false };
      };
      // a grid step can land well outside the current map: no head start then
      const covered = !initial && !!this.world && this.inLoadedArea(at.x, at.y);
      const first = await Promise.any([full(), fromTiles(covered ? 10_000 : 0)]);
      const world = first.world;
      if (abort.signal.aborted) return false;

      if (first.full) {
        // Overpass won: places as before (straight away at the start; before swapping later on)
        if (initial) {
          placesP.then(
            (p) => {
              if (this.world !== world) return;
              world.addPlaces(p);
              this.speech.say(`${world.places.length} places loaded.`, 'low');
            },
            () => {
              if (!abort.signal.aborted && this.world === world) this.speech.say('Could not load places. Roads are available.', 'normal');
            },
          );
        } else {
          try {
            world.addPlaces(await placesP);
          } catch (e) {
            if (abort.signal.aborted) throw e;
            console.warn('places failed', e);
          }
        }
      } else {
        void this.upgradeWorld(world, roadsP, placesP, tilesP, abort);
      }
      if (initial && world.isEmpty) {
        this.audio.error();
        this.speech.say('No roads found here. Press Escape to choose another location.', 'high');
      }

      if (this.world) this.swapWorld(world);
      else this.world = world;
      installed = true;
      if (this.dest && !this.grid && this.settings.turnByTurn && (!this.route || this.route.partial) && this.clock - this.lastRouteCalc > 10) void this.computeRoute(false);
      this.loadCenter = at;
      // the area name is nice to have, not worth holding up the start for
      const area = await Promise.race([areaP, new Promise<null>((r) => setTimeout(() => r(null), 2500))]);
      if (abort.signal.aborted) return false; // a newer load took over while the name was pending
      if (area) {
        if (!initial && area !== this.areaName) this.speech.say(`Entering ${area}`, 'low');
        this.areaName = area;
      } else {
        void areaP.then((late) => {
          if (late && this.loadAbort === abort) this.areaName = late;
        });
      }
      return true;
    } catch (e) {
      if (abort.signal.aborted) return false;
      console.error(e);
      this.audio.error();
      if (initial) this.loadFailed = true;
      this.speech.say(
        !initial
          ? 'Could not load more map data. Will retry shortly.'
          : this.touch
            ? `Could not load map data. The map servers may be busy, or there is no connection. Trying again in ${LOAD_RETRY} seconds.`
            : 'Could not load map data. The map servers may be busy. Press Escape, then Start to try again.',
        'high',
      );
      this.nextLoadTry = this.clock + 20;
      return false;
    } finally {
      if (this.loadAbort === abort) this.loading = false;
    }
  }

  /** When the Overpass data for an area arrives, put it in place of the tile-built map. */
  private async upgradeWorld(
    tileWorld: World,
    roadsP: Promise<RawRoads>,
    placesP: Promise<RawPlaces>,
    tilesP: Promise<{ places: RawPlaces }>,
    abort: AbortController,
  ) {
    let world: World;
    try {
      world = new World(this.proj, await roadsP);
    } catch {
      return; // keep the tile map; the next load tries again
    }
    try {
      world.addPlaces(await placesP);
    } catch {
      world.addPlaces((await tilesP).places); // Overpass places failed: the tiles' will do
    }
    if (abort.signal.aborted || this.world !== tileWorld) return; // a newer area has replaced it
    this.swapWorld(world);
  }

  /**
   * Replace the map while travelling. Node ids differ between maps, so what was already announced,
   * and the junction we stand in, are carried over by position.
   */
  private swapWorld(next: World) {
    const prev = this.world!;
    this.details.clear();
    const announced = new Map<number, number>();
    for (const [id, t] of this.announcedNodes) {
      const n = prev.nodes.get(id);
      if (!n || this.clock - t > 120) continue;
      for (const m of next.nodesNear(n.x, n.y, 12)) announced.set(m.id, t);
    }
    this.announcedNodes = announced;
    if (this.inJunction) {
      const ids = new Set<number>();
      for (const id of this.inJunction) {
        const n = prev.nodes.get(id);
        if (n) for (const m of next.nodesNear(n.x, n.y, 12)) if (next.isIntersection(m, this.filter)) ids.add(m.id);
      }
      const seed = next.nodes.get([...ids][0]);
      this.inJunction = seed ? new Set(next.junction(seed, this.filter, this.junctionRadius).nodes.map((m) => m.id)) : null;
    }
    this.world = next;
    this.markCrossings(); // streets newly loaded along the route may be crossed
    this.ring = null; // picked up again from the new map, if we are in one
    this.ahead = null;
    this.stepCursor = null;
    this.lastN = null;
    this.browse = null;
  }

  focus(el: HTMLElement) {
    this.input.attach(el);
    el.focus();
  }

  /** Runs a key command as if typed (used by the command palette). */
  run(key: string, mods: { shift?: boolean; ctrl?: boolean } = {}) {
    const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key;
    this.command({ key, code, shift: !!mods.shift, ctrl: !!mods.ctrl, alt: false, repeat: false });
  }

  /** The key currently bound to an action, as spoken. */
  private keyText(id: ActionId): string {
    return describeBinding(this.keyFor(id));
  }

  keyFor(id: ActionId): Binding {
    return bindingsOf(id, this.settings.keyBindings)[0];
  }

  hold(code: string, on: boolean) {
    const was = this.input.isDown(code);
    if (on && !was) this.speedAtPress = this.speed; // touch and voice get the same speed announcement as the keys
    this.input.setHeld(code, on);
    if (!on && was) this.keyUp(code);
  }

  pause() {
    this.paused = true;
    this.calibrationTimers.forEach(clearTimeout);
    this.speed = 0;
    this.audio.update({ speed: 0, maxSpeed: 1, throttle: 0, surface: 'paved', tunnel: false }, STEP);
    this.audio.setRumble(0, 0, 10);
    void this.audio.ctx.suspend();
  }

  resume() {
    this.paused = false;
    this.lastFrame = performance.now();
    this.audio.resume();
  }

  get isStarted() {
    return !!this.proj;
  }

  applySettings(s: Settings) {
    if (s.units !== this.settings.units) this.details.clear();
    this.settings = s;
    this.speech.configure(s.speechMode, s.voiceRate);
    this.audio.setVolume(s.volume);
    this.audio.setTheme(s.soundTheme);
    this.map.headingUp = s.headingUpMap;
    if (s.vehicle !== this.vehicle.id) this.setVehicle(s.vehicle, false);
  }

  private setVehicle(id: VehicleId, announce: boolean) {
    const prevRadius = this.vehicle.loadRadius;
    this.vehicle = VEHICLES[id];
    this.settings.vehicle = id;
    const before = this.settings.soundProfile;
    this.settings.soundProfile = this.settings.vehicleProfiles[id] ?? before;
    saveSettings(this.settings);
    this.speed = Math.min(this.speed, this.vehicle.maxSpeed);
    this.audio.setVehicle(id);
    if (this.dest && this.world) {
      if (this.settings.turnByTurn && id !== 'helicopter') void this.computeRoute(announce);
      else this.clearRoute();
    }
    this.announcedNodes.clear();
    if (announce) {
      this.speech.say(`${this.vehicle.name}. Top speed ${fmtSpeedShort(this.vehicle.maxSpeed, this.settings.units)}.${this.settings.soundProfile === before ? '' : ` ${PROFILE_TEXT[this.settings.soundProfile]}`}`, 'high');
    }
    if (this.proj && this.vehicle.loadRadius > prevRadius && !this.loading) void this.load(false);
  }

  // ---------------- loop ----------------

  private frame = (t: number) => {
    requestAnimationFrame(this.frame);
    this.advance(t, 0.25);
    if (this.paused || !this.world) return;
    if (t > this.nextMap) {
      this.nextMap = t + 33;
      this.map.update(this.proj.toLatLon(this.x, this.y), this.heading, this.speed);
    }
    if (t > this.nextHud) {
      this.nextHud = t + 200;
      this.emitHud();
    }
  };

  /**
   * With the screen off the browser runs no animation frames, but a walk under live GPS goes on, and
   * its turns, crossings, beacon and arrival with it. While frames have stopped, this timer keeps
   * time instead. A hidden page gets timers about once a second, so it may cover a longer gap.
   */
  private idle = () => {
    const t = performance.now();
    if (!(this.live && this.liveFix) || t - this.lastFrame < IDLE_AFTER) return;
    this.advance(t, 2);
  };

  /** Run the simulation up to time t (ms), at most maxDt seconds of it. */
  private advance(t: number, maxDt: number) {
    const dt = Math.max(0, Math.min(maxDt, (t - this.lastFrame) / 1000)); // resume() can stamp a time later than this frame's
    this.lastFrame = t;
    if (this.paused || !this.world) return;
    this.acc += dt;
    while (this.acc >= STEP) {
      this.step(STEP);
      this.acc -= STEP;
    }
    this.syncEngine();
    this.audio.update(
      {
        speed: this.speed,
        maxSpeed: this.vehicle.maxSpeed,
        throttle: this.throttle,
        surface: this.grid ? 'paved' : !this.onRoad && this.vehicle.id !== 'helicopter' ? 'offroad' : this.road?.surface && ROUGH.has(this.road.surface) ? 'rough' : 'paved',
        tunnel: !this.grid && !!this.road?.tunnel && this.onRoad,
        wind: !(this.live && this.liveFix),
      },
      dt,
    );
  }

  private step(dt: number) {
    this.clock += dt;
    const v = this.vehicle;
    if (this.grid) {
      // grid steps move the traveller; only notes, the destination and map loading carry on
      this.speed = 0;
      this.throttle = 0;
      this.updateRumble();
      if (this.clock > this.nextPlaceCheck) {
        this.nextPlaceCheck = this.clock + 0.25;
        this.checkNotes();
      }
      this.updateDestination();
    } else {
      if (this.live && this.liveFix) this.followGps(dt);
      else this.drive(dt);

      this.updateRoad(false);
      this.updateRumble();
      this.updateRing();
      this.checkInJunction();

      if (this.clock > this.nextAheadCheck) {
        this.nextAheadCheck = this.clock + 0.1;
        this.checkAhead();
      }
      this.updateProximityBeeps();
      if (this.route && this.clock > this.nextRouteCheck) {
        this.nextRouteCheck = this.clock + 0.1;
        this.updateRoute();
      }
      if (this.clock > this.nextPlaceCheck) {
        this.nextPlaceCheck = this.clock + 0.25;
        this.checkPlaces();
        this.checkHazards();
        this.checkAtCrossing();
        this.checkLookAround();
        this.checkNotes();
      }
      this.updateDestination();
    }

    if (!this.loading && this.clock > this.nextLoadTry && dist(this.x, this.y, this.loadCenter.x, this.loadCenter.y) > v.loadRadius * 0.55) {
      void this.load(false);
    }
  }

  /** Keyboard driving: speed, turning, road assist and movement. */
  private drive(dt: number) {
    const v = this.vehicle;
    const inp = this.input;
    this.throttle = 0;
    if (inp.isDown('ArrowUp') && !inp.isDown('ControlLeft') && !inp.isDown('ControlRight')) {
      this.speed += v.accel * dt;
      this.throttle = 1;
    }
    if (inp.isDown('ArrowDown')) {
      this.speed -= v.decel * dt;
      this.throttle = -1;
    }
    if (inp.isDown('Slash')) {
      this.speed -= v.brake * dt;
      this.throttle = -1;
    }
    let max = v.maxSpeed;
    if (v.offRoadMax !== null && !this.onRoad) max = Math.min(max, v.offRoadMax);
    if (this.speed > max) this.speed = Math.max(max, this.speed - v.brake * dt);
    this.speed = Math.max(0, Math.min(v.maxSpeed, this.speed));

    // --- continuous turning after a short hold ---
    if (this.turnHold) {
      const code = this.turnHold.dir < 0 ? 'ArrowLeft' : 'ArrowRight';
      if (!inp.isDown(code)) this.turnHold = null;
      else if (this.clock - this.turnHold.since > 0.35) {
        this.turn(this.turnHold.dir * v.turnRate * (inp.shift ? 2 : 1) * dt);
      }
    }

    if (this.settings.roadAssist) this.assist(dt);

    // --- move ---
    const r = (this.heading * Math.PI) / 180;
    if (this.trip) this.trip.meters += this.speed * dt;
    this.x += Math.sin(r) * this.speed * dt;
    this.y += Math.cos(r) * this.speed * dt;
  }

  /** Follow the device's real position, speed and heading instead of the keyboard. */
  private followGps(dt: number) {
    const f = this.liveFix;
    const e = this.gpsEst;
    if (!f || !e) return;
    const t = { x: e.x, y: e.y };
    // a walker's fix is likely on a street: pull it onto the nearest one when the fix is good enough
    const r = this.vehicle.id === 'helicopter' ? 0 : snapRadius(e.acc);
    const hit = r ? this.world?.nearestRoad(e.x, e.y, r, this.filter) : null;
    if (hit) {
      t.x = hit.hit.px;
      t.y = hit.hit.py;
    }
    const k = Math.min(1, dt * 3);
    const ox = this.x;
    const oy = this.y;
    this.x += (t.x - this.x) * k;
    this.y += (t.y - this.y) * k;
    if (this.trip) this.trip.meters += dist(ox, oy, this.x, this.y);
    this.speed = Math.min(this.vehicle.maxSpeed, f.speed);
    const h = pickHeading(this.live!.compass, f.heading, f.speed);
    if (h !== null) this.heading = easeAngle(this.heading, h, dt * 6);
  }

  /**
   * Lane keeping: while on a road and not steering, ease the heading along the road and toward
   * its centre. Gives up when the traveller deliberately points more than 20° away from the road.
   */
  private assist(dt: number) {
    if (this.speed < 0.5 || this.vehicle.id === 'helicopter') return;
    if (this.input.isDown('ArrowLeft') || this.input.isDown('ArrowRight')) return;
    if (this.clock - this.lastManualTurn < 1.5) return;
    const maxStep = this.vehicle.turnRate * 1.5 * dt;

    // On a route: follow the route's own line, so gentle bends and paths drifting away from the
    // street are followed without an instruction. Announced turns are left to the traveller.
    if (this.route && this.offRouteSince < 0) {
      const up = this.upcoming();
      const nearTurn = !!up && up.kind !== 'arrive' && up.d - this.routeProg < 8;
      if (!nearTurn) {
        const t = pointAlong(this.route, this.routeProg + this.speed * 0.6 + 4);
        const err = relAngle(this.heading, bearingTo(this.x, this.y, t.x, t.y));
        if (Math.abs(err) < 35) {
          this.heading = normDeg(this.heading + Math.max(-maxStep, Math.min(maxStep, err * Math.min(1, dt * 4))));
          return;
        }
      }
    }

    if (!this.onRoad || !this.road) return;
    const ahead = this.roadAhead(this.road, this.speed * 0.6 + 3);
    if (!ahead) return;
    // intent: pointing well away from both the road here and the road ahead means a deliberate turn
    if (Math.abs(relAngle(this.heading, ahead.hereDir)) > 30 && Math.abs(relAngle(this.heading, ahead.aim)) > 45) return;
    const err = relAngle(this.heading, ahead.aim);
    this.heading = normDeg(this.heading + Math.max(-maxStep, Math.min(maxStep, err * Math.min(1, dt * 4))));
  }

  /**
   * Where the road we are on goes over the next `look` metres, following its bends (and round a
   * roundabout) but not turning at intersections: beyond one it carries straight on.
   * hereDir is the road's direction where we are; aim is the direction to steer to follow it,
   * easing back toward its centre line.
   */
  private roadAhead(road: Way, look: number): { hereDir: number; aim: number; dir: number } | null {
    const w = this.world!;
    const ring = road.roundabout;
    const traverse = ring ? (wy: Way) => wy.roundabout : (wy: Way) => wy.name === road.name && this.vehicle.canUse(wy);
    const here = w.roadFacing(this.x, this.y, roadHalfWidth(road.type) + 6, this.heading, traverse);
    if (!here) return null;
    let forwards = Math.abs(relAngle(this.heading, here.dir)) <= 90;
    const way = here.seg.way;
    if (ring && way.oneway) forwards = !way.onewayReverse; // round the way traffic goes
    const from = w.nodes.get(forwards ? here.seg.a : here.seg.b)!;
    const to = w.nodes.get(forwards ? here.seg.b : here.seg.a)!;
    const stop = ring ? () => false : (n: GNode) => w.isIntersection(n, this.filter);
    const { pts } = w.roadLine(here.hit.px, here.hit.py, from, to, way.name, traverse, stop, look);
    const p = alongLine(pts, look);
    const toPoint = bearingTo(this.x, this.y, p.x, p.y);
    const aim = normDeg(p.dir + Math.max(-25, Math.min(25, relAngle(p.dir, toPoint))));
    return { hereDir: forwards ? here.dir : normDeg(here.dir + 180), aim, dir: p.dir };
  }

  private turn(deg: number) {
    const before = this.heading;
    this.heading = normDeg(this.heading + deg);
    this.lastManualTurn = this.clock;
    this.turnedDuringHold = true;
    if (!this.settings.compassTicks || !extrasWanted(this.settings, this.vehicle.id)) return;
    const a = Math.floor(before / 10);
    const b = Math.floor(this.heading / 10);
    if (a !== b) {
      // crossed a 10° line; which one depends on direction
      const line = deg > 0 ? b * 10 : a * 10;
      this.audio.tick(line % 90 === 0);
    }
  }

  // ---------------- road awareness ----------------

  private updateRoad(immediate: boolean) {
    const w = this.world!;
    const hit = w.nearestRoad(this.x, this.y, 40, this.vehicle.canUse);
    const half = hit ? roadHalfWidth(hit.seg.way.type) : 0;
    const tolerance = this.vehicle.id === 'walker' ? 4 : 1.5;
    this.onRoad = !!hit && hit.hit.dist <= half + tolerance;
    this.road = this.onRoad ? hit!.seg.way : null;

    // street name the traveller would describe themselves as being on
    let name: string | null = null;
    if (this.vehicle.id === 'walker') {
      const named = w.nearestRoad(this.x, this.y, 18, (wy) => wy.named);
      name = named ? named.seg.way.name : this.road?.name ?? null;
    } else if (this.vehicle.id === 'helicopter') {
      const named = w.nearestRoad(this.x, this.y, 25, (wy) => wy.named);
      name = named?.seg.way.name ?? null;
    } else {
      name = this.road?.name ?? null;
    }

    // going round a roundabout: still on it while passing the ends of its exit roads
    const ringName = this.ring && this.ring.offSince < 0 ? this.ring.nodes[0].edges.find((e) => e.way.roundabout)?.way.name : undefined;
    if (ringName) name = ringName;

    if (immediate) {
      this.streetName = name;
      this.candName = name;
      return;
    }
    if (name !== this.candName) {
      this.candName = name;
      this.candSince = this.clock;
    }
    if (this.candName !== this.streetName && this.clock - this.candSince > 0.6) {
      this.streetName = this.candName;
      const ts = this.trip?.streets;
      if (ts && this.streetName && ts[ts.length - 1] !== this.streetName) ts.push(this.streetName);
      // entering a roundabout is announced with its exits instead
      if (this.streetName && this.settings.announceStreets && this.streetName !== ringName) {
        const extras: string[] = [];
        if (this.road?.bridge) extras.push('bridge');
        if (this.road?.tunnel) extras.push('tunnel');
        if (this.road?.oneway && this.vehicle.id === 'car') extras.push('one way');
        this.audio.streetChange();
        const pr = this.vehicle.id === 'helicopter' ? 'low' : 'normal';
        this.speech.say([this.streetName, ...extras].join(', '), pr);
      }
    }

    // leaving / rejoining the road network
    const constrained = this.vehicle.offRoadMax !== null;
    if (constrained) {
      if (!this.onRoad && !this.wasOffRoad && this.speed > 0.5) {
        this.wasOffRoad = true;
        if (this.speed > (this.vehicle.offRoadMax ?? 0) + 3) this.audio.bump();
        const side = hit ? (relAngle(this.heading, bearingTo(this.x, this.y, hit.hit.px, hit.hit.py)) < 0 ? 'left' : 'right') : null;
        this.speech.say(side ? `Off road. Road is on your ${side}.` : 'Off road.', 'high');
      } else if (this.onRoad && this.wasOffRoad) {
        this.wasOffRoad = false;
        this.speech.say(`Back on ${this.road?.name ?? 'the road'}`, 'normal');
      }
    }
  }

  private updateRumble() {
    const v = this.vehicle.id;
    if ((v !== 'car' && v !== 'bicycle') || this.speed < 0.5 || !this.world) {
      this.audio.setRumble(0, 0, 10);
      return;
    }
    const hit = this.world.nearestRoad(this.x, this.y, 40, this.vehicle.canUse);
    if (!hit) {
      this.audio.setRumble(0, 0, 10);
      return;
    }
    const half = roadHalfWidth(hit.seg.way.type);
    const toCentre = relAngle(this.heading, bearingTo(this.x, this.y, hit.hit.px, hit.hit.py));
    const pan = Math.sin((toCentre * Math.PI) / 180);
    if (!this.onRoad) {
      // rough ground: rumble comes from the side the road is on
      this.audio.setRumble(0.6, pan, 6);
      return;
    }
    const ratio = hit.hit.dist / half;
    if (ratio > 0.7) {
      // rumble strip on the edge you are drifting towards (opposite the centre)
      this.audio.setRumble(Math.min(1, (ratio - 0.7) / 0.3) * 0.8, -pan, this.speed / 0.4);
    } else {
      this.audio.setRumble(0, 0, 10);
    }
  }

  private filter = (w: Way) => this.vehicle.roadFilter(w);

  /**
   * How close to junction node n counts as "at the intersection". Walkers use the sidewalk, so the
   * zone covers the widest road there; vehicles drive near the centre line and get a small speed lead.
   */
  private turnZone(n: GNode): number {
    if (this.vehicle.id === 'walker') {
      let half = 0;
      for (const e of n.edges) if (this.filter(e.way)) half = Math.max(half, roadHalfWidth(e.way.type));
      return half + 5;
    }
    return 6 + this.speed * 0.15;
  }

  /** Play a cue on entering a junction (the point to turn) and a softer one on leaving it. */
  private checkInJunction() {
    if (this.vehicle.id === 'helicopter') return;
    if (this.ring) return; // updateRing handles the exits
    const w = this.world!;
    let leaving = false;
    if (this.inJunction) {
      for (const id of this.inJunction) {
        const n = w.nodes.get(id);
        if (n && dist(this.x, this.y, n.x, n.y) <= this.turnZone(n) + 2) return; // still inside (small hysteresis)
      }
      this.inJunction = null;
      leaving = true;
    }
    let near: GNode | null = null;
    let best = Infinity;
    for (const n of w.nodesNear(this.x, this.y, 20)) {
      if (!w.isIntersection(n, this.filter)) continue;
      const d = dist(this.x, this.y, n.x, n.y);
      if (d <= this.turnZone(n) && d < best) {
        best = d;
        near = n;
      }
    }
    if (!near) {
      if (leaving) this.audio.leftIntersection(); // skipped when we step straight into the next junction
      return;
    }
    const j = w.junction(near, this.filter, this.junctionRadius);
    this.inJunction = new Set(j.nodes.map((m) => m.id));
    const ringNode = j.nodes.find((n) => w.onRing(n));
    // following a route: a distinct chime at the intersection where it turns, a quieter bell elsewhere
    const turn = ringNode ? null : this.routeTurnAt(j.nodes);
    if (turn) {
      this.audio.routeTurnHere(turn.rel);
      this.buzz(turn.rel < 0 ? 'left' : 'right');
      for (let k = 0; k <= 2; k++) this.spokenSteps.add(k);
      this.speech.say(`Here: ${this.stepWithThen(turn)}.`, 'high');
      return;
    }
    if (!ringNode && junctionQuiet(this.settings, this.vehicle.id, j)) return;
    if (this.route && this.offRouteSince < 0 && !ringNode) this.audio.routePassIntersection(this.exitAngles(j));
    else this.audio.atIntersection(this.exitAngles(j));
    // the moment to decide: name every road and which way it goes from here
    if (ringNode) {
      // the entry to a roundabout: its exits were listed on the approach
      const rb = w.ringExits(ringNode, this.vehicle.canUse);
      if (this.speed > 0.3) this.speech.say(`Roundabout. Turn ${rb.clockwise ? 'left' : 'right'} to enter.`, 'high');
      return;
    }
    const branches = this.junctionBranches(near, this.heading, this.streetName ?? '', false);
    if (branches && this.speed > 0.3 && !this.routeTurnWithin(25)) this.speech.say(`${branches}.`, 'high');
  }

  /** Directions (relative to heading) of the roads leaving a junction, excluding the one we arrived on. */
  private exitAngles(j: Junction): number[] {
    const w = this.world!;
    const rels: number[] = [];
    let droppedBehind = false;
    // if no road behind carries the name we arrived on (one-way, filtered), nothing is the road we came from to drop by name
    const arrivedBehind = j.exits.some((x) => Math.abs(relAngle(this.heading, w.edgeBearing(x.from, x.edge))) > 150 && x.edge.way.name === this.streetName);
    for (const { from, edge } of j.exits) {
      const rel = relAngle(this.heading, w.edgeBearing(from, edge));
      if (Math.abs(rel) > 150 && (edge.way.name === this.streetName || (!arrivedBehind && !droppedBehind))) {
        droppedBehind = true;
        continue;
      }
      if (rels.some((r) => Math.abs(relAngle(r, rel)) < 15)) continue; // same direction, e.g. both carriageways
      rels.push(rel);
    }
    return rels.sort((a, b) => a - b);
  }

  /** Nodes this close together count as one junction (dual carriageways, staggered crossings). */
  private get junctionRadius() {
    return this.vehicle.id === 'walker' ? 12 : 22;
  }

  /** Off-road fallback: nearest junction roughly straight ahead. */
  private findAhead(range: number): Ahead | null {
    const w = this.world!;
    const r = (this.heading * Math.PI) / 180;
    const sx = Math.sin(r);
    const cy = Math.cos(r);
    let best: Ahead | null = null;
    for (const n of w.nodesNear(this.x, this.y, range)) {
      if (!w.isIntersection(n, this.filter)) continue;
      const dx = n.x - this.x;
      const dy = n.y - this.y;
      const forward = dx * sx + dy * cy;
      const lateral = dx * cy - dy * sx;
      if (forward < 2 || Math.abs(lateral) > Math.max(12, forward * 0.15)) continue;
      if (!best || forward < best.forward) {
        best = { node: n, forward, arrival: this.heading, deadEnd: false, arriveName: this.streetName ?? '' };
      }
    }
    return best;
  }

  /** The road we are following and the segment's ends in our direction of travel. */
  private roadStart(maxDist = 20, filter = this.filter, heading = this.heading): { hit: RoadHit; from: GNode; to: GNode } | null {
    if (this.vehicle.id === 'helicopter') return null;
    const w = this.world!;
    const hit = w.roadFacing(this.x, this.y, maxDist, heading, filter);
    if (!hit) return null;
    const forwards = Math.abs(relAngle(heading, hit.dir)) <= 90;
    return { hit, from: w.nodes.get(forwards ? hit.seg.a : hit.seg.b)!, to: w.nodes.get(forwards ? hit.seg.b : hit.seg.a)! };
  }

  /** Next junction (or dead end) following the road we are on, however it curves. */
  private nextAlongRoad(range: number): Ahead | null {
    const w = this.world!;
    const s = this.roadStart();
    if (s) {
      const { hit, from, to } = s;
      const skip = this.inJunction; // the junction we are standing in doesn't count as "next"
      const r = w.followRoad(
        from,
        to,
        dist(this.x, this.y, to.x, to.y),
        hit.seg.way.name,
        this.filter,
        (n) => w.isIntersection(n, this.filter) && !skip?.has(n.id),
        range,
      );
      return r && { node: r.node, forward: r.dist, arrival: r.arrival, deadEnd: r.deadEnd, mapEdge: r.mapEdge, arriveName: r.arriveName };
    }
    return this.findAhead(range);
  }

  private checkAhead() {
    if (this.ring) {
      this.ahead = null; // the exits are announced one by one instead
      return;
    }
    const range = Math.max(40, Math.min(400, this.speed * 7 + 30));
    this.ahead = this.nextAlongRoad(range);
    this.aheadAt = this.clock;
    const a = this.ahead;
    if (this.speed < 0.3) return;
    this.checkBend();
    if (!a) return;
    const announceAt = this.speed * 5 + 20;
    const last = this.announcedNodes.get(a.node.id) ?? -1e9;
    if (a.forward > announceAt || this.clock - last <= 60) return;
    const pr = this.vehicle.id === 'helicopter' ? 'low' : 'normal';
    const u = this.settings.units;
    const rb = a.deadEnd ? null : this.roundaboutAhead(a);
    if (rb) {
      for (const n of rb.nodes) this.announcedNodes.set(n.id, this.clock);
      for (const m of this.world!.junction(a.node, this.filter, this.junctionRadius).nodes) this.announcedNodes.set(m.id, this.clock);
      this.audio.intersectionChime(rb.exits.length, false);
      this.speech.say(this.roundaboutText(rb, a), pr);
      return;
    }
    if (a.mapEdge) return; // not a real dead end: more map loads before we get there
    if (a.deadEnd) {
      this.announcedNodes.set(a.node.id, this.clock);
      this.audio.deadEnd();
      this.buzz('deadEnd');
      this.speech.say(`${this.endWord(a)} in ${fmtDistance(a.forward, u)}${this.bendText(a.arrival, this.heading)}.`, pr);
      return;
    }
    const j = this.world!.junction(a.node, this.filter, this.junctionRadius);
    for (const m of j.nodes) this.announcedNodes.set(m.id, this.clock); // one announcement per junction
    if (junctionQuiet(this.settings, this.vehicle.id, j)) return;
    const branches = this.junctionBranches(a.node, a.arrival, a.arriveName, false);
    if (!branches) return;
    this.audio.intersectionChime(j.exits.length, j.signals);
    // kept short while moving: relative directions only
    this.speech.say(
      `Intersection in ${fmtDistance(a.forward, u)}${this.bendText(a.arrival, this.heading)}${j.signals ? ', traffic signals' : ''}: ${branches}.`,
      pr,
    );
  }

  /**
   * Bends in the road ahead (before the next intersection): "Road bends right in 40 metres, about
   * 60 degrees", so you know which way and how far to turn. Without road assist, a turn cue also
   * plays as the bend begins.
   */
  private checkBend() {
    if (this.vehicle.id === 'helicopter' || !this.onRoad) return;
    const s = this.roadStart();
    if (!s || s.hit.seg.way.roundabout) return;
    const w = this.world!;
    const { span, minTurn } = this.bendParams(this.speed);
    const skip = this.inJunction;
    const range = Math.min(400, this.speed * 5 + 30 + span * 1.5); // the whole of a bend that is about to be announced
    const isStop = (n: GNode) => w.isIntersection(n, this.filter) && !skip?.has(n.id);
    const line = w.roadLine(s.hit.hit.px, s.hit.hit.py, s.from, s.to, s.hit.seg.way.name, this.filter, isStop, range);
    const bend = findBend(line.pts, minTurn, span);
    if (!bend) return;
    // a bend right at the next intersection is described with that intersection
    if (line.stopped && line.pts[line.pts.length - 1].d - (bend.at + bend.length) < 12) return;
    // so is a turn on the route
    const m = this.upcoming();
    if (m && m.kind !== 'arrive' && Math.abs(m.d - this.routeProg - bend.at) < 30) return;

    // the rest of a bend we are already in shares its corner points, so it is cued only once
    if (!this.settings.roadAssist && bend.at < this.speed * 0.8 + 3 && !bend.keys.some((k) => this.cuedBends.has(k))) {
      for (const k of bend.keys) this.cuedBends.add(k);
      this.audio.turnCue(bend.turn);
    }
    if (bend.at > this.speed * 5 + 20) return;
    if (bend.keys.some((k) => this.clock - (this.announcedBends.get(k) ?? -1e9) < 60)) return; // already told (or already in it)
    for (const k of bend.keys) this.announcedBends.set(k, this.clock);
    const when = this.inDistance(bend.at);
    this.speech.say(`${cap(this.bendWords(bend))} ${when}${this.bendDetail(bend)}.`, 'normal');
  }

  /** What counts as a bend: turning at least minTurn degrees within span metres (longer at speed). */
  private bendParams(speed: number): { span: number; minTurn: number } {
    return this.vehicle.id === 'walker' ? { span: 25, minTurn: 40 } : { span: Math.max(35, speed * 3), minTurn: 30 };
  }

  /** Bends between here and the junction ahead, not counting one right at the junction. */
  private bendsBefore(a: Ahead): { at: number; turn: number; length: number; keys: string[] }[] {
    const s = this.roadStart();
    if (!s) return [];
    const w = this.world!;
    const skip = this.inJunction;
    const isStop = (n: GNode) => w.isIntersection(n, this.filter) && !skip?.has(n.id);
    const line = w.roadLine(s.hit.hit.px, s.hit.hit.py, s.from, s.to, s.hit.seg.way.name, this.filter, isStop, a.forward + 5);
    const { span, minTurn } = this.bendParams(0);
    const out: { at: number; turn: number; length: number; keys: string[] }[] = [];
    let from = 0;
    for (let guard = 0; guard < 30; guard++) {
      const b = findBend(line.pts, minTurn, span, from);
      if (!b || a.forward - (b.at + b.length) < 12) break;
      out.push(b);
      from = b.at + b.length + 1;
    }
    return out;
  }

  /** "Road bends right in 40 metres, and 2 more bends, then " (empty if there are none). */
  private bendsLead(bends: { at: number; turn: number; length: number }[]): string {
    if (!bends.length) return '';
    const b = bends[0];
    const when = this.inDistance(b.at);
    const more = bends.length > 1 ? `, and ${bends.length - 1} more bend${bends.length > 2 ? 's' : ''}` : '';
    return `${this.bendWords(b)} ${when}${this.bendDetail(b)}${more}, then `;
  }

  /** "road bends right", "sharp bend left", "road curves right" */
  private bendWords(bend: { turn: number }): string {
    const a = Math.abs(bend.turn);
    const side = bend.turn < 0 ? 'left' : 'right';
    return a >= 110 ? `sharp bend ${side}` : a < 45 ? `road curves ${side}` : `road bends ${side}`;
  }

  /** For walkers: ", about 60 degrees, over 30 metres". Faster vehicles keep it short. */
  private bendDetail(bend: { turn: number; length: number }): string {
    if (this.vehicle.id !== 'walker') return '';
    const over = bend.length >= 20 ? `, over ${fmtDistance(bend.length, this.settings.units)}` : '';
    return `, about ${deg5(bend.turn)} degrees${over}`;
  }

  /** A roundabout at (or just beyond) the junction ahead, with its exits in order. */
  private roundaboutAhead(a: Ahead): Roundabout | null {
    const w = this.world!;
    let entry: GNode | null = w.onRing(a.node) ? a.node : null;
    if (!entry) {
      // slip roads often split from the approach a little before the ring
      let best = Infinity;
      for (const n of w.nodesNear(a.node.x, a.node.y, 30)) {
        if (!w.onRing(n) || !n.edges.some((e) => !e.way.roundabout)) continue;
        const d = dist(a.node.x, a.node.y, n.x, n.y);
        if (d > 3 && Math.abs(relAngle(a.arrival, bearingTo(a.node.x, a.node.y, n.x, n.y))) > 70) continue;
        if (d < best) {
          best = d;
          entry = n;
        }
      }
    }
    if (!entry) return null;
    return { ...this.world!.ringExits(entry, this.vehicle.canUse), entry };
  }

  /**
   * "Roundabout in 60 metres, 4 exits. Turn right to enter; traffic goes anticlockwise, so exits are
   * on your right. First exit Oak Street, right; second Main Street, straight on; ..."
   * Each exit's direction is where it leaves the ring, seen from the way you arrive.
   */
  private roundaboutText(rb: Roundabout, a: Ahead, lead?: string): string {
    const side = rb.clockwise ? 'left' : 'right';
    const cx = rb.nodes.reduce((t, n) => t + n.x, 0) / rb.nodes.length;
    const cy = rb.nodes.reduce((t, n) => t + n.y, 0) / rb.nodes.length;
    const list = rb.exits.map((x, i) => {
      const rel = relAngle(a.arrival, bearingTo(cx, cy, x.node.x, x.node.y));
      const r = Math.abs(rel);
      const lr = rel < 0 ? 'left' : 'right';
      const where = x.node === rb.entry || r >= 150 ? 'back the way you came' : r <= 30 ? 'straight on' : r <= 60 ? `bear ${lr}` : r >= 120 ? `sharp ${lr}` : lr;
      return `${i === 0 ? 'first exit' : ordinal(i + 1)} ${x.edge.way.name}, ${where}`;
    });
    const n = rb.exits.length;
    return (
      `${lead ?? `Roundabout in ${fmtDistance(a.forward, this.settings.units)}, `}${n} exit${n === 1 ? '' : 's'}. ` +
      `Turn ${side} to enter; traffic goes ${rb.clockwise ? 'clockwise' : 'anticlockwise'}, so exits are on your ${side}. ` +
      `${list.join('; ')}.`
    );
  }

  /** Progress round a roundabout: say each exit as it comes up, and ring the bell at it. */
  private updateRing() {
    if (this.vehicle.id === 'helicopter') return;
    const w = this.world!;
    const canUse = this.vehicle.canUse;
    const rh = w.nearestRoad(this.x, this.y, 30, (wy) => wy.roundabout && canUse(wy));
    let onRing = false;
    let near = false;
    if (rh) {
      const way = rh.seg.way;
      const flow = way.oneway && way.onewayReverse ? normDeg(rh.dir + 180) : rh.dir;
      const along = !way.oneway || Math.abs(relAngle(this.heading, flow)) < 60;
      const half = Math.min(5, roadHalfWidth(way.type)); // rings are narrower than the roads they carry
      onRing = along && rh.hit.dist <= half + 2;
      near = along && rh.hit.dist <= half + 4;
    }

    let r = this.ring;
    if (!r) {
      if (!onRing || this.speed < 0.3) return;
      r = this.ring = this.enterRing(rh!);
      this.inJunction = null;
      const side = r.clockwise ? 'left' : 'right';
      const first = r.exits[0];
      const mine = r.exits.findIndex((x) => this.routeLeavesAt(x));
      const yours = mine >= 0 ? ` Your exit is the ${ordinal(mine + 1)}, ${r.exits[mine].edge.way.name}.` : '';
      const n = r.exits.length;
      this.speech.say(`In the roundabout. ${n} exit${n === 1 ? '' : 's'}, on your ${side}.${first ? ` First, ${first.edge.way.name}.` : ''}${yours}`, 'high');
      return;
    }
    if (!near) {
      if (r.offSince < 0) r.offSince = this.clock;
      else if (this.clock - r.offSince > RING_EXIT_DELAY) {
        // off the ring for a moment, not just a swerve or a noisy fix, so it is left: the new street is announced as usual, and the soft blip plays once clear of the ring
        this.ring = null;
        this.inJunction = new Set(r.nodes.map((n) => n.id));
      }
      return;
    }
    r.offSince = -1;

    const prog = this.ringProgress(r);
    if (r.closed && prog < r.prog - r.length / 2) {
      // past the entry again: another lap
      r.next = 0;
      r.warned = -1;
      r.rung = -1;
    }
    r.prog = prog;
    while (r.next < r.exits.length && r.exits[r.next].at < prog - 3) r.next++;
    const x = r.exits[r.next];
    if (!x) return;
    const d = x.at - prog;
    const here = r.exits.filter((e) => e.node === x.node);
    const last = r.exits.indexOf(here[here.length - 1]);
    const ours = here.find((e) => this.routeLeavesAt(e));
    const rel = relAngle(this.heading, w.edgeBearing(x.node, (ours ?? x).edge));
    const side = rel < 0 ? 'left' : 'right';
    if (r.warned < r.next && d <= Math.max(12, this.speed * 2.5)) {
      r.warned = last;
      const names = [...new Set(here.map((e) => e.edge.way.name))].join(' or ');
      const num = here.length > 1 ? `Exits ${r.next + 1} and ${last + 1}` : `Exit ${r.next + 1}`;
      const tail = ours
        ? `, your exit. Turn ${side} to take it.`
        : x.node === r.entry
          ? ', back the way you came.'
          : `, on your ${side}.`;
      this.speech.say(`${num}, ${names}${tail}`, ours ? 'high' : 'normal');
    }
    if (r.rung < r.next && d <= this.turnZone(x.node)) {
      // the moment to turn off: bell, then a ping from each exit's direction
      r.rung = last;
      this.audio.atIntersection(here.map((e) => relAngle(this.heading, w.edgeBearing(e.node, e.edge))));
      if (ours) this.audio.turnCue(rel);
    }
  }

  /** Start following a roundabout we have just driven onto. */
  private enterRing(rh: RoadHit): RingState {
    const w = this.world!;
    const way = rh.seg.way;
    const { nodes } = w.ring(w.nodes.get(way.oneway && way.onewayReverse ? rh.seg.b : rh.seg.a)!);
    // the entry: the nearest node where a road joins (we have only just come in)
    let entry = nodes[0];
    let best = Infinity;
    for (const n of nodes) {
      const d = dist(this.x, this.y, n.x, n.y);
      if (d < best && n.edges.some((e) => !e.way.roundabout && this.vehicle.canUse(e.way))) {
        best = d;
        entry = n;
      }
    }
    const rx = w.ringExits(entry, this.vehicle.canUse);
    const closed = w.ring(entry).closed;
    const cum = [0];
    for (let i = 1; i < rx.nodes.length; i++) cum.push(cum[i - 1] + dist(rx.nodes[i - 1].x, rx.nodes[i - 1].y, rx.nodes[i].x, rx.nodes[i].y));
    const end = rx.nodes[rx.nodes.length - 1];
    const length = cum[cum.length - 1] + (closed ? dist(end.x, end.y, entry.x, entry.y) : 0);
    const idx = new Map(rx.nodes.map((n, i) => [n.id, i]));
    const exits = rx.exits.map((x) => ({ ...x, at: x.node === entry ? length : cum[idx.get(x.node.id) ?? 0] }));
    const r: RingState = { nodes: rx.nodes, cum, length, closed, entry, exits, clockwise: rx.clockwise, next: 0, warned: -1, rung: -1, prog: 0, offSince: -1 };
    r.prog = this.ringProgress(r);
    return r;
  }

  /**
   * Distance round the ring from the entry to where we are. Just before the entry (or just past
   * the end of a lap) it is negative, so the first exits still count as ahead.
   */
  private ringProgress(r: RingState): number {
    let best = Infinity;
    let prog = r.prog;
    const count = r.closed ? r.nodes.length : r.nodes.length - 1;
    for (let i = 0; i < count; i++) {
      const a = r.nodes[i];
      const b = r.nodes[(i + 1) % r.nodes.length];
      const h = pointSeg(this.x, this.y, a.x, a.y, b.x, b.y);
      if (h.dist < best) {
        best = h.dist;
        prog = r.cum[i] + h.t * dist(a.x, a.y, b.x, b.y);
      }
    }
    if (r.closed && prog > r.length - 15 && r.prog < r.length / 2) prog -= r.length;
    return prog;
  }

  /** Does the route leave the roundabout along this exit? */
  private routeLeavesAt(x: { node: GNode; edge: Edge }): boolean {
    const r = this.route;
    if (!r || this.offRouteSince >= 0) return false;
    // the route's nearest point to the exit node, looking a little way ahead
    let bestD = Infinity;
    let at = -1;
    for (let i = this.routeIdx; i < r.points.length && r.points[i].d < this.routeProg + 300; i++) {
      const p = r.points[i];
      const d = dist(p.x, p.y, x.node.x, x.node.y);
      if (d < bestD) {
        bestD = d;
        at = p.d;
      }
    }
    if (at < 0 || bestD > 8) return false;
    const t = pointAlong(r, at + 12);
    if (this.world!.nearestRoad(t.x, t.y, 4, (wy) => wy.roundabout)) return false; // the route still goes round
    return Math.abs(relAngle(this.world!.edgeBearing(x.node, x.edge), bearingTo(x.node.x, x.node.y, t.x, t.y))) < 40;
  }

  /** ", road bends left before it" when the road turns noticeably between here and there. */
  private bendText(arrival: number, from: number): string {
    const b = relAngle(from, arrival);
    if (Math.abs(b) < 30) return '';
    return `, road bends ${Math.abs(b) > 120 ? 'sharply ' : ''}${b < 0 ? 'left' : 'right'} before it`;
  }

  /**
   * "Dead end", or "Oak Street ends" when a path or smaller road carries on (walkers are never
   * blocked), or "Map data ends" where the road goes on beyond what has loaded.
   */
  private endWord(a: Ahead): string {
    if (a.mapEdge) return 'Map data ends';
    const usable = a.node.edges.filter((e) => this.vehicle.canUse(e.way)).length;
    const blocked = usable <= 1 && this.vehicle.id !== 'walker';
    return !blocked && a.arriveName ? `${a.arriveName} ends` : 'Dead end';
  }

  /**
   * Roads leaving the junction at n, relative to the direction you arrive (ref):
   * "Oak Street left and right; Main Street continues ahead". With compass, each gets "heading west".
   * Null if the junction offers nothing worth mentioning.
   */
  private junctionBranches(n: GNode, ref: number, arriveName: string, compass: boolean): string | null {
    const w = this.world!;
    const groups = new Map<string, string[]>();
    let hasAhead = false;
    let droppedBehind = false;
    const j = w.junction(n, this.filter, this.junctionRadius);
    const seen = new Set<string>();
    // if no road behind carries the name we arrived on (one-way, filtered), only the first one behind is taken as the road we came from
    const arrivedBehind = j.exits.some((x) => Math.abs(relAngle(ref, w.edgeBearing(x.from, x.edge))) > 150 && x.edge.way.name === arriveName);
    for (const { from, edge: e } of j.exits) {
      const b = w.edgeBearing(from, e);
      const rel = relAngle(ref, b);
      const a = Math.abs(rel);
      // the road we arrive on (both carriageways of a divided road)
      if (a > 150 && (e.way.name === arriveName || (!arrivedBehind && !droppedBehind))) {
        droppedBehind = true;
        continue;
      }
      const side = rel < 0 ? 'left' : 'right';
      let dir: string;
      if (a <= 25) {
        dir = 'ahead';
        hasAhead = true;
      } else if (a <= 60) dir = `bear ${side}`;
      else if (a <= 135) dir = side;
      else dir = `sharp ${side}`;
      const key = `${e.way.name}|${dir}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // walkers also hear the angle; faster vehicles get the short form
      let said = dir;
      if (this.vehicle.id === 'walker' && a >= 10) said = dir === 'ahead' ? `ahead, ${deg5(a)} degrees ${side}` : `${dir} ${deg5(a)} degrees`;
      if (!groups.has(e.way.name)) groups.set(e.way.name, []);
      groups.get(e.way.name)!.push(compass ? `${said} heading ${compass8(b)}` : said);
    }
    if (!groups.size) return null;
    const parts: string[] = [];
    for (const [name, dirs] of groups) {
      if (name === arriveName && dirs.length === 1 && dirs[0].startsWith('ahead')) {
        parts.push(`${name} continues ${dirs[0]}`);
      } else parts.push(`${name} ${dirs.join(' and ')}`);
    }
    if (!hasAhead) parts.push('no road straight ahead');
    return parts.join('; ');
  }

  private buzz(kind: string) {
    if (this.settings.haptics) buzz(kind);
  }

  private dark = false;
  private darkCheckedAt = -Infinity;

  /** Daylight is looked up at most every ten minutes, and only once an unlit path is close. */
  private isDarkNow(): boolean {
    if (this.clock - this.darkCheckedAt > 600) {
      this.darkCheckedAt = this.clock;
      void isDark(this.proj.toLatLon(this.x, this.y)).then((d) => (this.dark = d));
    }
    return this.dark;
  }

  private static readonly RADIUS_STEPS = [0.5, 1, 2, 3];

  /** A usual reach stretched by the player's setting, kept inside the area that is loaded. */
  private reach(base: number): number {
    // the map is a square loaded around where it last loaded, not around you: stay inside what is
    // left of it from here (but never below the usual reach, which was always allowed)
    const fromCentre = Math.max(Math.abs(this.x - this.loadCenter.x), Math.abs(this.y - this.loadCenter.y));
    const left = this.vehicle.loadRadius * 0.9 - fromCentre;
    return Math.min(base * this.settings.radiusScale, Math.max(base, left));
  }

  /** Ctrl ] and Ctrl [: announce places from farther or nearer. */
  private changeRadius(dir: 1 | -1) {
    const steps = Game.RADIUS_STEPS;
    const now = steps.reduce((best, s, i) => (Math.abs(s - this.settings.radiusScale) < Math.abs(steps[best] - this.settings.radiusScale) ? i : best), 0);
    const next = Math.max(0, Math.min(steps.length - 1, now + dir));
    if (next === now) return this.speech.say(dir > 0 ? 'Already at the farthest.' : 'Already at the nearest.', 'high');
    this.settings.radiusScale = steps[next];
    saveSettings(this.settings);
    this.speech.say(`Hearing places within ${fmtDistance(this.reach(this.vehicle.scanRadius), this.settings.units)}.`, 'high');
  }

  private lookOn = false;
  private lookHeading = NaN;
  private lookSince = 0;
  private lookSaid = NaN;

  /** Shift E: while on, point the phone a new way and hold still to hear what lies in that direction. */
  private toggleLookAround() {
    this.lookOn = !this.lookOn;
    this.lookHeading = this.lookSaid = NaN;
    this.speech.say(this.lookOn ? 'Look around on. Stand still, hold the phone flat, point its top a way and hold for a second.' : 'Look around off.', 'high');
  }

  /** Shift I: what lies the way you are heading, said once. While walking the heading follows your steps, so the phone can stay in a pocket. */
  private lookAhead() {
    this.speech.say(this.lookText(this.heading), 'high');
  }

  private checkLookAround() {
    if (!this.lookOn) return;
    // with live GPS, only while standing with the phone held to point: walking, the heading is the
    // way you go, and every turn would set it off; in a pocket the phone points nowhere
    if (this.live && this.liveFix && (this.liveFix.speed >= MIN_COURSE_SPEED || this.live.compass === null)) {
      this.lookHeading = NaN;
      return;
    }
    const moved = Number.isNaN(this.lookHeading) || Math.abs(relAngle(this.lookHeading, this.heading)) > 15;
    if (moved) {
      this.lookHeading = this.heading;
      this.lookSince = this.clock;
      return;
    }
    if (this.clock - this.lookSince < 1 || (!Number.isNaN(this.lookSaid) && Math.abs(relAngle(this.lookSaid, this.heading)) <= 25)) return;
    this.lookSaid = this.heading;
    this.audio.tick(true);
    this.speech.say(this.lookText(this.heading), 'high');
  }

  /** The nearest places and the nearest intersection within 30 degrees of a direction, as speech. */
  private lookText(heading: number): string {
    const u = this.settings.units;
    const reach = this.reach(this.vehicle.scanRadius);
    const inCone = (x: number, y: number) => Math.abs(relAngle(heading, bearingTo(this.x, this.y, x, y))) <= 30;
    const items = this.nearby(reach)
      .filter(({ place }) => inCone(place.x, place.y))
      .slice(0, 3)
      .map(({ place, d }) => `${this.placeText(place)}, ${fmtDistance(d, u)}`);
    const w = this.world!;
    let best: { names: string[]; d: number } | null = null;
    for (const n of w.nodesNear(this.x, this.y, reach)) {
      const d = dist(this.x, this.y, n.x, n.y);
      if (d < 5 || (best && d >= best.d) || !inCone(n.x, n.y) || !w.isIntersection(n, this.filter)) continue;
      const names = [...new Set(n.edges.filter((e) => e.way.named && this.filter(e.way)).map((e) => e.way.name))];
      if (names.length > 1) best = { names, d };
    }
    if (best) items.push(`${best.names.slice(0, 2).join(' and ')}, ${fmtDistance(best.d, u)}`);
    return `${cap(compass8(heading))}: ${items.length ? items.join('. ') : `nothing mapped within ${fmtDistance(reach, u)}`}.`;
  }

  /** Standing at a crossing: what to wait for before stepping out, said once. */
  private checkAtCrossing() {
    if (!this.settings.announceHazards || this.vehicle.id !== 'walker' || this.speed > 0.5) return;
    const hit = this.world!.hazardsNear(this.x, this.y, 8).find((n) => crossingAdvice(n.hazard.text, n.hazard.extras ?? []));
    if (!hit) return;
    const h = hit.hazard;
    const key = `at|${Math.round(h.x)},${Math.round(h.y)}`;
    if (this.clock - (this.announcedHazards.get(key) ?? -1e9) < 120) return;
    this.announcedHazards.set(key, this.clock);
    this.speech.say(crossingAdvice(h.text, h.extras ?? []), 'high');
  }

  /** Crossings and steps just ahead, for walkers and cyclists. */
  private checkHazards() {
    if (!this.settings.announceHazards || this.speed < 0.3 || (this.vehicle.id !== 'walker' && this.vehicle.id !== 'bicycle')) return;
    const reach = this.vehicle.id === 'walker' ? 30 : 45;
    for (const { hazard: h, d } of this.world!.hazardsNear(this.x, this.y, reach)) {
      if (Math.abs(relAngle(this.heading, bearingTo(this.x, this.y, h.x, h.y))) > 35) continue;
      if (h.text === 'Steps' && this.road?.type === 'steps') continue;
      if (h.text === 'Unlit path' && !this.isDarkNow()) continue;
      const key = `${h.text}|${Math.round(h.x)},${Math.round(h.y)}`;
      if (this.clock - (this.announcedHazards.get(key) ?? -1e9) < 120) continue;
      this.announcedHazards.set(key, this.clock);
      this.audio.hazardCue(h.text, relAngle(this.heading, bearingTo(this.x, this.y, h.x, h.y)), 1 - Math.min(1, d / reach));
      this.buzz(h.text);
      const leg = h.text === 'Pedestrian crossing' || h.text === 'Crossing with signals' ? crossingLeg(this.world!, h.x, h.y, this.settings.units) : '';
      const extras = h.extras?.length ? `. ${cap(h.extras.join(', '))}` : '';
      this.speech.say(`${h.text} ahead, ${fmtDistance(d, this.settings.units)}${leg ? `, ${leg}` : ''}${extras}`, 'high');
      break;
    }
  }

  private checkPlaces() {
    if (!this.settings.announcePlaces || this.speed < 0.3) return;
    // faster vehicles pass places quicker, so leave longer between cues
    if (this.clock - this.lastPlaceSpoken < placeSpeechGap(this.speed)) return;
    for (const { place, d } of this.world!.placesNear(this.x, this.y, this.reach(this.vehicle.passRadius))) {
      if (!placeWanted(this.settings, this.vehicle.id, place)) continue;
      const last = this.announcedPlaces.get(place.id) ?? -1e9;
      if (this.clock - last < 180) continue;
      const rel = relAngle(this.heading, bearingTo(this.x, this.y, place.x, place.y));
      if (Math.abs(rel) > 120 && d > 10) continue; // already passed it
      this.announcedPlaces.set(place.id, this.clock);
      // nearer is louder and clearer; landmarks stand out over everyday places
      const far = Math.min(1, d / this.reach(this.vehicle.passRadius));
      const level = (0.1 + 0.2 * (1 - far)) * (placeTier(place) >= 2 ? 1.4 : 1) * cueLevelScale(this.speed, this.speaking);
      this.audio.placeCue(place.group, rel, level, undefined, far);
      const spot = this.placeDetail(place).short;
      this.speech.say(placeSpeech(place.name, spot ? `${place.category}, ${spot}` : place.category, sideWord(rel), d > 15 ? fmtDistance(d, this.settings.units) : '', this.speed), 'low');
      this.lastPlaceSpoken = this.clock;
      return;
    }
    this.checkBuildings();
  }

  /**
   * Walking: named buildings and grounds within 20 m (from OpenStreetMap; the tiles carry no
   * names), once each. Not the one you are in, and not one a nearby place of the same name covers.
   */
  private checkBuildings() {
    if (this.vehicle.id !== 'walker') return;
    this.loadNamed();
    const reach = 20;
    for (const a of this.named?.items ?? []) {
      if (this.x < a.minX - reach || this.x > a.maxX + reach || this.y < a.minY - reach || this.y > a.maxY + reach) continue;
      const key = `area:${a.name}`;
      if (this.clock - (this.announcedPlaces.get(key) ?? -1e9) < 300) continue;
      if (inRings([a.ring], this.x, this.y)) continue; // inside it
      // the nearest point of its outline
      let best: { d: number; x: number; y: number } | null = null;
      for (let i = 0, j = a.ring.length - 1; i < a.ring.length; j = i++) {
        const h = pointSeg(this.x, this.y, a.ring[j].x, a.ring[j].y, a.ring[i].x, a.ring[i].y);
        if (!best || h.dist < best.d) best = { d: h.dist, x: h.px, y: h.py };
      }
      if (!best || best.d > reach) continue;
      const kind = a.building ? 'building' : a.kind ?? 'grounds';
      const place = { group: 'other', category: kind } as Place;
      if (!placeWanted(this.settings, this.vehicle.id, place)) return;
      if (this.world!.placesNear(best.x, best.y, 40).some((n) => n.place.name === a.name)) continue;
      const rel = relAngle(this.heading, bearingTo(this.x, this.y, best.x, best.y));
      if (Math.abs(rel) > 120 && best.d > 5) continue; // already passed it
      this.announcedPlaces.set(key, this.clock);
      const far = best.d / reach;
      this.audio.placeCue('other', rel, (0.1 + 0.2 * (1 - far)) * cueLevelScale(this.speed, this.speaking), undefined, far);
      this.speech.say(placeSpeech(a.name, kind, sideWord(rel), best.d > 15 ? fmtDistance(best.d, this.settings.units) : '', this.speed), 'low');
      this.lastPlaceSpoken = this.clock;
      return;
    }
  }

  /** On arrival: which way the entrance (or, failing that, the place itself) is. */
  private arrivalHint(t: Target): string {
    const place = this.world?.places.find((p) => p.id === t.placeId);
    const door = place?.entrances
      ?.map((e) => ({ e, d: dist(this.x, this.y, e.x, e.y) }))
      .sort((a, b) => a.d - b.d)[0];
    const to = door ? door.e : t;
    const d = dist(this.x, this.y, to.x, to.y);
    const side = sideWord(relAngle(this.heading, bearingTo(this.x, this.y, to.x, to.y)));
    const u = this.settings.units;
    if (door) return ` The ${door.e.label ?? (door.e.main ? 'main entrance' : 'nearest entrance')} is ${fmtDistance(d, u)} ${side}.`;
    return d < 4 ? '' : ` It is ${fmtDistance(d, u)} ${side}.`;
  }

  private get arriveRadius() {
    return this.vehicle.id === 'helicopter' ? 60 : this.vehicle.id === 'car' ? 25 : 12;
  }

  private updateDestination() {
    if (!this.dest) return;
    const d = dist(this.x, this.y, this.dest.x, this.dest.y);
    if (d < Math.max(this.arriveRadius, this.dest.radius ?? 0)) {
      this.audio.arrival();
      this.buzz('arrival');
      const done = this.trip ? ` Trip: ${this.tripText(this.trip)}. Press U to hear it again.` : '';
      this.lastTrip = this.trip ? `Last trip to ${this.dest.name}: ${this.tripText(this.trip)}.` : '';
      this.speech.say(`Arrived at ${this.dest.name}.${this.arrivalHint(this.dest)}${done}`, 'high');
      this.trip = null;
      this.dest = null;
      this.map.setDestination(null);
      this.clearRoute();
      return;
    }
    // grid steps do not follow the route, so in grid mode the beacon points straight at the destination
    const r = this.grid ? null : this.route;
    const remaining = r && !r.partial ? r.length - this.routeProg : d;
    if (this.settings.beaconSound && this.clock >= this.nextBeacon) {
      const closeness = Math.max(0, 1 - remaining / 500);
      this.nextBeacon = this.clock + 0.35 + (1 - closeness) * 1.4;
      // with a route, aim a little way along it so following the beacon follows the streets
      const look = this.vehicle.id === 'walker' ? 15 : Math.max(25, this.speed * 2);
      const aim = r ? pointAlong(r, this.routeProg + look) : this.dest;
      // grid mode always faces north, so this is a compass bearing: high for north, right for east
      this.audio.beacon(relAngle(this.heading, bearingTo(this.x, this.y, aim.x, aim.y)), closeness);
    }
    // progress updates at distance milestones
    const mark = MILESTONES.find((m) => remaining <= m);
    if (mark !== undefined && mark < this.destMilestone) {
      this.destMilestone = mark;
      this.speech.say(`${this.dest.name}, ${fmtDistance(remaining, this.settings.units)}${r ? ' to go' : ` ${this.dirTo(this.dest.x, this.dest.y)}`}.`, 'low');
    }
  }

  // ---------------- turn-by-turn ----------------

  private routeOptions(): RouteOptions {
    const canUse = this.vehicle.canUse;
    switch (this.vehicle.id) {
      case 'car':
        return {
          canUse,
          obeyOneway: true,
          minFactor: 0.5,
          uTurnPenalty: 300,
          costFactor: (w) =>
            ({ motorway: 0.5, trunk: 0.55, primary: 0.6, secondary: 0.7, tertiary: 0.8, living_street: 1.5, service: 2 } as Record<string, number>)[
              w.type.replace('_link', '')
            ] ?? 1,
        };
      case 'bicycle':
        return {
          canUse,
          obeyOneway: false,
          minFactor: 0.7,
          uTurnPenalty: 60,
          costFactor: (w) => (w.type === 'cycleway' ? 0.7 : w.type === 'primary' || w.type === 'trunk' ? 1.3 : 1),
        };
      default: {
        // walkers prefer named streets over unnamed paths so directions stay easy to follow;
        // "streets only" makes paths, tracks and alleys costly enough to use only when needed
        const streets = this.settings.walkRoute === 'streets';
        const offStreet = ['footway', 'path', 'track', 'service', 'cycleway', 'steps'];
        return {
          canUse,
          obeyOneway: false,
          minFactor: 1,
          uTurnPenalty: 15,
          costFactor: (w) =>
            streets
              ? offStreet.includes(w.type) && !w.named ? 5 : w.type === 'steps' ? 3 : 1
              : w.type === 'steps' ? 1.5 : !w.named && ['footway', 'path', 'track', 'service'].includes(w.type) ? 1.4 : 1,
        };
      }
    }
  }

  /** Plan the route, first loading the streets toward the destination if it is beyond the loaded map. */
  private prepareLocal(announce: boolean) {
    const t = this.dest;
    if (!t || !this.world) return;
    if (!this.settings.turnByTurn || this.vehicle.id === 'helicopter') return this.clearRoute();
    const c = this.routeWorld;
    const corridorReady = c && c.vehicle === this.vehicle.id && this.inBox(c, t.x, t.y) && this.inBox(c, this.x, this.y);
    if (corridorReady || this.inLoadedArea(t.x, t.y)) return this.planLocal(announce);
    if (this.corridorLoading) return;
    const d = dist(this.x, this.y, t.x, t.y);
    if (d > CORRIDOR[this.vehicle.id].max) {
      this.routeTooFar = true;
      this.clearRoute();
      if (announce) {
        this.speech.say(
          `The route planner is unavailable and the destination is too far to plan offline, ${fmtDistance(d, this.settings.units)} away. The beacon points straight at it.`,
          'normal',
        );
      }
      return;
    }
    void this.loadCorridor(announce);
  }

  /** Load the streets in a rectangle covering the traveller and the destination, then route on them. */
  private async loadCorridor(announce: boolean) {
    const t = this.dest!;
    const vehicle = this.vehicle.id;
    this.corridorAbort?.abort();
    const abort = (this.corridorAbort = new AbortController());
    const pad = 400;
    const box = {
      minX: Math.min(this.x, t.x) - pad,
      minY: Math.min(this.y, t.y) - pad,
      maxX: Math.max(this.x, t.x) + pad,
      maxY: Math.max(this.y, t.y) + pad,
    };
    this.clearRoute();
    this.corridorLoading = true;
    if (announce) this.speech.say('Loading the streets toward the destination. Follow the beacon for now.', 'normal');
    const sw = this.proj.toLatLon(box.minX, box.minY);
    const ne = this.proj.toLatLon(box.maxX, box.maxY);
    try {
      const raw = await fetchRoadsBox(sw.lat, sw.lon, ne.lat, ne.lon, CORRIDOR[vehicle].types, abort.signal);
      if (abort.signal.aborted || this.dest !== t || this.vehicle.id !== vehicle) return;
      this.routeWorld = { world: new World(this.proj, raw), vehicle, ...box };
      this.corridorLoading = false;
      this.planLocal(true);
    } catch (e) {
      if (abort.signal.aborted) return;
      console.error(e);
      this.speech.say('Could not load the streets toward the destination. Follow the beacon.', 'normal');
    } finally {
      if (this.corridorAbort === abort) this.corridorLoading = false;
    }
  }

  private dropCorridor() {
    this.routeReq++;
    this.routePending = false; // the request it belonged to is now superseded, and its finally will not clear it
    this.corridorAbort?.abort();
    this.corridorAbort = null;
    this.corridorLoading = false;
    this.routeWorld = null;
    this.routeTooFar = false;
  }

  /** Inside a rectangle, at least 50 m from its edges. */
  private inBox(b: { minX: number; minY: number; maxX: number; maxY: number }, x: number, y: number): boolean {
    return x > b.minX + 50 && x < b.maxX - 50 && y > b.minY + 50 && y < b.maxY - 50;
  }

  /** Inside the square of map loaded around the traveller (with a safety margin). */
  private inLoadedArea(x: number, y: number): boolean {
    const r = this.vehicle.loadRadius * 0.85;
    return Math.abs(x - this.loadCenter.x) < r && Math.abs(y - this.loadCenter.y) < r;
  }

  /**
   * Plan (or re-plan) the route: the online router first (any distance, no map loading needed),
   * then the loaded map as an offline fallback.
   */
  private async computeRoute(announce: boolean) {
    this.lastRouteCalc = this.clock;
    const t = this.dest;
    if (!t || !this.world || !this.settings.turnByTurn || this.vehicle.id === 'helicopter') return this.clearRoute();
    const req = ++this.routeReq;
    const vehicle = this.vehicle.id;
    if (hasOnlineRouting(vehicle)) {
      this.routePending = true;
      try {
        const r = await fetchOnlineRoute(
          vehicle,
          this.proj,
          { x: this.x, y: this.y, heading: this.heading },
          t,
          (x, y, dir) => this.namedRoadNear(x, y, dir),
          undefined,
          this.settings.walkRoute === 'streets',
          this.settings.accessibleRoute,
        );
        if (req !== this.routeReq || this.dest !== t || this.vehicle.id !== vehicle) return; // superseded
        if (r) return this.useRoute(r, announce);
      } catch (e) {
        if (req !== this.routeReq) return;
        console.warn('Online routing unavailable, using the loaded map', e);
      } finally {
        if (req === this.routeReq) this.routePending = false;
      }
    }
    this.prepareLocal(announce);
  }

  /** Spoken text for a manoeuvre; names an unnamed path after the street beside it once that area has loaded. */
  private stepText(m: Maneuver, destName: string): string {
    if (m.nameAt && !m.onto.startsWith('path along')) {
      const along = this.namedRoadNear(m.nameAt.x, m.nameAt.y, m.nameDir);
      if (along) m.onto = `path along ${along}`;
    }
    return maneuverText(m, destName);
  }

  /**
   * Name of the nearest named street within 25 m. With a direction, the street must run roughly
   * parallel to it, so a path that only crosses near a street isn't described as running along it.
   */
  private namedRoadNear(x: number, y: number, dir?: number, radius = 25, tol = 35): string | null {
    for (const w of [this.world, this.routeWorld?.world]) {
      if (!w) continue;
      const named = (wy: Way) => wy.named;
      const hit = dir === undefined ? w.nearestRoad(x, y, radius, named) : w.nearestRoadAlong(x, y, radius, dir, tol, named);
      if (hit) return hit.seg.way.name;
    }
    return null;
  }

  /**
   * A step that only moves between a street and its own sidewalk (or along that street's sidewalk)
   * isn't a turn for the traveller, who follows the street itself. Such steps are not announced.
   */
  private isTrivial(m: Maneuver): boolean {
    if (m.trivial !== undefined) return m.trivial;
    if (m.kind === 'arrive' || m.kind === 'roundabout') return false;
    const ontoStreet = m.ontoNamed ? m.onto : (this.stepText(m, ''), m.onto.startsWith('path along ') ? m.onto.slice(11) : null);
    // coming from: the street we were right beside, even via a short diagonal link between sidewalks
    const fromStreet = m.fromName || (m.fromAt ? this.namedRoadNear(m.fromAt.x, m.fromAt.y, m.fromDir, 12, 60) : null);
    if (!ontoStreet || !fromStreet) return false; // not known yet; decide again once that area has loaded
    if (m.ontoNamed && m.fromName) return (m.trivial = false); // a real street to a real street
    return (m.trivial = ontoStreet === fromStreet);
  }

  /** The next manoeuvre worth announcing, at or after index i. */
  private nextRealIndex(i: number): number {
    const ms = this.route?.maneuvers ?? [];
    while (i < ms.length && this.isTrivial(ms[i])) i++;
    return i;
  }

  private upcoming(): Maneuver | undefined {
    return this.route?.maneuvers[this.nextRealIndex(this.nextMan)];
  }

  /** Route on the loaded map data (offline fallback). */
  private planLocal(announce: boolean) {
    this.lastRouteCalc = this.clock;
    if (!this.dest || !this.world || !this.settings.turnByTurn || this.vehicle.id === 'helicopter') return this.clearRoute();
    const c = this.routeWorld;
    const graph = c && c.vehicle === this.vehicle.id && this.inBox(c, this.x, this.y) ? c.world : this.world;
    const r = planRoute(graph, { x: this.x, y: this.y, heading: this.heading }, this.dest, this.routeOptions());
    if (!r) {
      this.clearRoute();
      if (announce) this.speech.say('No route found from here. Follow the beacon.', 'normal');
      return;
    }
    this.useRoute(r, announce);
  }

  /** Start guidance along a planned route, optionally announcing it. */
  private useRoute(r: Route, announce: boolean) {
    const dest = this.dest!;
    this.route = r;
    this.routeIdx = 0;
    this.routeProg = 0;
    this.furthestProg = 0;
    this.nextMan = 0;
    this.spokenSteps.clear();
    this.offRouteSince = -1;
    this.map.setRoute(r.points.map((p) => this.proj.toLatLon(p.x, p.y)));
    this.markCrossings();
    if (!announce) return;
    const u = this.settings.units;
    const first = r.maneuvers[this.nextRealIndex(0)];
    const startAim = pointAlong(r, 15);
    const turnAround = Math.abs(relAngle(this.heading, bearingTo(this.x, this.y, startAim.x, startAim.y))) > 120 ? 'Turn around. ' : '';
    const walker = this.vehicle.id === 'walker';
    const kind = `${walker && this.settings.accessibleRoute ? 'Accessible ' : ''}${walker && this.settings.walkRoute === 'streets' ? 'street route' : 'route'}`.replace(/^./, (ch) => ch.toUpperCase());
    const lead = `${kind} ${fmtDistance(r.length, u)}${r.partial ? ', as far as the map has loaded; it will extend as you go' : ''}. `;
    const step =
      first.kind === 'arrive'
        ? r.partial
          ? 'Follow this road.'
          : `${dest.name} is ${fmtDistance(first.d, u)} along this road.`
        : `${this.stepWhen(first, first.d)}.`;
    // the instruction was just given: don't repeat the early reminders
    const th = this.stepThresholds;
    for (let k = 0; k < 2; k++) if (first.d <= th[k]) this.spokenSteps.add(k);
    this.speech.say(turnAround + lead + step, 'normal');
  }

  /**
   * I: the next instruction. Pressed twice quickly: the next three, each with the distance
   * from the one before, so the sequence can be pictured in order.
   */
  private instructions() {
    const now = performance.now();
    const double = now - this.lastIPress < 400;
    this.lastIPress = double ? -Infinity : now; // a third quick press starts over
    if (!this.dest) return this.speech.say(`No destination. Press ${this.keyText('navigate')} to choose one.`, 'high');
    if (this.grid) return this.speech.say(`Turn by turn pauses in grid mode. ${this.dest.name} is ${this.gridOffset(this.dest.x, this.dest.y)}; follow the beacon.`, 'high');
    const r = this.route;
    if (!r) {
      const why = !this.settings.turnByTurn
        ? `Turn by turn is off; press ${this.keyText('turnByTurn')} to turn it on.`
        : this.vehicle.id === 'helicopter'
          ? 'No turn by turn in the helicopter; follow the beacon.'
          : this.routePending
            ? 'Planning the route, one moment.'
            : this.corridorLoading
            ? 'Still loading the streets toward the destination. Follow the beacon for now.'
            : this.routeTooFar
              ? `The route planner is unavailable and ${this.dest.name} is too far to plan offline. Follow the beacon.`
              : 'No route found; follow the beacon.';
      return this.speech.say(why, 'high');
    }
    const u = this.settings.units;
    const steps = r.maneuvers.slice(this.nextMan).filter((m) => !(m.kind === 'arrive' && r.partial) && !this.isTrivial(m));
    if (!steps.length) {
      return this.speech.say(
        r.partial
          ? `Follow this road for ${fmtDistance(r.length - this.routeProg, u)}; more of the route loads as you go.`
          : `Arriving at ${this.dest.name}.`,
        'high',
      );
    }
    const parts: string[] = this.routeBehind() ? ['Turn around'] : [];
    let at = this.routeProg;
    for (const m of steps.slice(0, double ? 3 : 1)) {
      const gap = Math.max(0, m.d - at);
      const text = this.stepText(m, this.dest.name);
      parts.push(at > this.routeProg ? `Then after ${fmtDistance(gap, u)}, ${text}` : this.stepWhen(m, gap));
      at = m.d;
    }
    if (double && steps.length <= 3 && r.partial) parts.push('The route continues as more map loads');
    this.speech.say(parts.join('. ') + '.', 'high');
  }

  /** D twice: walking routes along streets only, or the shortest way (which may use footpaths). */
  private toggleWalkRoute() {
    this.settings.walkRoute = this.settings.walkRoute === 'streets' ? 'shortest' : 'streets';
    saveSettings(this.settings);
    const what = this.settings.walkRoute === 'streets' ? 'Walking routes: streets only.' : 'Walking routes: shortest, may use footpaths.';
    if (this.vehicle.id !== 'walker') return this.speech.say(`${what} This applies when walking.`, 'high');
    if (this.dest && this.settings.turnByTurn) {
      this.speech.say(`${what} Re-planning.`, 'high');
      void this.computeRoute(true);
    } else this.speech.say(what, 'high');
  }

  /** Shift A: walking routes that avoid steps and steep slopes. */
  private toggleAccessibleRoute() {
    this.settings.accessibleRoute = !this.settings.accessibleRoute;
    saveSettings(this.settings);
    const what = `Accessible walking routes ${this.settings.accessibleRoute ? 'on: avoiding steps and steep slopes' : 'off'}.`;
    if (this.vehicle.id !== 'walker') return this.speech.say(`${what} This applies when walking.`, 'high');
    if (this.dest && this.settings.turnByTurn) {
      this.speech.say(`${what} Re-planning.`, 'high');
      void this.computeRoute(true);
    } else this.speech.say(what, 'high');
  }

  /**
   * Walking: add "cross <street>" steps where the route crosses a named street (see addCrossings),
   * with how the crossing is controlled. Run again as more map loads, since a crossing can only be
   * found where the streets are loaded.
   */
  private markCrossings() {
    const r = this.route;
    if (!r || this.vehicle.id !== 'walker') return;
    const found: StreetCrossing[] = [];
    const check = (a: { x: number; y: number; d: number }, b: { x: number; y: number; d: number }) => {
      for (const w of [this.world, this.routeWorld?.world]) {
        for (const h of w?.streetsCrossed(a.x, a.y, b.x, b.y) ?? []) {
          const d = a.d + h.t * (b.d - a.d);
          // both halves of a divided road, or the same street from two loaded maps: one crossing
          if (found.some((c) => c.name === h.name && Math.abs(c.d - d) < 30)) continue;
          found.push({ d, x: h.x, y: h.y, name: h.name, via: this.crossingVia(h.x, h.y), kerb: roadHalfWidth(h.type) });
        }
      }
    };
    const pts = r.points;
    for (let i = 0; i + 1 < pts.length; i++) {
      check(pts[i], pts[i + 1]);
      // a bend right on a street's centre line (routes along centre lines, straight through an
      // intersection): from just before it to just after it crosses the street; turning onto it does not
      if (i === 0 || i + 1 >= pts.length) continue;
      const p = pts[i];
      const near = (q: { x: number; y: number; d: number }) => {
        const k = Math.min(1, 2 / Math.max(0.01, Math.abs(q.d - p.d)));
        return { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k, d: p.d + (q.d - p.d) * k };
      };
      check(near(pts[i - 1]), near(pts[i + 1]));
    }
    found.sort((a, b) => a.d - b.d);
    addCrossings(r, found);
    this.nextMan = r.maneuvers.findIndex((m) => m.d >= this.routeProg - 3);
    if (this.nextMan < 0) this.nextMan = r.maneuvers.length;
  }

  /** "at the signals, audible signal" from a crossing mapped within 15 m. */
  private crossingVia(x: number, y: number): string | undefined {
    const h = this.world?.hazardsNear(x, y, 15).find((n) => n.hazard.text === 'Crossing with signals' || n.hazard.text === 'Pedestrian crossing')?.hazard;
    if (!h) return undefined;
    return [h.text === 'Crossing with signals' ? 'at the signals' : 'at the crossing', ...(h.extras ?? [])].join(', ');
  }

  private clearRoute() {
    this.route = null;
    this.map.setRoute(null);
  }

  private toggleTurnByTurn() {
    this.settings.turnByTurn = !this.settings.turnByTurn;
    saveSettings(this.settings);
    if (!this.settings.turnByTurn) {
      this.clearRoute();
      return this.speech.say('Turn by turn off. The beacon points straight to the destination.', 'high');
    }
    if (this.vehicle.id === 'helicopter') {
      return this.speech.say('Turn by turn on, but not available in the helicopter. The beacon points straight to the destination.', 'high');
    }
    if (!this.dest) return this.speech.say(`Turn by turn on. Press ${this.keyText('navigate')} to choose a destination.`, 'high');
    this.speech.say('Turn by turn on.', 'high');
    void this.computeRoute(true);
  }

  /** Shift M: open the destination in the maps app for its turn-by-turn, and keep to naming what is around. */
  private openInMaps() {
    if (!this.dest) return this.speech.say(`No destination. Press ${this.keyText('navigate')} to choose one.`, 'high');
    const to = this.proj.toLatLon(this.dest.x, this.dest.y);
    const url = mapsUrl(to.lat, to.lon, this.vehicle.id);
    if (!url) return this.speech.say('The helicopter has no roads to hand over. Switch to walking first.', 'high');
    window.open(url, '_blank');
    // the maps app now gives the directions; two voices telling the turns would only confuse
    this.settings.turnByTurn = false;
    saveSettings(this.settings);
    this.clearRoute();
    this.speech.say(`Opening ${this.dest.name} in your maps app. Turn by turn here is off; places and intersections are still announced. ${this.keyText('turnByTurn')} turns it back on.`, 'high');
  }

  /** Distances (m) before a manoeuvre at which it is spoken: early, closer, now. Faster travel hears them earlier. */
  private get stepThresholds(): [number, number, number] {
    const s = (ref: number) => paceScale(this.speed, ref);
    switch (this.vehicle.id) {
      case 'walker':
        return [60 * s(1.4), 25 * s(1.4), 14 * s(1.4)];
      case 'bicycle':
        return [150 * s(5), 50 * s(5), Math.max(15, this.speed * 2.5)];
      default:
        return [400 * s(14), 150 * s(14), Math.max(30, this.speed * 2.5)];
    }
  }

  /** The route's next turn, if it is at the junction made of these nodes. */
  private routeTurnAt(nodes: GNode[]): Maneuver | null {
    if (!this.route || this.offRouteSince >= 0) return null;
    const m = this.upcoming();
    if (!m || !this.turnAtJunction(m)) return null;
    return nodes.some((n) => dist(n.x, n.y, m.x, m.y) <= 10) ? m : null;
  }

  /** Is this turn at an intersection, where arriving in it gives the "turn here" cue? */
  private turnAtJunction(m: Maneuver): boolean {
    if (m.kind === 'arrive' || m.kind === 'roundabout' || m.kind === 'cross') return false;
    const w = this.world!;
    return w.nodesNear(m.x, m.y, 10).some((n) => w.isIntersection(n, this.filter));
  }

  /**
   * "at the second intersection, " for a turn with other intersections before it: the ones whose
   * bell you will hear on the way. Empty when there are none or too many to be useful.
   */
  private whichIntersection(m: Maneuver): string {
    const r = this.route;
    if (!r || !this.turnAtJunction(m)) return '';
    const w = this.world!;
    const keys = new Set<number>();
    const turnNodes = w.nodesNear(m.x, m.y, 10).filter((n) => w.isIntersection(n, this.filter));
    const turnKeys = new Set(turnNodes.map((n) => this.junctionKey(n)));
    for (let d = this.routeProg + 2; d < m.d; d += 4) {
      const p = pointAlong(r, d);
      for (const n of w.nodesNear(p.x, p.y, 20)) {
        if (this.inJunction?.has(n.id) || !w.isIntersection(n, this.filter)) continue;
        if (dist(n.x, n.y, p.x, p.y) > this.turnZone(n) || dist(n.x, n.y, m.x, m.y) <= 10) continue;
        if (w.onRing(n)) return ''; // roundabouts on the way would make the count unclear
        const k = this.junctionKey(n);
        if (!turnKeys.has(k)) keys.add(k);
      }
    }
    if (keys.size > 3) return '';
    return keys.size === 0 ? 'at the next intersection, ' : `at the ${ordinal(keys.size + 1)} intersection, `;
  }

  /** The instruction for turn m, with the one after it if that follows closely. */
  private stepWithThen(m: Maneuver): string {
    const r = this.route!;
    const dest = this.dest?.name ?? '';
    const text = this.stepText(m, dest);
    const n2 = r.maneuvers[this.nextRealIndex(r.maneuvers.indexOf(m) + 1)];
    const then = n2 && n2.d - m.d < 60 && !(n2.kind === 'arrive' && r.partial) ? `, then ${this.stepText(n2, dest)}` : '';
    return text + then;
  }

  /** Is the next turn on the route within d metres? */
  private routeTurnWithin(d: number): boolean {
    const m = this.upcoming();
    return !!m && m.kind !== 'arrive' && m.d - this.routeProg < d;
  }

  private updateRoute() {
    const r = this.route!;
    const dest = this.dest;
    if (!dest) return this.clearRoute();
    const u = this.settings.units;

    // progress: nearest point on the route, searching a window around the last position
    let best = Infinity;
    let bi = this.routeIdx;
    let bt = 0;
    const hi = Math.min(r.points.length - 1, this.routeIdx + 80);
    for (let i = Math.max(0, this.routeIdx - 3); i < hi; i++) {
      const a = r.points[i];
      const b = r.points[i + 1];
      const h = pointSeg(this.x, this.y, a.x, a.y, b.x, b.y);
      if (h.dist < best) {
        best = h.dist;
        bi = i;
        bt = h.t;
      }
    }
    this.routeIdx = bi;
    const a = r.points[bi];
    const b = r.points[Math.min(bi + 1, r.points.length - 1)];
    this.routeProg = a.d + bt * (b.d - a.d);

    // off the route: re-plan after a short grace period
    const tolerance = this.vehicle.id === 'walker' ? 30 : this.vehicle.id === 'bicycle' ? 25 : 30;
    if (best > tolerance) {
      if (this.offRouteSince < 0) this.offRouteSince = this.clock;
      else if (this.clock - this.offRouteSince > 2.5 && this.clock - this.lastRouteCalc > 5 && !this.routePending) {
        this.speech.say('Off route. Recalculating.', 'high');
        void this.computeRoute(true);
      }
      return;
    }
    this.offRouteSince = -1;

    // travelling back along the route: the wrong way
    if (this.routeProg > this.furthestProg || this.speed < 0.5) this.furthestProg = Math.max(this.furthestProg, this.routeProg);
    else if (this.furthestProg - this.routeProg > Math.max(15, this.speed * 2) && this.clock - this.lastWrongWay > 15) {
      this.lastWrongWay = this.clock;
      this.furthestProg = this.routeProg;
      this.audio.wrongWay();
      this.buzz('wrongWay');
      this.speech.say('Wrong way. Turn around.', 'high');
    }

    // a route that stops at the edge of the loaded map: extend it as we approach the end
    if (r.partial && r.length - this.routeProg < 150 && this.clock - this.lastRouteCalc > 5) {
      void this.computeRoute(false);
      return;
    }

    const th = this.stepThresholds;
    // manoeuvres we have passed
    while (this.nextMan < r.maneuvers.length && r.maneuvers[this.nextMan].d < this.routeProg - 3) {
      const passed = r.maneuvers[this.nextMan++];
      if (this.isTrivial(passed)) continue; // stepping onto the sidewalk: nothing to say
      this.spokenSteps.clear();
      const next = r.maneuvers[this.nextRealIndex(this.nextMan)];
      // entering a roundabout: the exits are called out on the way round instead
      if (next && passed.kind !== 'arrive' && passed.kind !== 'roundabout') {
        const gap = next.d - this.routeProg;
        if (gap > th[1] * 1.4) {
          // say what comes next now, instead of a separate early reminder moments later
          const then = next.kind === 'arrive' && r.partial ? '' : `, then ${this.stepText(next, dest.name)}`;
          this.stepText(passed, dest.name); // fills in the street name of an unnamed path if now known
          const along = passed.ontoNamed ? `on ${passed.onto}` : passed.onto.startsWith('path along ') ? passed.onto.slice(5) : 'straight';
          this.speech.say(`Continue ${along} for ${fmtDistance(gap, u)}${then}.`, 'normal');
          if (gap <= th[0] * 1.5) this.spokenSteps.add(0);
        }
      }
    }
    const mi = this.nextRealIndex(this.nextMan);
    const m = r.maneuvers[mi];
    if (!m || (m.kind === 'arrive' && r.partial)) return;
    const d = m.d - this.routeProg;
    const atJunction = this.turnAtJunction(m);
    // a crossing's last call comes at the kerb, as you step up to cross, not by pace
    const at = m.kind === 'cross' ? [th[0], th[1], (m.kerb ?? 0) + 3] : th;
    for (let k = 2; k >= 0; k--) {
      if (d > at[k] || this.spokenSteps.has(k)) continue;
      // a turn at an intersection is called when you are in that intersection (checkInJunction),
      // not by distance, which could fall on a side street just before it
      if (k === 2 && atJunction) continue;
      // a crossing is said on the approach and again at the kerb, with what follows it
      if (m.kind === 'cross' && k === 0) continue;
      if (k < 2 && d <= at[k + 1] * 1.4) continue; // the closer reminder is coming up anyway
      for (let j = 0; j <= k; j++) this.spokenSteps.add(j); // never say an earlier reminder after a later one
      const text = this.stepWithThen(m);
      if (k < 2) {
        this.speech.say(`In ${fmtDistance(d, u)}, ${this.whichIntersection(m)}${text}.`, k === 0 ? 'normal' : 'high');
      } else if (m.kind !== 'arrive') {
        if (m.kind !== 'roundabout' && m.kind !== 'cross') {
          this.audio.turnCue(m.rel); // its overall direction isn't the way to turn in
          this.buzz(m.rel < 0 ? 'left' : 'right');
        }
        this.speech.say(`${cap(text)}.`, 'high');
      }
      break;
    }
  }

  // ---------------- keyboard ----------------

  private command(c: Command): boolean | void {
    if (this.onKey?.(c)) return;
    if (!this.world && c.key !== 'Escape' && c.key !== 'F1') {
      if (!c.repeat) this.speech.say(this.loading ? 'Still loading map data.' : 'No map loaded. Press Escape for the menu.', 'high');
      return;
    }
    const u = this.settings.units;
    if (this.grid && this.gridCommand(c)) return;
    switch (c.code) {
      case 'ArrowUp':
      case 'ArrowDown':
      case 'Slash':
        if (!c.repeat) this.speedAtPress = this.speed;
        return;
      case 'ArrowLeft':
      case 'ArrowRight': {
        if (c.repeat || (this.live && this.liveFix)) return;
        const dir = c.code === 'ArrowLeft' ? -1 : 1;
        if (c.ctrl) return this.snapTurn(dir);
        this.turnedDuringHold = false;
        this.turn(dir * (c.shift ? 10 : 1));
        this.turnHold = { dir, since: this.clock };
        return;
      }
    }
    if (c.repeat && c.code !== 'Tab') return;

    const action = lookup(c, this.settings.keyBindings);
    if (!action) return false;
    switch (action) {
      case 'stopSpeech':
        this.speech.stop();
        return;
      case 'menu':
        this.onMenu?.('main');
        return;
      case 'help':
        return this.help();
      case 'calibrate':
        return this.calibrate();
      case 'toggleGrid':
        return this.toggleGrid();
      case 'heading':
        return this.speech.say(`Facing ${compass8(this.heading)}, ${Math.round(this.heading)} degrees.`, 'high');
      case 'speed':
        return this.speech.say(
          this.speed < 0.1 ? 'Stopped.' : `${fmtSpeed(this.speed, u)}.`,
          'high',
        );
      case 'toggleLive':
        return void this.toggleLive();
      case 'location':
        return this.speech.say(this.locationText(), 'high');
      case 'nextIntersection':
      case 'prevIntersection': {
        const back = action === 'prevIntersection';
        // pressed twice quickly: move there
        const now = performance.now();
        const double = now - this.lastNPress < 400 && this.lastNShift === back;
        this.lastNPress = double ? -Infinity : now; // a third quick press starts over
        this.lastNShift = back;
        if (this.grid) return this.gridIntersection(double, back);
        if (double) return this.jump(back ? -1 : 1);
        return back ? this.previousIntersection() : this.nextIntersection();
      }
      case 'stepForward':
        return this.stepIntersection(1);
      case 'settings':
        return this.onMenu?.('settings');
      case 'stepBack':
        return this.stepIntersection(-1);
      case 'proximityBeeps':
        this.settings.proximityBeeps = !this.settings.proximityBeeps;
        saveSettings(this.settings);
        return this.speech.say(`Intersection beeps ${this.settings.proximityBeeps ? 'on' : 'off'}.`, 'high');
      case 'beacon':
        this.settings.beaconSound = !this.settings.beaconSound;
        saveSettings(this.settings);
        return this.speech.say(`Beacon sound ${this.settings.beaconSound ? 'on' : 'off'}.`, 'high');
      case 'turnByTurn':
        return this.toggleTurnByTurn();
      case 'instructions':
        return this.instructions();
      case 'whatsAround':
        return this.whatsAround();
      case 'conditions': {
        const at = this.position;
        if (!at) return;
        this.speech.say('Checking conditions.', 'low');
        void conditionsReport(at, this.settings.units).then((t) => this.speech.say(t, 'high'));
        return;
      }
      case 'sonar':
        return this.sonar();
      case 'nextPlace':
        return this.browsePlaces(1);
      case 'prevPlace':
        return this.browsePlaces(-1);
      case 'setDestination':
        return this.setDestination();
      case 'destinationInfo':
        return this.destinationInfo();
      case 'clearDestination':
        return this.clearDestination();
      case 'filter':
        return this.cycleFilter();
      case 'note':
        return this.onNote?.();
      case 'deleteNote':
        return this.deleteNote();
      case 'osmNote':
        return this.onOsmNote?.(this.proj.toLatLon(this.x, this.y));
      case 'share':
        return void this.shareLink();
      case 'openInMaps':
        return this.openInMaps();
      case 'radiusUp':
        return this.changeRadius(1);
      case 'radiusDown':
        return this.changeRadius(-1);
      case 'lookAround':
        return this.toggleLookAround();
      case 'lookAhead':
        return this.lookAhead();
      case 'exportRoute':
        return this.exportRoute();
      case 'sos':
        return void this.sos();
      case 'saveOffline':
        return void this.saveOffline();
      case 'tripSummary':
        return this.tripSummary();
      case 'whereAmI':
        return void this.whereAmI();
      case 'preview':
        return this.routePreview();
      case 'transit':
        return this.nearestTransit();
      case 'nearestAccess':
        return this.nearestAccess();
      case 'departures':
        return this.departures();
      case 'facilities':
        return this.facilities();
      case 'saveFavorite':
        return this.saveFavorite();
      case 'align':
        if (this.grid) return this.speech.say('Grid mode always faces north. F3 leaves it.', 'high');
        return this.alignToRoad();
      case 'search':
        this.onMenu?.('search');
        return;
      case 'jump':
        this.onJump?.();
        return;
      case 'saveRoute':
        return this.onSaveRoute?.();
      case 'routes':
        return this.onRoutes?.();
      case 'navigate':
        return this.onNavigate?.();
      case 'distance': {
        // pressed twice quickly: switch walking routes between shortest and streets only
        const now = performance.now();
        const double = now - this.lastDPress < 400;
        this.lastDPress = double ? -Infinity : now;
        return double ? this.toggleWalkRoute() : this.distanceToGo();
      }
      case 'mapRotation':
        this.settings.headingUpMap = !this.settings.headingUpMap;
        this.map.headingUp = this.settings.headingUpMap;
        saveSettings(this.settings);
        return this.speech.say(this.settings.headingUpMap ? 'Map rotates with heading.' : 'Map north up.', 'high');
      case 'accessibleRoute':
        return this.toggleAccessibleRoute();
      case 'roadAssist':
        this.settings.roadAssist = !this.settings.roadAssist;
        saveSettings(this.settings);
        return this.speech.say(`Road assist ${this.settings.roadAssist ? 'on' : 'off'}.`, 'high');
      case 'soundProfile':
        this.settings.soundProfile = nextProfile(this.settings.soundProfile);
        this.settings.vehicleProfiles = { ...this.settings.vehicleProfiles, [this.vehicle.id]: this.settings.soundProfile };
        saveSettings(this.settings);
        return this.speech.say(PROFILE_TEXT[this.settings.soundProfile], 'high');
      case 'announcePlaces':
        this.settings.announcePlaces = !this.settings.announcePlaces;
        saveSettings(this.settings);
        return this.speech.say(`Place announcements ${this.settings.announcePlaces ? 'on' : 'off'}.`, 'high');
      case 'reviewBack':
        return this.speech.review(-1);
      case 'reviewNext':
        return this.speech.review(1);
      case 'walker':
      case 'bicycle':
      case 'car':
      case 'helicopter':
        return this.setVehicle(action, true);
      case 'volumeUp':
      case 'volumeDown': {
        const v = Math.max(0, Math.min(1, this.settings.volume + (action === 'volumeUp' ? 0.1 : -0.1)));
        this.settings.volume = Math.round(v * 10) / 10;
        this.audio.setVolume(this.settings.volume);
        saveSettings(this.settings);
        return this.speech.say(`Volume ${Math.round(this.settings.volume * 100)} percent.`, 'high');
      }
    }
    return false;
  }

  private keyUp(code: string) {
    if (!this.world || this.grid) return;
    if (code === 'ArrowUp' || code === 'ArrowDown' || code === 'Slash') {
      if (this.input.isDown('ArrowUp') || this.input.isDown('ArrowDown') || this.input.isDown('Slash')) return;
      if (Math.abs(this.speed - this.speedAtPress) < 0.2) return;
      this.speech.say(this.speed < 0.1 ? 'Stopped.' : fmtSpeedShort(this.speed, this.settings.units), 'high');
    } else if ((code === 'ArrowLeft' || code === 'ArrowRight') && this.turnedDuringHold) {
      this.turnedDuringHold = false;
      if (this.settings.announceHeadingAfterTurn) {
        this.speech.say(`${Math.round(this.heading)}, ${compass8(this.heading)}`, 'high');
      }
    }
  }

  private speaking = false;
  private calibrationTimers: number[] = [];

  /** Says "left", plays a tone there, then the same for right and ahead. */
  private calibrate() {
    this.calibrationTimers.forEach(clearTimeout);
    this.speech.say('Headphone check. You should hear each tone from the side named.', 'high');
    // timed for the default rate; a slower built-in voice needs longer so "Left" does not cut off the intro
    const slow = this.settings.speechMode === 'voice' ? Math.max(1, 1.3 / this.settings.voiceRate) : 1;
    this.calibrationTimers = ([['Left', -90], ['Right', 90], ['Ahead', 0]] as const).flatMap(([word, rel], i) => [
      window.setTimeout(() => this.speech.say(word, 'high'), (4000 + i * 2200) * slow),
      window.setTimeout(() => this.audio.testTone(rel), (4000 + i * 2200) * slow + 800),
    ]);
  }

  setTheme(theme: SoundTheme) {
    this.settings.soundTheme = theme;
    this.audio.setTheme(this.settings.soundTheme);
    saveSettings(this.settings);
    this.audio.loaded();
    this.speech.say(`Sound theme switched to ${theme}.`, 'high');
  }

  private help() {
    this.speech.say(
      'Up arrow accelerate, down arrow slow down, slash brake. Left and right turn 1 degree, with shift 10 degrees; hold to keep turning. ' +
        'Control left or right turns onto the next road; at a roundabout it turns you in, and takes the exit you are at. R aligns with the road and says how much it bends. ' +
        'H heading, S speed, L location, Shift L live GPS: your real position and compass move you, N distance to the next intersection, Shift N the one behind you; press either twice to move there, stopping at bends too. Period and comma step forward and back through intersections ahead, W what is around, Shift W weather and daylight, Space sonar sweep. ' +
        'F3 grid mode: arrows step north, south, west and east with a sound for the ground, minus and equals change the step, Space says where you are. ' +
        'Control J jumps to a place. Shift Q saves this trip as a named route, Q lists saved routes. ' + `${this.keyText('navigate')} searches for a destination. ` + 'D says the distance to go, D twice switches walking routes between shortest and streets only, ' + `${this.keyText('turnByTurn')} toggles turn by turn directions,` + ' I says the next instruction, I twice the next three, B toggles the beacon sound, Shift B the intersection beeps. Tab cycles nearby places, Enter sets one as destination, C shows only one kind of place in W, Space and Tab. V leaves a spoken note here, Shift V deletes it, Control V reports a wrong or missing road or place to OpenStreetMap. Z copies a link to this spot and route, Shift Z saves the route as a GPX file, Shift S saves the map here for offline use. U says how the trip went. E says where you are with the nearest landmark and stop, and the way back to the route if you have left it. Shift E turns look around on: stand still, hold the phone flat and point it a way to hear what lies there. Shift I says what lies ahead, the way you are walking. Shift M opens the destination in your maps app for its directions. Control right bracket hears places from farther, Control left bracket from nearer. Shift K says your address and shares your location as a map link. O previews the whole route. X sets the nearest bus stop or station as destination, again for the next. Shift X says the nearest entrances, platforms and lifts, Shift O the nearest toilets, bench, drinking water, shelter, post box and cash machine. Shift T reads the next departures when you stand at a stop, using the open Transitous feed, which covers much of Europe, North America and Australia. G destination info, Backspace clears it. Y saves the destination or where you are; Control D lists saved places. Control Shift P opens the command palette: type to find any action. ' +
        '1 to 4 change vehicle. Control comma opens settings. A toggles road assist. Shift P cycles sound profiles. Sound themes are chosen in settings or from the command palette. P toggles place announcements. Left and right bracket review messages. Control stops speech. ' +
        'Shift H plays a headphone check: a tone left, right, then ahead. Page up and down change volume. F searches for a location. Escape opens the menu.',
      'high',
    );
  }

  private locationText(area = this.areaName): string {
    const parts: string[] = [];
    if (this.streetName) {
      let s = `On ${this.streetName}`;
      const near = this.nearestCrossStreet();
      if (near) s += `, near ${near.name}, ${fmtDistance(near.d, this.settings.units)} ${near.where}`;
      parts.push(s);
    } else {
      const hit = this.world!.nearestRoad(this.x, this.y, 150, (w) => w.named);
      parts.push(
        hit
          ? `Off road. ${hit.seg.way.name} is ${fmtDistance(hit.hit.dist, this.settings.units)} ${this.dirTo(hit.hit.px, hit.hit.py)}`
          : 'Off road, no streets nearby',
      );
    }
    parts.push(`facing ${compass8(this.heading)}`);
    if (area) parts.push(area);
    return parts.join('. ') + '.';
  }

  private nearestCrossStreet(): { name: string; d: number; where: string } | null {
    const w = this.world!;
    let best: { name: string; d: number; where: string } | null = null;
    for (const n of w.nodesNear(this.x, this.y, 120)) {
      if (!w.isIntersection(n, this.filter)) continue;
      const other = n.edges.find((e) => e.way.named && e.way.name !== this.streetName && this.filter(e.way));
      if (!other) continue;
      const d = dist(this.x, this.y, n.x, n.y);
      if (!best || d < best.d) {
        const rel = relAngle(this.heading, bearingTo(this.x, this.y, n.x, n.y));
        best = { name: other.way.name, d, where: Math.abs(rel) < 90 ? 'ahead' : 'behind' };
      }
    }
    return best;
  }

  /** A stable id for a junction (smallest member node id). */
  private junctionKey(n: GNode): number {
    let k = Infinity;
    for (const m of this.world!.junction(n, this.filter, this.junctionRadius).nodes) k = Math.min(k, m.id);
    return k;
  }

  /** Short name for a junction: the cross streets, e.g. "Oak Street" or "Oak Street and King Street". */
  private junctionLabel(a: Ahead): string {
    if (a.mapEdge) return 'end of the loaded map';
    if (a.deadEnd) return this.endWord(a).toLowerCase().startsWith('dead') ? 'dead end' : `end of ${a.arriveName}`;
    const names: string[] = [];
    for (const { edge } of this.world!.junction(a.node, this.filter, this.junctionRadius).exits) {
      const nm = edge.way.name;
      if (nm !== a.arriveName && edge.way.named && !names.includes(nm)) names.push(nm);
    }
    if (names.length) return names.slice(0, 2).join(' and ');
    return a.arriveName ? `${a.arriveName} junction` : 'intersection';
  }

  /** Full spoken description of a junction ahead; lead is e.g. "Next intersection in 120 metres". */
  private describeAhead(a: Ahead, lead: string, bendFrom: number): string {
    const bend = this.bendText(a.arrival, bendFrom);
    if (a.deadEnd) return `${lead}${bend}: ${this.endWord(a).toLowerCase()}.`;
    const sig = this.world!.junction(a.node, this.filter, this.junctionRadius).signals;
    const branches = this.junctionBranches(a.node, a.arrival, a.arriveName, true) ?? 'no turns';
    return `${lead}${bend}${sig ? ', traffic signals' : ''}. ${branches}.`;
  }

  /**
   * N: live distance to the next intersection along the road. The first press for an intersection
   * describes it fully; repeated presses for the same one give just the distance, so it can be used
   * as a countdown while moving. N also brings the step cursor (. and ,) back to this intersection.
   */
  private nextIntersection() {
    const u = this.settings.units;
    this.stepCursor = null;
    const rg = this.ring;
    if (rg) {
      const x = rg.exits[rg.next];
      if (!x) return this.speech.say('No more exits; carry on round.', 'high');
      const rel = relAngle(this.heading, this.world!.edgeBearing(x.node, x.edge));
      const ours = this.routeLeavesAt(x) ? ', your exit' : '';
      return this.speech.say(
        `Exit ${rg.next + 1} of ${rg.exits.length}, ${x.edge.way.name}${ours}, in ${fmtDistance(Math.max(0, x.at - rg.prog), u)}, on your ${rel < 0 ? 'left' : 'right'}.`,
        'high',
      );
    }
    const a = this.nextAlongRoad(1500);
    if (!a) {
      this.lastN = null;
      return this.speech.say(this.onRoad ? `No intersection within ${fmtDistance(1500, u)} along this road.` : 'No intersection ahead.', 'high');
    }
    const key = this.junctionKey(a.node);
    for (const m of this.world!.junction(a.node, this.filter, this.junctionRadius).nodes) this.announcedNodes.set(m.id, this.clock);
    // bends on the way there come first, with the exact turn; otherwise a rough "road bends left before it"
    const bends = this.bendsBefore(a);
    const lead = this.bendsLead(bends);
    const vague = bends.length ? '' : this.bendText(a.arrival, this.heading);
    if (this.lastN === key) {
      if (a.deadEnd) return this.speech.say(cap(`${lead}${fmtDistance(a.forward, u)}, ${this.junctionLabel(a)}.`), 'high');
      const branches = this.junctionBranches(a.node, a.arrival, a.arriveName, false) ?? this.junctionLabel(a);
      return this.speech.say(cap(`${lead}${fmtDistance(a.forward, u)}: ${branches}.`), 'high');
    }
    this.lastN = key;
    const rb = a.deadEnd ? null : this.roundaboutAhead(a);
    if (rb) return this.speech.say(cap(lead + this.roundaboutText(rb, a)), 'high');
    const rel = relAngle(this.heading, bearingTo(this.x, this.y, a.node.x, a.node.y));
    const where = a.forward < 15 || Math.abs(rel) <= 15 ? 'straight ahead' : `at ${clockDir(rel)}`;
    const note = this.routeNote(a);
    if (a.deadEnd) {
      const end = this.endWord(a);
      const more = a.mapEdge ? (this.loading ? ' More map is loading.' : ' More loads as you go.') : '';
      return this.speech.say(cap(`${lead}${lead && end !== 'Map data ends' && end !== 'Dead end' ? end : lead ? end.toLowerCase() : end} in ${fmtDistance(a.forward, u)}, ${where}${vague}.${more}${note}`), 'high');
    }
    this.speech.say(cap(this.describeAhead(a, `${lead}next intersection in ${fmtDistance(a.forward, u)}, ${where}`, bends.length ? a.arrival : this.heading)) + note, 'high');
  }

  /** For N: where the route goes, when it doesn't simply follow this road to what N describes. */
  private routeNote(a: Ahead): string {
    const r = this.route;
    if (!r || this.offRouteSince >= 0) return '';
    if (this.routeBehind()) return ' Your route is behind you.';
    const m = this.upcoming();
    if (!m || (m.kind === 'arrive' && r.partial)) return '';
    const d = m.d - this.routeProg;
    if (d >= a.forward - 10 || dist(m.x, m.y, a.node.x, a.node.y) < 15) return '';
    const u = this.settings.units;
    if (m.kind === 'arrive') return ` ${this.dest?.name ?? 'Your destination'} comes first, in ${fmtDistance(d, u)}.`;
    return ` Your route leaves this road before then: in ${fmtDistance(d, u)}, ${this.stepText(m, this.dest?.name ?? '')}.`;
  }

  /** Does the route go the other way from where we are facing? */
  private routeBehind(): boolean {
    const r = this.route;
    if (!r || this.offRouteSince >= 0 || r.length - this.routeProg < 10) return false;
    const t = pointAlong(r, this.routeProg + 15);
    if (dist(this.x, this.y, t.x, t.y) < 3) return false;
    return Math.abs(relAngle(this.heading, bearingTo(this.x, this.y, t.x, t.y))) > 120;
  }

  /**
   * N twice (Shift+N twice for back): move along the road to the next intersection or bend,
   * whichever comes first. You land at the intersection facing the way you arrived, or just
   * before the bend still facing along the road, so you choose the turn (Control + arrow).
   */
  private jump(dir: 1 | -1) {
    const u = this.settings.units;
    if (this.vehicle.id === 'helicopter') return this.speech.say('Moving by intersection needs a road; not in the helicopter.', 'high');
    if (this.ring) return this.speech.say('In a roundabout. N gives the next exit.', 'high');
    if (this.live && this.liveFix) return this.speech.say('Live GPS is moving you. Shift L turns it off.', 'high');
    const w = this.world!;
    const back = dir < 0;
    const s = this.roadStart(20, this.filter, back ? normDeg(this.heading + 180) : this.heading);
    if (!s) return this.speech.say('Not on a road.', 'high');
    const name = s.hit.seg.way.name;
    const skip = this.inJunction;
    const isStop = (n: GNode) => w.isIntersection(n, this.filter) && !skip?.has(n.id);
    const line = w.roadLine(s.hit.hit.px, s.hit.hit.py, s.from, s.to, name, this.filter, isStop, 1500);
    const end = line.pts[line.pts.length - 1];

    // the first bend: not the one we are standing at, nor one that is part of the junction
    const { span, minTurn } = this.bendParams(0);
    let bend: { at: number; turn: number; length: number; keys: string[] } | null = null;
    for (let from = 2, guard = 0; guard < 50; guard++) {
      const b = findBend(line.pts, minTurn, span, from);
      if (!b || (line.stopped && end.d - (b.at + b.length) < 12)) break;
      if (b.keys.some((k) => this.jumpBend.has(k))) {
        from = b.at + b.length + 1;
        continue;
      }
      bend = b;
      break;
    }
    const street = this.streetName;
    const moved = (d: number) => `Moved ${back ? 'back ' : ''}${fmtDistance(Math.max(1, d), u)}`;
    const onto = () => (this.streetName && this.streetName !== street ? `, on ${this.streetName}` : '');

    if (bend) {
      const p = alongLine(line.pts, Math.max(0, bend.at - 1));
      this.place(p.x, p.y, back ? normDeg(p.dir + 180) : p.dir, null);
      this.jumpBend = new Set(bend.keys);
      for (const k of bend.keys) this.announcedBends.set(k, this.clock);
      if (back) {
        // we now stand just past it; driven this way it turns the other way
        const b = { ...bend, turn: -bend.turn };
        const kind = Math.abs(b.turn) >= 110 ? 'sharp ' : '';
        return this.speech.say(`${moved(bend.at)}${onto()}, to just after a ${kind}${b.turn < 0 ? 'left' : 'right'} bend${this.bendDetail(b)}.`, 'high');
      }
      const key = bend.turn < 0 ? 'Left' : 'Right';
      const hint = this.jumpHinted ? '' : ` Control ${key} turns with it.`;
      this.jumpHinted = true;
      return this.speech.say(`${moved(bend.at)}${onto()}. ${cap(this.bendWords(bend))} ahead${this.bendDetail(bend)}.${hint}`, 'high');
    }
    if (line.stopped) {
      const node = w.nodesNear(end.x, end.y, 0.5).find((n) => w.isIntersection(n, this.filter));
      if (node) {
        const q = alongLine(line.pts, Math.max(0, end.d - 15));
        const arrival = bearingTo(q.x, q.y, end.x, end.y);
        const facing = back ? normDeg(arrival + 180) : arrival;
        const j = w.junction(node, this.filter, this.junctionRadius);
        this.place(node.x, node.y, facing, j);
        const a: Ahead = { node, forward: 0, arrival: facing, deadEnd: false, arriveName: name };
        const rb = this.roundaboutAhead(a);
        if (rb) return this.speech.say(`${moved(end.d)}, to a roundabout. ${this.roundaboutText(rb, a, '')}`, 'high');
        const branches = this.junctionBranches(node, facing, name, false) ?? 'no turns';
        const label = this.junctionLabel(a);
        return this.speech.say(`${moved(end.d)}, to ${label === 'intersection' ? 'an intersection' : label}${j.signals ? ', traffic signals' : ''}. ${branches}.`, 'high');
      }
    }
    if (line.deadEnd) {
      if (end.d < 5) return this.speech.say(line.mapEdge ? 'This is the edge of the loaded map.' : back ? 'This is the start of the road.' : 'The road ends here.', 'high');
      const p = alongLine(line.pts, Math.max(0, end.d - 2));
      this.place(p.x, p.y, back ? normDeg(p.dir + 180) : p.dir, null);
      const where = line.mapEdge ? `the edge of the loaded map${this.loading ? '; more is loading' : ''}` : 'where the road ends';
      return this.speech.say(`${moved(end.d)}${onto()}, to ${where}.`, 'high');
    }
    this.speech.say(`No intersection or bend within ${fmtDistance(1500, u)}${back ? ' behind you' : ''}.`, 'high');
  }

  private stopLive() {
    this.live?.stop();
    this.live = null;
    this.liveFix = null;
    this.gpsEst = null;
    this.gpsPoor = false;
    this.speed = 0;
  }

  /** Live GPS on or off. Must run from a key press so iOS allows the compass prompt. */
  private async toggleLive() {
    if (this.live) {
      this.stopLive();
      return this.speech.say('Live GPS off. Keyboard control.', 'high');
    }
    const live = new LiveGps(
      (f) => void this.onGpsFix(live, f),
      (p) => {
        if (this.live !== live) return;
        if (p === 'nosignal') {
          return this.speech.say(this.liveFix ? 'No GPS signal. Staying at the last known position.' : 'No GPS signal yet. Keyboard control until a location arrives.', 'high');
        }
        this.stopLive();
        this.speech.say(p === 'denied' ? 'Location permission denied. Live GPS off.' : 'This device has no location support. Live GPS off.', 'high');
      },
      () => this.live === live && this.speech.say('GPS signal back.', 'normal'),
    );
    this.live = live;
    const gridOff = !!this.grid;
    this.exitGrid();
    this.speech.say(`${gridOff ? 'Grid mode off. ' : ''}Live GPS on. Waiting for your location.${this.touch ? '' : ' The keyboard works until it arrives.'}`, 'high');
    await live.start();
  }

  private async onGpsFix(live: LiveGps, f: GpsFix) {
    // while the map restarts around the first fix, later fixes would mix the old and new projections
    if (this.live !== live || this.restartingForGps) return;
    const first = !this.liveFix;
    const acc = f.accuracy ?? DEFAULT_ACCURACY;
    const poor = acc > POOR_ACCURACY;
    if (poor !== this.gpsPoor) {
      this.gpsPoor = poor;
      this.speech.say(poor ? `GPS accuracy is poor, about ${fmtDistance(acc, this.settings.units)}.${first ? '' : ' Ignoring weak fixes.'}` : 'GPS accuracy is good again.', 'normal');
    }
    if (poor && !first) return;
    this.liveFix = f;
    const p0 = this.proj.toXY(f.lat, f.lon);
    this.gpsEst = fuse(this.gpsEst, p0.x, p0.y, acc, performance.now() / 1000, f.speed);
    if (!first) return;
    if (Math.hypot(p0.x, p0.y) > 20_000) {
      // projection distortion grows with distance, so begin afresh around the real position
      this.restartingForGps = true;
      try {
        await this.start({ lat: f.lat, lon: f.lon });
      } finally {
        this.restartingForGps = false;
      }
    }
    if (this.live !== live) return;
    const q = this.proj.toXY(f.lat, f.lon);
    this.gpsEst = { x: q.x, y: q.y, acc, t: performance.now() / 1000 };
    this.x = q.x;
    this.y = q.y;
    this.speech.say('Location found.', 'normal');
  }

  /** Put the traveller somewhere new along the roads, stopped, without the cues for getting there. */
  private place(x: number, y: number, heading: number, j: Junction | null) {
    this.x = x;
    this.y = y;
    this.heading = this.grid ? 0 : normDeg(Math.round(heading)); // grid mode stays north-up whatever moved us
    this.speed = 0;
    this.inJunction = j ? new Set(j.nodes.map((n) => n.id)) : null;
    if (j) for (const n of j.nodes) this.announcedNodes.set(n.id, this.clock);
    this.ring = null;
    this.lastN = null;
    this.stepCursor = null;
    this.jumpBend = new Set();
    this.ahead = null;
    this.wasOffRoad = false;
    this.updateRoad(true);
    if (this.route) this.relocateOnRoute();
  }

  /** After a jump: find our place on the route again, wherever along it that is. */
  private relocateOnRoute() {
    const r = this.route!;
    let best = Infinity;
    for (let i = 0; i + 1 < r.points.length; i++) {
      const a = r.points[i];
      const b = r.points[i + 1];
      const h = pointSeg(this.x, this.y, a.x, a.y, b.x, b.y);
      if (h.dist < best) {
        best = h.dist;
        this.routeIdx = i;
        this.routeProg = a.d + h.t * (b.d - a.d);
      }
    }
    this.nextMan = r.maneuvers.findIndex((m) => m.d >= this.routeProg - 3);
    if (this.nextMan < 0) this.nextMan = r.maneuvers.length;
    this.spokenSteps.clear();
    this.offRouteSince = -1;
    this.furthestProg = this.routeProg;
  }

  /** Shift+N: the last intersection behind you, described as you passed through it. */
  private previousIntersection() {
    const w = this.world!;
    const u = this.settings.units;
    const back = normDeg(this.heading + 180);
    const hit = this.vehicle.id !== 'helicopter' ? w.nearestRoad(this.x, this.y, 20, this.filter) : null;
    if (!hit) return this.speech.say('Not on a road.', 'high');
    if (this.inJunction) {
      const n = w.nodes.get([...this.inJunction][0])!;
      const branches = this.junctionBranches(n, this.heading, this.streetName ?? '', true) ?? 'no turns';
      return this.speech.say(`You are at an intersection. ${branches}.`, 'high');
    }
    const backwards = Math.abs(relAngle(back, hit.dir)) <= 90;
    const from = w.nodes.get(backwards ? hit.seg.a : hit.seg.b)!;
    const to = w.nodes.get(backwards ? hit.seg.b : hit.seg.a)!;
    const r = w.followRoad(from, to, dist(this.x, this.y, to.x, to.y), hit.seg.way.name, this.filter, (n) => w.isIntersection(n, this.filter), 1500);
    if (!r) return this.speech.say(`No intersection within ${fmtDistance(1500, u)} behind you.`, 'high');
    const rel = relAngle(this.heading, bearingTo(this.x, this.y, r.node.x, r.node.y));
    const where = Math.abs(rel) >= 165 ? 'directly behind' : `at ${clockDir(rel)}`;
    if (r.deadEnd) return this.speech.say(`Behind you, ${this.endWord({ ...r, forward: r.dist }).toLowerCase()} after ${fmtDistance(r.dist, u)}, ${where}.`, 'high');
    // describe it facing the way you were travelling when you went through it
    const forwardAtNode = normDeg(r.arrival + 180);
    const branches = this.junctionBranches(r.node, forwardAtNode, this.streetName ?? r.arriveName, true) ?? 'no turns';
    this.speech.say(`Last intersection, ${fmtDistance(r.dist, u)} behind you, ${where}. ${branches}.`, 'high');
  }

  /**
   * Period / comma: step forward or back through the intersections down the road, as if going
   * straight on. The list re-anchors to your position, so "from here" distances stay current.
   */
  private stepIntersection(dir: 1 | -1) {
    const u = this.settings.units;
    const live = this.nextAlongRoad(1500);
    if (!live) {
      this.stepCursor = null;
      return this.speech.say('No intersection ahead.', 'high');
    }
    // re-anchor: keep the list only if its first entry is still the next intersection (or we passed some)
    let c = this.stepCursor;
    if (c) {
      const liveKey = this.junctionKey(live.node);
      const at = c.list.findIndex((e) => e.key === liveKey);
      if (at < 0) c = null;
      else {
        c.list = c.list.slice(at);
        c.idx = Math.max(0, c.idx - at);
      }
    }
    if (!c) c = { list: [{ ahead: live, key: this.junctionKey(live.node), cum: 0, via: live.arriveName }], idx: 0 };
    c.list[0].ahead = live;
    this.stepCursor = c;

    if (dir < 0) {
      if (c.idx === 0) return this.speech.say('This is the next intersection. Shift N for the one behind you.', 'high');
      c.idx--;
    } else {
      if (c.idx + 1 >= c.list.length) {
        const next = this.stepFrom(c.list[c.idx]);
        if (typeof next === 'string') return this.speech.say(next, 'high');
        c.list.push(next);
      }
      c.idx++;
    }
    const e = c.list[c.idx];
    const fromHere = live.forward + e.cum;
    const lead =
      c.idx === 0
        ? `Next intersection, ${fmtDistance(fromHere, u)}`
        : `Intersection ${c.idx + 1}, ${fmtDistance(fromHere, u)} from here on ${e.via}`;
    const prevArrival = c.idx === 0 ? this.heading : c.list[c.idx - 1].ahead.arrival;
    this.speech.say(this.describeAhead(e.ahead, lead, prevArrival), 'high');
  }

  /** The intersection after `e`, continuing as straight as possible; a message if there is none. */
  private stepFrom(e: StepEntry): StepEntry | string {
    const w = this.world!;
    const u = this.settings.units;
    if (e.ahead.deadEnd) return 'The road ends there.';
    const j = w.junction(e.ahead.node, this.filter, this.junctionRadius);
    const members = new Set(j.nodes.map((n) => n.id));
    let best: { from: GNode; edge: Edge } | null = null;
    let bestScore = Infinity;
    for (const x of j.exits) {
      const turn = Math.abs(relAngle(e.ahead.arrival, w.edgeBearing(x.from, x.edge)));
      if (turn > 45) continue;
      const score = turn + (x.edge.way.name === e.ahead.arriveName ? 0 : 20);
      if (score < bestScore) {
        bestScore = score;
        best = x;
      }
    }
    if (!best) return 'No road continues straight after that intersection.';
    const to = w.nodes.get(best.edge.to)!;
    const r = w.followRoad(
      best.from,
      to,
      dist(best.from.x, best.from.y, to.x, to.y),
      best.edge.way.name,
      this.filter,
      (n) => w.isIntersection(n, this.filter) && !members.has(n.id),
      1500,
    );
    if (!r) return `No further intersection within ${fmtDistance(1500, u)}.`;
    const ahead: Ahead = { node: r.node, forward: r.dist, arrival: r.arrival, deadEnd: r.deadEnd, mapEdge: r.mapEdge, arriveName: r.arriveName };
    return { ahead, key: this.junctionKey(r.node), cum: e.cum + r.dist, via: best.edge.way.name };
  }

  /** Parking-sensor style beeps that quicken as the next intersection approaches. */
  private updateProximityBeeps() {
    const a = this.ahead;
    if (!this.settings.proximityBeeps || !extrasWanted(this.settings, this.vehicle.id) || !a || a.mapEdge || this.inJunction || this.ring || this.speed < 0.3 || this.vehicle.id === 'helicopter') return;
    const base = this.vehicle.id === 'walker' ? 25 : this.vehicle.id === 'bicycle' ? 35 : 40;
    const range = Math.min(120, Math.max(base, this.speed * 3));
    const d = a.forward - this.speed * (this.clock - this.aheadAt); // ahead is refreshed every 0.1 s
    if (d > range || d < 0) return;
    if (this.clock < this.nextProxBeep) return;
    const closeness = 1 - d / range;
    this.audio.proximityBeep(closeness, a.deadEnd);
    this.nextProxBeep = this.clock + 0.1 + 0.8 * (1 - closeness);
  }

  /** X: set the nearest bus stop or station as destination; again for the next nearest of five. */
  private nearestTransit() {
    const stops = this.transitStops().slice(0, 5);
    if (!stops.length) return this.speech.say('No bus stops or stations on the loaded map.', 'high');
    const cur = this.dest ? stops.findIndex(({ p }) => p.id === this.dest!.placeId) : -1;
    const { p } = stops[(cur + 1) % stops.length];
    this.setTarget(this.targetFor(p));
  }

  /** Shift O: the nearest toilets, bench, drinking water, shelter, post box and cash machine, each with direction and distance. */
  private facilities() {
    const nearest = new Map<string, { d: number; x: number; y: number }>();
    for (const f of this.world!.facilities) {
      const d = dist(this.x, this.y, f.x, f.y);
      if (d < (nearest.get(f.kind)?.d ?? Infinity)) nearest.set(f.kind, { d, x: f.x, y: f.y });
    }
    const list = [...nearest].sort((a, b) => a[1].d - b[1].d).map(([kind, f]) => `${cap(kind)}, ${fmtDistance(f.d, this.settings.units)} ${this.dirTo(f.x, f.y)}`);
    this.speech.say(list.length ? `${list.join('. ')}.` : 'No toilets, benches or other facilities on the loaded map.', 'high');
  }

  /** Shift X: say the nearest entrances, platforms and lifts with direction and distance. */
  private nearestAccess() {
    const u = this.settings.units;
    const list = this.world!.access
      .map((a) => ({ a, d: dist(this.x, this.y, a.x, a.y) }))
      .sort((p, q) => p.d - q.d)
      .slice(0, 4)
      .map(({ a, d }) => `${a.name ? `${a.kind} ${a.name}` : a.kind}, ${fmtDistance(d, u)} ${this.dirTo(a.x, a.y)}`);
    this.speech.say(list.length ? `${list.join('. ')}.` : 'No entrances, platforms or lifts on the loaded map.', 'high');
  }

  /** Shift T: read the next departures from a stop within a short walk. */
  private departures() {
    const stop = this.transitStops()[0];
    if (!stop || stop.d > 60) return this.speech.say('No departure data here. Stand next to a bus stop or station.', 'high');
    const ll = this.proj.toLatLon(stop.p.x, stop.p.y);
    this.speech.say('Checking departures.', 'low');
    void departuresReport(transitous, { name: stop.p.name, ...ll }).then((t) => this.speech.say(t, 'high'));
  }

  /** Stops and stations, nearest first; stops sharing a name nearby (the corners of one intersection) stay together. */
  private transitStops() {
    const list = this.world!.places.filter((p) => TRANSIT.has(p.category)).map((p) => ({ p, d: dist(this.x, this.y, p.x, p.y) }));
    const anchor = new Map<Place, number>();
    for (const s of list) {
      let a = s.d;
      for (const o of list) if (o.p.name === s.p.name && o.d < a && dist(o.p.x, o.p.y, s.p.x, s.p.y) < 250) a = o.d;
      anchor.set(s.p, a);
    }
    return list.sort((a, b) => anchor.get(a.p)! - anchor.get(b.p)! || a.d - b.d);
  }

  /** Where exactly a place is: always for stops and entrances, otherwise only when a place nearby shares its name. */
  private placeDetail(p: Place): { short: string; long: string } {
    let d = this.details.get(p.id);
    if (d) return d;
    const w = this.world!;
    const spot = () => {
      const ll = this.proj.toLatLon(p.x, p.y);
      return locate(w, p.x, p.y, this.settings.units, drivesOnLeft(ll.lat, ll.lon), p.name);
    };
    if (STOPS.has(p.category)) d = stopDetail(p, spot());
    else if (w.placesNear(p.x, p.y, 500).some(({ place: o }) => o !== p && o.name === p.name)) {
      const s = p.info?.address ? null : spot();
      const text = p.info?.address ? `at ${p.info.address}` : s ? spotText(s) : '';
      d = { short: text, long: text };
    } else d = { short: '', long: '' };
    this.details.set(p.id, d);
    return d;
  }

  /** "Green & Goodwin, bus stop, north-west corner" */
  private placeText(p: Place, long = false): string {
    const d = this.placeDetail(p)[long ? 'long' : 'short'];
    return `${p.name}, ${p.category}${d ? `, ${d}` : ''}`;
  }

  /** Where to guide to for a place: its main door, the nearest station entrance, or the place itself. */
  private targetFor(p: Place): Target {
    const t: Target = { name: p.name, x: p.x, y: p.y, placeId: p.id, detail: this.placeDetail(p).long || undefined };
    const nearer = (a: { x: number; y: number }, b: { x: number; y: number }) => dist(this.x, this.y, a.x, a.y) - dist(this.x, this.y, b.x, b.y);
    if (p.entrances?.length) {
      const mains = p.entrances.filter((e) => e.main);
      const e = [...(mains.length ? mains : p.entrances)].sort(nearer)[0];
      const s = locate(this.world!, e.x, e.y, this.settings.units);
      const access = e.wheelchair === 'yes' ? 'wheelchair accessible' : e.wheelchair === 'no' ? 'not wheelchair accessible' : '';
      const what = `${e.label ?? (e.main ? 'main entrance' : 'entrance')}${s ? ` on ${s.street}` : ''}`;
      return { ...t, x: e.x, y: e.y, detail: [what, access, t.detail].filter(Boolean).join(', ') };
    }
    if (p.category === 'station') {
      const ent = this.world!.placesNear(p.x, p.y, 400)
        .map((n) => n.place)
        .filter((q) => q.category === 'station entrance' && (q.name === p.name || q.name === 'Station entrance'))
        .sort(nearer)[0];
      if (ent) {
        const where = this.placeDetail(ent).long;
        return { ...t, x: ent.x, y: ent.y, detail: `nearest entrance${where ? `: ${where}` : ''}` };
      }
    }
    return t;
  }

  /** After choosing a stop: look up which lines call there and where they go. */
  private async lookUpLines(t: Target) {
    const node = this.world?.places.find((q) => q.id === t.placeId)?.info?.osmNode;
    if (!node) return;
    let text = this.stopLines.get(node);
    if (text === undefined) {
      try {
        text = routesText(await fetchStopRoutes(node));
      } catch {
        return; // the stop's route_ref, if any, was already spoken
      }
      this.stopLines.set(node, text);
    }
    if (!text || this.dest !== t) return;
    t.lines = text;
    this.speech.say(text, 'normal');
  }

  /** E: everything for when you are lost: street, area, nearest landmark and nearest transit stop. */
  private async whereAmI() {
    const u = this.settings.units;
    const at = (p: Place) => `${this.placeText(p, true)}, ${fmtDistance(dist(this.x, this.y, p.x, p.y), u)} ${this.dirTo(p.x, p.y)}`;
    const near = this.world!.placesNear(this.x, this.y, 400);
    const landmark = (near.find((n) => placeTier(n.place) >= 1) ?? near[0])?.place;
    const stop = this.transitStops()[0]?.p;
    const here = this.position;
    const area = here ? await Promise.race([reverseGeocode(here), new Promise<null>((r) => setTimeout(r, 2500))]) : null;
    const parts = [this.locationText(area ?? this.areaName)];
    const back = this.routeBackText();
    if (back) parts.push(back);
    const acc = this.live && this.gpsEst?.acc;
    if (acc && acc > 25) parts.push(`Your location is only accurate to about ${fmtDistance(acc, u)}, so street names may be off.`);
    if (landmark) parts.push(`Nearest landmark: ${at(landmark)}.`);
    if (stop) parts.push(`Nearest ${stop.category}: ${at(stop)}.`);
    this.speech.say(parts.join(' '), 'high');
  }

  /** Where the planned route is, when you have drifted from it; empty when there is no route or you are on it. */
  private routeBackText(): string {
    const pts = this.route?.points;
    if (!pts || pts.length < 2) return '';
    let best: ReturnType<typeof pointSeg> | null = null;
    for (let i = 0; i + 1 < pts.length; i++) {
      const h = pointSeg(this.x, this.y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
      if (!best || h.dist < best.dist) best = h;
    }
    if (!best || best.dist <= 30) return '';
    return `You are ${fmtDistance(best.dist, this.settings.units)} from your route. The way back is ${this.dirTo(best.px, best.py)}.`;
  }

  /** Shift K: say where you are, and share it with a trusted contact as a map link. Not a live feed. */
  private async sos() {
    const here = this.position;
    if (!here) return this.speech.say('No location yet to share.', 'high');
    const where = this.locationText().replace(/\.$/, '');
    const url = `https://www.openstreetmap.org/?mlat=${here.lat.toFixed(5)}&mlon=${here.lon.toFixed(5)}#map=18/${here.lat.toFixed(5)}/${here.lon.toFixed(5)}`;
    const text = `I need help. ${where}. Map: ${url}`;
    this.speech.say(`${where}. Coordinates ${here.lat.toFixed(5)}, ${here.lon.toFixed(5)}. Sharing your location now.`, 'high');
    const canShare = typeof navigator.share === 'function';
    try {
      if (canShare) await navigator.share({ title: 'I need help', text });
      else await navigator.clipboard.writeText(text);
      this.speech.say(canShare ? 'Location shared.' : 'Message copied. Paste it into a message to someone you trust.', 'high');
    } catch (e) {
      // closing the share sheet is not a failure
      if ((e as Error).name !== 'AbortError') this.speech.say('Could not share. Read the address above to someone nearby.', 'high');
    }
  }

  private nearby(r: number) {
    const all = this.world!.placesNear(this.x, this.y, r);
    return this.placeFilter ? all.filter((p) => p.place.group === this.placeFilter) : all;
  }

  private filterLabel() {
    return this.placeFilter ? `${FILTER_NAMES[this.placeFilter]} ` : '';
  }

  /** C: show only one kind of place in W, Space and Tab, cycling through the kinds and back to all. */
  private cycleFilter() {
    const i = FILTERS.indexOf(this.placeFilter);
    this.placeFilter = FILTERS[(i + 1) % FILTERS.length];
    this.browse = null;
    this.speech.say(this.placeFilter ? `Showing only ${FILTER_NAMES[this.placeFilter]}.` : 'Showing all places.', 'high');
  }

  private whatsAround() {
    const reach = this.reach(this.vehicle.scanRadius);
    const list = this.nearby(reach).slice(0, 6);
    if (!list.length) return this.speech.say(`No ${this.filterLabel()}places within ${fmtDistance(reach, this.settings.units)}.`, 'high');
    const text = list
      .map(({ place, d }) => `${this.placeText(place)}, ${fmtDistance(d, this.settings.units)} ${this.dirTo(place.x, place.y)}`)
      .join('. ');
    this.speech.say(text + '.', 'high');
  }

  // ---------------- grid mode ----------------

  private gridStepText(short = false): string {
    const n = GRID_STEPS[this.gridStepIdx];
    const imperial = this.settings.units === 'imperial';
    if (short) return `${n} ${imperial ? 'yd' : 'm'}`;
    return `${n} ${imperial ? 'yard' : 'metre'}${n === 1 ? '' : 's'}`;
  }

  private toggleGrid() {
    if (this.grid) {
      this.exitGrid();
      // on a road, face along it (the way nearest north) rather than across it
      const hit = this.world!.nearestRoad(this.x, this.y, 30, this.vehicle.canUse);
      if (hit && hit.hit.dist <= roadHalfWidth(hit.seg.way.type) + 4) this.place(hit.hit.px, hit.hit.py, Math.abs(relAngle(0, hit.dir)) <= 90 ? hit.dir : hit.dir + 180, null);
      else this.updateRoad(true);
      const on = this.streetName ? `On ${this.streetName}, facing` : 'Facing';
      this.speech.say(`Grid mode off. ${on} ${compass8(this.heading)}.`, 'high');
      // turn by turn resumes: plan afresh from wherever the grid left you
      if (this.dest && this.settings.turnByTurn && this.vehicle.id !== 'helicopter') void this.computeRoute(true);
      return;
    }
    if (this.live) return this.speech.say('Live GPS is on. Shift L turns it off first.', 'high');
    // face north and stay so: the beacon and clock directions then read as a north-up map
    this.place(this.x, this.y, 0, null);
    this.grid = { key: null, req: 0 };
    this.syncEngine(); // the vehicle is parked while you step about
    void this.gridLook(true, `Grid mode, up is north. Arrows move ${this.gridStepText()}; minus and equals change the step. Space says where you are. F3 leaves.`);
  }

  /**
   * The vehicle's own sound (footsteps, engine, rotor) plays only while the keyboard moves you: not
   * in grid mode, where the vehicle is parked, nor with live GPS, where you really are walking or driving.
   */
  private syncEngine() {
    this.audio.setEngine(!this.grid && !(this.live && this.liveFix));
  }

  /** Leave grid mode (if on) and start the vehicle's sound again. */
  exitGrid() {
    this.grid = null;
    this.syncEngine();
  }

  /** Keys that work differently in grid mode; returns false for the rest. */
  private gridCommand(c: Command): boolean {
    const mv = GRID_MOVES[c.code];
    if (mv) {
      if (!c.ctrl && !c.alt) this.gridMove(mv[0], mv[1]);
      return true;
    }
    switch (c.key) {
      case ' ':
        if (!c.repeat) this.gridDescribe(c.shift);
        return true;
      case '-':
      case '_':
      case '=':
      case '+':
        if (!c.repeat) this.gridResize(c.key === '-' || c.key === '_' ? -1 : 1);
        return true;
    }
    return c.code === 'Slash';
  }

  private gridMove(dx: number, dy: number) {
    const m = GRID_STEPS[this.gridStepIdx] * (this.settings.units === 'imperial' ? 0.9144 : 1);
    if (this.trip) this.trip.meters += m;
    this.grid!.dir = bearingTo(0, 0, dx, dy); // N looks this way
    this.place(this.x + dx * m, this.y + dy * m, 0, null);
    void this.gridLook(false);
  }

  private gridResize(dir: 1 | -1) {
    const i = Math.max(0, Math.min(GRID_STEPS.length - 1, this.gridStepIdx + dir));
    const lead = i !== this.gridStepIdx ? 'Step' : dir > 0 ? 'Largest step,' : 'Smallest step,';
    this.gridStepIdx = i;
    this.speech.say(`${lead} ${this.gridStepText()}.`, 'high');
  }

  /** Space: what is here. Shift Space adds the nearest street and the step size. */
  private gridDescribe(detail: boolean) {
    if (!detail) return void this.gridLook(true);
    const u = this.settings.units;
    const hit = this.world!.nearestRoad(this.x, this.y, 300, (w) => w.named);
    let street = 'No named street nearby.';
    if (hit && hit.hit.dist <= roadHalfWidth(hit.seg.way.type) + 1.5) street = '';
    else if (hit) street = `${hit.seg.way.name} is ${fmtDistance(hit.hit.dist, u)} ${compass8(bearingTo(this.x, this.y, hit.hit.px, hit.hit.py))}.`;
    void this.gridLook(true, '', ` ${street} Step ${this.gridStepText()}.`);
  }

  /** The road or path at (x, y), by default where the traveller stands, if any. */
  private gridRoad(x = this.x, y = this.y): Area | null {
    const hit = this.world?.nearestRoad(x, y, 30);
    if (!hit || hit.hit.dist > roadHalfWidth(hit.seg.way.type) + 1.5) return null;
    const w = hit.seg.way;
    return { key: `road:${w.name}`, kind: w.name, sound: MINOR.has(w.type) ? 'path' : 'road' };
  }

  /**
   * Play the sound for the ground here and say what it is. An unnamed place says the neighbourhood
   * it is near when asked (Space, entering grid mode); a step says it only on crossing into another
   * ("Now near Fort."), so pressing the arrows does not repeat it.
   */
  private async gridLook(ask: boolean, prefix = '', suffix = '') {
    const g = this.grid;
    if (!g) return;
    const req = ++g.req;
    this.loadNamed();
    const here = this.proj.toLatLon(this.x, this.y);
    let area = this.gridRoad();
    const onRoad = !!area;
    if (!area) {
      try {
        area = await this.areas.at(here);
      } catch {
        area = null;
      }
      if (this.grid !== g || g.req !== req) return; // moved on meanwhile
    }
    if (!area) {
      this.audio.error();
      return this.speech.say(`${prefix} Could not load what is here.`.trim(), 'high');
    }
    this.audio.areaCue(area.sound);
    g.key = area.key;
    let hood: string | null = null;
    try {
      hood = await this.areas.hood(here);
    } catch {
      hood = null;
    }
    if (this.grid !== g || g.req !== req) return;
    const hoodChanged = g.hood !== undefined && hood !== g.hood;
    g.hood = hood;
    const named = this.nameArea(area, onRoad, this.x, this.y);
    area = named.area;
    let text = named.text;
    // never the place's own name: leave the neighbourhood out when what is said already has it
    const hoodOk = !!hood && !text.toLowerCase().includes(hood.toLowerCase()) && !hood.toLowerCase().includes(text.toLowerCase());
    let now = '';
    if (hoodOk && ask && !onRoad && !area.name && !area.number) text = `${text} near ${hood}`;
    else if (hoodOk && !ask && hoodChanged) now = ` Now near ${hood}.`;
    const loading = this.inLoadedArea(this.x, this.y) ? '' : ' Streets here are still loading.';
    this.speech.say(`${prefix} ${cap(text)}.${now}${suffix}${loading}`.trim(), 'high');
  }

  /** Give a tile area its best name: OpenStreetMap's own, else a house number; and the phrase to say. */
  private nameArea(area: Area, onRoad: boolean, x: number, y: number): { area: Area; text: string } {
    let text = '';
    if (!onRoad) {
      // the tiles' building and ground outlines carry no names: OpenStreetMap's own, when loaded
      const osm = this.namedAt(x, y, area.sound === 'building');
      // a named compound where the tiles have no ground at all is its "grounds", not "open ground"
      if (osm) area = { ...area, name: osm.name, kind: osm.kind ?? (area.sound === 'open' ? 'grounds' : area.kind), number: undefined };
      if (!area.name && area.number) {
        const st = this.world?.nearestRoad(x, y, 30, (w) => w.named && !MINOR.has(w.type));
        text = `${area.kind} number ${area.number}${st ? ` on ${st.seg.way.name}` : ''}`;
      }
    }
    return { area, text: text || areaText(area) };
  }

  // ---------------- phone screen ----------------

  /** Where the traveller is and faces, for the phone screen. */
  get pose() {
    return { x: this.x, y: this.y, heading: this.heading, live: !!this.live, ready: !!this.world, loadFailed: this.loadFailed, units: this.settings.units };
  }

  /** Back from the lock screen or another app, where iOS may have interrupted the sound. */
  wakeAudio() {
    if (this.running && !this.paused) this.audio.resume();
  }

  /** What is at (x, y): road, named building or ground, as a short phrase with its sound. Null before the map loads. */
  async describeAt(x: number, y: number): Promise<{ text: string; sound: AreaSound; named: boolean } | null> {
    if (!this.world) return null;
    this.loadNamed();
    let area = this.gridRoad(x, y);
    const onRoad = !!area;
    if (!area) {
      try {
        area = await this.areas.at(this.proj.toLatLon(x, y));
      } catch {
        return null;
      }
    }
    const named = this.nameArea(area, onRoad, x, y);
    return { text: named.text, sound: named.area.sound, named: onRoad || !!named.area.name || !!named.area.number };
  }

  /** The neighbourhood (x, y) is near, if any. */
  async hoodAt(x: number, y: number): Promise<string | null> {
    try {
      return await this.areas.hood(this.proj.toLatLon(x, y));
    } catch {
      return null;
    }
  }

  /** Play the sound for a kind of ground (the phone grid, without a screen reader). */
  areaCue(sound: AreaSound) {
    this.audio.areaCue(sound);
  }

  /**
   * The way to treat as "up" for a heading: a street's direction when one is within 30 degrees
   * (the street here, or any leaving a nearby intersection), else the nearest of the 8 compass points.
   */
  streetUp(heading: number): { dir: number; street?: string } {
    const w = this.world;
    const options: { dir: number; street: string }[] = [];
    const hit = w?.nearestRoad(this.x, this.y, 25);
    if (hit) options.push({ dir: hit.dir, street: hit.seg.way.name }, { dir: normDeg(hit.dir + 180), street: hit.seg.way.name });
    for (const n of w?.nodesNear(this.x, this.y, 15) ?? []) {
      if (!w!.isIntersection(n, this.filter)) continue;
      for (const e of n.edges) options.push({ dir: w!.edgeBearing(n, e), street: e.way.name });
    }
    let best: { dir: number; street: string; off: number } | null = null;
    for (const o of options) {
      const off = Math.abs(relAngle(heading, o.dir));
      if (off <= 30 && (!best || off < best.off)) best = { ...o, off };
    }
    if (best) return { dir: Math.round(normDeg(best.dir)), street: best.street };
    return { dir: (Math.round(normDeg(heading) / 45) % 8) * 45 };
  }

  /**
   * Places within `r` metres, nearest first, for the phone's Nearby list: name, kind, how far and
   * which way ("ahead left"). `group` limits them to one kind.
   */
  nearbyList(group: PlaceGroup | null, r = 500, max = 20): { id: string; text: string }[] {
    if (!this.world) return [];
    const u = this.settings.units;
    return this.world
      .placesNear(this.x, this.y, r)
      .filter(({ place }) => !group || place.group === group)
      .slice(0, max)
      .map(({ place, d }) => ({
        id: place.id,
        text: `${this.placeText(place)}, ${fmtDistance(d, u)}, ${sideWord(relAngle(this.heading, bearingTo(this.x, this.y, place.x, place.y)))}`,
      }));
  }

  /** Make a loaded place the destination: its main door, a station's nearest entrance, or the place. */
  pickPlace(id: string): boolean {
    const p = this.world?.places.find((q) => q.id === id);
    if (!p) return false;
    this.setTarget(this.targetFor(p));
    return true;
  }

  /** Start live GPS from a tap (iOS asks for the compass only then); nothing if it is on. */
  startLive() {
    if (!this.live) void this.toggleLive();
  }

  get hasDestination(): boolean {
    return !!this.dest;
  }

  /** The next turn-by-turn instruction as text, for the phone's directions panel; '' without a destination. */
  directionsText(): string {
    const dest = this.dest;
    if (!dest) return '';
    const u = this.settings.units;
    const r = this.route;
    if (!r) return `${dest.name}, ${fmtDistance(dist(this.x, this.y, dest.x, dest.y), u)} ${compass8(bearingTo(this.x, this.y, dest.x, dest.y))}. Follow the beacon.`;
    const steps = r.maneuvers.slice(this.nextMan).filter((m) => !(m.kind === 'arrive' && r.partial) && !this.isTrivial(m));
    const m = steps[0];
    if (!m) return r.partial ? 'Follow this road; more of the route loads as you go.' : `Arriving at ${dest.name}.`;
    return `${this.stepWhen(m, m.d - this.routeProg)}.`;
  }

  /**
   * The next steps of the route, up to max, for the phone's list: the first from here ("In 40
   * metres, turn right onto Elm Street"), each after it from the step before ("After 120 metres
   * more, turn left onto Oak Street"). It ends at the destination when that comes first.
   */
  routeSteps(max = 5): string[] {
    const r = this.route;
    const dest = this.dest;
    if (!r || !dest) return [];
    const steps = r.maneuvers.slice(this.nextMan).filter((m) => !(m.kind === 'arrive' && r.partial) && !this.isTrivial(m)).slice(0, max);
    const out: string[] = [];
    let at = this.routeProg;
    for (const m of steps) {
      out.push(out.length ? `After ${fmtDistance(m.d - at, this.settings.units)} more, ${this.stepText(m, dest.name)}.` : `${this.stepWhen(m, m.d - at)}.`);
      at = m.d;
    }
    if (r.partial && out.length < max) out.push('The route goes on as more of the map loads.');
    return out;
  }

  /**
   * "In 40 metres, at the next intersection, turn left onto Oak Street". Within HERE, where GPS
   * cannot measure any closer: "Now, turn left onto Oak Street", or "Blue Cafe is very close".
   */
  private stepWhen(m: Maneuver, d: number): string {
    const name = this.dest?.name ?? 'Your destination';
    if (d >= HERE) return `In ${fmtDistance(d, this.settings.units)}, ${this.whichIntersection(m)}${this.stepText(m, name)}`;
    if (m.kind !== 'arrive') return `Now, ${this.stepText(m, name)}`;
    return `${name} is very close${Math.abs(m.rel) >= 25 ? `, on your ${m.rel < 0 ? 'left' : 'right'}` : ''}`;
  }

  /** "in 40 metres", or "now" within HERE. */
  private inDistance(d: number): string {
    return d < HERE ? 'now' : `in ${fmtDistance(d, this.settings.units)}`;
  }

  /** Fetch OpenStreetMap's named buildings and grounds around here, in the background, once per ~500 m. */
  private loadNamed() {
    if (this.namedLoading || performance.now() < this.namedRetry) return;
    if (this.named && dist(this.x, this.y, this.named.at.x, this.named.at.y) < 500) return;
    const at = { x: this.x, y: this.y };
    const proj = this.proj;
    this.namedLoading = true;
    fetchNamedAreas(proj.toLatLon(at.x, at.y), 900, new AbortController().signal)
      .then((list) => {
        if (this.proj !== proj) return; // moved to another place meanwhile
        this.named = { at, items: list.map((a) => namedPoly(a, proj)) };
      })
      .catch(() => {
        this.namedRetry = performance.now() + 30_000; // the tiles' names will do until then
      })
      .finally(() => {
        this.namedLoading = false;
      });
  }

  /** The smallest named building (or, for ground, named non-building) from OpenStreetMap around (x, y). */
  private namedAt(x: number, y: number, building: boolean): NamedPoly | null {
    let best: NamedPoly | null = null;
    for (const a of this.named?.items ?? []) {
      if (a.building !== building || x < a.minX || x > a.maxX || y < a.minY || y > a.maxY || !inRings([a.ring], x, y)) continue;
      if (!best || a.size < best.size) best = a;
    }
    return best;
  }

  /** A grid distance in the grid's own unit (metres, or yards with imperial units), so steps can be counted. */
  private gridDistance(m: number): string {
    const imperial = this.settings.units === 'imperial';
    const v = imperial ? m / 0.9144 : m;
    if (!imperial && v >= 1000) return `${(v / 1000).toFixed(1)} kilometres`;
    const n = v < 50 ? Math.round(v) : v < 500 ? Math.round(v / 10) * 10 : Math.round(v / 50) * 50;
    return `${n} ${imperial ? 'yard' : 'metre'}${n === 1 ? '' : 's'}`;
  }

  /** "80 metres north and 10 metres east": how far to step each way to reach a point. */
  private gridOffset(x: number, y: number): string {
    const dx = x - this.x;
    const dy = y - this.y;
    const min = this.settings.units === 'imperial' ? 0.9144 / 2 : 0.5; // under half the smallest step
    const parts: string[] = [];
    if (Math.abs(dy) >= min) parts.push(`${this.gridDistance(Math.abs(dy))} ${dy > 0 ? 'north' : 'south'}`);
    if (Math.abs(dx) >= min) parts.push(`${this.gridDistance(Math.abs(dx))} ${dx > 0 ? 'east' : 'west'}`);
    return parts.join(' and ');
  }

  /** Where a point lies from here: a compass direction in grid mode (no way you face), else a clock direction. */
  private dirTo(x: number, y: number): string {
    return this.grid ? compass8(bearingTo(this.x, this.y, x, y)) : `at ${clockDir(relAngle(this.heading, bearingTo(this.x, this.y, x, y)))}`;
  }

  /**
   * N in grid mode: the nearest intersection the way the last arrow went (within 45 degrees either
   * side), Shift N the other way, and how far each way it is. Pressed twice, step onto it. Before any
   * arrow, or with none that way, the nearest in any direction.
   */
  private gridIntersection(move: boolean, back: boolean) {
    const w = this.world!;
    const g = this.grid!;
    const want = g.dir === undefined ? undefined : normDeg(g.dir + (back ? 180 : 0));
    const R = 500;
    let any: { n: GNode; d: number } | null = null;
    let ahead: { n: GNode; d: number } | null = null;
    for (const n of w.nodesNear(this.x, this.y, R)) {
      if (!w.isIntersection(n, this.filter)) continue;
      const d = dist(this.x, this.y, n.x, n.y);
      if (!any || d < any.d) any = { n, d };
      // not the one we stand on: the next one that way
      if (want !== undefined && d > 2 && Math.abs(relAngle(want, bearingTo(this.x, this.y, n.x, n.y))) <= 45 && (!ahead || d < ahead.d)) ahead = { n, d };
    }
    const way = want === undefined ? '' : compass8(want);
    const best = want === undefined ? any : ahead;
    let lead = '';
    if (!best) {
      if (!any) return this.speech.say(`No intersection within ${this.gridDistance(R)}.`, 'high');
      return this.speech.say(`No intersection to the ${way} within ${this.gridDistance(R)}. Nearest: ${this.intersectionLabel(any.n)}, ${this.gridOffset(any.n.x, any.n.y) || 'here'}.`, 'high');
    }
    if (way) lead = `${cap(way)}: `;
    const label = this.intersectionLabel(best.n);
    if (move) {
      this.place(best.n.x, best.n.y, 0, null);
      return void this.gridLook(false, `${label}.`);
    }
    const off = this.gridOffset(best.n.x, best.n.y);
    this.speech.say(off ? `${lead}${label}, ${off}. Press ${back ? 'Shift N' : 'N'} twice to step onto it.` : `You are at ${label}.`, 'high');
  }

  /** "Oak Street and Elm Street" */
  private intersectionLabel(n: GNode): string {
    const names = [...new Set(n.edges.filter((e) => e.way.named).map((e) => e.way.name))];
    return names.length ? names.slice(0, 3).join(' and ') : 'Intersection';
  }

  private sonar() {
    const list = this.nearby(this.vehicle.scanRadius).slice(0, 14);
    this.audio.sonarStart();
    const t0 = this.audio.now + 0.5;
    for (const { place, d } of list) {
      const rel = relAngle(this.heading, bearingTo(this.x, this.y, place.x, place.y));
      const when = t0 + (normDeg(rel) / 360) * 2.2; // sweep clockwise from straight ahead
      const level = 0.12 + 0.3 * (1 - d / this.vehicle.scanRadius);
      this.audio.placeCue(place.group, rel, level, when, d / this.vehicle.scanRadius);
    }
    this.speech.say(list.length ? `${list.length} places` : 'Nothing nearby', 'low');
  }

  private browsePlaces(dir: 1 | -1) {
    if (!this.browse || dist(this.x, this.y, this.browse.x, this.browse.y) > 30) {
      const list = this.nearby(this.vehicle.scanRadius * 2).slice(0, 40).map((p) => p.place);
      if (!list.length) return this.speech.say(`No ${this.filterLabel()}places nearby.`, 'high');
      this.browse = { list, idx: dir === 1 ? -1 : list.length, x: this.x, y: this.y };
    }
    const b = this.browse;
    b.idx = (b.idx + dir + b.list.length) % b.list.length;
    const p = b.list[b.idx];
    const d = dist(this.x, this.y, p.x, p.y);
    const rel = relAngle(this.heading, bearingTo(this.x, this.y, p.x, p.y));
    this.audio.placeCue(p.group, rel, 0.3);
    this.speech.say(`${this.placeText(p)}, ${fmtDistance(d, this.settings.units)} ${this.dirTo(p.x, p.y)}. ${b.idx + 1} of ${b.list.length}`, 'high');
  }

  private setDestination() {
    if (!this.browse) return this.speech.say('Press Tab to choose a place first.', 'high');
    const p = this.browse.list[this.browse.idx];
    this.setTarget(this.targetFor(p));
  }

  setTarget(t: Target) {
    if (dist(this.x, this.y, t.x, t.y) < Math.max(this.arriveRadius, t.radius ?? 0)) {
      this.audio.arrival();
      this.buzz('arrival');
      return this.speech.say(`You are already at ${t.name}.`, 'high');
    }
    this.dest = t;
    addRecent({ name: t.name, ...this.proj.toLatLon(t.x, t.y) });
    this.trip = { t0: this.clock, meters: 0, streets: [] };
    this.nextBeacon = 0;
    this.dropCorridor();
    const d0 = dist(this.x, this.y, t.x, t.y);
    this.destMilestone = MILESTONES.find((m) => d0 <= m) ?? Infinity;
    this.map.setDestination(this.proj.toLatLon(t.x, t.y));
    const d = dist(this.x, this.y, t.x, t.y);
    const rel = relAngle(this.heading, bearingTo(this.x, this.y, t.x, t.y));
    // turn by turn pauses in grid mode (there is no way you face); it is planned on leaving
    const guided = this.settings.turnByTurn && this.vehicle.id !== 'helicopter' && !this.grid;
    const where = this.grid ? this.gridOffset(t.x, t.y) : `${fmtDistance(d, this.settings.units)} at ${clockDir(rel)}`;
    this.speech.say(`Destination ${t.name}${t.detail ? `, ${t.detail}` : ''}, ${where}.${guided ? '' : ' Follow the beacon.'}`, 'high');
    if (guided) void this.computeRoute(true);
    else this.clearRoute();
    void this.lookUpLines(t);
  }

  /**
   * Control + J: move to a place and load the map there, keeping the destination (re-planning the
   * route from the new spot), so a route from A to B can be learnt by jumping to A.
   */
  async jumpTo(name: string, lat: number, lon: number) {
    const d = this.dest;
    const keep = d ? { name: d.name, radius: d.radius ?? 0, ...this.proj.toLatLon(d.x, d.y) } : null;
    await this.start({ lat, lon }, name);
    if (keep && this.world) this.setTargetLatLon(keep.name, keep.lat, keep.lon, keep.radius);
  }

  /** Where you are and where you are going, as lat/lon, for saving a named route. */
  /** For dialogs outside the game that need to confirm something aloud. */
  announce(text: string) {
    this.speech.say(text, 'high');
  }

  currentTrip() {
    const d = this.dest;
    if (!d || !this.proj) return null;
    return { street: this.streetName, start: this.position!, dest: { name: d.name, radius: d.radius ?? 0, ...this.proj.toLatLon(d.x, d.y) } };
  }

  /** Set a beacon destination from a search result (any distance, even outside the loaded map). */
  setTargetLatLon(name: string, lat: number, lon: number, radius = 0) {
    const p = this.proj.toXY(lat, lon);
    // a loaded place of that name: aim for its door or entrance and say which corner
    const known = this.world?.placesNear(p.x, p.y, 60).find((n) => n.place.name === name)?.place;
    if (known) return this.setTarget({ ...this.targetFor(known), radius: Math.min(400, radius) });
    this.setTarget({ name, x: p.x, y: p.y, radius: Math.min(400, radius) });
  }

  /** Loaded places whose name matches the query, nearest first, for the destination search. */
  findPlaces(q: string): PlaceMatch[] {
    if (!this.world || !q.trim()) return [];
    const found: { p: Place; tier: number; d: number }[] = [];
    for (const p of this.world.places) {
      const tier = matchTier(q, [p.name, p.category]);
      if (tier !== null) found.push({ p, tier, d: dist(this.x, this.y, p.x, p.y) });
    }
    return found
      .sort(byTierThenDistance)
      .slice(0, 8)
      .map(({ p, tier, d }) => {
        const ll = this.proj.toLatLon(p.x, p.y);
        const spot = this.placeDetail(p).short;
        return { name: p.name, detail: `${p.category}${spot ? `, ${spot}` : ''}, ${this.describeOffset(d, bearingTo(this.x, this.y, p.x, p.y))}`, lat: ll.lat, lon: ll.lon, tier, d };
      });
  }

  /** Straight-line metres from the traveller to a lat/lon. */
  distanceFromHere(lat: number, lon: number): number {
    const p = this.proj.toXY(lat, lon);
    return dist(this.x, this.y, p.x, p.y);
  }

  /** "1.2 kilometres north-east" from the traveller to a lat/lon. */
  describeFromHere(lat: number, lon: number): string {
    const p = this.proj.toXY(lat, lon);
    return this.describeOffset(dist(this.x, this.y, p.x, p.y), bearingTo(this.x, this.y, p.x, p.y));
  }

  private describeOffset(d: number, b: number): string {
    return `${fmtDistance(d, this.settings.units)} ${compass8(b)}`;
  }

  get position(): LatLon | null {
    return this.proj ? this.proj.toLatLon(this.x, this.y) : null;
  }

  /**
   * D: how far is left. Along the route when there is one (with an estimated time), plus the
   * straight-line distance and direction.
   */
  private distanceToGo() {
    if (!this.dest) return this.speech.say(`No destination. Press ${this.keyText('navigate')} to choose one.`, 'high');
    const u = this.settings.units;
    const d = dist(this.x, this.y, this.dest.x, this.dest.y);
    const b = bearingTo(this.x, this.y, this.dest.x, this.dest.y);
    const straight = `${fmtDistance(d, u)} in a straight line, ${compass8(b)}`;
    const r = this.route;
    if (!r || r.partial) return this.speech.say(`${this.dest.name}: ${straight}.`, 'high');
    const left = Math.max(0, r.length - this.routeProg);
    // time at the current speed, or a typical speed for the vehicle when stopped
    this.speech.say(`${fmtDistance(left, u)} to go along the route, about ${this.etaText(left)}. ${straight}.`, 'high');
  }

  /** Time for a distance at the current speed, or a typical speed for the vehicle when stopped. */
  private etaText(left: number): string {
    const typical = { walker: 1.3, bicycle: 4.5, car: 9, helicopter: 50 }[this.vehicle.id];
    const minutes = Math.max(1, Math.round(left / (this.speed > 0.5 ? this.speed : typical) / 60));
    return minutesText(minutes);
  }

  /** Spot notes are stored by position, so they are put on the local map again after each start. */
  loadNotes() {
    this.notes = loadNotes().map((n) => ({ ...this.proj.toXY(n.lat, n.lon), text: n.text }));
  }

  addNote(text: string) {
    saveNotes([...loadNotes(), { text, ...this.proj.toLatLon(this.x, this.y) }]);
    this.loadNotes();
    this.speech.say('Note saved here.', 'high');
  }

  /** Shift + V: delete the note you are standing at. */
  private deleteNote() {
    this.loadNotes(); // another tab may have changed them, and the index below must match storage
    const here = this.notes.findIndex((n) => dist(this.x, this.y, n.x, n.y) < 25);
    if (here < 0) return this.speech.say('No note within 25 metres.', 'high');
    const all = loadNotes();
    all.splice(here, 1); // same order as this.notes
    saveNotes(all);
    this.loadNotes();
    this.speech.say('Note deleted.', 'high');
  }

  private checkNotes() {
    for (const n of this.notes) {
      if (dist(this.x, this.y, n.x, n.y) > 25) continue;
      const key = `note|${n.x}|${n.y}`;
      if (this.clock - (this.announcedHazards.get(key) ?? -1e9) < 120) continue;
      this.announcedHazards.set(key, this.clock);
      this.speech.say(`Note: ${n.text}`, 'high');
      break;
    }
  }

  /** Z: copy a link that opens the app at this spot with the same destination, for a sighted helper. */
  private async shareLink() {
    const here = this.position!;
    const enc = (name: string, p: LatLon) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)},${encodeURIComponent(name)}`;
    let hash = `from=${enc(this.streetName ?? 'Shared start', here)}`;
    if (this.dest) hash += `&to=${enc(this.dest.name, this.proj.toLatLon(this.dest.x, this.dest.y))}`;
    const url = `${location.origin}${location.pathname}#${hash}`;
    try {
      await navigator.clipboard.writeText(url);
      this.speech.say(this.dest ? `Link to this route copied.` : 'Link to this spot copied.', 'high');
    } catch {
      this.speech.say('Could not copy the link. Clipboard access was refused.', 'high');
    }
  }

  /** Shift S: fetch the map around here (and the destination) now, so it loads without a connection later. */
  private async saveOffline() {
    const radius = this.vehicle.loadRadius;
    // along the route when there is one, so the whole way opens offline, not just both ends
    const along = this.route ? corridorSpots(this.route.points, radius * 1.5, 12) : [];
    const spots = [this.proj.toLatLon(this.x, this.y), ...along.map((p) => this.proj.toLatLon(p.x, p.y))];
    if (this.dest && !along.length) spots.push(this.proj.toLatLon(this.dest.x, this.dest.y));
    this.speech.say('Saving this area for offline use.', 'high');
    const none = new AbortController().signal;
    try {
      for (const c of spots) await Promise.all([fetchTileArea(c, radius, none), fetchRoads(c, radius, none), fetchPlaces(c, radius, none)]);
      this.speech.say(`Saved the map around ${along.length ? 'here and along the route' : spots.length > 1 ? 'here and the destination' : 'here'} for offline use.`, 'high');
    } catch {
      this.speech.say('Could not save the area. Check your connection.', 'high');
    }
  }

  /** Shift Z: the planned route as a GPX file, so a helper or another app can follow it. */
  private exportRoute() {
    const r = this.route;
    if (!this.dest || !r) return this.speech.say('No route to save. Set a destination first.', 'high');
    downloadGpx(this.dest.name, routeToGpx(this.dest.name, r.points.map((p) => this.proj.toLatLon(p.x, p.y))));
    this.speech.say(`Route to ${this.dest.name} saved as a GPX file${r.partial ? ', as far as the map has loaded' : ''}.`, 'high');
  }

  /** U: how the trip to the destination is going, or how the last one went. */
  private tripSummary() {
    const t = this.trip;
    if (!t) return this.speech.say(this.lastTrip || 'No trip yet. Set a destination first.', 'high');
    this.speech.say(`Trip so far: ${this.tripText(t)}.`, 'high');
  }

  private tripText(t: { t0: number; meters: number; streets: string[] }): string {
    const via = t.streets.length ? `, via ${t.streets.slice(0, 5).join(', ')}${t.streets.length > 5 ? ' and more' : ''}` : '';
    return `${fmtDistance(t.meters, this.settings.units)} in ${minutesText(Math.max(1, Math.round((this.clock - t.t0) / 60)))}${via}`;
  }

  /** O: the whole route in one go: length, time and the first few turns with the street each leads onto. */
  private routePreview() {
    const r = this.route;
    if (!this.dest || !r) return this.instructions();
    const u = this.settings.units;
    const steps = r.maneuvers.slice(this.nextMan).filter((m) => m.kind !== 'arrive' && !this.isTrivial(m));
    const left = Math.max(0, r.length - this.routeProg);
    const shown = steps.slice(0, 8);
    const list = shown.map((m, i) => `${i + 1}, ${this.stepText(m, this.dest!.name)} after ${fmtDistance(Math.max(0, m.d - (i ? shown[i - 1].d : this.routeProg)), u)}`);
    const more = steps.length > shown.length ? ` ${steps.length - shown.length} more turns after that.` : '';
    const head = `Route to ${this.dest.name}: ${fmtDistance(left, u)}${r.partial ? ' so far' : ''}, about ${this.etaText(left)}, ${steps.length} turn${steps.length === 1 ? '' : 's'}.`;
    this.speech.say(`${head} ${list.length ? list.join('. ') + '.' : 'Straight on.'}${more}`, 'high');
  }

  private destinationInfo() {
    if (!this.dest) return this.speech.say(`No destination. Press ${this.keyText('navigate')} to search for one, or ${this.keyText('nextPlace')} to pick a nearby place and ${this.keyText('setDestination')}.`, 'high');
    const u = this.settings.units;
    const d = dist(this.x, this.y, this.dest.x, this.dest.y);
    const b = bearingTo(this.x, this.y, this.dest.x, this.dest.y);
    const t = this.dest;
    const where = this.grid ? this.gridOffset(t.x, t.y) : `${fmtDistance(d, u)} ${compass8(b)}, at ${clockDir(relAngle(this.heading, b))}`;
    const straight = `${t.name}${t.detail ? `, ${t.detail}` : ''}, ${where}`;
    const lines = t.lines ? ` ${t.lines}` : '';
    const r = this.route;
    if (!r) return this.speech.say(`${straight}.${lines}`, 'high');
    const m = this.upcoming();
    const next = m && m.kind !== 'arrive' ? `${cap(this.stepText(m, this.dest.name))} ${this.inDistance(m.d - this.routeProg)}. ` : '';
    const left = r.partial ? `${fmtDistance(r.length - this.routeProg, u)} of route loaded so far` : `${fmtDistance(r.length - this.routeProg, u)} to go`;
    this.speech.say(`${next}${left}. ${straight} in a straight line.${lines}`, 'high');
  }

  /** Y: save the destination, or else where you are, to recall in the Control + D / Control + J search. */
  private saveFavorite() {
    const at = this.dest ?? { name: this.streetName ?? 'Saved spot', x: this.x, y: this.y };
    const added = addFavorite({ name: at.name, ...this.proj.toLatLon(at.x, at.y) });
    this.speech.say(added ? `Saved ${at.name}.` : `${at.name} is already saved.`, 'high');
  }

  private clearDestination() {
    if (!this.dest) return this.speech.say('No destination set.', 'high');
    this.dest = null;
    this.trip = null;
    this.map.setDestination(null);
    this.dropCorridor();
    this.clearRoute();
    this.speech.say('Destination cleared.', 'high');
  }

  /** R: face along the road, following it a few metres ahead so it works in a bend, and say how far that was. */
  private alignToRoad() {
    const hit = this.world!.nearestRoad(this.x, this.y, 25);
    if (!hit) return this.speech.say('No road nearby.', 'high');
    const ahead = this.roadAhead(hit.seg.way, 8);
    const target = ahead ? ahead.aim : Math.abs(relAngle(this.heading, hit.dir)) <= 90 ? hit.dir : normDeg(hit.dir + 180);
    const turned = Math.round(relAngle(this.heading, target));
    this.heading = normDeg(Math.round(target));
    this.lastManualTurn = this.clock;
    const how = Math.abs(turned) < 3 ? 'Already aligned' : `Turned ${Math.abs(turned)} degrees ${turned < 0 ? 'left' : 'right'}`;
    // in or near a bend: how much more turning it will take
    let more = '';
    const s = this.roadStart(25, (wy) => wy.name === hit.seg.way.name);
    if (s) {
      const w = this.world!;
      const line = w.roadLine(s.hit.hit.px, s.hit.hit.py, s.from, s.to, s.hit.seg.way.name, this.vehicle.canUse, (n) => w.isIntersection(n, this.filter), 80);
      const bend = findBend(line.pts, 20, 30);
      if (bend && bend.at < 30) {
        const u = this.settings.units;
        const side = bend.turn < 0 ? 'left' : 'right';
        const deg = Math.round(Math.abs(bend.turn) / 5) * 5;
        const where = bend.at < 5 ? `keeps bending ${side}` : `bends ${side} in ${fmtDistance(bend.at, u)}`;
        more = ` Road ${where}, about ${deg} degrees over ${fmtDistance(Math.max(5, bend.length), u)}.`;
      }
    }
    this.speech.say(`${how}. ${hit.seg.way.name}, facing ${compass8(this.heading)}.${more}`, 'high');
  }

  /** Turn onto the next road branch to the left or right, at the nearest intersection or along the current road. */
  private snapTurn(dir: -1 | 1) {
    const w = this.world!;
    const snap = (b: number, what: string, pause = true) => {
      this.heading = normDeg(Math.round(b));
      if (pause) this.lastManualTurn = this.clock; // else road assist takes over at once
      this.audio.tick(true);
      this.speech.say(`${what}, ${compass8(this.heading)}.`, 'high');
    };
    const rg = this.ring;
    if (rg) {
      // in a roundabout: take the exit coming up, if it is on that side
      const x = rg.exits[rg.next];
      if (x && x.at - rg.prog < 30) {
        const b = w.edgeBearing(x.node, x.edge);
        if (Math.sign(relAngle(this.heading, b)) === dir) {
          const r = (b * Math.PI) / 180;
          return snap(bearingTo(this.x, this.y, x.node.x + Math.sin(r) * 12, x.node.y + Math.cos(r) * 12), `Exit ${rg.next + 1}, ${x.edge.way.name}`);
        }
      }
    } else if (!this.road?.roundabout) {
      // at a roundabout's entry: turn onto the ring, the way traffic goes
      const rh = w.nearestRoad(this.x, this.y, 15, (wy) => wy.roundabout && this.vehicle.canUse(wy));
      if (rh) {
        // aim at a point a little way round the ring, the way traffic goes (either way on a two-way ring)
        const way = rh.seg.way;
        const flow = way.oneway && way.onewayReverse ? normDeg(rh.dir + 180) : rh.dir;
        const fwd = way.oneway ? !way.onewayReverse : Math.sign(relAngle(this.heading, flow)) === dir;
        const from = w.nodes.get(fwd ? rh.seg.a : rh.seg.b)!;
        const to = w.nodes.get(fwd ? rh.seg.b : rh.seg.a)!;
        const { pts } = w.roadLine(rh.hit.px, rh.hit.py, from, to, way.name, (wy) => wy.roundabout, () => false, 12);
        const p = alongLine(pts, 12);
        const b = bearingTo(this.x, this.y, p.x, p.y);
        if (Math.sign(relAngle(this.heading, b)) === dir) return snap(b, 'Into the roundabout', false);
      }
    }
    // at a turn on the route (just before or just after it), turn onto exactly the route's next road
    const m = this.upcoming();
    if (this.route && m && m.kind !== 'arrive' && Math.abs(m.d - this.routeProg) < 30 && (Math.abs(m.rel) < 25 || Math.sign(m.rel) === dir)) {
      // aim from where we are to a point a little way along the new road, so pressing a few metres early still works
      const t = pointAlong(this.route, Math.max(m.d, this.routeProg) + 15);
      return snap(bearingTo(this.x, this.y, t.x, t.y), this.stepText(m, this.dest?.name ?? '').replace(/^.*? onto /, ''));
    }
    const options: { b: number; name: string }[] = [];
    const nodes = w.nodesNear(this.x, this.y, 25).filter((n) => w.isIntersection(n, this.filter));
    nodes.sort((a, b) => dist(this.x, this.y, a.x, a.y) - dist(this.x, this.y, b.x, b.y));
    if (nodes[0]) {
      const obeysOneway = this.vehicle.id === 'car';
      for (const { from, edge } of w.junction(nodes[0], this.filter, this.junctionRadius).exits) {
        if (obeysOneway && edge.way.oneway && edge.fwd === edge.way.onewayReverse) continue; // can't drive in against it
        options.push({ b: w.edgeBearing(from, edge), name: edge.way.name });
      }
    } else {
      const hit = w.nearestRoad(this.x, this.y, 25);
      if (hit) options.push({ b: hit.dir, name: hit.seg.way.name }, { b: normDeg(hit.dir + 180), name: hit.seg.way.name });
      // at a bend: the direction the road takes once round it
      const s = this.roadStart(25, this.vehicle.canUse);
      if (s) {
        const { pts } = w.roadLine(s.hit.hit.px, s.hit.hit.py, s.from, s.to, s.hit.seg.way.name, this.vehicle.canUse, (n) => w.isIntersection(n, this.filter), 80);
        const bend = findBend(pts, 20, 35);
        if (bend && bend.at < 10) options.push({ b: alongLine(pts, bend.at + bend.length + 3).dir, name: s.hit.seg.way.name });
      }
    }
    let best: { b: number; name: string; amt: number } | null = null;
    for (const o of options) {
      const amt = normDeg(dir * (o.b - this.heading)); // rotation needed in the requested direction
      if (amt < 5 || amt > 355) continue;
      if (!best || amt < best.amt) best = { ...o, amt };
    }
    if (!best) {
      this.audio.error();
      return this.speech.say(`No road to the ${dir < 0 ? 'left' : 'right'}.`, 'high');
    }
    this.heading = normDeg(Math.round(best.b));
    this.lastManualTurn = this.clock;
    this.audio.tick(true);
    this.speech.say(`${best.name}, ${compass8(this.heading)}.`, 'high');
  }

  private emitHud() {
    const u = this.settings.units;
    let destination = '';
    if (this.dest) {
      const d = dist(this.x, this.y, this.dest.x, this.dest.y);
      destination = `${this.dest.name} · ${fmtDistance(d, u)} · ${this.dirTo(this.dest.x, this.dest.y)}`;
      const m = this.upcoming();
      if (m && m.kind !== 'arrive') destination += ` · ${this.stepText(m, this.dest.name)} ${this.inDistance(m.d - this.routeProg)}`;
    }
    this.onHud?.({
      street: this.streetName ?? (this.onRoad ? '' : 'Off road'),
      speed: fmtSpeedShort(this.speed, u),
      heading: `${Math.round(this.heading)}° ${compass8(this.heading)}`,
      area: this.areaName,
      destination,
      status: this.loading ? 'Loading map data…' : this.grid ? `Grid mode · step ${this.gridStepText(true)}` : '',
    });
  }

  /** What the tutorial checks to see that a key did something. */
  get snap() {
    return { ready: !!this.world, speed: this.speed, heading: this.heading, vehicle: this.vehicle.id as string, hasDest: !!this.dest };
  }

  /** Convert a lat/lon to world coordinates (for teleport targets found by search). */
  toXY(p: LatLon) {
    return this.proj.toXY(p.lat, p.lon);
  }
}

interface NamedPoly {
  name: string;
  building: boolean;
  kind?: string;
  ring: { x: number; y: number }[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  size: number;
}

function namedPoly(a: NamedArea, proj: Projection): NamedPoly {
  const ring = a.ring.map((p) => proj.toXY(p.lat, p.lon));
  const xs = ring.map((p) => p.x);
  const ys = ring.map((p) => p.y);
  let size = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) size += (ring[j].x - ring[i].x) * (ring[j].y + ring[i].y);
  return { name: a.name, building: a.building, kind: a.kind, ring, minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys), size: Math.abs(size / 2) };
}

/** Countries (and US territories) whose everyday distances are in feet, yards and miles. */
const IMPERIAL_COUNTRIES = new Set(['us', 'pr', 'gu', 'vi', 'as', 'mp', 'lr']);

/** An angle rounded to 5 degrees, for speech. */
function deg5(a: number): number {
  return Math.round(Math.abs(a) / 5) * 5;
}

/** How much to stretch the spoken-turn distances: 1 at the usual pace `ref` (m/s), up to double when faster, down to 0.7 when slower. */
export function paceScale(speed: number, ref: number): number {
  return speed < 0.3 ? 1 : Math.max(0.7, Math.min(2, speed / ref));
}

/** What to do at the kerb of a crossing, from how it is mapped; empty for other hazards. Never says traffic has stopped. */
export function crossingAdvice(text: string, extras: string[]): string {
  const has = (e: string) => extras.includes(e);
  if (text === 'Crossing with signals') {
    const start = has('push button') || has('vibrating button') ? 'Press the button. ' : '';
    const wait = has('audible signal') ? 'Wait for the audible signal, then check for traffic before crossing.' : 'No audible signal is mapped here. Listen for traffic and check before crossing.';
    return `At the signal crossing. ${start}${wait}${has('flush kerb, no edge to feel') ? ' The kerb is flush, so there is no edge to feel.' : ''}`;
  }
  if (text === 'Pedestrian crossing') return 'At an uncontrolled crossing. Wait until traffic has stopped, and listen before crossing.';
  return '';
}

/** Points along a route about `spacing` metres apart, ending at the last point, at most `max` of them. */
export function corridorSpots<P extends { x: number; y: number; d: number }>(points: P[], spacing: number, max: number): P[] {
  if (!points.length) return [];
  const out: P[] = [];
  let next = spacing;
  for (const p of points) {
    if (p.d < next) continue;
    out.push(p);
    next = p.d + spacing;
  }
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  if (out.length <= max) return out;
  return Array.from({ length: max }, (_, i) => out[Math.round((i * (out.length - 1)) / (max - 1))]);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
