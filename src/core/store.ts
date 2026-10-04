/**
 * Session state: the active profile, its preferences, and the catalog.
 * Preferences live on the server profile and are mirrored to localStorage so the UI
 * feels instant and still works when the server is briefly unreachable.
 */
import { api, type SessionState } from './api';
import { sfx } from './sfx';
import { music } from './music';
import { normalizeKeymap } from '../emu/keymap';
import { DEFAULT_PREFS, type Catalog, type GameMeta, type Prefs, type Profile } from './types';

const LS_PROFILE = 'wsx.profile';
const LS_PREFS = 'wsx.prefs.';
const LS_LAST = 'wsx.lastGame.';
const LS_BOOTED = 'wsx.booted';
const LS_STATS = 'wsx.stats.';
const LS_FAVS = 'wsx.favs.';
const LS_VIEW = 'wsx.libview.';

/** When a game was last played on this browser and for how long in total. */
export type PlayStats = { last: number; secs: number };

/** How the library shelf is filtered and ordered (remembered per profile on this browser). */
export type LibraryView = {
  system: 'all' | 'ps1' | 'ps2';
  /** Minimum player count: 0 = any. */
  players: 0 | 2 | 3;
  sort: 'title' | 'recent' | 'year' | 'added';
  favOnly: boolean;
};
export const DEFAULT_VIEW: LibraryView = { system: 'all', players: 0, sort: 'title', favOnly: false };

function readLocal<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? 'null') as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}

type Listener = () => void;

class Store {
  catalog: Catalog = { games: [], bios: null };
  /** Who is signed in (invite name) and the ICE servers for online play. */
  session: SessionState = { signedIn: false, name: null, owner: false, gated: false, ice: [] };
  profile: Profile | null = null;
  prefs: Prefs = { ...DEFAULT_PREFS };
  private listeners = new Set<Listener>();

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private notify() {
    for (const l of this.listeners) l();
  }

  async loadCatalog() {
    this.catalog = await api.catalog();
    this.notify();
    return this.catalog;
  }

  game(id: string): GameMeta | undefined {
    return this.catalog.games.find((g) => g.id === id);
  }

  /** Try to restore the profile used last time on this browser. */
  async restoreProfile(): Promise<Profile | null> {
    const id = localStorage.getItem(LS_PROFILE);
    if (!id) return null;
    try {
      const all = await api.profiles();
      const p = all.find((x) => x.id === id) ?? null;
      if (p) this.setProfile(p, false);
      else localStorage.removeItem(LS_PROFILE);
      return p;
    } catch {
      return null;
    }
  }

  setProfile(p: Profile | null, remember = true) {
    this.profile = p;
    if (p) {
      if (remember) localStorage.setItem(LS_PROFILE, p.id);
      const cached = localStorage.getItem(LS_PREFS + p.id);
      this.prefs = { ...DEFAULT_PREFS, ...(cached ? JSON.parse(cached) : {}), ...p.prefs };
      this.prefs.keymap = normalizeKeymap(this.prefs.keymap);
      localStorage.setItem(LS_PREFS + p.id, JSON.stringify(this.prefs));
      api.updateProfile(p.id, {}).catch(() => {}); // bump lastSeen
    } else {
      localStorage.removeItem(LS_PROFILE);
      this.prefs = { ...DEFAULT_PREFS };
    }
    sfx.setEnabled(this.prefs.uiSounds);
    music.setVolume(this.prefs.musicVolume);
    this.notify();
  }

  async setPrefs(patch: Partial<Prefs>) {
    this.prefs = { ...this.prefs, ...patch };
    this.prefs.keymap = normalizeKeymap(this.prefs.keymap);
    sfx.setEnabled(this.prefs.uiSounds);
    music.setVolume(this.prefs.musicVolume);
    if (this.profile) {
      localStorage.setItem(LS_PREFS + this.profile.id, JSON.stringify(this.prefs));
      api.updateProfile(this.profile.id, { prefs: patch }).catch(() => {});
    }
    this.notify();
  }

  get lastGameId(): string | null {
    return this.profile ? localStorage.getItem(LS_LAST + this.profile.id) : null;
  }
  set lastGameId(id: string | null) {
    if (!this.profile) return;
    if (id) localStorage.setItem(LS_LAST + this.profile.id, id);
    else localStorage.removeItem(LS_LAST + this.profile.id);
  }

  /* ---------- Per-profile library extras (this browser only) ---------- */

  private get pid() {
    return this.profile?.id ?? 'guest';
  }

  get playStats(): Record<string, PlayStats> {
    return readLocal<Record<string, PlayStats>>(LS_STATS + this.pid, {});
  }

  /** Adds play time to a game and stamps it as played now. */
  addPlayTime(gameId: string, secs: number) {
    const all = this.playStats;
    all[gameId] = { last: Date.now(), secs: (all[gameId]?.secs ?? 0) + secs };
    localStorage.setItem(LS_STATS + this.pid, JSON.stringify(all));
  }

  get favorites(): string[] {
    return readLocal<string[]>(LS_FAVS + this.pid, []);
  }

  /** Returns whether the game is a favourite afterwards. */
  toggleFavorite(gameId: string): boolean {
    const favs = this.favorites;
    const on = !favs.includes(gameId);
    localStorage.setItem(LS_FAVS + this.pid, JSON.stringify(on ? [...favs, gameId] : favs.filter((f) => f !== gameId)));
    return on;
  }

  get libraryView(): LibraryView {
    return { ...DEFAULT_VIEW, ...readLocal<Partial<LibraryView>>(LS_VIEW + this.pid, {}) };
  }
  set libraryView(v: LibraryView) {
    localStorage.setItem(LS_VIEW + this.pid, JSON.stringify(v));
  }

  /** The boot animation plays once per browser session. */
  get bootedThisSession() {
    return sessionStorage.getItem(LS_BOOTED) === '1';
  }
  set bootedThisSession(v: boolean) {
    if (v) sessionStorage.setItem(LS_BOOTED, '1');
    else sessionStorage.removeItem(LS_BOOTED);
  }
}

export const store = new Store();

export function avatarUrl(avatar: string) {
  return `/assets/${avatar}.png`;
}
