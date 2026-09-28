import { defineConfig } from 'vite';

// Vite serves the UI in development; the Express server (server/index.ts) owns the
// game library, saves and profiles. In production Express also serves the built UI.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8090',
      '/library': 'http://localhost:8090',
      '/bios': 'http://localhost:8090',
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
