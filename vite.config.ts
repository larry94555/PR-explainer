import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const src = resolve(import.meta.dirname, 'src');

// Builds the Manifest V3 extension into dist/:
// - public/ (manifest.json, icons) is copied as-is to the root of dist/.
// - Each entry below becomes a file at the root of dist/ with a stable name,
//   so manifest.json can refer to background.js, content.js and options.html.
export default defineConfig(({ mode }) => ({
  root: src,
  // Relative URLs so pages work from chrome-extension://<id>/.
  base: './',
  publicDir: resolve(import.meta.dirname, 'public'),
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: mode === 'development',
    // Chrome supports modulepreload, so skip Vite's polyfill.
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        background: resolve(src, 'background.ts'),
        content: resolve(src, 'content.ts'),
        options: resolve(src, 'options.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
}));
