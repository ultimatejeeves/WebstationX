/**
 * Controller input for the PS2 core.
 *
 * The Play! core has no input layer of its own in our build: every few milliseconds we sample the
 * device assigned to each of the console's two ports (a local gamepad, a remote player's virtual
 * pad, or the keyboard/mouse with the profile's bindings) and hand the core a packed DualShock 2
 * state. Rumble reported by the game is played back on local controllers.
 */
import type { DeviceId } from '../../core/types';
import { codeToRetroKey, isMouseBinding, mouseButtonToRetro, type Keymap, type PsxButton } from '../keymap';
import { padFor, realGetGamepads } from '../virtual-pads';

/** Bit numbers of PS2::CControllerInfo::BUTTON in the core. */
const BIT: Partial<Record<PsxButton, number>> = {
  up: 4,
  down: 5,
  left: 6,
  right: 7,
  select: 8,
  start: 9,
  y: 10, // Square
  x: 11, // Triangle
  a: 12, // Circle
  b: 13, // Cross
  l: 14,
  l2: 15,
  l3: 16,
  r: 17,
  r2: 18,
  r3: 19,
};

/** W3C standard gamepad button index -> core bit. */
const STD_BITS: [number, number][] = [
  [0, 13], // A -> Cross
  [1, 12], // B -> Circle
  [2, 10], // X -> Square
  [3, 11], // Y -> Triangle
  [4, 14], // LB -> L1
  [5, 17], // RB -> R1
  [6, 15], // LT -> L2
  [7, 18], // RT -> R2
  [8, 8], // Back -> Select
  [9, 9], // Start
  [10, 16], // L3
  [11, 19], // R3
  [12, 4],
  [13, 5],
  [14, 6],
  [15, 7],
];

const NEUTRAL_AXES = 0x80808080;
const PORTS = 2;
const TICK_MS = 4;

export type PadCore = {
  setPadState(pad: number, buttons: number, axes: number): void;
  getVibration(pad: number): number;
};

type PadLike = { buttons: readonly { pressed: boolean; value: number }[]; axes: readonly number[] };

function axisByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round((v + 1) * 127.5)));
}

/** Packs a stick pair with a small radial deadzone (worn sticks drift). */
function stick(x: number, y: number): [number, number] {
  const mag = Math.hypot(x, y);
  if (mag < 0.12) return [0x80, 0x80];
  return [axisByte(x), axisByte(y)];
}

function fromGamepad(p: PadLike): { buttons: number; axes: number } {
  let buttons = 0;
  for (const [i, bit] of STD_BITS) {
    const b = p.buttons[i];
    if (b && (b.pressed || b.value > 0.5)) buttons |= 1 << bit;
  }
  const [lx, ly] = stick(p.axes[0] ?? 0, p.axes[1] ?? 0);
  const [rx, ry] = stick(p.axes[2] ?? 0, p.axes[3] ?? 0);
  return { buttons, axes: (lx | (ly << 8) | (rx << 16) | (ry << 24)) >>> 0 };
}

export class Ps2Pads {
  private core: PadCore;
  private players: (DeviceId | null)[];
  private keymap: Keymap;
  private target: HTMLElement;
  private keys = new Set<string>(); // RetroArch key names held
  private mouse = new Set<number>(); // RetroArch mouse button numbers held
  private timer = 0;
  private lastRumble: number[] = [0, 0];
  private rumbleAt: number[] = [0, 0];
  /** Port that also takes the keyboard binds (solo play with a controller), or -1. */
  private keyboardPort: number;

  constructor(core: PadCore, players: (DeviceId | null)[], keymap: Keymap, target: HTMLElement) {
    this.core = core;
    this.players = players.slice(0, PORTS);
    this.keymap = keymap;
    this.target = target;
    const active = this.players.filter(Boolean);
    const kbPort = this.players.indexOf('kb');
    const soloLocalPad = active.length === 1 && active[0] !== 'kb' && !String(active[0]).startsWith('net:');
    this.keyboardPort = kbPort >= 0 ? kbPort : soloLocalPad ? this.players.findIndex(Boolean) : -1;
  }

  start() {
    this.target.addEventListener('keydown', this.onKey);
    this.target.addEventListener('keyup', this.onKey);
    this.target.addEventListener('mousedown', this.onMouse);
    this.target.addEventListener('mouseup', this.onMouse);
    this.target.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('blur', this.releaseAll);
    this.timer = window.setInterval(this.tick, TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.target.removeEventListener('keydown', this.onKey);
    this.target.removeEventListener('keyup', this.onKey);
    this.target.removeEventListener('mousedown', this.onMouse);
    this.target.removeEventListener('mouseup', this.onMouse);
    this.target.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('blur', this.releaseAll);
    this.releaseAll();
    for (let p = 0; p < PORTS; p++) this.core.setPadState(p, 0, NEUTRAL_AXES);
  }

  /** Neutral pads, e.g. while the pause menu is open. */
  releaseAll = () => {
    this.keys.clear();
    this.mouse.clear();
  };

  private onKey = (e: KeyboardEvent) => {
    const k = codeToRetroKey(e.code);
    if (!k) return;
    if (e.type === 'keydown') this.keys.add(k);
    else this.keys.delete(k);
    if (this.isBound(k)) e.preventDefault();
  };

  private onMouse = (e: MouseEvent) => {
    const b = mouseButtonToRetro(e.button);
    if (b === null) return;
    if (e.type === 'mousedown') this.mouse.add(b);
    else this.mouse.delete(b);
  };

  private onContextMenu = (e: Event) => {
    if (Object.values(this.keymap).some(isMouseBinding)) e.preventDefault();
  };

  private isBound(k: string) {
    return Object.values(this.keymap).includes(k);
  }

  private held(binding: string): boolean {
    if (!binding || binding === 'nul') return false;
    if (isMouseBinding(binding)) return this.mouse.has(Number(binding.slice(6)));
    return this.keys.has(binding);
  }

  private fromKeyboard(): { buttons: number; axes: number } {
    let buttons = 0;
    for (const [id, bit] of Object.entries(BIT) as [PsxButton, number][]) if (this.held(this.keymap[id])) buttons |= 1 << bit;
    const axis = (minus: PsxButton, plus: PsxButton) => (this.held(this.keymap[plus]) ? 255 : 0) - (this.held(this.keymap[minus]) ? 255 : 0);
    const byte = (v: number) => (v === 0 ? 0x80 : v > 0 ? 0xff : 0x00);
    const lx = byte(axis('l_x_minus', 'l_x_plus'));
    const ly = byte(axis('l_y_minus', 'l_y_plus'));
    const rx = byte(axis('r_x_minus', 'r_x_plus'));
    const ry = byte(axis('r_y_minus', 'r_y_plus'));
    return { buttons, axes: (lx | (ly << 8) | (rx << 16) | (ry << 24)) >>> 0 };
  }

  private tick = () => {
    const real = realGetGamepads();
    for (let port = 0; port < PORTS; port++) {
      const dev = this.players[port] ?? null;
      let state = { buttons: 0, axes: NEUTRAL_AXES };
      let local: Gamepad | null = null;
      if (dev?.startsWith('gp:')) {
        local = real[Number(dev.slice(3))] ?? null;
        if (local) state = fromGamepad(local);
      } else if (dev?.startsWith('net:')) {
        const vp = padFor(dev);
        if (vp) state = fromGamepad(vp);
      }
      if (port === this.keyboardPort) {
        const kb = this.fromKeyboard();
        state.buttons |= kb.buttons;
        if (kb.axes !== NEUTRAL_AXES) state.axes = kb.axes;
      }
      this.core.setPadState(port, state.buttons, state.axes);
      if (local) this.rumble(port, local);
    }
  };

  private rumble(port: number, pad: Gamepad) {
    const v = this.core.getVibration(port);
    const now = performance.now();
    // Re-send while active: effects have a duration, and games often hold a constant rumble.
    if (v === this.lastRumble[port] && (v === 0 || now - this.rumbleAt[port] < 80)) return;
    this.lastRumble[port] = v;
    this.rumbleAt[port] = now;
    const actuator = (pad as Gamepad & { vibrationActuator?: { playEffect?: (t: string, p: object) => Promise<unknown> } }).vibrationActuator;
    if (!actuator?.playEffect) return;
    const large = (v & 0xff) / 255;
    const small = (v >> 8) & 0xff ? 1 : 0;
    void actuator.playEffect('dual-rumble', { duration: 120, strongMagnitude: large, weakMagnitude: small }).catch(() => {});
  }
}
