import { describe, expect, it } from 'vitest';
import { validate } from './backup';
import { conflict, describeBinding, isReserved, lookup, type ActionId } from './keymap';
import { tryBind } from './rebind';

// [key, shift, ctrl, action]: every key the old switch handled
const OLD: [string, boolean, boolean, ActionId][] = [
  ['Control', false, true, 'stopSpeech'], ['Escape', false, false, 'menu'], ['F1', false, false, 'help'], ['k', false, false, 'help'],
  ['h', false, false, 'heading'], ['H', true, false, 'calibrate'], ['s', false, false, 'speed'], ['l', false, false, 'location'],
  ['L', true, false, 'toggleLive'], ['n', false, false, 'nextIntersection'], ['N', true, false, 'prevIntersection'],
  ['.', false, false, 'stepForward'], [',', false, false, 'stepBack'], [',', false, true, 'settings'],
  ['B', true, false, 'proximityBeeps'], ['b', false, false, 'beacon'], ['t', false, false, 'turnByTurn'], ['i', false, false, 'instructions'],
  ['w', false, false, 'whatsAround'], ['W', true, false, 'conditions'], [' ', false, false, 'sonar'], ['Tab', false, false, 'nextPlace'],
  ['Tab', true, false, 'prevPlace'], ['Enter', false, false, 'setDestination'], ['g', false, false, 'destinationInfo'],
  ['G', true, false, 'clearDestination'], ['Backspace', false, false, 'clearDestination'], ['c', false, false, 'filter'],
  ['v', false, false, 'note'], ['V', true, false, 'deleteNote'], ['z', false, false, 'share'], ['Z', true, false, 'exportRoute'], ['S', true, false, 'saveOffline'], ['O', true, false, 'facilities'], ['E', true, false, 'lookAround'], ['I', true, false, 'lookAhead'], ['K', true, false, 'sos'], ['u', false, false, 'tripSummary'],
  ['e', false, false, 'whereAmI'], ['o', false, false, 'preview'], ['x', false, false, 'transit'], ['y', false, false, 'saveFavorite'],
  ['r', false, false, 'align'], ['f', false, false, 'search'], ['j', false, true, 'jump'], ['Q', true, false, 'saveRoute'],
  ['q', false, false, 'routes'], ['d', false, true, 'navigate'], ['d', false, false, 'distance'], ['m', false, false, 'mapRotation'],
  ['a', false, false, 'roadAssist'], ['p', false, false, 'announcePlaces'], ['P', true, false, 'soundProfile'],
  ['[', false, false, 'reviewBack'], [']', false, false, 'reviewNext'], ['1', false, false, 'walker'], ['2', false, false, 'bicycle'],
  ['3', false, false, 'car'], ['4', false, false, 'helicopter'], ['PageUp', false, false, 'volumeUp'], ['PageDown', false, false, 'volumeDown'],
];

describe('default key map', () => {
  it.each(OLD)('%s (shift %s, ctrl %s) runs %s', (key, shift, ctrl, action) => {
    expect(lookup({ key, shift, ctrl }, {})).toBe(action);
  });

  it('still fires a plain key with extra modifiers held, as before', () => {
    expect(lookup({ key: 'h', shift: false, ctrl: true }, {})).toBe('heading');
    expect(lookup({ key: ' ', shift: true, ctrl: false }, {})).toBe('sonar');
  });

  it('ignores unbound keys', () => {
    expect(lookup({ key: 'F9', shift: false, ctrl: false }, {})).toBeUndefined();
  });
});

describe('rebinding', () => {
  it('moves an action to its new key and frees the old one', () => {
    const o = { speed: { key: 'F8' } };
    expect(lookup({ key: 'F8', shift: false, ctrl: false }, o)).toBe('speed');
    expect(lookup({ key: 's', shift: false, ctrl: false }, o)).toBeUndefined();
  });

  it('detects keys already in use, including hidden aliases and modifiers', () => {
    expect(conflict('speed', { key: 'h' }, {})).toBe('heading');
    expect(conflict('speed', { key: 'k' }, {})).toBe('help');
    expect(conflict('speed', { key: 'h', shift: true }, {})).toBe('calibrate');
    expect(conflict('speed', { key: 'h', ctrl: true }, {})).toBeUndefined();
    expect(conflict('speed', { key: 's' }, {})).toBeUndefined();
  });

  it('refuses reserved keys and conflicts with a spoken reason', () => {
    for (const key of ['Escape', 'F1', 'F2']) expect(isReserved({ key })).toBe(true);
    expect(tryBind('speed', { key: 'F2' }, {})).toMatchObject({ ok: false });
    expect(tryBind('speed', { key: 'P', shift: true, ctrl: true }, {})).toMatchObject({ ok: false });
    expect(tryBind('note', { key: 'Control', shift: false, ctrl: false }, {})).toMatchObject({ ok: false });
    expect(tryBind('speed', { key: 'h' }, {})).toMatchObject({ ok: false, why: expect.stringContaining('Heading') });
    expect(tryBind('speed', { key: 'F8' }, {})).toEqual({ ok: true });
  });

  it('says keys by name', () => {
    expect(describeBinding({ key: 'p', shift: true })).toBe('Shift P');
    expect(describeBinding({ key: ',', ctrl: true })).toBe('Control Comma');
    expect(describeBinding({ key: 'PageUp' })).toBe('Page Up');
  });
});

describe('backup of key bindings', () => {
  it('round trips valid overrides and drops reserved, conflicting and unknown ones', () => {
    const keyBindings = { speed: { key: 'F8', shift: true, ctrl: false }, heading: { key: 'F2' }, location: { key: 'n' }, menu: { key: 'F9' }, nope: { key: 'F7' } };
    const b = validate({ app: 'audio-map', settings: { keyBindings } });
    expect(b.settings.keyBindings).toEqual({ speed: { key: 'F8', shift: true, ctrl: false } });
    expect(validate(JSON.parse(JSON.stringify({ app: 'audio-map', ...b }))).settings).toEqual(b.settings);
  });
});
