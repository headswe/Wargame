import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: true, port: 5173 },
  build: {
    target: 'es2022',
    outDir: 'dist',
    rollupOptions: {
      output: {
        // three.js is ~95% of the bundle and changes when we upgrade it, which
        // is rarely. Splitting it out means a deploy that only touches game code
        // does not make every returning player re-download the renderer.
        manualChunks: { three: ['three'] },
      },
    },
  },
});
