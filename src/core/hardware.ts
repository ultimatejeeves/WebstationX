/**
 * Per-device hardware detection and graphics presets. The page measures the machine it runs on (cores,
 * GPU, a short CPU benchmark), picks a quality tier from it and hands the emulators and the menu
 * backdrop a preset. Everything is device-local: the detection is cached and the user's overrides live
 * in localStorage, never on the profile, so one profile can be strong on a desktop and modest on a tablet.
 *
 * The rules (`tierFor`), the thresholds and the preset table are deliberately small and readable so they
 * can be tuned from benchmarks.
 */

export type Tier = 'ultra' | 'high' | 'balanced' | 'low';
export type GpuClass = 'software' | 'desktop-high' | 'desktop-mid' | 'integrated' | 'mobile-high' | 'mobile' | 'unknown';
export type Ps2Res = 1 | 2 | 3 | 4;

export type GraphicsPreset = {
  /** PS2 internal resolution multiplier. */
  ps2Resolution: Ps2Res;
  /** PS1 core's enhanced (2x) resolution, and dithering off with it. */
  ps1Enhanced: boolean;
  /** Let the PS1 core skip frames. */
  ps1Frameskip: boolean;
  /** How many compiled PS2 code blocks to precompile from the JIT cache at boot (0 = none). */
  ps2Precompile: number;
  /** Menu backdrop quality. */
  fx: 'high' | 'medium' | 'low';
};

export const TIERS: readonly Tier[] = ['low', 'balanced', 'high', 'ultra'];

export const PRESETS: Record<Tier, GraphicsPreset> = {
  ultra: { ps2Resolution: 3, ps1Enhanced: true, ps1Frameskip: false, ps2Precompile: 60000, fx: 'high' },
  high: { ps2Resolution: 2, ps1Enhanced: true, ps1Frameskip: false, ps2Precompile: 30000, fx: 'high' },
  balanced: { ps2Resolution: 1, ps1Enhanced: true, ps1Frameskip: false, ps2Precompile: 12000, fx: 'medium' },
  low: { ps2Resolution: 1, ps1Enhanced: false, ps1Frameskip: true, ps2Precompile: 4000, fx: 'low' },
};

export const TIER_LABELS: Record<Tier, string> = { ultra: 'Ultra', high: 'High', balanced: 'Balanced', low: 'Low' };

/* ---------- Detection ---------- */

export type HardwareInfo = {
  /** navigator.hardwareConcurrency (logical threads). */
  cores: number;
  /** navigator.deviceMemory in GB (Chromium only, capped at 8), or null. */
  memoryGb: number | null;
  /** Phone or tablet (any Android counts). */
  mobile: boolean;
  /** Raw WebGL renderer string ('' when unavailable). */
  gpu: string;
  gpuClass: GpuClass;
  /** crossOriginIsolated: what the PS2 core needs. */
  isolated: boolean;
  /** Milliseconds for the fixed benchmark workload (per BENCH_CHUNK iterations); null if it could not run. */
  benchMs: number | null;
};

/** Benchmark workload: iterations per timed step, the reporting unit, and roughly how long to keep running. */
const BENCH_CHUNK = 1_000_000;
const BENCH_STEP = 250_000;
const BENCH_MS = 90;
/** ms per BENCH_CHUNK at or under which the CPU counts as fast (and, missing that, "ok"). */
export const BENCH_FAST_MS = 3;
export const BENCH_OK_MS = 8;

const CACHE_KEY = 'wsx.hw';
const CACHE_VERSION = 2;

let detected: HardwareInfo | null = null;
let readyPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Called when detection finishes (or a device setting changes), so views can re-read `deviceGraphics()`. */
export function onHardwareChange(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
const notify = () => listeners.forEach((cb) => cb());

/** Resolves once detection has run (immediately when the cached result was usable). */
export function hardwareReady(): Promise<void> {
  return initHardware();
}

/** Detects the hardware once (cached per user agent). Safe to call repeatedly. */
export function initHardware(): Promise<void> {
  if (readyPromise) return readyPromise;
  const cached = readCache();
  if (cached) {
    detected = cached;
    return (readyPromise = Promise.resolve());
  }
  readyPromise = new Promise<void>((resolve) => {
    // After first paint: the benchmark blocks the main thread for a moment.
    setTimeout(() => {
      try {
        detected = detectHardware();
        writeCache(detected);
      } catch (e) {
        console.warn('[hardware] detection failed', e);
      }
      resolve();
      notify();
    }, 250);
  });
  return readyPromise;
}

function readCache(): HardwareInfo | null {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as { v: number; ua: string; info: HardwareInfo } | null;
    if (raw && raw.v === CACHE_VERSION && raw.ua === navigator.userAgent && raw.info && typeof raw.info.cores === 'number') return raw.info;
  } catch {
    /* no storage, or garbage */
  }
  return null;
}

function writeCache(info: HardwareInfo) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ v: CACHE_VERSION, ua: navigator.userAgent, info }));
  } catch {
    /* storage unavailable */
  }
}

function isMobileClass(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  if (nav.userAgentData?.mobile) return true;
  // Android tablets say "Android" without "Mobile", so any Android is mobile-class.
  if (/Android|iPhone|iPad|Mobile/i.test(nav.userAgent)) return true;
  // iPadOS asks for the desktop site and reports a Mac.
  return /Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1;
}

function readGpu(): string {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return '';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String((dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null) ?? gl.getParameter(gl.RENDERER) ?? '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch {
    return '';
  }
}

let benchSink = 0;

/** A small mixed integer/float loop, its own function so the engine tiers it up quickly. */
function spin(iterations: number, x: number, f: number): number {
  for (let i = 0; i < iterations; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    f = f * 0.999 + (x & 0xff) * 0.001;
  }
  return x + f;
}

/**
 * ms per BENCH_CHUNK iterations, from many short timed runs (the 20th percentile, so JIT warm-up at the
 * start and timer granularity don't decide the result), or null.
 */
function benchmark(): number | null {
  try {
    const times: number[] = [];
    const end = performance.now() + BENCH_MS;
    let acc = 1;
    do {
      const t0 = performance.now();
      acc = spin(BENCH_STEP, acc | 1, 0.5);
      times.push(performance.now() - t0);
    } while (performance.now() < end || times.length < 20);
    benchSink += acc;
    times.sort((a, b) => a - b);
    const p20 = times[Math.floor(times.length * 0.2)];
    return Math.round(((p20 * BENCH_CHUNK) / BENCH_STEP) * 10) / 10;
  } catch {
    return null;
  }
}

export function detectHardware(): HardwareInfo {
  const mobile = isMobileClass();
  const gpu = readGpu();
  return {
    cores: navigator.hardwareConcurrency || 2,
    memoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
    mobile,
    gpu,
    gpuClass: classifyGpu(gpu, mobile),
    isolated: !!globalThis.crossOriginIsolated,
    benchMs: benchmark(),
  };
}

/* ---------- Classification ---------- */

/** Buckets a WebGL renderer string. Order matters: the first matching rule wins. */
export function classifyGpu(renderer: string, mobile: boolean): GpuClass {
  const r = renderer.replace(/\((R|TM)\)/gi, '').toLowerCase();
  if (!r.trim()) return 'unknown';
  if (/swiftshader|llvmpipe|softpipe|lavapipe|basic render|microsoft basic|software/.test(r)) return 'software';

  // Phones and tablets.
  const adreno = /adreno\D*(\d)\d\d/.exec(r);
  if (adreno && !/adreno\W*x\d/.test(r)) return Number(adreno[1]) >= 7 ? 'mobile-high' : 'mobile';
  if (/adreno\W*x\d/.test(r)) return 'integrated'; // Snapdragon X laptops
  const xclipse = /xclipse\D*(\d)\d\d/.exec(r);
  if (xclipse) return Number(xclipse[1]) >= 9 ? 'mobile-high' : 'mobile';
  if (/immortalis/.test(r)) return 'mobile-high';
  if (/mali|powervr/.test(r)) return 'mobile';

  // Apple: M-series Pro/Max/Ultra are desktop-high; a masked "Apple GPU" is only knowable on iPhone/iPad.
  if (/apple/.test(r)) {
    if (/\bm\d+\s+(pro|max|ultra)/.test(r)) return 'desktop-high';
    if (/\bm\d+/.test(r)) return 'desktop-mid';
    return mobile ? 'mobile-high' : 'unknown';
  }

  // NVIDIA.
  const rtx = /rtx\s*(?:a|pro\s*)?(\d{4})/.exec(r);
  // Compare the model within its generation: a 4060/3050 isn't a higher tier than a 2080.
  if (rtx) return Number(rtx[1]) % 100 >= 70 ? 'desktop-high' : 'desktop-mid';
  if (/geforce|nvidia|quadro|\bgtx\b|titan/.test(r)) return 'desktop-mid';

  // AMD.
  const rx = /radeon\s*(?:pro\s*)?rx\s*(\d{4})/.exec(r);
  if (rx) return Number(rx[1]) % 1000 >= 700 ? 'desktop-high' : 'desktop-mid';
  if (/radeon\s*(?:pro\s*)?rx/.test(r)) return 'desktop-mid';
  if (/radeon\s*graphics|radeon\s*\d{3}m|vega\s*\d+|radeon\s*vega/.test(r)) return 'integrated';
  if (/radeon/.test(r)) return 'desktop-mid';

  // Intel.
  if (/\barc\b/.test(r)) return /\b(a7\d\d|b5\d\d|b7\d\d)\b/.test(r) ? 'desktop-high' : 'desktop-mid';
  if (/intel|iris|\buhd\b|\bhd graphics|\bxe\b/.test(r)) return 'integrated';

  return 'unknown';
}

/** The tier a device gets in Auto mode. */
export function tierFor(hw: Pick<HardwareInfo, 'cores' | 'mobile' | 'gpuClass' | 'benchMs'>): Tier {
  const { cores, gpuClass } = hw;
  const fast = hw.benchMs !== null && hw.benchMs <= BENCH_FAST_MS;
  const ok = hw.benchMs === null || hw.benchMs <= BENCH_OK_MS;
  if (gpuClass === 'software' || cores <= 2) return 'low';

  // Phones and tablets never go above Balanced.
  if (hw.mobile || gpuClass === 'mobile' || gpuClass === 'mobile-high') {
    const capable = gpuClass === 'mobile-high' || gpuClass === 'unknown';
    return capable && cores >= 8 && fast ? 'balanced' : 'low';
  }

  switch (gpuClass) {
    case 'desktop-high':
      if (cores >= 8 && fast) return 'ultra';
      return cores >= 6 ? 'high' : 'low';
    case 'desktop-mid':
      return cores >= 6 ? 'high' : 'low';
    case 'integrated':
      return cores >= 6 ? 'balanced' : 'low';
    default: // unknown GPU (masked renderer): threads and the benchmark decide, never Ultra
      if (cores >= 8 && fast) return 'high';
      if (cores >= 6 && ok) return 'balanced';
      return 'low';
  }
}

/** A conservative stand-in until detection has finished. */
function guessHardware(): HardwareInfo {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  return { cores, memoryGb: null, mobile: typeof navigator !== 'undefined' && isMobileClass(), gpu: '', gpuClass: 'unknown', isolated: false, benchMs: null };
}

/* ---------- Device settings ---------- */

export type DeviceSettings = {
  preset: 'auto' | Tier;
  ps2Resolution: 'preset' | 1 | 2 | 3 | 4;
  /** Lower tier the adaptive safety net dropped this device to (Auto mode only). */
  demotedTo?: Tier;
  /**
   * PS2 CPU speed. Auto: full clock, and the core keeps the console in real time by skipping EE cycles when
   * the device can't run them fast enough (the game drops frames instead of slowing down). Full: never skip
   * (a slow device runs in slow motion). 3/4 and 1/2: fewer EE cycles per frame, always.
   */
  ps2Speed: 'auto' | 'full' | '3/4' | '1/2';
  /** Flag or block games that are likely to run badly on this device (core/compat.ts). */
  deviceCheck: boolean;
};

const DEVICE_KEY = 'wsx.device';
let device: DeviceSettings | null = null;

function readDevice(): DeviceSettings {
  if (device) return device;
  const out: DeviceSettings = { preset: 'auto', ps2Resolution: 'preset', ps2Speed: 'auto', deviceCheck: true };
  try {
    const raw = JSON.parse(localStorage.getItem(DEVICE_KEY) ?? 'null') as Partial<DeviceSettings> | null;
    if (raw) {
      if (raw.preset === 'auto' || TIERS.includes(raw.preset as Tier)) out.preset = raw.preset!;
      if (raw.ps2Resolution === 'preset' || raw.ps2Resolution === 1 || raw.ps2Resolution === 2 || raw.ps2Resolution === 3 || raw.ps2Resolution === 4) out.ps2Resolution = raw.ps2Resolution;
      if (TIERS.includes(raw.demotedTo as Tier)) out.demotedTo = raw.demotedTo;
      if (raw.ps2Speed === 'auto' || raw.ps2Speed === 'full' || raw.ps2Speed === '3/4' || raw.ps2Speed === '1/2') out.ps2Speed = raw.ps2Speed;
      if (typeof raw.deviceCheck === 'boolean') out.deviceCheck = raw.deviceCheck;
    }
  } catch {
    /* defaults */
  }
  return (device = out);
}

function writeDevice(next: DeviceSettings) {
  device = next;
  try {
    localStorage.setItem(DEVICE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: the choice lasts for this page load */
  }
}

export function deviceSettings(): DeviceSettings {
  return { ...readDevice() };
}

/** Changes device settings. Choosing a preset by hand clears the automatic demotion. */
export function setDeviceSettings(patch: Partial<Pick<DeviceSettings, 'preset' | 'ps2Resolution' | 'ps2Speed' | 'deviceCheck'>>) {
  const next: DeviceSettings = { ...readDevice(), ...patch };
  if (patch.preset !== undefined) delete next.demotedTo;
  writeDevice(next);
  notify();
}

export type DeviceGraphics = {
  /** Tier in effect (the detected one in Auto mode). */
  tier: Tier;
  /** Preset is on Auto. */
  auto: boolean;
  /** Tier detection picked, whatever the user chose. */
  detectedTier: Tier;
  /** Effective preset, with the resolution override / demotion applied. */
  preset: GraphicsPreset;
  /** The PS2 resolution the preset alone would give (before the override). */
  presetResolution: Ps2Res;
  /** The user picked a PS2 resolution by hand. */
  resolutionOverride: boolean;
  demotedTo: Tier | null;
  /** PS2 EE clock scale in effect: full speed unless the user picked 75% or 50%. */
  ps2Speed: { numerator: number; denominator: number };
  /** Let the core skip EE cycles to stay in real time (everything but the "Full" CPU speed setting). */
  ps2CatchUp: boolean;
  /** The user picked a PS2 CPU speed by hand. */
  speedOverride: boolean;
  /** Detection has not finished; values are a conservative guess. */
  pending: boolean;
  hardware: HardwareInfo;
};

export function deviceGraphics(): DeviceGraphics {
  const hardware = detected ?? guessHardware();
  const dev = readDevice();
  const detectedTier = detected ? tierFor(detected) : hardware.cores <= 2 ? 'low' : 'balanced';
  const tier: Tier = dev.preset === 'auto' ? detectedTier : dev.preset;
  const auto = dev.preset === 'auto';
  let presetResolution: Ps2Res = PRESETS[tier].ps2Resolution;
  // A short JS benchmark and a GPU name cannot establish 3x PS2 headroom. Keep Auto conservative;
  // explicit Ultra/resolution settings still expose the higher resolutions.
  if (auto) presetResolution = Math.min(presetResolution, 2) as Ps2Res;
  if (auto && dev.demotedTo) presetResolution = Math.min(presetResolution, PRESETS[dev.demotedTo].ps2Resolution) as Ps2Res;
  const resolutionOverride = dev.ps2Resolution !== 'preset';
  const ps2Resolution: Ps2Res = dev.ps2Resolution === 'preset' ? presetResolution : dev.ps2Resolution;
  const speedOverride = dev.ps2Speed !== 'auto';
  const speed = speedOverride ? dev.ps2Speed : 'full';
  const [numerator, denominator] = speed === 'full' ? [1, 1] : speed === '3/4' ? [3, 4] : [1, 2];
  return {
    tier,
    auto,
    detectedTier,
    preset: { ...PRESETS[tier], ps2Resolution },
    presetResolution,
    resolutionOverride,
    demotedTo: auto ? dev.demotedTo ?? null : null,
    ps2Speed: { numerator, denominator },
    ps2CatchUp: dev.ps2Speed !== 'full',
    speedOverride,
    pending: !detected,
    hardware,
  };
}

/**
 * The safety net dropped PS2 resolution a step: remember the next tier down so later launches on this
 * device start lower. Returns that tier (or null when already at the bottom).
 */
export function recordDemotion(): Tier | null {
  const dev = readDevice();
  const g = deviceGraphics();
  const from = dev.demotedTo && TIERS.indexOf(dev.demotedTo) < TIERS.indexOf(g.tier) ? dev.demotedTo : g.tier;
  const lower = TIERS[TIERS.indexOf(from) - 1];
  if (!lower) return null;
  writeDevice({ ...dev, demotedTo: lower });
  notify();
  return lower;
}

/* ---------- Summary ---------- */

/** "ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 (0x00002B85) Direct3D11 vs_5_0 ps_5_0, D3D11)" -> "NVIDIA GeForce RTX 5090". */
export function shortGpuName(renderer: string): string {
  let s = renderer.trim();
  if (/swiftshader/i.test(s)) return 'SwiftShader (software)';
  const angle = /^ANGLE\s*\((.*)\)$/i.exec(s);
  if (angle) {
    const parts = angle[1].split(/,\s*/);
    s = parts.length >= 2 ? parts[1] : parts[0];
  }
  return s
    .replace(/\((R|TM)\)/gi, '')
    .replace(/^ANGLE Metal Renderer:\s*/i, '')
    .replace(/\s*\(0x[0-9a-f]+\).*$/i, '')
    .replace(/\s+(Direct3D\d*|OpenGL|Vulkan|Metal)\b.*$/i, '')
    .replace(/\/(PCIe|SSE2).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One line for the settings screen, e.g. "NVIDIA GeForce RTX 5090 · 16 threads". */
export function hardwareSummary(hw: HardwareInfo = deviceGraphics().hardware): string {
  const parts: string[] = [];
  const gpu = shortGpuName(hw.gpu);
  parts.push(gpu || (hw.mobile ? 'Mobile device' : 'Unknown GPU'));
  parts.push(`${hw.cores} threads`);
  return parts.join(' · ');
}
