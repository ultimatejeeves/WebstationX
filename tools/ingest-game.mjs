#!/usr/bin/env node
/**
 * WebStationX game ingest tool.
 *
 * Usage:
 *   node tools/ingest-game.mjs <source> --id crash-bash --title "Crash Bash" [--players 4] [--year 2000]
 *        [--publisher "Sony"] [--genre "Party"] [--multitap port1|port2|none] [--pad standard|analog]
 *        [--blurb "..."] [--cover path/to/cover.jpg]
 *
 * <source> may be a .7z / .zip archive containing bin+cue, a .cue file, or an existing .chd.
 * Output: library/<id>/game.chd, library/<id>/meta.json, and library/catalog.json is updated.
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
const players = Number(opt('players', '1'));
const meta = {
  id,
  title,
  players,
  year: opt('year') ? Number(opt('year')) : undefined,
  publisher: opt('publisher'),
  genre: opt('genre'),
  blurb: opt('blurb', ''),
  // 'port1' enables the multitap on controller port 1 when 3+ players join.
  multitap: opt('multitap', players > 2 ? 'port1' : 'none'),
  // Emulated pad type: 'standard' (digital) or 'analog' (DualShock-style).
  pad: opt('pad', 'standard'),
  disc: 'game.chd',
  cover: 'cover.jpg',
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
    fs.copyFileSync(source, outChd);
  } else {
    if (ext === '.7z' || ext === '.zip' || ext === '.rar') {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsx-ingest-'));
      console.log(`Extracting ${source} ...`);
      run(find7z(), ['x', '-y', `-o${tmp}`, source]);
      const cues = fs.readdirSync(tmp).filter((f) => f.toLowerCase().endsWith('.cue'));
      if (cues.length !== 1) throw new Error(`Expected exactly one .cue in archive, found ${cues.length}`);
      cue = path.join(tmp, cues[0]);
    } else if (ext === '.cue') {
      cue = source;
    } else {
      throw new Error(`Unsupported source: ${source}`);
    }
    console.log(`Compressing to CHD -> ${outChd}`);
    if (fs.existsSync(outChd)) fs.unlinkSync(outChd);
    run(findChdman(), ['createcd', '-i', cue, '-o', outChd]);
  }

  const cover = opt('cover');
  if (cover) fs.copyFileSync(cover, path.join(outDir, 'cover.jpg'));
  else if (!fs.existsSync(path.join(outDir, 'cover.jpg'))) {
    const generated = path.join(root, 'public/assets', `cover-${id}.jpg`);
    if (fs.existsSync(generated)) fs.copyFileSync(generated, path.join(outDir, 'cover.jpg'));
    else console.warn(`No cover found. Drop one at library/${id}/cover.jpg`);
  }

  meta.size = fs.statSync(outChd).size;
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

  const catalogPath = path.join(root, 'library/catalog.json');
  const catalog = fs.existsSync(catalogPath) ? JSON.parse(fs.readFileSync(catalogPath, 'utf8')) : { games: [] };
  catalog.games = catalog.games.filter((g) => g.id !== id);
  catalog.games.push(meta);
  catalog.games.sort((a, b) => a.title.localeCompare(b.title));
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
  console.log(`\nDone. ${title} -> library/${id} (${(meta.size / 1048576).toFixed(1)} MB)`);
} finally {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
}
