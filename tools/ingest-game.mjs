#!/usr/bin/env node
/**
 * WebStationX game ingest tool.
 *
 * Usage:
 *   node tools/ingest-game.mjs <source> --id crash-bash --title "Crash Bash" [--players 4] [--year 2000]
 *        [--publisher "Sony"] [--genre "Party"] [--multitap port1|port2|none] [--pad standard|analog]
 *        [--blurb "..."] [--cover path/to/cover.jpg] [--name "Crash Bash (USA)"] [--no-scrape]
 *        [--system ps1|ps2]
 *
 * <source> may be a .7z / .zip archive containing bin+cue (or an .iso for PS2), a .cue file, an .iso
 * (PS2), or an existing .chd.
 * PS2 games (--system ps2) run on the Play! core: two controller ports, DualShock 2, disc streamed
 * from the server. An existing .chd is hard-linked into the library when possible (they are GBs).
 * Output: library/<id>/game.chd, library/<id>/meta.json, and library/catalog.json is updated.
 * The source file's name (without extension) is kept as meta.sourceName (override with --name); it
 * should be the Redump-style name, because the art scraper looks the game up by it.
 * Afterwards tools/scrape-art.mjs runs for the new game (skip with --no-scrape); scrape failures
 * only warn.
 *
 * Requires: 7z.exe (C:\Program Files\7-Zip) and chdman.exe (work/tools/chdman.exe or on PATH).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(0);
}
const source = args[0];
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

const id = opt('id') ?? path.basename(source).replace(/\s*\(.*?\)/g, '').replace(/\.[^.]+$/, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
const title = opt('title') ?? path.basename(source).replace(/\s*\(.*?\)/g, '').replace(/\.[^.]+$/, '').trim();
const system = opt('system', 'ps1');
if (system !== 'ps1' && system !== 'ps2') throw new Error(`--system must be ps1 or ps2`);
const players = Math.min(Number(opt('players', '1')), system === 'ps2' ? 2 : 4);
const meta = {
  id,
  title,
  system,
  players,
  year: opt('year') ? Number(opt('year')) : undefined,
  publisher: opt('publisher'),
  genre: opt('genre'),
  blurb: opt('blurb', ''),
  // 'port1' enables the multitap on controller port 1 when 3+ players join.
  multitap: system === 'ps2' ? 'none' : opt('multitap', players > 2 ? 'port1' : 'none'),
  // Emulated pad type: 'standard' (digital) or 'analog' (DualShock-style). PS2 pads are always DualShock 2.
  pad: system === 'ps2' ? 'analog' : opt('pad', 'standard'),
  disc: 'game.chd',
  cover: 'cover.jpg',
  sourceName: opt('name') ?? path.basename(source).replace(/\.[^.]+$/, ''),
  addedAt: new Date().toISOString(),
};

const find7z = () => {
  for (const c of ['C:/Program Files/7-Zip/7z.exe', '7z']) if (c === '7z' || fs.existsSync(c)) return c;
};
const findChdman = () => {
  for (const c of [path.join(root, 'work/tools/chdman.exe'), 'chdman']) if (c === 'chdman' || fs.existsSync(c)) return c;
};
const run = (cmd, cmdArgs) => {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status})`);
};

const outDir = path.join(root, 'library', id);
fs.mkdirSync(outDir, { recursive: true });
const outChd = path.join(outDir, 'game.chd');

let tmp;
try {
  let cue;
  const ext = path.extname(source).toLowerCase();
  if (ext === '.chd') {
    if (fs.existsSync(outChd)) fs.unlinkSync(outChd);
    try {
      fs.linkSync(source, outChd); // same volume: no copy
      console.log(`Linked ${source} -> ${outChd}`);
    } catch {
      console.log(`Copying ${source} -> ${outChd}`);
      fs.copyFileSync(source, outChd);
    }
  } else {
    let iso;
    if (ext === '.7z' || ext === '.zip' || ext === '.rar') {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsx-ingest-'));
      console.log(`Extracting ${source} ...`);
      run(find7z(), ['x', '-y', `-o${tmp}`, source]);
      // Some archives wrap the disc in a folder, so look below the top level too.
      const files = fs.readdirSync(tmp, { recursive: true }).map(String);
      const cues = files.filter((f) => f.toLowerCase().endsWith('.cue'));
      const isos = files.filter((f) => f.toLowerCase().endsWith('.iso'));
      if (system === 'ps2' && isos.length === 1 && cues.length === 0) iso = path.join(tmp, isos[0]);
      else if (cues.length === 1) cue = path.join(tmp, cues[0]);
      else throw new Error(`Expected exactly one .cue (or .iso for PS2) in archive, found ${cues.length} cue / ${isos.length} iso`);
    } else if (ext === '.cue') {
      cue = source;
    } else if (ext === '.iso' && system === 'ps2') {
      iso = source;
    } else {
      throw new Error(`Unsupported source: ${source}`);
    }
    console.log(`Compressing to CHD -> ${outChd}`);
    if (fs.existsSync(outChd)) fs.unlinkSync(outChd);
    // PS2 DVDs become DVD CHDs; CD-based discs (all PS1, a few PS2) keep their track layout.
    if (iso) run(findChdman(), ['createdvd', '-i', iso, '-o', outChd]);
    else run(findChdman(), ['createcd', '-i', cue, '-o', outChd]);
  }

  const cover = opt('cover');
  if (cover) fs.copyFileSync(cover, path.join(outDir, 'cover.jpg'));
  else if (!fs.existsSync(path.join(outDir, 'cover.jpg'))) {
    const generated = path.join(root, 'public/assets', `cover-${id}.jpg`);
    if (fs.existsSync(generated)) fs.copyFileSync(generated, path.join(outDir, 'cover.jpg'));
    else console.warn(`No cover found. Drop one at library/${id}/cover.jpg`);
  }

  meta.size = fs.statSync(outChd).size;
  // Re-ingesting keeps art that was already scraped.
  const prevMetaPath = path.join(outDir, 'meta.json');
  if (fs.existsSync(prevMetaPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(prevMetaPath, 'utf8'));
      if (prev.art) {
        meta.art = prev.art;
        if (prev.art.box) meta.cover = prev.art.box;
      }
    } catch {
      /* unreadable old meta.json: start fresh */
    }
  }
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

  const catalogPath = path.join(root, 'library/catalog.json');
  const catalog = fs.existsSync(catalogPath) ? JSON.parse(fs.readFileSync(catalogPath, 'utf8')) : { games: [] };
  catalog.games = catalog.games.filter((g) => g.id !== id);
  catalog.games.push(meta);
  catalog.games.sort((a, b) => a.title.localeCompare(b.title));
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
  console.log(`\nDone. ${title} -> library/${id} (${(meta.size / 1048576).toFixed(1)} MB)`);

  if (!args.includes('--no-scrape')) {
    console.log('\nScraping game art (skip with --no-scrape) ...');
    try {
      const { scrapeGame } = await import('./scrape-art.mjs');
      await scrapeGame(id);
    } catch (e) {
      console.warn(`Art scrape failed (ingest is fine; retry with: npm run scrape -- --id ${id}): ${e.message}`);
    }
  }
} finally {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
}
