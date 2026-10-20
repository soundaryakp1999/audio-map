import { defineConfig, type Plugin } from 'vite';

// Every host the app fetches from. Anything else is blocked, so a script injected into the page cannot send the player's
// Gemini key (or anything else) elsewhere. Add a host here when code starts calling a new one.
const CONNECT = [
  'api.open-meteo.com',
  'api.openstreetmap.org',
  'api.transitous.org',
  'generativelanguage.googleapis.com',
  'maps.mail.ru',
  'nominatim.openstreetmap.org',
  'overpass-api.de',
  'overpass.kumi.systems',
  'overpass.private.coffee',
  'routing.openstreetmap.de',
  'tiles.openfreemap.org',
  'valhalla1.openstreetmap.de',
];

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'", // the signal detector runs as WebAssembly; plain eval stays blocked
  "style-src 'self' 'unsafe-inline'", // the page and MapLibre set inline styles
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${CONNECT.map((h) => `https://${h}`).join(' ')}`,
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

// Build only: the dev server injects inline scripts and a websocket that this policy would block.
const csp = (): Plugin => ({
  name: 'csp',
  apply: 'build',
  transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
});

// Relative asset paths, so the build works under any sub-path (e.g. GitHub Pages at /audio-map/).
export default defineConfig({
  base: './',
  plugins: [csp()],
});
