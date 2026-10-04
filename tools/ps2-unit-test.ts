import assert from 'node:assert/strict';
import { readVmFrames, summarizeVmFrames } from '../src/emu/ps2/frame-stats';
import { StreamingDisc } from '../src/emu/ps2/disc';
import { classifyGpu, deviceGraphics, setDeviceSettings } from '../src/core/hardware';

// Shared-memory layout, ring wrap, reset, and the formerly ignored VPU1 wait field.
const heap = new Uint8Array(new SharedArrayBuffer(16 + 512 * 32 + 512 * 16));
const view = new DataView(heap.buffer);
for (let n = 0; n < 520; n++) {
  const o = 16 + n % 512 * 32;
  view.setFloat64(o, n * 20, true);
  for (const [offset, value] of [[8, 20], [12, 1], [16, 2], [20, 3], [24, 4], [28, 5]]) view.setFloat32(o + offset, value, true);
}
Atomics.store(new Uint32Array(heap.buffer), 0, 520);
assert.equal(readVmFrames(heap, 0).frames.length, 512);
const fresh = readVmFrames(heap, 0, 518);
assert.equal(fresh.frames.length, 2);
const summary = summarizeVmFrames(fresh.frames);
assert.equal(summary.vblankFps, 50);
assert.equal(summary.vpu1WaitShare, 0.25);
assert.equal(summary.discShare, 0.15);
assert.equal(summary.p95Ms, 20);
Atomics.store(new Uint32Array(heap.buffer), 0, 2);
assert.equal(readVmFrames(heap, 0, 520).frames.length, 2);
assert.equal(summarizeVmFrames([]).vblankFps, 0);
assert.equal(classifyGpu('NVIDIA GeForce RTX 4060 Ti', false), 'desktop-mid');
assert.equal(classifyGpu('NVIDIA GeForce RTX 5090', false), 'desktop-high');
assert.equal(classifyGpu('AMD Radeon RX 7600', false), 'desktop-mid');
assert.equal(classifyGpu('AMD Radeon RX 7900 XTX', false), 'desktop-high');
setDeviceSettings({ preset: 'high' });
assert.deepEqual(deviceGraphics().ps2Speed, { numerator: 1, denominator: 1 }, 'Auto runs the EE at its full clock');
assert.equal(deviceGraphics().ps2CatchUp, true, 'Auto lets the core skip EE cycles to stay in real time');
setDeviceSettings({ ps2Speed: 'full' });
assert.equal(deviceGraphics().ps2CatchUp, false, 'Full never skips');
setDeviceSettings({ ps2Speed: '1/2' });
assert.deepEqual(deviceGraphics().ps2Speed, { numerator: 1, denominator: 2 });
assert.equal(deviceGraphics().ps2CatchUp, true);
setDeviceSettings({ ps2Speed: 'auto' });

const originalFetch = globalThis.fetch;
const block = 1 << 20;
let requests = 0;
let cancelled = false;
let mode: 'valid' | 'whole' | 'short' | 'pending' = 'valid';
globalThis.fetch = (async (_url: unknown, opts: RequestInit = {}) => {
  if (opts.method === 'HEAD') return new Response(null, { headers: { 'Content-Length': String(block + 3) } });
  requests++;
  if (mode === 'pending') return new Promise<Response>((_resolve, reject) => opts.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  if (mode === 'whole') return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 200 });
  const range = (opts.headers as Record<string, string>).Range;
  const last = range === `bytes=${block}-${block + 2}`;
  return new Response(new Uint8Array(mode === 'short' ? 1 : last ? 3 : block), {
    status: 206,
    headers: { 'Content-Range': last ? `bytes ${block}-${block + 2}/${block + 3}` : `bytes 0-${block - 1}/${block + 3}` },
  });
}) as typeof fetch;
try {
  const disc = await StreamingDisc.open('/disc.chd');
  const [a, b] = await Promise.all([disc.fetchBlock(0), disc.fetchBlock(0)]);
  assert.equal(requests, 1, 'deduplicate simultaneous requests');
  assert.equal(a, b);
  assert.equal((await disc.fetchBlock(1))?.length, 3, 'last block has exact length');
  disc.close();
  assert.equal(await disc.fetchBlock(0), null);

  for (mode of ['whole', 'short', 'pending'] as const) {
    const d = await StreamingDisc.open('/disc.chd');
    const request = d.fetchBlock(0);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(d.stats.fetched, 0, 'invalid data must not enter the cache/core');
    d.close();
    assert.equal(await Promise.race([request, new Promise((_, reject) => setTimeout(() => reject(new Error('close did not release read')), 200))]), null);
  }
  assert.ok(cancelled, 'cancel full-disc response before buffering it');
} finally {
  globalThis.fetch = originalFetch;
}
console.log('PASS: PS2 frame telemetry, range validation, request deduplication and cancellation');
