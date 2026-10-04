#!/usr/bin/env node
/**
 * Edits fields of an ingested game in both library/<id>/meta.json and library/catalog.json.
 *
 *   node tools/set-meta.mjs <id> [--demand light|medium|heavy] [--compat ok|issues|broken] [--note "..."]
 *        [--name "Redump name (USA)"] [--players N] [--title "..."] [--genre "..."]
 *
 * --demand and --compat feed the device check (src/core/compat.ts): how heavy the game is to emulate, and
 * what our own testing found. --compat ok clears a previous note.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [id, ...rest] = process.argv.slice(2);
if (!id || id.startsWith('--')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(1);
}
const opt = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

const patch = (meta) => {
  const demand = opt('demand');
  if (demand) {
    if (!['light', 'medium', 'heavy'].includes(demand)) throw new Error('--demand must be light, medium or heavy');
    meta.demand = demand;
  }
  const compat = opt('compat');
  if (compat) {
    if (!['ok', 'issues', 'broken'].includes(compat)) throw new Error('--compat must be ok, issues or broken');
    if (compat === 'ok') delete meta.compat;
    else meta.compat = { status: compat, ...(opt('note') ? { note: opt('note') } : {}) };
  }
  if (opt('name')) meta.sourceName = opt('name');
  if (opt('players')) meta.players = Number(opt('players'));
  if (opt('title')) meta.title = opt('title');
  if (opt('genre')) meta.genre = opt('genre');
  return meta;
};

const metaPath = path.join(root, 'library', id, 'meta.json');
const meta = patch(JSON.parse(fs.readFileSync(metaPath, 'utf8')));
fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

const catalogPath = path.join(root, 'library/catalog.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const entry = catalog.games.find((g) => g.id === id);
if (!entry) throw new Error(`${id} is not in the catalog`);
patch(entry);
catalog.games.sort((a, b) => a.title.localeCompare(b.title));
fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
console.log(`${id}: demand=${meta.demand ?? 'medium'} compat=${meta.compat?.status ?? 'ok'} sourceName="${meta.sourceName}"`);
