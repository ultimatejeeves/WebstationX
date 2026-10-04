/**
 * Online sessions.
 *
 * Topology is a star: the browser that opened the lobby is the host. It runs the emulator,
 * streams its canvas + audio to every remote player over WebRTC, and receives their
 * controller state on an unreliable data channel. Each remote device becomes a virtual
 * gamepad on the host (emu/virtual-pads.ts), so the emulator sees ordinary controllers.
 *
 * The server only brokers the connection (net/signal.ts); once peers are connected it is
 * not on the media path. The host is always the offerer, so there is no negotiation glare.
 */
import { clearNetLabel, setNetLabel } from '../core/net-labels';
import { store } from '../core/store';
import type { DeviceId } from '../core/types';
import { captureAudioStream } from '../emu/audio-tap';
import { allocateVirtualPad, bindDevicePad, releaseVirtualPad, unbindDevicePad, type VirtualPad } from '../emu/virtual-pads';
import {
  INPUT_PACKET_BYTES,
  netDevice,
  ordOfLocal,
  packInput,
  parseNetDevice,
  unpackInput,
  type HostCtl,
  type LobbyGame,
  type LobbySnapshot,
  type NetDevice,
  type PeerCtl,
  type Phase,
} from './protocol';
import { SignalClient, type SignalMsg } from './signal';

// PS1 output is 240p/480p; 540p keeps it crisp while roughly halving encode work vs 720p.
const VIDEO_MAX_BITRATE = 5_000_000;
const VIDEO_TARGET_HEIGHT = 540;
const PING_MS = 2000;

function rtcConfig(): RTCConfiguration {
  return { iceServers: store.session.ice.length ? store.session.ice : [{ urls: 'stun:stun.l.google.com:19302' }], bundlePolicy: 'max-bundle' };
}

/** Put hardware-friendly, low-latency codecs first. */
function preferCodecs(transceiver: RTCRtpTransceiver) {
  try {
    const caps = RTCRtpSender.getCapabilities('video');
    if (!caps || !transceiver.setCodecPreferences) return;
    const score = (c: RTCRtpCodec) => {
      const m = c.mimeType.toLowerCase();
      const f = c.sdpFmtpLine ?? '';
      if (m === 'video/h264' && /packetization-mode=1/.test(f) && /42e01f/i.test(f)) return 0;
      if (m === 'video/h264') return 1;
      if (m === 'video/vp8') return 2;
      if (m === 'video/av1') return 3;
      if (m === 'video/vp9') return 4;
      return 9;
    };
    transceiver.setCodecPreferences([...caps.codecs].sort((a, b) => score(a) - score(b)));
  } catch {
    /* not supported; the browser default is fine */
  }
}

type Peer = {
  id: string;
  name: string;
  pc: RTCPeerConnection;
  ctl: RTCDataChannel;
  inp: RTCDataChannel;
  devices: Map<number, VirtualPad>;
  state: RTCPeerConnectionState;
  pending: RTCIceCandidateInit[];
};

/* ===================================================================== */
/*  Host                                                                  */
/* ===================================================================== */

export class HostSession {
  readonly code: string;
  readonly game: LobbyGame;
  readonly hostName: string;
  private signal: SignalClient;
  private peers = new Map<string, Peer>();
  private tracks: MediaStreamTrack[] = [];
  private videoStream: MediaStream | null = null;
  private senders = new Map<RTCPeerConnection, RTCRtpSender[]>();
  private canvas: HTMLCanvasElement | null = null;
  private closed = false;
  phase: Phase = 'lobby';
  private snapshot: LobbySnapshot | null = null;

  /** Set by the lobby: a remote device wants a port. Return false when full. */
  onJoin: ((dev: NetDevice, label: string) => boolean) | null = null;
  onLeave: ((dev: NetDevice) => void) | null = null;
  onSwap: ((dev: NetDevice) => void) | null = null;
  /** Any change in who is connected. */
  onPeersChanged: (() => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;

  private constructor(signal: SignalClient, code: string, game: LobbyGame, hostName: string) {
    this.signal = signal;
    this.code = code;
    this.game = game;
    this.hostName = hostName;
    signal.on((m) => this.onSignal(m));
    signal.onClosed(() => {
      if (!this.closed) this.close('Lost the connection to the session server');
    });
  }

  static async create(game: LobbyGame, hostName: string): Promise<HostSession> {
    const signal = await SignalClient.connect();
    const room = await signal.request({ t: 'host', game, name: hostName }, (m): m is Extract<SignalMsg, { t: 'room' }> => m.t === 'room');
    return new HostSession(signal, room.code, game, hostName);
  }

  get peerCount() {
    return this.peers.size;
  }
  get peerNames() {
    return [...this.peers.values()].map((p) => p.name);
  }
  get streaming() {
    return this.tracks.length > 0;
  }

  /* ---------- Signaling ---------- */

  private onSignal(m: SignalMsg) {
    switch (m.t) {
      case 'peer-joined':
        void this.addPeer(m.peer, m.name);
        break;
      case 'peer-left':
        this.dropPeer(m.peer, 'left');
        break;
      case 'signal':
        void this.handleSignal(m.from, m.data as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null });
        break;
    }
  }

  private async addPeer(id: string, name: string) {
    if (this.peers.has(id)) this.dropPeer(id, 'reconnect');
    const pc = new RTCPeerConnection(rtcConfig());
    const ctl = pc.createDataChannel('ctl', { ordered: true });
    const inp = pc.createDataChannel('in', { ordered: false, maxRetransmits: 0 });
    inp.binaryType = 'arraybuffer';
    const peer: Peer = { id, name, pc, ctl, inp, devices: new Map(), state: 'new', pending: [] };
    this.peers.set(id, peer);

    pc.onicecandidate = (e) => this.signal.send({ t: 'signal', to: id, data: { candidate: e.candidate ? e.candidate.toJSON() : null } });
    pc.onconnectionstatechange = () => {
      peer.state = pc.connectionState;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.dropPeer(id, pc.connectionState);
      this.onPeersChanged?.();
    };
    pc.onnegotiationneeded = () => void this.offer(peer);
    ctl.onopen = () => {
      if (this.snapshot) this.sendTo(peer, { t: 'lobby', snapshot: this.snapshot });
      this.sendTo(peer, { t: 'phase', phase: this.phase, game: this.game });
      this.onPeersChanged?.();
    };
    ctl.onmessage = (e) => this.onCtl(peer, JSON.parse(e.data) as PeerCtl);
    inp.onmessage = (e) => this.onInput(peer, e.data as ArrayBuffer);

    // Media tracks (if we are already streaming) go in before the first offer.
    if (this.tracks.length) this.attachTracks(peer);
    this.onPeersChanged?.();
  }

  private makingOffer = new WeakSet<RTCPeerConnection>();
  private async offer(peer: Peer) {
    const { pc } = peer;
    if (this.makingOffer.has(pc)) return;
    this.makingOffer.add(pc);
    try {
      for (const t of pc.getTransceivers()) if (t.sender.track?.kind === 'video') preferCodecs(t);
      await pc.setLocalDescription(await pc.createOffer());
      this.signal.send({ t: 'signal', to: peer.id, data: { sdp: pc.localDescription } });
    } catch (e) {
      console.warn('offer failed', e);
    } finally {
      this.makingOffer.delete(pc);
    }
  }

  private async handleSignal(from: string, data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null }) {
    const peer = this.peers.get(from);
    if (!peer) return;
    try {
      if (data.sdp) {
        if (data.sdp.type !== 'answer') return; // peers never offer
        await peer.pc.setRemoteDescription(data.sdp);
        for (const c of peer.pending.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
        void this.tuneSenders(peer);
      } else if (data.candidate !== undefined) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate ?? undefined).catch(() => {});
        else if (data.candidate) peer.pending.push(data.candidate);
      }
    } catch (e) {
      console.warn('signal error', e);
    }
  }

  private dropPeer(id: string, why: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    for (const ord of [...peer.devices.keys()]) this.detachDevice(peer, ord);
    try {
      peer.pc.close();
    } catch {
      /* ignore */
    }
    this.senders.delete(peer.pc);
    console.debug(`[online] peer ${peer.name} dropped (${why})`);
    this.onPeersChanged?.();
  }

  /* ---------- Control channel ---------- */

  private sendTo(peer: Peer, msg: HostCtl) {
    if (peer.ctl.readyState === 'open') peer.ctl.send(JSON.stringify(msg));
  }
  private broadcast(msg: HostCtl) {
    for (const p of this.peers.values()) this.sendTo(p, msg);
  }

  private onCtl(peer: Peer, msg: PeerCtl) {
    switch (msg.t) {
      case 'hello':
        if (msg.name?.trim()) peer.name = msg.name.trim().slice(0, 24);
        this.onPeersChanged?.();
        break;
      case 'ping':
        this.sendTo(peer, { t: 'pong', ts: msg.ts });
        break;
      case 'join': {
        if (peer.devices.has(msg.ord)) return;
        if (!this.onJoin) return this.sendTo(peer, { t: 'toast', text: 'The host is not in the lobby right now' });
        const label = peer.devices.size > 0 ? `${peer.name} · ${msg.label}` : peer.name;
        const pad = allocateVirtualPad(label);
        if (!pad) return this.sendTo(peer, { t: 'toast', text: 'No free controller slots' });
        const dev = netDevice(peer.id, msg.ord);
        setNetLabel(dev, label);
        bindDevicePad(dev, pad);
        peer.devices.set(msg.ord, pad);
        if (!this.onJoin(dev, label)) {
          this.detachDevice(peer, msg.ord, false);
          this.sendTo(peer, { t: 'toast', text: 'All ports are taken' });
        }
        break;
      }
      case 'leave':
        this.detachDevice(peer, msg.ord);
        break;
      case 'swap':
        if (peer.devices.has(msg.ord)) this.onSwap?.(netDevice(peer.id, msg.ord));
        break;
    }
  }

  private detachDevice(peer: Peer, ord: number, notify = true) {
    const pad = peer.devices.get(ord);
    if (!pad) return;
    peer.devices.delete(ord);
    const dev = netDevice(peer.id, ord);
    releaseVirtualPad(pad);
    unbindDevicePad(dev);
    if (notify) this.onLeave?.(dev);
    clearNetLabel(dev);
  }

  private onInput(peer: Peer, buf: ArrayBuffer) {
    const p = unpackInput(buf);
    if (!p) return;
    peer.devices.get(p.ord)?.set(p.buttons, p.axes, p.seq);
  }

  /** Is this remote device still attached to a connected peer? */
  hasDevice(dev: DeviceId): boolean {
    const n = parseNetDevice(dev);
    return !!n && !!this.peers.get(n.peer)?.devices.has(n.ord);
  }

  /** Last time a remote device was pressed (for the lobby's port glow). */
  lastActive(dev: DeviceId): number {
    const n = parseNetDevice(dev);
    if (!n) return 0;
    return this.peers.get(n.peer)?.devices.get(n.ord)?.lastActive ?? 0;
  }

  /* ---------- Lobby & phase ---------- */

  publishLobby(slots: (DeviceId | null)[], label: (d: DeviceId) => string) {
    this.snapshot = {
      game: this.game,
      hostName: this.hostName,
      slots: slots.map((dev) => ({ dev, label: dev ? label(dev) : '' })),
      phase: this.phase,
    };
    this.broadcast({ t: 'lobby', snapshot: this.snapshot });
  }

  setPhase(phase: Phase) {
    if (this.phase === phase) return;
    this.phase = phase;
    if (this.snapshot) this.snapshot.phase = phase;
    this.broadcast({ t: 'phase', phase, game: this.game });
  }

  /* ---------- Streaming ---------- */

  /** Start (or restart) streaming the given canvas plus the emulator's audio to all peers. */
  startStreaming(canvas: HTMLCanvasElement) {
    this.stopStreaming();
    this.canvas = canvas;
    const video = canvas.captureStream(60);
    this.videoStream = video;
    const vt = video.getVideoTracks()[0];
    if (vt) {
      try {
        vt.contentHint = 'motion';
      } catch {
        /* older browser */
      }
      this.tracks.push(vt);
    }
    const audio = captureAudioStream();
    const at = audio?.getAudioTracks()[0];
    if (at) this.tracks.push(at);
    for (const peer of this.peers.values()) this.attachTracks(peer);
  }

  /** The emulator creates its audio context late; call again once it exists. */
  refreshAudio() {
    if (!this.videoStream || this.tracks.some((t) => t.kind === 'audio')) return;
    const at = captureAudioStream()?.getAudioTracks()[0];
    if (!at) return;
    this.tracks.push(at);
    for (const peer of this.peers.values()) {
      const s = peer.pc.addTrack(at, this.videoStream);
      this.senders.set(peer.pc, [...(this.senders.get(peer.pc) ?? []), s]);
    }
  }

  private attachTracks(peer: Peer) {
    const stream = this.videoStream ?? new MediaStream();
    const senders = this.tracks.map((t) => peer.pc.addTrack(t, stream));
    this.senders.set(peer.pc, senders);
  }

  private async tuneSenders(peer: Peer) {
    for (const s of this.senders.get(peer.pc) ?? []) {
      if (s.track?.kind !== 'video') continue;
      try {
        const p = s.getParameters();
        if (!p.encodings?.length) p.encodings = [{}];
        const h = this.canvas?.height ?? 720;
        p.encodings[0].maxBitrate = VIDEO_MAX_BITRATE;
        p.encodings[0].maxFramerate = 60;
        p.encodings[0].scaleResolutionDownBy = Math.max(1, h / VIDEO_TARGET_HEIGHT);
        (p.encodings[0] as RTCRtpEncodingParameters & { priority?: string; networkPriority?: string }).priority = 'high';
        (p.encodings[0] as RTCRtpEncodingParameters & { networkPriority?: string }).networkPriority = 'high';
        (p as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = 'maintain-framerate';
        await s.setParameters(p);
      } catch (e) {
        console.debug('setParameters', e);
      }
    }
  }

  stopStreaming() {
    for (const [pc, senders] of this.senders) for (const s of senders) if (pc.connectionState !== 'closed') pc.removeTrack(s);
    this.senders.clear();
    for (const t of this.tracks) t.stop();
    this.tracks = [];
    this.videoStream = null;
    this.canvas = null;
  }

  /** Runtime picture of the connection, for the pause menu. */
  async stats(): Promise<{ name: string; state: string; rttMs: number | null; kbps: number | null; fps: number | null }[]> {
    const out = [];
    for (const p of this.peers.values()) {
      let rttMs: number | null = null;
      let kbps: number | null = null;
      let fps: number | null = null;
      try {
        const report = await p.pc.getStats();
        report.forEach((r) => {
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && typeof r.currentRoundTripTime === 'number') rttMs = Math.round(r.currentRoundTripTime * 1000);
          if (r.type === 'outbound-rtp' && r.kind === 'video') {
            if (typeof r.framesPerSecond === 'number') fps = r.framesPerSecond;
            if (typeof r.targetBitrate === 'number') kbps = Math.round(r.targetBitrate / 1000);
          }
        });
      } catch {
        /* ignore */
      }
      out.push({ name: p.name, state: p.state, rttMs, kbps, fps });
    }
    return out;
  }

  close(reason = 'Host ended the session') {
    if (this.closed) return;
    this.closed = true;
    this.broadcast({ t: 'bye', reason });
    this.stopStreaming();
    for (const id of [...this.peers.keys()]) this.dropPeer(id, 'close');
    this.signal.send({ t: 'close' });
    this.signal.close();
    this.onClosed?.(reason);
  }
}

/* ===================================================================== */
/*  Remote player                                                         */
/* ===================================================================== */

export class ClientSession {
  readonly code: string;
  readonly hostName: string;
  game: LobbyGame | null;
  private signal: SignalClient;
  private pc: RTCPeerConnection | null = null;
  private ctl: RTCDataChannel | null = null;
  private inp: RTCDataChannel | null = null;
  private pending: RTCIceCandidateInit[] = [];
  private pingTimer = 0;
  private closed = false;
  private seq = new Map<number, number>();
  private packet = new DataView(new ArrayBuffer(INPUT_PACKET_BYTES));
  readonly stream = new MediaStream();
  rtt: number | null = null;
  phase: Phase = 'lobby';
  snapshot: LobbySnapshot | null = null;

  onStream: ((s: MediaStream) => void) | null = null;
  onLobby: ((s: LobbySnapshot) => void) | null = null;
  onPhase: ((p: Phase) => void) | null = null;
  onToast: ((text: string) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  onConnection: ((state: string) => void) | null = null;

  private constructor(signal: SignalClient, code: string, hostName: string, game: LobbyGame | null) {
    this.signal = signal;
    this.code = code;
    this.hostName = hostName;
    this.game = game;
    signal.on((m) => this.onSignal(m));
    signal.onClosed(() => {
      // The socket is only needed for setup; once WebRTC is up we keep playing without it.
      if (!this.closed && this.pc?.connectionState !== 'connected') this.close('Lost the connection to the session server');
    });
  }

  static async join(code: string, name: string): Promise<ClientSession> {
    const signal = await SignalClient.connect();
    const joined = await signal.request({ t: 'join', code, name }, (m): m is Extract<SignalMsg, { t: 'joined' }> => m.t === 'joined');
    return new ClientSession(signal, joined.code, joined.host.name, (joined.game as LobbyGame) ?? null);
  }

  get connected() {
    return this.pc?.connectionState === 'connected' && this.ctl?.readyState === 'open';
  }

  private onSignal(m: SignalMsg) {
    if (m.t === 'host-left') this.close(m.reason === 'removed by host' ? 'The host removed you from the session' : 'The host left');
    else if (m.t === 'signal') void this.handleSignal(m.data as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null });
  }

  private ensurePc(): RTCPeerConnection {
    if (this.pc) return this.pc;
    const pc = new RTCPeerConnection(rtcConfig());
    this.pc = pc;
    pc.onicecandidate = (e) => this.signal.send({ t: 'signal', data: { candidate: e.candidate ? e.candidate.toJSON() : null } });
    pc.onconnectionstatechange = () => {
      this.onConnection?.(pc.connectionState);
      if (pc.connectionState === 'failed') this.close('Connection to the host failed');
      if (pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
        // Give ICE a moment to recover before giving up.
        setTimeout(() => {
          if (pc.connectionState === 'disconnected' || pc.connectionState === 'closed') this.close('Connection to the host was lost');
        }, 6000);
      }
    };
    pc.ontrack = (e) => {
      try {
        const r = e.receiver as RTCRtpReceiver & { playoutDelayHint?: number; jitterBufferTarget?: number | null };
        if (e.track.kind === 'video') {
          r.playoutDelayHint = 0;
          r.jitterBufferTarget = 0;
        } else r.jitterBufferTarget = 20;
      } catch {
        /* not supported */
      }
      this.stream.addTrack(e.track);
      this.onStream?.(this.stream);
    };
    pc.ondatachannel = (e) => {
      const ch = e.channel;
      if (ch.label === 'ctl') {
        this.ctl = ch;
        ch.onopen = () => {
          this.send({ t: 'hello', name: store.profile?.name ?? store.session.name ?? 'Player' });
          this.pingTimer = window.setInterval(() => this.send({ t: 'ping', ts: performance.now() }), PING_MS);
          this.onConnection?.('connected');
        };
        ch.onmessage = (ev) => this.onCtl(JSON.parse(ev.data) as HostCtl);
      } else if (ch.label === 'in') {
        ch.binaryType = 'arraybuffer';
        this.inp = ch;
      }
    };
    return pc;
  }

  private async handleSignal(data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null }) {
    const pc = this.ensurePc();
    try {
      if (data.sdp) {
        if (data.sdp.type !== 'offer') return;
        await pc.setRemoteDescription(data.sdp);
        for (const c of this.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        await pc.setLocalDescription(await pc.createAnswer());
        this.signal.send({ t: 'signal', data: { sdp: pc.localDescription } });
      } else if (data.candidate !== undefined) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate ?? undefined).catch(() => {});
        else if (data.candidate) this.pending.push(data.candidate);
      }
    } catch (e) {
      console.warn('signal error', e);
    }
  }

  private onCtl(msg: HostCtl) {
    switch (msg.t) {
      case 'lobby':
        this.snapshot = msg.snapshot;
        this.game = msg.snapshot.game;
        this.phase = msg.snapshot.phase;
        this.onLobby?.(msg.snapshot);
        break;
      case 'phase':
        if (msg.game) this.game = msg.game;
        this.phase = msg.phase;
        this.onPhase?.(msg.phase);
        break;
      case 'pong':
        this.rtt = Math.round(performance.now() - msg.ts);
        break;
      case 'toast':
        this.onToast?.(msg.text);
        break;
      case 'bye':
        this.close(msg.reason);
        break;
    }
  }

  private send(msg: PeerCtl) {
    if (this.ctl?.readyState === 'open') this.ctl.send(JSON.stringify(msg));
  }

  /** Ask the host for a port for one of this machine's devices. */
  join(local: DeviceId, label: string) {
    this.send({ t: 'join', ord: ordOfLocal(local), label });
  }
  leave(local: DeviceId) {
    this.send({ t: 'leave', ord: ordOfLocal(local) });
  }
  swap(local: DeviceId) {
    this.send({ t: 'swap', ord: ordOfLocal(local) });
  }

  /** My host-side device id for a local device, if the host gave it a port. */
  netDeviceOf(local: DeviceId): NetDevice {
    return netDevice(this.signal.id, ordOfLocal(local));
  }

  sendInput(local: DeviceId, buttons: number, axes: readonly number[]) {
    if (!this.inp || this.inp.readyState !== 'open' || this.inp.bufferedAmount > 512) return;
    const ord = ordOfLocal(local);
    const seq = ((this.seq.get(ord) ?? 0) + 1) & 0xff;
    this.seq.set(ord, seq);
    packInput(this.packet, ord, buttons, axes, seq);
    this.inp.send(this.packet.buffer);
  }

  close(reason = 'Left the session') {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    this.send({ t: 'leave', ord: -1 });
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.signal.send({ t: 'leave' });
    this.signal.close();
    for (const t of this.stream.getTracks()) t.stop();
    this.onClosed?.(reason);
  }
}

/* ===================================================================== */
/*  App-wide handles                                                      */
/* ===================================================================== */

export const online: { host: HostSession | null; client: ClientSession | null } = { host: null, client: null };

/** Open a room for `game`, reusing the current one if it is for the same game. */
export async function ensureHosting(game: LobbyGame): Promise<HostSession> {
  if (online.host && online.host.game.id === game.id) return online.host;
  stopHosting();
  const host = await HostSession.create(game, store.profile?.name ?? store.session.name ?? 'Host');
  online.host = host;
  host.onClosed = () => {
    if (online.host === host) online.host = null;
  };
  return host;
}

export function stopHosting(reason?: string) {
  online.host?.close(reason);
  online.host = null;
}
