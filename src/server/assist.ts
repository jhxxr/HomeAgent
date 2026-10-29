import path from 'node:path';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ASSIST_FEATURE, ASSIST_MULTI_FEATURE, ASSIST_INVITE_MS, assistApprovalSchema, assistMultiApprovalSchema, assistDurationSchema, assistScopeSchema, assistProjects, approvedProjects, type AssistInvite, type AssistSession, type AssistAnyDescriptor } from '../shared/assist.js';
import { AppError, type Principal } from '../shared/protocol.js';
import { hash, secret, type ClientToken, type Device, type Store } from './store.js';
import { Limiter, page } from './security.js';

const inviteKey = z.object({ id: z.string().uuid(), token: z.string().min(32).max(128) }).strict();
export class AssistSessions {
  constructor(private store: Store) {}
  get(id: string) { return this.store.get<AssistSession>('assistSessions', id); }
  forDevice(device: Device) { return device.assistSessionId ? this.get(device.assistSessionId) : undefined; }
  family(id: string): ClientToken {
    const tokens = this.store.all<ClientToken>('tokens').filter(token => token.family === id && !token.revoked && token.expires > Date.now());
    const token = tokens.find(token => token.kind === 'pat') ?? tokens.find(token => token.kind === 'access') ?? tokens.find(token => token.kind === 'refresh');
    if (!token || (token.kind !== 'pat' && !this.store.get<{ revoked: boolean }>('clients', token.clientId)) || (token.kind !== 'pat' && this.store.get<{ revoked: boolean }>('clients', token.clientId)?.revoked)) throw new AppError('invalid_authorization', 'Choose an active client authorization', 409);
    const effective = this.store.resolvePermissions(token);
    if (!effective.scopes.includes('read') || (effective.tools && !effective.tools.includes('list_devices'))) throw new AppError('invalid_authorization', 'Client authorization must permit reading and device discovery', 409);
    return effective;
  }
  assertCurrent(session: AssistSession, allowPending = false) {
    if (session.state === 'ended' || (!allowPending && session.state !== 'active') || session.approval.expiresAt <= Date.now()) throw new AppError('assist_ended', 'Remote Assist is inactive or expired', 403);
    const family = this.family(session.authorizationId);
    if ((family.authorizationRevision ?? 0) !== session.authorizationRevision || family.id !== session.operatorId) throw new AppError('assist_ended', 'Client authorization changed; start a new assistance session', 403);
  }
  principal(device: Device, token: Principal, projectId?: string): Principal | undefined {
    const session = this.forDevice(device);
    if (!session || token.authorizationId !== session.authorizationId || token.id !== session.operatorId || token.authorizationRevision !== session.authorizationRevision) return;
    try { this.assertCurrent(session); } catch { return; }
    const projects = approvedProjects(session.approval), selected = projectId ? projects.find(project => project.id === projectId) : undefined;
    if (projectId && !selected) return;
    const ids = projects.map(project => project.id), scopes = selected?.scopes ?? projects.flatMap(project => project.scopes);
    return { ...token, devices: [device.id], projects: ids, projectGrants: { [device.id]: ids }, scopes: token.scopes.filter(scope => scopes.includes(scope as 'read' | 'write' | 'execute')), machineAccess: false, unrestrictedExecution: false, authorizationExpiresAt: Math.min(session.approval.expiresAt, token.authorizationExpiresAt ?? Infinity), assist: { sessionId: session.sessionId, localConsentRevision: session.localConsentRevision } };
  }
  end(id: string, reason: string) {
    const session = this.get(id);
    if (!session) return;
    if (session.state !== 'ended') {
      session.state = 'ended'; session.endedAt = Date.now(); session.reason = reason; session.cleanup = session.runnerInstanceId ? 'pending' : 'unconfirmed';
      this.store.put('assistSessions', id, session);
      const device = this.store.get<Device>('devices', session.deviceId);
      if (device) { device.revoked = true; this.store.put('devices', device.id, device); }
      this.store.audit({ principal: 'system', deviceId: session.deviceId, projectId: 'assist', tool: 'assist.ended', argsHash: hash(reason), status: 'ok', durationMs: 0 });
      this.store.emit('assistEnded', id);
    }
    return session;
  }
  descriptor(session: AssistSession): AssistAnyDescriptor {
    const { state, created, endedAt, reason, cleanup, runnerInstanceId, ...descriptor } = session;
    return descriptor;
  }
  sweep(restart = false) {
    for (const session of this.store.all<AssistSession>('assistSessions')) {
      if (session.state === 'ended') continue;
      if (restart) {
        const ended = this.end(session.sessionId, 'server_restarted');
        if (ended) { ended.cleanup = 'unconfirmed'; this.store.put('assistSessions', ended.sessionId, ended); }
        continue;
      }
      try { this.assertCurrent(session, true); } catch { this.end(session.sessionId, 'expired_or_authorization_changed'); }
      if (session.state === 'pending' && session.created + 60000 <= Date.now()) this.end(session.sessionId, 'activation_timeout');
    }
  }
  view() {
    const invites = this.store.all<AssistInvite>('assistInvites').map(({ secretHash, created, ...invite }) => invite);
    return { assistInvites: invites, assistSessions: this.store.all<AssistSession>('assistSessions') };
  }
  install(app: Express, publicUrl: string, admin: import('express').RequestHandler) {
    const limiter = new Limiter(30, 60000);
    const inspect = (input: unknown) => {
      const key = inviteKey.parse(input), invite = this.store.get<AssistInvite>('assistInvites', key.id);
      if (!invite || invite.secretHash !== hash(key.token) || invite.state !== 'pending' || invite.expiresAt <= Date.now()) throw new AppError('invalid_invite', 'Invitation expired, revoked or consumed', 410);
      const family = this.family(invite.authorizationId);
      if (family.authorizationRevision !== invite.authorizationRevision) throw new AppError('invalid_invite', 'Client authorization changed', 410);
      return invite;
    };
    app.get('/assist', (_req, res) => res.send(page('远程协助', '<section class="card narrow"><h1>HomeAgent · 远程协助</h1><p>安装 HomeAgent Runner 后运行 <code>homeagent</code>，在设置中选择“加入远程协助”，粘贴完整邀请链接。</p><p>无需管理员账号。你将在本机选择项目、权限和时长，批准后才允许 AI 访问；可随时立即停止。</p><p>程序执行拥有你的系统账户权限，不是沙箱；返回内容可能发送到操作者选择的模型服务。请仅使用你有权开放的项目。</p></section>')));
    for (const multi of [false, true]) {
      const prefix = multi ? '/assist/v2' : '/assist', feature = multi ? ASSIST_MULTI_FEATURE : ASSIST_FEATURE;
      app.post(prefix + '/inspect', (req, res) => {
        limiter.hit(req.ip ?? ''); const invite = inspect(req.body);
        const { secretHash, created, ...view } = invite; res.json({ feature, invite: view });
      });
      const claimSchema = z.object({ ...inviteKey.shape, feature: z.literal(feature), name: z.string().min(1).max(128), approval: multi ? assistMultiApprovalSchema : assistApprovalSchema }).strict();
      app.post(prefix + '/claim', (req, res) => {
        limiter.hit(req.ip ?? '');
        const body = claimSchema.parse(req.body);
        this.store.transaction(() => {
          const invite = inspect({ id: body.id, token: body.token }), approval = body.approval, projects = approvedProjects(approval);
          if (approval.durationMinutes > invite.maxDurationMinutes || projects.some(project => project.scopes.some(scope => !invite.scopes.includes(scope)) || !pathAbsolute(project.root) || project.commands.some(program => !pathAbsolute(program))) || approval.expiresAt <= Date.now() || approval.approvedAt > Date.now() + 30000) throw new AppError('invalid_consent', 'Approval exceeds the invitation or has expired');
          if (this.store.all<AssistSession>('assistSessions').filter(session => session.state !== 'ended').length >= 100) throw new AppError('assist_limit', 'Too many active assistance sessions', 429);
          const deviceId = randomUUID(), sessionId = randomUUID(), raw = secret('ha_assist_device_');
          const session: AssistSession = { sessionId, deviceId, inviteId: invite.id, operatorId: invite.operatorId, deviceOwnerId: randomUUID(), authorizationId: invite.authorizationId, authorizationRevision: invite.authorizationRevision, localConsentRevision: 1, approval, state: 'pending', created: Date.now(), cleanup: 'pending' };
          const device: Device = { id: deviceId, name: body.name, tokenHash: hash(raw), revoked: false, paused: false, projects: [], platform: '', lastSeen: 0, created: Date.now(), assistSessionId: sessionId, credentialExpiresAt: approval.expiresAt, permissions: { revision: 1, projects: assistProjects(approval), expiresAt: approval.expiresAt, fallbackProjects: [] } };
          invite.state = 'claimed'; this.store.put('assistInvites', invite.id, invite);
          this.store.put('assistSessions', sessionId, session); this.store.put('devices', deviceId, device);
          this.store.audit({ principal: 'device-owner', deviceId, projectId: '', tool: 'assist.claimed', argsHash: hash(JSON.stringify(approval)), status: 'ok', durationMs: 0 });
          res.status(201).json({ feature, descriptor: this.descriptor(session), token: raw });
        });
      });
    }
    // Each management route applies the existing browser session and CSRF checks.
    app.post('/api/assist/invites', admin, (req, res) => {
      const body = z.object({ authorizationId: z.string().min(1).max(200), operatorName: z.string().min(1).max(128), scopes: z.array(assistScopeSchema).min(1).max(3), maxDurationMinutes: assistDurationSchema }).strict().parse(req.body);
      const family = this.family(body.authorizationId);
      if (!body.scopes.includes('read') || body.scopes.some(scope => !family.scopes.includes(scope))) throw new AppError('invalid_scope', 'Choose scopes allowed for the selected client');
      if (this.store.all<AssistInvite>('assistInvites').filter(invite => invite.state === 'pending' && invite.expiresAt > Date.now()).length >= 100) throw new AppError('assist_limit', 'Too many pending invitations', 429);
      const token = secret('ha_assist_'), invite: AssistInvite = { id: randomUUID(), secretHash: hash(token), created: Date.now(), expiresAt: Date.now() + ASSIST_INVITE_MS, state: 'pending', operatorId: family.id, authorizationId: family.family, authorizationRevision: family.authorizationRevision ?? 0, operatorName: body.operatorName, scopes: body.scopes, maxDurationMinutes: body.maxDurationMinutes };
      this.store.put('assistInvites', invite.id, invite);
      const link = new URL('/assist', publicUrl); link.hash = new URLSearchParams({ id: invite.id, token }).toString();
      res.status(201).json({ id: invite.id, link: link.href, expiresAt: invite.expiresAt });
    });
    app.post('/api/assist/invites/:id/revoke', admin, (req, res) => {
      const invite = this.store.get<AssistInvite>('assistInvites', z.string().uuid().parse(req.params.id));
      if (!invite) throw new AppError('not_found', 'Invitation not found', 404);
      if (invite.state === 'pending') { invite.state = 'revoked'; this.store.put('assistInvites', invite.id, invite); }
      res.json({ ok: true });
    });
    app.post('/api/assist/sessions/:id/end', admin, (req, res) => {
      const id = z.string().uuid().parse(req.params.id);
      if (!this.get(id)) throw new AppError('not_found', 'Session not found', 404);
      this.end(id, 'operator_ended'); res.json({ ok: true, message: 'New access is blocked; task cleanup is awaiting Runner confirmation.' });
    });
  }
}
const pathAbsolute = (value: string) => path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
