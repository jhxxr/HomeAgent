import { assistFeature, type AssistCleanup } from '../shared/assist.js';
import { AssistConsent } from './assist-consent.js';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { AppError, MAX_FRAME, RUNNER_PROTOCOL, VERSION, relayMessageSchema, result, type JobView } from '../shared/protocol.js';
import type { RemotePermissions } from '../shared/permissions.js';
import { randomUUID } from 'node:crypto';
import { toolSchemas } from '../shared/tools.js';
import type { RunnerConfig } from './config.js';
import type { Credential } from './credentials.js';
import { Tools } from './tools.js';
import { RunnerLock } from './lock.js';
import { RunnerPermissions } from './permissions.js';
import type { RunnerState } from './tui.js';

export class Agent {
  readonly tools: Tools;
  private socket?: WebSocket;
  private stopped = false;
  private retry?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private attempt = 0;
  private active = new Map<string, { controller: AbortController; done: Promise<unknown>; authorizationId?: string }>();
  private permissions: RunnerPermissions;
  private permissionsReady = false;
  private requestedRevision = -1;
  private lock: RunnerLock;
  private instanceId = randomUUID();
  private ready = false;
  private syncing = false;
  private snapshot?: Promise<void>;
  private dirty = new Map<string, JobView>();
  private flushTimer?: NodeJS.Timeout;
  private closing?: Promise<void>;
  private assistStopping?: Promise<void>;
  private auditBytes = 0;
  constructor(readonly config: RunnerConfig, readonly credential: Credential, private log: (message: string) => void = console.log, private onState: (state: RunnerState, detail?: string) => void = () => {}, readonly consent?: AssistConsent) {
    if (credential.server !== config.server) throw new AppError('server_changed', 'Credential server mismatch');
    config.projects = [];
    this.lock = new RunnerLock(config.stateDir);
    try { this.tools = new Tools(config, credential.deviceId, consent); }
    catch (error) { this.lock.close(); throw error; }
    this.permissions = new RunnerPermissions(config, this.tools, async () => {
      this.permissionsReady = false;
      for (const call of this.active.values()) call.controller.abort();
      await Promise.all([...this.active.values()].map(call => call.done.catch(() => {})));
    }, (revision, error) => this.reportPermissions(revision, error), consent);
    consent?.arm(() => { queueMicrotask(() => { void this.stopAssist('local_expiry_or_stop').catch(error => this.log(`协助任务清理失败：${String(error)}`)); }); });
    this.tools.processes.on('change', job => {
      this.dirty.set(job.id, job);
      if (!this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = undefined; this.flushJobs(); }, 250).unref();
    });
  }
  start() { this.connect(); }
  async stopAssist(reason = 'local_stop') {
    if (!this.consent) return this.close();
    if (this.assistStopping) return this.assistStopping;
    this.permissionsReady = false; this.stopped = true;
    this.consent.revoke();
    for (const call of this.active.values()) call.controller.abort();
    this.assistStopping = (async () => {
      let cleanup: AssistCleanup = 'confirmed';
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.all([this.tools.processes.stopAllAndWait(), this.tools.git.stopAllAndWait(), Promise.all([...this.active.values()].map(call => call.done.catch(() => {})))]),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Task cleanup has not been confirmed')), 12000); }),
        ]);
      } catch (error) { cleanup = 'failed'; this.log(`新操作已封锁，停止尚未确认：${String(error)}`); }
      finally { if (timer) clearTimeout(timer); }
      const session = this.consent!.identity();
      if (this.socket?.readyState === WebSocket.OPEN) {
        let reportTimer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            this.sendSnapshot(this.socket, true),
            new Promise<never>((_resolve, reject) => { reportTimer = setTimeout(() => reject(new Error('Final task report timed out')), 2000); }),
          ]);
        } catch { this.socket?.terminate(); }
        finally { if (reportTimer) clearTimeout(reportTimer); }
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'assist_ended', sessionId: session.sessionId, localConsentRevision: session.localConsentRevision, cleanup, reason }));
      }
      this.onState('stopped', cleanup === 'confirmed' ? '协助已结束，托管任务已停止' : '访问已封锁，停止未确认');
      if (cleanup === 'confirmed') this.socket?.close(1000, 'Assistance ended');
      else this.assistStopping = undefined;
    })();
    return this.assistStopping;
  }
  private projectViews() {
    return this.config.projects.map(({ id, name, readOnly, commands, allowGitWrite, allowGitNetwork, allowGitPush, commandMode, filesystemScope, commandAliases, environmentProfiles }) => ({ id, name, readOnly, commands, allowGitWrite, allowGitNetwork, allowGitPush, commandMode, filesystemScope, commandAliasNames: Object.keys(commandAliases), environmentNames: Object.keys(environmentProfiles) }));
  }
  private reportPermissions(revision: number, error?: string) {
    if (revision !== this.requestedRevision) return;
    this.permissionsReady = !error;
    if (error) this.log(`设备权限应用失败：${error}`);
    else this.log(this.config.projects.length
      ? `当前生效项目目录（权限版本 ${revision}）：\n${this.config.projects.map(project => `  ${project.id}: ${project.root}`).join('\n')}`
      : '尚未配置项目目录，请在网页端为此设备添加项目。');
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'permissions_applied', revision, projects: this.projectViews(), ...(error ? { error: error.slice(0, 512) } : {}) }));
  }
  private applyPermissions(policy: RemotePermissions) {
    this.requestedRevision = policy.revision; this.permissionsReady = false;
    void this.permissions.apply(policy).then(() => this.reportPermissions(policy.revision)).catch(error => this.reportPermissions(policy.revision, error instanceof Error ? error.message : 'Permission update failed'));
  }
  private connect() {
    if (this.stopped) return;
    this.onState('connecting');
    const url = new URL('/runner', this.config.server); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${this.credential.token}`, 'X-Device-ID': this.credential.deviceId }, maxPayload: MAX_FRAME, perMessageDeflate: false, handshakeTimeout: 15000, followRedirects: false });
    this.socket = socket;
    const resetWatchdog = () => {
      if (this.watchdog) clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => socket.terminate(), 45000).unref();
    };
    socket.on('open', () => {
      resetWatchdog();
      socket.send(JSON.stringify({
        type: 'hello', protocol: RUNNER_PROTOCOL, name: this.config.name, platform: `${process.platform}/${process.arch}`, version: VERSION,
        instanceId: this.instanceId, capabilities: Object.keys(toolSchemas),
        projects: [],
        ...(this.consent ? { assist: { feature: assistFeature(this.consent.snapshot()), sessionId: this.consent.identity().sessionId } } : {}),
      }));
    });
    socket.on('ping', resetWatchdog);
    socket.on('message', raw => {
      try {
        const message = relayMessageSchema.parse(JSON.parse(raw.toString()));
        if (message.type === 'assist_welcome' || message.type === 'assist_multi_welcome') {
          if (!this.consent || this.ready || message.feature !== assistFeature(this.consent.snapshot()) || JSON.stringify(message.descriptor) !== JSON.stringify(this.consent.identity())) throw new Error('Local assistance identity mismatch');
          this.ready = true;
          this.consent.assertAlive();
          void this.permissions.apply(this.consent.validatePermissions(message.permissions)).then(() => {
            this.consent!.assertAlive();
            this.requestedRevision = message.permissions.revision;
            this.reportPermissions(message.permissions.revision);
            this.permissionsReady = false;
            socket.send(JSON.stringify({ type: 'assist_approved', sessionId: message.descriptor.sessionId, localConsentRevision: message.descriptor.localConsentRevision }));
            void this.sendSnapshot(socket).catch(() => socket.terminate());
          }).catch(() => { void this.stopAssist('invalid_server_policy'); });
          return;
        }
        if (message.type === 'assist_active') {
          const identity = this.consent?.identity();
          if (!identity || message.sessionId !== identity.sessionId || message.localConsentRevision !== identity.localConsentRevision) throw new Error('Unexpected assistance activation');
          this.consent!.activate(); this.permissionsReady = true;
          this.onState('connected', `协助至 ${new Date(identity.approval.expiresAt).toLocaleTimeString()}`); return;
        }
        if (message.type === 'assist_stop') {
          if (!this.consent || message.sessionId !== this.consent.identity().sessionId) throw new Error('Unexpected assistance stop');
          // An echoed stop must not race the next local cleanup retry.
          if (!this.stopped) void this.stopAssist(message.reason); return;
        }
        if (this.consent && message.type === 'authorization_changed') {
          if (message.authorizationId === this.consent.identity().authorizationId) void this.stopAssist('authorization_changed');
          return;
        }
        if (this.consent && ['welcome', 'permissions'].includes(message.type)) { void this.stopAssist('unexpected_authority_change'); return; }
        if (message.type === 'welcome') {
          if (this.ready || message.deviceId !== this.credential.deviceId) throw new Error('Unexpected device welcome');
          this.ready = true; this.attempt = 0;
          void this.tools.processes.syncAuthorizations(message.authorizations).then(() => {
            if (!this.ready || this.socket !== socket) return;
            this.applyPermissions(message.permissions);
          }).catch(() => socket.terminate());
          this.log(`Runner connected · ${message.deviceId} · v${VERSION}`);
          this.onState('connected', message.deviceId.slice(0, 8));
          void this.sendSnapshot(socket).catch(() => socket.terminate()); return;
        }
        if (!this.ready) throw new Error('Welcome required');
        if (message.type === 'cancel') { this.active.get(message.id)?.controller.abort(); return; }
        if (message.type === 'permissions') { this.applyPermissions(message.permissions); return; }
        if (message.type === 'authorization_changed') {
          for (const call of this.active.values()) if (call.authorizationId === message.authorizationId) call.controller.abort();
          void this.tools.processes.stopAuthorization(message.authorizationId).catch(error => this.log(`Authorization job stop failed: ${String(error)}`));
          return;
        }
        if (!this.permissionsReady) {
          socket.send(JSON.stringify({ type: 'result', id: message.id, result: result({ error: 'permissions_updating', message: 'Device permissions are being applied; retry after the Dashboard shows applied.' }, true) })); return;
        }
        if (this.active.has(message.id) || this.active.size >= 32) { socket.close(4400, 'Duplicate call or concurrency limit'); return; }
        if (message.principal.devices && !message.principal.devices.includes(this.credential.deviceId)) { socket.close(4400, 'Device grant mismatch'); return; }
        const callStarted = Date.now();
        try { this.consent?.assertCall(message.principal); }
        catch { socket.send(JSON.stringify({ type: 'result', id: message.id, result: result({ error: 'assist_forbidden', message: 'Call is outside local consent' }, true) })); return; }
        const controller = new AbortController();
        const deadline = Math.min(message.principal.authorizationExpiresAt ?? Infinity, this.tools.policy.expiresAt ?? Infinity, this.consent?.deadline(message.principal) ?? Infinity);
        const leaseTimer = Number.isFinite(deadline) ? setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now())).unref() : undefined;
        if (deadline <= Date.now()) controller.abort();
        const done = this.tools.invoke(message.tool, message.args, message.principal, controller.signal).then(async output => {
          if (this.consent) {
            const entry = JSON.stringify({ at: callStarted, sessionId: this.consent.identity().sessionId, tool: message.tool, argsHash: this.consent.auditHash(message.args), status: output.isError ? 'error' : 'ok', durationMs: Date.now() - callStarted }) + '\n';
            if (this.auditBytes + Buffer.byteLength(entry) <= 1024 * 1024) { this.auditBytes += Buffer.byteLength(entry); await appendFile(path.join(this.config.stateDir, 'assist-audit.jsonl'), entry, { mode: 0o600 }); }
            this.log(`${message.tool} · ${output.isError ? '拒绝/失败' : '完成'}`);
            try { this.consent.assertCall(message.principal); } catch { output = result({ error: 'assist_ended', message: 'Session ended; result content withheld' }, true); }
          }
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'result', id: message.id, result: output }));
        }).finally(() => { if (leaseTimer) clearTimeout(leaseTimer); this.active.delete(message.id); });
        this.active.set(message.id, { controller, done, authorizationId: message.principal.authorizationId });
      } catch { socket.close(4400, 'Invalid relay frame'); }
    });
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      if (response.statusCode === 401) {
        this.stopped = true; this.log('设备凭据被拒绝。请检查撤销状态；需要时显式重新配对。');
        void this.close().catch(error => this.log(`Runner shutdown failed: ${String(error)}`));
      }
      if (response.statusCode === 403) void this.tools.processes.stopAll().catch(error => this.log(`Process stop failed: ${String(error)}`));
      socket.terminate();
    });
    socket.on('error', () => { /* Reconnect on close; never log request headers or credentials. */ });
    socket.on('close', code => {
      if (this.consent) { this.stopped = true; void this.stopAssist('disconnected'); }
      if (this.watchdog) clearTimeout(this.watchdog);
      this.ready = false; this.syncing = false;
      this.permissionsReady = false;
      void this.tools.processes.stopTemporaryAuthorizations().catch(error => this.log(`Temporary authorization shutdown failed: ${String(error)}`));
      void this.permissions.reset().catch(error => this.log(`Permission reset failed: ${String(error)}`));
      for (const call of this.active.values()) call.controller.abort();
      if (code === 4401 || code === 4000) {
        this.stopped = true;
        this.log(code === 4401 ? '设备已撤销，请重新配对。' : '设备连接已被另一 Runner 替换，停止本实例以避免重复执行。');
        void this.close().catch(error => this.log(`Runner shutdown failed: ${String(error)}`));
      }
      if (code === 4403) void this.tools.processes.stopAll().catch(error => this.log(`Process stop failed: ${String(error)}`));
      if (!this.stopped) {
        const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5)) + Math.random() * 500;
        this.log(`Runner disconnected; reconnecting in ${Math.round(delay / 1000)}s`);
        this.onState('reconnecting', `${Math.ceil(delay / 1000)}s`);
        this.retry = setTimeout(() => this.connect(), delay);
      } else this.onState('stopped');
    });
  }
  private async sendSnapshot(socket: WebSocket, final = false) {
    const sending = (this.snapshot ?? Promise.resolve()).catch(() => {}).then(() => this.writeSnapshot(socket, final));
    this.snapshot = sending;
    try { await sending; } finally { if (this.snapshot === sending) this.snapshot = undefined; }
  }
  private async writeSnapshot(socket: WebSocket, final: boolean) {
    this.syncing = true;
    const jobs = this.tools.processes.snapshot(), snapshotId = randomUUID();
    this.dirty.clear();
    try {
      for (let offset = 0, page = 0; offset < jobs.length || page === 0; offset += 100, page++) {
        if (this.socket !== socket || !this.ready || socket.readyState !== WebSocket.OPEN || (this.stopped && !final)) return;
        await new Promise<void>((resolve, reject) => socket.send(JSON.stringify({ type: 'jobs_snapshot', snapshotId, page, done: offset + 100 >= jobs.length, jobs: jobs.slice(offset, offset + 100) }), error => error ? reject(error) : resolve()));
      }
    } finally {
      if (this.socket === socket) { this.syncing = false; this.flushJobs(); }
    }
  }
  private flushJobs() {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.ready || this.syncing || this.stopped) return;
    for (const [id, job] of this.dirty) {
      if (socket.bufferedAmount > MAX_FRAME * 2) { socket.terminate(); return; }
      socket.send(JSON.stringify({ type: 'job_update', job }), error => { if (error) socket.terminate(); });
      this.dirty.delete(id);
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (this.consent) await this.stopAssist('local_exit');
      this.stopped = true; this.ready = false;
      this.consent?.close();
      this.onState('stopped');
      if (this.retry) clearTimeout(this.retry);
      if (this.watchdog) clearTimeout(this.watchdog);
      if (this.flushTimer) clearTimeout(this.flushTimer);
      for (const call of this.active.values()) call.controller.abort();
      this.socket?.close(1000, 'Runner shutdown');
      this.socket?.terminate();
      await Promise.all([...this.active.values()].map(call => call.done));
      await this.permissions.reset();
      this.permissions.close();
      await this.tools.close();
      this.lock.close();
    })();
    return this.closing;
  }
}
