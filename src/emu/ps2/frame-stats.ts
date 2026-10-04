/**
 * Reads the core's frame-timing rings out of shared memory (see getFrameStatsAddress in the core).
 * Little endian: u32 vmCount, u32 gsCount, 8 reserved bytes, then 512 VM_FRAME entries (32 bytes:
 * f64 at, f32 frameMs, sleepMs, jitMs, discMs, gsWaitMs, vpu1WaitMs) and 512 GS_FRAME entries (16 bytes:
 * f64 at, f32 busyMs, f32 idleMs). Entry i lives at index i % 512; the counts are entries ever written.
 */
const RING = 512;
const HEADER = 16;
const VM_ENTRY = 32;
const GS_ENTRY = 16;
const GS_BASE = HEADER + RING * VM_ENTRY;

export type GsFrame = { at: number; busyMs: number; idleMs: number };

export type GsRead = {
  /** Entries written since `fromCount`, oldest first (at most the ring size). */
  frames: GsFrame[];
  /** Pass this back as `fromCount` next time. */
  count: number;
};

export type VmFrame = { at: number; frameMs: number; sleepMs: number; jitMs: number; discMs: number; gsWaitMs: number; vpu1WaitMs: number };

export type VmRead = { frames: VmFrame[]; count: number };

/** VM frames (one per emulated vblank) written since `fromCount` (0 = everything still in the ring). */
export function readVmFrames(heap: Uint8Array, address: number, fromCount = 0): VmRead {
  const view = new DataView(heap.buffer, heap.byteOffset + address, GS_BASE);
  const count = Atomics.load(new Uint32Array(heap.buffer, heap.byteOffset + address, 2), 0);
  const fresh = Math.min(count >= fromCount ? count - fromCount : count, RING);
  const frames: VmFrame[] = [];
  for (let n = count - fresh; n < count; n++) {
    const o = HEADER + (n % RING) * VM_ENTRY;
    frames.push({
      at: view.getFloat64(o, true),
      frameMs: view.getFloat32(o + 8, true),
      sleepMs: view.getFloat32(o + 12, true),
      jitMs: view.getFloat32(o + 16, true),
      discMs: view.getFloat32(o + 20, true),
      gsWaitMs: view.getFloat32(o + 24, true),
      vpu1WaitMs: view.getFloat32(o + 28, true),
    });
  }
  return { frames, count };
}

/** GS frames written since `fromCount` (0 = everything still in the ring). */
export function readGsFrames(heap: Uint8Array, address: number, fromCount = 0): GsRead {
  const view = new DataView(heap.buffer, heap.byteOffset + address, GS_BASE + RING * GS_ENTRY);
  const count = Atomics.load(new Uint32Array(heap.buffer, heap.byteOffset + address, 2), 1);
  // A count that went backwards means the core restarted its ring.
  const fresh = Math.min(count >= fromCount ? count - fromCount : count, RING);
  const frames: GsFrame[] = [];
  for (let n = count - fresh; n < count; n++) {
    const o = GS_BASE + (n % RING) * GS_ENTRY;
    frames.push({ at: view.getFloat64(o, true), busyMs: view.getFloat32(o + 8, true), idleMs: view.getFloat32(o + 12, true) });
  }
  return { frames, count };
}

/** Vblank speed, not the game's own rendering rate (a 30 fps game can emulate at full speed). */
export function summarizeVmFrames(frames: VmFrame[]) {
  const valid = frames.filter((f) => Number.isFinite(f.frameMs) && f.frameMs > 0 && f.frameMs < 250);
  const totalMs = valid.reduce((n, f) => n + f.frameMs, 0);
  const share = (key: keyof VmFrame) => totalMs ? valid.reduce((n, f) => n + f[key], 0) / totalMs : 0;
  const sorted = valid.map((f) => f.frameMs).sort((a, b) => a - b);
  return {
    samples: valid.length,
    totalMs,
    vblankFps: totalMs ? valid.length * 1000 / totalMs : 0,
    p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
    slowFrames: valid.filter((f) => f.frameMs > 25).length,
    sleepShare: share('sleepMs'),
    jitShare: share('jitMs'),
    discShare: share('discMs'),
    gsWaitShare: share('gsWaitMs'),
    vpu1WaitShare: share('vpu1WaitMs'),
  };
}
