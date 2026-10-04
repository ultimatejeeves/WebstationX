/**
 * Invite-code access control.
 *
 * The owner hands each friend a code (tools/invite.mjs). Logging in with a code sets a signed,
 * HttpOnly session cookie that is valid until the code is revoked. Everything except the UI
 * shell, the login endpoint and the emulator core requires that cookie.
 *
 * Codes live in data/invites.json; the cookie signing secret is generated once into
 * data/secret.key. Nothing here needs a database.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type express from 'express';

export type Invite = {
  /** The code itself, normalised to upper case with dashes stripped. */
  code: string;
  /** Who the code was made for. Shown as the "signed in as" name. */
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** Owner codes can manage the server from the UI later; unused for now. */
  owner?: boolean;
};

export type SessionInfo = { name: string; code: string; owner: boolean };

const COOKIE = 'wsx_session';
const SESSION_DAYS = 365;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_TRIES = 8;

export class Auth {
  private readonly invitesPath: string;
  private readonly secret: Buffer;
  private cache: { mtimeMs: number; invites: Invite[] } | null = null;
  private attempts = new Map<string, number[]>();

  constructor(dataDir: string) {
    this.invitesPath = path.join(dataDir, 'invites.json');
    const secretPath = path.join(dataDir, 'secret.key');
    if (!fs.existsSync(secretPath)) fs.writeFileSync(secretPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    this.secret = Buffer.from(fs.readFileSync(secretPath, 'utf8').trim(), 'hex');
  }

  /* ---------- Invites ---------- */

  static normalize(code: string) {
    return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  invites(): Invite[] {
    if (!fs.existsSync(this.invitesPath)) return [];
    const st = fs.statSync(this.invitesPath);
    if (this.cache && this.cache.mtimeMs === st.mtimeMs) return this.cache.invites;
    let invites: Invite[] = [];
    try {
      invites = JSON.parse(fs.readFileSync(this.invitesPath, 'utf8'));
    } catch (e) {
      console.error('invites.json is not valid JSON; nobody can sign in until it is fixed', e);
    }
    this.cache = { mtimeMs: st.mtimeMs, invites };
    return invites;
  }

  private writeInvites(invites: Invite[]) {
    fs.writeFileSync(this.invitesPath, JSON.stringify(invites, null, 2));
    this.cache = null;
  }

  /** Active invite for a code, or null. */
  find(code: string): Invite | null {
    const n = Auth.normalize(code);
    return this.invites().find((i) => i.code === n && !i.revokedAt) ?? null;
  }

  get enabled() {
    // Once configured, revoking the last code must never reopen the server.
    return fs.existsSync(this.invitesPath);
  }

  /* ---------- Session tokens ---------- */

  private sign(payload: string) {
    return crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  issue(invite: Invite): string {
    const exp = Date.now() + SESSION_DAYS * 86_400_000;
    const payload = Buffer.from(JSON.stringify({ c: invite.code, e: exp }), 'utf8').toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  verify(token: string | undefined | null): SessionInfo | null {
    if (!token) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = this.sign(payload);
    if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
    let data: { c: string; e: number };
    try {
      data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (typeof data.e !== 'number' || data.e < Date.now()) return null;
    const invite = this.find(data.c);
    if (!invite) return null;
    return { name: invite.name, code: invite.code, owner: !!invite.owner };
  }

  /* ---------- HTTP plumbing ---------- */

  static cookieOf(req: { headers: { cookie?: string } }): string | null {
    const raw = req.headers.cookie;
    if (!raw) return null;
    for (const part of raw.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) {
        try { return decodeURIComponent(v.join('=')); } catch { return null; }
      }
    }
    return null;
  }

  sessionOf(req: { headers: { cookie?: string } }): SessionInfo | null {
    return this.verify(Auth.cookieOf(req));
  }

  private secure(req: express.Request) {
    return req.secure;
  }

  setCookie(req: express.Request, res: express.Response, token: string) {
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.secure(req),
      maxAge: SESSION_DAYS * 86_400_000,
      path: '/',
    });
  }

  clearCookie(req: express.Request, res: express.Response) {
    res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: this.secure(req), path: '/' });
  }

  /** Very small per-IP brute-force brake for the login endpoint. */
  throttled(ip: string): boolean {
    const now = Date.now();
    const list = (this.attempts.get(ip) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
    list.push(now);
    this.attempts.set(ip, list);
    if (this.attempts.size > 5000) this.attempts.clear();
    return list.length > LOGIN_MAX_TRIES;
  }

  touch(invite: Invite) {
    const all = this.invites();
    const i = all.find((x) => x.code === invite.code);
    if (!i) return;
    // Only write when the timestamp is stale, to keep disk writes rare.
    if (i.lastUsedAt && Date.now() - Date.parse(i.lastUsedAt) < 3_600_000) return;
    i.lastUsedAt = new Date().toISOString();
    this.writeInvites(all);
  }

  /** Express middleware: 401 for anything without a valid session. */
  require(): express.RequestHandler {
    return (req, res, next) => {
      if (!this.enabled) {
        // No invites yet: run open, but say so loudly on every request to /api/session.
        (req as express.Request & { session?: SessionInfo | null }).session = { name: 'Open access', code: '', owner: true };
        return next();
      }
      const s = this.sessionOf(req);
      if (!s) return res.status(401).json({ error: 'sign in required' });
      (req as express.Request & { session?: SessionInfo | null }).session = s;
      next();
    };
  }
}
