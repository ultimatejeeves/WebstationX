import { defineConfig } from 'vite';

// Vite serves the UI in development; the Express server (server/index.ts) owns the
// game library, saves and profiles. In production Express also serves the built UI.
const API = `localhost:${process.env.WSX_PORT ?? 8090}`;

// See server/index.ts: the PS2 core needs a cross-origin isolated page (SharedArrayBuffer).
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

// The PS2 core is requested from /cores/play/<build version>/ (cache busting, see src/emu/ps2/runtime.ts);
// the files themselves live in public/cores/play.
const versionedCore = {
  name: 'wsx-versioned-core',
  configureServer(server: { middlewares: { use(fn: (req: { url?: string }, res: unknown, next: () => void) => void): void } }) {
    server.middlewares.use((req, _res, next) => {
      if (req.url) req.url = req.url.replace(/^\/cores\/play\/[0-9a-f]{6,40}\//, '/cores/play/');
      next();
    });
  },
};

export default defineConfig({
  plugins: [versionedCore],
  preview: { headers: isolation },
  server: {
    headers: isolation,
    port: Number(process.env.WSX_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': `http://${API}`,
      '/library': `http://${API}`,
      '/bios': `http://${API}`,
      '/games': `http://${API}`,
      '/ws': { target: `ws://${API}`, ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
