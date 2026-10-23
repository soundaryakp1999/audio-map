// A physically informed combustion engine: cylinders, valves and pipes as a network of digital
// waveguides, after Baldan, Lachambre, Delle Monache and Boussard, "Physically informed car engine
// sound synthesis for virtual and augmented environments" (2015). Pure DSP with no Web Audio, so it
// runs inside an AudioWorklet and in tests alike.

/*! Waveguide engine design after engine-sound-generator, Copyright (c) 2021-2022 Antonio-R1, MIT License: https://github.com/Antonio-R1/engine-sound-generator/blob/main/LICENSE (full text in THIRD_PARTY_NOTICES.md) */

/** The build of one engine: its cylinders and the pipes they breathe through. */
export interface EngineShape {
  /** when each cylinder fires, as a fraction of the four-stroke cycle (two turns of the crank) */
  firing: number[];
  /** how hard each firing hits, for engines whose cylinders sound unlike each other */
  amps?: number[];
  /** combustion pulse width as a fraction of the cycle: short and hard for a diesel's knock */
  burn: number;
  /** pipe lengths in metres: each cylinder's intake and exhaust runners, the extractor joining them */
  intake: number;
  exhaust: number;
  extractor: number;
  /** the collector pipe all extractors feed, and the tailpipe after the muffler */
  pipe: number;
  outlet: number;
  /** the muffler's chambers, metres, and how much they hold back (0 open .. 1 baffled) */
  muffler: number[];
  baffle: number;
  /** how unevenly it fires, from one firing to the next: a lumpy idle, a ragged single */
  rough: number;
}

const even = (n: number) => Array.from({ length: n }, (_, i) => i / n);

/** Each car and motorbike model's engine, by model id. */
export const SHAPES: Record<string, EngineShape> = {
  sedan: { firing: even(4), burn: 0.06, intake: 0.35, exhaust: 0.6, extractor: 0.5, pipe: 1.6, outlet: 0.4, muffler: [0.08, 0.12, 0.16, 0.2], baffle: 0.5, rough: 0.05 },
  // a cross-plane V8: the two banks fire unevenly, which is its burble
  sports: { firing: even(8), amps: [1, 0.7, 1, 0.8, 0.95, 0.65, 1, 0.75], burn: 0.06, intake: 0.3, exhaust: 0.5, extractor: 0.6, pipe: 1.2, outlet: 0.3, muffler: [0.1, 0.15], baffle: 0.2, rough: 0.06 },
  // a hybrid, heavily silenced
  taxi: { firing: even(4), burn: 0.06, intake: 0.35, exhaust: 0.6, extractor: 0.5, pipe: 1.8, outlet: 0.5, muffler: [0.06, 0.1, 0.14, 0.18, 0.22], baffle: 0.7, rough: 0.03 },
  // a diesel straight six: a short, hard burn is its knock
  pickup: { firing: even(6), burn: 0.035, intake: 0.5, exhaust: 0.8, extractor: 0.6, pipe: 2.2, outlet: 0.5, muffler: [0.1, 0.15, 0.2, 0.25], baffle: 0.6, rough: 0.08 },
  sport: { firing: even(4), burn: 0.06, intake: 0.2, exhaust: 0.35, extractor: 0.3, pipe: 0.6, outlet: 0.25, muffler: [0.06, 0.09], baffle: 0.25, rough: 0.04 },
  // a 45 degree V-twin fires twice, 405 and 315 degrees apart: potato-potato
  cruiser: { firing: [0, 405 / 720], burn: 0.07, intake: 0.4, exhaust: 0.9, extractor: 0.7, pipe: 0.9, outlet: 0.4, muffler: [0.12, 0.2], baffle: 0.15, rough: 0.12 },
  dirt: { firing: [0], burn: 0.07, intake: 0.25, exhaust: 0.5, extractor: 0.4, pipe: 0.6, outlet: 0.25, muffler: [0.07, 0.1], baffle: 0.2, rough: 0.1 },
  // a two-stroke fires every turn
  scooter: { firing: [0, 0.5], burn: 0.07, intake: 0.15, exhaust: 0.3, extractor: 0.25, pipe: 0.5, outlet: 0.15, muffler: [0.05, 0.07], baffle: 0.35, rough: 0.06 },
};

/** What the engine is told each block. */
export interface EngineInput {
  rpm: number;
  /** throttle opening, 0..1: how much fuel each firing burns */
  load: number;
  /** 0 while it is only being turned over, 1 once the ignition fires */
  fire: number;
  /** chance a firing fails, 0..1: the ragged first turns after it catches */
  misfire: number;
  /** the starter motor, 0..1: engaged and turning the engine over */
  starter: number;
  /** exhaust pops per second: unburnt fuel lighting in the hot pipes */
  pops: number;
}

/** The worklet's parameters, one per EngineInput field. */
export const ENGINE_PARAMS = ['rpm', 'load', 'fire', 'misfire', 'starter', 'pops'] as const satisfies readonly (keyof EngineInput)[];

const C = 343; // speed of sound, m/s

/** A tube: two delay lines carrying pressure each way, partly reflected at each end. */
class Waveguide {
  private right: Float32Array;
  private left: Float32Array;
  private i = 0;
  /** pressure leaving each end this sample */
  outL = 0;
  outR = 0;
  constructor(
    length: number,
    public rL: number,
    public rR: number,
  ) {
    this.right = new Float32Array(length);
    this.left = new Float32Array(length);
  }
  /** Advance one sample, with pressure entering from the left and right ends. */
  step(inL: number, inR: number) {
    const i = this.i;
    const atR = this.right[i];
    const atL = this.left[i];
    this.outR = atR * (1 - this.rR);
    this.outL = atL * (1 - this.rL);
    this.right[i] = inL + atL * this.rL;
    this.left[i] = inR + atR * this.rR;
    this.i = i + 1 === this.right.length ? 0 : i + 1;
  }
}

/** One-pole filters: a lowpass, and a highpass that takes out the DC every firing pushes. */
class OnePole {
  private y = 0;
  private a: number;
  constructor(freq: number, sr: number) {
    this.a = 1 - Math.exp((-2 * Math.PI * freq) / sr);
  }
  low(x: number) {
    return (this.y += this.a * (x - this.y));
  }
  high(x: number) {
    return x - this.low(x);
  }
}

interface Cylinder {
  at: number;
  amp: number;
  chamber: Waveguide;
  intake: Waveguide;
  exhaust: Waveguide;
  extractor: Waveguide;
  /** this firing's strength, drawn as it fires: combustion varies, sometimes fails */
  charge: number;
  last: number;
}

// valve reflections: an open valve lets the wave through, a shut one bounces it back
const OPEN = 0.25;
const SHUT = 0.8;
// the starter's pinion turns the flywheel's ring gear: whine at the teeth meshing
const RING_TEETH = 110;

/** Smooth ramp 0..1 over the last quarter of the cycle: the pressure building toward the top. */
const compression = (y: number) => (y > 0.75 ? ((y - 0.75) / 0.25) ** 3 : 0);

export class EngineModel {
  private cyl!: Cylinder[];
  private collector!: Waveguide;
  private chambers!: Waveguide[];
  private outlet!: Waveguide;
  private breath!: OnePole;
  private blockLow!: OnePole;
  private dc!: OnePole[];
  private phase = 0;
  private meshPhase = 0;
  private rpm = 0;
  private wobble = 0;
  private popLeft = 0;
  private popEnv = 0;
  /** each output's gain, set once so a full-throttle engine sits at a known level whatever its build */
  private norm = [1, 1, 1];

  constructor(
    private shape: EngineShape,
    private sr: number,
    private random: () => number = Math.random,
  ) {
    this.build();
    this.calibrate();
    this.build();
  }

  /** Fresh, silent pipes and cylinders. */
  private build() {
    const { shape, sr } = this;
    const len = (m: number) => Math.max(2, Math.round((m / C) * sr));
    this.cyl = shape.firing.map((at, i) => ({
      at,
      amp: shape.amps?.[i] ?? 1,
      chamber: new Waveguide(len(0.08), 0.5, 0.5),
      intake: new Waveguide(len(shape.intake), 0.01, OPEN),
      exhaust: new Waveguide(len(shape.exhaust), SHUT, 0.01),
      extractor: new Waveguide(len(shape.extractor), 0.01, 0.01),
      charge: 1,
      last: 1,
    }));
    this.collector = new Waveguide(len(shape.pipe), 0.05, 0.05);
    this.chambers = shape.muffler.map((m) => new Waveguide(len(m), 0, shape.baffle));
    this.outlet = new Waveguide(len(shape.outlet), 0.05, 0.05);
    this.breath = new OnePole(6000, sr);
    this.blockLow = new OnePole(140, sr);
    this.dc = [0, 1, 2].map(() => new OnePole(25, sr));
    this.phase = this.meshPhase = this.rpm = this.wobble = this.popLeft = this.popEnv = 0;
  }

  /** Run a moment at full throttle and scale each output to a set loudness. */
  private calibrate() {
    const n = Math.round(this.sr * 0.3);
    const outs = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    const input: EngineInput = { rpm: 3500, load: 1, fire: 1, misfire: 0, starter: 0, pops: 0 };
    this.rpm = input.rpm;
    this.render(input, outs[0], outs[1], outs[2]);
    this.norm = outs.map((o) => {
      let sum = 0;
      for (let i = n >> 1; i < n; i++) sum += o[i] * o[i];
      const rms = Math.sqrt(sum / (n - (n >> 1)));
      return rms > 1e-6 ? 0.25 / rms : 1;
    });
  }

  /**
   * Render one block into the exhaust (tailpipe), intake (air box) and block (the engine's body,
   * with the starter) outputs. The revs glide from the last block's to this one's.
   */
  render(input: EngineInput, exhaust: Float32Array, intake: Float32Array, block: Float32Array) {
    const s = this.shape;
    const n = exhaust.length;
    const from = this.rpm;
    const fuel = input.fire ? 0.2 + 0.8 * input.load : 0;
    const popChance = input.pops / this.sr;
    for (let k = 0; k < n; k++) {
      let rpm = from + ((input.rpm - from) * (k + 1)) / n;
      // turning over, the starter labours against each compression and the crank slows
      let squeeze = 0;
      for (const c of this.cyl) squeeze += compression((this.phase - c.at + 1) % 1);
      squeeze /= Math.max(1, this.cyl.length / 2);
      if (input.starter) rpm *= 1 - 0.45 * input.starter * squeeze;
      // the crank never turns quite evenly
      this.wobble += 0.002 * (this.random() - 0.5) - 0.001 * this.wobble;

      const air = this.breath.low(this.random() * 2 - 1);
      // what the collector sends back is shared among the runners, not copied into each
      const backflow = this.collector.outL / this.cyl.length;
      let feed = 0;
      let chamberOut = 0;
      let intakeOut = 0;
      for (const c of this.cyl) {
        const y = (this.phase - c.at + 1 + this.wobble * s.rough) % 1;
        // a new cycle: draw this firing's charge
        if (y < c.last) c.charge = this.random() < input.misfire ? 0 : 1 + s.rough * (this.random() * 2 - 1);
        c.last = y;
        // power stroke, then exhaust valve open, then intake valve open, then compression
        const burn = y < s.burn ? Math.sin((Math.PI * y) / s.burn) : 0;
        const ev = y >= 0.25 && y < 0.5 ? Math.sin(4 * Math.PI * (y - 0.25)) : 0;
        const iv = y >= 0.5 && y < 0.75 ? Math.sin(4 * Math.PI * (y - 0.5)) : 0;
        const piston = Math.cos(4 * Math.PI * y);
        const ri = OPEN * iv + SHUT * (1 - iv);
        const re = OPEN * ev + SHUT * (1 - ev);
        c.intake.rR = c.chamber.rL = ri;
        c.exhaust.rL = c.chamber.rR = re;
        const push = (piston * 0.4 + burn * 6 * fuel * c.charge * c.amp) * (rpm > 20 ? 1 : rpm / 20);

        const intakeR = c.intake.outR;
        const chamberL = c.chamber.outL;
        const chamberR = c.chamber.outR;
        const exhaustL = c.exhaust.outL;
        const exhaustR = c.exhaust.outR;
        const extractorL = c.extractor.outL;
        c.extractor.step(exhaustR, backflow);
        c.exhaust.step(chamberR, extractorL);
        c.chamber.step(push + intakeR * (1 - ri), exhaustL * (1 - re));
        c.intake.step(air * iv * (0.3 + 0.7 * input.load), chamberL * (1 - ri));
        feed += c.extractor.outR;
        chamberOut += c.chamber.outR;
        intakeOut += c.intake.outL;
      }

      // unburnt fuel catching in the pipes: a sharp crack that rings through the exhaust
      if (popChance && this.random() < popChance) {
        this.popLeft = Math.round(this.sr * (0.004 + 0.006 * this.random()));
        this.popEnv = 2 + 3 * this.random();
      }
      if (this.popLeft > 0) {
        feed += this.popEnv * (this.random() * 2 - 1);
        this.popEnv *= 0.995;
        this.popLeft--;
      }

      const toMuffler = this.collector.outR / this.chambers.length;
      const back = this.outlet.outL / this.chambers.length;
      let mufflerOut = 0;
      let mufflerBack = 0;
      for (const m of this.chambers) {
        mufflerOut += m.outR;
        mufflerBack += m.outL;
        m.step(toMuffler, back);
      }
      this.collector.step(feed, mufflerBack);
      this.outlet.step(mufflerOut, 0);

      // the starter's whine rides on the crank's speed, so it sags with every compression too
      let starter = 0;
      if (input.starter) {
        this.meshPhase = (this.meshPhase + ((rpm / 60) * RING_TEETH) / this.sr) % 1;
        const saw = 2 * this.meshPhase - 1;
        starter = input.starter * (0.5 * saw + 0.3 * Math.sin(2 * Math.PI * this.meshPhase)) * (0.6 + 0.8 * squeeze) * (1 + 0.4 * (this.random() - 0.5));
      }

      exhaust[k] = this.dc[0].high(this.outlet.outR) * this.norm[0];
      intake[k] = this.dc[1].high(intakeOut) * this.norm[1];
      block[k] = this.dc[2].high(this.blockLow.low(chamberOut)) * this.norm[2] + starter * 0.35;

      this.phase += rpm / 120 / this.sr;
      if (this.phase >= 1) this.phase -= 1;
      this.rpm = rpm;
    }
    this.rpm = input.rpm;
  }
}
