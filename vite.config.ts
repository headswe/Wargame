import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: true, port: 5173 },
  build: {
    target: 'es2022',
    outDir: 'dist',
    rollupOptions: {
      // The editor and the wall look-book are pages of the same app, so they
      // ship with it rather than being dev-only curiosities.
      input: {
        main: 'index.html',
        editor: 'editor.html',
        walls: 'walls.html',
      },
      output: {
        // three.js is ~95% of the bundle and changes when we upgrade it, which
        // is rarely. Splitting it out means a deploy that only touches game code
        // does not make every returning player re-download the renderer.
        manualChunks: { three: ['three'] },
      },
    },
  },
});
