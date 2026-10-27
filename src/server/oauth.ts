import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { Express, Response } from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { SCOPES, type Principal, type Scope } from '../shared/protocol.js';
import { Store, hash, secret, type BrowserSession, type ClientToken, type Device } from './store.js';
import { BrowserAuth, page } from './security.js';
import { consentFormView, consentProblemView, consentResultView } from './consent-views.js';

interface AuthRequest {
  id: string; clientId: string; params: Omit<AuthorizationParams, 'resource'> & { resource: string }; expires: number;
  completed?: { sessionId: string; submissionHash: string; redirect: string; codeHash?: string };
}
interface Code extends Principal { clientId: string; challenge: string; redirect: string; resource: string; expires: number }
const selections = (value: unknown) => [...new Set((Array.isArray(value) ? value : value ? [value] : []).map(String))].sort();
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
  private tokens(principal: Principal & { scopeLimit?: string[] }, clientId: string, family: string): OAuthTokens {
    const base = { id: principal.id, scopes: principal.scopes, devices: principal.devices, projects: principal.projects, projectGrants: principal.projectGrants, tools: principal.tools, scopeLimit: principal.scopeLimit, machineAccess: principal.machineAccess, unrestrictedExecution: principal.unrestrictedExecution, clientId, family };
    const access_token = this.store.mintToken({ ...base, kind: 'access', expires: Date.now() + 3600000 });
    const refresh_token = this.store.mintToken({ ...base, kind: 'refresh', expires: Date.now() + 30 * 86400000 });
    return { access_token, refresh_token, token_type: 'Bearer', expires_in: 3600, scope: this.store.token(access_token)!.scopes.join(' ') };
  }
  async exchangeRefreshToken(client: OAuthClientInformationFull, raw: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    this.checkResource(resource);
    // Replay invalidation must commit, so it must occur before the transaction throws.
    const token = this.store.get<ClientToken>('tokens', hash(raw));
    if (!token || token.clientId !== client.client_id || token.kind !== 'refresh' || token.expires <= Date.now()) throw new InvalidGrantError('Invalid refresh token');
    if (token.revoked) { this.store.revokeFamily(token.family); throw new InvalidGrantError('Refresh token replay; token family revoked'); }
    if (scopes?.some(scope => !this.store.resolvePermissions(token).scopes.includes(scope as Scope))) throw new InvalidScopeError('Scope escalation rejected');
    return this.store.transaction(() => {
      token.revoked = true; this.store.put('tokens', token.tokenHash, token);
      return this.tokens({ ...token, scopeLimit: scopes?.length ? scopes : token.scopeLimit }, client.client_id, token.family);
    });
  }
  async verifyAccessToken(raw: string) {
    const token = this.store.token(raw);
    if (!token) throw new InvalidTokenError('Invalid or expired token');
    if (token.kind === 'access' && !this.clientsStore.getClient(token.clientId)) throw new InvalidTokenError('Client revoked');
    const stored = this.store.get<ClientToken>('tokens', token.tokenHash)!;
    stored.lastUsed = Date.now(); this.store.put('tokens', stored.tokenHash, stored);
    token.lastUsed = stored.lastUsed;
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
  private consentProblem(res: Response, message: string, status = 410) {
    return res.status(status).send(page('授权未完成', consentProblemView(message)));
  }
  private consentPage(request: AuthRequest, res: Response, message = '', selected?: { scopes: string[]; devices: string[]; projects: string[] }) {
    const client = this.clientsStore.getClient(request.clientId);
    if (!client) return this.consentProblem(res, '客户端已被撤销。', 400);
    const scopes = request.params.scopes?.length ? request.params.scopes as Scope[] : [...SCOPES];
    const devices = this.store.all<Device>('devices').filter(device => !device.revoked);
    const isChecked = (name: 'scopes' | 'devices' | 'projects', value: string) => selected ? selected[name].includes(value) : name === 'scopes' && value === 'read';
    return res.send(page('授权客户端', consentFormView({
      clientName: client.client_name ?? client.client_id,
      redirectUri: request.params.redirectUri,
      requestId: request.id,
      csrf: res.locals.session.csrf,
      message,
      scopes: scopes.map(id => ({ id, checked: isChecked('scopes', id) })),
      devices: devices.map(device => ({ id: device.id, name: device.name, checked: isChecked('devices', device.id) })),
      projects: devices.flatMap(device => (device.projects as { id: string; name: string }[]).map(project => ({
        value: `${device.id}:${project.id}`, deviceId: device.id, deviceName: device.name,
        projectId: project.id, projectName: project.name, checked: isChecked('projects', `${device.id}:${project.id}`),
      }))),
    })));
  }
  private consentComplete(request: AuthRequest, res: Response) {
    const completed = request.completed!;
    if (completed.sessionId !== (res.locals.session as BrowserSession).id) return this.consentProblem(res, '此授权已由其他登录会话处理。', 403);
    if (!this.clientsStore.getClient(request.clientId)) return this.consentProblem(res, '客户端已被撤销。', 400);
    const code = completed.codeHash ? this.store.get<Code>('codes', completed.codeHash) : undefined;
    if (completed.codeHash && (!code || code.expires <= Date.now())) return res.send(page('授权已提交', consentResultView({ kind: 'submitted' })));
    return res.send(page('返回客户端', consentResultView({ kind: completed.codeHash ? 'saved' : 'denied', redirect: this.decrypt(completed.redirect) })));
  }
  install(app: Express) {
    app.use(mcpAuthRouter({ provider: this, issuerUrl: new URL(this.browser.config.publicUrl), resourceServerUrl: new URL(this.resource), scopesSupported: [...SCOPES], resourceName: 'HomeAgent' }));
    app.get('/consent', this.browser.requireSession, (req, res) => {
      const request = this.store.get<AuthRequest>('authRequests', String(req.query.request));
      if (!request || request.expires <= Date.now()) return this.consentProblem(res, '授权请求已过期或不存在。');
      if (request.completed) return this.consentComplete(request, res);
      return this.consentPage(request, res);
    });
    app.get('/consent/complete', this.browser.requireSession, (req, res) => {
      const request = this.store.get<AuthRequest>('authRequests', String(req.query.request));
      if (!request || request.expires <= Date.now()) return this.consentProblem(res, '授权请求已过期或不存在。');
      if (!request.completed) return this.consentProblem(res, '授权尚未提交，请返回客户端重新开始。', 400);
      return this.consentComplete(request, res);
    });
    app.post('/consent', this.browser.requireSession, (req, res) => {
      const request = this.store.get<AuthRequest>('authRequests', String(req.body.request));
      if (!request || request.expires <= Date.now()) return this.consentProblem(res, '授权请求已过期或不存在。');
      if (!this.clientsStore.getClient(request.clientId)) return this.consentProblem(res, '客户端已被撤销。', 400);
      const decision = req.body.decision;
      if (!['allow', 'deny'].includes(decision)) return this.consentProblem(res, '请选择允许或拒绝。', 400);
      const selected = { scopes: selections(req.body.scopes), devices: selections(req.body.devices), projects: selections(req.body.projects) };
      const submissionHash = hash(JSON.stringify(decision === 'allow' ? { decision, ...selected } : { decision }));
      const completePath = `/consent/complete?request=${encodeURIComponent(request.id)}`;
      if (request.completed) {
        if (request.completed.sessionId !== (res.locals.session as BrowserSession).id) return this.consentProblem(res, '此授权已由其他登录会话处理。', 403);
        if (request.completed.submissionHash !== submissionHash) return this.consentProblem(res, '此请求已处理，不能修改权限或决定。', 409);
        return res.redirect(303, completePath);
      }
      const url = new URL(request.params.redirectUri);
      let codeHash: string | undefined, code: Code | undefined;
      if (decision === 'deny') url.searchParams.set('error', 'access_denied');
      else {
        const scopes = selected.scopes as Scope[], devices = selected.devices;
        const requested = request.params.scopes?.length ? request.params.scopes : [...SCOPES];
        if (!scopes.length || scopes.some(scope => !requested.includes(scope)) || !devices.length || devices.some(id => !this.store.get<Device>('devices', id) || this.store.get<Device>('devices', id)!.revoked)) return this.consentPage(request, res.status(400), '请选择有效权限和至少一台已配对设备。', selected);
        const projectGrants: Record<string, string[]> = Object.fromEntries(devices.map(id => [id, []]));
        if (!selected.projects.length) return this.consentPage(request, res.status(400), '请至少选择一个所选设备上的具体项目。', selected);
        for (const selection of selected.projects) {
          const separator = selection.indexOf(':'), deviceId = selection.slice(0, separator), projectId = selection.slice(separator + 1);
          const device = this.store.get<Device>('devices', deviceId);
          if (separator < 0 || !devices.includes(deviceId) || !(device?.projects as { id: string }[] | undefined)?.some(project => project.id === projectId)) return this.consentPage(request, res.status(400), '项目必须属于所选设备，请检查设备与项目选择。', selected);
          if (!projectGrants[deviceId]!.includes(projectId)) projectGrants[deviceId]!.push(projectId);
        }
        const raw = secret('ha_code_');
        codeHash = hash(raw);
        code = { id: `oauth:${request.clientId}`, scopes, devices, projects: null, projectGrants, clientId: request.clientId, challenge: request.params.codeChallenge, redirect: request.params.redirectUri, resource: this.resource, expires: Date.now() + 120000 };
        url.searchParams.set('code', raw);
      }
      if (request.params.state) url.searchParams.set('state', request.params.state);
      url.searchParams.set('iss', this.issuer);
      request.completed = { sessionId: (res.locals.session as BrowserSession).id, submissionHash, redirect: this.encrypt(url.href), codeHash };
      request.expires = Date.now() + 120000;
      this.store.transaction(() => {
        if (code && codeHash) this.store.put('codes', codeHash, code);
        this.store.put('authRequests', request.id, request);
      });
      // A form redirect to another origin can be blocked by form-action 'self'.
      // Finish the form navigation here, then navigate from a same-origin HTML page.
      return res.redirect(303, completePath);
    });
  }
}
