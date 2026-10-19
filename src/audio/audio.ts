// Web Audio engine: synthesized vehicle sounds, earcons and 3D (HRTF) positioned cues.

import type { AreaSound } from '../areas';
import type { PlaceGroup } from '../world';
import type { VehicleId } from '../settings';
import { CUES, THEMES, type CueTune, type SoundTheme } from './themes';

export interface EngineState {
  speed: number;
  maxSpeed: number;
  throttle: number; // -1 braking .. 0 coasting .. 1 accelerating
  surface: 'paved' | 'rough' | 'offroad';
  tunnel: boolean;
  /** false when you are really moving (live GPS): the air around you is real, so no wind sound */
  wind?: boolean;
}

const GROUP_PITCH: Record<PlaceGroup, number> = {
  food: 880,
  shop: 660,
  transport: 523,
  culture: 1047,
  nature: 1319,
  health: 784,
  service: 587,
  other: 440,
};

export class AudioEngine {
  readonly ctx: AudioContext;
  private master: GainNode;
  private bed: GainNode; // continuous sounds, ducked under speech
  readonly noise: AudioBuffer;
  private voice: VehicleVoice | null = null;
  private vehicleId: VehicleId | null = null;
  private engineOn = true;
  private wind: { src: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode };
  private rumble: { gain: GainNode; pan: StereoPannerNode; trem: OscillatorNode; filter: BiquadFilterNode };
  private reverb: ConvolverNode;
  private reverbSend: GainNode;

  private theme: SoundTheme = 'classic';
  private tune: CueTune | null = null; // the running cue's theme tuning

  constructor(volume: number, theme: SoundTheme = 'classic') {
    this.theme = theme;
    // Cues synthesise synchronously, so wrapping each one lets tone() see its tuning without touching every cue.
    for (const name of CUES) {
      const cue = (this as any)[name] as (...args: unknown[]) => void;
      (this as any)[name] = (...args: unknown[]) => {
        const prev = this.tune;
        this.tune = THEMES[this.theme][name];
        try {
          cue.apply(this, args);
        } finally {
          this.tune = prev;
        }
      };
    }
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    const ctx = this.ctx;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = volume;
    this.master.connect(comp);

    this.bed = ctx.createGain();
    this.bed.connect(this.master);

    this.noise = makeNoise(ctx);

    // tunnel reverb
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeImpulse(ctx, 1.8);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0;
    this.bed.connect(this.reverbSend);
    this.reverbSend.connect(this.reverb);
    this.reverb.connect(this.master);

    // wind rises with speed
    {
      const src = this.loopNoise();
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 500;
      filter.Q.value = 0.6;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.bed);
      this.wind = { src, gain, filter };
    }

    // rumble strip / off-road texture, panned to one side
    {
      const src = this.loopNoise();
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 180;
      const amp = ctx.createGain();
      amp.gain.value = 0.5;
      const trem = ctx.createOscillator();
      trem.type = 'square';
      trem.frequency.value = 12;
      const tremDepth = ctx.createGain();
      tremDepth.gain.value = 0.5;
      trem.connect(tremDepth).connect(amp.gain);
      trem.start();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = ctx.createStereoPanner();
      src.connect(filter).connect(amp).connect(gain).connect(pan).connect(this.bed);
      this.rumble = { gain, pan, trem, filter };
    }

    // listener faces -Z, up +Y (Web Audio defaults)
  }

  get now() {
    return this.ctx.currentTime;
  }

  resume() {
    // not guarded by state: a suspend() requested just before can still be pending while state reads 'running'
    void this.ctx.resume();
  }

  setVolume(v: number) {
    this.master.gain.setTargetAtTime(v, this.now, 0.05);
  }

  /** Lower continuous sounds while speech plays (built-in voice only). */
  duck(on: boolean, depth = 0.45) {
    this.bed.gain.setTargetAtTime(on ? depth : 1, this.now, 0.08);
  }

  setTheme(t: SoundTheme) {
    this.theme = t;
  }

  setVehicle(id: VehicleId) {
    this.vehicleId = id;
    this.voice?.dispose();
    this.voice = this.engineOn ? makeVoice(id, this, this.bed) : null;
  }

  /** Off while the vehicle is parked (grid mode): its engine, rotor or footsteps fall silent until switched back on. */
  setEngine(on: boolean) {
    if (on === this.engineOn) return;
    this.engineOn = on;
    this.voice?.dispose();
    this.voice = on && this.vehicleId ? makeVoice(this.vehicleId, this, this.bed) : null;
  }

  update(s: EngineState, dt: number) {
    const t = this.now;
    this.voice?.update(s, dt);
    const r = s.speed / Math.max(1, s.maxSpeed);
    this.wind.gain.gain.setTargetAtTime(Math.min(0.08, 0.007 + r * r * 0.08) * (s.speed > 0.3 && s.wind !== false ? 1 : 0), t, 0.2);
    this.wind.filter.frequency.setTargetAtTime(300 + r * 900, t, 0.2);
    this.reverbSend.gain.setTargetAtTime(s.tunnel ? 0.7 : 0, t, 0.3);
  }

  /** level 0..1, pan -1 (left) .. 1 (right), rate in Hz of the strip pulses. */
  setRumble(level: number, pan: number, rate: number) {
    const t = this.now;
    this.rumble.gain.gain.setTargetAtTime(level * 0.55, t, 0.05);
    this.rumble.pan.pan.setTargetAtTime(pan, t, 0.05);
    this.rumble.trem.frequency.setTargetAtTime(Math.max(2, Math.min(40, rate)), t, 0.1);
  }

  // ---------- one-shot cues ----------

  private loopNoise(): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.start();
    return src;
  }

  noiseBurst(dest: AudioNode, when: number, dur: number, freq: number, q: number, level: number) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(level * (this.tune?.level ?? 1), when + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(when, Math.random() * 1.5, dur + 0.05);
  }

  tone(
    freq: number,
    opts: { when?: number; dur?: number; type?: OscillatorType; level?: number; dest?: AudioNode; glideTo?: number } = {},
  ) {
    const ctx = this.ctx;
    const when = opts.when ?? this.now;
    const dur = opts.dur ?? 0.12;
    const tune = this.tune ?? { level: 1, pitch: 1 };
    const o = ctx.createOscillator();
    o.type = tune.wave ?? opts.type ?? 'sine';
    o.frequency.setValueAtTime(freq * tune.pitch, when);
    if (opts.glideTo) o.frequency.exponentialRampToValueAtTime(opts.glideTo * tune.pitch, when + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime((opts.level ?? 0.2) * tune.level, when + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g).connect(opts.dest ?? this.master);
    o.start(when);
    o.stop(when + dur + 0.05);
  }

  /** A node positioned around the listener. rel: degrees clockwise from ahead. Sounds behind are muffled; far (0 near .. 1 at the edge of range) dulls them too. */
  spatial(rel: number, level: number, far = 0): AudioNode {
    const ctx = this.ctx;
    const rad = (rel * Math.PI) / 180;
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'linear';
    p.rolloffFactor = 0;
    p.positionX.value = Math.sin(rad) * 2;
    p.positionY.value = 0;
    p.positionZ.value = -Math.cos(rad) * 2;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    const behind = Math.max(0, -Math.cos(rad)); // 0 ahead .. 1 directly behind
    lp.frequency.value = (12000 - behind * 10000) * (1 - 0.7 * far);
    const g = ctx.createGain();
    g.gain.value = level;
    g.connect(lp).connect(p).connect(this.master);
    return g;
  }

  tick(cardinal: boolean) {
    if (cardinal) {
      this.tone(1760, { dur: 0.09, level: 0.18, type: 'triangle' });
      this.tone(2637, { when: this.now + 0.05, dur: 0.1, level: 0.12, type: 'triangle' });
    } else {
      this.noiseBurst(this.master, this.now, 0.025, 3500, 4, 0.25);
    }
  }

  /** Approaching intersection: rising arpeggio, one note per branch. */
  intersectionChime(branches: number, signals: boolean) {
    const base = 523;
    const n = Math.min(5, Math.max(3, branches));
    for (let i = 0; i < n; i++) {
      this.tone(base * Math.pow(2, (i * 4) / 12), { when: this.now + i * 0.07, dur: 0.18, level: 0.13, type: 'triangle' });
    }
    if (signals) {
      // traffic-signal style tick-tock
      for (let i = 0; i < 3; i++) this.noiseBurst(this.master, this.now + 0.4 + i * 0.18, 0.03, 2200, 8, 0.3);
    }
  }

  /** Warning earcon for a hazard ahead (~0.5 s, so speech follows it). closeness 0 far .. 1 at the hazard. */
  hazardCue(kind: string, rel: number, closeness: number) {
    const t = this.now;
    const dest = this.spatial(rel, 0.12 + 0.12 * closeness);
    switch (kind) {
      case 'Steps': // rising stair-step
        [392, 494, 587, 740].forEach((f, i) => this.tone(f, { when: t + i * 0.08, dur: 0.1, dest, type: 'square', level: 0.35 }));
        break;
      case 'Railway crossing': // low repeating ding
        for (let i = 0; i < 3; i++) this.tone(660, { when: t + i * 0.2, dur: 0.18, dest, type: 'sine', level: 0.7 });
        break;
      case 'Crossing with signals': // two pulses with a signal tick between
        this.tone(880, { when: t, dur: 0.07, dest, type: 'square', level: 0.3 });
        this.noiseBurst(dest, t + 0.1, 0.03, 2200, 8, 0.5);
        this.tone(880, { when: t + 0.2, dur: 0.07, dest, type: 'square', level: 0.3 });
        break;
      case 'Unlit path': // slow falling tone
        this.tone(800, { when: t, dur: 0.5, dest: this.spatial(rel, 0.6 + 0.4 * closeness), glideTo: 480, type: 'sine', level: 1 });
        break;
      default: // pedestrian crossing: urgent two-pulse
        this.tone(880, { when: t, dur: 0.07, dest, type: 'square', level: 0.3 });
        this.tone(880, { when: t + 0.12, dur: 0.07, dest, type: 'square', level: 0.3 });
    }
  }

  placeCue(group: PlaceGroup, rel: number, level = 0.25, when = this.now, far = 0) {
    const dest = this.spatial(rel, level, far);
    const f = GROUP_PITCH[group];
    switch (group) {
      case 'food': // cup clink
        this.tone(f * 2, { when, dur: 0.15, dest, type: 'sine' });
        this.tone(f * 2.76, { when: when + 0.06, dur: 0.12, dest, type: 'sine', level: 0.12 });
        break;
      case 'transport': // two-tone chime
        this.tone(f, { when, dur: 0.16, dest, type: 'triangle' });
        this.tone(f * 1.26, { when: when + 0.12, dur: 0.2, dest, type: 'triangle' });
        break;
      case 'nature': // water drop
        this.tone(f, { when, dur: 0.12, dest, glideTo: f * 2, type: 'sine' });
        break;
      case 'culture': // bell
        this.tone(f, { when, dur: 0.5, dest, type: 'sine' });
        this.tone(f * 2.4, { when, dur: 0.3, dest, type: 'sine', level: 0.08 });
        break;
      case 'health':
        this.tone(f, { when, dur: 0.1, dest, type: 'square', level: 0.08 });
        this.tone(f, { when: when + 0.14, dur: 0.1, dest, type: 'square', level: 0.08 });
        break;
      default:
        this.tone(f, { when, dur: 0.14, dest, type: 'triangle' });
    }
  }

  /** Calibration tone through the same panner as place cues. rel: degrees clockwise from ahead. */
  testTone(rel: number) {
    this.tone(660, { dur: 0.6, dest: this.spatial(rel, 0.3), level: 0.3 });
  }

  /**
   * Destination beacon ping. Stereo position = left/right; pitch = ahead (high) vs behind (low).
   * When you are pointing at it (within 10 degrees) a second, higher note confirms you are on course.
   */
  beacon(rel: number, closeness: number) {
    const rad = (rel * Math.PI) / 180;
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = Math.sin(rad); // -1 hard left .. +1 hard right; ahead and behind are centred
    pan.connect(this.master);
    const aheadness = (1 + Math.cos(rad)) / 2; // 1 straight ahead .. 0 directly behind
    const f = 330 * Math.pow(2, aheadness * 1.6); // ~330 Hz behind .. ~1000 Hz ahead
    const level = 0.22 + closeness * 0.1;
    this.tone(f, { dur: 0.1, dest: pan, type: 'sine', level });
    if (Math.abs(rel) <= 10) this.tone(f * 1.5, { when: this.now + 0.1, dur: 0.12, dest: pan, type: 'sine', level: level * 0.6 });
  }

  arrival() {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, { when: this.now + i * 0.1, dur: 0.3, level: 0.18, type: 'triangle' }));
  }

  sonarStart() {
    this.tone(220, { dur: 0.6, glideTo: 880, level: 0.12, type: 'sine' });
  }

  bump() {
    this.tone(90, { dur: 0.25, level: 0.5, type: 'sine', glideTo: 50 });
    this.noiseBurst(this.master, this.now, 0.15, 400, 1, 0.5);
  }

  error() {
    this.tone(200, { dur: 0.15, level: 0.2, type: 'square' });
  }

  loaded() {
    this.tone(659, { dur: 0.12, level: 0.15, type: 'triangle' });
    this.tone(988, { when: this.now + 0.1, dur: 0.2, level: 0.15, type: 'triangle' });
  }

  /**
   * You are now at a junction: a two-note bell, then a short ping from the direction of each road
   * you can take (ordered left to right; pitch is highest straight ahead).
   */
  atIntersection(exitRels: number[]) {
    const t = this.now;
    for (const [f, dt] of [[1319, 0], [988, 0.16]]) {
      this.tone(f, { when: t + dt, dur: 0.45, level: 0.16, type: 'sine' });
      this.tone(f * 2.76, { when: t + dt, dur: 0.2, level: 0.05, type: 'sine' });
    }
    exitRels.forEach((rel, i) => {
      const dest = this.spatial(rel, 0.32);
      const f = 1320 + (1 - Math.abs(rel) / 180) * 660;
      this.tone(f, { when: t + 0.45 + i * 0.14, dur: 0.07, dest, type: 'triangle' });
    });
  }

  /** Soft falling blip when you leave the junction. */
  leftIntersection() {
    this.tone(660, { dur: 0.1, level: 0.07, type: 'sine', glideTo: 440 });
  }

  /** Approaching an intersection: closeness 0 (edge of range) .. 1 (arriving). Lower for a dead end. */
  proximityBeep(closeness: number, deadEnd: boolean) {
    const f = (deadEnd ? 330 : 880) * (1 + closeness * 0.5);
    this.tone(f, { dur: 0.045, level: 0.06 + closeness * 0.06, type: 'sine' });
  }

  /** "Turn now": a quick rising pair of notes on the side you need to turn to. */
  turnCue(rel: number) {
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, rel / 90));
    pan.connect(this.master);
    this.tone(784, { dur: 0.12, dest: pan, type: 'triangle', level: 0.22 });
    this.tone(1175, { when: this.now + 0.12, dur: 0.2, dest: pan, type: 'triangle', level: 0.22 });
  }

  /**
   * This is the intersection where the route turns: a bright rising major chord from the side to
   * turn to, then a ping from the road to take.
   */
  routeTurnHere(rel: number) {
    const t = this.now;
    const dest = this.spatial(Math.max(-90, Math.min(90, rel)), 0.3);
    [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, { when: t + i * 0.07, dur: 0.35 - i * 0.05, dest, type: 'triangle' }));
    const ping = this.spatial(rel, 0.32);
    this.tone(1980, { when: t + 0.45, dur: 0.08, dest: ping, type: 'triangle' });
  }

  /**
   * An intersection on the route that you go straight through: a single soft low bell instead of
   * the two-note one, then the usual pings from each road.
   */
  routePassIntersection(exitRels: number[]) {
    const t = this.now;
    this.tone(659, { when: t, dur: 0.3, level: 0.07, type: 'sine' });
    exitRels.forEach((rel, i) => {
      const dest = this.spatial(rel, 0.18);
      const f = 1320 + (1 - Math.abs(rel) / 180) * 660;
      this.tone(f, { when: t + 0.25 + i * 0.12, dur: 0.06, dest, type: 'triangle' });
    });
  }

  /** Going the wrong way along the route: a low falling pair from behind you. */
  wrongWay() {
    const dest = this.spatial(180, 0.4);
    this.tone(523, { dur: 0.18, dest, type: 'square', level: 0.12 });
    this.tone(330, { when: this.now + 0.2, dur: 0.3, dest, type: 'square', level: 0.12 });
  }

  /** Road ends ahead: two low falling notes. */
  deadEnd() {
    this.tone(392, { dur: 0.16, level: 0.16, type: 'triangle' });
    this.tone(262, { when: this.now + 0.17, dur: 0.3, level: 0.16, type: 'triangle' });
  }

  /** Grid mode: a short sound for the kind of ground you stepped onto. */
  areaCue(kind: AreaSound) {
    const t = this.now;
    const m = this.master;
    switch (kind) {
      case 'road': // hard click on tarmac
        this.noiseBurst(m, t, 0.04, 2500, 2, 0.45);
        this.tone(180, { dur: 0.05, level: 0.15, type: 'square' });
        break;
      case 'path': // light footstep tap
        this.noiseBurst(m, t, 0.05, 1200, 1.5, 0.3);
        break;
      case 'building': // knock on a door
        this.tone(160, { dur: 0.08, level: 0.35, type: 'sine', glideTo: 110 });
        this.tone(160, { when: t + 0.11, dur: 0.08, level: 0.35, type: 'sine', glideTo: 110 });
        break;
      case 'water': // drop
        this.tone(500, { dur: 0.12, level: 0.25, type: 'sine', glideTo: 1400 });
        this.noiseBurst(m, t + 0.04, 0.12, 900, 0.8, 0.12);
        break;
      case 'green': // rustle of leaves
        this.noiseBurst(m, t, 0.18, 5000, 0.7, 0.18);
        this.noiseBurst(m, t + 0.06, 0.12, 3500, 0.7, 0.12);
        break;
      case 'sport': // whistle
        this.tone(2100, { dur: 0.14, level: 0.12, type: 'sine', glideTo: 2350 });
        break;
      case 'residential': // warm doorbell pair
        this.tone(659, { dur: 0.12, level: 0.16, type: 'triangle' });
        this.tone(523, { when: t + 0.1, dur: 0.16, level: 0.16, type: 'triangle' });
        break;
      case 'commercial': // till ding
        this.tone(1568, { dur: 0.25, level: 0.13, type: 'sine' });
        this.tone(1568 * 2.4, { dur: 0.12, level: 0.04, type: 'sine' });
        break;
      case 'industrial': // metal clank
        this.tone(220, { dur: 0.12, level: 0.1, type: 'square' });
        this.noiseBurst(m, t, 0.1, 1800, 12, 0.5);
        break;
      case 'civic': // soft chord
        this.tone(523, { dur: 0.2, level: 0.12, type: 'sine' });
        this.tone(784, { dur: 0.2, level: 0.1, type: 'sine' });
        break;
      case 'farm': // low hollow thud
        this.tone(330, { dur: 0.14, level: 0.14, type: 'triangle', glideTo: 260 });
        break;
      case 'bare': // gritty crunch
        this.noiseBurst(m, t, 0.09, 600, 0.6, 0.35);
        break;
      default: // open ground: a faint breath
        this.noiseBurst(m, t, 0.12, 800, 0.5, 0.12);
    }
  }

  streetChange() {
    this.tone(1175, { dur: 0.06, level: 0.08, type: 'sine' });
  }
}

// ---------- vehicle voices ----------

interface VehicleVoice {
  update(s: EngineState, dt: number): void;
  dispose(): void;
}

function makeVoice(id: VehicleId, a: AudioEngine, out: AudioNode): VehicleVoice {
  switch (id) {
    case 'walker':
      return new WalkerVoice(a, out);
    case 'bicycle':
      return new BicycleVoice(a, out);
    case 'car':
      return new CarVoice(a, out);
    case 'helicopter':
      return new HelicopterVoice(a, out);
  }
}

class WalkerVoice implements VehicleVoice {
  private phase = 0;
  private foot = 0;
  private pan: StereoPannerNode[];
  constructor(
    private a: AudioEngine,
    out: AudioNode,
  ) {
    this.pan = [-0.25, 0.25].map((v) => {
      const p = a.ctx.createStereoPanner();
      p.pan.value = v;
      p.connect(out);
      return p;
    });
  }
  update(s: EngineState, dt: number) {
    if (s.speed < 0.15) {
      this.phase = 0.9;
      return;
    }
    const stride = s.speed > 2.2 ? 1.1 : 0.75; // running takes longer strides
    this.phase += (s.speed * dt) / stride;
    if (this.phase >= 1) {
      this.phase -= 1;
      this.foot ^= 1;
      const when = this.a.now + 0.01;
      const dest = this.pan[this.foot];
      const run = s.speed > 2.2 ? 1.4 : 1;
      if (s.surface === 'offroad') {
        this.a.noiseBurst(dest, when, 0.12, 700, 0.8, 0.35 * run); // grass / dirt
      } else if (s.surface === 'rough') {
        this.a.noiseBurst(dest, when, 0.09, 1500, 0.7, 0.4 * run); // gravel crunch
        this.a.noiseBurst(dest, when + 0.02, 0.06, 3000, 1, 0.2 * run);
      } else {
        this.a.noiseBurst(dest, when, 0.05, 1800, 2.5, 0.45 * run); // heel
        this.a.noiseBurst(dest, when + 0.07, 0.04, 2600, 3, 0.2 * run); // toe
      }
    }
  }
  dispose() {
    this.pan.forEach((p) => p.disconnect());
  }
}

class BicycleVoice implements VehicleVoice {
  private tire: { src: AudioBufferSourceNode; gain: GainNode; f: BiquadFilterNode };
  private tickPhase = 0;
  constructor(
    private a: AudioEngine,
    private out: AudioNode,
  ) {
    const ctx = a.ctx;
    const src = ctx.createBufferSource();
    src.buffer = a.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 400;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(f).connect(gain).connect(out);
    src.start();
    this.tire = { src, gain, f };
  }
  update(s: EngineState, dt: number) {
    const t = this.a.now;
    const r = s.speed / s.maxSpeed;
    const rough = s.surface !== 'paved' ? 2 : 1;
    this.tire.gain.gain.setTargetAtTime(s.speed > 0.2 ? (0.05 + r * 0.2) * rough : 0, t, 0.1);
    this.tire.f.frequency.setTargetAtTime(250 + r * 700 * rough, t, 0.1);
    // freewheel ticking while coasting
    if (s.throttle <= 0 && s.speed > 0.5) {
      this.tickPhase += dt * (4 + s.speed * 3);
      if (this.tickPhase >= 1) {
        this.tickPhase -= 1;
        this.a.noiseBurst(this.out, t + 0.005, 0.015, 4500, 6, 0.18);
      }
    }
  }
  dispose() {
    this.tire.src.stop();
    this.tire.gain.disconnect();
  }
}

class CarVoice implements VehicleVoice {
  private o1: OscillatorNode;
  private o2: OscillatorNode;
  private f: BiquadFilterNode;
  private gain: GainNode;
  private rough: { src: AudioBufferSourceNode; gain: GainNode };
  private gear = 1;
  private static readonly GEARS = [0, 7, 14, 21, 28, 40]; // upper speed (m/s) for gears 1..5
  constructor(
    private a: AudioEngine,
    out: AudioNode,
  ) {
    const ctx = a.ctx;
    this.o1 = ctx.createOscillator();
    this.o1.type = 'sawtooth';
    this.o2 = ctx.createOscillator();
    this.o2.type = 'square';
    this.f = ctx.createBiquadFilter();
    this.f.type = 'lowpass';
    this.f.frequency.value = 300;
    this.f.Q.value = 3;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0.07;
    const g2 = ctx.createGain();
    g2.gain.value = 0.5;
    this.o1.connect(this.f);
    this.o2.connect(g2).connect(this.f);
    this.f.connect(this.gain).connect(out);
    this.o1.start();
    this.o2.start();

    const src = ctx.createBufferSource();
    src.buffer = a.noise;
    src.loop = true;
    const rf = ctx.createBiquadFilter();
    rf.type = 'lowpass';
    rf.frequency.value = 350;
    const rg = ctx.createGain();
    rg.gain.value = 0;
    src.connect(rf).connect(rg).connect(out);
    src.start();
    this.rough = { src, gain: rg };
  }
  update(s: EngineState) {
    const t = this.a.now;
    const G = CarVoice.GEARS;
    let gear = 1;
    while (gear < 5 && s.speed > G[gear]) gear++;
    if (gear !== this.gear) {
      this.gear = gear;
      // brief dip in the engine on a gear change
      this.gain.gain.cancelScheduledValues(t);
      this.gain.gain.setTargetAtTime(0.03, t, 0.01); // not a jump, which would click
    }
    const lo = G[gear - 1];
    const hi = G[gear];
    const inGear = Math.max(0, Math.min(1, (s.speed - lo) / (hi - lo)));
    const rpm = s.speed < 0.3 ? 800 : 1300 + inGear * 3200; // idle 800
    const f = (rpm / 60) * 2; // 4-cylinder firing frequency
    this.o1.frequency.setTargetAtTime(f, t, 0.06);
    this.o2.frequency.setTargetAtTime(f * 0.5 * 1.01, t, 0.06);
    const load = s.throttle > 0 ? 1 : 0.4;
    this.f.frequency.setTargetAtTime(200 + rpm * 0.12 * load + 200 * load, t, 0.08);
    this.gain.gain.setTargetAtTime(0.05 + load * 0.05 + inGear * 0.02, t, 0.12);
    this.rough.gain.gain.setTargetAtTime(s.surface !== 'paved' && s.speed > 0.5 ? 0.15 + Math.min(0.2, s.speed / 40) : 0, t, 0.1);
  }
  dispose() {
    fadeOut(this.a, [this.gain, this.rough.gain], [this.o1, this.o2, this.rough.src]);
  }
}

class HelicopterVoice implements VehicleVoice {
  private lfo: OscillatorNode;
  private whine: OscillatorNode;
  private src: AudioBufferSourceNode;
  private nodes: AudioNode[] = [];
  constructor(
    private a: AudioEngine,
    out: AudioNode,
  ) {
    const ctx = a.ctx;
    const src = (this.src = ctx.createBufferSource());
    src.buffer = a.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 350;
    const chop = ctx.createGain();
    chop.gain.value = 0.15;
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sawtooth';
    this.lfo.frequency.value = 5;
    const depth = ctx.createGain();
    depth.gain.value = 0.14;
    this.lfo.connect(depth).connect(chop.gain);
    src.connect(f).connect(chop).connect(out);
    src.start();
    this.lfo.start();

    this.whine = ctx.createOscillator();
    this.whine.type = 'sine';
    this.whine.frequency.value = 1400;
    const wg = ctx.createGain();
    wg.gain.value = 0.015;
    this.whine.connect(wg).connect(out);
    this.whine.start();
    this.nodes.push(chop, wg);
  }
  update(s: EngineState) {
    const t = this.a.now;
    const r = s.speed / s.maxSpeed;
    this.lfo.frequency.setTargetAtTime(5 + r * 2.5 + (s.throttle > 0 ? 0.6 : 0), t, 0.3);
    this.whine.frequency.setTargetAtTime(1400 + r * 300, t, 0.3);
  }
  dispose() {
    fadeOut(this.a, this.nodes as GainNode[], [this.src, this.lfo, this.whine]);
  }
}

/** Silences a voice over a few milliseconds before stopping its sources, so switching vehicle does not click. */
function fadeOut(a: AudioEngine, gains: GainNode[], sources: AudioScheduledSourceNode[]) {
  const t = a.now;
  for (const g of gains) {
    g.gain.cancelScheduledValues(t);
    g.gain.setTargetAtTime(0, t, 0.01);
  }
  for (const s of sources) s.stop(t + 0.06);
  sources[0].onended = () => gains.forEach((g) => g.disconnect());
}

function makeNoise(ctx: AudioContext): AudioBuffer {
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function makeImpulse(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  return buf;
}
