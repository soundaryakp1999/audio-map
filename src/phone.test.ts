import { afterEach, describe, expect, it, vi } from 'vitest';
import { Phone, cellPoint, isPhone, nextUp, offsetText, type PhoneGame } from './phone';

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
  classList = { add() {}, remove() {}, toggle() {} };
  private attrs = new Map<string, string>();
  private on = new Map<string, ((e: unknown) => void)[]>();
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
    vi.stubGlobal('document', { getElementById: el, createElement: () => new FakeEl() });
    const game = {
      pose: { x: 0, y: 0, heading: 0, live: true, ready: true, loadFailed: false, units: 'metric', ...pose },
      hasDestination: false,
      describeAt: async (x: number, y: number) => ({ text: `Spot ${Math.round(x)} ${Math.round(y)}`, sound: 'road', named: true }),
      streetUp: (h: number) => ({ dir: h }),
      directionsText: () => '',
      routeSteps: () => [],
      announce: vi.fn(),
      setTarget: vi.fn(),
    };
    const phone = new Phone(el('phone') as unknown as HTMLElement, () => game as unknown as PhoneGame, {} as never) as any;
    return { phone, game, el };
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
