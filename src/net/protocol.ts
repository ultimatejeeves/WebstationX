/**
 * Wire protocol between the host browser and remote players.
 *
 * Two WebRTC data channels per peer:
 *   "ctl"  reliable, ordered   — lobby state, phase changes, pings (JSON)
 *   "in"   unreliable, unordered — controller state, one small packet per device per frame
 *
 * Video and audio ride on ordinary WebRTC media tracks from the host.
 */
import type { DeviceId } from '../core/types';

export type Phase = 'lobby' | 'loading' | 'playing' | 'paused' | 'ended';

export type LobbyGame = { id: string; title: string; coverUrl: string | null; players: number };

export type LobbySnapshot = {
  game: LobbyGame;
  hostName: string;
  /** One entry per port; `dev` is the host-side device id, `label` what to show. */
  slots: { dev: DeviceId | null; label: string }[];
  phase: Phase;
};

/** Peer -> host on the control channel. */
export type PeerCtl =
  | { t: 'hello'; name: string }
  | { t: 'join'; ord: number; label: string }
  | { t: 'leave'; ord: number }
  | { t: 'swap'; ord: number }
  | { t: 'ping'; ts: number };

/** Host -> peer on the control channel. */
export type HostCtl =
  | { t: 'lobby'; snapshot: LobbySnapshot }
  | { t: 'phase'; phase: Phase; game?: LobbyGame }
  | { t: 'pong'; ts: number }
  | { t: 'toast'; text: string }
  | { t: 'bye'; reason: string };

/**
 * A remote device is `net:<peerId>:<ord>` where `ord` identifies the device on the remote
 * machine: 0 = keyboard/mouse, 1..4 = gamepad index 0..3.
 */
export type NetDevice = `net:${string}`;
export const isNetDevice = (d: DeviceId | null | undefined): d is NetDevice => !!d && d.startsWith('net:');
export const netDevice = (peer: string, ord: number): NetDevice => `net:${peer}:${ord}`;
export function parseNetDevice(d: DeviceId): { peer: string; ord: number } | null {
  if (!isNetDevice(d)) return null;
  const [, peer, ord] = d.split(':');
  return { peer, ord: Number(ord) };
}
export const ordOfLocal = (dev: DeviceId): number => (dev === 'kb' ? 0 : Number(dev.slice(3)) + 1);
export const localOfOrd = (ord: number): DeviceId => (ord === 0 ? 'kb' : `gp:${ord - 1}`);

/* ---------- Input packets ---------- */

export const INPUT_PACKET_BYTES = 8;

/**
 * Pack one device's state: [ord u8][buttons u16 LE][lx ly rx ry i8][seq u8].
 * Buttons follow the W3C standard gamepad order (0 = Cross ... 15 = D-right, 16 = Home).
 */
export function packInput(out: DataView, ord: number, buttons: number, axes: readonly number[], seq: number) {
  out.setUint8(0, ord);
  out.setUint16(1, buttons & 0xffff, true);
  for (let i = 0; i < 4; i++) out.setInt8(3 + i, Math.max(-127, Math.min(127, Math.round((axes[i] ?? 0) * 127))));
  out.setUint8(7, seq & 0xff);
}

export function unpackInput(buf: ArrayBuffer): { ord: number; buttons: number; axes: number[]; seq: number } | null {
  if (buf.byteLength < INPUT_PACKET_BYTES) return null;
  const v = new DataView(buf);
  const axes: number[] = [];
  for (let i = 0; i < 4; i++) axes.push(v.getInt8(3 + i) / 127);
  return { ord: v.getUint8(0), buttons: v.getUint16(1, true), axes, seq: v.getUint8(7) };
}
