/**
 * Play screen: loads the disc (from cache when possible), runs the emulator, and hosts the
 * pause menu. On quit it suspends the game (save state + memory card) so "Continue" works.
 */
import { api } from '../core/api';
import { app, type Screen } from '../core/app';
import { recordPerf } from '../core/compat';
import { clear, fmtWhen, h, icon } from '../core/dom';
import { deviceLabel, input } from '../core/input';
import { sfx } from '../core/sfx';
import { store } from '../core/store';
import type { GameMeta, NavEvent, SaveSummary } from '../core/types';
import { fetchCached } from '../emu/disc-cache';
import { keymapHints } from '../emu/keymap';
import { setStreamingKeepAlive } from '../emu/keepalive';
import { EmuSession, type SessionPlayers } from '../emu/player';
import { Ps2Session } from '../emu/ps2-session';
import { online } from '../net/online';
import { isNetDevice } from '../net/protocol';
import { openKeybindDialog } from '../ui/keybind-dialog';
import { button, confirmDialog, Dialog, touchMenuButton } from '../ui/components';
import { openSettings } from './settings';

const MEMCARD_FLUSH_MS = 30_000;
const MAX_SAVES = 8;
/** Play time is counted in steps of this many seconds while the game is actually running. */
const PLAY_CLOCK_SECS = 15;

export class PlayScreen implements Screen {
  name = 'play';
  readonly ambient = 'off' as const;
  el: HTMLElement;
  private game: GameMeta;
  private players: SessionPlayers;
  private resumeSlot: string | null;
  private onQuit: () => void;
  private onChangePlayers: () => void;
  private onRelaunch: () => void;
  private session: EmuSession | Ps2Session;
  private canvasWrap: HTMLElement;
  private canvas: HTMLCanvasElement;
  private loader: HTMLElement;
  private loaderBar: HTMLElement;
  private loaderText: HTMLElement;
  private menu: Dialog | null = null;
  private flushTimer = 0;
  private playClock = 0;
  private lastMemcardHash = '';
  private quitting = false;
  private ready = false;
  private log: string[] = [];
  private unsubs: (() => void)[] = [];
  private streaming = false;
  private audioRetry = 0;
  /** Set once a quit / player change / relaunch starts; the menu no longer resumes the game. */
  private leaving = false;
  /** Keys currently held on the game canvas, released by hand if focus leaves mid-press. */
  private keysDown = new Map<string, string>();

  constructor(
    game: GameMeta,
    players: SessionPlayers,
    resumeSlot: string | null,
    onQuit: () => void,
    onChangePlayers: () => void,
    onRelaunch: () => void,
  ) {
    this.game = game;
    this.players = players;
    this.resumeSlot = resumeSlot;
    this.onQuit = onQuit;
    this.onChangePlayers = onChangePlayers;
    this.onRelaunch = onRelaunch;
    this.session = game.system === 'ps2' ? new Ps2Session(game, (l) => this.pushLog(l)) : new EmuSession(game, (l) => this.pushLog(l));
    if (this.session instanceof Ps2Session) this.session.onProblem = (message) => app.toast(message, 'warn', 8000);
    this.canvas = h('canvas.game-canvas', { tabindex: 0 }) as HTMLCanvasElement;
    this.canvasWrap = h('div.canvas-wrap', this.canvas, h('div.crt-overlay'));
    this.loaderBar = h('div.loader-bar', h('div.loader-fill'));
    this.loaderText = h('div.loader-text', 'Preparing');
    this.loader = h(
      'div.loader',
      h('div.loader-disc', h('img', { src: '/assets/hero-disc.png', alt: '' })),
      h(
        'div.loader-panel',
        game.coverUrl ? h('img.loader-cover', { src: game.coverUrl, alt: '' }) : null,
        h('div.loader-title', game.title),
        h(
          'div.loader-players',
          players.map((p, i) => (p ? h(`span.pill.p${i + 1}`, `P${i + 1} · ${deviceLabel(p)}`) : null)),
        ),
        this.loaderBar,
        this.loaderText,
      ),
    );
    this.el = h('div.play', h('div.bg-play'), this.canvasWrap, this.loader, touchMenuButton());
  }

  async mount() {
    this.applyPictureSettings();
    this.unsubs.push(store.subscribe(() => this.applyPictureSettings()));
    window.addEventListener('resize', this.fitCanvas);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('beforeunload', this.onBeforeUnload);
    window.addEventListener('blur', this.onWindowBlur);
    window.addEventListener('focus', this.onWindowFocus);
    this.canvas.addEventListener('keydown', this.onCanvasKey);
    this.canvas.addEventListener('keyup', this.onCanvasKey);
    this.canvas.addEventListener('blur', this.releaseKeys);
    this.fitCanvas();
    try {
      await this.load();
    } catch (err) {
      console.error(err);
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  unmount() {
    this.quitting = true;
    clearInterval(this.flushTimer);
    clearInterval(this.playClock);
    clearInterval(this.audioRetry);
    // How the game ran here feeds the library's device check next time.
    if (this.session instanceof Ps2Session && this.session.perf) recordPerf(this.game.id, this.session.perf);
    this.stopStreaming();
    window.removeEventListener('resize', this.fitCanvas);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    window.removeEventListener('blur', this.onWindowBlur);
    window.removeEventListener('focus', this.onWindowFocus);
    for (const u of this.unsubs) u();
    input.suspended = false;
    this.session.exit();
  }

  /* ---------- Loading ---------- */

  private progress(text: string, frac: number) {
    this.loaderText.textContent = text;
    (this.loaderBar.firstElementChild as HTMLElement).style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
  }

  private async load() {
    const pid = store.profile?.id;
    const bios = store.catalog.bios;
    const ps2 = this.game.system === 'ps2';

    let disc: Blob | null = null;
    let biosBlob: Blob | null = null;
    if (ps2) {
      // PS2 discs are gigabytes: the session streams them from the server as the game reads.
      this.progress('Spinning up the disc', 0.3);
    } else {
      this.progress('Reading disc', 0);
      disc = await fetchCached(this.game.discUrl, (l, t) => this.progress(l < t ? `Downloading disc · ${Math.round((l / t) * 100)}%` : 'Disc ready', (l / t) * 0.8));
      if (bios) {
        this.progress('Loading system', 0.82);
        biosBlob = await fetchCached(bios);
      }
    }
    let memcard: Blob | null = null;
    let state: Blob | null = null;
    if (pid) {
      this.progress('Inserting memory card', 0.86);
      memcard = await api.memcard(pid, this.game.id).catch(() => null);
      if (this.resumeSlot) {
        this.progress('Restoring your game', 0.9);
        state = await api.state(pid, this.game.id, this.resumeSlot).catch(() => null);
      }
    }
    if (memcard) this.lastMemcardHash = await hashBlob(memcard);
    if (this.quitting) return;

    this.progress('Starting', 0.95);
    input.suspended = true;
    await this.session.launch({
      game: this.game,
      disc,
      bios: biosBlob,
      players: this.players,
      prefs: store.prefs,
      memcard,
      state,
      canvas: this.canvas,
    });
    if (this.quitting) return;
    this.ready = true;
    (window as unknown as { __wsx: unknown }).__wsx = { session: this.session, screen: this };
    this.progress('Go!', 1);
    store.lastGameId = this.game.id;
    this.startStreaming();
    setTimeout(() => this.loader.classList.add('hide'), 250);
    this.fitCanvas();
    this.canvas.focus();
    this.flushTimer = window.setInterval(() => void this.flushMemcard(), MEMCARD_FLUSH_MS);
    store.addPlayTime(this.game.id, 0);
    this.playClock = window.setInterval(() => {
      if (!this.menu && !this.leaving && !document.hidden) store.addPlayTime(this.game.id, PLAY_CLOCK_SECS);
    }, PLAY_CLOCK_SECS * 1000);
    if (state) app.toast('Game restored', 'ok');
    app.toast(matchMedia('(pointer: coarse)').matches ? 'Select+Start or the corner button opens the menu' : 'Esc or Select+Start opens the menu', 'info', 3500);
  }

  /* ---------- Online (host) ---------- */

  private get host() {
    return online.host;
  }

  /** Stream the canvas + audio to remote players whenever any port is held by one. */
  private startStreaming() {
    const host = this.host;
    if (!host || !this.players.some(isNetDevice)) {
      host?.setPhase('playing');
      return;
    }
    host.startStreaming(this.canvas);
    host.setPhase('playing');
    host.onLeave = (dev) => app.toast(`${deviceLabel(dev)} left the game`, 'info', 2000);
    host.onJoin = null;
    host.onSwap = null;
    this.streaming = true;
    setStreamingKeepAlive(true);
    // The core's audio context appears a moment after launch; attach it when it does.
    this.audioRetry = window.setInterval(() => host.refreshAudio(), 500);
    setTimeout(() => clearInterval(this.audioRetry), 15_000);
  }

  private stopStreaming() {
    if (!this.streaming) return;
    this.streaming = false;
    setStreamingKeepAlive(false);
    this.host?.stopStreaming();
    if (this.host) this.host.onLeave = null;
  }

  private fail(msg: string) {
    input.suspended = false;
    this.loader.classList.remove('hide');
    this.progress('Something went wrong', 0);
    const dlg = new Dialog({
      title: 'Could not start the game',
      body: h('div', h('p', msg), h('pre.log', this.log.slice(-12).join('\n'))),
      actions: [{ label: 'Back to library', icon: 'home', variant: 'primary', focusDefault: true, onClick: () => (dlg.close(), this.onQuit()) }],
      onCancel: () => (dlg.close(), this.onQuit()),
    });
    dlg.open();
  }

  private pushLog(l: string) {
    this.log.push(l);
    if (this.log.length > 200) this.log.shift();
    if (import.meta.env.DEV) console.debug('[core]', l);
  }

  /* ---------- Picture ---------- */

  private applyPictureSettings() {
    const { filter, aspect } = store.prefs;
    this.el.dataset.filter = filter;
    this.el.dataset.aspect = aspect;
    this.fitCanvas();
  }

  private fitCanvas = () => {
    // Use the viewport, not the element rect: screen transitions scale the element briefly.
    const fill = store.prefs.aspect === 'fill';
    let w = window.innerWidth;
    let hgt = window.innerHeight;
    if (!fill) {
      if (w / hgt > 4 / 3) w = hgt * (4 / 3);
      else hgt = w * (3 / 4);
    }
    this.canvasWrap.style.width = `${Math.floor(w)}px`;
    this.canvasWrap.style.height = `${Math.floor(hgt)}px`;
    // While hosting online, keep the canvas at 1x: every extra pixel is captured and encoded
    // for each remote player, and PS1 output is upscaled anyway.
    const dpr = this.host ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    const pw = Math.floor(w * dpr);
    const ph = Math.floor(hgt * dpr);
    if (this.ready) this.session.resize(pw, ph);
    else {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
  };

  /* ---------- Saving ---------- */

  private async flushMemcard(force = false): Promise<boolean> {
    const pid = store.profile?.id;
    if (!pid || !this.ready) return false;
    const blob = await this.session.saveMemcard();
    if (!blob) return false;
    const hash = await hashBlob(blob);
    if (!force && hash === this.lastMemcardHash) return false;
    this.lastMemcardHash = hash;
    await api.putMemcard(pid, this.game.id, blob);
    return true;
  }

  private async saveSlot(slot: string, label: string) {
    const pid = store.profile?.id;
    if (!pid) throw new Error('No profile');
    const { state, thumbnail } = await this.session.saveState();
    await api.putState(pid, this.game.id, slot, state, thumbnail, label);
    await this.flushMemcard();
  }

  private async pruneSaves(summary: SaveSummary) {
    const pid = store.profile?.id;
    if (!pid) return;
    const manual = summary.slots.filter((s) => s.slot !== 'suspend');
    for (const s of manual.slice(MAX_SAVES)) await api.deleteState(pid, this.game.id, s.slot);
  }

  /* ---------- Pause menu ---------- */

  private openMenu() {
    if (!this.ready || this.menu || this.leaving) return;
    this.session.hold('menu');
    this.host?.setPhase('paused');
    input.suspended = false;
    const onlineLine = this.host
      ? h('div.pause-online', icon('globe'), h('span', 'Online code ', h('b', this.host.code)), h('span.pause-online-stats', ''))
      : null;
    if (onlineLine && this.streaming) {
      const statsEl = onlineLine.querySelector('.pause-online-stats')!;
      void this.host!.stats().then((rows) => {
        statsEl.textContent = rows.length
          ? rows
              .map(
                (r) =>
                  `${r.name}: ${r.state}${r.rttMs !== null ? ` · ${r.rttMs} ms` : ''}${r.fps ? ` · ${Math.round(r.fps)} fps` : ''}${r.kbps ? ` · ${(r.kbps / 1000).toFixed(1)} Mbps` : ''}`,
              )
              .join('   ')
          : 'No remote players connected';
      });
    }
    const body = h(
      'div.pause-body',
      h(
        'div.pause-players',
        this.players.map((p, i) => (p ? h(`span.pill.p${i + 1}`, icon(p === 'kb' ? 'keyboard' : isNetDevice(p) ? 'globe' : 'pad'), `P${i + 1} ${deviceLabel(p)}`) : null)),
      ),
      onlineLine,
    );
    const dlg: Dialog = new Dialog({
      title: this.game.title,
      body,
      actions: [
        { label: 'Resume', icon: 'play', variant: 'primary', focusDefault: true, onClick: () => this.closeMenu() },
        { label: 'Save progress', icon: 'save', onClick: () => void this.quickSave() },
        { label: 'Load progress', icon: 'load', onClick: () => void this.loadMenu() },
        { label: 'Settings', icon: 'gear', onClick: () => openSettings({ inGame: true }) },
        { label: 'Controls', icon: 'pad', onClick: () => this.controlsDialog() },
        { label: 'Restart game', icon: 'restart', onClick: () => void this.restart() },
        { label: 'Change players', icon: 'users', onClick: () => void this.changePlayers() },
        { label: 'Quit to library', icon: 'home', variant: 'danger', onClick: () => void this.quit() },
      ],
      onCancel: () => dlg.close(),
      // The menu key (Esc is Back here) toggles the menu shut again.
      onNav: (e): boolean => {
        if (e.action !== 'menu') return false;
        dlg.close();
        return true;
      },
      onClose: () => this.onMenuClosed(dlg),
    });
    dlg.el.classList.add('pause-menu');
    this.menu = dlg;
    dlg.open();
  }

  private closeMenu() {
    this.menu?.close();
  }

  /** The game resumes whenever the pause menu goes away, whatever closed it. */
  private onMenuClosed(dlg: Dialog) {
    if (this.menu !== dlg) return;
    this.menu = null;
    app.closeAllModals(); // sub-dialogs (settings, controls, load) go with it
    if (this.leaving || this.quitting) return;
    input.suspended = true;
    this.session.release('menu');
    this.host?.setPhase('playing');
    sfx.close();
  }

  private async quickSave() {
    try {
      const slot = `s${Date.now().toString(36)}`;
      await this.saveSlot(slot, `Saved ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
      const summary = await api.saves(store.profile!.id, this.game.id);
      await this.pruneSaves(summary);
      sfx.saved();
      app.toast('Progress saved', 'ok');
      this.closeMenu();
    } catch (e) {
      app.toast(`Save failed: ${e instanceof Error ? e.message : e}`, 'warn');
    }
  }

  private async loadMenu() {
    const pid = store.profile?.id;
    if (!pid) return;
    const summary = await api.saves(pid, this.game.id);
    if (summary.slots.length === 0) return app.toast('No saved progress yet', 'info');
    const list = h('div.save-list', { 'data-scroll': 'y' });
    const render = () => {
      clear(list);
      for (const s of summary.slots) {
        list.appendChild(
          h(
            'div.save-row',
            h(
              'button.save-item',
              {
                type: 'button',
                'data-focus': true,
                tabindex: -1,
                onClick: async () => {
                  try {
                    const blob = await api.state(pid, this.game.id, s.slot);
                    if (!blob) throw new Error('missing');
                    await this.session.loadState(blob);
                    dlg.close();
                    sfx.saved();
                    app.toast('Progress loaded', 'ok');
                    this.closeMenu();
                  } catch {
                    app.toast('Could not load that save', 'warn');
                  }
                },
              },
              s.thumbnail ? h('img.save-thumb', { src: s.thumbnail, alt: '' }) : h('div.save-thumb.empty', icon('save')),
              h('div.save-text', h('b', s.label ?? (s.slot === 'suspend' ? 'Suspended game' : 'Save')), h('span', fmtWhen(s.updatedAt))),
            ),
            h(
              'button.save-delete',
              {
                type: 'button',
                'data-focus': true,
                tabindex: -1,
                title: 'Delete',
                onClick: async () => {
                  await api.deleteState(pid, this.game.id, s.slot);
                  summary.slots = summary.slots.filter((x) => x !== s);
                  render();
                  dlg.ring.revalidate();
                },
              },
              icon('trash'),
            ),
          ),
        );
      }
    };
    render();
    const dlg = new Dialog({ title: 'Load progress', wide: true, body: list, actions: [{ label: 'Back', onClick: () => dlg.close() }] });
    dlg.open();
  }

  private controlsDialog() {
    const hasKeyboard = this.players.includes('kb');
    const keyGrid = h('div.keyhelp-grid');
    const renderKeys = () =>
      keyGrid.replaceChildren(...keymapHints(store.prefs.keymap).map((k) => h('div.keyhelp-item', h('kbd', k.key), h('span', k.does))));
    renderKeys();
    let pendingApply = false;
    const dlg = new Dialog({
      title: 'Controls',
      wide: true,
      body: h(
        'div.controls-help',
        h(
          'div.controls-ports',
          this.players.map((p, i) =>
            h(
              `div.port-mini.p${i + 1}${p ? '' : '.empty'}`,
              h('div.port-mini-num', `${i + 1}`),
              h('div.port-mini-label', p ? deviceLabel(p) : 'Empty'),
            ),
          ),
        ),
        h(
          'div.keyhelp',
          h(
            'div.keyhelp-head',
            h('div.keyhelp-title', icon('keyboard'), 'Keyboard & mouse'),
            button({
              label: 'Change bindings',
              icon: 'gear',
              size: 'sm',
              onClick: async () => {
                const { changed } = await openKeybindDialog();
                renderKeys();
                if (changed) {
                  pendingApply = true;
                  applyBtn.disabled = false;
                  applyBtn.classList.add('attention');
                  app.toast(hasKeyboard ? 'Saved. Press Apply now to use the new bindings in this game.' : 'Bindings saved', 'ok', 3200);
                }
              },
            }),
          ),
          keyGrid,
        ),
        h('p.settings-note', 'Controllers use their standard layout. Open this menu any time with Esc, the Home button, or Select + Start.'),
      ),
      actions: [
        {
          label: 'Apply now',
          icon: 'zap',
          variant: 'primary',
          disabled: true,
          hint: 'Reloads the game from a quick save',
          onClick: () => {
            if (!pendingApply) return;
            dlg.close();
            void this.relaunch();
          },
        },
        { label: 'Back', focusDefault: true, onClick: () => dlg.close() },
      ],
    });
    const applyBtn = dlg.el.querySelector<HTMLButtonElement>('.dialog-actions .btn')!;
    dlg.open();
  }

  /** Suspend and start the same session again so new bindings take effect. */
  private async relaunch() {
    if (!this.beginLeaving()) return;
    await this.suspend();
    this.onRelaunch();
  }

  private async restart() {
    if (!(await confirmDialog('Restart the game?', 'Unsaved progress since your last save will be lost.', 'Restart'))) return;
    this.session.restart();
    app.toast('Game restarted', 'info');
    this.closeMenu();
  }

  private async changePlayers() {
    if (!this.beginLeaving()) return;
    await this.suspend();
    this.onChangePlayers();
  }

  private async quit() {
    if (!this.beginLeaving()) return;
    await this.suspend();
    this.onQuit();
  }

  /** Guards against a second quit/change/relaunch while the first is still saving. */
  private beginLeaving() {
    if (this.leaving) return false;
    this.leaving = true;
    return true;
  }

  /** Save a "suspend" state plus the memory card, then leave. */
  private async suspend() {
    if (!this.ready) return;
    app.toast('Suspending…', 'info', 1200);
    try {
      await this.saveSlot('suspend', 'Suspended game');
      await this.flushMemcard(true);
    } catch (e) {
      console.warn('suspend failed', e);
    }
  }

  /* ---------- Events ---------- */

  private onVisibility = () => {
    if (!this.ready) return;
    if (this.streaming) return; // remote players keep playing; the keep-alive drives frames
    if (document.hidden) {
      this.releaseKeys();
      this.session.hold('hidden');
      void this.flushMemcard();
    } else this.session.release('hidden');
  };

  private onWindowBlur = () => this.releaseKeys();

  private onWindowFocus = () => {
    if (this.ready && !this.menu && !this.leaving && !app.hasModal) this.canvas.focus();
  };

  private onCanvasKey = (e: KeyboardEvent) => {
    if (!e.isTrusted) return;
    if (e.type === 'keydown') this.keysDown.set(e.code, e.key);
    else this.keysDown.delete(e.code);
  };

  /**
   * The core only hears keys on its canvas, so a key held while focus leaves (alt-tab, the
   * menu opening, a click elsewhere) never gets its keyup and stays pressed in the game.
   */
  private releaseKeys = () => {
    for (const [code, key] of this.keysDown) this.canvas.dispatchEvent(new KeyboardEvent('keyup', { code, key, bubbles: true }));
    this.keysDown.clear();
  };

  private onBeforeUnload = () => {
    // Best effort: the memory card is flushed every 30s and on hide, so little is lost.
  };

  onNav(e: NavEvent) {
    if (e.action === 'menu') {
      if (this.menu) this.closeMenu();
      else this.openMenu();
      return true;
    }
    if (!this.ready && e.action === 'back') {
      this.onQuit();
      return true;
    }
    return false;
  }
}

async function hashBlob(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer());
  // crypto.subtle only exists on secure origins; plain-http LAN play falls back to FNV-1a.
  if (globalThis.crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-1', bytes);
    return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const x of bytes) {
    h1 = Math.imul(h1 ^ x, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + x, 0x9e3779b1) >>> 0;
  }
  return `${h1.toString(16)}-${h2.toString(16)}-${bytes.length}`;
}
