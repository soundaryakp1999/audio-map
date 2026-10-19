// The last few destinations, so a repeat trip is one tap.

import type { Favorite } from './favorites';

const KEY = 'audio-map-recents';
const MAX = 5;

export function loadRecents(): Favorite[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((f) => typeof f?.name === 'string' && Number.isFinite(f.lat) && Number.isFinite(f.lon)).slice(0, MAX) : [];
  } catch {
    return [];
  }
}

/** Newest first; the same name within about 30 metres moves to the front instead of repeating. */
export function addRecent(f: Favorite) {
  const rest = loadRecents().filter((o) => !(o.name === f.name && Math.abs(o.lat - f.lat) < 0.0003 && Math.abs(o.lon - f.lon) < 0.0003));
  try {
    localStorage.setItem(KEY, JSON.stringify([f, ...rest].slice(0, MAX)));
  } catch {
    // ignore
  }
}
