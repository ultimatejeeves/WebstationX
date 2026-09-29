/**
 * Virtual gamepads for remote players.
 *
 * The emulator (RetroArch's Emscripten build) reads controllers through `navigator.getGamepads()`
 * every frame and learns about new pads from `gamepadconnected` events. Its web joypad driver
 * only looks at gamepad indices 0-3 (DEFAULT_MAX_PADS is 4 on Emscripten), so virtual pads
 * take whichever of those four slots no real controller is using. We wrap `getGamepads` so
 * those slots report our pads; the host lobby then pins each remote device to a RetroArch
 * port through the pad's index, exactly like a locally plugged-in controller.
 *
 * The shell's own navigation code uses `realGetGamepads` so remote players never drive menus.
 */

/** Gamepad slots the emulator can see. Four total, shared between local and remote pads. */
export const PAD_SLOTS = 4;

class VirtualButton implements GamepadButton {
  pressed = false;
  touched = false;
  value = 0;
}

export class VirtualPad {
  readonly id: string;
  readonly index: number;
  readonly mapping: GamepadMappingType = 'standard';
  readonly buttons: VirtualButton[] = Array.from({ length: 17 }, () => new VirtualButton());
  readonly axes: number[] = [0, 0, 0, 0];
  readonly hapticActuators: never[] = [];
  readonly vibrationActuator = null;
  connected = true;
  timestamp = performance.now();
  /** Last time a button or stick was non-neutral (for the lobby's activity glow). */
  lastActive = 0;
  /** Sequence number of the last packet applied; used to ignore out-of-order packets. */
  private lastSeq = -1;

  constructor(index: number, label: string) {
    this.index = index;
    // Look like a common pad with the standard mapping so RetroArch autoconfigures it.
    this.id = `${label} (STANDARD GAMEPAD Vendor: 045e Product: 028e)`;
  }

  /** Apply a packed state from the network. Returns false if the packet was stale. */
  set(buttons: number, axes: readonly number[], seq: number): boolean {
    if (this.lastSeq >= 0) {
      const delta = (seq - this.lastSeq + 256) % 256;
      if (delta === 0 || delta > 128) return false; // duplicate or older than what we have
    }
    this.lastSeq = seq;
    let active = false;
    for (let i = 0; i < 16; i++) {
      const on = (buttons >> i) & 1 ? true : false;
      const b = this.buttons[i];
      b.pressed = on;
      b.touched = on;
      b.value = on ? 1 : 0;
      active ||= on;
    }
    for (let i = 0; i < 4; i++) {
      const v = Math.max(-1, Math.min(1, axes[i] ?? 0));
      this.axes[i] = v;
      active ||= Math.abs(v) > 0.3;
    }
    this.timestamp = performance.now();
    if (active) this.lastActive = this.timestamp;
    return true;
  }

  neutral() {
    for (const b of this.buttons) {
      b.pressed = false;
      b.touched = false;
      b.value = 0;
    }
    this.axes.fill(0);
    this.timestamp = performance.now();
  }
}

const pads: (VirtualPad | null)[] = new Array(PAD_SLOTS).fill(null);
let installed = false;
let realFn: (() => (Gamepad | null)[]) | null = null;

/** The browser's own getGamepads, unaffected by our virtual pads. */
export function realGetGamepads(): (Gamepad | null)[] {
  if (realFn) return realFn();
  return navigator.getGamepads?.() ?? [];
}

export function installVirtualPads() {
  if (installed || typeof navigator === 'undefined' || !navigator.getGamepads) return;
  installed = true;
  const orig = navigator.getGamepads.bind(navigator);
  realFn = () => orig() as (Gamepad | null)[];
  // Test hooks (used by tools/*.mjs).
  Object.assign(window as unknown as Record<string, unknown>, { __wsxVirtualPads: virtualPads, __wsxAllocVirtualPad: allocateVirtualPad, __wsxReleaseVirtualPad: releaseVirtualPad });
  // Nostalgist re-announces every pad at launch with `new GamepadEvent(type, { gamepad })`,
  // which rejects anything that is not a native Gamepad. Hand out a plain event instead.
  const RealGamepadEvent = window.GamepadEvent;
  const NativeGamepad = window.Gamepad;
  if (RealGamepadEvent) {
    const Patched = function (this: unknown, type: string, init?: GamepadEventInit) {
      if (init?.gamepad && !(NativeGamepad && init.gamepad instanceof NativeGamepad)) {
        const ev = new Event(type, init);
        Object.defineProperty(ev, 'gamepad', { value: init.gamepad, enumerable: true });
        return ev;
      }
      return new RealGamepadEvent(type, init as GamepadEventInit);
    } as unknown as typeof GamepadEvent;
    Patched.prototype = RealGamepadEvent.prototype;
    window.GamepadEvent = Patched;
  }
  navigator.getGamepads = function patchedGetGamepads(): (Gamepad | null)[] {
    const real = orig() as (Gamepad | null)[];
    if (portMap) {
      // While a game runs, slot N-1 holds whatever device plays port N (see setPortMap).
      return portMap.map((src, slot) => {
        if (!src) return null;
        if (src.kind === 'virtual') return src.pad.connected ? viewOf(src.pad, slot) : null;
        const g = real[src.realIndex];
        return g ? viewOf(g, slot) : null;
      });
    }
    if (!pads.some(Boolean)) return real;
    const out: (Gamepad | null)[] = [];
    for (let i = 0; i < Math.max(PAD_SLOTS, real.length); i++) out.push((pads[i] as unknown as Gamepad | null) ?? real[i] ?? null);
    return out;
  };
  // While the port map is active, native hotplug events would tell the emulator about the
  // browser's slot numbers, which no longer match ours. Swallow them; the map is fixed per game.
  if (RealGamepadEvent)
    for (const type of ['gamepadconnected', 'gamepaddisconnected'] as const)
      window.addEventListener(
        type,
        (e) => {
          if (portMap && e instanceof RealGamepadEvent) e.stopImmediatePropagation();
        },
        { capture: true },
      );
}

function dispatch(type: 'gamepadconnected' | 'gamepaddisconnected', pad: VirtualPad) {
  const ev = new Event(type);
  Object.defineProperty(ev, 'gamepad', { value: pad, enumerable: true });
  window.dispatchEvent(ev);
}

/** Create a virtual pad in a free slot, or null when all four slots hold a controller. */
export function allocateVirtualPad(label: string): VirtualPad | null {
  installVirtualPads();
  // Any free virtual slot will do: the port map relocates pads to their port's slot at launch.
  let slot = -1;
  for (let i = 0; i < PAD_SLOTS; i++) {
    if (!pads[i]) {
      slot = i;
      break;
    }
  }
  if (slot < 0) return null;
  const pad = new VirtualPad(slot, label);
  pads[slot] = pad;
  dispatch('gamepadconnected', pad);
  return pad;
}

/** True when a remote player's virtual pad currently occupies this gamepad index. */
export function slotTakenByVirtualPad(index: number): boolean {
  return !!pads[index];
}

export function releaseVirtualPad(pad: VirtualPad) {
  const slot = pad.index;
  if (pads[slot] !== pad) return;
  pad.neutral();
  pad.connected = false;
  pads[slot] = null;
  dispatch('gamepaddisconnected', pad);
}

export function virtualPads(): VirtualPad[] {
  return pads.filter((p): p is VirtualPad => !!p);
}

/* ---------- Port map: gamepad slot N-1 <-> emulator port N ----------
 * RetroArch's web joypad driver reads the gamepad at the same index as the port it is
 * polling, regardless of the configured joypad index. So for the game's lifetime we present
 * the pad chosen for port N in slot N-1, whatever slot the browser or the lobby gave it. */
type SlotSource = { kind: 'real'; realIndex: number } | { kind: 'virtual'; pad: VirtualPad } | null;
let portMap: SlotSource[] | null = null;

/** A Gamepad-shaped snapshot of `g` that claims to live in `slot`. */
function viewOf(g: Gamepad | VirtualPad, slot: number): Gamepad {
  return {
    id: g.id,
    index: slot,
    connected: g.connected,
    mapping: g.mapping,
    timestamp: g.timestamp,
    buttons: g.buttons,
    axes: g.axes,
    hapticActuators: (g as unknown as { hapticActuators?: unknown[] }).hapticActuators ?? [],
    vibrationActuator: (g as Gamepad).vibrationActuator ?? null,
  } as unknown as Gamepad;
}

/** Devices per port (index 0 = port 1): 'gp:N' local pad, 'net:..' remote pad, 'kb'/null = no pad. */
export function setPortMap(players: (string | null)[]) {
  installVirtualPads();
  const map: SlotSource[] = [];
  for (let i = 0; i < Math.max(PAD_SLOTS, players.length); i++) {
    const dev = players[i] ?? null;
    if (dev?.startsWith('gp:')) map.push({ kind: 'real', realIndex: Number(dev.slice(3)) });
    else if (dev?.startsWith('net:')) {
      const pad = devicePads.get(dev);
      map.push(pad ? { kind: 'virtual', pad } : null);
    } else map.push(null);
  }
  portMap = map;
}

export function clearPortMap() {
  portMap = null;
}

export function portMapActive() {
  return !!portMap;
}

/* Which virtual pad backs a `net:` device id (set by the host session, read at launch). */
const devicePads = new Map<string, VirtualPad>();
export function bindDevicePad(dev: string, pad: VirtualPad) {
  devicePads.set(dev, pad);
}
export function unbindDevicePad(dev: string) {
  devicePads.delete(dev);
}
export function padIndexFor(dev: string): number | null {
  return devicePads.get(dev)?.index ?? null;
}
export function padFor(dev: string): VirtualPad | null {
  return devicePads.get(dev) ?? null;
}
