// Keeps guidance going with the screen off. A silent looping sound makes the browser treat the page
// as playing media, so it is not frozen, and the lock-screen media buttons run commands.
// ponytail: a browser may still suspend a page whose screen is off (iOS most of all); a native wrapper is the real fix.

export interface Buttons {
  /** next-track button */
  next: () => void;
  /** previous-track button */
  previous: () => void;
}

/** A one-second mono 8 kHz WAV of silence. */
export function silentWav(): Uint8Array {
  const rate = 8000;
  const b = new Uint8Array(44 + rate);
  const v = new DataView(b.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => (b[at + i] = c.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 36 + rate, true);
  text(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  text(36, 'data');
  v.setUint32(40, rate, true);
  b.fill(128, 44); // 8-bit silence sits at the midpoint
  return b;
}

type Sessionish = {
  metadata: unknown;
  playbackState: string;
  setActionHandler(action: string, handler: (() => void) | null): void;
};

let player: HTMLAudioElement | null = null;

export function startBackground(buttons: Buttons, title: string) {
  if (player) return;
  player = new Audio(URL.createObjectURL(new Blob([silentWav() as BlobPart], { type: 'audio/wav' })));
  player.loop = true;
  void player.play().catch(() => stopBackground()); // refused outside a tap: carry on without
  const s = (navigator as unknown as { mediaSession?: Sessionish }).mediaSession;
  if (!s) return;
  if (typeof MediaMetadata !== 'undefined') s.metadata = new MediaMetadata({ title, artist: 'Audio Map Explorer' });
  s.playbackState = 'playing';
  const set = (action: string, handler: (() => void) | null) => {
    try {
      s.setActionHandler(action, handler);
    } catch {
      // this browser has no such button
    }
  };
  set('nexttrack', buttons.next);
  set('previoustrack', buttons.previous);
  set('play', () => void player?.play()); // a pause or play press must not stop guidance
  set('pause', () => void player?.play());
}

export function stopBackground() {
  if (!player) return;
  URL.revokeObjectURL(player.src);
  player.pause();
  player = null;
  const s = (navigator as unknown as { mediaSession?: Sessionish }).mediaSession;
  if (!s) return;
  s.playbackState = 'none';
  for (const a of ['nexttrack', 'previoustrack', 'play', 'pause']) {
    try {
      s.setActionHandler(a, null);
    } catch {
      // ignore
    }
  }
}
