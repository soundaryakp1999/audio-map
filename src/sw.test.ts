import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SOURCE from '../public/sw.js?raw';

const PAGE = 'https://x.test/audio-map/';

/** The service worker with stand-ins for its caches, the network and its open windows. */
function worker(saved?: string) {
  const store = new Map<string, Response>();
  if (saved !== undefined) store.set(PAGE, new Response(saved));
  const cache = {
    match: async (req: { url: string }) => store.get(req.url)?.clone(),
    put: async (req: { url: string }, res: Response) => void store.set(req.url, res),
    keys: async () => [],
    delete: async () => true,
  };
  const handlers: Record<string, (e: unknown) => void> = {};
  const window = { postMessage: vi.fn() };
  const self = {
    addEventListener: (type: string, f: (e: unknown) => void) => (handlers[type] = f),
    skipWaiting() {},
    clients: { claim: async () => {}, matchAll: async () => [window] },
  };
  const fetch = vi.fn();
  const caches = { open: async () => cache, keys: async () => [] };
  new Function('self', 'caches', 'fetch', 'location', SOURCE)(self, caches, fetch, { origin: 'https://x.test' });
  /** open the app: what the page gets, and the work left running after it */
  const open = () => {
    let res!: Promise<Response>;
    const waits: Promise<unknown>[] = [];
    handlers.fetch({
      request: { url: PAGE, method: 'GET', mode: 'navigate' },
      respondWith: (p: Promise<Response>) => (res = p),
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    return { res, settled: () => Promise.all(waits) };
  };
  return { open, fetch, store, window };
}

describe('opening the app', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs the latest page from the network, checked past the browser cache, and saves it', async () => {
    const w = worker('old build');
    w.fetch.mockResolvedValue(new Response('new build'));
    const { res } = w.open();
    expect(await (await res).text()).toBe('new build');
    expect(w.fetch).toHaveBeenCalledWith(PAGE, { cache: 'no-cache', credentials: 'same-origin' });
    expect(await w.store.get(PAGE)!.text()).toBe('new build');
    expect(w.window.postMessage).not.toHaveBeenCalled();
  });

  it('opens the saved page at once when offline', async () => {
    const w = worker('old build');
    w.fetch.mockRejectedValue(new TypeError('offline'));
    const { res } = w.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(await (await res).text()).toBe('old build');
  });

  it('on a weak signal opens the saved page after a few seconds, then says when a newer one is in', async () => {
    const w = worker('old build');
    let arrive!: (r: Response) => void;
    w.fetch.mockReturnValue(new Promise<Response>((r) => (arrive = r)));
    const { res, settled } = w.open();
    let page: Response | undefined;
    void res.then((r) => (page = r));
    await vi.advanceTimersByTimeAsync(2999);
    expect(page).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(await page!.text()).toBe('old build');
    arrive(new Response('new build'));
    await settled();
    expect(w.window.postMessage).toHaveBeenCalledWith({ type: 'updated' });
    expect(await w.store.get(PAGE)!.text()).toBe('new build');
  });

  it('says nothing when the late page is the same build', async () => {
    const w = worker('same build');
    let arrive!: (r: Response) => void;
    w.fetch.mockReturnValue(new Promise<Response>((r) => (arrive = r)));
    const { res, settled } = w.open();
    await vi.advanceTimersByTimeAsync(3000);
    await res;
    arrive(new Response('same build'));
    await settled();
    expect(w.window.postMessage).not.toHaveBeenCalled();
  });

  it('keeps the saved page when the server answers with an error', async () => {
    const w = worker('old build');
    w.fetch.mockResolvedValue(new Response('not found', { status: 404 }));
    const { res } = w.open();
    expect(await (await res).text()).toBe('old build');
  });

  it('waits for the network on the first visit, and gives a redirected page in a form a navigation accepts', async () => {
    const w = worker();
    const moved = new Response('new build');
    Object.defineProperty(moved, 'redirected', { value: true });
    w.fetch.mockResolvedValue(moved);
    const page = await w.open().res;
    expect(page.redirected).toBe(false);
    expect(await page.text()).toBe('new build');
  });

  it('fails the first visit cleanly when offline', async () => {
    const w = worker();
    w.fetch.mockRejectedValue(new TypeError('offline'));
    expect((await w.open().res).type).toBe('error');
  });
});
