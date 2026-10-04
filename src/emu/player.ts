/**
 * Emulator session: wraps Nostalgist.js driving the PCSX-ReARMed libretro core (WebAssembly).
 *
 * The important design point is input routing. Every player slot chosen in the lobby is
 * pinned to a RetroArch port: gamepads by their Gamepad API index, the keyboard by giving
 * that port the keyboard binds and every other port `nul`. With 3-4 players the core's
 * multitap is switched on so the game sees a real 4-controller setup.
 */
import { Nostalgist } from 'nostalgist';
import { deviceGraphics, hardwareReady } from '../core/hardware';
import type { DeviceId, GameMeta, Prefs } from '../core/types';
import { isMouseBinding, PSX_BUTTONS } from './keymap';
import { clearPortMap, setPortMap } from './virtual-pads';

export type SessionPlayers = (DeviceId | null)[]; // index = PSX player 0..3

export type LaunchArgs = {
  game: GameMeta;
  /** The whole disc image (PS1). PS2 sessions stream the disc themselves and get null. */
  disc: Blob | null;
  bios: Blob | null;
  players: SessionPlayers;
  prefs: Prefs;
  memcard: Blob | null;
  state: Blob | null;
  canvas: HTMLCanvasElement;
  onLog?: (line: string) => void;
};

// RetroArch hotkeys we do not want firing from stray keys during play.
const HOTKEYS_OFF = [
  'input_menu_toggle',
  'input_exit_emulator',
  'input_toggle_fullscreen',
  'input_save_state',
  'input_load_state',
  'input_state_slot_increase',
  'input_state_slot_decrease',
  'input_rewind',
  'input_hold_fast_forward',
  'input_toggle_fast_forward',
  'input_hold_slowmotion',
  'input_toggle_slowmotion',
  'input_screenshot',
  'input_pause_toggle',
  'input_frame_advance',
  'input_reset',
  'input_shader_next',
  'input_shader_prev',
  'input_cheat_index_plus',
  'input_cheat_index_minus',
  'input_cheat_toggle',
  'input_volume_up',
  'input_volume_down',
  'input_audio_mute',
  'input_osk_toggle',
  'input_fps_toggle',
  'input_movie_record_toggle',
  'input_disk_eject_toggle',
  'input_disk_next',
  'input_disk_prev',
  'input_grab_mouse_toggle',
  'input_game_focus_toggle',
  'input_desktop_menu_toggle',
  'input_netplay_game_watch',
  'input_ai_service',
  'input_overlay_next',
  'input_close_content',
  'input_send_debug_info',
  'input_statistics_toggle',
  'input_recording_toggle',
  'input_streaming_toggle',
  'input_runahead_toggle',
  'input_preempt_toggle',
  'input_vrr_runloop_toggle',
  'input_play_replay',
  'input_record_replay',
  'input_turbo_fire_toggle',
  'input_enable_hotkey',
];

/** W3C standard gamepad mapping -> RetroArch joypad button / axis binds. */
const STD_BTN: Partial<Record<string, number>> = { b: 0, a: 1, y: 2, x: 3, l: 4, r: 5, l2: 6, r2: 7, select: 8, start: 9, l3: 10, r3: 11, up: 12, down: 13, left: 14, right: 15 };
const STD_AXIS: Partial<Record<string, string>> = { l_x_minus: '-0', l_x_plus: '+0', l_y_minus: '-1', l_y_plus: '+1', r_x_minus: '-2', r_x_plus: '+2', r_y_minus: '-3', r_y_plus: '+3' };

const RETRO_DEVICE_NONE = 0;
const RETRO_DEVICE_JOYPAD = 1;
const RETRO_DEVICE_ANALOG = 5;
// PCSX-ReARMed's ANALOG subclasses: 0 = Dual Analog, 1 = DualShock, 2 = neGcon. DualShock-only
// games (Ape Escape) reject the Dual Analog, so use subclass 1: ((1 + 1) << 8) | 5
const PSX_DUALSHOCK = ((1 + 1) << 8) | RETRO_DEVICE_ANALOG;

// RetroArch ignores input_libretro_device_pN in retroarch.cfg: with no remap file loaded it resets
// every port to the plain pad at launch. The device types therefore also go into the core's remap
// file, which RetroArch auto-loads before it connects the ports.
const REMAP_DIR = '/home/web_user/retroarch/userdata/config/remaps';
const REMAP_FILE = `${REMAP_DIR}/PCSX-ReARMed/PCSX-ReARMed.rmp`;

export function buildRemapFile(cfg: Record<string, string | number | boolean>): string {
  const lines = Object.entries(cfg)
    .filter(([k]) => k.startsWith('input_libretro_device_p'))
    .map(([k, v]) => `${k} = "${v}"`);
  return lines.join('\n') + '\n';
}

export function buildRetroarchConfig(args: Pick<LaunchArgs, 'players' | 'prefs' | 'game'>): Record<string, string | number | boolean> {
  const { players, prefs, game } = args;
  const cfg: Record<string, string | number | boolean> = {
    log_verbosity: import.meta.env.DEV,
    frontend_log_level: 1,
    libretro_log_level: 1,
    video_vsync: true,
    video_smooth: prefs.filter === 'smooth',
    video_scale_integer: false,
    video_font_enable: false,
    video_shader_enable: false,
    audio_volume: volumeToDb(prefs.volume),
    audio_sync: true,
    savestate_thumbnail_enable: true,
    // Flush the memory card to the virtual filesystem periodically so a crash loses little.
    autosave_interval: 10,
    input_autodetect_enable: true,
    input_max_users: 8,
    menu_show_online_updater: false,
    quit_press_twice: false,
    notification_show_autoconfig: false,
    notification_show_remap_load: false,
    notification_show_config_override_load: false,
    notification_show_set_initial_disk: false,
    notification_show_fast_forward: false,
    notification_show_screenshot: false,
    notification_show_save_state: false,
    notification_show_when_menu_is_alive: false,
    video_message_bgcolor_enable: false,
    // Prevent RetroArch from remapping ports on hotplug; we pin ports explicitly below.
    input_remap_binds_enable: true,
    auto_remaps_enable: true,
    input_remapping_directory: REMAP_DIR,
  };
  for (const k of HOTKEYS_OFF) cfg[k] = 'nul';

  const padDevice = game.pad === 'analog' ? PSX_DUALSHOCK : RETRO_DEVICE_JOYPAD;
  const kbKeys = PSX_BUTTONS.map((b) => b.id);
  const keymap = prefs.keymap;
  const active = players.filter(Boolean);
  // Solo play with a local controller: port 1 also gets the keyboard binds, so the keyboard
  // works no matter which device happened to press Play.
  const soloKeyboard = active.length === 1 && active[0] !== 'kb' && !String(active[0]).startsWith('net:');

  for (let port = 1; port <= 8; port++) {
    const dev = players[port - 1] ?? null;
    if (!dev) {
      cfg[`input_libretro_device_p${port}`] = RETRO_DEVICE_NONE;
      cfg[`input_player${port}_joypad_index`] = 32 + port; // point at a pad that never exists
      for (const k of kbKeys) {
        cfg[`input_player${port}_${k}`] = 'nul';
        cfg[`input_player${port}_${k}_mbtn`] = 'nul';
      }
      continue;
    }
    cfg[`input_libretro_device_p${port}`] = padDevice;
    cfg[`input_player${port}_analog_dpad_mode`] = 1; // left stick doubles as d-pad
    if (dev === 'kb') {
      cfg[`input_player${port}_joypad_index`] = 32 + port;
      for (const k of kbKeys) {
        const v = keymap[k] || 'nul';
        if (isMouseBinding(v)) {
          cfg[`input_player${port}_${k}`] = 'nul';
          cfg[`input_player${port}_${k}_mbtn`] = Number(v.slice(6));
        } else {
          cfg[`input_player${port}_${k}`] = v;
          cfg[`input_player${port}_${k}_mbtn`] = 'nul';
        }
      }
    } else {
      // The web joypad driver reads gamepad slot N-1 for port N; the port map (virtual-pads.ts)
      // puts this device there, so the index is simply port-1. Binds are spelled out because
      // players 2+ have no defaults in this build.
      cfg[`input_player${port}_joypad_index`] = port - 1;
      for (const k of kbKeys) {
        const v = soloKeyboard && port === 1 ? keymap[k] || 'nul' : 'nul';
        if (isMouseBinding(v)) {
          cfg[`input_player${port}_${k}`] = 'nul';
          cfg[`input_player${port}_${k}_mbtn`] = Number(v.slice(6));
        } else {
          cfg[`input_player${port}_${k}`] = v;
          cfg[`input_player${port}_${k}_mbtn`] = 'nul';
        }
        cfg[`input_player${port}_${k}_btn`] = STD_BTN[k] ?? 'nul';
        cfg[`input_player${port}_${k}_axis`] = STD_AXIS[k] ?? 'nul';
      }
    }
  }
  // Dev-only escape hatch so the headless tests can prove RetroArch reads a given pad.
  if (import.meta.env.DEV) Object.assign(cfg, (window as unknown as { __wsxCfgOverride?: Record<string, string | number | boolean> }).__wsxCfgOverride ?? {});
  return cfg;
}

export function buildCoreConfig(args: Pick<LaunchArgs, 'players' | 'prefs' | 'game'>): Record<string, string> {
  const { players, prefs, game } = args;
  const { preset } = deviceGraphics();
  const count = players.filter(Boolean).length;
  const highest = players.reduce((m, d, i) => (d ? i + 1 : m), 0);
  const needsMultitap = Math.max(count, highest) > 2 && game.multitap !== 'none';
  return {
    pcsx_rearmed_bios: 'auto',
    pcsx_rearmed_show_bios_bootlogo: prefs.consoleBoot ? 'enabled' : 'disabled',
    pcsx_rearmed_multitap: needsMultitap ? (game.multitap === 'port2' ? 'port 2' : 'port 1') : 'disabled',
    pcsx_rearmed_memcard2: 'none',
    pcsx_rearmed_neon_enhancement_enable: preset.ps1Enhanced ? 'enabled' : 'disabled',
    pcsx_rearmed_neon_enhancement_no_main: 'disabled',
    pcsx_rearmed_dithering: preset.ps1Enhanced ? 'disabled' : 'enabled',
    pcsx_rearmed_frameskip_type: prefs.autoFrameskip || preset.ps1Frameskip ? 'auto' : 'disabled',
    pcsx_rearmed_duping_enable: 'enabled',
    pcsx_rearmed_display_fps_v2: 'disabled',
    pcsx_rearmed_vibration: 'enabled',
    pcsx_rearmed_analog_axis_modifier: 'circle',
    pcsx_rearmed_input_sensitivity: '1.00',
    pcsx_rearmed_spu_reverb: 'enabled',
    pcsx_rearmed_spu_interpolation: 'simple',
    pcsx_rearmed_gpu_thread_rendering: 'disabled',
    pcsx_rearmed_region: 'auto',
  };
}

function volumeToDb(v: number) {
  if (v <= 0) return -80;
  return Math.round(20 * Math.log10(v / 100) * 10) / 10;
}

export class EmuSession {
  private inst: Nostalgist | null = null;
  readonly game: GameMeta;
  private readonly onLog?: (l: string) => void;
  private aborted = false;
  private readonly holds = new Set<string>();

  constructor(game: GameMeta, onLog?: (l: string) => void) {
    this.game = game;
    this.onLog = onLog;
  }

  async launch(args: LaunchArgs) {
    await hardwareReady();
    const retroarchConfig = buildRetroarchConfig(args);
    const retroarchCoreConfig = buildCoreConfig(args);
    this.onLog?.(`ports: ${args.players.map((p, i) => `${i + 1}=${p ?? '-'}`).join(' ')} multitap=${retroarchCoreConfig.pcsx_rearmed_multitap}`);

    setPortMap(args.players);
    if (!args.disc) throw new Error('No disc');
    const rom = { fileName: `${args.game.id}.chd`, fileContent: args.disc };
    const bios = args.bios ? [{ fileName: 'scph1001.bin', fileContent: args.bios }] : [];

    this.inst = await Nostalgist.launch({
      element: args.canvas,
      core: {
        name: 'pcsx_rearmed',
        js: '/cores/pcsx_rearmed_libretro.js',
        wasm: '/cores/pcsx_rearmed_libretro.wasm',
      },
      rom,
      bios,
      sram: args.memcard ?? undefined,
      state: args.state ?? undefined,
      size: 'auto',
      // Keyboard events are read from the canvas only, so the shell can take the keyboard
      // back whenever the pause menu is open.
      respondToGlobalEvents: false,
      retroarchConfig: retroarchConfig as never,
      retroarchCoreConfig,
      beforeLaunch: (n) => {
        const fs = n.getEmscriptenFS() as { mkdirTree(p: string): void; writeFile(p: string, d: string): void };
        fs.mkdirTree(REMAP_FILE.slice(0, REMAP_FILE.lastIndexOf('/')));
        fs.writeFile(REMAP_FILE, buildRemapFile(retroarchConfig));
      },
      emscriptenModule: {
        print: (s: string) => this.onLog?.(s),
        printErr: (s: string) => this.onLog?.(s),
      } as never,
    });
    if (this.aborted) {
      this.exit();
      return;
    }
    if (this.holds.size) this.applyPause();
    args.canvas.focus();
  }

  get status() {
    const s = this.inst?.getStatus() ?? 'initial';
    return s === 'running' && this.holds.size > 0 ? 'paused' : s;
  }
  /** Raw Emscripten module (FS, HEAP...). Used by the headless tests to read retroarch.cfg. */
  get module(): unknown {
    return this.inst?.getEmscriptenModule() ?? null;
  }
  get running() {
    return this.status === 'running';
  }

  /**
   * Pausing is reference counted by reason ('menu', 'hidden', ...): the game runs only while
   * nothing holds it. Nostalgist's pause()/resume() send a *toggle* to RetroArch and guess the
   * resulting state, so a quick open/close of the menu or a focus change at the wrong moment
   * could leave the core paused while the UI thought it was running (a "frozen" game). The core
   * exports idempotent pause/unpause commands, so we always send the state we want.
   */
  hold(reason: string) {
    this.holds.add(reason);
    this.applyPause();
  }
  release(reason: string) {
    if (!this.holds.delete(reason)) return;
    this.applyPause();
    if (this.holds.size === 0) this.inst?.getCanvas().focus();
  }
  isHeld(reason: string) {
    return this.holds.has(reason);
  }
  private applyPause() {
    if (!this.inst || this.inst.getStatus() === 'terminated') return;
    const m = this.inst.getEmscriptenModule() as { _cmd_pause?: () => void; _cmd_unpause?: () => void };
    const paused = this.holds.size > 0;
    try {
      if (m._cmd_pause && m._cmd_unpause) (paused ? m._cmd_pause : m._cmd_unpause)();
      else if (paused) this.inst.pause();
      else this.inst.resume();
    } catch (e) {
      this.onLog?.(`pause command failed: ${e}`);
    }
  }
  restart() {
    this.inst?.restart();
    this.applyPause(); // a reset must not un-pause a game whose menu is still open
  }
  async saveState() {
    if (!this.inst) throw new Error('not running');
    return this.inst.saveState();
  }
  async loadState(blob: Blob) {
    if (!this.inst) throw new Error('not running');
    await this.inst.loadState(blob);
  }
  async saveMemcard(): Promise<Blob | null> {
    if (!this.inst) return null;
    try {
      const blob = await withTimeout(this.inst.saveSRAM(), 4000);
      return blob.size > 0 ? blob : null;
    } catch {
      return null;
    }
  }
  async screenshot() {
    return this.inst?.screenshot();
  }
  resize(w: number, h: number) {
    this.inst?.resize({ width: w, height: h });
  }
  exit() {
    this.aborted = true;
    clearPortMap();
    try {
      this.inst?.exit({ removeCanvas: false });
    } catch {
      /* already gone */
    }
    this.inst = null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms);
    p.then((v) => (clearTimeout(t), res(v)), (e) => (clearTimeout(t), rej(e)));
  });
}
