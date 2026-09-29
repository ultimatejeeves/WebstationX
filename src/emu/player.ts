/**
 * Emulator session: wraps Nostalgist.js driving the PCSX-ReARMed libretro core (WebAssembly).
 *
 * The important design point is input routing. Every player slot chosen in the lobby is
 * pinned to a RetroArch port: gamepads by their Gamepad API index, the keyboard by giving
 * that port the keyboard binds and every other port `nul`. With 3-4 players the core's
 * multitap is switched on so the game sees a real 4-controller setup.
 */
import { Nostalgist } from 'nostalgist';
import type { DeviceId, GameMeta, Prefs } from '../core/types';
import { isMouseBinding, PSX_BUTTONS } from './keymap';
import { padIndexFor } from './virtual-pads';

export type SessionPlayers = (DeviceId | null)[]; // index = PSX player 0..3

export type LaunchArgs = {
  game: GameMeta;
  disc: Blob;
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

const RETRO_DEVICE_NONE = 0;
const RETRO_DEVICE_JOYPAD = 1;
const RETRO_DEVICE_ANALOG = 5;
// PCSX-ReARMed's DualShock is subclass 0 of ANALOG: ((0 + 1) << 8) | 5
const PSX_DUALSHOCK = ((0 + 1) << 8) | RETRO_DEVICE_ANALOG;

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
  };
  for (const k of HOTKEYS_OFF) cfg[k] = 'nul';

  const padDevice = game.pad === 'analog' ? PSX_DUALSHOCK : RETRO_DEVICE_JOYPAD;
  const kbKeys = PSX_BUTTONS.map((b) => b.id);
  const keymap = prefs.keymap;

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
      // Local pads by Gamepad API index; remote players by their virtual pad's index.
      cfg[`input_player${port}_joypad_index`] = dev.startsWith('net:') ? (padIndexFor(dev) ?? 32 + port) : Number(dev.slice(3));
      for (const k of kbKeys) {
        cfg[`input_player${port}_${k}`] = 'nul';
        cfg[`input_player${port}_${k}_mbtn`] = 'nul';
      }
    }
  }
  // Dev-only escape hatch so the headless tests can prove RetroArch reads a given pad.
  if (import.meta.env.DEV) Object.assign(cfg, (window as unknown as { __wsxCfgOverride?: Record<string, string | number | boolean> }).__wsxCfgOverride ?? {});
  return cfg;
}

export function buildCoreConfig(args: Pick<LaunchArgs, 'players' | 'prefs' | 'game'>): Record<string, string> {
  const { players, prefs, game } = args;
  const count = players.filter(Boolean).length;
  const highest = players.reduce((m, d, i) => (d ? i + 1 : m), 0);
  const needsMultitap = Math.max(count, highest) > 2 && game.multitap !== 'none';
  return {
    pcsx_rearmed_bios: 'auto',
    pcsx_rearmed_show_bios_bootlogo: prefs.consoleBoot ? 'enabled' : 'disabled',
    pcsx_rearmed_multitap: needsMultitap ? (game.multitap === 'port2' ? 'port 2' : 'port 1') : 'disabled',
    pcsx_rearmed_memcard2: 'none',
    pcsx_rearmed_neon_enhancement_enable: prefs.enhanced ? 'enabled' : 'disabled',
    pcsx_rearmed_neon_enhancement_no_main: 'disabled',
    pcsx_rearmed_dithering: prefs.enhanced ? 'disabled' : 'enabled',
    pcsx_rearmed_frameskip_type: prefs.autoFrameskip ? 'auto' : 'disabled',
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

  constructor(game: GameMeta, onLog?: (l: string) => void) {
    this.game = game;
    this.onLog = onLog;
  }

  async launch(args: LaunchArgs) {
    const retroarchConfig = buildRetroarchConfig(args);
    const retroarchCoreConfig = buildCoreConfig(args);
    this.onLog?.(`ports: ${args.players.map((p, i) => `${i + 1}=${p ?? '-'}`).join(' ')} multitap=${retroarchCoreConfig.pcsx_rearmed_multitap}`);

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
      emscriptenModule: {
        print: (s: string) => this.onLog?.(s),
        printErr: (s: string) => this.onLog?.(s),
      } as never,
    });
    if (this.aborted) {
      this.exit();
      return;
    }
    args.canvas.focus();
  }

  get status() {
    return this.inst?.getStatus() ?? 'initial';
  }
  /** Raw Emscripten module (FS, HEAP...). Used by the headless tests to read retroarch.cfg. */
  get module(): unknown {
    return this.inst?.getEmscriptenModule() ?? null;
  }
  get running() {
    return this.status === 'running';
  }

  pause() {
    this.inst?.pause();
  }
  resume() {
    this.inst?.resume();
    this.inst?.getCanvas().focus();
  }
  restart() {
    this.inst?.restart();
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
