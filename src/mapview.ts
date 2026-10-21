// Visual map (MapLibre GL + OpenFreeMap vector tiles). Purely supplementary: hidden from screen readers.

import { Map as MlMap, setWorkerUrl, type GeoJSONSource } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { Feature, FeatureCollection } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { LatLon } from './geo';
import { applyHighContrast } from './highcontrast';
import type { Favorite } from './favorites';
import type { Note } from './notes';
import type { VehicleId } from './settings';
import { VEHICLE_MODELS, type VehicleModel } from './vehicles';
import { SPRITE_FRAMES, SPRITE_RATIO, drawVehicle } from './sprites';

const STYLE = 'https://tiles.openfreemap.org/styles/liberty';

// MapLibre looks for its worker next to its own script, which bundling breaks; ship it as a file
setWorkerUrl(workerUrl);

export class MapView {
  private map: MlMap;
  private ready = false;
  private trail: [number, number][] = [];
  private lastTrail = 0;
  private routeCoords: [number, number][] = [];
  private destCoords: [number, number][] = [];
  private saved: FeatureCollection = { type: 'FeatureCollection', features: [] };
  private pending: { pos: LatLon; heading: number; speed: number } | null = null;
  private highContrast = false;
  private vehicle: VehicleId = 'walker';
  private model: VehicleModel = VEHICLE_MODELS.walker[0];
  private frames = 0;
  private frame = 0;
  /** stride or rotor progress, in frames */
  private phase = 0;
  private lastUpdate = 0;
  headingUp = true;

  constructor(container: HTMLElement, center: LatLon, highContrast = false) {
    this.highContrast = highContrast;
    this.map = new MlMap({
      container,
      style: STYLE,
      center: [center.lon, center.lat],
      zoom: 17,
      interactive: false,
      attributionControl: { compact: true },
      fadeDuration: 0,
    });
    // fires for the first style and again after every style switch, which drops our layers
    this.map.on('style.load', () => {
      if (this.highContrast) applyHighContrast(this.map);
      this.addOverlays();
      this.ready = true;
      if (this.pending) this.update(this.pending.pos, this.pending.heading, this.pending.speed);
    });
  }

  /** Switch between the standard look and the high-contrast look. */
  setHighContrast(on: boolean) {
    if (on === this.highContrast) return;
    this.highContrast = on;
    this.ready = false;
    this.frames = 0; // a new style starts without our images
    this.map.setStyle(STYLE, { diff: false });
  }

  /** Route, trail, destination, heading cone and position marker; larger and bolder in high contrast. */
  private addOverlays() {
    const hc = this.highContrast;
    const m = this.map;
    m.addSource('route', { type: 'geojson', data: line(this.routeCoords) });
    if (hc) {
      m.addLayer({
        id: 'route-casing',
        type: 'line',
        source: 'route',
        paint: { 'line-color': '#000', 'line-width': 18 },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
    }
    m.addLayer({
      id: 'route',
      type: 'line',
      source: 'route',
      paint: { 'line-color': hc ? '#ff2bd6' : '#7c4dff', 'line-width': hc ? 12 : 7, 'line-opacity': hc ? 1 : 0.75 },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    });
    m.addSource('trail', { type: 'geojson', data: line(this.trail) });
    m.addLayer({
      id: 'trail',
      type: 'line',
      source: 'trail',
      paint: { 'line-color': hc ? '#ff8c00' : '#ff3d7f', 'line-width': hc ? 6 : 4, 'line-opacity': hc ? 0.9 : 0.8 },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    });
    m.addSource('dest', { type: 'geojson', data: points(this.destCoords) });
    m.addLayer({
      id: 'dest',
      type: 'circle',
      source: 'dest',
      paint: hc
        ? { 'circle-radius': 16, 'circle-color': '#ff2bd6', 'circle-stroke-color': '#fff', 'circle-stroke-width': 4 }
        : { 'circle-radius': 9, 'circle-color': '#ffb300', 'circle-stroke-color': '#000', 'circle-stroke-width': 2 },
    });
    m.addSource('saved', { type: 'geojson', data: this.saved });
    m.addLayer({
      id: 'saved',
      type: 'circle',
      source: 'saved',
      paint: {
        'circle-radius': hc ? 12 : 7,
        'circle-color': ['case', ['==', ['get', 'kind'], 'note'], hc ? '#ffee00' : '#43a047', hc ? '#00e5ff' : '#e53935'],
        'circle-stroke-color': hc ? '#000' : '#fff',
        'circle-stroke-width': hc ? 4 : 2,
      },
    });
    // the map is aria-hidden, so these names are for sighted users only
    m.addLayer({
      id: 'saved-label',
      type: 'symbol',
      source: 'saved',
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Bold'],
        'text-size': hc ? 16 : 12,
        'text-anchor': 'top',
        'text-offset': [0, hc ? 1.1 : 0.9],
        'text-optional': true,
      },
      paint: { 'text-color': hc ? '#fff' : '#000', 'text-halo-color': hc ? '#000' : '#fff', 'text-halo-width': hc ? 3 : 2 },
    });
    m.addSource('cone', { type: 'geojson', data: points([]) });
    m.addLayer({
      id: 'cone',
      type: 'fill',
      source: 'cone',
      paint: { 'fill-color': hc ? '#00ff66' : '#1e88e5', 'fill-opacity': hc ? 0.4 : 0.25 },
    });
    m.addSource('me', { type: 'geojson', data: points([]) });
    this.addSprites();
    m.addLayer({
      id: 'me',
      type: 'symbol',
      source: 'me',
      layout: {
        'icon-image': this.spriteId(),
        'icon-size': hc ? 1.3 : 1,
        'icon-rotate': ['get', 'heading'],
        'icon-rotation-alignment': 'map',
        'icon-pitch-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });
  }

  /** Show this vehicle in this model; its drawings replace the last one's. */
  setVehicle(vehicle: VehicleId, model: VehicleModel) {
    if (vehicle === this.vehicle && model.id === this.model.id) return;
    this.vehicle = vehicle;
    this.model = model;
    this.phase = 0;
    this.frame = 0;
    if (!this.ready) return;
    this.addSprites();
    this.map.setLayoutProperty('me', 'icon-image', this.spriteId());
  }

  private spriteId() {
    return `vehicle-${this.frame}`;
  }

  /** One image per animation frame; sizes differ between vehicles, so old ones are removed, not updated. */
  private addSprites() {
    for (let i = 0; i < this.frames; i++) this.map.removeImage(`vehicle-${i}`);
    this.frames = SPRITE_FRAMES[this.vehicle];
    for (let i = 0; i < this.frames; i++) {
      this.map.addImage(`vehicle-${i}`, drawVehicle(this.vehicle, this.model, i, this.highContrast), { pixelRatio: SPRITE_RATIO });
    }
  }

  /** A walker strides with speed and stands still when stopped; a rotor always turns. */
  private animate(speed: number, now: number) {
    const dt = Math.min(0.2, (now - this.lastUpdate) / 1000);
    this.lastUpdate = now;
    let frame = 0;
    if (this.vehicle === 'helicopter') {
      this.phase += dt * 24;
      frame = Math.floor(this.phase) % this.frames;
    } else if (this.vehicle === 'walker' && speed > 0.2) {
      this.phase += (dt * speed) / 0.35; // a frame per 35 cm, a full stride per 1.4 m
      frame = Math.floor(this.phase) % this.frames;
    }
    if (frame === this.frame) return;
    this.frame = frame;
    this.map.setLayoutProperty('me', 'icon-image', this.spriteId());
  }

  resize() {
    this.map.resize();
  }

  resetTrail() {
    this.trail = [];
  }

  /** Planned route for turn-by-turn guidance (null to clear). */
  setRoute(pts: LatLon[] | null) {
    this.routeCoords = (pts ?? []).map((p) => [p.lon, p.lat] as [number, number]);
    if (this.ready) (this.map.getSource('route') as GeoJSONSource).setData(line(this.routeCoords));
  }

  setDestination(p: LatLon | null) {
    this.destCoords = p ? [[p.lon, p.lat]] : [];
    if (this.ready) (this.map.getSource('dest') as GeoJSONSource).setData(points(this.destCoords));
  }

  /** Saved places (red) and spot notes (green; yellow in high contrast). */
  setSaved(places: Favorite[], notes: Note[]) {
    const f = (list: LatLon[], kind: string, text: (p: any) => string) =>
      list.map((p) => ({ type: 'Feature' as const, properties: { kind, label: truncate(text(p)) }, geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] } }));
    this.saved = { type: 'FeatureCollection', features: [...f(places, 'place', (p: Favorite) => p.name), ...f(notes, 'note', (p: Note) => p.text)] };
    if (this.ready) (this.map.getSource('saved') as GeoJSONSource).setData(this.saved);
  }

  update(pos: LatLon, heading: number, speed: number) {
    if (!this.ready) {
      this.pending = { pos, heading, speed };
      return;
    }
    const now = performance.now();
    const last = this.trail[this.trail.length - 1];
    if (now - this.lastTrail > 250 && (!last || last[0] !== pos.lon || last[1] !== pos.lat)) {
      this.trail.push([pos.lon, pos.lat]);
      if (this.trail.length > 4000) this.trail.shift();
      this.lastTrail = now;
      (this.map.getSource('trail') as GeoJSONSource).setData(line(this.trail));
    }
    const me = points([[pos.lon, pos.lat]]);
    me.features[0].properties = { heading };
    (this.map.getSource('me') as GeoJSONSource).setData(me);
    this.animate(speed, now);
    (this.map.getSource('cone') as GeoJSONSource).setData(cone(pos, heading, (this.highContrast ? 30 : 40) + speed * 3));

    // high contrast: a little closer in, so streets and names are bigger on screen
    const near = this.highContrast ? 18.6 : 18;
    const zoom = Math.max(14.5, Math.min(near, near - Math.log2(1 + speed / 4)));
    this.map.jumpTo({
      center: [pos.lon, pos.lat],
      bearing: this.headingUp ? heading : 0,
      zoom: this.map.getZoom() + (zoom - this.map.getZoom()) * 0.05,
    });
  }
}

function truncate(s: string, max = 24): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function line(coords: [number, number][]): Feature {
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } };
}

function points(coords: [number, number][]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: coords.map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } })),
  };
}

function cone(pos: LatLon, heading: number, lenM: number): Feature {
  const mLat = 1 / 110540;
  const mLon = 1 / (111320 * Math.cos((pos.lat * Math.PI) / 180));
  const pts: [number, number][] = [[pos.lon, pos.lat]];
  for (const off of [-20, -10, 0, 10, 20]) {
    const r = ((heading + off) * Math.PI) / 180;
    pts.push([pos.lon + Math.sin(r) * lenM * mLon, pos.lat + Math.cos(r) * lenM * mLat]);
  }
  pts.push([pos.lon, pos.lat]);
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [pts] } };
}
