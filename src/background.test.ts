import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentWav, startBackground, stopBackground } from './background';

afterEach(() => {
  stopBackground();
  vi.unstubAllGlobals();
});

describe('silentWav', () => {
  it('is a valid one-second 8 kHz WAV of midpoint samples', () => {
    const w = silentWav();
    const v = new DataView(w.buffer);
    expect(String.fromCharCode(...w.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...w.slice(8, 16))).toBe('WAVEfmt ');
    expect(v.getUint32(24, true)).toBe(8000);
    expect(v.getUint32(40, true)).toBe(w.length - 44);
    expect(new Set(w.slice(44))).toEqual(new Set([128]));
  });
});

describe('startBackground', () => {
  function stubs() {
    const handlers = new Map<string, (() => void) | null>();
    const played: string[] = [];
    const session = { metadata: null as unknown, playbackState: '', setActionHandler: (a: string, h: (() => void) | null) => void handlers.set(a, h) };
    vi.stubGlobal('navigator', { mediaSession: session });
    vi.stubGlobal('MediaMetadata', class { constructor(public init: { title: string }) {} });
    vi.stubGlobal('Audio', class { loop = false; src = 'blob:x'; play = async () => void played.push('play'); pause = () => void played.push('pause'); });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    return { handlers, played, session };
  }

  it('loops silence, wires the track buttons and keeps playing when paused', () => {
    const { handlers, played, session } = stubs();
    const calls: string[] = [];
    startBackground({ next: () => calls.push('next'), previous: () => calls.push('previous') }, 'To the station');
    expect(played).toEqual(['play']);
    expect((session.metadata as { init: { title: string } }).init.title).toBe('To the station');
    handlers.get('nexttrack')!();
    handlers.get('previoustrack')!();
    expect(calls).toEqual(['next', 'previous']);
    handlers.get('pause')!();
    expect(played).toEqual(['play', 'play']);
  });

  it('removes the buttons and stops on stopBackground', () => {
    const { handlers, played, session } = stubs();
    startBackground({ next() {}, previous() {} }, 't');
    stopBackground();
    expect(played.at(-1)).toBe('pause');
    expect(handlers.get('nexttrack')).toBeNull();
    expect(session.playbackState).toBe('none');
  });
});
