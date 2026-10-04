/**
 * PS2 game session on the Play! core. Same surface as EmuSession (the PS1 session) so the play
 * screen doesn't care which console runs: launch, hold/release (reference-counted pause), save
 * states, memory card, screenshots.
 */
import { api } from '../core/api';
import { app } from '../core/app';
import { deviceGraphics, hardwareReady, recordDemotion, type Ps2Res } from '../core/hardware';
import { store } from '../core/store';
import type { GameMeta } from '../core/types';
import type { LaunchArgs } from './player';
import { StreamingDisc } from './ps2/disc';
import { readVmFrames, summarizeVmFrames, type VmFrame } from './ps2/frame-stats';
import { JitCache } from './ps2/jit-cache';
import { packCard, unpackCard } from './ps2/memcard';
import { Ps2Pads } from './ps2/pads';
import { PS2_CORE_VERSION } from './ps2/core-version';
import { PRESENT_FILL, PRESENT_FIT, ps2Runtime, ps2Unsupported, type PlayModule, type Ps2Runtime } from './ps2/runtime';

const STATE_PATH = '/work/wsx-state.p2s';
const RUNNING = 1; // CVirtualMachine::STATUS (PAUSED = 2)
/** Seconds without an emulated frame (the VM thread is stuck) before we call it a freeze. */
const VM_STALL_SECS = 6;
/** Seconds of emulation without a single picture (the GS thread is stuck, or a very long black screen). */
const PICTURE_STALL_SECS = 20;
const CORE_ERROR = /abort|RuntimeError|Uncaught|exception|out of memory/i;
/**
 * Adaptive resolution: how often we look, the window we judge over, and what counts as struggling. The
 * signal is the VM thread: while the game runs at full speed the frame limiter has time to spare every
 * vblank (whatever the game's own frame rate); when the renderer can't keep up, that slack is gone and
 * the VM spends its frames blocked on the GS thread.
 */
const ADAPT_TICK_MS = 5000;
const ADAPT_WINDOW_MS = 30_000;
const ADAPT_MIN_RUNNING_MS = 60_000;
const ADAPT_COOLDOWN_MS = 60_000;
/** Limiter sleep under this share of the window's time: not keeping up. */
const ADAPT_MAX_SLEEP_SHARE = 0.03;
/** Time blocked on the GS thread over this share: the renderer is why. */
const ADAPT_MIN_GS_WAIT_SHARE = 0.15;
/** Resuming a save state: how long the loading screen may spend precompiling cached code first. */
const WARM_JIT_MAX_MS = 1500;

export class Ps2Session {
  readonly game: GameMeta;
  private readonly onLog?: (l: string) => void;
  private rt: Ps2Runtime | null = null;
  private disc: StreamingDisc | null = null;
  private pads: Ps2Pads | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private aborted = false;
  private launched = false;
  private readonly holds = new Set<string>();
  private watchdog = 0;
  private jit: JitCache | null = null;
  private jitFlush = 0;
  private launchedAt = 0;
  private adaptive = 0;
  private resolution: Ps2Res = 1;
  private speed: 'full' | '3/4' | '1/2' = 'full';
  private vmCount = 0;
  private vmWindow: VmFrame[] = [];
  private runningMs = 0;
  private lastDemote = 0;
  private reported = new Set<string>();
  private perfFps = 0;
  private perfSlack = 0;
  private perfSamples = 0;
  /** Told when the core looks frozen or crashed (the play screen shows it); a report went to the server. */
  onProblem: ((message: string) => void) | null = null;

  constructor(game: GameMeta, onLog?: (l: string) => void) {
    this.game = game;
    this.onLog = onLog;
  }

  async launch(args: LaunchArgs) {
    const why = ps2Unsupported();
    if (why) throw new Error(why);
    this.canvas = args.canvas;
    await hardwareReady();
    const { preset } = deviceGraphics();

    // The core starts in seconds; if its threads never come up (a stale or broken download), say so
    // instead of leaving the loading screen up forever.
    let timer = 0;
    const rt = await Promise.race([
      ps2Runtime(),
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error('The PS2 core did not start. Reload the page (Ctrl+F5) and try again.')), 45_000);
      }),
    ]).finally(() => clearTimeout(timer));
    if (this.aborted) return;
    this.rt = rt;
    rt.setLog((l) => {
      this.onLog?.(l);
      if (CORE_ERROR.test(l)) this.report('core-error', `The PS2 core reported an error: ${l.slice(0, 120)}`);
    });
    const m = rt.module;
    m.pauseVm();

    this.disc = await StreamingDisc.open(this.game.discUrl);
    this.disc.onTrouble = (msg) => msg && this.onLog?.(msg);
    if (this.aborted) return this.exit();
    m.discImageDevice = this.disc;
    // Code compiled in earlier sessions, loaded before the boot so it's there from the first block.
    this.jit = await JitCache.open(this.game.id, m);
    if (this.aborted) return this.exit();
    m.jitCacheSetPrecompile?.(preset.ps2Precompile);
    // A save state drops the game straight into a level that needs thousands of blocks at once, faster than
    // idle time can precompile them: give the (still paused) VM a moment on the loading screen first.
    if (args.state && preset.ps2Precompile > 0) await this.warmJit(m, WARM_JIT_MAX_MS);
    if (this.aborted) return this.exit();

    unpackCard(m.FS, m.getMemoryCardPath(0), args.memcard ? new Uint8Array(await args.memcard.arrayBuffer()) : null);
    unpackCard(m.FS, m.getMemoryCardPath(1), null);

    rt.setView(args.canvas);
    this.resize(args.canvas.width, args.canvas.height);
    this.resolution = preset.ps2Resolution;
    m.setResolutionFactor(this.resolution);
    const { ps2Speed, ps2CatchUp, hardware } = deviceGraphics();
    this.speed = ps2Speed.numerator === ps2Speed.denominator ? 'full' : ps2Speed.numerator === 3 ? '3/4' : '1/2';
    m.setEeFrequencyScale(ps2Speed.numerator, ps2Speed.denominator);
    m.setCatchUp?.(ps2CatchUp);
    // Hand-overs between the emulation threads spin before they sleep; keep that short on battery devices.
    m.setVpu1SpinCount?.(hardware.mobile ? 4000 : 30000);
    rt.setVolume(args.prefs.volume / 100);
    m.setFrameLimit(true);

    const ext = this.game.disc.slice(this.game.disc.lastIndexOf('.')) || '.chd';
    this.onLog?.(`booting ${this.game.id}${ext} (${(this.disc.size / 1048576).toFixed(0)} MB, streamed)`);
    m.bootDiscImage(`${this.game.id}${ext}`);
    if (args.state) {
      m.FS.writeFile(STATE_PATH, new Uint8Array(await args.state.arrayBuffer()));
      m.loadState(STATE_PATH);
      if (!(await rt.waitStateOp())) this.onLog?.('could not restore the saved state; starting fresh');
    }
    if (this.aborted) return this.exit();

    this.pads = new Ps2Pads(m, args.players, args.prefs.keymap, args.canvas);
    this.pads.start();
    void rt.audioContext?.resume();
    rt.onGsEvent = (name) => {
      if (name === 'lost') this.report('gl-context-lost', 'The browser reset the graphics; rebuilding the picture…');
      else if (name === 'restore-failed') this.report('gl-restore-failed', 'The graphics could not be rebuilt yet; retrying…');
    };
    this.launched = true;
    this.launchedAt = performance.now();
    this.applyPause();
    this.startWatchdog();
    this.jitFlush = window.setInterval(() => this.flushJit(), 30_000);
    this.vmCount = readVmFrames(m.HEAPU8, m.getFrameStatsAddress()).count;
    this.adaptive = window.setInterval(() => this.adapt(), ADAPT_TICK_MS);
    args.canvas.focus();
  }

  /**
   * Watches for freezes: the emulated frame counter (the VM thread's heartbeat) and the pictures the
   * GS thread hands us. Either one stopping while the game should be running gets reported, with what
   * the core was doing, so a freeze on someone's machine leaves a trace in the server's diag log.
   */
  private startWatchdog() {
    const rt = this.rt;
    if (!rt) return;
    const m = rt.module;
    let lastVblank = m.getVblankCount();
    let lastFrames = rt.totalFrames;
    let vblankStill = 0;
    let framesStill = 0;
    this.watchdog = window.setInterval(() => {
      const vblank = m.getVblankCount();
      const frames = rt.totalFrames;
      if (this.status !== 'running' || document.hidden) {
        vblankStill = framesStill = 0;
      } else {
        vblankStill = vblank === lastVblank ? vblankStill + 1 : 0;
        framesStill = frames === lastFrames ? framesStill + 1 : 0;
        if (vblankStill === VM_STALL_SECS) this.report('vm-stall', 'The PS2 core stopped responding. A report was sent; reloading the page gets you back in.');
        else if (framesStill === PICTURE_STALL_SECS && vblankStill === 0) this.report('no-picture', 'The PS2 core is running but has shown no picture for a while. A report was sent.');
      }
      lastVblank = vblank;
      lastFrames = frames;
    }, 1000);
  }

  /**
   * Safety net for Auto graphics: when the console can't be kept at real speed and the GS thread is the
   * bottleneck, step the PS2 resolution down, live, and remember it for this device. A CPU that is too slow
   * needs nothing from here: the core skips EE cycles to stay in real time and the game drops frames.
   */
  private adapt() {
    const rt = this.rt;
    if (!rt || !this.launched) return;
    const m = rt.module;
    const now = performance.now();
    let read;
    try {
      read = readVmFrames(m.HEAPU8, m.getFrameStatsAddress(), this.vmCount);
    } catch {
      return; // an older core without the frame rings
    }
    this.vmCount = read.count;
    if (this.status !== 'running' || document.hidden) {
      this.vmWindow = [];
      return;
    }
    this.runningMs += ADAPT_TICK_MS;
    // Frames spanning a pause or a hidden tab are not the renderer's fault.
    this.vmWindow.push(...read.frames.filter((f) => f.frameMs > 0 && f.frameMs < 250));
    const since = this.vmWindow.length ? this.vmWindow[this.vmWindow.length - 1].at - ADAPT_WINDOW_MS : 0;
    this.vmWindow = this.vmWindow.filter((f) => f.at >= since);

    const timing = summarizeVmFrames(this.vmWindow);
    if (this.runningMs >= ADAPT_MIN_RUNNING_MS && timing.totalMs >= ADAPT_WINDOW_MS - ADAPT_TICK_MS && timing.vblankFps < 45) {
      this.report('slow-emulation', 'Sustained PS2 slowdown', false);
    }
    // Steady-state samples (no loading, no first-use compilation) for the device check's "how it ran here".
    if (this.runningMs >= ADAPT_MIN_RUNNING_MS && timing.totalMs >= ADAPT_WINDOW_MS - ADAPT_TICK_MS && timing.jitShare + timing.discShare <= 0.05) {
      this.perfFps += timing.vblankFps;
      this.perfSlack += timing.sleepShare;
      this.perfSamples++;
    }
    const g = deviceGraphics();
    const canLowerRes = g.auto && !g.resolutionOverride && this.resolution > 1;
    if (!canLowerRes) return;
    if (this.runningMs < ADAPT_MIN_RUNNING_MS || now - this.lastDemote < ADAPT_COOLDOWN_MS) return;
    const total = timing.totalMs;
    if (total < ADAPT_WINDOW_MS - ADAPT_TICK_MS) return;
    // Loading and first-use compilation are temporary; don't permanently underclock the device for them.
    if (timing.jitShare + timing.discShare > 0.05 || timing.vblankFps >= 48) return;
    const { sleepShare, gsWaitShare } = timing;
    if (sleepShare >= ADAPT_MAX_SLEEP_SHARE) return;
    const why = `limiter slack ${(sleepShare * 100).toFixed(1)}%, waiting on the GS ${(gsWaitShare * 100).toFixed(0)}% of the time`;

    if (gsWaitShare <= ADAPT_MIN_GS_WAIT_SHARE) return;
    this.resolution = (this.resolution - 1) as Ps2Res;
    m.setResolutionFactor(this.resolution);
    recordDemotion();
    this.lastDemote = now;
    this.vmWindow = [];
    this.onLog?.(`resolution lowered to ${this.resolution}x (${why})`);
    app.toast(`Lowered PS2 resolution to ${this.resolution}x to keep the game smooth (Settings → Graphics preset)`, 'ok', 6000);
  }

  /** Waits while the paused VM precompiles cached code, until it has nothing left to do or `maxMs` passed. */
  private async warmJit(m: PlayModule, maxMs: number) {
    const precompiled = () => (JSON.parse(m.jitCacheStats()) as { precompiled?: number }).precompiled ?? 0;
    const start = performance.now();
    let last = precompiled();
    while (performance.now() - start < maxMs && !this.aborted) {
      await new Promise((r) => setTimeout(r, 100));
      const now = precompiled();
      if (now === last) break;
      last = now;
    }
    this.onLog?.(`precompiled ${last} cached blocks in ${Math.round(performance.now() - start)} ms before resuming`);
  }

  /** Stores newly compiled code (every 30 s, when hidden, and on exit). */
  flushJit() {
    if (this.jit && this.rt) void this.jit.flush(this.rt.module);
  }

  private report(kind: string, message: string, notify = true) {
    if (this.reported.has(kind) || !this.rt) return;
    this.reported.add(kind);
    const rt = this.rt;
    const m = rt.module;
    const g = deviceGraphics();
    // A few PC samples: a PC that doesn't move means the VM thread is blocked outside guest code.
    const pcs: string[] = [];
    try {
      for (let i = 0; i < 4; i++) pcs.push(rt.eePc().toString(16).padStart(8, '0'));
    } catch {
      /* ignore */
    }
    const report = {
      kind,
      game: this.game.id,
      core: PS2_CORE_VERSION,
      ua: navigator.userAgent,
      secondsIn: Math.round((performance.now() - this.launchedAt) / 1000),
      vmStatus: m.getVmStatus(),
      vblanks: m.getVblankCount(),
      frames: rt.totalFrames,
      eePc: pcs,
      holds: [...this.holds],
      disc: this.disc ? { ...this.disc.stats, ...this.disc.debug() } : null,
      audio: rt.audioStats,
      jit: JSON.parse(m.jitCacheStats()),
      vpu1Thread: m.getVpu1Stats ? JSON.parse(m.getVpu1Stats()) : null,
      ee: m.getEeStats ? JSON.parse(m.getEeStats()) : null,
      gs: m.getGsStats ? JSON.parse(m.getGsStats()) : null,
      device: { tier: g.tier, auto: g.auto, ps2Resolution: this.resolution, ps2Speed: this.speed, demotedTo: g.demotedTo, cores: navigator.hardwareConcurrency },
      hardware: g.hardware,
      timing: summarizeVmFrames(this.vmWindow),
      prefs: { aspect: store.prefs.aspect },
      log: rt.recentLog.slice(-40),
    };
    console.warn('[ps2] problem report', report);
    void api.diag(report);
    if (notify) this.onProblem?.(message);
  }

  /** Average speed over this session's steady gameplay, or null when there was too little of it. */
  get perf(): { fps: number; slack: number; secs: number } | null {
    if (this.perfSamples === 0) return null;
    return { fps: this.perfFps / this.perfSamples, slack: this.perfSlack / this.perfSamples, secs: (this.perfSamples * ADAPT_TICK_MS) / 1000 };
  }

  get status() {
    if (!this.launched || !this.rt) return 'initial';
    if (this.holds.size > 0) return 'paused';
    return this.rt.module.getVmStatus() === RUNNING ? 'running' : 'paused';
  }
  get module(): unknown {
    return this.rt?.module ?? null;
  }
  /** Actual pictures delivered to the page, rather than the core's vblank counter. */
  get presentedFrames() {
    return this.rt?.totalFrames ?? 0;
  }
  get running() {
    return this.status === 'running';
  }
  /** Sound output state, for tests and problem reports. */
  get audio() {
    const ctx = this.rt?.audioContext;
    return { state: ctx?.state ?? 'none', sampleRate: ctx?.sampleRate ?? 0, ...(this.rt?.audioStats ?? { fillMs: 0, minFillMs: -1, underruns: 0 }) };
  }

  hold(reason: string) {
    this.holds.add(reason);
    this.applyPause();
  }
  release(reason: string) {
    if (!this.holds.delete(reason)) return;
    this.applyPause();
    if (this.holds.size === 0) this.canvas?.focus();
  }
  isHeld(reason: string) {
    return this.holds.has(reason);
  }
  private applyPause() {
    if (!this.launched || !this.rt) return;
    const m = this.rt.module;
    const ctx = this.rt.audioContext;
    if (this.holds.size > 0) {
      m.pauseVm();
      this.flushJit();
      this.pads?.releaseAll();
      void ctx?.suspend();
    } else {
      m.resumeVm();
      void ctx?.resume();
    }
  }

  restart() {
    if (!this.rt) return;
    const ext = this.game.disc.slice(this.game.disc.lastIndexOf('.')) || '.chd';
    this.rt.module.bootDiscImage(`${this.game.id}${ext}`); // resets the VM and boots again
    this.applyPause();
  }

  async saveState(): Promise<{ state: Blob; thumbnail?: Blob }> {
    if (!this.rt) throw new Error('not running');
    const m = this.rt.module;
    m.saveState(STATE_PATH);
    if (!(await this.rt.waitStateOp())) throw new Error('The core could not save its state');
    const state = new Blob([m.FS.readFile(STATE_PATH) as BlobPart], { type: 'application/octet-stream' });
    const thumbnail = (await this.thumbnail()) ?? undefined;
    return { state, thumbnail };
  }

  async loadState(blob: Blob) {
    if (!this.rt) throw new Error('not running');
    const m = this.rt.module;
    m.FS.writeFile(STATE_PATH, new Uint8Array(await blob.arrayBuffer()));
    m.loadState(STATE_PATH);
    if (!(await this.rt.waitStateOp())) throw new Error('That save does not fit this game');
    this.applyPause();
  }

  async saveMemcard(): Promise<Blob | null> {
    if (!this.rt) return null;
    const m = this.rt.module;
    const packed = packCard(m.FS, m.getMemoryCardPath(0));
    return packed ? new Blob([packed as BlobPart], { type: 'application/octet-stream' }) : null;
  }

  async screenshot(): Promise<Blob | undefined> {
    const c = this.canvas;
    if (!c) return undefined;
    return (await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'))) ?? undefined;
  }

  /** Small PNG of the current picture for save-slot lists. */
  private async thumbnail(): Promise<Blob | null> {
    const c = this.canvas;
    if (!c || !c.width || !c.height) return null;
    try {
      const bitmap = await createImageBitmap(c, { resizeWidth: 320, resizeHeight: Math.round((320 * c.height) / c.width), resizeQuality: 'medium' });
      const small = document.createElement('canvas');
      small.width = bitmap.width;
      small.height = bitmap.height;
      small.getContext('2d')!.drawImage(bitmap, 0, 0);
      bitmap.close();
      return await new Promise<Blob | null>((res) => small.toBlob(res, 'image/png'));
    } catch {
      return null;
    }
  }

  resize(w: number, h: number) {
    if (!this.canvas) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.rt?.module.setPresentation(w, h, store.prefs.aspect === 'fill' ? PRESENT_FILL : PRESENT_FIT);
  }

  exit() {
    this.aborted = true;
    clearInterval(this.watchdog);
    clearInterval(this.jitFlush);
    clearInterval(this.adaptive);
    this.flushJit();
    if (this.rt) this.rt.onGsEvent = null;
    this.pads?.stop();
    this.pads = null;
    if (this.rt) {
      const m = this.rt.module;
      m.pauseVm();
      this.rt.setView(null);
      this.rt.setLog(null);
      void this.rt.audioContext?.suspend();
    }
    this.disc?.close();
    this.disc = null;
    this.launched = false;
  }
}
