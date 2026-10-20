// Watches the rear camera for a pedestrian signal and beeps for it: a slow low tone for Don't Walk, a short high
// trill for Walk. On its own it sees only lit red or orange (Don't Walk), and says 'unsure' when red and green both
// show. Colour cannot tell a walk signal from a car light, a sign or glare, so Walk comes only from the recognisers
// (the on-device detector, and Gemini if set up), and only when the local check sees nothing: a local Don't Walk or
// 'unsure' always wins. A false Walk is the one mistake this must not make.

export type SignalState = 'walk' | 'dontWalk' | 'unsure' | 'none';

/** Reads the camera frame and says what signal it shows; it may be slow or fail, so its answers are checked for age and repeated. */
export type Recognise = (video: HTMLVideoElement) => Promise<SignalState>;

export interface SignalOptions {
  /** the video element that shows the camera; it must be in the page, and may be hidden from view */
  video: HTMLVideoElement;
  /** called when the confirmed state changes */
  onChange?: (state: SignalState) => void;
  /** recognisers and how often each may be asked (ms); a slow one is simply asked less often */
  recognisers?: { read: Recognise; everyMs: number }[];
  /** frames are looked at only while this returns true, e.g. at a mapped signal crossing; any other frame reads as no signal */
  gate?: () => boolean;
  /** frames analysed per second */
  fps?: number;
  /** lit pixels, as a fraction of the frame, needed before a colour counts as a signal */
  minFraction?: number;
  /** same reading in a row before the state changes, so one noisy frame does not flip the alert */
  confirmFrames?: number;
  /** milliseconds between trills while Walk shows */
  walkBeepMs?: number;
  /** milliseconds between beeps while Don't Walk shows */
  dontWalkBeepMs?: number;
}

const SIZE = { w: 64, h: 48 }; // frames are shrunk to this before counting; a signal is still several pixels wide
const LOST_FRAMES = 10; // frames with no signal before the alert goes quiet
const FRESH_MS = 2500; // a recogniser answer older than this no longer counts
const CONFIRM = 3; // the same recogniser answer this many times in a row before it counts
/** the part of the frame that counts, as fractions: the signal being crossed is aimed at, so the edges are not ours (and may hold bystanders) */
export const CENTRE = { x0: 0.25, x1: 0.75, y0: 0.2, y1: 0.8 };

/** Hue (degrees), saturation and value (0-1) of an RGB pixel. */
function hsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, max ? d / max : 0, max / 255];
}

/**
 * Classify RGBA pixels of a frame `width` pixels wide. Only the middle of the frame counts: the signal being
 * crossed is aimed at, so side lights are not ours. Lit red or orange there is Don't Walk; if lit green shows
 * too, it is a traffic scene and which light is ours cannot be told, so the answer is 'unsure'.
 */
export function classify(rgba: Uint8ClampedArray, width: number, minFraction = 0.004): SignalState {
  const rows = rgba.length / 4 / width;
  let green = 0;
  let red = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const x = (i / 4) % width;
    const y = Math.floor(i / 4 / width);
    if (x < width * CENTRE.x0 || x >= width * CENTRE.x1 || y < rows * CENTRE.y0 || y >= rows * CENTRE.y1) continue;
    const [h, s, v] = hsv(rgba[i], rgba[i + 1], rgba[i + 2]);
    if (s < 0.6 || v < 0.7) continue; // a lit lamp is bright and saturated; paint and foliage are not
    if (h >= 90 && h <= 175) green++;
    else if (h <= 40 || h >= 340) red++; // the US "hand" is orange-red
  }
  const need = (rgba.length / 4) * minFraction;
  if (red < need) return 'none';
  return green >= need ? 'unsure' : 'dontWalk';
}

type Seen = { state: SignalState; at: number };
const RANK: Record<SignalState, number> = { none: 0, walk: 1, unsure: 2, dontWalk: 3 };

/**
 * The local reading wins unless it sees nothing. Then the fresh recogniser answers count, and the most cautious of
 * them wins: one saying Don't Walk or unsure outweighs another saying Walk.
 */
export function pick(local: SignalState, seen: Seen[], now: number): SignalState {
  if (local !== 'none') return local;
  return seen.filter((s) => now - s.at <= FRESH_MS).reduce<SignalState>((a, s) => (RANK[s.state] > RANK[a] ? s.state : a), 'none');
}

/** One recogniser, asked on a timer; its answer counts only once repeated CONFIRM times in a row. */
class Recogniser {
  seen: Seen = { state: 'none', at: 0 };
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private run = 0;
  private candidate: SignalState = 'none';

  constructor(
    private readonly read: () => Promise<SignalState | null>,
    private readonly everyMs: number,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.ask(), this.everyMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.seen = { state: 'none', at: 0 };
    this.run = 0;
  }

  private async ask(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    let answer: SignalState | null = 'none';
    try {
      answer = await this.read();
    } catch {
      // a failed or late answer is the same as no answer
    }
    this.busy = false;
    if (answer === null || !this.timer) return; // not asked (no frame, or away from a crossing), or stopped meanwhile
    this.run = answer === this.candidate ? this.run + 1 : 1;
    this.candidate = answer;
    this.seen = { state: this.run >= CONFIRM ? answer : 'none', at: Date.now() };
  }
}

export class SignalWatcher {
  private readonly o: Required<Omit<SignalOptions, 'onChange' | 'gate' | 'recognisers'>> & Pick<SignalOptions, 'onChange' | 'gate'>;
  private readonly canvas = document.createElement('canvas');
  private readonly recognisers: Recogniser[];
  private stream: MediaStream | null = null;
  private audio: AudioContext | null = null;
  private scan: ReturnType<typeof setInterval> | undefined;
  private alert: ReturnType<typeof setInterval> | undefined;
  private state: SignalState = 'none';
  private candidate: SignalState = 'none';
  private run = 0;

  constructor(options: SignalOptions) {
    this.o = { fps: 5, minFraction: 0.004, confirmFrames: 3, walkBeepMs: 600, dontWalkBeepMs: 1200, ...options };
    this.canvas.width = SIZE.w;
    this.canvas.height = SIZE.h;
    const { video } = options;
    this.recognisers = (options.recognisers ?? []).map(
      (r) => new Recogniser(async () => (video.readyState < 2 || this.o.gate?.() === false ? null : r.read(video)), r.everyMs),
    );
  }

  get active(): boolean {
    return this.stream !== null;
  }

  /** Open the rear camera and start watching. Call from a tap: browsers allow sound only after one. Rejects if the camera is refused. */
  async start(): Promise<void> {
    if (this.stream) return;
    // a high resolution keeps a signal across the road big enough for the detector to see
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      audio: false,
    });
    this.o.video.srcObject = this.stream;
    this.o.video.muted = true;
    this.o.video.setAttribute('playsinline', '');
    await this.o.video.play();
    this.audio = new AudioContext();
    this.scan = setInterval(() => this.frame(), 1000 / this.o.fps);
    for (const r of this.recognisers) r.start();
  }

  /** Stop the camera, the beeps and the recognisers. Safe to call twice; call it when the screen closes. */
  stop(): void {
    clearInterval(this.scan);
    this.scan = undefined;
    for (const r of this.recognisers) r.stop();
    this.setState('none');
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.o.video.srcObject = null;
    void this.audio?.close();
    this.audio = null;
  }

  private frame(): void {
    const { video } = this.o;
    if (video.readyState < 2) return;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    let seen: SignalState = 'none';
    if (this.o.gate?.() !== false) {
      ctx.drawImage(video, 0, 0, SIZE.w, SIZE.h);
      seen = classify(ctx.getImageData(0, 0, SIZE.w, SIZE.h).data, SIZE.w, this.o.minFraction);
      seen = pick(
        seen,
        this.recognisers.map((r) => r.seen),
        Date.now(),
      );
    }
    // a signal needs a few frames in a row to appear, and a longer gap to go away: lamps flicker and cars pass
    const need = seen === 'none' ? LOST_FRAMES : this.o.confirmFrames;
    this.run = seen === this.candidate ? this.run + 1 : 1;
    this.candidate = seen;
    if (this.run >= need && seen !== this.state) this.setState(seen);
  }

  private setState(next: SignalState): void {
    if (next === this.state) return;
    this.state = next;
    clearInterval(this.alert);
    this.alert = undefined;
    if (next === 'walk' || next === 'dontWalk') {
      const sound = next === 'walk' ? () => this.trill() : () => this.tone(400, 0.25);
      sound();
      this.alert = setInterval(sound, next === 'walk' ? this.o.walkBeepMs : this.o.dontWalkBeepMs);
    }
    this.o.onChange?.(next);
  }

  /** Walk: a short high trill. Not a rising pair (that is the turn cue) and not the ticking of a real accessible signal. */
  private trill(): void {
    for (let i = 0; i < 6; i++) this.tone(i % 2 ? 1650 : 1250, 0.04, i * 0.05);
  }

  /** Don't walk: one low, longer tone. */
  private tone(hz: number, seconds: number, delay = 0): void {
    const a = this.audio;
    if (!a) return;
    const at = a.currentTime + delay;
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0.3, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + seconds);
    osc.connect(gain).connect(a.destination);
    osc.start(at);
    osc.stop(at + seconds);
  }
}
