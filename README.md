# Audio Map Explorer

Explore real city streets by sound and keyboard. Built for blind and low-vision travellers, with a visual map for sighted helpers.

**Try it:** https://soundaryakp1999.github.io/audio-map/

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production build into dist/
```

Headphones recommended (place sounds are positioned in 3D around you).

## How it works

- **Map data:** OpenStreetMap. Roads and places are first built from OpenFreeMap vector tiles (`src/tiles.ts`), ready in a second or two; the fuller Overpass data (roundabouts, traffic signals) follows in the background and replaces them. Overpass responses are cached in the browser for 14 days, and requests rotate across mirrors with backoff.
- **Search:** Nominatim. **Visual map:** MapLibre GL with OpenFreeMap tiles (no API keys needed).
- **Speech:** your screen reader via ARIA live regions, or the browser's built-in voice.
- **Sound:** synthesized with the Web Audio API. No audio files.

| File | Role |
|---|---|
| `src/game.ts` | Game loop, physics, road assist, announcements, key commands |
| `src/world.ts` | Road graph, junction grouping, spatial indexes, places |
| `src/placeinfo.ts` | Which corner or side of the street a stop, entrance or crossing is on; stop letters and lines |
| `src/phone.ts` | Phone mode: the touch grid, travel and explore modes |
| `src/areas.ts` | Buildings, water, parks and land use under a point, for grid mode |
| `src/osm.ts` | Overpass and Nominatim fetching, retry, cache |
| `src/audio/audio.ts` | Vehicle engines, earcons, HRTF place cues, rumble strips |
| `src/speech.ts` | Live regions, built-in voice, priorities, message history |
| `src/vehicles.ts` | Speed and handling per vehicle, which roads each can use |
| `src/mapview.ts` | Visual map, trail, heading cone |
| `src/profiles.ts` | Sound profiles: which places and junctions are heard for each vehicle |
| `src/favorites.ts`, `src/notes.ts` | Saved places and spot notes, kept in the browser |

On a phone, **Phone mode** (top of the start menu) gives a touch map that works with VoiceOver and TalkBack: a 7 × 7 grid of squares read as you touch them. **Travel** (the default) follows your real location with up the street you face, directions at the top and the beacon; **Explore** is north up and pans by buttons. Units follow the country (imperial in the US) until you choose them in settings. Location needs HTTPS.

**Crossing signal watch** (phone mode, experimental) reads the pedestrian signal with the back camera. A slow low tone means *Don't Walk*; a short high trill means *Walk, maybe*. Silence never means walk, and the watch is an aid only: it is not reliable enough to cross on. It is started by a tap, not automatically (the phone is often in a pocket, and iOS stops the camera when the screen locks); standing at a mapped signal crossing with the watch off, the crossing advice reminds you to start it. It watches wherever the camera points, so a crossing missing from the map or a GPS fix a few metres out does not silence it.

The reading comes from a small YOLO model running on the phone (`src/signalModel.ts`, onnxruntime-web): it looks at a square in the middle of the frame, a little above centre, and a state counts after three matching readings in a row. *Walk* needs a score of 0.7. It downloads (about 25 MB) the first time the watch is switched on, then works offline. It was trained on about 2,000 US photos (`tools/signal-detector/train_signal_detector.ipynb`); on held-out photos it never called a don't-walk signal or a car light walk at these thresholds, but it misses most signals that are far away, and the test set was small. Training data, all CC BY 4.0 from Roboflow Universe: brimagelle-eyewear/brimagelle-test1, bibek-pjlvk/pedestrian-light-classifier, garage-dkgp8/pedestrian-signals-gyb3d, and LISA traffic lights (yolov7-tldetection/lisa-traffic-light-detection-wusg9) for testing. The model was trained with Ultralytics, which is AGPL-3.0.

Press **F3** for grid mode: north is up, the arrow keys step across the map, and each kind of ground (road, building, park, water, land use) has its own sound. Areas come from the same vector tiles (`src/areas.ts`).

Press **F1** in the explorer for spoken help. The full key list is in the menu (**Escape**).

## Contributing

Pull request titles follow [Conventional Commits](https://www.conventionalcommits.org): `type(scope): description`, for example `feat(phone): add a nearby list` or `fix(grid): stop naming areas after bus stops`. Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`; the scope is optional (`grid`, `phone`, `walk`, `gps`, `transit`, `audio`, `nav` are in use). A check on every pull request enforces it.
