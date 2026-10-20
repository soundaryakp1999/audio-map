// Watches the rear camera for a pedestrian signal and sounds it: a slow low tone for Don't Walk, a short high trill
// for Walk. The reading comes from an experimental detector on the phone (`signalModel.ts`); a state counts only
// once it is read several times in a row, so one odd frame or a passing car does not flip the alert. Silence never
// means walk.

export type SignalState = 'walk' | 'dontWalk' | 'unsure' | 'none';

/** Countries whose signals look like those the detector was trained on: a white walking figure and an orange hand (the US and Canada, and US territories). */
const TRAINED_STYLE = new Set(['us', 'ca', 'pr', 'gu', 'vi', 'as', 'mp']);
/** A warning for countries with other signal styles; empty where the style matches, or the country is not known yet. */
export function styleWarning(country: string | null): string {
  return country && !TRAINED_STYLE.has(country) ? 'This detector was trained on US-style signals and may not recognise signals here.' : '';
}

/** Reads the camera frame and says what signal it shows; may be slow, may fail. */
export type Read = (video: HTMLVideoElement) => Promise<SignalState>;

export interface SignalOptions {
  /** the video element that shows the camera; it must be in the page, and may be hidden from view */
  video: HTMLVideoElement;
  /** the detector; until it is given (it loads after the camera opens) nothing is read */
  read?: Read;
  /** called when the confirmed state changes */
  onChange?: (state: SignalState) => void;
}

/** The same reading this many times in a row before the state changes. */
export const CONFIRM = 3;
const GAP_MS = 150; // pause between readings, so the phone keeps up with everything else
const WALK_EVERY_MS = 600;
const DONT_WALK_EVERY_MS = 1200;

/** Counts readings in a row and says when a new state is confirmed. */
export class Confirmer {
  state: SignalState = 'none';
  private candidate: SignalState = 'none';
  private run = 0;

  /** Add one reading; returns the new state when it changes, else null. */
  add(seen: SignalState): SignalState | null {
    this.run = seen === this.candidate ? this.run + 1 : 1;
    this.candidate = seen;
    if (this.run < CONFIRM || seen === this.state) return null;
    this.state = seen;
    return seen;
  }
}

export class SignalWatcher {
  read: Read | undefined;
  private readonly confirmer = new Confirmer();
  private stream: MediaStream | null = null;
  private audio: AudioContext | null = null;
  private alert: ReturnType<typeof setInterval> | undefined;
  private loop: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly o: SignalOptions) {
    this.read = o.read;
  }

  /** Open the rear camera and start watching. Call from a tap: browsers allow sound only after one. Rejects if the camera is refused. */
  async start(): Promise<void> {
    if (this.stream) return;
    // a high resolution keeps a signal across the road big enough for the detector to see
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      audio: false,
    });
    const { video } = this.o;
    video.srcObject = this.stream;
    video.muted = true;
    video.setAttribute('playsinline', '');
    await video.play();
    this.audio = new AudioContext();
    this.next();
  }

  /** Stop the camera and the sounds. Safe to call twice. */
  stop(): void {
    clearTimeout(this.loop);
    this.loop = undefined;
    const stream = this.stream;
    this.stream = null; // first, so switching off is not announced as a lost signal
    this.show('none');
    stream?.getTracks().forEach((t) => t.stop());
    this.o.video.srcObject = null;
    void this.audio?.close();
    this.audio = null;
  }

  /** One reading, then the next after a short pause; readings never overlap. */
  private next(): void {
    this.loop = setTimeout(async () => {
      const { video } = this.o;
      if (this.read && video.readyState >= 2) {
        let seen: SignalState = 'none';
        try {
          seen = await this.read(video);
        } catch {
          // a failed reading is the same as seeing nothing
        }
        if (!this.stream) return;
        const changed = this.confirmer.add(seen);
        if (changed) this.show(changed);
      }
      if (this.stream) this.next();
    }, GAP_MS);
  }

  private show(next: SignalState): void {
    clearInterval(this.alert);
    this.alert = undefined;
    if (next === 'walk' || next === 'dontWalk') {
      const sound = next === 'walk' ? () => this.trill() : () => this.tone(400, 0.25);
      sound();
      this.alert = setInterval(sound, next === 'walk' ? WALK_EVERY_MS : DONT_WALK_EVERY_MS);
    }
    if (this.stream) this.o.onChange?.(next);
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
