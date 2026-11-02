import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Serves the static demo pages in demo/ (for example `npm run demo:popup` or `npm run demo:chat`).
// These pages are never part of the extension build in dist/.
export default defineConfig({
  root: resolve(import.meta.dirname, 'demo'),
  server: { fs: { allow: [import.meta.dirname] } },
});
