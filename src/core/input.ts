/**
 * Unified navigation input. Keyboard, every connected gamepad, and the mouse all produce
 * the same NavEvents so every screen is driven by one handler. Each event carries the
 * device that produced it, which lets the lobby do "press any button to join".
 */
import type { DeviceId, NavAction, NavEvent } from './types';

type Listener = (e: NavEvent) => void;

const REPEAT_DELAY = 380;
const REPEAT_RATE = 110;
const DEADZONE = 0.55;

// Standard Gamepad mapping (https://w3c.github.io/gamepad/#remapping)
export const GP = {
  A: 0, // Cross
  B: 1, // Circle
  X: 2, // Square
  Y: 3, // Triangle
  L1: 4,
  R1: 5,
  L2: 6,
  R2: 7,
  SELECT: 8,
  START: 9,
  L3: 10,
  R3: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
  HOME: 16,
};

class InputService {
  private listeners = new Set<Listener>();
  private prevButtons = new Map<number, boolean[]>();
  private prevAxisDir = new Map<number, { x: number; y: number }>();
  private held = new Map<string, { since: number; last: number }>();
  private raf = 0;
  private _suspended = false;
  /** When set, every keydown/mousedown goes here exclusively (used to capture new bindings). */
  capture: ((e: KeyboardEvent | MouseEvent | WheelEvent) => void) | null = null;
  /** Devices seen at least once (gamepads only report through getGamepads). */
  readonly gamepads = new Map<number, string>();
  onGamepadsChanged: (() => void) | null = null;
  /** Fires with the raw gamepad snapshot every frame (used by the lobby "controller test"). */
  onFrame: ((pads: (Gamepad | null)[]) => void) | null = null;

  start() {
    window.addEventListener('keydown', this.onKeyDown, { capture: true });
    window.addEventListener('keyup', this.onKeyUp, { capture: true });
    window.addEventListener('mousedown', this.onMouseDown, { capture: true });
    window.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    window.addEventListener('contextmenu', (e) => {
      if (this.capture || this._suspended) e.preventDefault();
    });
    window.addEventListener('gamepadconnected', this.refreshPads);
    window.addEventListener('gamepaddisconnected', this.refreshPads);
    this.refreshPads();
    this.loop();
  }

  /** While the emulator has focus we stop translating input into navigation. */
  set suspended(v: boolean) {
    this._suspended = v;
    this.held.clear();
  }
  get suspended() {
    return this._suspended;
  }

  on(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: NavEvent) {
    for (const l of [...this.listeners]) l(e);
  }

  private refreshPads = () => {
    const before = [...this.gamepads.keys()].join(',');
    this.gamepads.clear();
    for (const p of navigator.getGamepads?.() ?? []) if (p) this.gamepads.set(p.index, p.id);
    if ([...this.gamepads.keys()].join(',') !== before) this.onGamepadsChanged?.();
  };

  private keyAction(e: KeyboardEvent): NavAction | null {
    switch (e.key) {
      case 'ArrowUp':
      case 'w':
      case 'W':
        return 'up';
      case 'ArrowDown':
      case 's':
      case 'S':
        return 'down';
      case 'ArrowLeft':
      case 'a':
      case 'A':
        return 'left';
      case 'ArrowRight':
      case 'd':
      case 'D':
        return 'right';
      case 'Enter':
      case ' ':
        return 'confirm';
      case 'Escape':
      case 'Backspace':
        return 'back';
      case 'Tab':
        return e.shiftKey ? 'prev' : 'next';
      case 'PageUp':
      case 'q':
      case 'Q':
        return 'prev';
      case 'PageDown':
      case 'e':
      case 'E':
        return 'next';
      case 'F1':
        return 'menu';
    }
    return null;
  }

  private onMouseDown = (e: MouseEvent) => {
    if (this.capture) {
      e.preventDefault();
      e.stopPropagation();
      this.capture(e);
    }
  };

  private onWheel = (e: WheelEvent) => {
    if (this.capture) {
      e.preventDefault();
      e.stopPropagation();
      this.capture(e);
    }
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.capture) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) this.capture(e);
      return;
    }
    if (this._suspended) {
      // Only the menu key escapes to the shell while a game runs.
      if (e.key === 'Escape' || e.key === 'F1') {
        e.preventDefault();
        if (!e.repeat) this.emit({ action: 'menu', device: 'kb', repeat: false, raw: e.key });
      }
      return;
    }
    const target = e.target as HTMLElement | null;
    const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
    // Inside a text field only the structural keys navigate; letters must reach the field.
    if (typing && !['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const action = this.keyAction(e);
    if (!action) {
      if (!e.repeat && !typing && e.key.length === 1) this.emit({ action: 'any', device: 'kb', repeat: false, raw: e.key });
      return;
    }
    e.preventDefault();
    this.emit({ action, device: 'kb', repeat: e.repeat, raw: e.key });
    if (!e.repeat) this.emit({ action: 'any', device: 'kb', repeat: false, raw: e.key });
  };

  private onKeyUp = (_e: KeyboardEvent) => {};

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const pads = navigator.getGamepads?.() ?? [];
    this.onFrame?.(pads);
    if (this.capture) return;
    if (this._suspended) {
      // Still watch for the "open menu" gesture: Home button, or Select+Start together.
      for (const p of pads) {
        if (!p) continue;
        const prev = this.prevButtons.get(p.index) ?? [];
        const home = p.buttons[GP.HOME]?.pressed && !prev[GP.HOME];
        const combo = p.buttons[GP.SELECT]?.pressed && p.buttons[GP.START]?.pressed && !(prev[GP.SELECT] && prev[GP.START]);
        if (home || combo) this.emit({ action: 'menu', device: `gp:${p.index}`, repeat: false });
        this.prevButtons.set(
          p.index,
          p.buttons.map((b) => b.pressed),
        );
      }
      return;
    }
    const now = performance.now();
    for (const p of pads) {
      if (!p) continue;
      const dev: DeviceId = `gp:${p.index}`;
      const prev = this.prevButtons.get(p.index) ?? [];
      const cur = p.buttons.map((b) => b.pressed);
      const map: [number, NavAction][] = [
        [GP.UP, 'up'],
        [GP.DOWN, 'down'],
        [GP.LEFT, 'left'],
        [GP.RIGHT, 'right'],
        [GP.A, 'confirm'],
        [GP.B, 'back'],
        [GP.START, 'start'],
        [GP.L1, 'prev'],
        [GP.R1, 'next'],
        [GP.HOME, 'menu'],
        [GP.Y, 'menu'],
      ];
      let anyPressed = false;
      for (const [btn, action] of map) {
        const key = `${dev}:${btn}`;
        if (cur[btn] && !prev[btn]) {
          this.emit({ action, device: dev, repeat: false });
          this.held.set(key, { since: now, last: now });
          anyPressed = true;
        } else if (cur[btn] && prev[btn]) {
          const hstate = this.held.get(key);
          if (hstate && ['up', 'down', 'left', 'right'].includes(action) && now - hstate.since > REPEAT_DELAY && now - hstate.last > REPEAT_RATE) {
            hstate.last = now;
            this.emit({ action, device: dev, repeat: true });
          }
        } else if (!cur[btn]) this.held.delete(key);
      }
      for (let i = 0; i < cur.length; i++) if (cur[i] && !prev[i]) anyPressed = true;
      if (anyPressed) this.emit({ action: 'any', device: dev, repeat: false });

      // Left stick as a d-pad with auto repeat.
      const ax = p.axes[0] ?? 0;
      const ay = p.axes[1] ?? 0;
      const dir = { x: Math.abs(ax) > DEADZONE ? Math.sign(ax) : 0, y: Math.abs(ay) > DEADZONE ? Math.sign(ay) : 0 };
      const pd = this.prevAxisDir.get(p.index) ?? { x: 0, y: 0 };
      for (const axis of ['x', 'y'] as const) {
        const key = `${dev}:axis:${axis}`;
        const action: NavAction = axis === 'x' ? (dir[axis] > 0 ? 'right' : 'left') : dir[axis] > 0 ? 'down' : 'up';
        if (dir[axis] !== 0 && dir[axis] !== pd[axis]) {
          this.emit({ action, device: dev, repeat: false });
          this.held.set(key, { since: now, last: now });
        } else if (dir[axis] !== 0) {
          const hstate = this.held.get(key);
          if (hstate && now - hstate.since > REPEAT_DELAY && now - hstate.last > REPEAT_RATE) {
            hstate.last = now;
            this.emit({ action, device: dev, repeat: true });
          }
        } else this.held.delete(key);
      }
      this.prevAxisDir.set(p.index, dir);
      this.prevButtons.set(p.index, cur);
    }
  };

  stop() {
    cancelAnimationFrame(this.raf);
  }
}

export const input = new InputService();

export function deviceLabel(dev: DeviceId): string {
  if (dev === 'kb') return 'Keyboard';
  const idx = Number(dev.slice(3));
  const id = input.gamepads.get(idx) ?? 'Controller';
  return prettyPadName(id);
}

export function prettyPadName(id: string): string {
  const s = id.toLowerCase();
  if (/dualsense|054c.*0ce6/.test(s)) return 'DualSense';
  if (/dualshock|wireless controller|054c/.test(s)) return 'DualShock';
  if (/xbox|045e|xinput/.test(s)) return 'Xbox Controller';
  if (/pro controller|057e/.test(s)) return 'Switch Pro';
  if (/8bitdo/.test(s)) return '8BitDo';
  return id.replace(/\s*\(.*$/, '').slice(0, 22) || 'Controller';
}
