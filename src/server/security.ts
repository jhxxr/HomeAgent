import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../shared/protocol.js';
import { hash, secret, Store, type BrowserSession } from './store.js';
import type { ServerConfig } from './config.js';

export class Limiter {
  private entries = new Map<string, { count: number; expires: number }>();
  constructor(private max: number, private windowMs: number) {}
  hit(key: string) {
    const now = Date.now();
    if (this.entries.size >= 10000) {
      for (const [k, v] of this.entries) if (v.expires <= now) this.entries.delete(k);
      if (!this.entries.has(key) && this.entries.size >= 10000) throw new AppError('rate_limited', 'Rate limiter capacity reached; try again later', 429);
    }
    const value = this.entries.get(key);
    if (!value || value.expires <= now) { this.entries.set(key, { count: 1, expires: now + this.windowMs }); return; }
    if (++value.count > this.max) throw new AppError('rate_limited', 'Too many requests; try again later', 429);
  }
}
export const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
export function page(title: string, body: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · HomeAgent</title><link rel="icon" href="/assets/favicon.svg"><link rel="stylesheet" href="/assets/style.css"></head><body><header><a href="/">HomeAgent</a><span>私有开发环境 · 远程 MCP</span></header><main>${body}</main></body></html>`;
}
export class BrowserAuth {
  private salt = randomBytes(16);
  private passwordHash: Buffer;
  readonly loginLimiter = new Limiter(5, 300000);
  constructor(readonly store: Store, readonly config: ServerConfig) {
    this.passwordHash = scryptSync(config.password, this.salt, 64);
  }
  private signature(value: string) { return createHmac('sha256', this.config.sessionSecret).update(value).digest('base64url'); }
  session(req: Request): BrowserSession | undefined {
    const cookieName = this.config.publicUrl.startsWith('https:') ? '__Host-ha_session' : 'ha_session';
    const raw = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!raw) return;
    const [sid, signature] = raw.split('.');
    if (!sid || !signature) return;
    const expected = this.signature(sid);
    if (Buffer.byteLength(signature) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return;
    const session = this.store.get<BrowserSession>('sessions', hash(sid));
    if (session && session.expires > Date.now()) {
      if (Date.now() - (session.lastSeen ?? 0) >= 60000) {
        session.lastSeen = Date.now(); this.store.put('sessions', session.id, session);
      }
      return session;
    }
  }
  login(req: Request, res: Response, password: string) {
    this.checkOrigin(req, true); this.loginLimiter.hit(req.ip ?? 'unknown');
    const computed = scryptSync(password.slice(0, 1024), this.salt, 64);
    if (!timingSafeEqual(computed, this.passwordHash)) {
      this.store.audit({ principal: 'anonymous', deviceId: '', projectId: '', tool: 'admin.login', argsHash: hash('login'), status: 'denied', durationMs: 0 });
      throw new AppError('bad_login', '密码错误', 401);
    }
    const sid = secret();
    const session: BrowserSession = { id: hash(sid), csrf: secret(), created: Date.now(), lastSeen: Date.now(), userAgent: req.get('user-agent')?.slice(0, 160), expires: Date.now() + 8 * 3600000 };
    this.store.put('sessions', session.id, session);
    this.store.audit({ principal: 'admin', deviceId: '', projectId: '', tool: 'admin.login', argsHash: hash('login'), status: 'ok', durationMs: 0 });
    const secure = this.config.publicUrl.startsWith('https:');
    res.cookie(secure ? '__Host-ha_session' : 'ha_session', `${sid}.${this.signature(sid)}`, { httpOnly: true, secure, sameSite: 'lax', maxAge: 8 * 3600000, path: '/' });
  }
  checkOrigin(req: Request, required = false) {
    if ((required && !req.headers.origin) || (req.headers.origin && req.headers.origin !== this.config.publicUrl)) throw new AppError('bad_origin', 'Origin rejected', 403);
  }
  requireSession = (req: Request, res: Response, next: NextFunction) => {
    const session = this.session(req);
    if (!session) {
      if (req.originalUrl.startsWith('/api/')) { res.status(401).json({ error: 'login_required' }); return; }
      res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`); return;
    }
    res.locals.session = session;
    if (!['GET', 'HEAD'].includes(req.method)) {
      this.checkOrigin(req);
      if ((req.get('x-csrf-token') ?? req.body?._csrf) !== session.csrf) throw new AppError('csrf', 'CSRF token required', 403);
    }
    next();
  };
}
