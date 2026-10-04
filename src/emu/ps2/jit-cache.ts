/**
 * Keeps the PS2 core's compiled code between sessions (WsxJitCache.h in engine/play).
 *
 * Compiling guest code the first time it runs is what makes a new level or menu hitch. The core
 * records what it compiled; we store that in IndexedDB per game and core build, and hand it back on
 * the next launch, so code the player has run before skips most of the compile work.
 *
 * Stored as chunks (one per flush) under [game, core version, n]; loading concatenates them. Chunks of
 * other core versions are dropped: a rebuilt core generates different code.
 */
import { PS2_CORE_VERSION } from './core-version';

const DB_NAME = 'wsx-ps2-jit';
const STORE = 'chunks';

type JitCore = {
  HEAPU8: Uint8Array;
  jitCacheAlloc(size: number): number;
  jitCacheLoad(ptr: number, size: number): void;
  jitCacheTakeNew(): Uint8Array;
  jitCacheStats(): string;
};

type Key = [string, string, number];

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Games whose cache the page's core already holds (the core instance lives as long as the page). */
const loadedGames = new Set<string>();

export class JitCache {
  private readonly game: string;
  private readonly db: IDBDatabase;
  private nextChunk = 0;

  private constructor(game: string, db: IDBDatabase) {
    this.game = game;
    this.db = db;
  }

  /** Opens the game's cache and, the first time this page runs the game, loads it into the core. */
  static async open(game: string, core: JitCore): Promise<JitCache | null> {
    if (typeof indexedDB === 'undefined') return null;
    try {
      const cache = new JitCache(game, await openDb());
      await cache.load(core);
      return cache;
    } catch (e) {
      console.warn('[ps2] compiled code cache unavailable', e);
      return null;
    }
  }

  private async load(core: JitCore) {
    const store = this.db.transaction(STORE, 'readwrite').objectStore(STORE);
    const keys = (await done(store.getAllKeys(IDBKeyRange.bound([this.game], [this.game, []])))) as Key[];
    const chunks: Uint8Array[] = [];
    for (const key of keys) {
      if (key[1] !== PS2_CORE_VERSION) {
        store.delete(key);
        continue;
      }
      this.nextChunk = Math.max(this.nextChunk, key[2] + 1);
      if (!loadedGames.has(this.game)) chunks.push((await done(store.get(key))) as Uint8Array);
    }
    if (loadedGames.has(this.game)) return;
    loadedGames.add(this.game);
    const size = chunks.reduce((n, c) => n + c.length, 0);
    if (!size) return;
    const ptr = core.jitCacheAlloc(size);
    let at = ptr;
    for (const chunk of chunks) {
      core.HEAPU8.set(chunk, at);
      at += chunk.length;
    }
    core.jitCacheLoad(ptr, size);
    console.info(`[ps2] compiled code cache: ${(size / 1048576).toFixed(1)} MiB loaded for ${this.game}`);
  }

  /** Stores what the core compiled since the last flush. */
  async flush(core: JitCore) {
    const fresh = core.jitCacheTakeNew();
    if (!fresh.length) return;
    try {
      const store = this.db.transaction(STORE, 'readwrite').objectStore(STORE);
      await done(store.put(fresh, [this.game, PS2_CORE_VERSION, this.nextChunk++] satisfies Key));
    } catch (e) {
      console.warn('[ps2] could not store compiled code', e);
    }
  }
}

/** Drops every stored compiled code cache (Settings → clear downloaded games). */
export async function clearPs2JitCache() {
  try {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  } catch {
    /* ignore */
  }
}
