// The player's own Gemini API key. It lives in its own localStorage entry, never in Settings: settings are exported,
// imported and validated as a whole, and the key must not travel in any of that. It is sent only by cloudSignal.ts.

const KEY = 'audio-map-gemini-key';
/** a key the player chose not to have remembered lives only here, and is gone when the page closes */
let memory: string | null = null;

/** Google keys are one token of letters, digits, '-', '_' and '.'; anything else (spaces, newlines, URLs) is a paste mistake. */
export function cleanKey(raw: string): string | null {
  const k = raw.trim();
  return /^[A-Za-z0-9_.-]{20,200}$/.test(k) ? k : null;
}

export function loadKey(): string | null {
  if (memory) return memory;
  try {
    return cleanKey(localStorage.getItem(KEY) ?? '');
  } catch {
    return null;
  }
}

/** Keep the key for this page, and on this device too if `remember`. Returns false if it is malformed. */
export function saveKey(raw: string, remember = true): boolean {
  const k = cleanKey(raw);
  if (!k) return false;
  memory = k;
  if (!remember) forgetStoredKey();
  else {
    try {
      localStorage.setItem(KEY, k);
    } catch {
      // the key still works until the page closes
    }
  }
  return true;
}

/** Remove the copy kept on this device; a key held for this page stays. */
export function forgetStoredKey(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing stored that could be removed
  }
}

export function clearKey(): void {
  memory = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing stored that could be removed
  }
}
