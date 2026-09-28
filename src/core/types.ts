import { DEFAULT_KEYMAP, type Keymap } from '../emu/keymap';

export type GameMeta = {
  id: string;
  title: string;
  players: number;
  year?: number;
  publisher?: string;
  genre?: string;
  blurb?: string;
  multitap: 'port1' | 'port2' | 'none';
  pad: 'standard' | 'analog';
  disc: string;
  cover: string;
  size?: number;
  discUrl: string;
  coverUrl: string | null;
};

export type Catalog = { games: GameMeta[]; bios: string | null };

export type Profile = {
  id: string;
  name: string;
  avatar: string;
  createdAt: string;
  lastSeenAt: string;
  prefs: Partial<Prefs>;
};

/** Player preferences. Stored on the profile (server) and mirrored to localStorage. */
export type Prefs = {
  /** Rendering filter for the game picture. */
  filter: 'crt' | 'sharp' | 'smooth';
  /** Force 4:3 (authentic) or stretch to fill. */
  aspect: '4:3' | 'fill';
  /** Render internal resolution at 2x where the machine can afford it. */
  enhanced: boolean;
  /** Let the core skip frames to keep audio smooth on slow machines. */
  autoFrameskip: boolean;
  /** Show the real console boot sequence before the game. */
  consoleBoot: boolean;
  /** Master volume 0..100 for the game. */
  volume: number;
  /** UI sound effects on/off. */
  uiSounds: boolean;
  /** Remember the last game and offer to resume it on the library screen. */
  quickResume: boolean;
  /** Keyboard & mouse bindings for the keyboard player. */
  keymap: Keymap;
};

export const DEFAULT_PREFS: Prefs = {
  filter: 'crt',
  aspect: '4:3',
  enhanced: autoEnhanced(),
  autoFrameskip: false,
  consoleBoot: false,
  volume: 80,
  uiSounds: true,
  quickResume: true,
  keymap: { ...DEFAULT_KEYMAP },
};

/** Pick a sane default for the 2x-resolution enhancement based on the machine we run on. */
function autoEnhanced(): boolean {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 2 : 2;
  const mobile = typeof navigator !== 'undefined' && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  return !mobile && cores >= 6;
}

export type SaveSummary = {
  memcard: { updatedAt: string; size: number } | null;
  slots: { slot: string; updatedAt: string; size: number; thumbnail: string | null; label?: string }[];
};

/** An input device that can occupy a player slot. */
export type DeviceId = 'kb' | `gp:${number}`;

export type PlayerSlot = {
  index: number; // 0..3
  device: DeviceId | null;
  label: string; // "Keyboard" or gamepad id
};

export type NavAction =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'confirm'
  | 'back'
  | 'menu'
  | 'start'
  | 'prev'
  | 'next'
  | 'any';

export type NavEvent = { action: NavAction; device: DeviceId; repeat: boolean; raw?: string };
