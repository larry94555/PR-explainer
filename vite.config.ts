import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Placeholder build. PR 1.2 replaces the single entry below with the
// Manifest V3 entry points (service worker, content script, options page).
export default defineConfig(({ mode }) => ({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: mode === 'development',
    rollupOptions: {
      input: resolve(import.meta.dirname, 'src/index.ts'),
      output: {
        entryFileNames: '[name].js',
      },
    },
  },
}));
