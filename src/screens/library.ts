/**
 * Library: the shelf of published games. Pick a game, then choose Single Player or
 * Multiplayer. That is the whole flow players need to learn.
 */
import { api } from '../core/api';
import { app, type Screen } from '../core/app';
import { clear, fmtWhen, h, icon } from '../core/dom';
import { FocusRing } from '../core/focus';
import { input } from '../core/input';
import { sfx } from '../core/sfx';
import { avatarUrl, store } from '../core/store';
import type { DeviceId, GameMeta, NavEvent, SaveSummary } from '../core/types';
import { isCached } from '../emu/disc-cache';
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

export class LibraryScreen implements Screen {
  name = 'library';
  el: HTMLElement;
  private shelf: HTMLElement;
  private detail: HTMLElement;
  private ring: FocusRing;
  private bar: ReturnType<typeof topBar>;
  private padCount: HTMLElement;
  private selected: GameMeta | null = null;
  private saves = new Map<string, SaveSummary>();
  private onLaunch: (intent: LaunchIntent) => void;
  private onSwitchProfile: () => void;
  private unsub: (() => void)[] = [];

  constructor(onLaunch: (i: LaunchIntent) => void, onSwitchProfile: () => void) {
    this.onLaunch = onLaunch;
    this.onSwitchProfile = onSwitchProfile;
    this.shelf = h('div.shelf', { 'data-scroll': 'x' });
    this.detail = h('div.detail');
    this.padCount = h('span.padcount');
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
    this.bar = topBar({
      left: h('div.brand', h('img.brand-emblem', { src: '/assets/emblem.png', alt: '' }), h('span.brand-text', h('b', 'WEBSTATION'), 'X')),
      right: h('div.topbar-tools', this.padCount, settingsBtn, profileChip),
    });
    this.el = h(
      'div.library',
      h('div.bg-main'),
      this.bar,
      h('div.library-body', h('div.shelf-wrap', h('div.shelf-label', 'GAME LIBRARY'), this.shelf), this.detail),
      hintBar([
        { glyph: 'cross', label: 'Play' },
        { glyph: 'dpad', label: 'Browse' },
        { glyph: 'triangle', label: 'Settings' },
      ]),
    );
    this.ring = new FocusRing(this.el);
    this.ring.onChange = (el) => {
      const id = el?.dataset.game;
      if (id) this.select(store.game(id) ?? null);
    };
  }

  async mount() {
    this.renderPads();
    input.onGamepadsChanged = () => this.renderPads();
    this.unsub.push(store.subscribe(() => this.renderDetail()));
    await this.renderShelf();
  }

  unmount() {
    this.bar.dispose();
    input.onGamepadsChanged = null;
    for (const u of this.unsub) u();
  }

  private renderPads() {
    const n = input.gamepads.size;
    clear(this.padCount);
    this.padCount.append(icon('pad'), h('span', n === 0 ? 'No controllers' : `${n} controller${n > 1 ? 's' : ''}`));
    this.padCount.classList.toggle('dim', n === 0);
  }

  private async renderShelf() {
    clear(this.shelf);
    const games = store.catalog.games;
    if (games.length === 0) {
      this.shelf.appendChild(h('div.shelf-empty', 'No games published yet. Add one with: npm run ingest'));
      return;
    }
    const last = store.lastGameId;
    for (const g of games) {
      const card = h(
        'button.game-card',
        {
          type: 'button',
          'data-focus': true,
          tabindex: -1,
          'data-game': g.id,
          'data-focus-default': (last ? g.id === last : g === games[0]) || undefined,
          onClick: (ev: Event) => this.play(g, ev),
        },
        h('div.jewel', h('div.jewel-spine'), g.coverUrl ? h('img.cover', { src: g.coverUrl, alt: g.title, draggable: false }) : h('div.cover.cover-missing', g.title)),
        h('div.game-card-title', g.title),
      );
      this.shelf.appendChild(card);
    }
    // Load save summaries in the background so the detail panel can show "Continue".
    if (store.profile) {
      for (const g of games) {
        api
          .saves(store.profile.id, g.id)
          .then((s) => {
            this.saves.set(g.id, s);
            if (this.selected?.id === g.id) this.renderDetail();
          })
          .catch(() => {});
      }
    }
    this.ring.focusDefault();
    if (!this.selected) this.select(store.game(last ?? '') ?? games[0]);
  }

  private select(g: GameMeta | null) {
    this.selected = g;
    this.renderDetail();
  }

  private renderToken = 0;
  private async renderDetail() {
    const g = this.selected;
    const token = ++this.renderToken;
    if (!g) return clear(this.detail);
    const saves = this.saves.get(g.id);
    const latest = saves?.slots[0];
    const cached = await isCached(g.discUrl);
    if (token !== this.renderToken) return;
    clear(this.detail);
    const facts: string[] = [];
    if (g.year) facts.push(String(g.year));
    if (g.genre) facts.push(g.genre);
    facts.push(g.players > 1 ? `1-${g.players} Players` : '1 Player');
    if (g.publisher) facts.push(g.publisher);
    this.detail.append(
      h('div.detail-kicker', 'NOW SHOWING'),
      h('h2.detail-title', g.title),
      h('div.detail-facts', facts.map((f) => h('span.fact', f))),
      g.blurb ? h('p.detail-blurb', g.blurb) : '',
      h(
        'div.detail-status',
        h('span.status-pill', icon('disc'), cached ? 'Disc ready' : `Disc download ${g.size ? (g.size / 1048576).toFixed(0) + ' MB' : ''}`),
        saves?.memcard ? h('span.status-pill', icon('memcard'), `Memory card · ${fmtWhen(saves.memcard.updatedAt)}`) : h('span.status-pill.dim', icon('memcard'), 'New memory card'),
        latest ? h('span.status-pill.ok', icon('save'), `Suspended game · ${fmtWhen(latest.updatedAt)}`) : '',
      ),
      h('div.detail-hint', 'Press ', h('span.glyph', icon('cross')), ' to play'),
    );
  }

  /** The play flow: (Continue?) -> Single / Multiplayer -> launch. */
  private play(g: GameMeta, ev: Event) {
    const device = lastDevice;
    const saves = this.saves.get(g.id);
    const latest = saves?.slots[0] ?? null;
    void ev;
    const choose = (resumeSlot: string | null) => {
      if (g.players <= 1) return this.onLaunch({ game: g, mode: 'single', device, resumeSlot });
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
                this.onLaunch({ game: g, mode: 'single', device, resumeSlot });
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
                this.onLaunch({ game: g, mode: 'multi', device, resumeSlot });
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
    if (e.action !== 'any') lastDevice = e.device;
    switch (e.action) {
      case 'up':
      case 'down':
      case 'left':
      case 'right':
        this.ring.move(e.action);
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

/** Device that last produced a navigation event; a mouse click counts as the keyboard. */
let lastDevice: DeviceId = 'kb';
