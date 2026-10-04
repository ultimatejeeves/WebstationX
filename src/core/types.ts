import { DEFAULT_KEYMAP, type Keymap } from '../emu/keymap';

export type GameMeta = {
  id: string;
  title: string;
  /** Console the disc belongs to (absent = 'ps1'). PS2 games run on the Play! core. */
  system?: 'ps1' | 'ps2';
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
  /** When the game was ingested (ISO date). */
  addedAt?: string;
  /** How heavy the game is to emulate (PS2; absent = 'medium'). Feeds the device check. */
  demand?: 'light' | 'medium' | 'heavy';
  /** Known emulation state from our own testing, shown to every device. */
  compat?: { status: 'ok' | 'issues' | 'broken'; note?: string };
  discUrl: string;
  files?: { name: string; url: string }[];
  coverUrl: string | null;
  /** Scraped game art (URLs), present only for the pieces that exist. `accent` is a '#rrggbb' colour. */
  art?: {
    box?: string;
    back?: string;
    disc?: string;
    logo?: string;
    title?: string;
    snap?: string;
    fanart?: string;
    video?: string;
    accent?: string;
  };
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
  /** Let the core skip frames to keep audio smooth on slow machines. */
  autoFrameskip: boolean;
  /** Show the real console boot sequence before the game. */
  consoleBoot: boolean;
  /** Master volume 0..100 for the game. */
  volume: number;
  /** UI sound effects on/off. */
  uiSounds: boolean;
  /** Ambient menu music volume 0..100 (0 = off). */
  musicVolume: number;
  /** Remember the last game and offer to resume it on the library screen. */
  quickResume: boolean;
  /** Keyboard & mouse bindings for the keyboard player. */
  keymap: Keymap;
};

export const DEFAULT_PREFS: Prefs = {
  filter: 'crt',
  aspect: '4:3',
  autoFrameskip: false,
  consoleBoot: false,
  volume: 80,
  uiSounds: true,
  musicVolume: 50,
  quickResume: true,
  keymap: { ...DEFAULT_KEYMAP },
};

export type SaveSummary = {
  memcard: { updatedAt: string; size: number } | null;
  slots: { slot: string; updatedAt: string; size: number; thumbnail: string | null; label?: string }[];
};

/**
 * An input device that can occupy a player slot: the keyboard, a local gamepad by Gamepad
 * API index, or a remote player's device (`net:<peer>:<ord>`, see net/protocol.ts).
 */
export type DeviceId = 'kb' | `gp:${number}` | `net:${string}`;

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
  | 'alt'
  | 'start'
  | 'prev'
  | 'next'
  | 'any';

export type NavEvent = { action: NavAction; device: DeviceId; repeat: boolean; raw?: string };
