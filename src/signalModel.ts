// Experimental on-device pedestrian signal detector: a small YOLO model, trained on about 2,000 US photos, looks
// at the middle of the camera frame. Tested on held-out photos it never called a don't-walk signal or a car light
// walk at the thresholds below, but it misses most signals that are far away, and its test set was small. It is a
// hint, not permission: silence never means walk.
// ponytail: trained by tools/signal-detector/train_signal_detector.ipynb; real kerb-side photos are the next step.
// The model itself runs in signalWorker.ts, so the page stays responsive while it reads.
import type { SignalState } from './signal';

/** The model's square input, in pixels. */
export const INPUT = 960;
export const CLASSES = 3; // walk, dont_walk, countdown
/** A walk box needs this score; on the test photos no wrong walk scored this high. */
export const WALK_MIN = 0.7;
/** A don't-walk or countdown box needs this score. */
export const STOP_MIN = 0.5;
/** The part of the frame looked at: a square half the frame wide, a little above the middle, where the signal across the road is when the phone points ahead. */
const CROP = { side: 0.5, cy: 0.42 };

export interface Scores {
  walk: number;
  stop: number;
}

/**
 * Best walk and best stop (don't walk or countdown) score in a raw YOLO output laid out [4 + classes][boxes]:
 * centre x, centre y, width, height, then one score per class. Only the best of each matters, so no box merging.
 */
export function bestScores(out: Float32Array, boxes: number): Scores {
  let walk = 0;
  let stop = 0;
  for (let j = 0; j < boxes; j++) {
    walk = Math.max(walk, out[4 * boxes + j]);
    stop = Math.max(stop, out[5 * boxes + j], out[6 * boxes + j]);
  }
  return { walk, stop };
}

/** Both a confident walk and a stop in view means it cannot tell which is ours: unsure. */
export function judge({ walk, stop }: Scores): SignalState {
  const w = walk >= WALK_MIN;
  const s = stop >= STOP_MIN;
  return w && s ? 'unsure' : s ? 'dontWalk' : w ? 'walk' : 'none';
}

/** The source rectangle of the crop in a frame `w` by `h`. */
export function cropOf(w: number, h: number): { sx: number; sy: number; side: number } {
  const side = Math.round(Math.min(w, h) * CROP.side);
  const sx = Math.round((w - side) / 2);
  const sy = Math.round(Math.min(Math.max(h * CROP.cy - side / 2, 0), h - side));
  return { sx, sy, side };
}

/** RGBA pixels of an INPUT x INPUT square to the model's planar RGB in 0..1. */
export function toTensorData(rgba: Uint8ClampedArray): Float32Array {
  const n = INPUT * INPUT;
  const data = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    data[i] = rgba[4 * i] / 255;
    data[n + i] = rgba[4 * i + 1] / 255;
    data[2 * n + i] = rgba[4 * i + 2] / 255;
  }
  return data;
}

export class SignalModel {
  private readonly canvas = Object.assign(document.createElement('canvas'), { width: INPUT, height: INPUT });
  private pending: ((s: Scores) => void) | null = null;

  private constructor(private readonly worker: Worker) {
    worker.onmessage = (e: MessageEvent<Scores>) => {
      this.pending?.(e.data);
      this.pending = null;
    };
  }

  /** Download (about 25 MB the first time, then cached for offline use) and prepare the model. Rejects if this browser cannot run it. */
  static load(): Promise<SignalModel> {
    const worker = new Worker(new URL('./signalWorker.ts', import.meta.url), { type: 'module' });
    return new Promise((resolve, reject) => {
      worker.onerror = () => {
        worker.terminate();
        reject(new Error('signal worker failed'));
      };
      worker.onmessage = (e: MessageEvent<string>) => {
        if (e.data === 'ready') return resolve(new SignalModel(worker));
        worker.terminate();
        reject(new Error('signal model failed to load'));
      };
    });
  }

  /** Look at the current camera frame and say what signal it shows. */
  async read(video: HTMLVideoElement): Promise<SignalState> {
    return judge(await this.scores(video));
  }

  /** The best walk and stop scores in the middle of the current camera frame. One reading at a time. */
  scores(video: HTMLVideoElement): Promise<Scores> {
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx || this.pending) return Promise.resolve({ walk: 0, stop: 0 });
    const { sx, sy, side } = cropOf(video.videoWidth, video.videoHeight);
    ctx.drawImage(video, sx, sy, side, side, 0, 0, INPUT, INPUT);
    const pixels = ctx.getImageData(0, 0, INPUT, INPUT).data.buffer;
    return new Promise((resolve) => {
      this.pending = resolve;
      this.worker.postMessage(pixels, [pixels]); // handed over, not copied
    });
  }

  release(): void {
    this.worker.terminate();
    this.pending?.({ walk: 0, stop: 0 });
    this.pending = null;
  }
}
