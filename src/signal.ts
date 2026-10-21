// Watches the rear camera for a pedestrian signal and sounds it without stopping, so the phone need not be touched
// while crossing: a short high trill for Walk, a slow low tone for Don't Walk, and a soft tick while no signal is read. The reading comes from an experimental detector on the phone (`signalModel.ts`); each reading is
// passed on at once, best effort, and a wrong one is put right by the next. Silence never means walk.

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
  /** called when the state to say changes */
  onChange?: (state: SignalState) => void;
}

/** No signal read for this long (ms) after one was: the signal is lost. Shorter gaps are a flashing hand's dark half. */
export const LOST_MS = 5000;
const GAP_MS = 100; // rest between readings; the model runs in a worker, so the page stays responsive
/** How each state sounds, and how often it repeats (ms). 'unsure' sounds like no signal: neither can be acted on. */
const SOUND_EVERY_MS: Record<SignalState, number> = { walk: 600, dontWalk: 1200, unsure: 1500, none: 1500 };

/** What to do after a reading: the state to sound, and whether to say it. */
export interface Change {
  state: SignalState;
  say: boolean;
}

/**
 * Turns readings into what is sounded. Walk, don't walk and unclear take effect on the first reading. A reading of
 * nothing stops a walk at once (walk never flashes, so it may have ended), but holds don't walk through the dark half
 * of a flashing hand; "lost" is said only after LOST_MS with no signal at all.
 */
export class SignalTracker {
  state: SignalState = 'none';
  private lastSeen = -Infinity;
  private lostSaid = true; // nothing seen yet: nothing to lose
  /** what was last said, so a walk that flickers with blank readings is not said again each time */
  private said: SignalState = 'none';

  /** Add one reading taken at `now` (ms); returns the change to sound or say, else null. */
  add(seen: SignalState, now: number): Change | null {
    if (seen !== 'none') {
      this.lastSeen = now;
      this.lostSaid = false;
      if (seen === this.state) return null;
      this.state = seen;
      const say = seen !== this.said;
      this.said = seen;
      return { state: seen, say };
    }
    const lost = now - this.lastSeen >= LOST_MS;
    if (lost && !this.lostSaid) {
      this.lostSaid = true;
      this.state = this.said = 'none';
      return { state: 'none', say: true };
    }
    if (this.state === 'walk' || this.state === 'unsure') {
      this.state = 'none';
      return { state: 'none', say: false };
    }
    return null;
  }
}

export class SignalWatcher {
  read: Read | undefined;
  private readonly tracker = new SignalTracker();
  private stream: MediaStream | null = null;
  private audio: AudioContext | null = null;
  private alert: ReturnType<typeof setInterval> | undefined;
  private loop: ReturnType<typeof setTimeout> | undefined;
  /** the state whose sound is repeating, so a spoken change that sounds the same does not restart it */
  private sounding: SignalState | null = null;

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
    this.sound('none'); // ticking from the start says it is on and looking
    this.next();
  }

  /** Stop the camera and the sounds. Safe to call twice. */
  stop(): void {
    clearTimeout(this.loop);
    this.loop = undefined;
    const stream = this.stream;
    this.stream = null;
    this.sound(null);
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
        const change = this.tracker.add(seen, performance.now());
        if (change) {
          if (change.state !== this.sounding) this.sound(change.state);
          if (change.say) this.o.onChange?.(change.state);
        }
      }
      if (this.stream) this.next();
    }, GAP_MS);
  }

  /** Repeat the sound of `state` until the next change; null for silence. */
  private sound(state: SignalState | null): void {
    this.sounding = state;
    clearInterval(this.alert);
    this.alert = undefined;
    if (!state) return;
    const play = state === 'walk' ? () => this.trill() : state === 'dontWalk' ? () => this.tone(400, 0.25) : () => this.tone(900, 0.02, 0, 0.08);
    play();
    this.alert = setInterval(play, SOUND_EVERY_MS[state]);
  }

  /** Walk: a short high trill. Not a rising pair (that is the turn cue) and not the ticking of a real accessible signal. */
  private trill(): void {
    for (let i = 0; i < 6; i++) this.tone(i % 2 ? 1650 : 1250, 0.04, i * 0.05);
  }

  /** One tone: don't walk is low and long, the no-signal tick short and quiet. */
  private tone(hz: number, seconds: number, delay = 0, level = 0.3): void {
    const a = this.audio;
    if (!a) return;
    const at = a.currentTime + delay;
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(level, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + seconds);
    osc.connect(gain).connect(a.destination);
    osc.start(at);
    osc.stop(at + seconds);
  }
}
