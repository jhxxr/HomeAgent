import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { SCOPES, type Principal, type Scope, AppError } from '../shared/protocol.js';
import { Store, hash, secret, type ClientToken, type Device } from './store.js';
import { BrowserAuth, escapeHtml as h, page } from './security.js';

interface AuthRequest { id: string; clientId: string; params: Omit<AuthorizationParams, 'resource'> & { resource: string }; expires: number; }
interface Code extends Principal { clientId: string; challenge: string; redirect: string; resource: string; expires: number }
export class OAuth implements OAuthServerProvider {
  private key: Buffer;
  readonly resource: string;
  readonly issuer: string;
  constructor(readonly store: Store, readonly browser: BrowserAuth) {
    this.key = Buffer.from(hash(browser.config.sessionSecret), 'hex');
    this.resource = `${browser.config.publicUrl}/mcp`;
    this.issuer = new URL(browser.config.publicUrl).href;
  }
  private encrypt(value: string) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
  }
  private decrypt(value: string) {
    const bytes = Buffer.from(value, 'base64url'), decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  }
  get clientsStore() {
    return {
      getClient: (id: string) => {
        const stored = this.store.get<{ data: string; revoked: boolean }>('clients', id);
        if (!stored || stored.revoked) return;
        try { return JSON.parse(this.decrypt(stored.data)) as OAuthClientInformationFull; }
        catch { return; } // A rotated key or corrupt ciphertext must fail closed without breaking the Dashboard.
      },
      registerClient: (input: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) => {
        if (this.store.all<{ revoked: boolean }>('clients').filter(client => !client.revoked).length >= 1000) throw new InvalidClientError('Client registration limit reached; revoke unused clients');
        if (input.token_endpoint_auth_method && !['none', 'client_secret_post'].includes(input.token_endpoint_auth_method)) throw new InvalidClientError('Supported client authentication methods: none, client_secret_post');
        if (!input.redirect_uris.length || input.redirect_uris.length > 16) throw new InvalidClientError('Invalid redirect URIs');
        for (const redirect of input.redirect_uris) {
          const url = new URL(redirect);
          if (url.hash || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new InvalidClientError('Redirect requires HTTPS or HTTP loopback');
        }
        const client: OAuthClientInformationFull = { ...input, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) };
        this.store.put('clients', client.client_id, { data: this.encrypt(JSON.stringify(client)), revoked: false });
        return client;
      },
    };
  }
  private checkResource(resource?: URL) {
    if (resource && resource.href !== this.resource) throw new InvalidTargetError('Resource must match this MCP endpoint');
  }
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: import('express').Response) {
    this.checkResource(params.resource);
    if (params.scopes?.some(scope => !SCOPES.includes(scope as Scope))) throw new InvalidScopeError('Unsupported scope');
    const request: AuthRequest = { id: secret(), clientId: client.client_id, params: { ...params, resource: this.resource }, expires: Date.now() + 600000 };
    this.store.put('authRequests', request.id, request);
    res.redirect(`/consent?request=${encodeURIComponent(request.id)}`);
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string) {
    const code = this.store.get<Code>('codes', hash(authorizationCode));
    if (!code || code.clientId !== client.client_id || code.expires < Date.now()) throw new InvalidGrantError('Invalid authorization code');
    return code.challenge;
  }
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, raw: string, _verifier?: string, redirect?: string, resource?: URL): Promise<OAuthTokens> {
    this.checkResource(resource);
    return this.store.transaction(() => {
      const code = this.store.get<Code>('codes', hash(raw));
      if (!code || code.expires <= Date.now() || code.clientId !== client.client_id || !redirect || redirect !== code.redirect) throw new InvalidGrantError('Code or redirect URI mismatch');
      this.store.delete('codes', hash(raw));
      return this.tokens(code, client.client_id, randomUUID());
    });
  }
  private tokens(principal: Principal, clientId: string, family: string): OAuthTokens {
    const base = { id: principal.id, scopes: principal.scopes, devices: principal.devices, projects: principal.projects, projectGrants: principal.projectGrants, clientId, family };
    const access_token = this.store.mintToken({ ...base, kind: 'access', expires: Date.now() + 3600000 });
    const refresh_token = this.store.mintToken({ ...base, kind: 'refresh', expires: Date.now() + 30 * 86400000 });
    return { access_token, refresh_token, token_type: 'Bearer', expires_in: 3600, scope: principal.scopes.join(' ') };
  }
  async exchangeRefreshToken(client: OAuthClientInformationFull, raw: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    this.checkResource(resource);
    // Replay invalidation must commit, so it must occur before the transaction throws.
    const token = this.store.get<ClientToken>('tokens', hash(raw));
    if (!token || token.clientId !== client.client_id || token.kind !== 'refresh' || token.expires <= Date.now()) throw new InvalidGrantError('Invalid refresh token');
    if (token.revoked) { this.store.revokeFamily(token.family); throw new InvalidGrantError('Refresh token replay; token family revoked'); }
    if (scopes?.some(scope => !token.scopes.includes(scope as Scope))) throw new InvalidScopeError('Scope escalation rejected');
    return this.store.transaction(() => {
      token.revoked = true; this.store.put('tokens', token.tokenHash, token);
      return this.tokens({ ...token, scopes: scopes?.length ? scopes as Scope[] : token.scopes }, client.client_id, token.family);
    });
  }
  async verifyAccessToken(raw: string) {
    const token = this.store.token(raw);
    if (!token) throw new InvalidTokenError('Invalid or expired token');
    if (token.kind === 'access' && !this.clientsStore.getClient(token.clientId)) throw new InvalidTokenError('Client revoked');
    token.lastUsed = Date.now(); this.store.put('tokens', token.tokenHash, token);
    return { token: raw, clientId: token.clientId, scopes: token.scopes, expiresAt: Math.floor(token.expires / 1000), resource: new URL(this.resource), extra: { principal: token } };
  }
  async revokeToken(client: OAuthClientInformationFull, request: { token: string }) {
    const token = this.store.get<ClientToken>('tokens', hash(request.token));
    if (token?.clientId === client.client_id) this.store.revokeFamily(token.family);
  }
  revokeClient(id: string) {
    const stored = this.store.get<{ data: string; revoked: boolean }>('clients', id);
    if (stored) { stored.revoked = true; this.store.put('clients', id, stored); }
    for (const token of this.store.all<ClientToken>('tokens')) if (token.clientId === id) this.store.revokeFamily(token.family);
  }
  install(app: Express) {
    app.use(mcpAuthRouter({ provider: this, issuerUrl: new URL(this.browser.config.publicUrl), resourceServerUrl: new URL(this.resource), scopesSupported: [...SCOPES], resourceName: 'HomeAgent' }));
    app.get('/consent', this.browser.requireSession, (req, res) => {
      const request = this.store.get<AuthRequest>('authRequests', String(req.query.request));
      if (!request || request.expires < Date.now()) throw new AppError('expired', 'Authorization request expired');
      const client = this.clientsStore.getClient(request.clientId);
      if (!client) throw new AppError('invalid_client', 'Client revoked');
      const scopes = request.params.scopes?.length ? request.params.scopes as Scope[] : [...SCOPES];
      const devices = this.store.all<Device>('devices').filter(device => !device.revoked);
      const projects = devices.flatMap(device => (device.projects as { id: string; name: string }[]).map(project => `<label><input type="checkbox" name="projects" value="${h(`${device.id}:${project.id}`)}">${h(device.name)} / ${h(project.name)} (${h(project.id)})</label>`));
      res.send(page('授权客户端', `<section class="card"><h1>允许 ${h(client.client_name ?? client.client_id)} 访问</h1><p>回调地址：<code>${h(request.params.redirectUri)}</code></p><p>选择设备、具体项目与权限。执行命令使用运行账户的系统权限；新增项目不会自动加入本次授权。</p><form method="post" action="/consent"><input type="hidden" name="request" value="${h(request.id)}"><input type="hidden" name="_csrf" value="${h(res.locals.session.csrf)}"><fieldset><legend>工具权限</legend>${scopes.map(scope => `<label><input type="checkbox" name="scopes" value="${scope}" ${scope === 'read' ? 'checked' : ''}>${scope}</label>`).join('')}</fieldset><fieldset><legend>设备</legend>${devices.map(device => `<label><input type="checkbox" name="devices" value="${h(device.id)}">${h(device.name)}</label>`).join('') || '<p>请先配对设备。</p>'}</fieldset><fieldset><legend>项目（至少选择一个属于所选设备的项目）</legend>${projects.join('') || '<p>请先运行 Runner，注册项目后再授权。</p>'}</fieldset><button name="decision" value="allow">允许</button><button class="secondary" name="decision" value="deny">拒绝</button></form></section>`));
    });
    app.post('/consent', this.browser.requireSession, (req, res) => {
      const request = this.store.get<AuthRequest>('authRequests', String(req.body.request));
      if (!request || request.expires < Date.now()) throw new AppError('expired', 'Authorization request expired');
      const url = new URL(request.params.redirectUri);
      if (req.body.decision !== 'allow') url.searchParams.set('error', 'access_denied');
      else {
        const array = (value: unknown) => (Array.isArray(value) ? value : value ? [value] : []).map(String);
        const scopes = array(req.body.scopes) as Scope[], devices = array(req.body.devices);
        const requested = request.params.scopes?.length ? request.params.scopes : [...SCOPES];
        if (!scopes.length || scopes.some(scope => !requested.includes(scope)) || !devices.length || devices.some(id => !this.store.get<Device>('devices', id) || this.store.get<Device>('devices', id)!.revoked)) throw new AppError('invalid_grant', 'Select valid scopes and at least one paired device');
        const selections = array(req.body.projects), projectGrants: Record<string, string[]> = Object.fromEntries(devices.map(id => [id, []]));
        if (!selections.length) throw new AppError('invalid_grant', 'Select at least one concrete project');
        for (const selection of selections) {
          const separator = selection.indexOf(':'), deviceId = selection.slice(0, separator), projectId = selection.slice(separator + 1);
          const device = this.store.get<Device>('devices', deviceId);
          if (separator < 0 || !devices.includes(deviceId) || !(device?.projects as { id: string }[] | undefined)?.some(project => project.id === projectId)) throw new AppError('invalid_grant', 'Project is not registered on a selected device');
          if (!projectGrants[deviceId]!.includes(projectId)) projectGrants[deviceId]!.push(projectId);
        }
        const raw = secret('ha_code_');
        this.store.put('codes', hash(raw), { id: `oauth:${request.clientId}`, scopes, devices, projects: null, projectGrants, clientId: request.clientId, challenge: request.params.codeChallenge, redirect: request.params.redirectUri, resource: this.resource, expires: Date.now() + 120000 } satisfies Code);
        url.searchParams.set('code', raw);
      }
      this.store.delete('authRequests', request.id);
      if (request.params.state) url.searchParams.set('state', request.params.state);
      url.searchParams.set('iss', this.issuer); res.redirect(url.href);
    });
  }
}
