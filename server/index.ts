/**
 * WebStationX server.
 *
 * Responsibilities:
 *  - Serve the built UI (dist/) in production.
 *  - Serve the enclosed game library (library/) and BIOS (bios/) with range + caching.
 *  - Persist player profiles, preferences, memory cards and save states as plain files under data/.
 *
 * Access is gated by invite codes (see auth.ts); profiles themselves are nickname based.
 * Online play uses the WebSocket signaling endpoint in signaling.ts.
 */
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Auth } from './auth';
import { attachSignaling } from './signaling';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const libraryDir = path.join(root, 'library');
const biosDir = path.join(root, 'bios');
const distDir = path.join(root, 'dist');
const PORT = Number(process.env.WSX_PORT ?? 8090);

fs.mkdirSync(path.join(dataDir, 'saves'), { recursive: true });

const app = express();
app.disable('x-powered-by');
// Cross-origin isolation: the PS2 core runs on several threads sharing memory, which browsers only
// allow (SharedArrayBuffer) on isolated pages. Everything the app loads is same-origin, so it's free.
app.use((_req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});
// Behind a reverse proxy (Unraid + Nginx Proxy Manager / SWAG / Cloudflare Tunnel) trust the
// forwarded protocol so session cookies are marked Secure and rate limits see real IPs.
if (process.env.WSX_TRUST_PROXY !== '0') app.set('trust proxy', true);

/* ---------- Access gate ---------- */

const auth = new Auth(dataDir);
app.use(express.json({ limit: '1mb' }));

app.get('/api/session', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const s = auth.enabled ? auth.sessionOf(req) : { name: 'Open access', code: '', owner: true };
  res.json({
    signedIn: !!s,
    name: s?.name ?? null,
    owner: !!s?.owner,
    gated: auth.enabled,
    ice: iceServers(),
  });
});

app.post('/api/login', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!auth.enabled) return res.json({ ok: true, name: 'Open access' });
  if (auth.throttled(req.ip ?? 'unknown')) return res.status(429).json({ error: 'Too many tries. Wait a minute.' });
  const invite = auth.find(String(req.body?.code ?? ''));
  if (!invite) return res.status(401).json({ error: 'That code is not valid' });
  auth.setCookie(req, res, auth.issue(invite));
  auth.touch(invite);
  res.json({ ok: true, name: invite.name });
});

app.post('/api/logout', (req, res) => {
  auth.clearCookie(req, res);
  res.json({ ok: true });
});

/** STUN/TURN servers handed to browsers. Set WSX_ICE_SERVERS to a JSON array to add TURN. */
function iceServers(): unknown[] {
  const raw = process.env.WSX_ICE_SERVERS;
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      console.error('WSX_ICE_SERVERS is not valid JSON; using public STUN only');
    }
  }
  return [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
}

const gate = auth.require();
app.use('/api', gate);
app.use('/library', gate);
app.use('/bios', gate);

/* ---------- Library ---------- */

type GameMeta = {
  id: string;
  title: string;
  system?: 'ps1' | 'ps2';
  players: number;
  year?: number;
  publisher?: string;
  genre?: string;
  blurb?: string;
  multitap: 'port1' | 'port2' | 'none';
  pad: 'standard' | 'analog';
  disc: string;
  cover: string;
  size?: number;
  sourceName?: string;
  art?: Record<string, unknown> & { accent?: string; sources?: unknown; scrapedAt?: string };
};

const ART_KINDS = ['box', 'back', 'disc', 'logo', 'title', 'snap', 'fanart', 'video'] as const;

/** Art paths that exist on disk, as URLs, plus the accent colour. Scrape provenance stays server-side. */
function artUrls(g: GameMeta): Record<string, string> | undefined {
  if (!g.art) return undefined;
  const out: Record<string, string> = {};
  for (const kind of ART_KINDS) {
    const rel = g.art[kind];
    if (typeof rel !== 'string' || rel.includes('..')) continue;
    if (fs.existsSync(path.join(libraryDir, g.id, rel))) out[kind] = `/library/${g.id}/${rel}`;
  }
  if (typeof g.art.accent === 'string' && /^#[0-9a-f]{6}$/i.test(g.art.accent)) out.accent = g.art.accent;
  return Object.keys(out).length ? out : undefined;
}

function readCatalog(): GameMeta[] {
  const p = path.join(libraryDir, 'catalog.json');
  if (!fs.existsSync(p)) return [];
  const games = (JSON.parse(fs.readFileSync(p, 'utf8')).games ?? []) as GameMeta[];
  return games.filter((g) => fs.existsSync(path.join(libraryDir, g.id, g.disc)));
}

app.get('/api/catalog', (_req, res) => {
  const games = readCatalog().map((g) => ({
    ...g,
    art: artUrls(g),
    discUrl: `/library/${g.id}/${g.disc}`,
    coverUrl: fs.existsSync(path.join(libraryDir, g.id, g.cover)) ? `/library/${g.id}/${g.cover}` : null,
  }));
  const bios = fs.existsSync(path.join(biosDir, 'SCPH1001.BIN')) ? '/bios/SCPH1001.BIN' : null;
  res.setHeader('Cache-Control', 'no-store');
  res.json({ games, bios });
});

const immutable = {
  acceptRanges: true,
  etag: true,
  index: false,
  setHeaders(res: express.Response) {
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  },
};
app.use('/library', express.static(libraryDir, immutable));
app.use('/bios', express.static(biosDir, immutable));

/* ---------- Profiles & saves ---------- */

type Profile = {
  id: string;
  name: string;
  avatar: string;
  createdAt: string;
  lastSeenAt: string;
  prefs: Record<string, unknown>;
};

const profilesPath = path.join(dataDir, 'profiles.json');
const readProfiles = (): Profile[] => (fs.existsSync(profilesPath) ? JSON.parse(fs.readFileSync(profilesPath, 'utf8')) : []);
const writeProfiles = (p: Profile[]) => fs.writeFileSync(profilesPath, JSON.stringify(p, null, 2));
const safeId = (s: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(s);
const saveDir = (pid: string, gid: string) => path.join(dataDir, 'saves', pid, gid);

app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
const raw = express.raw({ type: () => true, limit: '64mb' });

app.get('/api/profiles', (_req, res) => {
  res.json(readProfiles().sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)));
});

app.post('/api/profiles', (req, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 16);
  const avatar = String(req.body?.avatar ?? 'avatar-01');
  if (!name) return res.status(400).json({ error: 'name required' });
  const profiles = readProfiles();
  let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'player';
  while (profiles.some((p) => p.id === id)) id = `${id}-${Math.floor(Math.random() * 900 + 100)}`;
  const now = new Date().toISOString();
  const profile: Profile = { id, name, avatar, createdAt: now, lastSeenAt: now, prefs: {} };
  profiles.push(profile);
  writeProfiles(profiles);
  res.json(profile);
});

app.patch('/api/profiles/:id', (req, res) => {
  const profiles = readProfiles();
  const p = profiles.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (typeof req.body?.name === 'string' && req.body.name.trim()) p.name = req.body.name.trim().slice(0, 16);
  if (typeof req.body?.avatar === 'string') p.avatar = req.body.avatar;
  if (req.body?.prefs && typeof req.body.prefs === 'object') p.prefs = { ...p.prefs, ...req.body.prefs };
  p.lastSeenAt = new Date().toISOString();
  writeProfiles(profiles);
  res.json(p);
});

app.delete('/api/profiles/:id', (req, res) => {
  const profiles = readProfiles();
  const idx = profiles.findIndex((x) => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  profiles.splice(idx, 1);
  writeProfiles(profiles);
  fs.rmSync(path.join(dataDir, 'saves', req.params.id), { recursive: true, force: true });
  res.json({ ok: true });
});

type SlotInfo = { slot: string; updatedAt: string; size: number; thumbnail: string | null; label?: string };

/** Summary of everything saved for a profile+game: memory card presence and state slots. */
app.get('/api/saves/:pid/:gid', async (req, res) => {
  const { pid, gid } = req.params;
  if (!safeId(pid) || !safeId(gid)) return res.status(400).json({ error: 'bad id' });
  const dir = saveDir(pid, gid);
  const out: { memcard: { updatedAt: string; size: number } | null; slots: SlotInfo[] } = { memcard: null, slots: [] };
  if (!fs.existsSync(dir)) return res.json(out);
  const mc = path.join(dir, 'memcard.srm');
  if (fs.existsSync(mc)) {
    const st = await fsp.stat(mc);
    out.memcard = { updatedAt: st.mtime.toISOString(), size: st.size };
  }
  for (const f of await fsp.readdir(dir)) {
    const m = /^state-([a-z0-9-]+)\.sav$/.exec(f);
    if (!m) continue;
    const st = await fsp.stat(path.join(dir, f));
    const thumb = path.join(dir, `state-${m[1]}.png`);
    const metaPath = path.join(dir, `state-${m[1]}.json`);
    const meta = fs.existsSync(metaPath) ? JSON.parse(await fsp.readFile(metaPath, 'utf8')) : {};
    out.slots.push({
      slot: m[1],
      updatedAt: st.mtime.toISOString(),
      size: st.size,
      thumbnail: fs.existsSync(thumb) ? `/api/saves/${pid}/${gid}/state/${m[1]}/thumbnail?v=${st.mtimeMs}` : null,
      label: meta.label,
    });
  }
  out.slots.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  res.json(out);
});

app.get('/api/saves/:pid/:gid/memcard', (req, res) => {
  const { pid, gid } = req.params;
  if (!safeId(pid) || !safeId(gid)) return res.status(400).end();
  const f = path.join(saveDir(pid, gid), 'memcard.srm');
  if (!fs.existsSync(f)) return res.status(404).end();
  res.sendFile(f);
});

app.put('/api/saves/:pid/:gid/memcard', raw, async (req, res) => {
  const { pid, gid } = req.params;
  if (!safeId(pid) || !safeId(gid)) return res.status(400).end();
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ error: 'empty' });
  const dir = saveDir(pid, gid);
  await fsp.mkdir(dir, { recursive: true });
  // Keep one rolling backup so a corrupted card is never fatal.
  const f = path.join(dir, 'memcard.srm');
  if (fs.existsSync(f)) await fsp.copyFile(f, path.join(dir, 'memcard.bak'));
  await fsp.writeFile(f, body);
  res.json({ ok: true, size: body.length });
});

app.get('/api/saves/:pid/:gid/state/:slot', (req, res) => {
  const { pid, gid, slot } = req.params;
  if (!safeId(pid) || !safeId(gid) || !safeId(slot)) return res.status(400).end();
  const f = path.join(saveDir(pid, gid), `state-${slot}.sav`);
  if (!fs.existsSync(f)) return res.status(404).end();
  res.sendFile(f);
});

app.get('/api/saves/:pid/:gid/state/:slot/thumbnail', (req, res) => {
  const { pid, gid, slot } = req.params;
  if (!safeId(pid) || !safeId(gid) || !safeId(slot)) return res.status(400).end();
  const f = path.join(saveDir(pid, gid), `state-${slot}.png`);
  if (!fs.existsSync(f)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(f);
});

app.put('/api/saves/:pid/:gid/state/:slot', raw, async (req, res) => {
  const { pid, gid, slot } = req.params;
  if (!safeId(pid) || !safeId(gid) || !safeId(slot)) return res.status(400).end();
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ error: 'empty' });
  const dir = saveDir(pid, gid);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `state-${slot}.sav`), body);
  const label = typeof req.query.label === 'string' ? req.query.label.slice(0, 40) : undefined;
  await fsp.writeFile(path.join(dir, `state-${slot}.json`), JSON.stringify({ label, savedAt: new Date().toISOString() }));
  res.json({ ok: true });
});

app.put('/api/saves/:pid/:gid/state/:slot/thumbnail', raw, async (req, res) => {
  const { pid, gid, slot } = req.params;
  if (!safeId(pid) || !safeId(gid) || !safeId(slot)) return res.status(400).end();
  const dir = saveDir(pid, gid);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `state-${slot}.png`), req.body as Buffer);
  res.json({ ok: true });
});

app.delete('/api/saves/:pid/:gid/state/:slot', async (req, res) => {
  const { pid, gid, slot } = req.params;
  if (!safeId(pid) || !safeId(gid) || !safeId(slot)) return res.status(400).end();
  const dir = saveDir(pid, gid);
  for (const ext of ['sav', 'png', 'json']) await fsp.rm(path.join(dir, `state-${slot}.${ext}`), { force: true });
  res.json({ ok: true });
});

/* ---------- Diagnostics ---------- */

// Reports from the client when a game stalls or its core aborts (see Ps2Session's watchdog), one JSON
// object per line. Kept small: the oldest half is dropped past 2 MB.
const diagLog = path.join(dataDir, 'diag.log');
app.post('/api/diag', async (req, res) => {
  const line = JSON.stringify({ at: new Date().toISOString(), from: auth.sessionOf(req)?.name ?? null, ...req.body }).slice(0, 64_000);
  try {
    const st = await fsp.stat(diagLog).catch(() => null);
    if (st && st.size > 2_000_000) {
      const text = await fsp.readFile(diagLog, 'utf8');
      await fsp.writeFile(diagLog, text.slice(text.indexOf('\n', text.length / 2) + 1));
    }
    await fsp.appendFile(diagLog, line + '\n');
  } catch (e) {
    console.error('diag write failed', e);
  }
  console.warn(`[diag] ${String(req.body?.kind ?? '?')} ${String(req.body?.game ?? '')}`);
  res.json({ ok: true });
});

/* ---------- UI (production) ---------- */

if (fs.existsSync(distDir)) {
  // The PS2 core is requested from a folder named after its build (/cores/play/<version>/Play.js, see
  // src/emu/ps2/runtime.ts), so those URLs can be cached forever; the files live in dist/cores/play.
  app.get(/^\/cores\/play\/[0-9a-f]{6,40}\/(Play\.(?:js|wasm))$/, (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(path.join(distDir, 'cores', 'play', req.params[0]));
  });
  app.use(
    express.static(distDir, {
      setHeaders(res, filePath) {
        const p = filePath.replace(/\\/g, '/');
        // Unversioned core files must revalidate: the core's workers used to fetch /cores/play/Play.js.
        if (/\/(assets|fonts)\//.test(p)) res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
        else res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );
  app.get(/^\/(?!api|library|bios).*/, (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

const server = http.createServer(app);
const signaling = attachSignaling(server, auth);

server.listen(PORT, '0.0.0.0', () => {
  const invites = auth.invites().filter((i) => !i.revokedAt).length;
  console.log(`WebStationX server on http://localhost:${PORT}  (library: ${readCatalog().length} game(s), invites: ${invites})`);
  if (!auth.enabled) console.log('No invite codes yet: access is OPEN. Create one with: npm run invite -- add "Name"');
});

process.on('SIGTERM', () => {
  console.log('shutting down', signaling.stats());
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});
