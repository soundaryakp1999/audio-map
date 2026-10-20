// Live GPS mode: real location and compass from the device, to guide an actual walk.

import { normDeg, relAngle } from './geo';

export interface GpsFix {
  lat: number;
  lon: number;
  /** metres per second; 0 when the device does not report it */
  speed: number;
  /** direction of travel in degrees, when the device reports one */
  heading: number | null;
  /** radius in metres within which the position is 68% likely to lie, when reported */
  accuracy: number | null;
}

/** Filtered position in local metres, with its estimated accuracy and the time (s) of the last fix. */
export interface Estimate {
  x: number;
  y: number;
  acc: number;
  t: number;
  /** velocity east and north (m/s) from the last fix's speed and course; 0 when either is unknown */
  vx: number;
  vy: number;
}

/** Between fixes, the position is carried on at the last speed and course for at most this long (s). */
const MAX_COAST = 2;

/** Fixes worse than this are ignored once a good one has arrived. */
export const POOR_ACCURACY = 100;
/** Snapping to the nearest road is only trusted when the fix is at least this good (metres). */
const SNAP_MAX = 30;
/** Accuracy assumed when the device reports none. */
export const DEFAULT_ACCURACY = 15;

export type GpsProblem = 'denied' | 'nosignal' | 'unsupported';

/** Below this speed the GPS course is noise, so it is not used for heading. */
export const MIN_COURSE_SPEED = 0.8;

/** Tilted further than this (degrees, either way), the phone is not held to point: in a pocket, say. */
const MAX_TILT = 65;

export interface OrientationLike {
  webkitCompassHeading?: number;
  alpha?: number | null;
  absolute?: boolean;
  /** front-to-back tilt: 0 flat, 90 upright */
  beta?: number | null;
  /** side-to-side tilt */
  gamma?: number | null;
}

/**
 * Is the phone held near enough flat for its compass to say where it points? Upright or on its
 * side, as in a pocket, it points nowhere useful.
 */
export function heldToPoint(e: OrientationLike): boolean {
  return Math.abs(e.beta ?? 0) <= MAX_TILT && Math.abs(e.gamma ?? 0) <= MAX_TILT;
}

/** Compass heading (0 = north, clockwise) from an orientation event, or null if it is not relative to north. */
export function compassHeading(e: OrientationLike): number | null {
  if (typeof e.webkitCompassHeading === 'number') return normDeg(e.webkitCompassHeading);
  if (e.absolute && typeof e.alpha === 'number') return normDeg(360 - e.alpha);
  return null;
}

/**
 * The way you are going: the GPS course while actually moving (the phone may point anywhere, or be
 * in a pocket), otherwise the compass, the way the phone points.
 */
export function pickHeading(compass: number | null, course: number | null, speed: number): number | null {
  if (course !== null && speed >= MIN_COURSE_SPEED) return normDeg(course);
  return compass;
}

let compassAsked: Promise<boolean> | null = null;
/**
 * Ask for the compass once; later calls get the same answer without asking again. Call it from a
 * tap or key press first: iOS only shows the prompt inside a user gesture.
 */
export function requestCompass(): Promise<boolean> {
  const DOE = (window as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
  compassAsked ??= DOE?.requestPermission ? DOE.requestPermission().then((r) => r === 'granted', () => false) : Promise.resolve(true);
  return compassAsked;
}

/** Positions this many ms apart (or more) give a steady speed and course at walking pace. */
const MOTION_SPAN = 2500;

/** Of the recent positions, the one to measure motion from: the newest at least MOTION_SPAN old, else the oldest. */
export function motionBase<T extends { t: number }>(track: T[], now: number): T | null {
  let base: T | null = null;
  for (const p of track) if (now - p.t >= MOTION_SPAN) base = p;
  return base ?? track[0] ?? null;
}

/**
 * Blend a new fix into the estimate, weighting each by its accuracy: a poor fix moves us little, a good one a lot.
 * The estimate is first carried forward at its speed and course: left where it was, it would trail a
 * walker by metres (about the fix accuracy at walking pace), and every turn and crossing would be
 * called late. Its uncertainty grows with the time since the last fix and the speed we may have covered.
 */
export function fuse(prev: Estimate | null, x: number, y: number, acc: number, t: number, speed: number, course: number | null = null): Estimate {
  // a NaN position, speed or a zero accuracy would poison every later estimate
  if (!Number.isFinite(x + y)) return prev ?? { x: 0, y: 0, acc: 1000, t, vx: 0, vy: 0 };
  acc = Math.max(acc, 1);
  speed = Number.isFinite(speed) ? Math.max(0, speed) : 0;
  const rad = ((course ?? 0) * Math.PI) / 180;
  const v = course !== null && Number.isFinite(course) ? { vx: speed * Math.sin(rad), vy: speed * Math.cos(rad) } : { vx: 0, vy: 0 };
  if (!prev) return { x, y, acc, t, ...v };
  const dt = Math.max(0, t - prev.t);
  const p = coast(prev, t);
  const reach = Math.max(speed, 1) * dt;
  const pv = prev.acc ** 2 + reach ** 2;
  const k = pv / (pv + acc ** 2);
  return { x: p.x + (x - p.x) * k, y: p.y + (y - p.y) * k, acc: Math.sqrt((1 - k) * pv), t, ...v };
}

/** Where the estimate puts us at time t (s): carried on at its speed and course, for at most MAX_COAST seconds. */
export function coast(e: Estimate, t: number): { x: number; y: number } {
  const dt = Math.min(MAX_COAST, Math.max(0, t - e.t));
  return { x: e.x + e.vx * dt, y: e.y + e.vy * dt };
}

/** Search radius for snapping to a road, or 0 when the position is too uncertain to snap. */
export function snapRadius(acc: number): number {
  return acc <= SNAP_MAX ? Math.max(acc, 10) : 0;
}

/** Speed (m/s) and course from two timed positions, for devices that report neither; null when too close in time. */
export function motionBetween(a: { lat: number; lon: number; t: number }, b: { lat: number; lon: number; t: number }): { speed: number; heading: number } | null {
  const dt = (b.t - a.t) / 1000;
  if (dt < 0.5) return null;
  const R = 6_371_000;
  const dx = (relAngle(a.lon, b.lon) * Math.PI) / 180 * R * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const dy = ((b.lat - a.lat) * Math.PI) / 180 * R;
  return { speed: Math.hypot(dx, dy) / dt, heading: normDeg((Math.atan2(dx, dy) * 180) / Math.PI) };
}

/** Move angle `from` a fraction k of the way to `to`, the short way round north. */
export function easeAngle(from: number, to: number, k: number): number {
  return normDeg(from + relAngle(from, to) * Math.max(0, Math.min(1, k)));
}

export class LiveGps {
  /** where the phone points, or null when it is not held to point (see heldToPoint) */
  compass: number | null = null;
  private watch: number | null = null;
  private lost = false;
  private stopped = false;
  /** the last few seconds of positions, to work out speed and course when the device does not say */
  private track: { lat: number; lon: number; t: number }[] = [];

  constructor(
    private onFix: (f: GpsFix) => void,
    private onProblem: (p: GpsProblem) => void,
    private onRecovered: () => void,
  ) {}

  private onOrientation = (e: Event) => {
    const o = e as unknown as OrientationLike;
    const h = compassHeading(o);
    if (h !== null) this.compass = heldToPoint(o) ? h : null;
  };

  /** Call from a key press or click: iOS only asks for compass permission inside a user gesture. */
  async start(): Promise<boolean> {
    if (!('geolocation' in navigator)) {
      this.onProblem('unsupported');
      return false;
    }
    // a refused compass is not fatal: GPS course still works while moving
    const granted = await requestCompass();
    // turned off while the permission prompt was open
    if (this.stopped) return false;
    if (granted) {
      window.addEventListener('deviceorientationabsolute', this.onOrientation);
      window.addEventListener('deviceorientation', this.onOrientation);
    }
    this.watch = navigator.geolocation.watchPosition(
      (p) => {
        if (this.lost) {
          this.lost = false;
          this.onRecovered();
        }
        const c = p.coords;
        const here = { lat: c.latitude, lon: c.longitude, t: p.timestamp };
        // some devices report no speed or course; work them out from the last fix
        const course = c.heading === null || Number.isNaN(c.heading) ? null : c.heading;
        // measured over a few seconds: fix to fix, GPS wander swamps walking pace
        const base = motionBase(this.track, here.t);
        const m = c.speed === null || course === null ? base && motionBetween(base, here) : null;
        this.track = [...this.track.filter((p) => here.t - p.t <= 6000), here];
        const speed = c.speed !== null && Number.isFinite(c.speed) ? c.speed : (m?.speed ?? 0);
        const heading = course ?? m?.heading ?? null;
        this.onFix({ lat: c.latitude, lon: c.longitude, speed, heading, accuracy: Number.isFinite(c.accuracy) ? c.accuracy : null });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) return this.onProblem('denied');
        if (!this.lost) {
          this.lost = true;
          this.onProblem('nosignal');
        }
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15_000 },
    );
    return true;
  }

  stop() {
    this.stopped = true;
    if (this.watch !== null) navigator.geolocation.clearWatch(this.watch);
    this.watch = null;
    window.removeEventListener('deviceorientationabsolute', this.onOrientation);
    window.removeEventListener('deviceorientation', this.onOrientation);
  }
}
