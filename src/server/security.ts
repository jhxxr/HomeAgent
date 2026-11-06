import { createHash, createHmac, createPublicKey, randomBytes, randomUUID, scryptSync, timingSafeEqual, verify } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../shared/protocol.js';
import { hash, secret, Store, type BrowserSession, type XAuthAdmin, type XAuthLoginRequest } from './store.js';
import type { ServerConfig } from './config.js';

type JwkKey = globalThis.JsonWebKey & { kid?: string; use?: string; alg?: string };

interface XAuthDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}
interface XAuthClaims {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
}

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
export function page(title: string, body: string, options: { console?: boolean } = {}) {
  const consoleStyles = options.console ? '<link rel="stylesheet" href="/assets/console.css">' : '';
  const header = options.console ? '' : '<header><a href="/"><img src="/assets/favicon.svg" width="32" height="32" alt="">HomeAgent</a><span>私有开发环境 · 远程 MCP</span></header>';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · HomeAgent</title><link rel="icon" type="image/svg+xml" href="/assets/favicon.svg"><link rel="apple-touch-icon" href="/assets/icon.png"><link rel="stylesheet" href="/assets/style.css">${consoleStyles}</head><body${options.console ? ' class="console-page"' : ''}><a class="skip-link" href="#main-content">跳至主要内容</a>${header}<main id="main-content">${body}</main></body></html>`;
}
export class BrowserAuth {
  private salt = randomBytes(16);
  private passwordHash?: Buffer;
  private discoveryCache?: { expires: number; doc: XAuthDiscovery };
  private jwksCache?: { expires: number; keys: JwkKey[] };
  readonly loginLimiter = new Limiter(5, 300000);
  readonly xauthLimiter = new Limiter(20, 300000);
  constructor(readonly store: Store, readonly config: ServerConfig) {
    if (!config.password && !config.xauth) throw new Error('ADMIN_PASSWORD or XAuth configuration is required');
    this.passwordHash = config.password ? scryptSync(config.password, this.salt, 64) : undefined;
  }
  private signature(value: string) { return createHmac('sha256', this.config.sessionSecret).update(value).digest('base64url'); }
  private verifySignature(expectedInput: string, actualSignature: string): boolean {
    const expected = this.signature(expectedInput);
    return Buffer.byteLength(actualSignature) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(actualSignature), Buffer.from(expected));
  }
  private readCookie(req: Request, baseName: string): string | undefined {
    const cookieName = this.config.publicUrl.startsWith('https:') ? `__Host-${baseName}` : baseName;
    return req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  }
  private createSession(req: Request, res: Response, extra: Partial<BrowserSession> = {}): BrowserSession {
    const sid = secret();
    const session: BrowserSession = {
      id: hash(sid), csrf: secret(), created: Date.now(), lastSeen: Date.now(),
      userAgent: req.get('user-agent')?.slice(0, 160), expires: Date.now() + 8 * 3600000,
      ...extra,
    };
    this.store.put('sessions', session.id, session);
    const secure = this.config.publicUrl.startsWith('https:');
    res.cookie(secure ? '__Host-ha_session' : 'ha_session', `${sid}.${this.signature(sid)}`, { httpOnly: true, secure, sameSite: 'lax', maxAge: 8 * 3600000, path: '/' });
    return session;
  }
  session(req: Request): BrowserSession | undefined {
    const raw = this.readCookie(req, 'ha_session');
    if (!raw) return;
    const [sid, signature] = raw.split('.');
    if (!sid || !signature || !this.verifySignature(sid, signature)) return;
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
    if (!this.passwordHash) {
      this.store.audit({ principal: 'anonymous', deviceId: '', projectId: '', tool: 'admin.login', argsHash: hash('login'), status: 'denied', durationMs: 0 });
      throw new AppError('password_login_disabled', '此服务未开启密码登录，请使用 XAuth 登录', 403);
    }
    const computed = scryptSync(password.slice(0, 1024), this.salt, 64);
    if (!timingSafeEqual(computed, this.passwordHash)) {
      this.store.audit({ principal: 'anonymous', deviceId: '', projectId: '', tool: 'admin.login', argsHash: hash('login'), status: 'denied', durationMs: 0 });
      throw new AppError('bad_login', '密码错误', 401);
    }
    this.createSession(req, res, { authMethod: 'password' });
    this.store.audit({ principal: 'admin', deviceId: '', projectId: '', tool: 'admin.login', argsHash: hash('login'), status: 'ok', durationMs: 0 });
  }
  xauthCallbackUrl() { return `${this.config.publicUrl}/login/xauth/callback`; }
  xauthAdmin(): XAuthAdmin | undefined { return this.store.get<XAuthAdmin>('settings', 'xauth_admin'); }
  private validateIssuerEndpoint(raw: unknown, label: string): string {
    if (typeof raw !== 'string' || !raw) throw new AppError('xauth_discovery', `XAuth discovery missing ${label}`, 502);
    let url: URL;
    try { url = new URL(raw); }
    catch { throw new AppError('xauth_discovery', `XAuth discovery invalid ${label}`, 502); }
    if (url.origin !== this.config.xauth!.issuer) throw new AppError('xauth_discovery', `XAuth ${label} origin mismatch`, 502);
    return url.href;
  }
  private async discover(force = false): Promise<XAuthDiscovery> {
    if (!force && this.discoveryCache && this.discoveryCache.expires > Date.now()) return this.discoveryCache.doc;
    const issuer = this.config.xauth!.issuer;
    let response: globalThis.Response;
    try {
      response = await fetch(`${issuer}/.well-known/openid-configuration`, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new AppError('xauth_unavailable', '无法连接到 XAuth 认证服务，请检查网络或服务状态。', 502);
    }
    if (!response.ok) throw new AppError('xauth_discovery', 'XAuth 认证服务返回异常状态。', 502);
    const data = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!data || data.issuer !== issuer) throw new AppError('xauth_discovery', 'XAuth Issuer 元数据校验失败。', 502);
    const doc: XAuthDiscovery = {
      issuer,
      authorization_endpoint: this.validateIssuerEndpoint(data.authorization_endpoint, 'authorization_endpoint'),
      token_endpoint: this.validateIssuerEndpoint(data.token_endpoint, 'token_endpoint'),
      jwks_uri: this.validateIssuerEndpoint(data.jwks_uri, 'jwks_uri'),
      ...(typeof data.userinfo_endpoint === 'string' && data.userinfo_endpoint ? { userinfo_endpoint: this.validateIssuerEndpoint(data.userinfo_endpoint, 'userinfo_endpoint') } : {}),
    };
    this.discoveryCache = { doc, expires: Date.now() + 300000 };
    return doc;
  }
  private async fetchJwks(jwksUri: string, force = false) {
    if (!force && this.jwksCache && this.jwksCache.expires > Date.now()) return this.jwksCache.keys;
    let response: globalThis.Response;
    try {
      response = await fetch(jwksUri, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    } catch {
      throw new AppError('xauth_unavailable', '无法获取 XAuth 签名公钥。', 502);
    }
    if (!response.ok) throw new AppError('xauth_jwks', 'XAuth 签名公钥接口返回异常。', 502);
    const body = await response.json().catch(() => null) as { keys?: unknown[] } | null;
    if (!body || !Array.isArray(body.keys)) throw new AppError('xauth_jwks', 'XAuth 签名公钥格式无效。', 502);
    const keys = body.keys.filter((item): item is JwkKey => Boolean(item && typeof item === 'object'));
    this.jwksCache = { keys, expires: Date.now() + 300000 };
    return keys;
  }
  private async verifyIdToken(rawToken: string, expectedNonce: string, jwksUri: string): Promise<XAuthClaims> {
    const parts = rawToken.split('.');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new AppError('xauth_token', 'XAuth ID 令牌格式无效。', 401);
    const [rawHeader, rawPayload, rawSignature] = parts;
    let header: { alg?: unknown; kid?: unknown };
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(rawHeader, 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(rawPayload, 'base64url').toString('utf8'));
    } catch {
      throw new AppError('xauth_token', 'XAuth ID 令牌解析失败。', 401);
    }
    if (header.alg !== 'RS256') throw new AppError('xauth_token', 'XAuth ID 令牌签名算法不受支持。', 401);
    const kid = typeof header.kid === 'string' ? header.kid : undefined;
    const matchKey = (keys: JwkKey[]) =>
      keys.find(key => key.kty === 'RSA' && (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256') && (!kid || key.kid === kid));
    let jwk = matchKey(await this.fetchJwks(jwksUri, false));
    if (!jwk) jwk = matchKey(await this.fetchJwks(jwksUri, true));
    if (!jwk) throw new AppError('xauth_token', '未找到匹配的 XAuth 签名密钥。', 401);
    let validSignature = false;
    try {
      const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
      validSignature = verify('RSA-SHA256', Buffer.from(`${rawHeader}.${rawPayload}`), publicKey, Buffer.from(rawSignature, 'base64url'));
    } catch {
      validSignature = false;
    }
    if (!validSignature) throw new AppError('xauth_token', 'XAuth ID 令牌签名验证失败。', 401);
    const { issuer, clientId } = this.config.xauth!;
    if (payload.iss !== issuer) throw new AppError('xauth_token', 'XAuth ID 令牌签发方不匹配。', 401);
    if (typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 256) throw new AppError('xauth_token', 'XAuth ID 令牌缺少有效用户标识。', 401);
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(clientId) || (audiences.length > 1 && payload.azp !== clientId)) throw new AppError('xauth_token', 'XAuth ID 令牌受众不匹配。', 401);
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= nowSec - 30) throw new AppError('xauth_token', 'XAuth ID 令牌已过期。', 401);
    if (typeof payload.iat !== 'number' || payload.iat > nowSec + 60) throw new AppError('xauth_token', 'XAuth ID 令牌签发时间无效。', 401);
    if (typeof payload.nonce !== 'string' || Buffer.byteLength(payload.nonce) !== Buffer.byteLength(expectedNonce) ||
        !timingSafeEqual(Buffer.from(payload.nonce), Buffer.from(expectedNonce))) {
      throw new AppError('xauth_token', 'XAuth 登录随机态（nonce）不匹配。', 401);
    }
    return {
      sub: payload.sub,
      ...(typeof payload.email === 'string' && payload.email ? { email: payload.email.slice(0, 320) } : {}),
      ...(typeof payload.name === 'string' && payload.name ? { name: payload.name.slice(0, 160) } : {}),
      ...(typeof payload.preferred_username === 'string' && payload.preferred_username ? { preferred_username: payload.preferred_username.slice(0, 320) } : {}),
    };
  }
  async startXAuthLogin(req: Request, res: Response, nextPath: string): Promise<string> {
    if (!this.config.xauth) throw new AppError('not_found', 'XAuth login is not configured', 404);
    this.xauthLimiter.hit(req.ip ?? 'unknown');
    const discovery = await this.discover();
    const id = randomUUID(), state = secret(), nonce = secret(), codeVerifier = secret();
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const stateHash = hash(state);
    const loginRequest: XAuthLoginRequest = { id, stateHash, nonce, codeVerifier, next: nextPath, expires: Date.now() + 600000 };
    this.store.put('xauthRequests', id, loginRequest);
    const secure = this.config.publicUrl.startsWith('https:');
    res.cookie(secure ? '__Host-ha_xauth' : 'ha_xauth', `${id}.${this.signature(`xauth:${id}:${stateHash}`)}`, {
      httpOnly: true, secure, sameSite: 'lax', maxAge: 600000, path: '/',
    });
    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set('client_id', this.config.xauth.clientId);
    url.searchParams.set('redirect_uri', this.xauthCallbackUrl());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.href;
  }
  async finishXAuthLogin(req: Request, res: Response): Promise<string> {
    if (!this.config.xauth) throw new AppError('not_found', 'XAuth login is not configured', 404);
    this.xauthLimiter.hit(req.ip ?? 'unknown');
    const secure = this.config.publicUrl.startsWith('https:');
    const rawCookie = this.readCookie(req, 'ha_xauth');
    res.clearCookie(secure ? '__Host-ha_xauth' : 'ha_xauth', { path: '/' });
    if (!rawCookie) throw new AppError('xauth_state', 'XAuth 登录会话已过期或缺失，请重新发起登录。', 400);
    const [requestId, cookieSig] = rawCookie.split('.');
    if (!requestId || !cookieSig) throw new AppError('xauth_state', 'XAuth 登录状态无效，请重新发起登录。', 400);
    const loginRequest = this.store.transaction(() => {
      const stored = this.store.get<XAuthLoginRequest>('xauthRequests', requestId);
      if (stored) this.store.delete('xauthRequests', requestId);
      return stored;
    });
    if (!loginRequest || loginRequest.expires <= Date.now() || !this.verifySignature(`xauth:${requestId}:${loginRequest.stateHash}`, cookieSig)) {
      throw new AppError('xauth_state', 'XAuth 登录请求已过期或已使用，请重新登录。', 400);
    }
    const queryState = typeof req.query.state === 'string' ? req.query.state : '';
    if (!queryState || hash(queryState) !== loginRequest.stateHash) {
      throw new AppError('xauth_state', 'XAuth 登录状态校验失败，请重新发起登录。', 400);
    }
    if (typeof req.query.error === 'string' && req.query.error) {
      this.store.audit({ principal: 'anonymous', deviceId: '', projectId: '', tool: 'admin.login', argsHash: hash('xauth_error'), status: 'denied', durationMs: 0 });
      throw new AppError('xauth_denied', 'XAuth 登录已取消或未获授权。', 401);
    }
    const code = typeof req.query.code === 'string' ? req.query.code.trim() : '';
    if (!code || code.length > 1024) throw new AppError('xauth_code', 'XAuth 授权码无效，请重新登录。', 400);
    const discovery = await this.discover();
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.xauthCallbackUrl(),
      code_verifier: loginRequest.codeVerifier,
    });
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    if (this.config.xauth.clientSecret) {
      const credentials = `${encodeURIComponent(this.config.xauth.clientId)}:${encodeURIComponent(this.config.xauth.clientSecret)}`;
      headers.authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
    } else {
      form.set('client_id', this.config.xauth.clientId);
    }
    let tokenResponse: globalThis.Response;
    try {
      tokenResponse = await fetch(discovery.token_endpoint, {
        method: 'POST', headers, body: form, redirect: 'error', signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new AppError('xauth_unavailable', '无法连接 XAuth 令牌接口，请稍后重试。', 502);
    }
    const tokenData = await tokenResponse.json().catch(() => null) as { id_token?: unknown; access_token?: unknown } | null;
    if (!tokenResponse.ok || !tokenData || typeof tokenData.id_token !== 'string' || !tokenData.id_token) {
      this.store.audit({ principal: 'anonymous', deviceId: '', projectId: '', tool: 'admin.login', argsHash: hash('xauth_token'), status: 'denied', durationMs: 0 });
      throw new AppError('xauth_token', 'XAuth 授权码兑换失败，请检查客户端配置或重新登录。', 401);
    }
    const claims = await this.verifyIdToken(tokenData.id_token, loginRequest.nonce, discovery.jwks_uri);
    let email = claims.email ?? claims.preferred_username;
    let name = claims.name;
    if ((!email || !name) && typeof tokenData.access_token === 'string' && tokenData.access_token && discovery.userinfo_endpoint) {
      try {
        const infoRes = await fetch(discovery.userinfo_endpoint, {
          headers: { authorization: `Bearer ${tokenData.access_token}`, accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
        });
        if (infoRes.ok) {
          const info = await infoRes.json().catch(() => null) as Record<string, unknown> | null;
          if (info && info.sub === claims.sub) {
            if (!email && typeof info.email === 'string' && info.email) email = info.email.slice(0, 320);
            if (!name && typeof info.name === 'string' && info.name) name = info.name.slice(0, 160);
          }
        }
      } catch { /* ID token claims are already verified; userinfo enrichment is best-effort. */ }
    }
    const now = Date.now();
    const allowed = this.store.transaction(() => {
      const existing = this.store.get<XAuthAdmin>('settings', 'xauth_admin');
      if (!existing) {
        const bound: XAuthAdmin = { sub: claims.sub, ...(email ? { email } : {}), ...(name ? { name } : {}), boundAt: now, lastLoginAt: now };
        this.store.put('settings', 'xauth_admin', bound);
        this.store.audit({ principal: 'admin', deviceId: '', projectId: '', tool: 'admin.xauth_bound', argsHash: hash(claims.sub), status: 'ok', durationMs: 0 });
      } else if (existing.sub !== claims.sub) {
        this.store.audit({ principal: `xauth:${claims.sub}`, deviceId: '', projectId: '', tool: 'admin.login', argsHash: hash(claims.sub), status: 'denied', durationMs: 0 });
        return false;
      } else {
        this.store.put('settings', 'xauth_admin', {
          ...existing,
          ...(email ? { email } : {}),
          ...(name ? { name } : {}),
          lastLoginAt: now,
        });
      }
      this.createSession(req, res, { authMethod: 'xauth', userSub: claims.sub, ...(email ? { userEmail: email } : {}), ...(name ? { userName: name } : {}) });
      this.store.audit({ principal: 'admin', deviceId: '', projectId: '', tool: 'admin.login', argsHash: hash(`xauth:${claims.sub}`), status: 'ok', durationMs: 0 });
      return true;
    });
    if (!allowed) {
      throw new AppError('xauth_forbidden', '此工作空间仅允许首个登录的管理员账号访问，其他账号无权登录。', 403);
    }
    return loginRequest.next;
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
