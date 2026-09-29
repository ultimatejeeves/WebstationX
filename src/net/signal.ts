/**
 * Thin client for the server's signaling socket (server/signaling.ts).
 */

export type SignalMsg =
  | { t: 'hello'; id: string; name: string }
  | { t: 'room'; code: string }
  | { t: 'joined'; code: string; peer: string; host: { id: string; name: string }; game: unknown }
  | { t: 'peer-joined'; peer: string; name: string }
  | { t: 'peer-left'; peer: string }
  | { t: 'host-left'; reason: string }
  | { t: 'signal'; from: string; data: unknown }
  | { t: 'error'; reason: string };

export class SignalClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<(m: SignalMsg) => void>();
  private closedListeners = new Set<() => void>();
  id = '';
  name = '';

  static async connect(): Promise<SignalClient> {
    const c = new SignalClient();
    await c.open();
    return c;
  }

  private open() {
    return new Promise<void>((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws`);
      this.ws = ws;
      let settled = false;
      ws.onmessage = (ev) => {
        let m: SignalMsg;
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (m.t === 'hello') {
          this.id = m.id;
          this.name = m.name;
          if (!settled) {
            settled = true;
            resolve();
          }
        }
        for (const l of [...this.listeners]) l(m);
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error('Cannot reach the session server'));
        }
      };
      ws.onclose = () => {
        if (!settled) {
          settled = true;
          reject(new Error('Session server closed the connection (are you signed in?)'));
        }
        for (const l of [...this.closedListeners]) l();
      };
    });
  }

  on(fn: (m: SignalMsg) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onClosed(fn: () => void) {
    this.closedListeners.add(fn);
    return () => this.closedListeners.delete(fn);
  }

  send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Send and wait for the first message matching `match` (or an error). */
  request<T extends SignalMsg>(msg: unknown, match: (m: SignalMsg) => m is T, timeoutMs = 8000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('Session server did not answer'));
      }, timeoutMs);
      const off = this.on((m) => {
        if (match(m)) {
          clearTimeout(timer);
          off();
          resolve(m);
        } else if (m.t === 'error') {
          clearTimeout(timer);
          off();
          reject(new Error(m.reason));
        }
      });
      this.send(msg);
    });
  }

  close() {
    this.listeners.clear();
    this.closedListeners.clear();
    this.ws?.close();
    this.ws = null;
  }
}
