import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addRecent, loadRecents } from './recents';

const memory = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
});

beforeEach(() => memory.clear());

describe('recents', () => {
  it('keeps the newest first, moves a repeat to the front and caps at five', () => {
    for (let i = 0; i < 6; i++) addRecent({ name: `P${i}`, lat: 51 + i, lon: 0 });
    expect(loadRecents().map((r) => r.name)).toEqual(['P5', 'P4', 'P3', 'P2', 'P1']);
    addRecent({ name: 'P2', lat: 53.0001, lon: 0 });
    expect(loadRecents().map((r) => r.name)).toEqual(['P2', 'P5', 'P4', 'P3', 'P1']);
  });

  it('drops malformed stored entries', () => {
    memory.set('audio-map-recents', JSON.stringify([{ name: 'ok', lat: 1, lon: 2 }, { name: 3 }, { name: 'x', lat: 'a', lon: 1 }]));
    expect(loadRecents()).toEqual([{ name: 'ok', lat: 1, lon: 2 }]);
  });
});
