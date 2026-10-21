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
  /** the brake key is held, not just easing off: tyres and brakes squeal */
  brake?: boolean;
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
  private model = '';
  private hornUntil = 0;
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

  /** model: a VehicleModel id; each model has its own engine, tyres or footsteps */
  setVehicle(id: VehicleId, model = '') {
    this.vehicleId = id;
    this.model = model;
    this.voice?.dispose();
    this.voice = this.engineOn ? makeVoice(id, model, this, this.bed) : null;
  }

  /** Off while the vehicle is parked (grid mode): its engine, rotor or footsteps fall silent until switched back on. */
  setEngine(on: boolean) {
    if (on === this.engineOn) return;
    this.engineOn = on;
    this.voice?.dispose();
    this.voice = on && this.vehicleId ? makeVoice(this.vehicleId, this.model, this, this.bed) : null;
  }

  update(s: EngineState, dt: number) {
    const t = this.now;
    this.voice?.update(s, dt);
    const r = s.speed / Math.max(1, s.maxSpeed);
    // a rider's helmet is out in the wind
    const exposed = this.vehicleId === 'motorbike' ? 1.8 : 1;
    this.wind.gain.gain.setTargetAtTime(Math.min(0.08, 0.007 + r * r * 0.08) * exposed * (s.speed > 0.3 && s.wind !== false ? 1 : 0), t, 0.2);
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

  /** Just for fun: the car's horn, a bike bell, a motorbike's horn or revs, a walker's whistle, a helicopter's siren or radio. */
  horn() {
    const t = this.now;
    if (t < this.hornUntil) return;
    switch (this.vehicleId) {
      case 'car': {
        // first and second note, level, then [start, length] of each honk
        const [f1, f2, level, honks] =
          (
            {
              sports: [523, 659, 0.13, [[0, 0.11], [0.17, 0.11]]],
              taxi: [440, 554, 0.13, [[0, 0.12], [0.18, 0.12], [0.36, 0.4]]],
              pickup: [311, 392, 0.17, [[0, 0.75]]],
            } as Record<string, [number, number, number, number[][]]>
          )[this.model] ?? [415, 523, 0.14, [[0, 0.45]]];
        for (const [at, dur] of honks) this.honk(t + at, dur, f1, f2, level);
        this.hornUntil = t + Math.max(...honks.map(([at, dur]) => at + dur));
        return;
      }
      case 'motorbike':
        if ((this.model === 'cruiser' || this.model === 'dirt') && this.voice?.rev) {
          this.voice.rev(); // vroom vroom
          this.hornUntil = t + 0.75;
        } else if (this.model === 'scooter') {
          this.honk(t, 0.1, 620, 780, 0.11);
          this.honk(t + 0.15, 0.1, 620, 780, 0.11);
          this.hornUntil = t + 0.25;
        } else {
          this.honk(t, 0.3, 470, 590, 0.12);
          this.hornUntil = t + 0.3;
        }
        return;
      case 'bicycle': {
        const [f, rings] = ({ road: [3300, 1], mountain: [2600, 2], city: [2050, 3] } as Record<string, [number, number]>)[this.model] ?? [2600, 2];
        for (let i = 0; i < rings; i++) this.bell(t + i * 0.16, f);
        this.hornUntil = t + rings * 0.16;
        return;
      }
      case 'helicopter':
        if (this.model === 'rescue') {
          // two-tone siren
          for (let i = 0; i < 4; i++) this.honk(t + i * 0.32, 0.3, i % 2 ? 700 : 940, i % 2 ? 702 : 942, 0.11);
          this.hornUntil = t + 1.28;
        } else {
          // the pilot's radio: a crackle of squelch, then a roger beep
          this.noiseBurst(this.master, t, 0.18, 2000, 0.5, 0.35);
          this.tone(1000, { when: t + 0.2, dur: 0.08, level: 0.12, type: 'square' });
          this.tone(1300, { when: t + 0.29, dur: 0.1, level: 0.12, type: 'square' });
          this.hornUntil = t + 0.4;
        }
        return;
      default:
        if (this.model === 'green') {
          // sports whistle: a fast trill
          for (let i = 0; i < 10; i++) this.tone(i % 2 ? 2900 : 2650, { when: t + i * 0.035, dur: 0.05, level: 0.1 });
          this.hornUntil = t + 0.4;
        } else {
          // a whistle to get attention: up, then down
          this.tone(1800, { dur: 0.14, level: 0.12, glideTo: 2700 });
          this.tone(2700, { when: t + 0.18, dur: 0.26, level: 0.12, glideTo: 1900 });
          this.hornUntil = t + 0.45;
        }
    }
  }

  /** A car horn: two buzzy notes together, held for dur. */
  private honk(when: number, dur: number, f1: number, f2: number, level: number) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(level, when + 0.015);
    g.gain.setValueAtTime(level, when + dur - 0.03);
    g.gain.linearRampToValueAtTime(0, when + dur);
    lp.connect(g).connect(this.master);
    for (const f of [f1, f2]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(lp);
      o.start(when);
      o.stop(when + dur + 0.02);
    }
  }

  /** A bicycle bell: a struck metal dome, its overtones out of tune with each other. */
  private bell(when: number, f: number) {
    this.tone(f, { when, dur: 0.6, level: 0.13 });
    this.tone(f * 2.76, { when, dur: 0.35, level: 0.06 });
    this.tone(f * 5.4, { when, dur: 0.15, level: 0.03 });
    this.noiseBurst(this.master, when, 0.01, 6000, 2, 0.15);
  }
}

// ---------- vehicle voices ----------

interface VehicleVoice {
  update(s: EngineState, dt: number): void;
  dispose(): void;
  /** blip the throttle, for engines */
  rev?(): void;
}

function makeVoice(id: VehicleId, model: string, a: AudioEngine, out: AudioNode): VehicleVoice {
  switch (id) {
    case 'walker':
      return new WalkerVoice(a, out, model);
    case 'bicycle':
      return new BicycleVoice(a, out, model);
    case 'car':
      return new EngineVoice(a, out, model, 'sedan');
    case 'motorbike':
      return new EngineVoice(a, out, model, 'sport');
    case 'helicopter':
      return new HelicopterVoice(a, out, model);
  }
}

/** A looping noise source through a filter into a silent gain, for sounds that fade in and out. */
function noiseLoop(a: AudioEngine, out: AudioNode, type: BiquadFilterType, freq: number, q = 1) {
  const ctx = a.ctx;
  const src = ctx.createBufferSource();
  src.buffer = a.noise;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  src.connect(f).connect(gain).connect(out);
  src.start(a.now, Math.random() * 1.5);
  return { src, f, gain };
}

/** A sine that is silent until its gain is raised: brake squeal, electric whine. */
function toneLoop(a: AudioEngine, out: AudioNode, freq: number) {
  const o = a.ctx.createOscillator();
  o.frequency.value = freq;
  const gain = a.ctx.createGain();
  gain.gain.value = 0;
  o.connect(gain).connect(out);
  o.start();
  return { o, gain };
}

class WalkerVoice implements VehicleVoice {
  private phase = 0;
  private foot = 0;
  private pan: StereoPannerNode[];
  constructor(
    private a: AudioEngine,
    out: AudioNode,
    private model: string,
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
      const boots = this.model === 'green';
      const run = (s.speed > 2.2 ? 1.4 : 1) * (boots ? 1.25 : 1);
      if (s.surface === 'offroad') {
        this.a.noiseBurst(dest, when, 0.12, 700, 0.8, 0.35 * run); // grass / dirt
      } else if (s.surface === 'rough') {
        this.a.noiseBurst(dest, when, 0.09, 1500, 0.7, 0.4 * run); // gravel crunch
        this.a.noiseBurst(dest, when + 0.02, 0.06, 3000, 1, 0.2 * run);
      } else if (boots) {
        // heavy heel thud, then the sole scuffing
        this.a.tone(120, { when, dur: 0.07, level: 0.16, type: 'sine', glideTo: 70, dest });
        this.a.noiseBurst(dest, when, 0.07, 1100, 1.2, 0.45 * run);
        this.a.noiseBurst(dest, when + 0.08, 0.05, 1900, 1.5, 0.2 * run);
      } else if (this.model === 'red') {
        this.a.noiseBurst(dest, when, 0.06, 900, 1.2, 0.35 * run); // soft trainer sole
        this.a.noiseBurst(dest, when + 0.06, 0.03, 1700, 2, 0.1 * run);
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

const BIKES: Record<string, { tyre: number; tyreFreq: number; tick: number; tickFreq: number; squeal: number }> = {
  road: { tyre: 0.7, tyreFreq: 1.4, tick: 1.4, tickFreq: 5200, squeal: 2300 },
  mountain: { tyre: 1.4, tyreFreq: 0.8, tick: 0.8, tickFreq: 3800, squeal: 3100 },
  city: { tyre: 1, tyreFreq: 1, tick: 0.6, tickFreq: 3300, squeal: 1900 },
};

class BicycleVoice implements VehicleVoice {
  private tire: ReturnType<typeof noiseLoop>;
  private squeal: ReturnType<typeof toneLoop>;
  private kind: (typeof BIKES)[string];
  private tickPhase = 0;
  private pedalPhase = 0;
  private gear = 0;
  constructor(
    private a: AudioEngine,
    private out: AudioNode,
    private model: string,
  ) {
    this.kind = BIKES[model] ?? BIKES.road;
    this.tire = noiseLoop(a, out, 'lowpass', 400);
    this.squeal = toneLoop(a, out, this.kind.squeal);
  }
  update(s: EngineState, dt: number) {
    const t = this.a.now;
    const k = this.kind;
    const r = s.speed / s.maxSpeed;
    const rough = s.surface !== 'paved' ? 2 : 1;
    this.tire.gain.gain.setTargetAtTime(s.speed > 0.2 ? (0.05 + r * 0.2) * rough * k.tyre : 0, t, 0.1);
    this.tire.f.frequency.setTargetAtTime((250 + r * 700 * rough) * k.tyreFreq, t, 0.1);
    // freewheel ticking while coasting
    if (s.throttle <= 0 && s.speed > 0.5) {
      this.tickPhase += dt * (4 + s.speed * 3) * k.tick;
      if (this.tickPhase >= 1) {
        this.tickPhase -= 1;
        this.a.noiseBurst(this.out, t + 0.005, 0.015, k.tickFreq, 6, 0.18);
      }
    }
    // chain running over the sprockets, once per pedal stroke
    if (s.throttle > 0 && s.speed > 0.5) {
      this.pedalPhase += dt * (1.6 + r * 1.4);
      if (this.pedalPhase >= 1) {
        this.pedalPhase -= 1;
        this.a.noiseBurst(this.out, t + 0.005, 0.08, 1500, 3, 0.07);
      }
    }
    // the derailleur clicks as you speed up or slow down through the gears
    const gear = Math.min(5, Math.floor(r * 6));
    if (gear !== this.gear) {
      if (s.speed > 0.5) {
        this.a.noiseBurst(this.out, t + 0.005, 0.02, 6000, 10, 0.22);
        this.a.noiseBurst(this.out, t + 0.04, 0.02, 4500, 10, 0.16);
      }
      this.gear = gear;
    }
    // rim or disc brakes squeal under hard braking
    const squeal = s.brake && s.speed > 1.5 ? 0.012 + r * 0.03 : 0;
    this.squeal.gain.gain.setTargetAtTime(squeal, t, squeal ? 0.05 : 0.03);
    // a loose mudguard or knobbly tyres rattle on rough ground
    if (rough > 1 && s.speed > 1 && this.model !== 'road' && Math.random() < dt * 6) {
      this.a.noiseBurst(this.out, t + 0.005, 0.03, 2600, 8, 0.12);
    }
  }
  dispose() {
    fadeOut(this.a, [this.tire.gain, this.squeal.gain], [this.tire.src, this.squeal.o]);
  }
}

interface EngineKind {
  /** when each cylinder fires, as a fraction of the four-stroke cycle (two turns of the crank) */
  firing: number[];
  /** how hard each firing hits, for engines whose cylinders sound unlike each other */
  amps?: number[];
  idle: number;
  redline: number;
  /** road speed (m/s) at the redline in each gear; none for a twist-and-go scooter */
  gears?: number[];
  /** how open the exhaust note is, and overall loudness */
  bright: number;
  level: number;
  /** exhaust rasp: noise riding on each firing */
  rasp: number;
  /** air rushing into the intake under load */
  intake: number;
  /** pops and crackles from the exhaust when the throttle shuts at high revs */
  crackle: number;
  /** tyre noise: four wide tyres, or two narrow ones */
  tyres: number;
  diesel?: boolean;
  turbo?: boolean;
  /** below this speed (m/s) the hybrid runs on its electric motor alone */
  electric?: number;
}

const even = (n: number) => Array.from({ length: n }, (_, i) => i / n);

const ENGINES: Record<string, EngineKind> = {
  // cars
  sedan: { firing: even(4), idle: 800, redline: 6500, gears: [12, 21, 31, 45, 70], bright: 1, level: 1, rasp: 0.3, intake: 0.6, crackle: 0, tyres: 1 },
  // a cross-plane V8: the two banks fire unevenly, which is its burble
  sports: { firing: even(8), amps: [1, 0.7, 1, 0.8, 0.95, 0.65, 1, 0.75], idle: 950, redline: 7500, gears: [14, 23, 32, 42, 56, 75], bright: 1.4, level: 1.25, rasp: 1, intake: 0.8, crackle: 1, tyres: 1.1 },
  taxi: { firing: even(4), idle: 800, redline: 6000, gears: [12, 21, 31, 45, 70], bright: 0.85, level: 0.75, rasp: 0.2, intake: 0.4, crackle: 0, tyres: 1, electric: 9 },
  pickup: { firing: even(6), idle: 650, redline: 4200, gears: [9, 16, 25, 38, 55], bright: 0.7, level: 1.15, rasp: 0.6, intake: 0.5, crackle: 0, tyres: 1.2, diesel: true, turbo: true },
  // motorbikes
  sport: { firing: even(4), idle: 1300, redline: 14000, gears: [20, 30, 40, 50, 58, 66], bright: 1.6, level: 1.1, rasp: 0.9, intake: 1, crackle: 0.8, tyres: 0.5 },
  // a 45 degree V-twin fires twice, 405 and 315 degrees apart: potato-potato
  cruiser: { firing: [0, 405 / 720], idle: 850, redline: 5500, gears: [13, 21, 30, 40, 55], bright: 0.8, level: 1.3, rasp: 1, intake: 0.5, crackle: 0.5, tyres: 0.6 },
  dirt: { firing: [0], idle: 1500, redline: 11000, gears: [12, 19, 27, 36, 46], bright: 1.2, level: 1, rasp: 1.2, intake: 0.8, crackle: 0.6, tyres: 0.6 },
  // a two-stroke fires every turn
  scooter: { firing: [0, 0.5], idle: 1700, redline: 9000, bright: 1.3, level: 0.75, rasp: 1.4, intake: 0.3, crackle: 0, tyres: 0.4 },
};

/** One engine cycle as a train of short pulses, one per firing, built from its harmonics. */
function engineWave(ctx: BaseAudioContext, k: EngineKind): PeriodicWave {
  const n = 96;
  const real = new Float32Array(n + 1);
  const imag = new Float32Array(n + 1);
  const width = 0.012; // of a cycle
  for (let h = 1; h <= n; h++) {
    const fall = Math.exp(-((2 * Math.PI * h * width) ** 2) / 2);
    k.firing.forEach((at, i) => {
      const amp = (k.amps?.[i] ?? 1) * fall;
      real[h] += amp * Math.cos(2 * Math.PI * h * at);
      imag[h] += amp * Math.sin(2 * Math.PI * h * at);
    });
  }
  return ctx.createPeriodicWave(real, imag);
}

/**
 * A car or motorbike engine. Revs follow road speed through a gearbox: pulling hard holds each gear
 * near the redline with a clutch dip at each change; holding a speed settles into a high gear at
 * low revs; slowing drops a gear at a time with a blip, the engine braking with its exhaust popping.
 */
class EngineVoice implements VehicleVoice {
  private osc: OscillatorNode;
  private filter: BiquadFilterNode;
  private body: GainNode;
  private wobble: { lfo: OscillatorNode; depth: GainNode };
  private rasp: ReturnType<typeof noiseLoop>;
  private intake: ReturnType<typeof noiseLoop>;
  private rough: ReturnType<typeof noiseLoop>;
  private road: ReturnType<typeof noiseLoop>;
  private squeal: ReturnType<typeof toneLoop>;
  private squeal2: ReturnType<typeof toneLoop>;
  private gearbox: ReturnType<typeof toneLoop>;
  private whine: ReturnType<typeof toneLoop> | null = null;
  private turbo: ReturnType<typeof toneLoop> | null = null;
  private kind: EngineKind;
  private clock = 0;
  private gear = 1;
  private shiftLock = 0;
  private dipUntil = 0;
  /** extra revs from a rev-matching blip, as a share of the redline; dies away */
  private blip = 0;
  private rpm: number;
  private load = 0;
  private boost = 0;
  private lastThrottle = 0;
  /** times the rider blips the throttle for fun */
  private revs: number[] = [];
  constructor(
    private a: AudioEngine,
    private out: AudioNode,
    model: string,
    fallback: string,
  ) {
    const ctx = a.ctx;
    const k = (this.kind = ENGINES[model] ?? ENGINES[fallback]);
    this.rpm = k.idle;
    this.osc = ctx.createOscillator();
    this.osc.setPeriodicWave(engineWave(ctx, k));
    this.osc.frequency.value = k.idle / 120;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 2.5;
    this.body = ctx.createGain();
    this.body.gain.value = 0;
    this.osc.connect(this.filter).connect(this.body).connect(out);
    // a rough idle: the revs hunt a little, which smooths out once moving
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 1.7;
    const depth = ctx.createGain();
    depth.gain.value = 0;
    lfo.connect(depth).connect(this.osc.detune);
    this.wobble = { lfo, depth };

    // exhaust rasp: noise that bursts with each firing (a diesel's clatter is the same, brighter)
    this.rasp = noiseLoop(a, out, 'bandpass', k.diesel ? 2400 : 1200, k.diesel ? 2 : 1);
    const gate = ctx.createGain();
    gate.gain.value = 0;
    this.rasp.f.disconnect();
    this.rasp.f.connect(gate).connect(this.rasp.gain);
    const gateDepth = ctx.createGain();
    gateDepth.gain.value = 1;
    this.osc.connect(gateDepth).connect(gate.gain);

    this.intake = noiseLoop(a, out, 'bandpass', 800, 1.2);
    this.rough = noiseLoop(a, out, 'lowpass', 350);
    // tyres rolling on tarmac, rising with speed
    this.road = noiseLoop(a, out, 'bandpass', 600, 0.7);
    // two close tones beat against each other like a skidding tyre
    this.squeal = toneLoop(a, out, 1150);
    this.squeal2 = toneLoop(a, out, 1215);
    // gears whine when the engine is braking
    this.gearbox = toneLoop(a, out, 400);
    if (k.electric) this.whine = toneLoop(a, out, 300);
    if (k.turbo) this.turbo = toneLoop(a, out, 2000);
    this.osc.start();
    lfo.start();
  }

  /** Two quick blips of the throttle. */
  rev() {
    this.revs = [this.clock, this.clock + 0.45];
  }

  update(s: EngineState, dt: number) {
    const t = this.a.now;
    const k = this.kind;
    this.clock += dt;
    const moving = s.speed > 0.3;
    // held at top speed the engine only holds it, so it eases off and changes up
    const pinned = s.throttle > 0 && s.speed >= s.maxSpeed - 0.1;
    const revving = this.revs.some((at) => this.clock >= at && this.clock < at + 0.25);
    this.revs = this.revs.filter((at) => this.clock < at + 0.25);
    // how hard the engine works: foot down, holding a speed, or shut off with the engine braking
    const want = revving ? 1 : pinned ? 0.6 : s.throttle > 0 ? 1 : s.throttle < 0 ? 0 : moving ? 0.3 : 0.12;
    this.load += (want - this.load) * Math.min(1, dt / 0.12);
    const L = this.load;

    let rpm: number;
    const G = k.gears;
    if (!G) {
      // a scooter's belt drive: the clutch holds the revs up while pulling away, then the speed catches up
      const r = s.speed / s.maxSpeed;
      rpm = moving || s.throttle > 0 ? k.idle + (k.redline - k.idle) * Math.min(1, 0.2 + 0.4 * L + 0.4 * r) : k.idle;
    } else {
      const inGear = (g: number) => (s.speed / G[g - 1]) * k.redline;
      if (!moving) this.gear = 1;
      else if (this.clock > this.shiftLock) {
        // pulling hard holds a gear to near the redline; holding a speed changes up early
        const pulling = s.throttle > 0 && !pinned;
        const up = pulling ? 0.9 : 0.4;
        // slowing changes down sooner, to brake with the engine
        const down = s.throttle < 0 ? 0.35 : pulling ? 0.35 : 0.25;
        if (this.gear < G.length && inGear(this.gear) > up * k.redline && (pulling || inGear(this.gear + 1) > 0.3 * k.redline)) {
          this.gear++;
          this.shiftLock = this.clock + 0.35;
          if (pulling) this.dipUntil = this.clock + 0.14; // clutch in, throttle off, for a moment
        } else if (this.gear > 1 && inGear(this.gear) < down * k.redline && inGear(this.gear - 1) < 0.75 * k.redline) {
          this.gear--;
          this.shiftLock = this.clock + 0.35;
          this.blip = 0.12; // rev matching
        }
      }
      // pulling away the clutch slips, so the engine runs above road speed; rolling to a stop it is
      // pressed in, and the engine drops to idle
      const slip = this.gear === 1 && (moving || s.throttle > 0) ? k.idle * 1.2 + 0.3 * k.redline * L : k.idle;
      rpm = s.throttle <= 0 && s.speed < 3 ? k.idle : Math.max(slip, inGear(this.gear));
    }
    if (revving) rpm = Math.max(rpm, 0.7 * k.redline);
    rpm = Math.min(k.redline, rpm + this.blip * k.redline);
    this.blip *= Math.exp(-dt / 0.12);
    // the engine's own weight: revs take a moment to rise and fall
    this.rpm += (rpm - this.rpm) * Math.min(1, dt / 0.08);
    const rev = this.rpm / k.redline;

    // a hybrid is silent but for its motor's whine until the engine joins in
    const on = k.electric ? Math.max(0, Math.min(1, (s.speed - k.electric) / 3)) : 1;
    const dip = this.clock < this.dipUntil ? 0.35 : 1;
    this.osc.frequency.setTargetAtTime(this.rpm / 120, t, 0.02);
    this.wobble.depth.gain.setTargetAtTime(moving ? 0 : 25, t, 0.3);
    // shutting the throttle muffles the note; opening it lets the exhaust bark
    this.filter.frequency.setTargetAtTime((180 + rev * 2600 * (0.3 + 0.7 * L)) * k.bright, t, 0.04);
    this.body.gain.setTargetAtTime(k.level * on * dip * (0.05 + 0.07 * L + 0.04 * rev), t, dip < 1 ? 0.02 : 0.05);
    const rasp = k.diesel ? 0.05 + 0.05 * L : 0.09 * L * (0.3 + rev);
    this.rasp.gain.gain.setTargetAtTime(k.rasp * k.level * on * dip * rasp, t, 0.05);
    if (!k.diesel) this.rasp.f.frequency.setTargetAtTime(900 + rev * 2200, t, 0.05);
    this.intake.gain.gain.setTargetAtTime(k.intake * on * dip * 0.06 * L * L * rev, t, 0.05);
    this.intake.f.frequency.setTargetAtTime(500 + rev * 2000, t, 0.05);

    // lifting off at high revs pops in the exhaust, and keeps crackling while the engine brakes
    if (k.crackle && on) {
      if (this.lastThrottle > 0 && s.throttle <= 0 && rev > 0.55) {
        for (let i = 0; i < Math.round(4 * k.crackle); i++) this.pop(t + 0.04 + Math.random() * 0.5);
      } else if (L < 0.15 && rev > 0.4 && Math.random() < dt * 5 * k.crackle) {
        this.pop(t + 0.01);
      }
    }
    if (this.turbo) {
      // the turbo spools up under load and sighs out through the blow-off valve when the throttle shuts
      if (this.lastThrottle > 0 && s.throttle <= 0 && this.boost > 0.4) this.a.noiseBurst(this.out, t + 0.02, 0.35, 3200, 0.8, 0.3 * this.boost);
      const spool = s.throttle > 0 ? L * Math.min(1, rev * 1.6) : 0;
      this.boost += (spool - this.boost) * Math.min(1, dt / (spool > this.boost ? 0.5 : 0.1));
      this.turbo.o.frequency.setTargetAtTime(1500 + this.boost * 3500, t, 0.05);
      this.turbo.gain.gain.setTargetAtTime(0.012 * this.boost, t, 0.05);
    }
    this.lastThrottle = s.throttle;
    if (this.whine) {
      this.whine.o.frequency.setTargetAtTime(250 + s.speed * 70, t, 0.1);
      this.whine.gain.gain.setTargetAtTime(moving ? 0.012 + L * 0.01 : 0, t, 0.1);
    }
    this.gearbox.o.frequency.setTargetAtTime((this.rpm / 60) * 2.7, t, 0.05);
    this.gearbox.gain.gain.setTargetAtTime(G && s.throttle < 0 && s.speed > 3 ? 0.005 : 0, t, 0.1);

    const r = s.speed / s.maxSpeed;
    this.road.gain.gain.setTargetAtTime(s.surface === 'paved' && s.speed > 0.5 ? (0.02 + r * 0.07) * k.tyres : 0, t, 0.15);
    this.road.f.frequency.setTargetAtTime(400 + r * 800, t, 0.15);
    this.rough.gain.gain.setTargetAtTime(s.surface !== 'paved' && s.speed > 0.5 ? 0.15 + Math.min(0.2, s.speed / 40) : 0, t, 0.1);
    const squeal = s.brake && s.speed > 8 && s.surface === 'paved' ? (0.015 + r * 0.03) * Math.min(1, k.tyres) : 0;
    this.squeal.gain.gain.setTargetAtTime(squeal, t, squeal ? 0.04 : 0.03);
    this.squeal2.gain.gain.setTargetAtTime(squeal * 0.8, t, squeal ? 0.04 : 0.03);
  }

  private pop(when: number) {
    const low = this.kind.firing.length <= 2; // big twins and singles bang lower
    this.a.noiseBurst(this.out, when, 0.03, (low ? 200 : 350) + Math.random() * 600, 1, (0.3 + Math.random() * 0.3) * this.kind.level);
  }

  dispose() {
    const loops = [this.rasp, this.intake, this.rough, this.road];
    const tones = [this.squeal, this.squeal2, this.gearbox, ...(this.whine ? [this.whine] : []), ...(this.turbo ? [this.turbo] : [])];
    fadeOut(
      this.a,
      [this.body, ...loops.map((l) => l.gain), ...tones.map((x) => x.gain)],
      [this.osc, this.wobble.lfo, ...loops.map((l) => l.src), ...tones.map((x) => x.o)],
    );
  }
}

const HELICOPTERS: Record<string, { rate: number; body: number; thump: number; whine: number; level: number }> = {
  tour: { rate: 5, body: 350, thump: 55, whine: 1400, level: 1 },
  rescue: { rate: 4, body: 260, thump: 42, whine: 1100, level: 1.25 },
  news: { rate: 6.5, body: 550, thump: 70, whine: 1900, level: 0.85 },
};

class HelicopterVoice implements VehicleVoice {
  private lfo: OscillatorNode;
  private whine: OscillatorNode;
  private thump: OscillatorNode;
  private src: AudioBufferSourceNode;
  private depth: GainNode;
  private nodes: GainNode[] = [];
  private kind: (typeof HELICOPTERS)[string];
  constructor(
    private a: AudioEngine,
    out: AudioNode,
    model: string,
  ) {
    const ctx = a.ctx;
    const k = (this.kind = HELICOPTERS[model] ?? HELICOPTERS.tour);
    const src = (this.src = ctx.createBufferSource());
    src.buffer = a.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = k.body;
    const chop = ctx.createGain();
    chop.gain.value = 0.06 * k.level;
    // each blade passing is a sharp pulse rather than a smooth wobble: a sum of equal harmonics
    this.lfo = ctx.createOscillator();
    const harmonics = 10;
    this.lfo.setPeriodicWave(ctx.createPeriodicWave(new Float32Array(harmonics + 1).fill(1), new Float32Array(harmonics + 1)));
    this.lfo.frequency.value = k.rate;
    this.depth = ctx.createGain();
    this.depth.gain.value = 0.22 * k.level;
    this.lfo.connect(this.depth).connect(chop.gain);
    src.connect(f).connect(chop).connect(out);
    src.start();
    this.lfo.start();

    // the low thud of the blades, beating in time with the chop
    this.thump = ctx.createOscillator();
    this.thump.frequency.value = k.thump;
    const tg = ctx.createGain();
    tg.gain.value = 0;
    const td = ctx.createGain();
    td.gain.value = 0.18 * k.level;
    this.lfo.connect(td).connect(tg.gain);
    this.thump.connect(tg).connect(out);
    this.thump.start();

    this.whine = ctx.createOscillator();
    this.whine.type = 'sine';
    this.whine.frequency.value = k.whine;
    const wg = ctx.createGain();
    wg.gain.value = 0.015 * k.level;
    this.whine.connect(wg).connect(out);
    this.whine.start();
    this.nodes.push(chop, tg, wg);
  }
  update(s: EngineState) {
    const t = this.a.now;
    const k = this.kind;
    const r = s.speed / s.maxSpeed;
    const pulling = s.throttle > 0;
    this.lfo.frequency.setTargetAtTime(k.rate * (1 + r * 0.5) + (pulling ? 0.6 : 0), t, 0.3);
    // blades bite harder when pulling away
    this.depth.gain.setTargetAtTime((pulling ? 0.3 : 0.22) * k.level, t, 0.3);
    this.whine.frequency.setTargetAtTime(k.whine * (1 + r * 0.2), t, 0.3);
  }
  dispose() {
    fadeOut(this.a, this.nodes, [this.src, this.lfo, this.whine, this.thump]);
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
