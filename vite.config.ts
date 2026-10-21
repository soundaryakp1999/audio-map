import { defineConfig } from 'vite';

// Relative asset paths, so the build works under any sub-path (e.g. GitHub Pages at /audio-map/).
export default defineConfig({
  base: './',
});
