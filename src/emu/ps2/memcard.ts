/**
 * PS2 memory cards in the Play! core are directories on the emulator's virtual filesystem (one
 * folder per save, like the files a real card's browser shows). To store them with the profile's
 * other saves we pack the tree into one blob:
 *
 *   "WSXPS2MC" | u32 version | u32 count | count x (u16 pathLen | path utf8 | u8 isDir | u32 size | bytes)
 *
 * All integers little endian; paths are relative to the card root with '/' separators.
 */

const MAGIC = 'WSXPS2MC';
const VERSION = 1;

export type EmFS = {
  readdir(path: string): string[];
  stat(path: string): { mode: number; size: number };
  isDir(mode: number): boolean;
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array): void;
  mkdir(path: string): void;
  rmdir(path: string): void;
  unlink(path: string): void;
  analyzePath(path: string): { exists: boolean };
};

type Entry = { path: string; dir: boolean; data: Uint8Array };

function walk(fs: EmFS, root: string, rel: string, out: Entry[]) {
  for (const name of fs.readdir(root + rel)) {
    if (name === '.' || name === '..') continue;
    const p = `${rel}/${name}`;
    const st = fs.stat(root + p);
    if (fs.isDir(st.mode)) {
      out.push({ path: p.slice(1), dir: true, data: new Uint8Array(0) });
      walk(fs, root, p, out);
    } else {
      out.push({ path: p.slice(1), dir: false, data: fs.readFile(root + p) });
    }
  }
}

export function packCard(fs: EmFS, root: string): Uint8Array | null {
  if (!fs.analyzePath(root).exists) return null;
  const entries: Entry[] = [];
  walk(fs, root, '', entries);
  if (entries.length === 0) return null;
  const enc = new TextEncoder();
  const names = entries.map((e) => enc.encode(e.path));
  let size = 8 + 4 + 4;
  entries.forEach((e, i) => (size += 2 + names[i].length + 1 + 4 + e.data.length));
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(enc.encode(MAGIC), 0);
  view.setUint32(8, VERSION, true);
  view.setUint32(12, entries.length, true);
  let o = 16;
  entries.forEach((e, i) => {
    view.setUint16(o, names[i].length, true);
    out.set(names[i], o + 2);
    o += 2 + names[i].length;
    out[o++] = e.dir ? 1 : 0;
    view.setUint32(o, e.data.length, true);
    out.set(e.data, o + 4);
    o += 4 + e.data.length;
  });
  return out;
}

function removeTree(fs: EmFS, path: string) {
  for (const name of fs.readdir(path)) {
    if (name === '.' || name === '..') continue;
    const p = `${path}/${name}`;
    if (fs.isDir(fs.stat(p).mode)) {
      removeTree(fs, p);
      fs.rmdir(p);
    } else fs.unlink(p);
  }
}

function mkdirs(fs: EmFS, path: string) {
  let cur = '';
  for (const part of path.split('/').filter(Boolean)) {
    cur += `/${part}`;
    if (!fs.analyzePath(cur).exists) fs.mkdir(cur);
  }
}

/** Replaces the card at `root` with the packed contents (or an empty card for null). */
export function unpackCard(fs: EmFS, root: string, packed: Uint8Array | null) {
  mkdirs(fs, root);
  removeTree(fs, root);
  if (!packed) return;
  const dec = new TextDecoder();
  if (packed.length < 16 || dec.decode(packed.subarray(0, 8)) !== MAGIC) throw new Error('Not a PS2 memory card');
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  const count = view.getUint32(12, true);
  let o = 16;
  for (let i = 0; i < count; i++) {
    const len = view.getUint16(o, true);
    const rel = dec.decode(packed.subarray(o + 2, o + 2 + len));
    o += 2 + len;
    const dir = packed[o++] === 1;
    const size = view.getUint32(o, true);
    const data = packed.subarray(o + 4, o + 4 + size);
    o += 4 + size;
    if (rel.split('/').some((p) => p === '..' || p === '')) continue;
    const full = `${root}/${rel}`;
    if (dir) mkdirs(fs, full);
    else {
      mkdirs(fs, full.slice(0, full.lastIndexOf('/')));
      fs.writeFile(full, data);
    }
  }
}
