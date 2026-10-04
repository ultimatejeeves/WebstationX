/**
 * Discs and the BIOS are fetched once and kept in the browser's Cache Storage, so
 * the first play of a game shows a download bar and every later play is instant.
 */
const CACHE = 'wsx-discs-v1';

export type Progress = (loaded: number, total: number) => void;

export async function fetchCached(url: string, onProgress?: Progress): Promise<Blob> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) {
      const blob = await hit.blob();
      onProgress?.(blob.size, blob.size);
      return blob;
    }
  } catch {
    cache = null; // Cache API unavailable (e.g. insecure context); fall back to a plain fetch.
  }

  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Failed to fetch ${url} (${res.status})`);
  const total = Number(res.headers.get('Content-Length') ?? 0);
  const type = res.headers.get('Content-Type') ?? 'application/octet-stream';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.(loaded, total || loaded);
  }
  const blob = new Blob(chunks as BlobPart[], { type });
  if (cache) {
    try {
      await cache.put(url, new Response(blob, { headers: { 'Content-Type': type, 'Content-Length': String(blob.size) } }));
    } catch {
      /* storage full or denied: play from memory this time */
    }
  }
  return blob;
}

export async function isCached(url: string): Promise<boolean> {
  try {
    const cache = await caches.open(CACHE);
    return !!(await cache.match(url));
  } catch {
    return false;
  }
}

export async function clearDiscCache() {
  try {
    await caches.delete(CACHE);
  } catch {
    /* ignore */
  }
}
