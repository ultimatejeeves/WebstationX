/**
 * Device check: will this game run well on this device? Combines what the catalog says about the game
 * (how demanding it is, known emulation problems), what hardware detection says about the device, and how
 * the game actually ran here last time. The library flags or blocks games from the verdict; every block
 * that is only an estimate can be overridden ("Play anyway").
 *
 * Like the graphics presets, everything here is device-local (localStorage), never on the profile.
 */
import { ps2Unsupported } from '../emu/ps2/runtime';
import { deviceGraphics, deviceSettings, type DeviceGraphics } from './hardware';
import type { GameMeta } from './types';

export type Verdict = {
  level: 'ok' | 'warn' | 'block';
  /** The browser lacks something the core needs: "Play anyway" can't help. */
  hard: boolean;
  /** Short text for the status pill. */
  label: string;
  /** A sentence or two for the dialog. */
  detail: string;
};

const OK: Verdict = { level: 'ok', hard: false, label: '', detail: '' };

/** How much PS2 a device can take: 0 none, 1 weak, 2 capable, 3 strong. */
export function ps2Power(g: DeviceGraphics = deviceGraphics()): 0 | 1 | 2 | 3 {
  const hw = g.hardware;
  // The core runs the EE, the VU1/GIF pipeline, the GS and audio on their own threads.
  if (hw.cores < 4 || hw.gpuClass === 'software') return 0;
  if (hw.memoryGb !== null && hw.memoryGb <= 2) return 0;
  switch (g.detectedTier) {
    case 'ultra':
    case 'high':
      return 3;
    case 'balanced':
      return 2;
    default:
      return 1;
  }
}

const DEMAND = { light: 1, medium: 2, heavy: 3 } as const;

/* ---------- How it ran last time ---------- */

export type PerfRecord = {
  /** Emulated vblanks per real second (60 = full speed for NTSC). */
  fps: number;
  /** Share of the time the frame limiter had to spare (0 = the device could not keep up). */
  slack: number;
  /** Seconds of gameplay the numbers cover. */
  secs: number;
  at: number;
};

const PERF_KEY = 'wsx.perf';
const ACK_KEY = 'wsx.compat.ack';
/** Shorter sessions say too little (boot, menus, first-use compilation). */
const PERF_MIN_SECS = 120;

function readJson<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? 'null') as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

export function recordPerf(gameId: string, perf: Omit<PerfRecord, 'at'>) {
  if (perf.secs < PERF_MIN_SECS) return;
  const all = readJson<Record<string, PerfRecord>>(PERF_KEY, {});
  all[gameId] = { ...perf, at: Date.now() };
  writeJson(PERF_KEY, all);
}

export function lastPerf(gameId: string): PerfRecord | null {
  return readJson<Record<string, PerfRecord>>(PERF_KEY, {})[gameId] ?? null;
}

/** The player was warned about this game on this device and chose to play: don't ask again. */
export function acknowledge(gameId: string) {
  const ack = readJson<string[]>(ACK_KEY, []);
  if (!ack.includes(gameId)) writeJson(ACK_KEY, [...ack, gameId]);
}
export function acknowledged(gameId: string): boolean {
  return readJson<string[]>(ACK_KEY, []).includes(gameId);
}

/* ---------- The verdict ---------- */

export function checkGame(game: GameMeta): Verdict {
  const ps2 = game.system === 'ps2';
  if (ps2) {
    const why = ps2Unsupported();
    if (why) return { level: 'block', hard: true, label: 'PS2 unavailable here', detail: why };
  }
  if (!deviceSettings().deviceCheck) return OK;

  // Known emulation problems apply to every device.
  if (game.compat?.status === 'broken') {
    return { level: 'block', hard: false, label: 'Not working yet', detail: game.compat.note ?? 'This game does not run properly in the emulator yet.' };
  }
  const issues: Verdict | null =
    game.compat?.status === 'issues' ? { level: 'warn', hard: false, label: 'Known issues', detail: game.compat.note ?? 'This game has known emulation glitches.' } : null;

  const g = deviceGraphics();
  if (!ps2) {
    // PS1 runs nearly everywhere; only the very bottom end struggles.
    if (!g.pending && g.hardware.cores <= 2 && g.hardware.gpuClass === 'software') {
      return { level: 'warn', hard: false, label: 'May stutter here', detail: 'This device has no graphics acceleration and few CPU cores, so the game may stutter. Performance mode in Settings can help.' };
    }
    return issues ?? OK;
  }

  // What actually happened beats any estimate.
  const perf = lastPerf(game.id);
  if (perf) {
    if (perf.fps < 50 || perf.slack < 0.03) {
      const pct = Math.round((Math.min(perf.fps, 60) / 60) * 100);
      return {
        level: 'warn',
        hard: false,
        label: 'Ran slowly here',
        detail:
          perf.fps < 50
            ? `Last time this game ran at about ${pct}% speed on this device. Lowering PS2 resolution or CPU speed in Settings may help.`
            : 'Last time this device could not keep up with this game and it dropped frames. Lowering PS2 resolution or CPU speed in Settings may help.',
      };
    }
    if (perf.fps >= 57 && perf.slack >= 0.1) return issues ?? { ...OK, label: 'Runs well here' };
  }
  if (g.pending) return issues ?? OK;

  const power = ps2Power(g);
  const demand = DEMAND[game.demand ?? 'medium'];
  const device = g.hardware.mobile ? 'phone or tablet' : 'device';
  if (power === 0) {
    return {
      level: 'block',
      hard: false,
      label: 'Too demanding for this device',
      detail: `PS2 games need a multi-core CPU and a real graphics chip, and this ${device} is below that. It will most likely be unplayable.`,
    };
  }
  if (power <= demand - 2) {
    return {
      level: 'block',
      hard: false,
      label: 'Too demanding for this device',
      detail: `This is one of the heaviest games in the library and this ${device} is at the low end for PS2. Expect it to crawl.`,
    };
  }
  if (power === demand - 1) {
    return {
      level: 'warn',
      hard: false,
      label: 'May run slowly here',
      detail: `This game is demanding for this ${device}. It should start, but expect dropped frames in busy scenes.`,
    };
  }
  return issues ?? OK;
}
