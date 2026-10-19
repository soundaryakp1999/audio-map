import { describe, expect, it } from 'vitest';
import { matchPhrase, parseTravel } from './voice';

describe('matchPhrase', () => {
  it('matches phrases inside a sentence, ignoring case and punctuation', () => {
    expect(matchPhrase('Where am I?')).toEqual({ key: 'e' });
    expect(matchPhrase('please go faster')).toEqual({ drive: 'go' });
    expect(matchPhrase('Stop!')).toEqual({ drive: 'brake' });
  });
  it('matches look ahead as an action', () => {
    expect(matchPhrase("what's ahead")).toEqual({ action: 'lookAhead' });
    expect(matchPhrase('look ahead please')).toEqual({ action: 'lookAhead' });
  });
  it('prefers the longest phrase', () => {
    expect(matchPhrase('next road left')).toEqual({ key: 'ArrowLeft', ctrl: true });
  });
  it('matches whole words only and ignores unknown speech', () => {
    expect(matchPhrase('gopher')).toBeNull();
    expect(matchPhrase('banana')).toBeNull();
  });
});

describe('parseTravel', () => {
  it('reads a place to search for', () => {
    expect(parseTravel('Take me to the British Museum')).toEqual({ query: 'british museum' });
    expect(parseTravel('please navigate to Soho')).toEqual({ query: 'soho' });
    expect(parseTravel('go to cafe')).toEqual({ query: 'cafe' });
  });
  it('reads a repeat of the last trip', () => {
    expect(parseTravel('take me to my last destination')).toEqual({ last: true });
    expect(parseTravel('go back to the last place')).toEqual({ last: true });
    expect(parseTravel('go back to my last place')).toEqual({ last: true });
  });
  it('leaves other speech to the phrase list', () => {
    expect(parseTravel('go')).toBeNull();
    expect(parseTravel('where am I')).toBeNull();
  });
});
