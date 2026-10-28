import express, { type ErrorRequestHandler } from 'express';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { AppError, MAX_FRAME, RUNNER_PROTOCOL, SCOPES, VERSION, type ToolResult } from '../shared/protocol.js';
import type { ServerConfig } from './config.js';
import { Store, hash, secret, type Pairing, type Device, type ClientToken, type BrowserSession } from './store.js';
import { BrowserAuth, Limiter, escapeHtml as h, page } from './security.js';
import { OAuth } from './oauth.js';
import { Hub } from './hub.js';
import { installPermissionRoutes, permissionState } from './permissions.js';
import { createMcpEndpoint, type AuthInfo } from './mcp.js';
import { permissionProjectSchema } from '../shared/permissions.js';
import { dashboard } from './dashboard.js';

const tokenInput = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(SCOPES)).min(1),
  devices: z.array(z.string().min(1)).min(1),
  projects: z.array(z.string().min(1)).nullable().default(null),
  projectGrants: z.record(z.string().uuid(), z.array(z.string().min(1).max(64))).optional(),
  unrestrictedExecution: z.boolean().default(false),
  machineAccess: z.boolean().default(false),
  expiresDays: z.number().int().min(1).max(365).default(30),
}).strict();
const safeNext = (input: unknown) => typeof input === 'string' && input.startsWith('/') && !input.startsWith('//') && !/[\\\u0000-\u0020]/.test(input) ? input : '/';
const jobResponse = (output: ToolResult) => {
  const value = JSON.parse(output.content[0]!.text) as { message?: string };
  if (output.isError) throw new AppError('job_tool_error', value.message ?? 'Runner rejected the job operation', 409);
  return value;
};
export function createHomeServer(config: ServerConfig) {
  const store = new Store(config.db), hub = new Hub(store), browser = new BrowserAuth(store, config), oauth = new OAuth(store, browser);
  const app = express(), server = createServer(app);
  const mcp = createMcpEndpoint(store, hub, config.publicUrl);
  app.disable('x-powered-by'); app.set('trust proxy', config.trustProxyHops);
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
    if (config.publicUrl.startsWith('https:')) res.set('Strict-Transport-Security', 'max-age=31536000');
    if (req.headers.origin && req.headers.origin !== config.publicUrl) { res.status(403).json({ error: 'origin_rejected' }); return; }
    // Validate the actual Host header before trusting forwarding headers.
    const validHosts = new Set([new URL(config.publicUrl).host, `${config.host}:${config.port}`, `127.0.0.1:${config.port}`, `localhost:${config.port}`]);
    if (!validHosts.has(req.headers.host ?? '')) { res.status(403).json({ error: 'host_rejected' }); return; }
    next();
  });
  app.use(express.json({ limit: '512kb' })); app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  app.use('/assets', express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../public'), { dotfiles: 'deny', index: false }));
  app.get('/health', (_req, res) => { store.db.prepare('SELECT 1').get(); res.json({ status: 'ok', version: VERSION, runnerProtocol: RUNNER_PROTOCOL }); });
  app.get('/login', (req, res) => res.send(page('登录', `<section class="login-page" aria-labelledby="loginTitle">
    <div class="login-intro"><img class="login-brandmark" src="/assets/favicon.svg" width="72" height="72" alt=""><p class="eyebrow">YOUR PRIVATE WORKSPACE</p><h1>让 AI 与你的<br>开发环境协作。</h1><p>连接自己的机器，在一个控制台中管理设备、项目权限和执行任务。</p>
      <ul class="login-points"><li><strong>在自己的机器上执行</strong><span>文件、命令与 Git 操作由本地 Runner 完成。</span></li><li><strong>为每个客户端指定权限</strong><span>选择可访问的项目，以及只读或完整开发权限。</span></li><li><strong>连接状态与任务一目了然</strong><span>查看设备、读取输出，并随时收回授权。</span></li></ul><p class="login-note">自托管 MCP · Linux / Windows · v${VERSION}</p></div>
    <section class="login-card"><p class="eyebrow">WELCOME BACK</p><h2 id="loginTitle">登录控制台</h2><p class="login-description">使用管理员密码，继续管理你的开发环境。</p>
      <form id="loginForm" method="post" action="/login"><input type="hidden" name="next" value="${h(safeNext(req.query.next))}"><label for="adminPassword">管理员密码</label><div class="password-field"><input id="adminPassword" type="password" name="password" minlength="16" required autocomplete="current-password" placeholder="输入管理员密码" aria-describedby="passwordHelp"><button class="password-toggle secondary" type="button" aria-controls="adminPassword" aria-pressed="false">显示</button></div><p id="passwordHelp" class="muted">管理员密码由此服务的部署者设置。</p><p id="loginError" class="login-error" role="alert" hidden></p><button type="submit">登录</button></form><p class="login-security">仅授权管理员可以管理此服务的设备和访问权限。</p>
    </section></section><script src="/assets/auth.js" defer></script>`)));
  app.post('/login', (req, res) => { browser.login(req, res, z.string().max(1024).parse(req.body.password)); res.redirect(safeNext(req.body.next)); });
  app.post('/logout', browser.requireSession, (_req, res) => {
    store.delete('sessions', res.locals.session.id);
    res.clearCookie(config.publicUrl.startsWith('https:') ? '__Host-ha_session' : 'ha_session', { path: '/' }); res.json({ ok: true });
  });
  app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json({ resource: `${config.publicUrl}/mcp`, authorization_servers: [oauth.issuer], scopes_supported: [...SCOPES], bearer_methods_supported: ['header'], resource_name: 'HomeAgent' }));
  oauth.install(app);
  const pairStartLimiter = new Limiter(10, 600000), pairPollLimiter = new Limiter(90, 60000), approveLimiter = new Limiter(10, 60000), pairLinkLimiter = new Limiter(20, 60000), mcpLimiter = new Limiter(600, 60000);
  app.post('/pair/start', (req, res) => {
    pairStartLimiter.hit(req.ip ?? '');
    const { name } = z.object({ name: z.string().min(1).max(128) }).strict().parse(req.body);
    const code = randomBytes(5).toString('hex').toUpperCase(), pollToken = secret(), approvalToken = secret('ha_pair_');
    const pairing: Pairing = { id: randomUUID(), codeHash: hash(code), pollHash: hash(pollToken), approvalHash: hash(approvalToken), name, expires: Date.now() + 600000, state: 'pending' };
    store.put('pairings', pairing.id, pairing);
    const verificationUrl = new URL('/pair/verify', config.publicUrl);
    verificationUrl.searchParams.set('id', pairing.id);
    verificationUrl.searchParams.set('token', approvalToken);
    res.status(201).json({ id: pairing.id, code, pollToken, expires: pairing.expires, verificationUrl: verificationUrl.href });
  });
  app.post('/pair/claim', (req, res) => {
    pairPollLimiter.hit(req.ip ?? '');
    const body = z.object({ id: z.string().uuid(), pollToken: z.string().max(256) }).strict().parse(req.body);
    store.transaction(() => {
      const pairing = store.get<Pairing>('pairings', body.id);
      if (!pairing || pairing.pollHash !== hash(body.pollToken) || pairing.expires <= Date.now() || pairing.state === 'claimed') throw new AppError('invalid_pairing', 'Pairing expired, consumed or invalid', 401);
      if (pairing.state === 'pending') { res.status(202).json({ status: 'pending' }); return; }
      const raw = secret('ha_device_'), deviceId = randomUUID();
      const device: Device = { id: deviceId, name: pairing.name, tokenHash: hash(raw), revoked: false, paused: false, projects: [], platform: '', lastSeen: 0, created: Date.now() };
      if (pairing.projects?.length) {
        device.permanentProjects = pairing.projects;
        device.permissions = { revision: 1, projects: pairing.projects, expiresAt: null, fallbackProjects: pairing.projects };
      }
      pairing.state = 'claimed'; pairing.deviceId = deviceId;
      store.put('devices', deviceId, device); store.put('pairings', pairing.id, pairing);
      store.audit({ principal: 'admin', deviceId, projectId: '', tool: 'device.paired', argsHash: hash(pairing.id), status: 'ok', durationMs: 0 });
      res.json({ deviceId, token: raw });
    });
  });
  app.get('/pair/verify', browser.requireSession, (req, res) => {
    pairLinkLimiter.hit(req.ip ?? '');
    const id = z.string().uuid().parse(req.query.id);
    const token = z.string().min(32).max(256).parse(req.query.token);
    const pairing = store.get<Pairing>('pairings', id);
    if (!pairing || !pairing.approvalHash || pairing.approvalHash !== hash(token) || pairing.expires <= Date.now()) {
      return res.status(410).send(page('配对链接已失效', `<section class="card narrow"><h1>配对链接已失效</h1><p role="alert">此设备登录链接已过期、无效或已经完成。请在 Runner 重新执行登录。</p><a href="/">打开 Dashboard</a></section>`));
    }
    const projectInput = '<label>首个项目目录（可稍后配置）<input name="root" maxlength="4096" placeholder="被控端上的绝对路径，如 E:/Projects/my-app" autocomplete="off"></label><label>访问权限<select name="access"><option value="read">只读查看</option><option value="full">完整开发（读写文件和运行程序）</option></select></label><label class="permission-switch"><input type="checkbox" name="git" value="on">允许 Git 操作（仅在完整开发模式下生效）</label><p class="muted">目录和权限保存在 Server 上，稍后也可在设备设置弹窗中修改。</p>';
    const status = pairing.state === 'pending'
      ? `<p>请核对设备名称后批准。HomeAgent 交互界面会自动保存凭据、连接并应用项目配置。</p><form method="post" action="/pair/verify"><input type="hidden" name="id" value="${h(id)}"><input type="hidden" name="token" value="${h(token)}"><input type="hidden" name="_csrf" value="${h(res.locals.session.csrf)}">${projectInput}<button>批准并配置设备</button></form>`
      : `<p class="success">设备已批准，${pairing.state === 'claimed' ? 'Runner 已领取凭据。' : '等待 Runner 领取凭据。'}返回终端查看自动连接状态；如已退出，运行 <code>homeagent</code> 重新进入。</p><a class="button" href="/">进入 Dashboard 配置设备</a>`;
    return res.send(page('配置设备', `<section class="card narrow"><p class="eyebrow">DEVICE LOGIN</p><h1>配置被控端设备</h1><p>设备名称：<strong>${h(pairing.name)}</strong></p><p>链接有效期至：${h(new Date(pairing.expires).toLocaleString())}</p>${status}<p class="muted">进入 Dashboard 后，可在“设备与项目”中调整项目目录、只读、命令执行和 Git 权限。</p></section>`));
  });
  app.post('/pair/verify', browser.requireSession, (req, res) => {
    pairLinkLimiter.hit(req.ip ?? '');
    const body = z.object({
      id: z.string().uuid(), token: z.string().min(32).max(256), root: z.string().trim().max(4096).default(''),
      access: z.enum(['read', 'full']).default('read'), git: z.union([z.boolean(), z.literal('on')]).default(false),
    }).parse(req.body);
    const pairing = store.get<Pairing>('pairings', body.id);
    if (!pairing || !pairing.approvalHash || pairing.approvalHash !== hash(body.token) || pairing.expires <= Date.now()) throw new AppError('invalid_pairing', '配对链接已过期或无效');
    if (pairing.state === 'pending') {
      if (body.root) {
        if (body.root.includes('\0') || !(path.posix.isAbsolute(body.root) || path.win32.isAbsolute(body.root))) throw new AppError('invalid_root', '请输入被控端上的绝对目录路径');
        const full = body.access === 'full', git = full && (body.git === true || body.git === 'on');
        pairing.projects = [permissionProjectSchema.parse({
          id: 'workspace', name: 'Workspace', root: body.root, readOnly: !full,
          commandMode: full ? 'unrestricted' : 'allowlist', allowGitWrite: git, allowGitNetwork: git, allowGitPush: git,
        })];
      }
      pairing.state = 'approved'; store.put('pairings', pairing.id, pairing);
      store.audit({ principal: 'admin', deviceId: '', projectId: '', tool: 'device.pairing_approved', argsHash: hash(pairing.id), status: 'ok', durationMs: 0 });
    }
    const next = new URL('/pair/verify', config.publicUrl);
    next.searchParams.set('id', pairing.id); next.searchParams.set('token', body.token);
    res.redirect(303, `${next.pathname}${next.search}`);
  });
  app.use('/api', browser.requireSession);
  installPermissionRoutes(app, store, hub);
  app.get('/api/state', (_req, res) => {
    const tokens = store.all<ClientToken>('tokens').filter(token => token.kind !== 'refresh' && token.expires > Date.now()).map(token => store.resolvePermissions(token)).map(({ tokenHash, ...token }) => ({ ...token, tokenId: tokenHash }));
    const clients = store.db.prepare("SELECT id FROM records WHERE bucket='clients'").all().map(row => oauth.clientsStore.getClient(row.id as string)).filter(Boolean).map(client => ({ id: client!.client_id, name: client!.client_name ?? client!.client_id, redirects: client!.redirect_uris }));
    const sessions = store.all<BrowserSession>('sessions').filter(session => session.expires > Date.now()).map(({ csrf, ...session }) => ({ ...session, current: session.id === res.locals.session.id }));
    res.json({ csrf: res.locals.session.csrf, devices: hub.devices(), tokens, clients, sessions, clientCount: clients.length, jobs: hub.jobs(undefined, { limit: 200 }), audit: store.audits(100), publicUrl: config.publicUrl, version: VERSION, runnerProtocol: RUNNER_PROTOCOL, runtime: { node: process.version, platform: process.platform, arch: process.arch }, ...permissionState(store) });
  });
  app.post('/api/sessions/:id/revoke', (req, res) => {
    const id = z.string().regex(/^[a-f0-9]{64}$/).parse(req.params.id);
    store.delete('sessions', id);
    store.audit({ principal: 'admin', deviceId: '', projectId: '', tool: 'admin.session_revoked', argsHash: hash(id), status: 'ok', durationMs: 0 });
    res.json({ current: id === res.locals.session.id });
  });
  app.get('/api/jobs', (req, res) => {
    const query = z.object({ deviceId: z.string().uuid().optional(), projectId: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }).parse(req.query);
    res.json(hub.jobs(undefined, query));
  });
  app.get('/api/jobs/:deviceId/:id/output', async (req, res) => {
    const ids = z.object({ deviceId: z.string().uuid(), id: z.string().uuid() }).parse(req.params);
    const { cursor, length, view } = z.object({ cursor: z.coerce.number().int().min(0).optional(), length: z.coerce.number().int().min(1).max(65536).default(65536), view: z.enum(['prefix', 'tail']).default('prefix') }).parse(req.query);
    res.json(jobResponse(await hub.manageJob(ids.deviceId, ids.id, view === 'tail' ? 'tail' : 'output', cursor, length)));
  });
  app.post('/api/jobs/:deviceId/:id/stop', async (req, res) => {
    const ids = z.object({ deviceId: z.string().uuid(), id: z.string().uuid() }).parse(req.params);
    res.json(jobResponse(await hub.manageJob(ids.deviceId, ids.id, 'stop')));
  });
  app.get('/api/audit', (req, res) => {
    const limit = z.coerce.number().int().min(1).max(1000).default(100).parse(req.query.limit);
    const before = z.coerce.number().int().positive().default(Date.now() + 1).parse(req.query.before);
    const beforeId = z.string().uuid().optional().parse(req.query.beforeId);
    res.json(store.audits(limit, before, beforeId));
  });
  app.post('/api/pair/inspect', (req, res) => {
    approveLimiter.hit(req.ip ?? '');
    const code = z.string().regex(/^[A-Fa-f0-9]{10}$/).parse(req.body.code).toUpperCase();
    const pairing = store.all<Pairing>('pairings').find(item => item.codeHash === hash(code) && item.state === 'pending' && item.expires > Date.now());
    if (!pairing) throw new AppError('invalid_pairing', '配对码无效或已过期');
    res.json({ name: pairing.name, expires: pairing.expires });
  });
  app.post('/api/pair/approve', (req, res) => {
    approveLimiter.hit(req.ip ?? '');
    const code = z.string().regex(/^[A-Fa-f0-9]{10}$/).parse(req.body.code).toUpperCase();
    const pairing = store.all<Pairing>('pairings').find(item => item.codeHash === hash(code) && item.state === 'pending' && item.expires > Date.now());
    if (!pairing) throw new AppError('invalid_pairing', '配对码无效或已过期');
    pairing.state = 'approved'; store.put('pairings', pairing.id, pairing);
    res.json({ approved: true, name: pairing.name });
  });
  app.post('/api/devices/:id/:action', (req, res) => {
    const device = store.get<Device>('devices', String(req.params.id));
    if (!device || device.revoked) throw new AppError('not_found', 'Device not found', 404);
    const action = z.enum(['pause', 'resume', 'revoke', 'rename']).parse(req.params.action);
    if (action === 'rename') device.name = z.string().min(1).max(128).parse(req.body.name);
    else if (action === 'revoke') device.revoked = true;
    else device.paused = action === 'pause';
    store.put('devices', device.id, device);
    if (device.revoked || device.paused) hub.disconnect(device.id, device.revoked);
    store.audit({ principal: 'admin', deviceId: device.id, projectId: '', tool: `device.${action}`, argsHash: hash(JSON.stringify(req.body)), status: 'ok', durationMs: 0 });
    res.json({ ok: true });
  });
  app.post('/api/tokens', (req, res) => {
    const body = tokenInput.parse(req.body);
    if (body.devices.some(id => !store.get<Device>('devices', id) || store.get<Device>('devices', id)!.revoked)) throw new AppError('invalid_device', 'Select existing paired devices');
    if (body.projectGrants) for (const [deviceId, projects] of Object.entries(body.projectGrants)) {
      const device = store.get<Device>('devices', deviceId);
      if (!body.devices.includes(deviceId) || projects.some(id => !(device?.projects as { id: string }[] | undefined)?.some(project => project.id === id))) throw new AppError('invalid_project', 'Qualified project grants must select registered projects on granted devices');
    }
    const id = randomUUID();
    const token = store.mintToken({ id: `pat:${id}`, kind: 'pat', clientId: body.name, family: id, scopes: body.scopes, devices: body.devices, projects: body.projects, projectGrants: body.projectGrants, unrestrictedExecution: body.unrestrictedExecution, machineAccess: body.machineAccess, expires: Date.now() + body.expiresDays * 86400000 });
    store.audit({ principal: 'admin', deviceId: '', projectId: '', tool: 'token.created', argsHash: hash(id), status: 'ok', durationMs: 0 });
    res.status(201).json({ token, tokenId: hash(token) });
  });
  app.post('/api/tokens/:id/revoke', (req, res) => {
    const token = store.get<ClientToken>('tokens', String(req.params.id));
    if (!token) throw new AppError('not_found', 'Token not found', 404);
    store.revokeFamily(token.family);
    if (token.kind === 'access') oauth.revokeClient(token.clientId);
    store.audit({ principal: 'admin', deviceId: '', projectId: '', tool: 'token.revoked', argsHash: hash(token.id), status: 'ok', durationMs: 0 });
    res.json({ ok: true });
  });
  app.get('/api/clients', (_req, res) => {
    const rows = store.db.prepare("SELECT id FROM records WHERE bucket='clients'").all();
    res.json(rows.map(row => oauth.clientsStore.getClient(row.id as string)).filter(Boolean).map(client => ({ id: client!.client_id, name: client!.client_name, redirects: client!.redirect_uris })));
  });
  app.post('/api/clients/:id/revoke', (req, res) => {
    oauth.revokeClient(String(req.params.id));
    store.audit({ principal: 'admin', deviceId: '', projectId: '', tool: 'oauth_client.revoked', argsHash: hash(String(req.params.id)), status: 'ok', durationMs: 0 });
    res.json({ ok: true });
  });
  app.get('/', browser.requireSession, (_req, res) => res.send(page('控制台', dashboard, { console: true })));
  app.all('/mcp', async (req, res) => {
    const raw = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '')?.[1];
    let principal: ClientToken;
    let authInfo: AuthInfo;
    try {
      if (!raw) throw new Error();
      authInfo = await oauth.verifyAccessToken(raw);
      principal = authInfo.extra!.principal as ClientToken;
      mcpLimiter.hit(hash(raw));
    } catch (error) {
      if (error instanceof AppError && error.status === 429) throw error;
      res.set('WWW-Authenticate', `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource/mcp"`);
      res.status(401).json({ error: 'invalid_token' }); return;
    }
    if (req.method !== 'POST') {
      res.set('Allow', 'POST'); res.status(405).json({ error: 'method_not_allowed' }); return;
    }
    (req as typeof req & { auth: AuthInfo }).auth = authInfo;
    await mcp.node(req, res, req.body);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const token = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const deviceId = req.headers['x-device-id'];
    const device = typeof deviceId === 'string' ? store.get<Device>('devices', deviceId) : undefined;
    if (req.url !== '/runner' || req.headers.origin || !token || !device || device.revoked || device.tokenHash !== hash(token)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
    }
    if (device.paused) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => hub.attach(device, ws));
  });
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) { res.end(); return; }
    if (error instanceof AppError) res.status(error.status).json({ error: error.code, message: error.message });
    else if (error instanceof z.ZodError) res.status(400).json({ error: 'invalid_input', message: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
    else if (error?.type === 'entity.too.large') res.status(413).json({ error: 'body_limit' });
    else if (error instanceof SyntaxError) res.status(400).json({ error: 'invalid_json' });
    else { console.error('Request failed:', error instanceof Error ? error.name : 'unknown'); res.status(500).json({ error: 'internal_error' }); }
  };
  app.use(errors);
  store.prune(config.retentionDays);
  const prune = setInterval(() => store.prune(config.retentionDays), 3600000).unref();
  server.requestTimeout = 60000; server.headersTimeout = 15000;
  return {
    app, server, store, hub, oauth, browser,
    listen: () => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); }); }),
    close: async () => {
      clearInterval(prune); hub.close();
      await mcp.handler.close();
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
      store.close();
    },
  };
}
