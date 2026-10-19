// Spoken commands through the browser's speech recognition. Phrases map to the same actions as touch.

import { perform, type Action, type Driver } from './touch';

const PHRASES: [string, Action][] = [
  ['where am i', { key: 'e' }],
  ['what is around', { key: 'w' }],
  ["what's around", { key: 'w' }],
  ['around me', { key: 'w' }],
  ['speed', { key: 's' }],
  ['heading', { key: 'h' }],
  ['location', { key: 'l' }],
  ['next intersection', { key: 'n' }],
  ['next instruction', { key: 'i' }],
  ['look ahead', { action: 'lookAhead' }],
  ['what is ahead', { action: 'lookAhead' }],
  ["what's ahead", { action: 'lookAhead' }],
  ['distance', { key: 'd' }],
  ['repeat', { key: '[' }],
  ['say again', { key: '[' }],
  ['faster', { drive: 'go' }],
  ['go', { drive: 'go' }],
  ['accelerate', { drive: 'go' }],
  ['stop', { drive: 'brake' }],
  ['brake', { drive: 'brake' }],
  ['slow down', { drive: 'brake' }],
  ['turn left', { key: 'ArrowLeft', shift: true }],
  ['turn right', { key: 'ArrowRight', shift: true }],
  ['next road left', { key: 'ArrowLeft', ctrl: true }],
  ['next road right', { key: 'ArrowRight', ctrl: true }],
  ['help', { key: 'F1' }],
  ['menu', { key: 'Escape' }],
  ['pause', { key: 'Escape' }],
];

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z' ]/g, ' ')
    .split(' ')
    .filter(Boolean)
    .join(' ');

/** Longest phrase wins, so "next road left" is not read as a shorter one; whole words only. */
export function matchPhrase(transcript: string): Action | null {
  const t = ` ${norm(transcript)} `;
  let best: [string, Action] | null = null;
  for (const p of PHRASES) {
    if (t.includes(` ${p[0]} `) && (!best || p[0].length > best[0].length)) best = p;
  }
  return best ? best[1] : null;
}

export type Travel = { last: true } | { query: string };

/** "Take me to the library" searches for a place; "take me to my last destination" repeats the last trip. */
export function parseTravel(transcript: string): Travel | null {
  const m = norm(transcript).match(/^(?:please )?(?:take me|navigate|go|head|walk) (?:to|back to) (.+)$/);
  if (!m) return null;
  return /^(?:(?:my|the) )?(?:last|previous)(?: (?:destination|place|trip))?$/.test(m[1]) ? { last: true } : { query: m[1].replace(/^the /, '') };
}

interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
}

function recognitionCtor(): (new () => Recognition) | undefined {
  const w = window as unknown as Record<string, new () => Recognition>;
  return w.SpeechRecognition || w.webkitSpeechRecognition;
}

/** Returns a toggle, or null when the browser has no speech recognition. */
export function setupVoice(getGame: () => Driver | null, say: (s: string) => void, onChange: (on: boolean) => void, travel?: (t: Travel) => void): (() => boolean) | null {
  const Ctor = recognitionCtor();
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = false;
  rec.lang = navigator.language || 'en-US';
  let on = false;
  rec.onresult = (e) => {
    const game = getGame();
    if (!game) return;
    // one event can carry several results; each final one is a command
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (!r.isFinal) continue;
      const trip = travel && parseTravel(r[0].transcript);
      if (trip) {
        travel!(trip);
        continue;
      }
      const a = matchPhrase(r[0].transcript);
      if (a) perform(game, a);
      else say(`Did not understand ${r[0].transcript.trim()}.`);
    }
  };
  // browsers end recognition after silence; restart while the user wants it on
  rec.onend = () => {
    if (!on) return;
    try {
      rec.start();
    } catch {
      on = false;
      onChange(false);
    }
  };
  rec.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    on = false;
    onChange(false);
    // Brave and some other browsers expose the API but block the speech service behind it ('network')
    const brave = 'brave' in navigator;
    say(
      e.error === 'not-allowed'
        ? 'Voice commands need microphone permission. They are off.'
        : e.error === 'network'
          ? `Voice commands cannot reach the speech service${brave ? ', which Brave blocks' : ''}. They are off. Chrome or Edge may work.`
          : `Voice commands are not working in this browser: ${e.error}. They are off.`,
    );
  };
  return () => {
    on = !on;
    try {
      if (on) rec.start();
      else rec.stop();
    } catch {
      // still stopping from the last toggle; onend restarts it while `on` is set
    }
    onChange(on);
    say(`Voice commands ${on ? 'on' : 'off'}.`);
    return on;
  };
}
