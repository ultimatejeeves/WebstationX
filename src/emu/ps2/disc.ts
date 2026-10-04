/**
 * Streams a PS2 disc image from the server with HTTP range requests.
 *
 * PS2 discs are gigabytes, so unlike PS1 games they are never downloaded up front. The core reads the
 * image in 1 MiB blocks (Js_DiscImageDeviceStream in the Play! core): it keeps a few dozen in its own
 * heap and asks us for the rest, and for read-ahead, with `fetchBlock`. We serve blocks from memory,
 * from Cache Storage (so a second play of the same areas never touches the network), or from the
 * server.
 */
const BLOCK = 1 << 20; // must match CJsDiscImageDeviceStream::BLOCK_SIZE
const MEMORY_BLOCKS = 160; // ~160 MB kept in RAM
const FETCH_TIMEOUT_MS = 20_000;
const CACHE = 'wsx-ps2-blocks-v1';

export type DiscStats = { fetched: number; cacheHits: number; requests: number };

export class StreamingDisc {
  readonly url: string;
  readonly size: number;
  private memory = new Map<number, Uint8Array>(); // insertion order = LRU order
  private pending = new Map<number, Promise<Uint8Array>>();
  private cache: Cache | null = null;
  private closed = false;
  private readonly abort = new AbortController();
  private trouble: string | null = null;
  readonly stats: DiscStats = { fetched: 0, cacheHits: 0, requests: 0 };
  /** Called when the network keeps failing (the core is stalled waiting for data). */
  onTrouble: ((message: string | null) => void) | null = null;

  private constructor(url: string, size: number, cache: Cache | null) {
    this.url = url;
    this.size = size;
    this.cache = cache;
  }

  static async open(url: string): Promise<StreamingDisc> {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Disc not available (${res.status})`);
    const size = Number(res.headers.get('Content-Length') ?? 0);
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Disc size unknown');
    let cache: Cache | null = null;
    try {
      cache = await caches.open(CACHE);
    } catch {
      cache = null; // insecure context: memory only
    }
    return new StreamingDisc(url, size, cache);
  }

  /** Stops streaming. Blocks still in flight resolve (to null) so the core never waits on us. */
  close() {
    this.closed = true;
    this.abort.abort();
    this.memory.clear();
    this.pending.clear();
  }

  /** For problem reports: what's in flight and whether the network is struggling. */
  debug() {
    return { pending: [...this.pending.keys()].slice(0, 16), inMemory: this.memory.size, trouble: this.trouble, closed: this.closed };
  }

  /* ---------- Interface used by the core ---------- */

  getFileSize() {
    return this.size;
  }

  /** The bytes of block `i` (BLOCK long, shorter at the end of the image), or null once closed. */
  async fetchBlock(i: number): Promise<Uint8Array | null> {
    if (this.closed || i < 0 || i * BLOCK >= this.size) return null;
    this.stats.requests++;
    const data = await this.block(i);
    return this.closed ? null : data;
  }

  /* ---------- Blocks ---------- */

  private block(i: number): Promise<Uint8Array> {
    const hit = this.memory.get(i);
    if (hit) {
      this.memory.delete(i);
      this.memory.set(i, hit);
      return Promise.resolve(hit);
    }
    let p = this.pending.get(i);
    if (!p) {
      p = this.load(i).then((data) => {
        this.pending.delete(i);
        this.remember(i, data);
        return data;
      });
      this.pending.set(i, p);
    }
    return p;
  }

  private remember(i: number, data: Uint8Array) {
    if (this.closed) return;
    this.memory.set(i, data);
    while (this.memory.size > MEMORY_BLOCKS) this.memory.delete(this.memory.keys().next().value!);
  }

  private key(i: number) {
    return `${this.url}?wsx-block=${i}`;
  }

  private async load(i: number): Promise<Uint8Array> {
    const start = i * BLOCK;
    const end = Math.min(this.size, start + BLOCK) - 1;
    const expected = end - start + 1;
    if (this.cache) {
      try {
        const cached = await this.cache.match(this.key(i));
        if (cached) {
          const data = new Uint8Array(await cached.arrayBuffer());
          if (data.length === expected) {
            this.stats.cacheHits++;
            return data;
          }
          await this.cache.delete(this.key(i));
        }
      } catch {
        /* fall through to the network */
      }
    }
    for (let attempt = 0; ; attempt++) {
      if (this.closed) return new Uint8Array(end - start + 1);
      try {
        // A stalled connection must not hang the game: give up on the attempt and retry.
        const res = await fetch(this.url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) });
        // Never buffer a multi-GB image when a proxy ignores Range: that can kill the browser tab.
        const wholeSmallDisc = res.status === 200 && start === 0 && expected === this.size;
        const range = res.headers.get('Content-Range');
        if ((!wholeSmallDisc && res.status !== 206) || (res.status === 206 && range !== `bytes ${start}-${end}/${this.size}`)) {
          await res.body?.cancel();
          throw new Error(`Invalid disc range response (HTTP ${res.status})`);
        }
        const data = new Uint8Array(await res.arrayBuffer());
        if (data.length !== expected) throw new Error(`Incomplete disc block (${data.length}/${expected} bytes)`);
        this.stats.fetched += data.length;
        if (attempt > 0) {
          this.trouble = null;
          this.onTrouble?.(null);
        }
        if (this.cache) {
          void this.cache
            .put(this.key(i), new Response(data, { headers: { 'Content-Type': 'application/octet-stream' } }))
            .catch(() => {
              /* storage full: stream only */
            });
        }
        return data;
      } catch (e) {
        if (this.closed) return new Uint8Array(0);
        this.trouble = `block ${i} attempt ${attempt + 1}: ${e instanceof Error ? e.message : e}`;
        if (attempt >= 1) this.onTrouble?.(`Reading the disc from the server failed (${e instanceof Error ? e.message : e}); retrying…`);
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            this.abort.signal.removeEventListener('abort', finish);
            resolve();
          };
          const timer = setTimeout(finish, Math.min(8000, 250 * 2 ** attempt));
          this.abort.signal.addEventListener('abort', finish, { once: true });
          if (this.closed) finish();
        });
      }
    }
  }
}

/** Removes every cached PS2 disc block (Settings → clear downloaded games). */
export async function clearPs2DiscCache() {
  try {
    await caches.delete(CACHE);
  } catch {
    /* ignore */
  }
}
