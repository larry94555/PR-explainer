import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { build, defineConfig, type Plugin } from 'vite';

const src = resolve(import.meta.dirname, 'src');
const outDir = resolve(import.meta.dirname, 'dist');

// The side panel page (PR 11.8) draws the chat with the same code as the
// content script's chat panel. Inside one build that code would go into a
// chunk the content script cannot load (see src/content.ts), so the side
// panel is built on its own, after the main build writes dist/, into
// sidepanel.html and its own files. With `npm run dev` it is built again
// after each rebuild, and its own files are watched too.
function sidePanelBuild(mode: string): Plugin {
  const dir = resolve(src, 'sidepanel');
  return {
    name: 'pr-explainer-side-panel',
    apply: 'build',
    buildStart() {
      for (const file of readdirSync(dir)) this.addWatchFile(resolve(dir, file));
      this.addWatchFile(resolve(src, 'sidepanel.html'));
    },
    async writeBundle() {
      await build({
        configFile: false,
        mode,
        root: src,
        base: './',
        publicDir: false,
        logLevel: 'warn',
        build: {
          outDir,
          emptyOutDir: false,
          sourcemap: mode === 'development',
          modulePreload: { polyfill: false },
          rollupOptions: {
            input: { sidepanel: resolve(src, 'sidepanel.html') },
            output: {
              entryFileNames: '[name].js',
              chunkFileNames: 'chunks/sidepanel-[name]-[hash].js',
              assetFileNames: 'assets/[name]-[hash][extname]',
            },
          },
        },
      });
    },
  };
}

// Builds the Manifest V3 extension into dist/:
// - public/ (manifest.json, icons) is copied as-is to the root of dist/.
// - Each entry below becomes a file at the root of dist/ with a stable name,
//   so manifest.json can refer to background.js, content.js and options.html
//   (and the service worker can open debug.html).
export default defineConfig(({ mode }) => ({
  root: src,
  // Relative URLs so pages work from chrome-extension://<id>/.
  base: './',
  publicDir: resolve(import.meta.dirname, 'public'),
  plugins: [sidePanelBuild(mode)],
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: mode === 'development',
    // Chrome supports modulepreload, so skip Vite's polyfill.
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        background: resolve(src, 'background.ts'),
        content: resolve(src, 'content.ts'),
        options: resolve(src, 'options.html'),
        // The debug window (PR 9.4).
        debug: resolve(src, 'debug.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
}));
