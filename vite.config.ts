import { defineConfig } from 'vite';

// Vite serves the UI in development; the Express server (server/index.ts) owns the
// game library, saves and profiles. In production Express also serves the built UI.
const API = `localhost:${process.env.WSX_PORT ?? 8090}`;

export default defineConfig({
  server: {
    port: Number(process.env.WSX_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': `http://${API}`,
      '/library': `http://${API}`,
      '/bios': `http://${API}`,
      '/ws': { target: `ws://${API}`, ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
