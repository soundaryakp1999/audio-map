import { afterEach, describe, expect, it, vi } from 'vitest';
import { Phone, TRAVEL_WARNING, cellOf, cellPoint, isPhone, nextUp, offsetText, type PhoneGame } from './phone';

describe('cellPoint', () => {
  it('puts the top row ahead and the right column to the right, whichever way is up', () => {
    // north up: the top-right square is north-east
    const ne = cellPoint(0, 0, 0, 10, 0, 6);
    expect(ne.x).toBeCloseTo(30);
    expect(ne.y).toBeCloseTo(30);
    // east up: the top row is east, the right column south
    const top = cellPoint(0, 0, 90, 10, 0, 3);
    expect(top.x).toBeCloseTo(30);
    expect(top.y).toBeCloseTo(0);
    const right = cellPoint(0, 0, 90, 10, 3, 6);
    expect(right.x).toBeCloseTo(0);
    expect(right.y).toBeCloseTo(-30);
    expect(cellPoint(5, 7, 45, 10, 3, 3)).toEqual({ x: 5, y: 7 });
  });
});

describe('cellOf', () => {
  it('finds the square holding a point, whichever way is up, and none off the map', () => {
    for (const up of [0, 37, 90, 200]) {
      for (const [row, col] of [[0, 0], [3, 3], [1, 5], [6, 2]]) {
        const p = cellPoint(10, -20, up, 20, row, col);
        expect(cellOf(10, -20, up, 20, p.x + 4, p.y - 3)).toBe(row * 7 + col);
      }
    }
    expect(cellOf(0, 0, 0, 20, 0, 75)).toBe(-1); // just beyond the top row
  });
});

describe('offsetText', () => {
  it('says ahead and right in travel mode, compass in explore mode, nothing for the centre', () => {
    expect(offsetText(1, 4, 20, 'metric', true)).toBe('40 metres ahead, 20 metres right');
    expect(offsetText(6, 0, 20, 'metric', true)).toBe('60 metres behind, 60 metres left');
    expect(offsetText(1, 4, 20, 'metric', false)).toBe('40 metres north, 20 metres east');
    expect(offsetText(3, 2, 10, 'imperial', false)).toBe('10 yards west');
    expect(offsetText(3, 3, 10, 'metric', true)).toBe('');
  });
});

describe('nextUp', () => {
  it('turns the map only once a new direction has held for a second', () => {
    let r = nextUp(null, { dir: 90, street: 'Green Street' }, 0);
    expect(r).toEqual({ state: { dir: 90, street: 'Green Street' }, turned: true });
    r = nextUp(r.state, { dir: 0, street: 'Goodwin Avenue' }, 100);
    expect(r.turned).toBe(false);
    expect(r.state.dir).toBe(90);
    r = nextUp(r.state, { dir: 90 }, 400); // a glance aside and back: nothing changes
    expect(r.state).toEqual({ dir: 90, street: 'Green Street' });
    r = nextUp(r.state, { dir: 0, street: 'Goodwin Avenue' }, 500);
    r = nextUp(r.state, { dir: 0, street: 'Goodwin Avenue' }, 1200);
    expect(r.turned).toBe(false);
    r = nextUp(r.state, { dir: 0, street: 'Goodwin Avenue' }, 1600);
    expect(r).toEqual({ state: { dir: 0, street: 'Goodwin Avenue' }, turned: true });
  });
});

describe('isPhone', () => {
  it('counts touch screens up to 600 pixels on their shorter side', () => {
    expect(isPhone(true, 390)).toBe(true); // iPhone
    expect(isPhone(true, 412)).toBe(true); // Android phone
    expect(isPhone(true, 820)).toBe(false); // iPad
    expect(isPhone(false, 390)).toBe(false); // a narrow desktop window
  });
});

/** Just enough of an element for the phone screen. */
class FakeEl {
  hidden = false;
  disabled = false;
  textContent = '';
  type = '';
  className = '';
  dataset: Record<string, string> = {};
  children: FakeEl[] = [];
  classes = new Set<string>();
  classList = {
    add: (c: string) => void this.classes.add(c),
    remove: (c: string) => void this.classes.delete(c),
    toggle: (c: string, on?: boolean) => void ((on ?? !this.classes.has(c)) ? this.classes.add(c) : this.classes.delete(c)),
  };
  private attrs = new Map<string, string>();
  on = new Map<string, ((e: unknown) => void)[]>();
  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  addEventListener(type: string, f: (e: unknown) => void) {
    this.on.set(type, [...(this.on.get(type) ?? []), f]);
  }
  click() {
    for (const f of this.on.get('click') ?? []) f({});
  }
  appendChild(c: FakeEl) {
    this.children.push(c);
    return c;
  }
  replaceChildren() {
    this.children = [];
  }
  querySelector() {
    return null;
  }
  focus() {}
}

describe('Phone screen', () => {
  afterEach(() => vi.unstubAllGlobals());

  function screen(pose: Partial<PhoneGame['pose']> = {}) {
    const els = new Map<string, FakeEl>();
    const el = (id: string) => els.get(id) ?? els.set(id, new FakeEl()).get(id)!;
    const page = new FakeEl();
    vi.stubGlobal('document', { getElementById: el, createElement: () => new FakeEl(), addEventListener: page.addEventListener.bind(page), elementFromPoint: () => null });
    const game = {
      pose: { x: 0, y: 0, heading: 0, live: true, ready: true, loadFailed: false, mapVersion: 0, units: 'metric', ...pose },
      hasDestination: false,
      beaconOn: true,
      describeAt: vi.fn(async (x: number, y: number) => ({ text: `Spot ${Math.round(x)} ${Math.round(y)}`, sound: 'road', named: true })),
      streetUp: (h: number) => ({ dir: h }),
      directionsText: () => '',
      routeSteps: () => [],
      announce: vi.fn(),
      setTarget: vi.fn(),
      startLive: vi.fn(),
    };
    const phone = new Phone(el('phone') as unknown as HTMLElement, () => game as unknown as PhoneGame, {} as never) as any;
    return { phone, game, el, page };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('keeps the chosen square as the map moves on, so Set as destination still goes there', async () => {
    const { phone, game, el } = screen();
    phone.mapShown = true;
    phone.applyMap();
    phone.tick();
    await flush();
    await phone.choose(3); // top row, middle: 60 metres ahead
    expect(el('ph-dest').disabled).toBe(false);
    game.pose.y = 15; // walked on far enough for the map to be drawn afresh
    phone.tick();
    await flush();
    expect(el('ph-dest').disabled).toBe(false);
    expect(el('ph-dest').textContent).toBe('Set as destination: Spot 0 60');
    el('ph-dest').click();
    expect(game.setTarget).toHaveBeenCalledWith({ name: 'Spot 0 60', x: 0, y: 60 });
  });

  it('keeps the beacon button in step with the beacon, however it was switched', () => {
    const { phone, game, el } = screen();
    phone.tick();
    expect(el('ph-beacon').textContent).toBe('Beacon sound: on');
    game.beaconOn = false; // B, a voice command or the settings
    phone.tick();
    expect(el('ph-beacon').textContent).toBe('Beacon sound: off');
  });

  it('describes the squares again when a map arrives, though the view has not moved', async () => {
    const { phone, game } = screen();
    phone.setMode('explore', false);
    phone.tick();
    await flush();
    expect(game.describeAt).toHaveBeenCalledTimes(49);
    phone.tick();
    await flush();
    expect(game.describeAt).toHaveBeenCalledTimes(49);
    game.pose.mapVersion = 1;
    phone.tick();
    await flush();
    expect(game.describeAt).toHaveBeenCalledTimes(98);
  });

  it('opens explore mode around you, and marks the square you are in as the map is panned', async () => {
    const { phone, game, el } = screen();
    phone.setMode('explore', false);
    phone.tick();
    const me = () => phone.buttons.findIndex((b: FakeEl) => b.classes.has('me'));
    expect(me()).toBe(24);
    el('ph-east').click(); // 140 metres east: you are now off the map's west edge
    phone.tick();
    expect(me()).toBe(-1);
    el('ph-larger').click(); // 50-metre squares: 350 metres across, you are 140 m west of its centre
    phone.tick();
    expect(me()).toBe(3 * 7 + 3 - 3);
    phone.setMode('travel', false);
    game.pose.x = 900; // walked on
    phone.setMode('explore', false);
    phone.tick();
    expect(phone.frame.cx).toBe(900);
    expect(me()).toBe(24);
    await flush();
  });

  it('follows you only once travel mode is chosen, with a warning that it is not reliable', () => {
    const { phone, game, el } = screen();
    phone.setMode('explore', false); // as phone mode opens
    expect(el('ph-warning').hidden).toBe(true);
    expect(el('ph-mode').textContent).toBe('Explore mode. Switch to travel (experimental)');
    expect(game.startLive).not.toHaveBeenCalled();
    el('ph-mode').click();
    expect(phone.mode).toBe('travel');
    expect(game.startLive).toHaveBeenCalledTimes(1);
    expect(el('ph-warning').hidden).toBe(false);
    expect(el('ph-warning').textContent).toBe(TRAVEL_WARNING);
    expect(game.announce).toHaveBeenLastCalledWith(expect.stringMatching(/^Travel mode is experimental and not reliable/));
    el('ph-mode').click();
    expect(el('ph-warning').hidden).toBe(true);
    expect(game.startLive).toHaveBeenCalledTimes(1);
  });

  it('stops speaking squares once the mouse is let go, even outside the map', () => {
    const { phone, el, page } = screen();
    (el('ph-grid') as any).on.get('pointerdown')[0]({ clientX: 0, clientY: 0 });
    expect(phone.touching).toBe(true);
    (page as any).on.get('pointerup')[0]({});
    expect(phone.touching).toBe(false);
  });

  it('says on the directions line that the map is loading, or could not load', () => {
    const { phone, game, el } = screen({ ready: false });
    phone.tick();
    expect(el('ph-dirs').textContent).toBe('Loading the map…');
    game.pose.loadFailed = true;
    phone.tick();
    expect(el('ph-dirs').textContent).toBe('Could not load the map. Trying again shortly.');
    game.pose.ready = true;
    game.pose.loadFailed = false;
    phone.tick();
    expect(el('ph-dirs').textContent).toBe('Choose a destination: tap Where to.');
  });
});
