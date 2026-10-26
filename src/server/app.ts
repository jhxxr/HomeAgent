import express, { type ErrorRequestHandler } from 'express';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { AppError, MAX_FRAME, SCOPES, VERSION, type ToolResult } from '../shared/protocol.js';
import type { ServerConfig } from './config.js';
import { Store, hash, secret, type Pairing, type Device, type ClientToken, type BrowserSession } from './store.js';
import { BrowserAuth, Limiter, escapeHtml as h, page } from './security.js';
import { OAuth } from './oauth.js';
import { Hub } from './hub.js';
import { createMcpEndpoint, type AuthInfo } from './mcp.js';

const tokenInput = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(SCOPES)).min(1),
  devices: z.array(z.string().min(1)).min(1),
  projects: z.array(z.string().min(1)).nullable().default(null),
  projectGrants: z.record(z.string().uuid(), z.array(z.string().min(1).max(64))).optional(),
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
  const mcp = createMcpEndpoint(store, hub);
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
  app.get('/health', (_req, res) => { store.db.prepare('SELECT 1').get(); res.json({ status: 'ok', version: VERSION }); });
  app.get('/login', (req, res) => res.send(page('登录', `<section class="card narrow"><p class="eyebrow">CONTROL PLANE</p><h1>登录 HomeAgent</h1><p>管理设备、客户端权限与调用记录。</p><form method="post" action="/login"><input type="hidden" name="next" value="${h(safeNext(req.query.next))}"><label>管理员密码<input type="password" name="password" minlength="16" required autocomplete="current-password"></label><button>登录</button></form></section>`)));
  app.post('/login', (req, res) => { browser.login(req, res, z.string().max(1024).parse(req.body.password)); res.redirect(safeNext(req.body.next)); });
  app.post('/logout', browser.requireSession, (_req, res) => {
    store.delete('sessions', res.locals.session.id);
    res.clearCookie(config.publicUrl.startsWith('https:') ? '__Host-ha_session' : 'ha_session', { path: '/' }); res.json({ ok: true });
  });
  app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json({ resource: `${config.publicUrl}/mcp`, authorization_servers: [oauth.issuer], scopes_supported: [...SCOPES], bearer_methods_supported: ['header'], resource_name: 'HomeAgent' }));
  oauth.install(app);
  const pairStartLimiter = new Limiter(10, 600000), pairPollLimiter = new Limiter(90, 60000), approveLimiter = new Limiter(10, 60000), mcpLimiter = new Limiter(600, 60000);
  app.post('/pair/start', (req, res) => {
    pairStartLimiter.hit(req.ip ?? '');
    const { name } = z.object({ name: z.string().min(1).max(128) }).strict().parse(req.body);
    const code = randomBytes(5).toString('hex').toUpperCase(), pollToken = secret();
    const pairing: Pairing = { id: randomUUID(), codeHash: hash(code), pollHash: hash(pollToken), name, expires: Date.now() + 600000, state: 'pending' };
    store.put('pairings', pairing.id, pairing);
    res.status(201).json({ id: pairing.id, code, pollToken, expires: pairing.expires, verificationUrl: `${config.publicUrl}/` });
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
      pairing.state = 'claimed'; pairing.deviceId = deviceId;
      store.put('devices', deviceId, device); store.put('pairings', pairing.id, pairing);
      store.audit({ principal: 'admin', deviceId, projectId: '', tool: 'device.paired', argsHash: hash(pairing.id), status: 'ok', durationMs: 0 });
      res.json({ deviceId, token: raw });
    });
  });
  app.use('/api', browser.requireSession);
  app.get('/api/state', (_req, res) => {
    const tokens = store.all<ClientToken>('tokens').filter(token => token.kind !== 'refresh' && token.expires > Date.now()).map(({ tokenHash, ...token }) => ({ ...token, tokenId: tokenHash }));
    const clients = store.db.prepare("SELECT id FROM records WHERE bucket='clients'").all().map(row => oauth.clientsStore.getClient(row.id as string)).filter(Boolean).map(client => ({ id: client!.client_id, name: client!.client_name ?? client!.client_id, redirects: client!.redirect_uris }));
    const sessions = store.all<BrowserSession>('sessions').filter(session => session.expires > Date.now()).map(({ csrf, ...session }) => ({ ...session, current: session.id === res.locals.session.id }));
    res.json({ csrf: res.locals.session.csrf, devices: hub.devices(), tokens, clients, sessions, clientCount: clients.length, jobs: hub.jobs(undefined, { limit: 200 }), audit: store.audits(100), publicUrl: config.publicUrl });
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
    const token = store.mintToken({ id: `pat:${id}`, kind: 'pat', clientId: body.name, family: id, scopes: body.scopes, devices: body.devices, projects: body.projects, projectGrants: body.projectGrants, expires: Date.now() + body.expiresDays * 86400000 });
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
  app.get('/', browser.requireSession, (_req, res) => res.send(page('控制台', dashboard)));
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
const dashboard = `
<section class="intro"><div><p class="eyebrow">YOUR MACHINES, YOUR CONTROL</p><h1>远程开发控制台</h1><p>管理设备连接、项目授权和每次工具调用。</p></div><button id="logout" class="secondary">退出登录</button></section>
<p id="notice" role="status" aria-live="polite"></p>
<div class="stats"><article><span id="online">—</span><p>在线设备</p></article><article><span id="total">—</span><p>已配对设备</p></article><article><span id="clientCount">—</span><p>OAuth 客户端</p></article><article><span id="calls">—</span><p>最近调用</p></article></div>
<div class="columns"><section class="card"><h2>设备配对</h2><p>在 Runner 执行 pair，核对设备名称后输入一次性配对码。</p><form id="pair"><label>一次性码<input name="code" required maxlength="10" pattern="[A-Fa-f0-9]{10}" placeholder="10 位配对码" autocomplete="off"></label><button>批准配对</button></form><p id="pairResult"></p></section>
<section class="card"><h2>MCP 连接</h2><code id="endpoint"></code><p>OAuth 客户端使用此地址。需要 Bearer Token 的客户端可在下方创建授权令牌。</p><a href="/.well-known/oauth-authorization-server" target="_blank" rel="noreferrer">查看 OAuth 元数据</a></section></div>
<section class="card"><div class="section-title"><h2>设备与项目</h2><span id="updated"></span></div><div id="devices" class="device-grid"></div></section>
<section class="card"><h2>长任务与执行记录</h2><p>重连后自动核对任务状态。离线时保留最近观察，不把断线当作执行成功。</p><div class="scroll"><table><thead><tr><th>开始时间</th><th>程序 / 任务</th><th>设备 / 项目</th><th>状态</th><th>输出字节</th><th>操作</th></tr></thead><tbody id="jobs"></tbody></table></div><section id="jobOutputPanel" hidden><div class="section-title"><h3>任务输出</h3><button id="jobOutputNext" class="secondary">读取下一段</button></div><pre id="jobOutput"></pre></section></section>
<section class="card"><h2>创建客户端令牌</h2><form id="token"><div class="form-grid"><label>客户端名称<input name="name" required maxlength="100" placeholder="Cursor 工作站"></label><label>有效天数<input name="days" type="number" min="1" max="365" value="30" required></label><label>项目 ID（可选，逗号分隔）<input name="projects" placeholder="为空表示所选设备的所有项目"></label></div><fieldset><legend>设备范围</legend><div id="tokenDevices"></div></fieldset><fieldset><legend>工具权限</legend><label><input type="checkbox" name="scopes" value="read" checked>read 读取</label><label><input type="checkbox" name="scopes" value="write">write 写入</label><label><input type="checkbox" name="scopes" value="execute">execute 终端</label><label><input type="checkbox" name="scopes" value="git">git 提交</label></fieldset><button>创建令牌</button></form><pre id="newToken" hidden></pre><p id="tokenHint" hidden>令牌仅展示一次，请安全保存。刷新后不再显示。</p></section>
<section class="card"><h2>客户端授权与令牌</h2><div class="scroll"><table><thead><tr><th>客户端</th><th>类型</th><th>权限</th><th>最近使用</th><th>到期时间</th><th>操作</th></tr></thead><tbody id="tokens"></tbody></table></div></section>
<section class="card"><h2>管理员登录会话</h2><div class="scroll"><table><thead><tr><th>浏览器</th><th>最近使用</th><th>到期时间</th><th>状态</th><th>操作</th></tr></thead><tbody id="sessions"></tbody></table></div></section>
<section class="card"><h2>已注册 OAuth 客户端</h2><div class="scroll"><table><thead><tr><th>客户端</th><th>回调地址</th><th>操作</th></tr></thead><tbody id="oauthClients"></tbody></table></div></section>
<section class="card"><div class="section-title"><h2>审计日志</h2><a href="/api/audit?limit=1000" target="_blank" rel="noreferrer">查看 JSON</a></div><p>记录主体、目标、参数摘要和结果；不保存文件内容或命令输出。</p><div class="scroll"><table><thead><tr><th>时间</th><th>工具</th><th>设备 / 项目</th><th>主体</th><th>结果</th><th>耗时</th></tr></thead><tbody id="audit"></tbody></table></div></section>
<script type="module" src="/assets/dashboard.js"></script>`;
