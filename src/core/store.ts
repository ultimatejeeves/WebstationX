/**
 * Session state: the active profile, its preferences, and the catalog.
 * Preferences live on the server profile and are mirrored to localStorage so the UI
 * feels instant and still works when the server is briefly unreachable.
 */
import { api, type SessionState } from './api';
import { sfx } from './sfx';
import { normalizeKeymap } from '../emu/keymap';
import { DEFAULT_PREFS, type Catalog, type GameMeta, type Prefs, type Profile } from './types';

const LS_PROFILE = 'wsx.profile';
const LS_PREFS = 'wsx.prefs.';
const LS_LAST = 'wsx.lastGame.';
const LS_BOOTED = 'wsx.booted';

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
    this.notify();
  }

  async setPrefs(patch: Partial<Prefs>) {
    this.prefs = { ...this.prefs, ...patch };
    this.prefs.keymap = normalizeKeymap(this.prefs.keymap);
    sfx.setEnabled(this.prefs.uiSounds);
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
