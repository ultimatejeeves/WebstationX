/**
 * Multiplayer lobby: four controller ports. Any device that presses a button drops into
 * the next free port. Player 1 presses Start (or the Start button) when everyone is in.
 *
 * The lobby also opens an online room. Friends join it from their own library screen with
 * the four-letter code; their controllers appear here as ports just like local ones.
 */
import { app, type Screen } from '../core/app';
import { clear, h, icon } from '../core/dom';
import { input, deviceLabel, GP } from '../core/input';
import { sfx } from '../core/sfx';
import type { DeviceId, GameMeta, NavEvent } from '../core/types';
import type { SessionPlayers } from '../emu/player';
import { ensureHosting, online, type HostSession } from '../net/online';
import { isNetDevice } from '../net/protocol';
import { slotTakenByVirtualPad } from '../emu/virtual-pads';
import { button, hintBar } from '../ui/components';

const COLORS = ['p1', 'p2', 'p3', 'p4'];

export class LobbyScreen implements Screen {
  name = 'lobby';
  el: HTMLElement;
  private ports: HTMLElement;
  private onlinePanel: HTMLElement;
  private slots: (DeviceId | null)[];
  private game: GameMeta;
  private onStart: (players: SessionPlayers) => void;
  private onBack: () => void;
  private startBtn: HTMLButtonElement;
  private activity = new Map<DeviceId, number>();
  private host: HostSession | null = null;
  private gone = false;

  constructor(game: GameMeta, firstDevice: DeviceId, onStart: (players: SessionPlayers) => void, onBack: () => void, keep: SessionPlayers = []) {
    this.game = game;
    this.onStart = onStart;
    this.onBack = onBack;
    this.slots = new Array(Math.min(4, game.players)).fill(null);
    // Coming back from a game: keep everyone in their ports (remote players stay connected).
    keep.forEach((d, i) => {
      if (d && i < this.slots.length) this.slots[i] = d;
    });
    if (!this.slots.includes(firstDevice) && !isNetDevice(firstDevice)) {
      const free = this.slots.indexOf(null);
      if (free >= 0) this.slots[free] = firstDevice;
    }
    this.ports = h('div.ports');
    this.onlinePanel = h('div.online-panel');
    this.startBtn = button({
      label: 'Start Game',
      icon: 'play',
      variant: 'primary',
      size: 'lg',
      focusDefault: true,
      onClick: () => this.start(),
    });
    this.el = h(
      'div.lobby',
      h('div.bg-main'),
      h(
        'div.lobby-head',
        h('div.lobby-kicker', 'MULTIPLAYER'),
        h('h1.title-glow', game.title),
        h('p.subtitle', 'Press any button on a controller or the keyboard to join. Multitap engages automatically for 3-4 players.'),
      ),
      this.ports,
      this.onlinePanel,
      h('div.lobby-actions', this.startBtn, button({ label: 'Back', icon: 'chevronL', onClick: () => this.onBack() })),
      hintBar([
        { glyph: 'cross', label: 'Join' },
        { glyph: 'circle', label: 'Leave / Back' },
        { glyph: 'triangle', label: 'Swap port' },
      ]),
    );
  }

  async mount() {
    this.render();
    input.onFrame = (pads) => this.pulse(pads);
    this.renderOnline('connecting');
    try {
      const host = await ensureHosting({ id: this.game.id, title: this.game.title, coverUrl: this.game.coverUrl, players: this.game.players });
      if (this.gone) return;
      this.host = host;
      host.onJoin = (dev) => this.join(dev, true);
      host.onLeave = (dev) => this.leave(dev, true);
      host.onSwap = (dev) => this.swap(dev);
      host.onPeersChanged = () => this.renderOnline('ready');
      host.onClosed = (reason) => {
        if (online.host === host) online.host = null;
        this.host = null;
        this.renderOnline('offline', reason);
      };
      host.setPhase('lobby');
      // Drop remote devices whose peers vanished while we were in the game.
      this.slots = this.slots.map((d) => (d && isNetDevice(d) && !host.hasDevice(d) ? null : d));
      this.renderOnline('ready');
      this.render();
    } catch (e) {
      console.warn('online lobby unavailable', e);
      this.renderOnline('offline', e instanceof Error ? e.message : String(e));
    }
  }

  unmount() {
    this.gone = true;
    input.onFrame = null;
    if (this.host) {
      this.host.onJoin = null;
      this.host.onLeave = null;
      this.host.onSwap = null;
      this.host.onPeersChanged = null;
    }
  }

  private render() {
    clear(this.ports);
    this.slots.forEach((dev, i) => {
      const remote = isNetDevice(dev);
      const port = h(
        `div.port.${COLORS[i]}${dev ? '.filled' : ''}${remote ? '.remote' : ''}`,
        h('div.port-num', `${i + 1}`),
        h(
          'div.port-art',
          dev === 'kb' ? icon('keyboard') : dev ? h('img', { src: '/assets/hero-controller.png', alt: '' }) : h('div.port-empty-ring'),
          remote ? h('div.port-remote-badge', icon('globe'), 'ONLINE') : null,
        ),
        h('div.port-label', dev ? deviceLabel(dev) : 'Press a button to join'),
        h('div.port-sub', dev ? `Player ${i + 1}` : 'Open port'),
        h('div.port-activity'),
      );
      this.ports.appendChild(port);
    });
    const n = this.slots.filter(Boolean).length;
    this.startBtn.querySelector('.btn-label')!.textContent = n > 1 ? `Start · ${n} Players` : 'Start · 1 Player';
    this.startBtn.classList.add('focused');
    this.host?.publishLobby(this.slots, deviceLabel);
  }

  private renderOnline(state: 'connecting' | 'ready' | 'offline', detail?: string) {
    clear(this.onlinePanel);
    this.onlinePanel.dataset.state = state;
    if (state === 'connecting') {
      this.onlinePanel.append(icon('globe'), h('span.online-text', 'Opening an online room…'));
      return;
    }
    if (state === 'offline' || !this.host) {
      this.onlinePanel.append(icon('globe'), h('span.online-text', 'Online play unavailable', detail ? h('small', detail) : null));
      return;
    }
    const host = this.host;
    const names = host.peerNames;
    this.onlinePanel.append(
      h('div.online-code-wrap', h('span.online-kicker', 'FRIENDS JOIN WITH CODE'), h('span.online-code', ...[...host.code].map((c) => h('b', c)))),
      h(
        'div.online-info',
        h('span.online-text', 'From their library screen: ', h('b', 'Join online'), ' → enter the code'),
        h(
          'span.online-peers',
          icon('users'),
          names.length === 0 ? 'Nobody connected yet' : names.length === 1 ? `${names[0]} connected` : `${names.length} connected: ${names.join(', ')}`,
        ),
      ),
    );
  }

  /** Light up a port whenever its device is being pressed, so people can find their pad. */
  private pulse(pads: (Gamepad | null)[]) {
    const now = performance.now();
    for (const p of pads) {
      if (!p) continue;
      if (p.buttons.some((b) => b.pressed) || p.axes.some((a) => Math.abs(a) > 0.5)) this.activity.set(`gp:${p.index}`, now);
    }
    const els = this.ports.children;
    this.slots.forEach((dev, i) => {
      const el = els[i] as HTMLElement | undefined;
      if (!el || !dev) return;
      const last = isNetDevice(dev) ? (this.host?.lastActive(dev) ?? 0) : (this.activity.get(dev) ?? 0);
      el.classList.toggle('active', now - last < 120);
    });
  }

  private join(dev: DeviceId, remote = false): boolean {
    if (this.slots.includes(dev)) return true;
    if (dev.startsWith('gp:') && slotTakenByVirtualPad(Number(dev.slice(3)))) {
      // The emulator only sees four controller slots; an online player already holds this one.
      sfx.error();
      app.toast('That controller slot is used by an online player. Connect controllers before friends join.', 'warn', 3200);
      return false;
    }
    const free = this.slots.indexOf(null);
    if (free < 0) {
      if (!remote) {
        sfx.error();
        app.toast('All ports are taken', 'warn', 1400);
      }
      return false;
    }
    this.slots[free] = dev;
    sfx.join();
    if (remote) app.toast(`${deviceLabel(dev)} joined online`, 'ok', 1800);
    this.render();
    return true;
  }

  private leave(dev: DeviceId, remote = false) {
    const i = this.slots.indexOf(dev);
    if (i < 0) return;
    if (i === 0 && !remote) {
      // Player 1 leaving means going back.
      this.onBack();
      return;
    }
    this.slots[i] = null;
    sfx.leave();
    if (remote) app.toast(`${deviceLabel(dev)} left`, 'info', 1600);
    this.render();
  }

  /** Move a device one port to the right (wrapping), so people can pick their colour. */
  private swap(dev: DeviceId) {
    const i = this.slots.indexOf(dev);
    if (i < 0) return;
    const j = (i + 1) % this.slots.length;
    [this.slots[i], this.slots[j]] = [this.slots[j], this.slots[i]];
    sfx.move();
    this.render();
  }

  private start() {
    // Compact players into the lowest ports so the game always sees Player 1.
    const players: SessionPlayers = [...this.slots];
    if (!players[0]) {
      const first = players.findIndex(Boolean);
      if (first < 0) return sfx.error();
      players[0] = players[first];
      players[first] = null;
    }
    sfx.confirm();
    this.host?.setPhase('loading');
    this.onStart(players);
  }

  onNav(e: NavEvent) {
    const dev = e.device;
    if (e.action === 'any') {
      if (!this.slots.includes(dev)) this.join(dev);
      return true;
    }
    if (e.action === 'back') {
      if (dev === 'kb' && e.raw === 'Backspace' && this.slots.indexOf(dev) > 0) this.leave(dev);
      else if (dev !== 'kb') this.leave(dev);
      else this.onBack();
      return true;
    }
    if (e.action === 'menu') {
      this.swap(dev);
      return true;
    }
    if (e.action === 'confirm' || e.action === 'start') {
      // Only a joined device can start the game (any of them can).
      if (this.slots.includes(dev)) this.activity.set(dev, performance.now());
      if (e.action === 'start' || this.slots.includes(dev)) {
        if (e.action === 'confirm' && this.startBtn.classList.contains('focused')) this.start();
        else if (e.action === 'start') this.start();
      }
      return true;
    }
    if (e.action === 'left' || e.action === 'right') {
      // D-pad left/right also swaps ports for the pressing device.
      if (!e.repeat && this.slots.includes(dev)) this.swap(dev);
      return true;
    }
    return true;
  }

  /** Current port layout, so the caller can hand it back when we return from a game. */
  get players(): SessionPlayers {
    return [...this.slots];
  }
}

export { GP };
