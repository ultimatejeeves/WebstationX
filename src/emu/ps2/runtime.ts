/**
 * The PS2 core (Play! compiled to WebAssembly with WebStationX's patches, see engine/play).
 *
 * The core runs on its own threads (VM, GS renderer, VIF1/VU1, audio) and cannot be torn down cleanly, so the
 * page keeps a single instance and every PS2 launch reuses it: boot a new disc, point the video
 * output at the current canvas, and pause it when leaving. Frames arrive as ImageBitmaps that the GS
 * thread renders on its own OffscreenCanvas; we draw them with a `bitmaprenderer` context. Sound comes
 * out of a ring in the heap into an AudioWorklet (audio.ts).
 */
import { Ps2Audio } from './audio';
import { PS2_CORE_VERSION } from './core-version';
import type { EmFS } from './memcard';

export type PlayModule = {
  FS: EmFS & { mkdirTree?(p: string): void };
  HEAPU8: Uint8Array;
  discImageDevice: unknown;
  initVmHosted(width: number, height: number, resolutionFactor: number): void;
  bootDiscImage(path: string): void;
  pauseVm(): void;
  resumeVm(): void;
  getVmStatus(): number;
  setPadState(pad: number, buttons: number, axes: number): void;
  getVibration(pad: number): number;
  saveState(path: string): void;
  loadState(path: string): void;
  pollStateOp(): number;
  getMemoryCardPath(slot: number): string;
  setPresentation(width: number, height: number, mode: number): void;
  setResolutionFactor(factor: number): void;
  setFrameLimit(enabled: boolean): void;
  setVolume(gain: number): void;
  setEeFrequencyScale(numerator: number, denominator: number): void;
  getFrames(): number;
  clearStats(): void;
  getVblankCount(): number;
  getEePcAddress(): number;
  getFrameStatsAddress(): number;
  getAudioRingAddress(): number;
  jitCacheAlloc(size: number): number;
  jitCacheLoad(ptr: number, size: number): void;
  jitCacheTakeNew(): Uint8Array;
  jitCacheStats(): string;
  /** Precompile up to this many cached code blocks at boot (newer cores only). */
  jitCacheSetPrecompile?(maxEntries: number): void;
  /** VIF1/VU1/GIF on a thread of their own: 0 off, 1 synchronous (testing), 2 on. Before initVmHosted. */
  setVpu1ThreadMode?(mode: number): void;
  /** That thread's counters (mode, EE waits by reason), as JSON. */
  getVpu1Stats?(): string;
  /** Keep the console on the wall clock by skipping EE cycles when emulation falls behind (default on). */
  setCatchUp?(enabled: boolean): void;
  /** How long each side of an EE/VPU1 hand-over spins before sleeping (0: sleeps at once). */
  setVpu1SpinCount?(count: number): void;
  /** EE thread counters (cycles run, skipped, idle, waits), as JSON. */
  getEeStats?(): string;
  /** GS thread counters, as JSON. */
  getGsStats?(): string;
};

/**
 * Whether the VIF1/VU1/GIF work gets its own thread. It takes about 40% of the emulation thread's load
 * off, which is what lets slower CPUs keep up, but it needs a spare core: the VM and GS threads each
 * already keep one busy. `localStorage['wsx.vu1thread']` ('0' or '2') overrides it for testing.
 */
function vpu1ThreadMode(): number {
  try {
    const forced = localStorage.getItem('wsx.vu1thread');
    if (forced === '0' || forced === '2') return Number(forced);
  } catch {
    // storage unavailable: use the default
  }
  return (navigator.hardwareConcurrency ?? 0) >= 4 ? 2 : 0;
}

type PlayFactory = (overrides: Record<string, unknown>) => Promise<PlayModule>;

// A folder per build (the servers map it to public/cores/play), so a rebuilt core is never served from a
// stale immutable cache. A ?v= query is not enough: the core's worker threads load `Play.js` relative to
// the core's own URL, without the query, and got the old cached glue with the new wasm (a hang at boot).
const CORE_DIR = `/cores/play/${PS2_CORE_VERSION}/`;
const CORE_URL = `${CORE_DIR}Play.js`;

/** PRESENTATION_MODE in the core. */
export const PRESENT_FILL = 0;
export const PRESENT_FIT = 1;

export class Ps2Runtime {
  readonly module: PlayModule;
  private view: ImageBitmapRenderingContext | null = null;
  private logSink: ((line: string) => void) | null = null;
  private frames = 0;
  /** Frames presented since the runtime started (never reset, unlike takeFrameCount). */
  totalFrames = 0;
  /** The core's recent output, kept for problem reports. */
  readonly recentLog: string[] = [];
  /** GS thread events: 'lost' (the browser dropped its WebGL context), 'restored', 'restore-failed'. */
  onGsEvent: ((name: string) => void) | null = null;

  private audio: Ps2Audio | null = null;

  private constructor(module: PlayModule) {
    this.module = module;
  }

  static async create(onFrame: (rt: Ps2Runtime, bitmap: ImageBitmap) => void, onLog: (line: string) => void): Promise<Ps2Runtime> {
    // A full URL: Vite's dev server rewrites root-relative dynamic imports (appends ?import), which
    // breaks files served from public/.
    const { default: Play } = (await import(/* @vite-ignore */ new URL(CORE_URL, location.origin).href)) as { default: PlayFactory };
    let rt: Ps2Runtime | null = null;
    const module = await Play({
      locateFile: (p: string) => `${CORE_DIR}${p}`,
      mainScriptUrlOrBlob: CORE_URL,
      print: (s: string) => onLog(s),
      printErr: (s: string) => onLog(s),
      wsxPresent: (bitmap: ImageBitmap) => {
        if (rt) onFrame(rt, bitmap);
        else bitmap.close();
      },
      wsxGsEvent: (name: string) => {
        rt?.log(`GS: ${name}`);
        rt?.onGsEvent?.(name);
      },
    });
    module.FS.mkdir('/work');
    module.setVpu1ThreadMode?.(vpu1ThreadMode());
    // Size and resolution are set again on every launch.
    module.initVmHosted(640, 480, 1);
    const created = new Ps2Runtime(module);
    created.audio = await Ps2Audio.create(module.HEAPU8.buffer, module.getAudioRingAddress());
    rt = created;
    return rt;
  }

  /** Where frames go (null = drop them). */
  setView(canvas: HTMLCanvasElement | null) {
    this.view = canvas ? canvas.getContext('bitmaprenderer') : null;
  }

  present(bitmap: ImageBitmap) {
    this.frames++;
    this.totalFrames++;
    if (this.view) this.view.transferFromImageBitmap(bitmap);
    else bitmap.close();
  }

  /** Frames presented since the last call. */
  takeFrameCount() {
    const n = this.frames;
    this.frames = 0;
    return n;
  }

  setLog(sink: ((line: string) => void) | null) {
    this.logSink = sink;
  }

  log(line: string) {
    this.recentLog.push(line);
    if (this.recentLog.length > 80) this.recentLog.shift();
    this.logSink?.(line);
  }

  /** The EE (main CPU) program counter, read straight from the shared memory. */
  eePc(): number {
    const heap = this.module.HEAPU8;
    return new DataView(heap.buffer, heap.byteOffset).getUint32(this.module.getEePcAddress(), true);
  }

  /** The AudioContext the core plays through (created with the runtime). */
  get audioContext(): AudioContext | null {
    return this.audio?.context ?? null;
  }

  /** Master volume, 0..1. */
  setVolume(volume: number) {
    this.audio?.setVolume(volume);
  }

  /** Sound buffer level and underruns so far (for problem reports). */
  get audioStats() {
    return this.audio?.stats ?? null;
  }

  /** Runs a save/load state request to completion (the core does it on the VM thread). */
  async waitStateOp(timeoutMs = 20_000): Promise<boolean> {
    const end = performance.now() + timeoutMs;
    for (;;) {
      const r = this.module.pollStateOp();
      if (r >= 0) return r === 1;
      if (r === -2) return false;
      if (performance.now() > end) throw new Error('The PS2 core did not answer');
      await new Promise((res) => setTimeout(res, 16));
    }
  }
}

let runtime: Promise<Ps2Runtime> | null = null;

/** The page's PS2 core, created on first use. */
export function ps2Runtime(): Promise<Ps2Runtime> {
  runtime ??= Ps2Runtime.create(
    (rt, bitmap) => rt.present(bitmap),
    (line) => current?.log(line),
  ).then((rt) => (current = rt));
  runtime.catch(() => (runtime = null));
  return runtime;
}
let current: Ps2Runtime | null = null;

/** Why PS2 games can't run in this browser/context, or null if they can. */
export function ps2Unsupported(): string | null {
  if (typeof SharedArrayBuffer === 'undefined' || !globalThis.crossOriginIsolated) {
    return location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1'
      ? 'This page is not cross-origin isolated, which the PS2 core needs. Reload the page; if it persists, the server is missing its COOP/COEP headers.'
      : 'PS2 games need a secure connection. Open WebStationX through its https:// address (or on localhost).';
  }
  if (typeof OffscreenCanvas === 'undefined' || typeof ImageBitmapRenderingContext === 'undefined' || !('transferFromImageBitmap' in ImageBitmapRenderingContext.prototype)) {
    return 'This browser lacks OffscreenCanvas rendering. Use a recent Chrome, Edge or Firefox.';
  }
  return null;
}
