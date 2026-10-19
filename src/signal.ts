// Watches the rear camera for a pedestrian signal and beeps for it: slowly for Don't Walk, fast for Walk.
// On its own it sees only lit red or orange (Don't Walk), and says 'unsure' when red and green both show. Colour cannot
// tell a walk signal from a car light, a sign or glare, so Walk comes only from the optional `cloud` recogniser,
// and only when the local check sees nothing: a local Don't Walk or 'unsure' always wins. A false Walk is the one
// mistake this must not make.
// ponytail: local check counts saturated bright red pixels only. A symbol detector on the device would replace `cloud`.

export type SignalState = 'walk' | 'dontWalk' | 'unsure' | 'none';

export interface SignalOptions {
  /** the video element that shows the camera; it must be in the page, and may be hidden from view */
  video: HTMLVideoElement;
  /** called when the confirmed state changes */
  onChange?: (state: SignalState) => void;
  /** reads a photo (base64 JPEG) and says what signal it shows; it may be slow or fail, so its answers are checked for age and repeated */
  cloud?: (jpegBase64: string) => Promise<SignalState>;
  /** frames are looked at only while this returns true, e.g. at a mapped signal crossing; any other frame reads as no signal */
  gate?: () => boolean;
  /** frames analysed per second */
  fps?: number;
  /** lit pixels, as a fraction of the frame, needed before a colour counts as a signal */
  minFraction?: number;
  /** same reading in a row before the state changes, so one noisy frame does not flip the alert */
  confirmFrames?: number;
  /** milliseconds between beeps while Walk shows */
  walkBeepMs?: number;
  /** milliseconds between beeps while Don't Walk shows */
  dontWalkBeepMs?: number;
}

const SIZE = { w: 64, h: 48 }; // frames are shrunk to this before counting; a signal is still several pixels wide
const LOST_FRAMES = 10; // frames with no signal before the alert goes quiet
const CLOUD_MS = 1000; // one photo to the recogniser per second
const CLOUD_FRESH_MS = 2500; // an answer older than this no longer counts
const CLOUD_CONFIRM = 3; // the same answer this many times in a row before it counts
const CLOUD_WIDTH = 640;
/** the part of the frame that counts, as fractions: the signal being crossed is aimed at, so the edges are not ours (and may hold bystanders) */
const CENTRE = { x0: 0.25, x1: 0.75, y0: 0.2, y1: 0.8 };

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

/** The local reading wins unless it sees nothing; then a recogniser answer counts only while fresh. */
export function pick(local: SignalState, cloud: { state: SignalState; at: number }, now: number): SignalState {
  return local === 'none' && now - cloud.at <= CLOUD_FRESH_MS ? cloud.state : local;
}

export class SignalWatcher {
  private readonly o: Required<Omit<SignalOptions, 'onChange' | 'gate' | 'cloud'>> & Pick<SignalOptions, 'onChange' | 'gate' | 'cloud'>;
  private readonly canvas = document.createElement('canvas');
  private stream: MediaStream | null = null;
  private audio: AudioContext | null = null;
  private readonly photo = document.createElement('canvas');
  private scan: ReturnType<typeof setInterval> | undefined;
  private cloudScan: ReturnType<typeof setInterval> | undefined;
  private cloudBusy = false;
  private cloudRun = 0;
  private cloudCandidate: SignalState = 'none';
  private cloudSeen: { state: SignalState; at: number } = { state: 'none', at: 0 };
  private alert: ReturnType<typeof setInterval> | undefined;
  private state: SignalState = 'none';
  private candidate: SignalState = 'none';
  private run = 0;

  constructor(options: SignalOptions) {
    this.o = { fps: 5, minFraction: 0.004, confirmFrames: 3, walkBeepMs: 250, dontWalkBeepMs: 1200, ...options };
    this.canvas.width = SIZE.w;
    this.canvas.height = SIZE.h;
  }

  get active(): boolean {
    return this.stream !== null;
  }

  /** Open the rear camera and start watching. Call from a tap: browsers allow sound only after one. Rejects if the camera is refused. */
  async start(): Promise<void> {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    this.o.video.srcObject = this.stream;
    this.o.video.muted = true;
    this.o.video.setAttribute('playsinline', '');
    await this.o.video.play();
    this.audio = new AudioContext();
    this.scan = setInterval(() => this.frame(), 1000 / this.o.fps);
    if (this.o.cloud) this.cloudScan = setInterval(() => void this.askCloud(), CLOUD_MS);
  }

  /** Stop the camera, the beeps and the buzz. Safe to call twice; call it when the screen closes. */
  stop(): void {
    clearInterval(this.scan);
    clearInterval(this.cloudScan);
    this.scan = this.cloudScan = undefined;
    this.cloudSeen = { state: 'none', at: 0 };
    this.cloudRun = 0;
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
      seen = pick(seen, this.cloudSeen, Date.now());
    }
    // a signal needs a few frames in a row to appear, and a longer gap to go away: lamps flicker and cars pass
    const need = seen === 'none' ? LOST_FRAMES : this.o.confirmFrames;
    this.run = seen === this.candidate ? this.run + 1 : 1;
    this.candidate = seen;
    if (this.run >= need && seen !== this.state) this.setState(seen);
  }

  /** Send one photo to the recogniser; its answer counts only once repeated, and only while fresh. */
  private async askCloud(): Promise<void> {
    const { video, cloud } = this.o;
    if (!cloud || this.cloudBusy || video.readyState < 2 || this.o.gate?.() === false) return;
    this.cloudBusy = true;
    let answer: SignalState = 'none';
    try {
      // only the middle of the frame is sent, so bystanders and plates at the edges never leave the phone
      const sx = video.videoWidth * CENTRE.x0;
      const sy = video.videoHeight * CENTRE.y0;
      const sw = video.videoWidth * (CENTRE.x1 - CENTRE.x0);
      const sh = video.videoHeight * (CENTRE.y1 - CENTRE.y0);
      this.photo.width = CLOUD_WIDTH;
      this.photo.height = Math.round((CLOUD_WIDTH * sh) / Math.max(1, sw));
      this.photo.getContext('2d')?.drawImage(video, sx, sy, sw, sh, 0, 0, this.photo.width, this.photo.height);
      answer = await cloud(this.photo.toDataURL('image/jpeg', 0.6).split(',')[1]);
    } catch {
      // a failed or late answer is the same as no answer
    }
    this.cloudBusy = false;
    if (!this.stream) return;
    this.cloudRun = answer === this.cloudCandidate ? this.cloudRun + 1 : 1;
    this.cloudCandidate = answer;
    this.cloudSeen = { state: this.cloudRun >= CLOUD_CONFIRM ? answer : 'none', at: Date.now() };
  }

  private setState(next: SignalState): void {
    if (next === this.state) return;
    this.state = next;
    clearInterval(this.alert);
    this.alert = undefined;
    if (next === 'walk' || next === 'dontWalk') {
      const [hz, ms] = next === 'walk' ? [1000, this.o.walkBeepMs] : [400, this.o.dontWalkBeepMs];
      this.beep(hz);
      this.alert = setInterval(() => this.beep(hz), ms);
    }
    this.o.onChange?.(next);
  }

  private beep(hz: number): void {
    const a = this.audio;
    if (!a) return;
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0.3, a.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.12);
    osc.connect(gain).connect(a.destination);
    osc.start();
    osc.stop(a.currentTime + 0.12);
  }
}
