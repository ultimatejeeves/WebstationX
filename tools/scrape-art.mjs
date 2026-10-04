#!/usr/bin/env node
/**
 * WebStationX game-art scraper.
 *
 * Usage:
 *   node tools/scrape-art.mjs [--id <gameId>] [--force] [--source all|libretro|screenscraper] [--dry]
 *   npm run scrape -- --id ape-escape --force
 *
 * For every game in library/catalog.json (or just --id) this fetches art into library/<id>/art/:
 *   box.jpg (front cover), back.jpg, disc.png (disc label), logo.png (wheel logo), title.jpg
 *   (title screen), snap.jpg (in-game shot), fanart.jpg, video.mp4 (gameplay clip)
 * Existing files are skipped unless --force. meta.json and catalog.json get an `art` block
 * (relative paths, an accent colour and per-file sources) and `cover` points at art/box.jpg.
 *
 * Sources, layered (ScreenScraper wins where it has something, libretro fills the rest):
 *   libretro-thumbnails   no account needed; box, title and snap.
 *   ScreenScraper API v2  only when SS_DEV_ID, SS_DEV_PASSWORD, SS_USER and SS_PASSWORD are set
 *                         (in .env or the environment); everything above plus blurb/genre/players/
 *                         year/publisher (filled only when empty). Needs a free ScreenScraper
 *                         account and developer credentials requested on their forum.
 *
 * The game is looked up by its Redump-style name (meta.sourceName, e.g. "Ape Escape (USA)").
 * Also exports scrapeGame(id, opts) for the ingest tool.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const libraryDir = path.join(root, 'library');
const catalogPath = path.join(libraryDir, 'catalog.json');

/** Redump names for games ingested before meta.sourceName existed. */
const KNOWN_SOURCE_NAMES = {
  'crash-bash': 'Crash Bash (USA)',
  medievil: 'MediEvil (USA)',
  'ape-escape': 'Ape Escape (USA)',
};

const REGION_PREF = ['us', 'wor', 'ss', 'eu', 'jp'];
const SS_DELAY_MS = 1250;
/** Per console: libretro-thumbnails folder, ScreenScraper system id, and the file type ScreenScraper expects. */
const SYSTEMS = {
  ps1: { libretro: 'https://thumbnails.libretro.com/Sony%20-%20PlayStation', ssId: '57', romExt: '.cue' },
  ps2: { libretro: 'https://thumbnails.libretro.com/Sony%20-%20PlayStation%202', ssId: '58', romExt: '.iso' },
};
const systemOf = (meta) => SYSTEMS[meta.system] ?? SYSTEMS.ps1;

/**
 * kind -> output file, ScreenScraper media types (in preference order), libretro folder.
 * `kind` order is the order of work.
 */
const KINDS = {
  box: { file: 'box.jpg', ss: ['box-2D'], libretro: 'Named_Boxarts' },
  back: { file: 'back.jpg', ss: ['box-2D-back'] },
  disc: { file: 'disc.png', ss: ['support-2D'] },
  logo: { file: 'logo.png', ss: ['wheel-hd', 'wheel'] },
  title: { file: 'title.jpg', ss: ['sstitle'], libretro: 'Named_Titles' },
  snap: { file: 'snap.jpg', ss: ['ss'], libretro: 'Named_Snaps' },
  fanart: { file: 'fanart.jpg', ss: ['fanart'] },
  video: { file: 'video.mp4', ss: ['video-normalized', 'video'], raw: true },
};

/* ---------- env / credentials ---------- */

function loadEnv() {
  const env = {};
  const p = path.join(root, '.env');
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      let v = m[2];
      if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
      env[m[1]] = v;
    }
  }
  return { ...env, ...process.env };
}

function ssCredentials() {
  const e = loadEnv();
  if (!e.SS_DEV_ID || !e.SS_DEV_PASSWORD || !e.SS_USER || !e.SS_PASSWORD) return null;
  return { devid: e.SS_DEV_ID, devpassword: e.SS_DEV_PASSWORD, ssid: e.SS_USER, sspassword: e.SS_PASSWORD };
}

/* ---------- http ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

async function getBuffer(url, timeoutMs = 60000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'WebStationX/0.1' } });
  if (!res.ok) throw new HttpError(res.status);
  return Buffer.from(await res.arrayBuffer());
}

/** Fetch failures can carry the URL (and with ScreenScraper, credentials); reduce them to a short reason. */
const reason = (e) => (e instanceof HttpError ? e.message : e?.name === 'TimeoutError' ? 'timed out' : 'network error');

let lastSsCall = 0;
async function ssThrottle() {
  const wait = lastSsCall + SS_DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastSsCall = Date.now();
}

const SS_FATAL = {
  401: 'API closed for this account (or not logged in)',
  403: 'developer credentials rejected',
  423: 'API temporarily closed to non-members',
  426: 'API closed to this software (update or credentials)',
  429: 'thread/quota limit reached',
  430: 'daily quota exhausted',
  431: 'too many failed requests, banned for the day',
};

/* ---------- image processing ---------- */

const jpg = (q) => ({ quality: q, mozjpeg: true });

async function processImage(kind, buf) {
  const img = sharp(buf, { animated: false }).rotate();
  switch (kind) {
    case 'box':
    case 'back':
      return img.flatten({ background: '#000000' }).resize({ height: 1000, withoutEnlargement: true }).jpeg(jpg(85)).toBuffer();
    case 'disc':
      return img.resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
    case 'logo':
      return img.resize({ width: 800, withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
    case 'title':
    case 'snap':
      return img
        .flatten({ background: '#000000' })
        .resize({ width: 960, withoutEnlargement: true, kernel: 'nearest' })
        .jpeg(jpg(85))
        .toBuffer();
    case 'fanart':
      return img.flatten({ background: '#000000' }).resize({ width: 1920, withoutEnlargement: true }).jpeg(jpg(82)).toBuffer();
    default:
      throw new Error(`unknown kind ${kind}`);
  }
}

/* ---------- accent colour ---------- */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
}

/** A saturated mid-lightness colour from the box art that reads on a dark blue UI. */
async function accentFrom(buf) {
  const { dominant } = await sharp(buf).stats();
  let [h, s, l] = rgbToHsl(dominant.r, dominant.g, dominant.b);
  if (s < 0.25 || l < 0.12 || l > 0.9) {
    // Dominant bucket is black/white/grey (common on box art): use the most colourful pixels instead.
    const { data } = await sharp(buf).resize(64, 64, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let x = 0;
    let y = 0;
    let wsum = 0;
    for (let i = 0; i < data.length; i += 3) {
      const [ph, ps, pl] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
      const w = ps * (1 - Math.abs(2 * pl - 1)) ** 2;
      x += Math.cos((ph * Math.PI) / 180) * w;
      y += Math.sin((ph * Math.PI) / 180) * w;
      wsum += w;
    }
    h = wsum > 1 ? ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360 : 215;
  }
  return hslToHex(h, clamp(s, 0.55, 0.85), clamp(l, 0.52, 0.62));
}

/* ---------- ScreenScraper ---------- */

function romInfo(sourceName) {
  // Optional hints for the lookup. Never hash big files: 7z lists CRCs without extracting.
  const gamesDir = path.join(root, 'Games');
  const archive = path.join(gamesDir, `${sourceName}.7z`);
  if (fs.existsSync(archive)) {
    const exe = ['C:/Program Files/7-Zip/7z.exe', '7z'].find((c) => c === '7z' || fs.existsSync(c));
    const r = spawnSync(exe, ['l', '-slt', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (r.status === 0) {
      const bins = r.stdout
        .split(/\r?\n\r?\n/)
        .map((blk) => Object.fromEntries(blk.split(/\r?\n/).map((l) => l.split(/ = (.*)/s).slice(0, 2))))
        .filter((e) => /\.bin$/i.test(e.Path ?? '') && e.CRC && e.Size);
      if (bins.length === 1) return { crc: bins[0].CRC.toLowerCase(), romtaille: bins[0].Size };
    }
  }
  const bin = path.join(gamesDir, `${sourceName}.bin`);
  if (fs.existsSync(bin)) return { romtaille: String(fs.statSync(bin).size) };
  return {};
}

const ssState = { disabled: false };

/** Returns the `jeu` object, null when the game is unknown, or throws on a hard failure. */
async function ssLookup(creds, sourceName, sys = SYSTEMS.ps1) {
  await ssThrottle();
  const params = new URLSearchParams({
    devid: creds.devid,
    devpassword: creds.devpassword,
    softname: 'WebStationX',
    output: 'json',
    ssid: creds.ssid,
    sspassword: creds.sspassword,
    systemeid: sys.ssId,
    romtype: 'rom',
    romnom: `${sourceName}${sys.romExt}`,
    ...romInfo(sourceName),
  });
  let res;
  try {
    res = await fetch(`https://api.screenscraper.fr/api2/jeuInfos.php?${params}`, {
      signal: AbortSignal.timeout(45000),
      headers: { 'User-Agent': 'WebStationX/0.1' },
    });
  } catch (e) {
    throw new Error(`ScreenScraper unreachable (${reason(e)})`);
  }
  if (SS_FATAL[res.status]) {
    ssState.disabled = true;
    throw new Error(`ScreenScraper HTTP ${res.status}: ${SS_FATAL[res.status]}`);
  }
  const text = await res.text();
  if (res.status === 404 || /erreur\s*:\s*(rom|jeu).*non trouv/i.test(text)) return null;
  if (!res.ok) throw new Error(`ScreenScraper HTTP ${res.status}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // The API answers some failures (bad login, closed server) with a plain-text 200.
    const line = text.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (/login|identifiant|api|closed|ferm|quota|limit/i.test(line)) ssState.disabled = true;
    throw new Error(`ScreenScraper returned a non-JSON reply (${line || 'empty'})`);
  }
  return json?.response?.jeu ?? null;
}

const regionRank = (r) => {
  const i = REGION_PREF.indexOf((r ?? 'wor').toLowerCase());
  return i < 0 ? REGION_PREF.length : i;
};

function pickMedia(jeu, types) {
  const medias = Array.isArray(jeu?.medias) ? jeu.medias : [];
  for (const type of types) {
    const cands = medias.filter((m) => m.type === type && m.url && (m.parent ?? 'jeu') === 'jeu');
    if (cands.length === 0) continue;
    cands.sort((a, b) => regionRank(a.region) - regionRank(b.region));
    return cands[0];
  }
  return null;
}

const byRegion = (list, region = (x) => x.region) => [...(list ?? [])].sort((a, b) => regionRank(region(a)) - regionRank(region(b)));

function ssMetaFields(jeu) {
  const out = {};
  const syn = (jeu.synopsis ?? []).find((s) => s.langue === 'en' && s.text);
  if (syn) out.blurb = String(syn.text).trim();
  const g = (jeu.genres ?? [])[0];
  const gname = (g?.noms ?? []).find((n) => n.langue === 'en')?.text;
  if (gname) out.genre = String(gname);
  const pl = /\d+/g.exec(String(jeu.joueurs?.text ?? '').split('-').pop() ?? '');
  if (pl) out.players = Number(pl[0]);
  const date = byRegion(jeu.dates, (d) => d.region).find((d) => /^\d{4}/.test(d.text ?? ''));
  if (date) out.year = Number(date.text.slice(0, 4));
  if (jeu.editeur?.text) out.publisher = String(jeu.editeur.text);
  return out;
}

/* ---------- libretro ---------- */

const libretroName = (n) => n.replace(/[&*/:`<>?\\|]/g, '_');
const libretroUrl = (folder, sourceName, sys = SYSTEMS.ps1) => `${sys.libretro}/${folder}/${encodeURIComponent(libretroName(sourceName))}.png`;

/* ---------- main ---------- */

const isEmpty = (v) => v === undefined || v === null || v === '';

function readCatalog() {
  return fs.existsSync(catalogPath) ? JSON.parse(fs.readFileSync(catalogPath, 'utf8')) : { games: [] };
}

/**
 * Scrape art for one game. opts: { force, source: 'all'|'libretro'|'screenscraper', dry, log }.
 * Never throws for per-file failures; throws only if the game does not exist.
 * Returns the art record (or, for --dry, what would have been written).
 */
export async function scrapeGame(id, opts = {}) {
  const { force = false, source = 'all', dry = false } = opts;
  const log = opts.log ?? ((m) => console.log(m));
  const gameDir = path.join(libraryDir, id);
  const metaPath = path.join(gameDir, 'meta.json');
  const catalog = readCatalog();
  const entry = catalog.games.find((g) => g.id === id);
  if (!fs.existsSync(metaPath) && !entry) throw new Error(`No such game: ${id}`);
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : { ...entry };

  if (!meta.sourceName) {
    meta.sourceName = KNOWN_SOURCE_NAMES[id];
    if (!meta.sourceName) {
      meta.sourceName = `${meta.title} (USA)`;
      log(`[${id}] warning: no sourceName in meta.json; guessing "${meta.sourceName}"`);
    }
  }
  const sourceName = meta.sourceName;
  const artDir = path.join(gameDir, 'art');
  const prev = meta.art ?? {};
  const sources = { ...(prev.sources ?? {}) };
  const wrote = new Set();
  const tag = `[${id}]`;

  const need = (kind) => force || !fs.existsSync(path.join(artDir, KINDS[kind].file));
  const wanted = Object.keys(KINDS).filter(need);

  // 1) ScreenScraper
  const creds = source === 'libretro' ? null : ssCredentials();
  let jeu = null;
  const filled = {};
  if (source === 'screenscraper' && !creds) {
    log(`${tag} ScreenScraper credentials missing (SS_DEV_ID, SS_DEV_PASSWORD, SS_USER, SS_PASSWORD); nothing to do`);
  }
  if (creds && !ssState.disabled) {
    try {
      jeu = await ssLookup(creds, sourceName, systemOf(meta));
      if (!jeu) log(`${tag} ScreenScraper: no match for "${sourceName}"`);
      else log(`${tag} ScreenScraper: matched`);
    } catch (e) {
      log(`${tag} ${e.message}; continuing with libretro only`);
    }
  } else if (creds && ssState.disabled) {
    log(`${tag} ScreenScraper skipped (disabled earlier this run)`);
  }

  if (jeu && !dry) {
    for (const [k, v] of Object.entries(ssMetaFields(jeu))) {
      if (isEmpty(meta[k]) || (k === 'players' && !(meta.players > 0))) {
        meta[k] = v;
        filled[k] = true;
      }
    }
  }

  const store = async (kind, buf, from) => {
    const file = KINDS[kind].file;
    const out = KINDS[kind].raw ? buf : await processImage(kind, buf);
    if (dry) {
      log(`${tag} ${file}: would write ${(out.length / 1024).toFixed(0)} KB from ${from}`);
    } else {
      fs.mkdirSync(artDir, { recursive: true });
      fs.writeFileSync(path.join(artDir, file), out);
      log(`${tag} ${file}: ${(out.length / 1024).toFixed(0)} KB from ${from}`);
    }
    sources[kind] = from;
    wrote.add(kind);
  };

  if (jeu) {
    for (const kind of wanted) {
      const media = pickMedia(jeu, KINDS[kind].ss);
      if (!media) continue;
      if (kind === 'video' && dry) {
        log(`${tag} video.mp4: available from screenscraper (dry run, not downloaded)`);
        continue;
      }
      try {
        await ssThrottle();
        const buf = await getBuffer(media.url, kind === 'video' ? 300000 : 60000);
        await store(kind, buf, 'screenscraper');
      } catch (e) {
        log(`${tag} ${KINDS[kind].file}: screenscraper download failed (${e.message?.startsWith('HTTP') ? e.message : reason(e)})`);
        if (e instanceof HttpError && SS_FATAL[e.status]) {
          ssState.disabled = true;
          break;
        }
      }
    }
  }

  // 2) libretro fills the rest
  if (source !== 'screenscraper') {
    for (const kind of wanted) {
      if (wrote.has(kind) || !KINDS[kind].libretro) continue;
      try {
        const buf = await getBuffer(libretroUrl(KINDS[kind].libretro, sourceName, systemOf(meta)));
        await store(kind, buf, 'libretro');
      } catch (e) {
        log(`${tag} ${KINDS[kind].file}: libretro ${e instanceof HttpError && e.status === 404 ? 'has none' : `failed (${reason(e)})`}`);
      }
    }
  }

  // 3) record what is on disk
  const art = {};
  for (const kind of Object.keys(KINDS)) {
    const file = KINDS[kind].file;
    const onDisk = fs.existsSync(path.join(artDir, file)) || (dry && wrote.has(kind));
    if (onDisk) art[kind] = `art/${file}`;
    else delete sources[kind];
  }
  const boxFile = path.join(artDir, 'box.jpg');
  if (wrote.has('box') || (prev.accent === undefined && fs.existsSync(boxFile))) {
    try {
      const buf = fs.existsSync(boxFile) && !(dry && wrote.has('box')) ? fs.readFileSync(boxFile) : null;
      if (buf) art.accent = await accentFrom(buf);
    } catch (e) {
      log(`${tag} accent colour failed (${e.message})`);
    }
  }
  if (art.accent === undefined && prev.accent) art.accent = prev.accent;
  art.sources = sources;
  art.scrapedAt = new Date().toISOString();

  if (dry) {
    log(`${tag} dry run: no files or metadata written`);
    return art;
  }
  meta.art = art;
  if (art.box) meta.cover = art.box;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  const latest = readCatalog();
  const existing = latest.games.find((g) => g.id === id) ?? {};
  latest.games = latest.games.filter((g) => g.id !== id);
  latest.games.push({ ...existing, ...meta });
  latest.games.sort((a, b) => a.title.localeCompare(b.title));
  fs.writeFileSync(catalogPath, JSON.stringify(latest, null, 2));

  const have = Object.keys(KINDS).filter((k) => art[k]);
  const fromCounts = Object.values(sources).reduce((m, s) => ({ ...m, [s]: (m[s] ?? 0) + 1 }), {});
  log(
    `${tag} art: ${have.join(', ') || 'none'}${art.accent ? ` | accent ${art.accent}` : ''}` +
      (Object.keys(filled).length ? ` | filled ${Object.keys(filled).join(', ')}` : '') +
      ` | ${JSON.stringify(fromCounts)}`,
  );
  return art;
}

/* ---------- CLI ---------- */

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
    return;
  }
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const source = opt('source') ?? 'all';
  if (!['all', 'libretro', 'screenscraper'].includes(source)) {
    console.error('--source must be all, libretro or screenscraper');
    process.exit(2);
  }
  const only = opt('id');
  const ids = only ? [only] : readCatalog().games.map((g) => g.id);
  if (ids.length === 0) {
    console.log('No games in library/catalog.json');
    return;
  }
  if (source !== 'libretro' && !ssCredentials()) {
    console.log('ScreenScraper credentials not set; using libretro only. (See README: Game art)');
  }
  let failed = 0;
  for (const id of ids) {
    try {
      await scrapeGame(id, { force: args.includes('--force'), source, dry: args.includes('--dry') });
    } catch (e) {
      failed++;
      console.error(`[${id}] ${e.message}`);
    }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
