import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeyRejected, askGemini, findImageModels, isModel, listModels, parseAnswer, parseModels, readsImages } from './cloudSignal';
import { cleanKey } from './geminiKey';
import { validate } from './backup';

const reply = (signal: string) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ signal }) }] } }] });
const KEY = 'SECRETKEY-1234567890abcdef';
const MODEL = 'models/gemini-test-flash';

describe('parseAnswer', () => {
  it('maps the four answers', () => {
    expect(parseAnswer(reply('walk'))).toBe('walk');
    expect(parseAnswer(reply('dont_walk'))).toBe('dontWalk');
    expect(parseAnswer(reply('none'))).toBe('none');
    expect(parseAnswer(reply('unsure'))).toBe('unsure');
  });
  it('never turns junk into walk', () => {
    for (const bad of [reply('WALK'), reply('go'), {}, null, { candidates: [{ content: { parts: [{ text: 'walk' }] } }] }]) expect(parseAnswer(bad)).toBe('unsure');
  });
});

describe('askGemini', () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (status: number, body: unknown) => {
    const f = vi.fn().mockResolvedValue({ status, ok: status < 400, json: async () => body });
    vi.stubGlobal('fetch', f);
    return f;
  };

  it('sends the key only in a header, to Google, with no credentials or referrer', async () => {
    const f = stub(200, reply('walk'));
    expect(await askGemini(KEY, MODEL, 'AAAA')).toBe('walk');
    const [url, init] = f.mock.calls[0];
    expect(url).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\//);
    expect(url).toContain(`/${MODEL}:generateContent`);
    expect(url).not.toContain('SECRETKEY');
    expect(init.headers['x-goog-api-key']).toBe(KEY);
    expect(init.body).not.toContain('SECRETKEY');
    expect(init).toMatchObject({ credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
  });
  it('reports a refused key without echoing it', async () => {
    stub(403, {});
    const err = await askGemini(KEY, MODEL, 'AAAA').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeyRejected);
    expect((err as Error).message).not.toContain('SECRETKEY');
  });
  it('treats a 400 invalid-key reply as a refused key, and other errors as plain failures', async () => {
    stub(400, { error: { details: [{ reason: 'API_KEY_INVALID' }] } });
    await expect(askGemini(KEY, MODEL, 'A')).rejects.toBeInstanceOf(KeyRejected);
    stub(429, {});
    const err = await askGemini(KEY, MODEL, 'A').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(KeyRejected);
  });
});

describe('the key store', () => {
  it('accepts a normal key and rejects pasted junk', () => {
    expect(cleanKey('  AIzaSyA-1234567890_abcdefghijklmnopqrs \n')).toBe('AIzaSyA-1234567890_abcdefghijklmnopqrs');
    for (const bad of ['', 'short', 'has space 1234567890123456789', 'https://x.test/?key=AIzaSyA-1234567890_abcdefghijk']) expect(cleanKey(bad)).toBeNull();
  });
  it('is not carried by backups: validate drops a geminiKey field', () => {
    const out = validate({ app: 'audio-map', settings: { geminiKey: 'AIzaSyA-1234567890_abcdefghijklmnopqrs', cloudWalk: true } });
    expect(JSON.stringify(out)).not.toContain('AIza');
  });
});

describe('models', () => {
  const list = {
    models: [
      { name: 'models/gemini-b', displayName: 'Gemini B', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-a', displayName: 'Gemini A', supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { name: 'models/gemini-embed', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/../evil', supportedGenerationMethods: ['generateContent'] },
      null,
    ],
  };

  it('lists only Gemini models that can generate, sorted, and ignores junk', () => {
    expect(parseModels(list).map((m) => m.name)).toEqual(['models/gemini-a', 'models/gemini-b']);
    expect(parseModels(list)[0].label).toBe('Gemini A (gemini-a)');
    expect(parseModels(null)).toEqual([]);
    expect(parseModels({ models: 'x' })).toEqual([]);
  });
  it('accepts only plain model names, since the name goes into a URL path', () => {
    expect(isModel('models/gemini-2.5-flash')).toBe(true);
    for (const bad of ['', 'gemini-2.5-flash', 'models/', 'models/a/b', 'models/a?key=x', 'models/..', 'https://evil.test/models/x', 5, null]) expect(isModel(bad)).toBe(false);
  });
  it('refuses to call a model that was not chosen', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await expect(askGemini(KEY, '', 'A')).rejects.toThrow('no model chosen');
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it('asks Google for the list with the key in a header only', async () => {
    const f = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => list });
    vi.stubGlobal('fetch', f);
    expect(await listModels(KEY)).toHaveLength(2);
    const [url, init] = f.mock.calls[0];
    expect(url).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models/);
    expect(url).not.toContain('SECRETKEY');
    expect(init.headers['x-goog-api-key']).toBe(KEY);
    vi.unstubAllGlobals();
  });
  it('is not carried by backups unless it is a plain model name', () => {
    expect(validate({ app: 'audio-map', settings: { geminiModel: 'models/gemini-a' } }).settings.geminiModel).toBe('models/gemini-a');
    expect(validate({ app: 'audio-map', settings: { geminiModel: 'https://evil.test' } }).settings.geminiModel).toBeUndefined();
  });
});

describe('image-capable models', () => {
  const swatches = [
    { png: 'RED', colour: 'red' },
    { png: 'GRN', colour: 'green' },
  ];
  afterEach(() => vi.unstubAllGlobals());
  /** fetch that names each colour square correctly for models in `seeing`, wrongly for others, and answers 429 for models in `busy` */
  const fake = (seeing: string[], busy: string[] = []) =>
    vi.fn(async (url: string, init: { body: string }) => {
      const model = /models\/([^:]+):/.exec(url)![1];
      if (busy.includes(model)) return { status: 429, ok: false, json: async () => ({}) };
      const sent = JSON.parse(init.body).contents[0].parts[1].inline_data.data as string;
      const truth = sent === 'RED' ? 'red' : 'green';
      return { status: 200, ok: true, json: async () => reply(seeing.includes(model) ? truth : 'blue') };
    });

  it('says yes only when every colour is named, and no when one is missed', async () => {
    vi.stubGlobal('fetch', fake(['gemini-a']));
    expect(await readsImages(KEY, 'models/gemini-a', swatches)).toBe('yes');
    expect(await readsImages(KEY, 'models/gemini-b', swatches)).toBe('no');
  });
  it('treats a 400 as no, and a rate limit as untested rather than no', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 400, ok: false, json: async () => ({}) }));
    expect(await readsImages(KEY, 'models/gemini-a', swatches)).toBe('no');
    vi.stubGlobal('fetch', fake([], ['gemini-a']));
    expect(await readsImages(KEY, 'models/gemini-a', swatches)).toBe('error');
  });
  it('keeps only the models that read pictures and counts the untested', async () => {
    vi.stubGlobal('fetch', fake(['gemini-a', 'gemini-d'], ['gemini-c']));
    const choices = ['a', 'b', 'c', 'd'].map((n) => ({ name: `models/gemini-${n}`, label: n }));
    const seen: number[] = [];
    const out = await findImageModels(KEY, choices, swatches, (d) => seen.push(d));
    expect(out.ok.map((m) => m.label)).toEqual(['a', 'd']);
    expect(out.untested).toBe(1);
    expect(seen).toHaveLength(4);
  });
  it('stops on a refused key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 403, ok: false, json: async () => ({}) }));
    await expect(findImageModels(KEY, [{ name: 'models/gemini-a', label: 'a' }], swatches)).rejects.toBeInstanceOf(KeyRejected);
  });
});
