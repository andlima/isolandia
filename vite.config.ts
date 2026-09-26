import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    // Pixi is large; the spike ships as one bundle and that is fine.
    chunkSizeWarningLimit: 2000,
  },
});
