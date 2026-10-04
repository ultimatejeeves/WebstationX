import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type DiscoveredGame = {
  id: string; title: string; system: 'ps1' | 'ps2'; players: number;
  multitap: 'none'; pad: 'analog'; disc: string; cover: string; coverUrl: null;
  discUrl: string; size: number; files: { name: string; url: string }[];
};

/** Only regular disc files inside Games are exposed. Symlinks and CUE traversal are rejected. */
export function scanGames(root: string) {
  const games: DiscoveredGame[] = [];
  const files = new Map<string, string>();
  for (const [folder, system] of [['psx', 'ps1'], ['ps2', 'ps2']] as const) {
    const base = path.join(root, folder);
    const walk = (dir: string, depth = 0) => {
      if (depth > 8 || !fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full, depth + 1); continue; }
        const ext = path.extname(entry.name).toLowerCase();
        if (!entry.isFile() || !(system === 'ps1' ? ['.chd', '.iso', '.pbp', '.cue'] : ['.chd', '.iso']).includes(ext)) continue;
        const related = [entry.name];
        if (ext === '.cue') {
          if (fs.statSync(full).size > 1024 * 1024) continue;
          const cue = fs.readFileSync(full, 'utf8');
          const refs = [...cue.matchAll(/^\s*FILE\s+(?:"([^"]+)"|(\S+))\s+/gim)].map(m => m[1] ?? m[2]);
          if (!refs.length || refs.some(name => name.includes('/') || name.includes('\\') || name.includes(':') || name.startsWith('.') || !fs.existsSync(path.join(dir, name)) || !fs.lstatSync(path.join(dir, name)).isFile() || fs.lstatSync(path.join(dir, name)).isSymbolicLink())) continue;
          related.push(...new Set(refs));
        }
        const relative = path.relative(base, full).replace(/\\/g, '/');
        const id = `drop-${system}-${crypto.createHash('sha256').update(relative).digest('hex').slice(0, 20)}`;
        const stat = fs.statSync(full);
        const publicFiles = related.map(name => {
          const key = `${id}/${name}`;
          files.set(key, path.join(dir, name));
          const s = fs.statSync(path.join(dir, name));
          return { name, url: `/games/${id}/${encodeURIComponent(name)}?v=${s.size}-${s.mtimeMs}` };
        });
        games.push({ id, title: path.basename(entry.name, path.extname(entry.name)).replace(/[_]+/g, ' '), system,
          players: 2, multitap: 'none', pad: 'analog', disc: entry.name, cover: '', coverUrl: null,
          discUrl: publicFiles[0].url, size: stat.size, files: publicFiles });
      }
    };
    if (fs.existsSync(base) && !fs.lstatSync(base).isSymbolicLink()) walk(base);
  }
  games.sort((a, b) => a.title.localeCompare(b.title));
  return { games, files };
}
