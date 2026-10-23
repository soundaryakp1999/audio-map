// How a car or motorbike engine drives the wheels: torque curves, gearboxes, shifts and grip.
// Both the driving and the engine sound read from here, so what you hear is what moves you.

/** The mechanical side of one engine and its gearbox. */
export interface Powertrain {
  idle: number;
  redline: number;
  /** rpm where the engine pulls hardest */
  peak: number;
  /** pull at idle and at the redline, as a share of the peak: a turbo diesel is flat, a sport bike peaky */
  low: number;
  high: number;
  /** road speed (m/s) at the redline in each gear; none for a twist-and-go or hybrid CVT */
  gears?: number[];
  /** seconds the drive is cut while changing up: a slow automatic, a quickshifter */
  shift: number;
  /** pull in first gear at peak torque, as a multiple of the vehicle's acceleration */
  punch: number;
  /** pull the tyres can take on tarmac, same units: more than this spins them */
  grip: number;
  /** grip on dirt and grass, as a share of tarmac grip */
  looseGrip: number;
  /** its own top speed (m/s), when lower than the vehicle's */
  top?: number;
}

export const POWERTRAINS: Record<string, Powertrain> = {
  // cars
  sedan: { idle: 800, redline: 6500, peak: 4200, low: 0.55, high: 0.75, gears: [12, 21, 31, 45, 70], shift: 0.35, punch: 1.8, grip: 3, looseGrip: 0.35 },
  sports: { idle: 950, redline: 7500, peak: 5200, low: 0.5, high: 0.85, gears: [14, 23, 32, 42, 56, 75], shift: 0.12, punch: 3.2, grip: 2.9, looseGrip: 0.35 },
  // a hybrid's e-CVT: the electric motor pulls away, then the engine holds steady revs
  taxi: { idle: 800, redline: 6000, peak: 4000, low: 0.7, high: 0.7, shift: 0, punch: 1.5, grip: 3, looseGrip: 0.35 },
  // a turbo diesel: all its pull low down, changing up early through a slow box
  pickup: { idle: 650, redline: 4200, peak: 1900, low: 0.6, high: 0.6, gears: [9, 16, 25, 38, 55], shift: 0.45, punch: 2, grip: 3, looseGrip: 0.75 },
  // motorbikes
  sport: { idle: 1300, redline: 14000, peak: 11000, low: 0.35, high: 0.85, gears: [20, 30, 40, 50, 58, 66], shift: 0.06, punch: 2.2, grip: 2.1, looseGrip: 0.4 },
  cruiser: { idle: 850, redline: 5500, peak: 2800, low: 0.7, high: 0.6, gears: [13, 21, 30, 40, 55], shift: 0.25, punch: 1.3, grip: 2.5, looseGrip: 0.55 },
  dirt: { idle: 1500, redline: 11000, peak: 7500, low: 0.5, high: 0.75, gears: [12, 19, 27, 36, 46], shift: 0.15, punch: 1.4, grip: 2.2, looseGrip: 0.9, top: 30 },
  scooter: { idle: 1700, redline: 9000, peak: 7000, low: 0.6, high: 0.7, shift: 0, punch: 1, grip: 2, looseGrip: 0.5, top: 25 },
};

/** The powertrain for a car or motorbike model, falling back to the vehicle's first. */
export function powertrainFor(model: string, fallback: string): Powertrain {
  return POWERTRAINS[model] ?? POWERTRAINS[fallback];
}

/** Engine pull at an rpm, 0..1 of its peak: rising from idle to the peak, falling to the redline, nothing past it. */
export function torqueAt(p: Powertrain, rpm: number): number {
  if (rpm > p.redline * 1.001) return 0;
  const ease = (x: number) => (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, x)))) / 2;
  if (rpm <= p.peak) return p.low + (1 - p.low) * ease((rpm - p.idle) / (p.peak - p.idle));
  return 1 - (1 - p.high) * ease((rpm - p.peak) / (p.redline - p.peak));
}

export type Surface = 'paved' | 'rough' | 'offroad';

/** What the engine is doing, for the sound. */
export interface EngineReading {
  rpm: number;
  idle: number;
  redline: number;
  /** current gear, 0 for a CVT */
  gear: number;
  /** how hard the engine works, 0 (shut off, engine braking) .. 1 (foot down) */
  load: number;
  /** mid gear change: the drive is cut */
  shifting: boolean;
  /** wheelspin, 0..1 */
  spin: number;
}

/** A CVT's belt is at its lowest ratio up to this share of top speed, then stretches out. */
const CVT_LOW = 0.3;
/** Pulling away the clutch slips until the engine reaches this rpm in first gear. */
const SLIP_SHARE = 0.32;

/**
 * Runs one engine and gearbox. Each step takes the driver's throttle (-1 slowing, 0 holding the
 * speed, 1 pulling) and the road speed, picks a gear like a good automatic, and returns how hard
 * the engine pushes: torque times gearing, minus the air and road holding it back.
 */
export class Drivetrain {
  gear = 1;
  rpm: number;
  load = 0;
  spin = 0;
  private clock = 0;
  private shiftUntil = 0;
  private lockUntil = 0;
  /** extra revs from a rev-matching blip, as a share of the redline; dies away */
  private blip = 0;
  /** air and rolling resistance: pull lost at speed v is drag * v² */
  private drag: number;
  readonly top: number;

  constructor(
    readonly p: Powertrain,
    /** the vehicle's acceleration (m/s²), which punch and grip multiply */
    private accel: number,
    maxSpeed: number,
  ) {
    this.rpm = p.idle;
    this.top = Math.min(maxSpeed, p.top ?? Infinity);
    // set the drag so full throttle still gains a little at top speed: it gets there, slowly
    this.drag = (0.55 * this.bestPull(this.top)) / (this.top * this.top);
  }

  get shifting() {
    return this.clock < this.shiftUntil;
  }

  reading(): EngineReading {
    return { rpm: this.rpm, idle: this.p.idle, redline: this.p.redline, gear: this.p.gears ? this.gear : 0, load: this.load, shifting: this.shifting, spin: this.spin };
  }

  /** Engine rpm in a gear at road speed v, ignoring the clutch. */
  inGear(g: number, v: number): number {
    const G = this.p.gears!;
    return (v / G[g - 1]) * this.p.redline;
  }

  /** Pull at the wheels (m/s²) in gear g at speed v with the throttle wide open, before grip and drag. */
  pull(g: number, v: number): number {
    const p = this.p;
    const base = this.accel * p.punch;
    if (!p.gears) {
      const r = v / this.top;
      return (base * torqueAt(p, p.peak)) / Math.max(1, r / CVT_LOW);
    }
    const rpm = Math.max(this.slipRpm(g, 1), this.inGear(g, v));
    return base * torqueAt(p, rpm) * (p.gears[0] / p.gears[g - 1]);
  }

  private bestPull(v: number): number {
    if (!this.p.gears) return this.pull(0, v);
    return Math.max(...this.p.gears.map((_, i) => this.pull(i + 1, v)));
  }

  /** While the clutch slips in first, the engine runs at least this fast. */
  private slipRpm(g: number, load: number): number {
    const p = this.p;
    return g === 1 ? p.idle * 1.2 + SLIP_SHARE * (p.peak - p.idle) * load : 0;
  }

  /**
   * Advance dt seconds. Returns the acceleration from the engine (m/s²) while pulling, else 0:
   * holding a speed and slowing down are left to the caller.
   */
  step(dt: number, throttle: number, speed: number, maxSpeed: number, surface: Surface): number {
    const p = this.p;
    this.clock += dt;
    const moving = speed > 0.3;
    // held at top speed the engine only holds it, so it eases off
    const pinned = throttle > 0 && speed >= Math.min(maxSpeed, this.top) - 0.1;
    const pulling = throttle > 0 && !pinned;
    const want = pulling ? 1 : pinned ? 0.55 : throttle < 0 ? 0 : moving ? 0.3 : 0.12;
    this.load += (want - this.load) * Math.min(1, dt / 0.12);

    let rpm: number;
    let drive = 0;
    if (!p.gears) {
      // the belt holds the revs near peak power while pulling, and relaxes them when cruising
      const r = Math.min(1, speed / this.top);
      if (pulling) rpm = p.peak * (0.82 + 0.18 * r);
      else if (moving && throttle === 0) rpm = p.idle + (p.peak - p.idle) * (0.25 + 0.45 * r) * (pinned ? 1.3 : 1);
      else rpm = moving ? p.idle + (p.peak - p.idle) * 0.25 * r : p.idle;
      if (pulling) drive = this.pull(0, speed);
    } else {
      this.chooseGear(speed, throttle, pulling, moving);
      const geared = this.inGear(this.gear, speed);
      // pulling away the clutch slips, so the engine runs above road speed; rolling to a stop it is
      // pressed in, and the engine drops to idle
      if (throttle <= 0 && speed < 3) rpm = p.idle;
      else rpm = Math.max(this.slipRpm(this.gear, moving || throttle > 0 ? this.load : 0), geared, p.idle);
      if (pulling && !this.shifting) drive = this.pull(this.gear, speed);
    }

    // more pull than the tyres can take spins them: the revs flare and the push is held at the grip
    const grip = this.accel * p.grip * (surface === 'paved' ? 1 : surface === 'rough' ? 0.8 : p.looseGrip);
    const excess = drive > grip ? (drive - grip) / grip : 0;
    this.spin += (Math.min(1, excess * 2) - this.spin) * Math.min(1, dt / (excess ? 0.05 : 0.15));
    drive = Math.min(drive, grip);
    rpm *= 1 + 0.25 * this.spin;

    rpm = Math.min(p.redline, rpm + this.blip * p.redline);
    this.blip *= Math.exp(-dt / 0.12);
    // the engine's own weight: revs take a moment to rise and fall, quicker for a light bike
    const inertia = this.shifting ? 0.04 : 0.08;
    this.rpm += (rpm - this.rpm) * Math.min(1, dt / inertia);

    if (!pulling) return 0;
    return Math.max(0, drive - this.drag * speed * speed);
  }

  private chooseGear(speed: number, throttle: number, pulling: boolean, moving: boolean) {
    const p = this.p;
    const G = p.gears!;
    const red = p.redline;
    if (!moving) {
      this.gear = 1;
      return;
    }
    if (this.clock < this.lockUntil) return;
    const g = this.gear;
    const rpm = this.inGear(g, speed);
    let next = g;
    if (pulling) {
      // change up at the redline, or sooner when the next gear already pulls harder
      if (g < G.length && (rpm > 0.96 * red || this.pull(g + 1, speed) > this.pull(g, speed) * 1.02)) next = g + 1;
      // kick down when the engine is labouring
      else if (g > 1 && rpm < 0.4 * p.peak && this.inGear(g - 1, speed) < 0.85 * red) next = g - 1;
    } else if (throttle === 0) {
      // holding a speed settles into a high gear at low revs
      if (g < G.length && rpm > 0.4 * red && this.inGear(g + 1, speed) > 0.3 * red) next = g + 1;
      else if (g > 1 && rpm < 0.25 * red && this.inGear(g - 1, speed) < 0.75 * red) next = g - 1;
    } else if (g > 1 && rpm < 0.35 * red && this.inGear(g - 1, speed) < 0.75 * red) {
      // slowing changes down sooner, to brake with the engine
      next = g - 1;
    }
    if (next === g) return;
    if (next > g && pulling) this.shiftUntil = this.clock + p.shift; // clutch in, throttle off, for a moment
    if (next < g) this.blip = throttle < 0 ? 0.12 : 0.05; // rev matching
    this.gear = next;
    this.lockUntil = this.clock + Math.max(0.35, p.shift + 0.15);
  }
}
