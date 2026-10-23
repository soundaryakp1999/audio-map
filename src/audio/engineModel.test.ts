import { describe, expect, it } from 'vitest';
import { EngineModel, SHAPES, type EngineInput } from './engineModel';
import { VEHICLE_MODELS } from '../vehicles';

const SR = 48000;
const BLOCK = 128;

/** A repeatable random source, so a test hears the same engine every run. */
function seeded(seed = 1) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
}

/** Render seconds of one engine with fixed controls; returns exhaust + intake + block summed. */
function render(model: EngineModel, input: Partial<EngineInput>, seconds: number) {
  const full: EngineInput = { rpm: 0, load: 0, fire: 1, misfire: 0, starter: 0, pops: 0, ...input };
  const n = Math.round((seconds * SR) / BLOCK) * BLOCK;
  const out = new Float32Array(n);
  const e = new Float32Array(BLOCK);
  const i = new Float32Array(BLOCK);
  const b = new Float32Array(BLOCK);
  for (let k = 0; k < n; k += BLOCK) {
    model.render(full, e, i, b);
    for (let j = 0; j < BLOCK; j++) out[k + j] = e[j] + i[j] + b[j];
  }
  return out;
}

const rms = (x: Float32Array, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / (to - from));
};

/** Loudness in short windows, for hearing how a sound pulses. */
function envelope(x: Float32Array, win: number) {
  const env: number[] = [];
  for (let i = 0; i + win <= x.length; i += win) env.push(rms(x, i, i + win));
  return env;
}

/** The strongest repetition rate (Hz) in a signal between lo and hi, by autocorrelation. */
function period(x: number[] | Float32Array, rate: number, lo: number, hi: number) {
  const mean = Array.from(x).reduce((a, v) => a + v, 0) / x.length;
  let best = 0;
  let bestLag = 0;
  for (let lag = Math.floor(rate / hi); lag <= Math.ceil(rate / lo); lag++) {
    let s = 0;
    for (let i = 0; i + lag < x.length; i++) s += (x[i] - mean) * (x[i + lag] - mean);
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  return rate / bestLag;
}

describe('modelled engine', () => {
  it('has an engine for every car and motorbike model', () => {
    for (const m of [...VEHICLE_MODELS.car, ...VEHICLE_MODELS.motorbike]) expect(SHAPES[m.id]).toBeDefined();
  });

  it('stays stable and bounded for every engine, from idle to the redline and back', () => {
    for (const [name, shape] of Object.entries(SHAPES)) {
      const m = new EngineModel(shape, SR, seeded());
      for (const input of [{ rpm: 800, load: 0.1 }, { rpm: 9000, load: 1, pops: 10 }, { rpm: 1500, load: 0 }]) {
        const x = render(m, input, 0.5);
        expect(x.every(Number.isFinite), name).toBe(true);
        expect(Math.max(...x.map(Math.abs)), name).toBeLessThan(4);
      }
    }
  });

  it('is silent with the engine stopped', () => {
    const m = new EngineModel(SHAPES.sedan, SR, seeded());
    expect(rms(render(m, { rpm: 0, fire: 0 }, 0.3))).toBeLessThan(1e-3);
  });

  it('beats at its firing rate: four cylinders at 1200 rpm fire 40 times a second', () => {
    const m = new EngineModel({ ...SHAPES.sedan, rough: 0 }, SR, seeded());
    const x = render(m, { rpm: 1200, load: 0.6 }, 1).slice(SR / 2);
    const env = envelope(x, 48); // 1 ms windows
    expect(period(env, 1000, 20, 80)).toBeCloseTo(40, -1);
  });

  it('is louder and brighter under load than shut off', () => {
    const m = new EngineModel(SHAPES.sedan, SR, seeded());
    const on = render(m, { rpm: 3000, load: 1 }, 0.6).slice(SR / 4);
    const off = render(m, { rpm: 3000, load: 0 }, 0.6).slice(SR / 4);
    expect(rms(on)).toBeGreaterThan(rms(off) * 1.3);
  });

  it('labours on the starter: the whirr pulses with each compression, slower than the firing', () => {
    const m = new EngineModel(SHAPES.cruiser, SR, seeded());
    const x = render(m, { rpm: 200, fire: 0, starter: 1 }, 1.5).slice(SR / 2);
    expect(rms(x)).toBeGreaterThan(0.01);
    const env = envelope(x, 240); // 5 ms windows
    const depth = Math.sqrt(env.reduce((a, v) => a + (v - rms(x)) ** 2, 0) / env.length) / rms(x);
    expect(depth).toBeGreaterThan(0.2);
  });

  it('misfires go quiet in the gaps', () => {
    const steady = rms(render(new EngineModel(SHAPES.dirt, SR, seeded()), { rpm: 1500, load: 0.5 }, 0.8));
    const ragged = rms(render(new EngineModel(SHAPES.dirt, SR, seeded()), { rpm: 1500, load: 0.5, misfire: 0.8 }, 0.8));
    expect(ragged).toBeLessThan(steady);
  });

  it('pops crack through the exhaust', () => {
    const quiet = render(new EngineModel(SHAPES.sports, SR, seeded()), { rpm: 4000, load: 0 }, 1);
    const popping = render(new EngineModel(SHAPES.sports, SR, seeded()), { rpm: 4000, load: 0, pops: 20 }, 1);
    expect(Math.max(...popping.map(Math.abs))).toBeGreaterThan(Math.max(...quiet.map(Math.abs)) * 1.5);
  });
});
