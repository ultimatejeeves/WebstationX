/**
 * Multiplayer lobby: four controller ports. Any device that presses a button drops into
 * the next free port. Player 1 presses Start (or the Start button) when everyone is in.
 */
import { app, type Screen } from '../core/app';
import { clear, h, icon } from '../core/dom';
import { input, deviceLabel, GP } from '../core/input';
import { sfx } from '../core/sfx';
import type { DeviceId, GameMeta, NavEvent } from '../core/types';
import type { SessionPlayers } from '../emu/player';
import { button, hintBar } from '../ui/components';

const COLORS = ['p1', 'p2', 'p3', 'p4'];

export class LobbyScreen implements Screen {
  name = 'lobby';
  el: HTMLElement;
  private ports: HTMLElement;
  private slots: (DeviceId | null)[];
  private game: GameMeta;
  private onStart: (players: SessionPlayers) => void;
  private onBack: () => void;
  private startBtn: HTMLButtonElement;
  private activity = new Map<DeviceId, number>();

  constructor(game: GameMeta, firstDevice: DeviceId, onStart: (players: SessionPlayers) => void, onBack: () => void) {
    this.game = game;
    this.onStart = onStart;
    this.onBack = onBack;
    this.slots = new Array(Math.min(4, game.players)).fill(null);
    this.slots[0] = firstDevice;
    this.ports = h('div.ports');
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
      h('div.lobby-actions', this.startBtn, button({ label: 'Back', icon: 'chevronL', onClick: () => this.onBack() })),
      hintBar([
        { glyph: 'cross', label: 'Join' },
        { glyph: 'circle', label: 'Leave / Back' },
        { glyph: 'triangle', label: 'Swap port' },
      ]),
    );
  }

  mount() {
    this.render();
    input.onFrame = (pads) => this.pulse(pads);
  }
  unmount() {
    input.onFrame = null;
  }

  private render() {
    clear(this.ports);
    this.slots.forEach((dev, i) => {
      const port = h(
        `div.port.${COLORS[i]}${dev ? '.filled' : ''}`,
        h('div.port-num', `${i + 1}`),
        h('div.port-art', dev === 'kb' ? icon('keyboard') : dev ? h('img', { src: '/assets/hero-controller.png', alt: '' }) : h('div.port-empty-ring')),
        h('div.port-label', dev ? deviceLabel(dev) : 'Press a button to join'),
        h('div.port-sub', dev ? `Player ${i + 1}` : 'Open port'),
        h('div.port-activity'),
      );
      this.ports.appendChild(port);
    });
    const n = this.slots.filter(Boolean).length;
    this.startBtn.querySelector('.btn-label')!.textContent = n > 1 ? `Start · ${n} Players` : 'Start · 1 Player';
    this.startBtn.classList.add('focused');
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
      if (!el) return;
      const active = dev && now - (this.activity.get(dev) ?? 0) < 120;
      el.classList.toggle('active', !!active);
    });
  }

  private join(dev: DeviceId) {
    if (this.slots.includes(dev)) return;
    const free = this.slots.indexOf(null);
    if (free < 0) {
      sfx.error();
      app.toast('All ports are taken', 'warn', 1400);
      return;
    }
    this.slots[free] = dev;
    sfx.join();
    this.render();
  }

  private leave(dev: DeviceId) {
    const i = this.slots.indexOf(dev);
    if (i < 0) return;
    if (i === 0) {
      // Player 1 leaving means going back.
      this.onBack();
      return;
    }
    this.slots[i] = null;
    sfx.leave();
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
}

export { GP };
