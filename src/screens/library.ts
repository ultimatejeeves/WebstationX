/**
 * Library: the collection as floating jewel cases in the tower field. Pick a game, then choose
 * Single Player or Multiplayer. That is the whole flow players need to learn.
 *
 * The selected case drifts forward and turns slowly like a memory-card icon, its disc peeks out
 * and spins, the game's own art washes into the background, and a small screen plays its
 * gameplay clip (or a title/screenshot slideshow when there is no clip).
 */
import { api } from '../core/api';
import type { Screen } from '../core/app';
import { acknowledge, acknowledged, checkGame, type Verdict } from '../core/compat';
import { clear, fmtWhen, h, icon } from '../core/dom';
import { FocusRing } from '../core/focus';
import { onHardwareChange } from '../core/hardware';
import { input } from '../core/input';
import { music } from '../core/music';
import { sfx } from '../core/sfx';
import { avatarUrl, store, type LibraryView } from '../core/store';
import type { DeviceId, GameMeta, NavEvent, SaveSummary } from '../core/types';
import { isCached } from '../emu/disc-cache';
import { scene } from '../fx/scene';
import { button, Dialog, hintBar, topBar } from '../ui/components';
import { openSettings } from './settings';

export type LaunchIntent = {
  game: GameMeta;
  mode: 'single' | 'multi';
  /** Device that made the choice; becomes Player 1 for single player. */
  device: DeviceId;
  /** Save-state slot to resume from, if any. */
  resumeSlot: string | null;
};

const DEFAULT_ACCENT = '#62e6ff';
/** How long a game must stay selected before its clip starts. */
const CLIP_DWELL_MS = 900;
const SLIDE_MS = 4800;

const SYSTEMS: { id: LibraryView['system']; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'ps1', label: 'PS1' },
  { id: 'ps2', label: 'PS2' },
];
const PLAYER_FILTERS: { id: LibraryView['players']; label: string }[] = [
  { id: 0, label: 'Any players' },
  { id: 2, label: '2+ players' },
  { id: 3, label: '3-4 players' },
];
const SORTS: { id: LibraryView['sort']; label: string }[] = [
  { id: 'title', label: 'A-Z' },
  { id: 'recent', label: 'Recently played' },
  { id: 'year', label: 'Release year' },
  { id: 'added', label: 'Newest added' },
];
const systemOf = (g: GameMeta) => g.system ?? 'ps1';

export class LibraryScreen implements Screen {
  name = 'library';
  el: HTMLElement;
  private track: HTMLElement;
  private carousel: HTMLElement;
  private detail: HTMLElement;
  private media: HTMLElement;
  private backdrop: HTMLElement;
  private ring: FocusRing;
  private bar: ReturnType<typeof topBar>;
  private padCount: HTMLElement;
  private filterBar: HTMLElement;
  private cards: HTMLElement[] = [];
  /** The games on the shelf: the catalog after the filters and the sort. */
  private games: GameMeta[] = [];
  private view: LibraryView = store.libraryView;
  private verdicts = new Map<string, Verdict>();
  private swipe: { x: number; moved: boolean } | null = null;
  private swipedAt = 0;
  private index = 0;
  private selected: GameMeta | null = null;
  private saves = new Map<string, SaveSummary>();
  private onLaunch: (intent: LaunchIntent) => void;
  private onSwitchProfile: () => void;
  private onJoinOnline: () => void;
  private unsub: (() => void)[] = [];
  private mediaTimer = 0;
  private slideTimer = 0;
  private video: HTMLVideoElement | null = null;
  private launching = false;
  private wheelAt = 0;

  constructor(onLaunch: (i: LaunchIntent) => void, onSwitchProfile: () => void, onJoinOnline: () => void) {
    this.onLaunch = onLaunch;
    this.onSwitchProfile = onSwitchProfile;
    this.onJoinOnline = onJoinOnline;
    this.track = h('div.carousel-track');
    this.carousel = h('div.carousel', { 'data-scroll': 'none' }, this.track);
    this.detail = h('div.detail');
    this.media = h('div.media');
    this.backdrop = h('div.lib-backdrop');
    this.padCount = h('span.padcount');
    this.filterBar = h('div.filterbar');
    const profileChip = h(
      'button.chip.profile-chip',
      { type: 'button', 'data-focus': true, tabindex: -1, onClick: () => this.onSwitchProfile() },
      h('img.chip-avatar', { src: avatarUrl(store.profile?.avatar ?? 'avatar-01'), alt: '' }),
      h('span', store.profile?.name ?? 'Guest'),
    );
    const settingsBtn = h(
      'button.chip',
      { type: 'button', 'data-focus': true, tabindex: -1, title: 'Settings', onClick: () => openSettings() },
      icon('gear'),
      h('span', 'Settings'),
    );
    const joinBtn = h(
      'button.chip.chip-online',
      { type: 'button', 'data-focus': true, tabindex: -1, title: "Join a friend's session", onClick: () => this.onJoinOnline() },
      icon('globe'),
      h('span', 'Join online'),
    );
    // Phones: the browser chrome eats a third of a landscape screen, so offer real fullscreen.
    const fullscreenBtn =
      document.fullscreenEnabled && matchMedia('(pointer: coarse)').matches
        ? h('button.chip.chip-fullscreen', { type: 'button', 'data-focus': true, tabindex: -1, title: 'Fullscreen', onClick: () => void toggleFullscreen() }, icon('fullscreen'), h('span', 'Fullscreen'))
        : null;
    this.bar = topBar({
      left: h('div.brand', h('img.brand-emblem', { src: '/assets/emblem.png', alt: '' }), h('span.brand-text', h('b', 'WEBSTATION'), 'X')),
      right: h('div.topbar-tools', this.padCount, fullscreenBtn, joinBtn, settingsBtn, profileChip),
    });
    const hints = hintBar([
      { glyph: 'cross', label: 'Play' },
      { glyph: 'dpad', label: 'Browse' },
      { glyph: 'square', label: 'Favorite' },
      { glyph: 'triangle', label: 'Settings' },
    ]);
    hints.insertBefore(h('span.hint', h('span.glyph.glyph-key', 'L1'), h('span.glyph.glyph-key', 'R1'), 'PS1 / PS2'), hints.children[2]);
    this.el = h(
      'div.library',
      this.backdrop,
      h('div.bg-main'),
      this.bar,
      h(
        'div.library-body',
        this.filterBar,
        h('div.library-main', h('div.carousel-wrap', this.carousel, h('div.carousel-floor')), h('div.info-row', this.detail, this.media)),
      ),
      hints,
    );
    this.ring = new FocusRing(this.el);
    this.ring.onChange = (el) => {
      const id = el?.dataset.game;
      if (id) this.select(this.games.findIndex((g) => g.id === id));
    };
    this.carousel.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    // Touch: drag across the shelf to flick through the cases.
    this.carousel.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') this.swipe = { x: e.clientX, moved: false };
    });
    this.carousel.addEventListener('pointermove', (e) => {
      const sw = this.swipe;
      if (!sw) return;
      const step = Math.max(40, (this.cards[0]?.offsetWidth || 160) * 0.45);
      const dx = e.clientX - sw.x;
      if (Math.abs(dx) < step) return;
      sw.x = e.clientX;
      sw.moved = true;
      const next = this.index + (dx < 0 ? 1 : -1);
      if (next >= 0 && next < this.games.length) this.focusIndex(next, true);
    });
    const endSwipe = () => {
      if (this.swipe?.moved) this.swipedAt = performance.now();
      this.swipe = null;
    };
    this.carousel.addEventListener('pointerup', endSwipe);
    this.carousel.addEventListener('pointercancel', endSwipe);
  }

  async mount() {
    window.addEventListener('pointerdown', markPointer, { capture: true });
    this.renderPads();
    input.onGamepadsChanged = () => this.renderPads();
    this.unsub.push(store.subscribe(() => this.renderDetail()));
    // Detection finishing (or a settings change) can change what this device should run.
    this.unsub.push(
      onHardwareChange(() => {
        this.verdicts.clear();
        this.cards.forEach((card, i) => this.flagCard(card, this.games[i]));
        void this.renderDetail();
      }),
    );
    this.view = store.libraryView;
    this.applyView(true);
    // Load save summaries in the background so the detail panel can show "Continue".
    if (store.profile) {
      for (const g of store.catalog.games) {
        api
          .saves(store.profile.id, g.id)
          .then((s) => {
            this.saves.set(g.id, s);
            if (this.selected?.id === g.id) void this.renderDetail();
          })
          .catch(() => {});
      }
    }
  }

  unmount() {
    window.removeEventListener('pointerdown', markPointer, { capture: true });
    this.bar.dispose();
    input.onGamepadsChanged = null;
    for (const u of this.unsub) u();
    this.stopMedia();
    scene.setAccent(null);
  }

  private renderPads() {
    const n = input.gamepads.size;
    clear(this.padCount);
    this.padCount.append(icon('pad'), h('span', n === 0 ? 'No controllers' : `${n} controller${n > 1 ? 's' : ''}`));
    this.padCount.classList.toggle('dim', n === 0);
  }

  /* ---------- Filters ---------- */

  private filtered(): GameMeta[] {
    const { system, players, sort, favOnly } = this.view;
    const favs = favOnly ? store.favorites : null;
    const games = store.catalog.games.filter((g) => (system === 'all' || systemOf(g) === system) && g.players >= players && (!favs || favs.includes(g.id)));
    if (sort === 'title') return games; // the catalog's own order
    const stats = sort === 'recent' ? store.playStats : {};
    const key = (g: GameMeta) => (sort === 'recent' ? -(stats[g.id]?.last ?? 0) : sort === 'year' ? g.year ?? 9999 : -(Date.parse(g.addedAt ?? '') || 0));
    return [...games].sort((a, b) => key(a) - key(b) || a.title.localeCompare(b.title));
  }

  private setView(patch: Partial<LibraryView>, focusCase: boolean) {
    this.view = { ...this.view, ...patch };
    store.libraryView = this.view;
    this.applyView(focusCase);
  }

  private cycleSystem(dir: 1 | -1) {
    const i = SYSTEMS.findIndex((s) => s.id === this.view.system);
    sfx.select();
    scene.lean(dir);
    this.setView({ system: SYSTEMS[(i + dir + SYSTEMS.length) % SYSTEMS.length].id }, true);
  }

  private renderFilterBar() {
    const all = store.catalog.games;
    const chip = (name: string, ic: string, label: string, active: boolean, title: string, onClick: () => void) =>
      h(
        `button.filter-chip${active ? '.active' : ''}`,
        {
          type: 'button',
          'data-focus': true,
          'data-filter': name,
          tabindex: -1,
          title,
          onClick: () => {
            sfx.move();
            onClick();
          },
        },
        icon(ic),
        h('span', label),
      );
    const next = <T,>(list: { id: T }[], cur: T) => list[(list.findIndex((x) => x.id === cur) + 1) % list.length].id;
    const players = PLAYER_FILTERS.find((p) => p.id === this.view.players)!;
    const sort = SORTS.find((x) => x.id === this.view.sort)!;
    // Keep focus on the same control when the bar is rebuilt under it.
    const focused = this.ring.current?.closest('.filterbar') ? this.ring.current.dataset.filter : undefined;
    clear(this.filterBar);
    this.filterBar.append(
      h(
        'div.sys-tabs',
        h('span.glyph.glyph-key', 'L1'),
        SYSTEMS.map((sys) =>
          h(
            `button.sys-tab.sys-${sys.id}${this.view.system === sys.id ? '.active' : ''}`,
            {
              type: 'button',
              'data-focus': true,
              'data-filter': `sys-${sys.id}`,
              tabindex: -1,
              onClick: () => {
                sfx.move();
                this.setView({ system: sys.id }, false);
              },
            },
            h('b', sys.label),
            h('span.sys-count', String(sys.id === 'all' ? all.length : all.filter((g) => systemOf(g) === sys.id).length)),
          ),
        ),
        h('span.glyph.glyph-key', 'R1'),
      ),
      h(
        'div.filter-chips',
        chip('players', 'users', players.label, players.id !== 0, 'Filter by players', () => this.setView({ players: next(PLAYER_FILTERS, this.view.players) }, false)),
        chip('fav', 'star', 'Favorites', this.view.favOnly, 'Only favorites', () => this.setView({ favOnly: !this.view.favOnly }, false)),
        chip('sort', 'sort', sort.label, sort.id !== 'title', 'Sort', () => this.setView({ sort: next(SORTS, this.view.sort) }, false)),
        h('span.filter-count', this.games.length === all.length ? `${all.length} games` : `${this.games.length} of ${all.length}`),
      ),
    );
    if (focused) this.ring.set(this.filterBar.querySelector<HTMLElement>(`[data-filter="${focused}"]`), true);
  }

  /** Rebuild the shelf for the current filters, keeping the selected game in front when it survives. */
  private applyView(focusCase: boolean) {
    const keep = this.selected?.id ?? store.lastGameId;
    this.games = this.filtered();
    this.renderShelf();
    this.renderFilterBar();
    if (this.games.length === 0) {
      this.selected = null;
      this.index = 0;
      this.stopMedia();
      clear(this.media);
      void this.renderDetail();
      if (focusCase || !this.ring.current?.isConnected) this.ring.set(this.filterBar.querySelector<HTMLElement>('.sys-tab.active'), true);
      return;
    }
    const i = Math.max(0, this.games.findIndex((g) => g.id === keep));
    this.select(i);
    if (focusCase || !this.ring.current?.isConnected) this.ring.set(this.cards[i], true);
  }

  private verdict(g: GameMeta): Verdict {
    let v = this.verdicts.get(g.id);
    if (!v) this.verdicts.set(g.id, (v = checkGame(g)));
    return v;
  }

  private flagCard(card: HTMLElement, g: GameMeta) {
    const level = this.verdict(g).level;
    if (level === 'ok') delete card.dataset.verdict;
    else card.dataset.verdict = level;
  }

  /* ---------- Carousel ---------- */

  private renderShelf() {
    clear(this.track);
    this.cards = [];
    if (this.games.length === 0) {
      const none = store.catalog.games.length === 0;
      this.track.appendChild(h('div.shelf-empty', none ? 'No games published yet. Add one with: npm run ingest' : 'No games match these filters.'));
      return;
    }
    const favs = store.favorites;
    this.games.forEach((g, i) => {
      const card = h(
        g.system === 'ps2' ? 'button.game-card.ps2' : 'button.game-card',
        {
          type: 'button',
          'data-focus': true,
          'data-nohover': true,
          tabindex: -1,
          'data-game': g.id,
          onClick: (ev: Event) => {
            if (performance.now() - this.swipedAt < 350) return; // the tail of a swipe, not a tap
            // A click on a case to the side brings it forward; on the front case it plays.
            if (i !== this.index) this.focusIndex(i, true);
            else this.play(g, ev);
          },
        },
        h('div.case-float', jewelCase(g), discFor(g), h('div.case-shadow'), h('div.case-flag', icon('warn')), h('div.case-fav', icon('star'))),
        h('div.game-card-title', g.title),
      );
      card.classList.toggle('fav', favs.includes(g.id));
      this.flagCard(card, g);
      this.track.appendChild(card);
      this.cards.push(card);
    });
  }

  private focusIndex(i: number, withSound: boolean) {
    const card = this.cards[i];
    if (!card) return;
    const dir = i > this.index ? 1 : -1;
    this.ring.set(card, true);
    if (withSound) {
      sfx.select();
      scene.lean(dir as 1 | -1);
    }
  }

  private select(i: number) {
    if (i < 0 || i >= this.games.length) return;
    const changed = this.selected?.id !== this.games[i].id;
    this.index = i;
    this.selected = this.games[i];
    this.layout();
    if (!changed) return;
    const g = this.selected;
    const accent = g.art?.accent ?? DEFAULT_ACCENT;
    this.el.style.setProperty('--accent', accent);
    scene.setAccent(g.art?.accent ?? null);
    this.setBackdrop(g);
    this.renderDetail();
    this.startMedia(g);
  }

  /** Coverflow: the selected case front and centre, the rest angled away down each side. */
  private layout() {
    const w = this.cards[0]?.offsetWidth || 240;
    this.cards.forEach((card, i) => {
      const o = i - this.index;
      const a = Math.abs(o);
      const s = Math.sign(o);
      // Leave room on the right of the front case for its disc to slide out.
      const x = o === 0 ? 0 : s * (w * (s > 0 ? 1.55 : 1.15) + (a - 1) * w * 0.5);
      const z = o === 0 ? 80 : -220 - a * 40;
      const ry = o === 0 ? 0 : -s * 62;
      card.style.transform = `translate(-50%, 0) translate3d(${x}px, 0, ${z}px) rotateY(${ry}deg)`;
      card.style.zIndex = String(100 - a);
      card.style.opacity = a > 5 ? '0' : String(1 - a * 0.14);
      card.classList.toggle('selected', o === 0);
      card.classList.toggle('side-left', o < 0);
      card.classList.toggle('side-right', o > 0);
    });
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const now = performance.now();
    if (now - this.wheelAt < 160) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(d) < 4) return;
    this.wheelAt = now;
    const next = this.index + (d > 0 ? 1 : -1);
    if (next >= 0 && next < this.games.length) this.focusIndex(next, true);
  }

  /* ---------- Backdrop & media ---------- */

  private setBackdrop(g: GameMeta) {
    // Fanart or an in-game shot; title screens are mostly a big logo that fights the UI.
    const src = g.art?.fanart ?? g.art?.snap ?? g.art?.title ?? g.coverUrl;
    const old = [...this.backdrop.children] as HTMLElement[];
    if (!src) {
      for (const o of old) o.classList.remove('show');
      return;
    }
    const img = h('img.bd-img', { src, alt: '', draggable: false }) as HTMLImageElement;
    img.addEventListener('load', () => requestAnimationFrame(() => img.classList.add('show')), { once: true });
    this.backdrop.appendChild(img);
    for (const o of old) {
      o.classList.remove('show');
      setTimeout(() => o.remove(), 1400);
    }
  }

  private stopMedia() {
    clearTimeout(this.mediaTimer);
    clearInterval(this.slideTimer);
    if (this.video) {
      const v = this.video;
      this.video = null;
      fadeVolume(v, 0, 250).then(() => {
        v.pause();
        v.removeAttribute('src');
        v.load();
      });
      music.duck(false);
    }
  }

  private startMedia(g: GameMeta) {
    this.stopMedia();
    const slides = [g.art?.title, g.art?.snap].filter((s): s is string => !!s);
    if (slides.length === 0 && g.coverUrl) slides.push(g.coverUrl);
    const screen = h('div.media-screen');
    const label = h('div.media-label', g.art?.video ? 'GAMEPLAY' : slides.length ? 'TITLE SCREEN' : 'NO SIGNAL');
    clear(this.media);
    this.media.append(h('div.media-bezel', screen, h('div.media-scan'), h('div.media-glass')), label);

    // Slideshow first; the clip (if any) replaces it after a short dwell.
    const imgs = slides.map((src, i) => h(`img.media-slide${i === 0 ? '.show' : ''}`, { src, alt: '', draggable: false }));
    if (imgs.length) screen.append(...imgs);
    else screen.append(h('div.media-static'));
    let n = 0;
    if (imgs.length > 1) {
      this.slideTimer = window.setInterval(() => {
        imgs[n].classList.remove('show');
        n = (n + 1) % imgs.length;
        imgs[n].classList.add('show');
        label.textContent = n === 0 ? 'TITLE SCREEN' : 'IN GAME';
      }, SLIDE_MS);
    }
    if (!g.art?.video) return;
    this.mediaTimer = window.setTimeout(() => {
      if (this.selected?.id !== g.id || this.launching) return;
      const v = h('video.media-video', { muted: true, loop: true, playsinline: true, preload: 'auto' }) as HTMLVideoElement;
      v.muted = true;
      v.volume = 0;
      v.src = g.art!.video!;
      v.addEventListener(
        'playing',
        () => {
          if (this.video !== v) return;
          clearInterval(this.slideTimer);
          v.classList.add('show');
          // Bring the clip's own sound up under the music, which ducks out of the way.
          if (store.prefs.volume > 0) {
            v.muted = false;
            music.duck(true);
            void fadeVolume(v, Math.min(0.55, store.prefs.volume / 150), 1400);
          }
        },
        { once: true },
      );
      screen.append(v);
      this.video = v;
      v.play().catch(() => {});
    }, CLIP_DWELL_MS);
  }

  /* ---------- Detail ---------- */

  private renderToken = 0;
  private async renderDetail() {
    const g = this.selected;
    const token = ++this.renderToken;
    if (!g) {
      clear(this.detail);
      if (store.catalog.games.length) {
        this.detail.append(
          h('h2.detail-title', 'Nothing here'),
          h('p.detail-blurb', this.view.favOnly ? 'No favorites match. Press Square on a game to add it to your favorites.' : 'No games match these filters.'),
          h('button.btn.btn-glass.btn-sm.detail-reset', { type: 'button', onClick: () => this.setView({ system: 'all', players: 0, favOnly: false }, true) }, h('span.btn-label', 'Show all games')),
        );
      }
      return;
    }
    const saves = this.saves.get(g.id);
    const latest = saves?.slots[0];
    const ps2 = g.system === 'ps2';
    const cached = ps2 ? false : await isCached(g.discUrl);
    if (token !== this.renderToken) return;
    clear(this.detail);
    const verdict = this.verdict(g);
    const fav = store.favorites.includes(g.id);
    const played = store.playStats[g.id];
    const facts: string[] = [];
    if (g.year) facts.push(String(g.year));
    if (g.genre) facts.push(g.genre);
    facts.push(g.players > 1 ? `1-${g.players} Players` : '1 Player');
    if (g.publisher) facts.push(g.publisher);
    this.detail.append(
      g.art?.logo ? h('img.detail-logo', { src: g.art.logo, alt: g.title, draggable: false }) : h('h2.detail-title', g.title),
      h('div.detail-facts', h(`span.fact.fact-sys.sys-${systemOf(g)}`, ps2 ? 'PlayStation 2' : 'PlayStation'), fav ? h('span.fact.fact-fav', icon('star'), 'Favorite') : null, facts.map((f) => h('span.fact', f))),
      g.blurb ? h('p.detail-blurb', g.blurb) : '',
      h(
        'div.detail-status',
        ps2
          ? h('span.status-pill', icon('disc'), 'DVD · streams as you play')
          : h('span.status-pill', icon('disc'), cached ? 'Disc ready' : `Disc download ${g.size ? (g.size / 1048576).toFixed(0) + ' MB' : ''}`),
        saves?.memcard ? h('span.status-pill', icon('memcard'), `Memory card · ${fmtWhen(saves.memcard.updatedAt)}`) : h('span.status-pill.dim', icon('memcard'), 'New memory card'),
        latest ? h('span.status-pill.ok', icon('save'), `Suspended game · ${fmtWhen(latest.updatedAt)}`) : '',
        played && played.secs >= 60 ? h('span.status-pill.dim', icon('clock'), `Played ${fmtPlayed(played.secs)} · ${fmtWhen(new Date(played.last).toISOString())}`) : '',
        verdict.label ? h(`span.status-pill.verdict-${verdict.level}`, { title: verdict.detail }, icon(verdict.level === 'ok' ? 'check' : 'warn'), verdict.label) : '',
      ),
      h('div.detail-hint', 'Press ', h('span.glyph', icon('cross')), ' to play'),
      // Touch and mouse: an obvious thing to press.
      h(
        'div.detail-touch',
        h('button.btn.btn-primary.btn-sm', { type: 'button', onClick: (ev: Event) => this.play(g, ev) }, icon('play'), h('span.btn-label', 'Play')),
        h('button.btn.btn-glass.btn-sm', { type: 'button', onClick: () => this.toggleFavorite() }, icon('star'), h('span.btn-label', fav ? 'Unfavorite' : 'Favorite')),
      ),
    );
    // Restart the entrance animation for the new game.
    this.detail.classList.remove('detail-in');
    void this.detail.offsetWidth;
    this.detail.classList.add('detail-in');
  }

  /* ---------- Launch ---------- */

  /** The disc slides out, spins up and the world pulses before the game screen takes over. */
  private launch(intent: LaunchIntent) {
    if (this.launching) return;
    this.launching = true;
    this.stopMedia();
    sfx.discIn();
    scene.pulse();
    this.el.classList.add('launching');
    setTimeout(() => this.onLaunch(intent), 1150);
  }

  private toggleFavorite() {
    const g = this.selected;
    if (!g) return;
    const on = store.toggleFavorite(g.id);
    sfx.confirm();
    this.cards[this.index]?.classList.toggle('fav', on);
    if (this.view.favOnly && !on) this.applyView(true);
    else void this.renderDetail();
  }

  /** The device check comes first: a blocked game explains itself, a flagged one asks once. */
  private play(g: GameMeta, ev: Event) {
    const v = this.verdict(g);
    if (v.level === 'block' && v.hard) {
      const dlg = new Dialog({
        title: 'PS2 games can’t start here',
        body: h('p', v.detail),
        actions: [{ label: 'OK', variant: 'primary', focusDefault: true, onClick: () => dlg.close() }],
      });
      dlg.open();
      return;
    }
    if (v.level === 'block' || (v.level === 'warn' && !acknowledged(g.id))) {
      const block = v.level === 'block';
      const dlg = new Dialog({
        title: block ? 'Not recommended on this device' : 'Heads up',
        body: h('div.verdict-body', h(`div.verdict-badge.verdict-${v.level}`, icon('warn'), v.label), h('p', v.detail), h('p.settings-note', 'You can turn this check off in Settings → Device check.')),
        actions: [
          {
            label: block ? 'Play anyway' : 'Play',
            icon: 'play',
            variant: block ? 'glass' : 'primary',
            focusDefault: !block,
            onClick: () => {
              dlg.close();
              acknowledge(g.id);
              this.startFlow(g, ev);
            },
          },
          { label: 'Back', focusDefault: block, onClick: () => dlg.close() },
        ],
      });
      dlg.open();
      return;
    }
    this.startFlow(g, ev);
  }

  /** The play flow: (Continue?) -> Single / Multiplayer -> launch. */
  private startFlow(g: GameMeta, ev: Event) {
    const device = lastDevice;
    const saves = this.saves.get(g.id);
    const latest = saves?.slots[0] ?? null;
    void ev;
    const choose = (resumeSlot: string | null) => {
      if (g.players <= 1) return this.launch({ game: g, mode: 'single', device, resumeSlot });
      const dlg = new Dialog({
        title: g.title,
        body: h(
          'div.mode-pick',
          h('p', 'How do you want to play?'),
          h('div.mode-buttons', [
            button({
              label: 'Single Player',
              icon: 'user',
              variant: 'primary',
              size: 'lg',
              focusDefault: true,
              onClick: () => {
                dlg.close();
                this.launch({ game: g, mode: 'single', device, resumeSlot });
              },
            }),
            button({
              label: 'Multiplayer',
              icon: 'users',
              variant: 'primary',
              size: 'lg',
              hint: `Up to ${g.players} players`,
              onClick: () => {
                dlg.close();
                this.launch({ game: g, mode: 'multi', device, resumeSlot });
              },
            }),
          ]),
        ),
        actions: [{ label: 'Back', onClick: () => dlg.close() }],
      });
      dlg.open();
    };
    if (latest) {
      const dlg = new Dialog({
        title: 'Continue where you left off?',
        body: h(
          'div.resume-pick',
          latest.thumbnail ? h('img.resume-thumb', { src: latest.thumbnail, alt: '' }) : null,
          h('div.resume-text', h('b', latest.label ?? 'Suspended game'), h('span', fmtWhen(latest.updatedAt))),
        ),
        actions: [
          {
            label: 'Continue',
            icon: 'play',
            variant: 'primary',
            focusDefault: true,
            onClick: () => {
              dlg.close();
              choose(latest.slot);
            },
          },
          {
            label: 'Start from the disc',
            icon: 'disc',
            onClick: () => {
              dlg.close();
              choose(null);
            },
          },
          { label: 'Back', onClick: () => dlg.close() },
        ],
      });
      dlg.open();
    } else choose(null);
  }

  onNav(e: NavEvent) {
    if (this.launching) return true;
    // Whoever pressed a real button last becomes Player 1 for single player. Stick drift
    // (axis events) and auto-repeats are ignored so an idle pad cannot steal the slot.
    if (e.action !== 'any' && !e.repeat && e.raw !== 'axis') lastDevice = e.device;
    const onCase = !!this.ring.current?.dataset.game;
    const inFilters = !!this.ring.current?.closest('.filterbar');
    switch (e.action) {
      case 'left':
      case 'right': {
        if (onCase) {
          const next = this.index + (e.action === 'right' ? 1 : -1);
          if (next >= 0 && next < this.cards.length) this.focusIndex(next, true);
          return true;
        }
        this.ring.move(e.action);
        return true;
      }
      case 'prev':
      case 'next':
        // L1 / R1 flip between All, PS1 and PS2 like tabs.
        if (!e.repeat) this.cycleSystem(e.action === 'next' ? 1 : -1);
        return true;
      case 'alt':
        if (!e.repeat) this.toggleFavorite();
        return true;
      case 'down':
        // From the filters, drop straight back onto the front case.
        if (inFilters && this.cards[this.index]) {
          this.ring.set(this.cards[this.index]);
          return true;
        }
        this.ring.move('down');
        return true;
      case 'up':
        this.ring.move('up');
        return true;
      case 'confirm':
        this.ring.activate();
        return true;
      case 'menu':
        openSettings();
        return true;
      case 'back':
        sfx.back();
        this.onSwitchProfile();
        return true;
    }
  }
}

/* ---------- Pieces ---------- */

/** A PS1-style jewel case: front cover, back, spine, clear plastic edges, glare. */
function jewelCase(g: GameMeta) {
  const front = g.coverUrl
    ? h('img.cover', { src: g.coverUrl, alt: g.title, draggable: false })
    : h('div.cover.cover-missing', h('span', g.title));
  const back = g.art?.back
    ? h('img.cover', { src: g.art.back, alt: '', draggable: false })
    : h('div.case-back-plain', h('span', g.title));
  return h(
    'div.case3d',
    h('div.face.face-front', front, h('div.case-hinge'), h('div.case-glare')),
    h('div.face.face-back', back, h('div.case-glare')),
    h('div.face.face-spine', h('span.spine-text', g.title)),
    h('div.face.face-edge'),
    h('div.face.face-top'),
    h('div.face.face-bottom'),
    h('div.case-reflect', g.coverUrl ? h('img', { src: g.coverUrl, alt: '', draggable: false }) : null),
  );
}

/** The disc: scraped label art, or one printed from the cover. */
function discFor(g: GameMeta) {
  const label = g.art?.disc
    ? h('img.disc-art', { src: g.art.disc, alt: '', draggable: false })
    : h('div.disc-print', g.coverUrl ? h('img', { src: g.coverUrl, alt: '', draggable: false }) : null);
  return h('div.case-disc', h('div.disc-spin', label, h('div.disc-sheen'), h('div.disc-hub')));
}

function fmtPlayed(secs: number) {
  const m = Math.round(secs / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} m`;
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape').catch(() => {});
    }
  } catch {
    /* not allowed here (iPhone Safari): the home-screen app is the way */
  }
}

function fadeVolume(v: HTMLVideoElement, to: number, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const from = v.volume;
    const t0 = performance.now();
    // Timers rather than rAF so a fade still finishes in a background tab.
    const id = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      v.volume = from + (to - from) * k;
      if (k >= 1) {
        clearInterval(id);
        resolve();
      }
    }, 30);
  });
}

/** Device that last produced a navigation event; a mouse click counts as the keyboard. */
let lastDevice: DeviceId = 'kb';
const markPointer = () => {
  lastDevice = 'kb';
};

