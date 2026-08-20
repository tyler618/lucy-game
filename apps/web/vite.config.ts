import { defineConfig } from 'vite';

/**
 * Build targets, and why they are what they are.
 *
 * - `es2020` because the floor is a three-year-old Android, and shipping
 *   syntax its browser has to polyfill costs both bytes and parse time.
 * - Pixi is split into its own chunk so the shell and the verifier page do not
 *   drag the renderer in. `/verify` must load without it: the verifier is the
 *   trust argument and has to work on a bad connection, in a hurry, on
 *   someone else's phone.
 * - No sourcemaps in production. They are 3x the bundle for a title whose
 *   budget is 3MB gzipped.
 */
export default defineConfig({
  build: {
    target: 'es2020',
    sourcemap: false,
    cssCodeSplit: true,
    rollupOptions: {
      input: {
        main: 'index.html',
        verify: 'verify.html',
      },
      output: {
        manualChunks(id) {
          if (id.includes('pixi.js')) return 'pixi';
          if (id.includes('howler')) return 'audio';
          return undefined;
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
