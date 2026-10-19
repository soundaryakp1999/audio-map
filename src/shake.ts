// Shake the phone to hear where you are. Four hard jolts within 0.8 s: a shake jolts twice per
// back-and-forth, several times a second, while footsteps (one jolt each, at most about three a
// second even running) and a bump in a pocket or bag never come that fast.

const HARD = 25; // m/s², gravity alone reads about 9.8
const GAP = 120; // ms between jolts, so one jolt is not counted twice
const WINDOW = 800;
const JOLTS = 4;
const COOLDOWN = 3000;

export class ShakeDetector {
  private jolts: number[] = [];
  private lastFire = -Infinity;

  /** Feed one acceleration reading (m/s², gravity included) and its time in ms; true when a shake completes. */
  feed(magnitude: number, t: number): boolean {
    if (magnitude < HARD || t - this.lastFire < COOLDOWN) return false;
    const last = this.jolts[this.jolts.length - 1];
    if (last !== undefined && t - last < GAP) return false;
    this.jolts = [...this.jolts.filter((j) => t - j <= WINDOW), t];
    if (this.jolts.length < JOLTS) return false;
    this.jolts = [];
    this.lastFire = t;
    return true;
  }
}

type MotionPermission = { requestPermission?: () => Promise<string> };

/** From a tap: iOS asks for motion access only inside a user gesture. */
export function requestMotion(): Promise<boolean> {
  const DME = (window as { DeviceMotionEvent?: MotionPermission }).DeviceMotionEvent;
  return DME?.requestPermission ? DME.requestPermission().then((r) => r === 'granted', () => false) : Promise.resolve(true);
}

/** Listen for shakes; returns a function that stops listening. */
export function startShake(onShake: () => void): () => void {
  const d = new ShakeDetector();
  const handler = (e: Event) => {
    const a = (e as DeviceMotionEvent).accelerationIncludingGravity;
    if (a && d.feed(Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0), e.timeStamp)) onShake();
  };
  window.addEventListener('devicemotion', handler);
  return () => window.removeEventListener('devicemotion', handler);
}
