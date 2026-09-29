/**
 * WebRTC signaling for online sessions.
 *
 * A host opens a room and gets a short code. Friends join with the code. From then on the
 * server only relays SDP offers/answers and ICE candidates between the host and each peer;
 * video, audio and controller input flow directly between browsers.
 *
 * Rooms are in-memory and die with the host's socket.
 */
import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Auth, SessionInfo } from './auth';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 4;
const MAX_PEERS = 7;

type Client = { ws: WebSocket; id: string; user: SessionInfo; room: Room | null; name: string };
type Room = { code: string; host: Client; peers: Map<string, Client>; game: unknown; createdAt: number };

type ClientMsg =
  | { t: 'host'; game: unknown; name?: string }
  | { t: 'join'; code: string; name?: string }
  | { t: 'signal'; to?: string; data: unknown }
  | { t: 'kick'; peer: string }
  | { t: 'close' }
  | { t: 'leave' };

export function attachSignaling(server: Server, auth: Auth, path = '/ws') {
  const wss = new WebSocketServer({ noServer: true });
  const rooms = new Map<string, Room>();
  let nextId = 1;

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== path) return; // Vite's HMR socket in dev, or something else
    const user = auth.enabled ? auth.sessionOf(req) : { name: 'Open access', code: '', owner: true };
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, user));
  });

  const send = (c: Client, msg: unknown) => {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  };

  const newCode = () => {
    for (let tries = 0; tries < 50; tries++) {
      let code = '';
      for (let i = 0; i < CODE_LEN; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
    return null;
  };

  const closeRoom = (room: Room, reason: string) => {
    rooms.delete(room.code);
    for (const p of room.peers.values()) {
      p.room = null;
      send(p, { t: 'host-left', reason });
    }
    room.host.room = null;
  };

  const leaveRoom = (c: Client) => {
    const room = c.room;
    if (!room) return;
    if (room.host === c) closeRoom(room, 'host left');
    else {
      room.peers.delete(c.id);
      c.room = null;
      send(room.host, { t: 'peer-left', peer: c.id });
    }
  };

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, user: SessionInfo) => {
    const c: Client = { ws, id: `p${nextId++}`, user, room: null, name: user.name };
    send(c, { t: 'hello', id: c.id, name: user.name });

    ws.on('message', (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      switch (msg.t) {
        case 'host': {
          leaveRoom(c);
          const code = newCode();
          if (!code) return send(c, { t: 'error', reason: 'too many rooms' });
          if (typeof msg.name === 'string' && msg.name.trim()) c.name = msg.name.trim().slice(0, 24);
          const room: Room = { code, host: c, peers: new Map(), game: msg.game ?? null, createdAt: Date.now() };
          rooms.set(code, room);
          c.room = room;
          send(c, { t: 'room', code });
          break;
        }
        case 'join': {
          leaveRoom(c);
          const room = rooms.get(String(msg.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
          if (!room) return send(c, { t: 'error', reason: 'No session with that code' });
          if (room.host === c) return send(c, { t: 'error', reason: 'That is your own session' });
          if (room.peers.size >= MAX_PEERS) return send(c, { t: 'error', reason: 'That session is full' });
          if (typeof msg.name === 'string' && msg.name.trim()) c.name = msg.name.trim().slice(0, 24);
          room.peers.set(c.id, c);
          c.room = room;
          send(c, { t: 'joined', code: room.code, peer: c.id, host: { id: room.host.id, name: room.host.name }, game: room.game });
          send(room.host, { t: 'peer-joined', peer: c.id, name: c.name });
          break;
        }
        case 'signal': {
          const room = c.room;
          if (!room) return;
          if (room.host === c) {
            const to = room.peers.get(String(msg.to ?? ''));
            if (to) send(to, { t: 'signal', from: c.id, data: msg.data });
          } else send(room.host, { t: 'signal', from: c.id, data: msg.data });
          break;
        }
        case 'kick': {
          const room = c.room;
          if (!room || room.host !== c) return;
          const p = room.peers.get(String(msg.peer));
          if (!p) return;
          room.peers.delete(p.id);
          p.room = null;
          send(p, { t: 'host-left', reason: 'removed by host' });
          break;
        }
        case 'close':
        case 'leave':
          leaveRoom(c);
          break;
      }
    });

    ws.on('close', () => leaveRoom(c));
    ws.on('error', () => leaveRoom(c));
  });

  // Keepalive: reverse proxies drop idle sockets, and dead hosts must free their room.
  const iv = setInterval(() => {
    wss.clients.forEach((ws) => {
      const w = ws as WebSocket & { __alive?: boolean };
      if (w.__alive === false) return ws.terminate();
      w.__alive = false;
      ws.once('pong', () => (w.__alive = true));
      ws.ping();
    });
  }, 25_000);
  wss.on('close', () => clearInterval(iv));

  return {
    stats: () => ({ rooms: rooms.size, clients: wss.clients.size }),
  };
}
