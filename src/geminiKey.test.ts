import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const K = 'AIzaSyA-1234567890_abcdefghijklmnopqrs';
let store: Map<string, string>;

beforeEach(() => {
  vi.resetModules();
  store = new Map();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
});
afterEach(() => vi.unstubAllGlobals());

describe('key store', () => {
  it('remembers a key on the device by default', async () => {
    const { saveKey, loadKey } = await import('./geminiKey');
    expect(saveKey(K)).toBe(true);
    expect(store.size).toBe(1);
    expect(loadKey()).toBe(K);
  });
  it('holds a key only in memory when told not to remember, and wipes an older stored copy', async () => {
    const { saveKey, loadKey } = await import('./geminiKey');
    saveKey('OLDKEY-1234567890abcdefgh');
    expect(saveKey(K, false)).toBe(true);
    expect(store.size).toBe(0);
    expect(loadKey()).toBe(K);
  });
  it('forgetting the stored copy keeps the key for this page, and clearing removes both', async () => {
    const { saveKey, loadKey, forgetStoredKey, clearKey } = await import('./geminiKey');
    saveKey(K);
    forgetStoredKey();
    expect(store.size).toBe(0);
    expect(loadKey()).toBe(K);
    clearKey();
    expect(loadKey()).toBeNull();
  });
  it('rejects a malformed key and keeps nothing', async () => {
    const { saveKey, loadKey } = await import('./geminiKey');
    expect(saveKey('nope', false)).toBe(false);
    expect(loadKey()).toBeNull();
  });
});
