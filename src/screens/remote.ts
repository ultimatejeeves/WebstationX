/**
 * Remote player screen. Joins a friend's session with a code, shows the host's lobby while
 * ports are being picked, then plays the host's video/audio stream full screen and sends
 * this machine's controller state back.
 *
 * Several people can share one remote machine: every local device (keyboard, each pad)
 * joins separately and gets its own port on the host.
 */
import { app, type Screen } from '../core/app';
import { clear, h, icon } from '../core/dom';
import { deviceLabel, input, GP } from '../core/input';
import { sfx } from '../core/sfx';
import { store } from '../core/store';
import type { DeviceId, NavEvent } from '../core/types';
import { codeToRetroKey, mouseButtonToRetro, wheelToRetro, type PsxButton } from '../emu/keymap';
import { realGetGamepads } from '../emu/virtual-pads';
import type { ClientSession } from '../net/online';
import type { LobbySnapshot, Phase } from '../net/protocol';
import { button, confirmDialog, Dialog, hintBar } from '../ui/components';

const COLORS = ['p1', 'p2', 'p3', 'p4'];

/** PSX button -> bit in the standard-gamepad button mask. */
const BIT: Partial<Record<PsxButton, number>> = {
  b: GP.A,
  a: GP.B,
  y: GP.X,
  x: GP.Y,
  l: GP.L1,
  r: GP.R1,
  l2: GP.L2,
  r2: GP.R2,
  select: GP.SELECT,
  start: GP.START,
  l3: GP.L3,
  r3: GP.R3,
  up: GP.UP,
  down: GP.DOWN,
  left: GP.LEFT,
  right: GP.RIGHT,
};
/** PSX stick directions -> [axis index, sign]. */
const AXIS: Partial<Record<PsxButton, [number, number]>> = {
  l_x_minus: [0, -1],
  l_x_plus: [0, 1],
  l_y_minus: [1, -1],
  l_y_plus: [1, 1],
  r_x_minus: [2, -1],
  r_x_plus: [2, 1],
  r_y_minus: [3, -1],
  r_y_plus: [3, 1],
};

export class RemoteScreen implements Screen {
  name = 'remote';
  el: HTMLElement;
  private client: ClientSession;
  private onLeave: () => void;
  private video: HTMLVideoElement;
  private videoWrap: HTMLElement;
  private room: HTMLElement;
  private roomPorts: HTMLElement;
  private roomStatus: HTMLElement;
  private overlay: HTMLElement;
  private joined = new Set<DeviceId>();
  private kbHeld = new Set<PsxButton>();
  private wheelPulse = new Map<PsxButton, number>();
  private raf = 0;
  private playing = false;
  private menu: Dialog | null = null;
  private unsubs: (() => void)[] = [];
  private left = false;
  private lastSnapshot: LobbySnapshot | null = null;

  constructor(client: ClientSession, onLeave: () => void) {
    this.client = client;
    this.onLeave = onLeave;
    this.video = h('video.game-canvas.remote-video', { autoplay: true, playsinline: true }) as HTMLVideoElement;
    this.videoWrap = h('div.canvas-wrap', this.video, h('div.crt-overlay'));
    this.roomPorts = h('div.ports.ports-remote');
    this.roomStatus = h('div.remote-status', 'Connecting to host…');
    this.room = h(
      'div.remote-room',
      h('div.lobby-kicker', 'ONLINE SESSION'),
      h('h1.title-glow', client.game?.title ?? 'Waiting for host'),
      h('p.subtitle', h('b', client.hostName), "'s console · press any button on your controller or keyboard to take a port"),
      this.roomPorts,
      this.roomStatus,
      h('div.lobby-actions', button({ label: 'Leave session', icon: 'chevronL', onClick: () => void this.confirmLeave() })),
      hintBar([
        { glyph: 'cross', label: 'Join' },
        { glyph: 'circle', label: 'Leave port' },
        { glyph: 'triangle', label: 'Swap port' },
      ]),
    );
    this.overlay = h('div.remote-overlay');
    this.el = h('div.play.remote', h('div.bg-play'), this.videoWrap, this.room, this.overlay);
  }

  async mount() {
    this.applyPictureSettings();
    this.unsubs.push(store.subscribe(() => this.applyPictureSettings()));
    window.addEventListener('resize', this.fitVideo);
    this.fitVideo();
    const c = this.client;
    c.onStream = (s) => {
      if (this.video.srcObject !== s) this.video.srcObject = s;
      void this.tryPlay();
    };
    c.onLobby = (snap) => this.renderRoom(snap);
    c.onPhase = (p) => this.setPhase(p);
    c.onToast = (t) => app.toast(t, 'warn');
    c.onConnection = (state) => {
      if (state === 'connected') this.roomStatus.textContent = 'Connected. Press a button to join.';
      else if (state === 'connecting' || state === 'new') this.roomStatus.textContent = 'Connecting to host…';
      else this.roomStatus.textContent = `Connection: ${state}`;
    };
    c.onClosed = (reason) => this.ended(reason);
    if (c.snapshot) this.renderRoom(c.snapshot);
    this.setPhase(c.phase);
    if (c.connected) this.roomStatus.textContent = 'Connected. Press a button to join.';
    (window as unknown as { __wsx: unknown }).__wsx = { remote: this, client: c };
  }

  unmount() {
    this.left = true;
    cancelAnimationFrame(this.raf);
    this.stopCapture();
    window.removeEventListener('resize', this.fitVideo);
    for (const u of this.unsubs) u();
    input.suspended = false;
    this.client.onStream = this.client.onLobby = this.client.onPhase = this.client.onToast = this.client.onClosed = this.client.onConnection = null;
    this.client.close();
  }

  /* ---------- Waiting room ---------- */

  private renderRoom(snap: LobbySnapshot) {
    this.lastSnapshot = snap;
    this.room.querySelector('h1')!.textContent = snap.game.title;
    clear(this.roomPorts);
    snap.slots.forEach((s, i) => {
      const mine = this.joined.size > 0 && [...this.joined].some((d) => this.client.netDeviceOf(d) === s.dev);
      this.roomPorts.appendChild(
        h(
          `div.port.port-sm.${COLORS[i]}${s.dev ? '.filled' : ''}${mine ? '.mine' : ''}`,
          h('div.port-num', `${i + 1}`),
          h('div.port-label', s.dev ? s.label : 'Open port'),
          h('div.port-sub', mine ? 'You' : s.dev ? `Player ${i + 1}` : ''),
        ),
      );
    });
  }

  private setPhase(p: Phase) {
    this.el.dataset.phase = p;
    clear(this.overlay);
    if (p === 'playing') {
      this.startPlaying();
    } else {
      this.stopPlaying();
      if (p === 'loading') this.overlay.append(h('div.remote-overlay-card', h('div.loader-text', 'Host is starting the game…')));
      else if (p === 'paused') this.overlay.append(h('div.remote-overlay-card', icon('pause'), h('div.loader-text', 'Paused by host')));
      else if (p === 'lobby' && this.joined.size) this.roomStatus.textContent = 'Back in the lobby';
    }
    if (p === 'paused') {
      // The picture stays up behind the overlay; keep sending input so nothing sticks.
      this.el.classList.add('show-video');
    } else this.el.classList.toggle('show-video', p === 'playing');
  }

  private async confirmLeave() {
    if (await confirmDialog('Leave the session?', 'You can join again with the same code.', 'Leave')) this.leaveNow();
  }

  private leaveNow() {
    if (this.left) return;
    this.left = true;
    this.onLeave();
  }

  private ended(reason: string) {
    if (this.left) return;
    this.left = true;
    this.stopPlaying();
    const dlg = new Dialog({
      title: 'Session ended',
      body: reason,
      actions: [{ label: 'Back to library', icon: 'home', variant: 'primary', focusDefault: true, onClick: () => (dlg.close(), this.onLeave()) }],
      onCancel: () => (dlg.close(), this.onLeave()),
    });
    dlg.open();
  }

  /* ---------- Playing ---------- */

  private async tryPlay() {
    try {
      await this.video.play();
      this.overlay.querySelector('.tap-to-start')?.remove();
    } catch {
      // Autoplay with sound was blocked: one click fixes it.
      if (!this.overlay.querySelector('.tap-to-start'))
        this.overlay.append(
          h(
            'button.remote-overlay-card.tap-to-start',
            { type: 'button', onClick: () => void this.tryPlay() },
            icon('play'),
            h('div.loader-text', 'Click to start the picture and sound'),
          ),
        );
    }
  }

  private startPlaying() {
    if (this.playing) return;
    this.playing = true;
    input.suspended = true;
    this.startCapture();
    this.raf = requestAnimationFrame(this.tick);
    void this.tryPlay();
    if (this.joined.size === 0) app.toast('You are watching. Press a button in the lobby next time to play.', 'info', 3500);
    else app.toast('Esc or Select+Start opens the menu', 'info', 3000);
  }

  private stopPlaying() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.stopCapture();
    if (!this.menu) input.suspended = false;
    // Release everything on the host side so no button stays held.
    for (const d of this.joined) this.client.sendInput(d, 0, [0, 0, 0, 0]);
  }

  private tick = () => {
    this.raf = requestAnimationFrame(this.tick);
    if (!this.playing || this.menu) return;
    const pads = realGetGamepads();
    for (const dev of this.joined) {
      if (dev === 'kb') {
        this.client.sendInput('kb', this.kbMask(), this.kbAxes());
      } else {
        const p = pads[Number(dev.slice(3))];
        if (!p) continue;
        let mask = 0;
        for (let i = 0; i < 16 && i < p.buttons.length; i++) if (p.buttons[i].pressed) mask |= 1 << i;
        this.client.sendInput(dev, mask, [p.axes[0] ?? 0, p.axes[1] ?? 0, p.axes[2] ?? 0, p.axes[3] ?? 0]);
      }
    }
  };

  /* ---------- Keyboard & mouse -> PSX buttons (uses this player's own bindings) ---------- */

  private bindings(): Map<string, PsxButton[]> {
    const m = new Map<string, PsxButton[]>();
    for (const [btn, v] of Object.entries(store.prefs.keymap) as [PsxButton, string][]) {
      if (!v || v === 'nul') continue;
      m.set(v, [...(m.get(v) ?? []), btn]);
    }
    return m;
  }
  private bindCache: Map<string, PsxButton[]> | null = null;
  private lookup(v: string | null): PsxButton[] {
    if (!v) return [];
    if (!this.bindCache) this.bindCache = this.bindings();
    return this.bindCache.get(v) ?? [];
  }

  private kbMask(): number {
    let mask = 0;
    const now = performance.now();
    for (const b of this.kbHeld) {
      const bit = BIT[b];
      if (bit !== undefined) mask |= 1 << bit;
    }
    for (const [b, until] of this.wheelPulse) {
      if (until < now) this.wheelPulse.delete(b);
      else {
        const bit = BIT[b];
        if (bit !== undefined) mask |= 1 << bit;
      }
    }
    return mask;
  }
  private kbAxes(): number[] {
    const axes = [0, 0, 0, 0];
    const now = performance.now();
    const apply = (b: PsxButton) => {
      const a = AXIS[b];
      if (a) axes[a[0]] = a[1];
    };
    for (const b of this.kbHeld) apply(b);
    for (const [b, until] of this.wheelPulse) if (until >= now) apply(b);
    return axes;
  }

  private onKey = (e: KeyboardEvent) => {
    if (!this.playing || this.menu) return;
    if (e.key === 'Escape' || e.key === 'F1') return; // menu toggle belongs to the shell
    const key = codeToRetroKey(e.code);
    const btns = this.lookup(key);
    if (btns.length === 0) return;
    e.preventDefault();
    for (const b of btns) if (e.type === 'keydown') this.kbHeld.add(b);
    else this.kbHeld.delete(b);
  };
  private onMouse = (e: MouseEvent) => {
    if (!this.playing || this.menu) return;
    const n = mouseButtonToRetro(e.button);
    const btns = this.lookup(n === null ? null : `mouse:${n}`);
    if (btns.length === 0) return;
    e.preventDefault();
    for (const b of btns) if (e.type === 'mousedown') this.kbHeld.add(b);
    else this.kbHeld.delete(b);
  };
  private onWheel = (e: WheelEvent) => {
    if (!this.playing || this.menu) return;
    const n = wheelToRetro(e.deltaY, e.deltaX);
    const btns = this.lookup(n === null ? null : `mouse:${n}`);
    if (btns.length === 0) return;
    e.preventDefault();
    for (const b of btns) this.wheelPulse.set(b, performance.now() + 60);
  };
  private onBlur = () => {
    this.kbHeld.clear();
  };

  private startCapture() {
    this.bindCache = null;
    window.addEventListener('keydown', this.onKey, { capture: true });
    window.addEventListener('keyup', this.onKey, { capture: true });
    window.addEventListener('mousedown', this.onMouse, { capture: true });
    window.addEventListener('mouseup', this.onMouse, { capture: true });
    window.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    window.addEventListener('contextmenu', prevent);
    window.addEventListener('blur', this.onBlur);
  }
  private stopCapture() {
    window.removeEventListener('keydown', this.onKey, { capture: true });
    window.removeEventListener('keyup', this.onKey, { capture: true });
    window.removeEventListener('mousedown', this.onMouse, { capture: true });
    window.removeEventListener('mouseup', this.onMouse, { capture: true });
    window.removeEventListener('wheel', this.onWheel, { capture: true });
    window.removeEventListener('contextmenu', prevent);
    window.removeEventListener('blur', this.onBlur);
    this.kbHeld.clear();
  }

  /* ---------- Picture ---------- */

  private applyPictureSettings() {
    this.el.dataset.filter = store.prefs.filter;
    this.el.dataset.aspect = store.prefs.aspect;
    this.fitVideo();
  }

  private fitVideo = () => {
    const fill = store.prefs.aspect === 'fill';
    let w = window.innerWidth;
    let hgt = window.innerHeight;
    if (!fill) {
      if (w / hgt > 4 / 3) w = hgt * (4 / 3);
      else hgt = w * (3 / 4);
    }
    this.videoWrap.style.width = `${Math.floor(w)}px`;
    this.videoWrap.style.height = `${Math.floor(hgt)}px`;
  };

  /* ---------- Menu ---------- */

  private openMenu() {
    if (this.menu) return;
    input.suspended = false;
    const mine = [...this.joined];
    const info = h(
      'div.pause-body',
      h('div.pause-players', mine.length ? mine.map((d) => h('span.pill', icon(d === 'kb' ? 'keyboard' : 'pad'), deviceLabel(d))) : h('span.pill', 'Watching')),
      h('div.remote-stats', `Host: ${this.client.hostName} · Ping: ${this.client.rtt === null ? '…' : `${this.client.rtt} ms`}`),
    );
    const dlg = new Dialog({
      title: this.client.game?.title ?? 'Online session',
      body: info,
      actions: [
        { label: 'Resume', icon: 'play', variant: 'primary', focusDefault: true, onClick: () => this.closeMenu() },
        { label: 'Leave session', icon: 'home', variant: 'danger', onClick: () => (this.closeMenu(), this.leaveNow()) },
      ],
      onCancel: () => this.closeMenu(),
    });
    dlg.el.classList.add('pause-menu');
    this.menu = dlg;
    dlg.open();
    this.kbHeld.clear();
  }

  private closeMenu() {
    if (!this.menu) return;
    this.menu.close();
    this.menu = null;
    app.closeAllModals();
    if (this.playing) input.suspended = true;
    sfx.close();
  }

  /* ---------- Navigation ---------- */

  onNav(e: NavEvent) {
    const dev = e.device;
    if (this.playing) {
      if (e.action === 'menu') {
        if (this.menu) this.closeMenu();
        else this.openMenu();
      }
      return true;
    }
    if (e.action === 'any') {
      if (!this.joined.has(dev) && this.client.connected) {
        this.joined.add(dev);
        this.client.join(dev, deviceLabel(dev));
        sfx.join();
        if (this.lastSnapshot) this.renderRoom(this.lastSnapshot);
      }
      return true;
    }
    if (e.action === 'back') {
      if (this.joined.has(dev) && (dev !== 'kb' || e.raw === 'Backspace')) {
        this.joined.delete(dev);
        this.client.leave(dev);
        sfx.leave();
        if (this.lastSnapshot) this.renderRoom(this.lastSnapshot);
      } else void this.confirmLeave();
      return true;
    }
    if (e.action === 'menu' || ((e.action === 'left' || e.action === 'right') && !e.repeat)) {
      if (this.joined.has(dev)) this.client.swap(dev);
      return true;
    }
    return true;
  }
}

function prevent(e: Event) {
  e.preventDefault();
}
