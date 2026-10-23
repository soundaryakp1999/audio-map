import { describe, expect, it } from 'vitest';
import { Drivetrain, POWERTRAINS, powertrainFor, torqueAt, type Surface } from './drivetrain';
import { VEHICLE_MODELS, VEHICLES } from './vehicles';

const DT = 1 / 60;
const car = (model: string) => new Drivetrain(POWERTRAINS[model], VEHICLES.car.accel, VEHICLES.car.maxSpeed);
const bike = (model: string) => new Drivetrain(POWERTRAINS[model], VEHICLES.motorbike.accel, VEHICLES.motorbike.maxSpeed);

/** Full throttle from a standstill; returns seconds to reach `target` m/s (Infinity if never) and the speed after `secs`. */
function launch(d: Drivetrain, target: number, secs = 40, surface: Surface = 'paved', onTick?: (speed: number, pull: number) => void) {
  let v = 0;
  let reached = Infinity;
  for (let t = 0; t < secs; t += DT) {
    const a = d.step(DT, 1, v, 1000, surface);
    onTick?.(v, a);
    v = Math.min(d.top, v + a * DT);
    if (reached === Infinity && v >= target) reached = t;
  }
  return { reached, speed: v };
}

describe('torque curve', () => {
  it('peaks at the peak rpm, falls either side and stops past the redline', () => {
    const p = POWERTRAINS.sedan;
    expect(torqueAt(p, p.peak)).toBeCloseTo(1);
    expect(torqueAt(p, p.idle)).toBeCloseTo(p.low);
    expect(torqueAt(p, p.redline)).toBeCloseTo(p.high);
    expect(torqueAt(p, 2500)).toBeLessThan(1);
    expect(torqueAt(p, p.redline + 100)).toBe(0);
  });
});

describe('drivetrain', () => {
  it('has a powertrain for every car and motorbike model', () => {
    for (const m of [...VEHICLE_MODELS.car, ...VEHICLE_MODELS.motorbike]) expect(POWERTRAINS[m.id]).toBeDefined();
    expect(powertrainFor('spaceship', 'sedan')).toBe(POWERTRAINS.sedan);
  });

  it('changes up through the gears while pulling', () => {
    const d = car('sedan');
    const gears: number[] = [];
    launch(d, Infinity, 20, 'paved', () => gears.at(-1) !== d.gear && gears.push(d.gear));
    expect(gears.slice(0, 4)).toEqual([1, 2, 3, 4]);
  });

  it('pulls harder in a low gear than a high one', () => {
    const d = car('sedan');
    expect(d.pull(1, 8)).toBeGreaterThan(d.pull(2, 8));
    expect(d.pull(2, 15)).toBeGreaterThan(d.pull(4, 15));
  });

  it('cuts the drive while changing up', () => {
    const d = car('pickup');
    let cut = 0;
    launch(d, Infinity, 10, 'paved', (v, a) => {
      if (d.shifting && v > 1) {
        expect(a).toBe(0);
        cut++;
      }
    });
    expect(cut).toBeGreaterThan(10);
  });

  it('eases into its top speed rather than slamming into it', () => {
    const d = car('sedan');
    const early = d.step(DT, 1, 10, 1000, 'paved');
    const late = new Drivetrain(POWERTRAINS.sedan, VEHICLES.car.accel, VEHICLES.car.maxSpeed);
    late.gear = 4;
    const near = late.step(DT, 1, 30, 1000, 'paved');
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(early / 3);
    expect(launch(car('sedan'), d.top - 0.5).reached).toBeLessThan(40);
  });

  it('gives each model its own character', () => {
    const to100 = (d: Drivetrain) => launch(d, 100 / 3.6).reached;
    expect(to100(car('sports'))).toBeLessThan(to100(car('sedan')));
    expect(to100(car('sedan'))).toBeLessThan(to100(car('pickup')));
    expect(to100(bike('sport'))).toBeLessThan(to100(bike('cruiser')));
  });

  it('keeps a scooter to its own top speed', () => {
    const d = bike('scooter');
    expect(d.top).toBe(25);
    expect(launch(d, Infinity).speed).toBeLessThanOrEqual(25);
    expect(d.reading().gear).toBe(0);
  });

  it('spins a powerful car on a hard launch, and anything on loose ground', () => {
    let spun = 0;
    const d = car('sports');
    launch(d, Infinity, 2, 'paved', () => (spun = Math.max(spun, d.spin)));
    expect(spun).toBeGreaterThan(0.05);
    const s = car('sedan');
    let calm = 0;
    launch(s, Infinity, 2, 'paved', () => (calm = Math.max(calm, s.spin)));
    expect(calm).toBe(0);
    const loose = car('sedan');
    let dirt = 0;
    launch(loose, Infinity, 2, 'offroad', () => (dirt = Math.max(dirt, loose.spin)));
    expect(dirt).toBeGreaterThan(0.05);
  });

  it('settles into a high gear at low revs when holding a speed', () => {
    const d = car('sedan');
    for (let t = 0; t < 5; t += DT) d.step(DT, 0, 25, 33, 'paved');
    expect(d.gear).toBeGreaterThanOrEqual(4);
    expect(d.rpm).toBeLessThan(0.5 * d.p.redline);
    expect(d.step(DT, 0, 25, 33, 'paved')).toBe(0);
  });

  it('changes down while slowing and idles once nearly stopped', () => {
    const d = car('sedan');
    d.gear = 4;
    let v = 30;
    while (v > 0) {
      d.step(DT, -1, v, 33, 'paved');
      v -= VEHICLES.car.decel * DT;
    }
    d.step(DT, 0, 0, 33, 'paved');
    expect(d.gear).toBe(1);
    for (let t = 0; t < 1; t += DT) d.step(DT, 0, 0, 33, 'paved');
    expect(d.rpm).toBeCloseTo(d.p.idle, -1);
  });
});

describe('settling at top speed', () => {
  /** Flat out to top speed, hold there, then let go; returns rpm and load each step after letting go. */
  function settle(d: Drivetrain, maxSpeed: number) {
    let v = 0;
    for (let t = 0; t < 40; t += DT) v = Math.min(maxSpeed, v + d.step(DT, 1, v, maxSpeed, 'paved') * DT);
    const gearHeld = d.gear;
    const after: { rpm: number; load: number; gear: number }[] = [];
    for (let t = 0; t < 2; t += DT) {
      d.step(DT, 0, v, maxSpeed, 'paved');
      after.push({ rpm: d.rpm, load: d.load, gear: d.gear });
    }
    return { gearHeld, after };
  }

  it('is already in its cruising gear while held at top speed, so letting go changes nothing abruptly', () => {
    for (const [d, max] of [[car('sedan'), 33], [car('sports'), 33], [bike('sport'), 36]] as const) {
      const { gearHeld, after } = settle(d, max);
      expect(after.every((a) => a.gear === gearHeld)).toBe(true);
      for (let i = 1; i < after.length; i++) expect(Math.abs(after[i].rpm - after[i - 1].rpm)).toBeLessThan(0.02 * d.p.redline);
    }
  });

  it('eases off over about half a second rather than cutting out', () => {
    const { after } = settle(car('sedan'), 33);
    expect(after[Math.round(0.1 / DT)].load).toBeGreaterThan(0.45);
    expect(after.at(-1)!.load).toBeCloseTo(0.3, 1);
  });

  it('glides the revs down when letting go mid-pull changes up', () => {
    const d = car('sedan');
    let v = 0;
    while (v < 20) v += d.step(DT, 1, v, 33, 'paved') * DT;
    const before = d.gear;
    let maxDrop = 0;
    let last = d.rpm;
    for (let t = 0; t < 2; t += DT) {
      d.step(DT, 0, v, 33, 'paved');
      maxDrop = Math.max(maxDrop, last - d.rpm);
      last = d.rpm;
    }
    expect(d.gear).toBeGreaterThan(before);
    expect(maxDrop).toBeLessThan(0.03 * d.p.redline);
  });
});
