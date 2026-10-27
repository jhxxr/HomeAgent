import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { agentMessageSchema, AppError, RUNNER_PROTOCOL, principalSchema, projectGranted, terminalJob, type Principal, type ToolResult } from '../shared/protocol.js';
import { hash, Store, type Device, type ClientToken } from './store.js';
import { toolSchemas, toolScope, type ToolName } from '../shared/tools.js';
import { JobMirror, type JobRecord } from './jobs.js';

interface Connection {
  socket: WebSocket; ready: boolean; alive: boolean; inFlight: number; instanceId: string; reconciled: boolean;
  snapshot?: { id: string; nextPage: number; seen: Set<string> };
  permissionsReady: boolean;
}
interface Pending { deviceId: string; connection: Connection; family?: string; cancel: (error?: AppError) => void; resolve: (v: ToolResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
interface InvocationContext { family?: string; tokenHash?: string; expires?: number; actorId?: string }
export class Hub {
  private connections = new Map<string, Connection>();
  private pending = new Map<string, Pending>();
  private timer: NodeJS.Timeout;
  private permissionTimer: NodeJS.Timeout;
  readonly jobMirror: JobMirror;
  private revoke = (family: string) => {
    for (const pending of [...this.pending.values()]) if (pending.family === family) pending.cancel(new AppError('credential_revoked', 'Credential revoked while the call was pending', 403));
    for (const connection of this.connections.values()) if (connection.ready && connection.socket.readyState === 1) {
      connection.socket.send(JSON.stringify({ type: 'authorization_changed', authorizationId: family }));
    }
  };
  constructor(private store: Store) {
    this.jobMirror = new JobMirror(store);
    store.on('revoked', this.revoke);
    store.on('permissionsChanged', this.revoke);
    this.permissionTimer = setInterval(() => store.expireAuthorizations(), 1000).unref();
    this.timer = setInterval(() => {
      for (const [id, connection] of this.connections) {
        if (!connection.alive) { connection.socket.terminate(); continue; }
        connection.alive = false; connection.socket.ping();
        const device = this.store.get<Device>('devices', id);
        if (device) { device.lastSeen = Date.now(); this.store.put('devices', id, device); }
      }
    }, 15000).unref();
  }
  attach(device: Device, socket: WebSocket) {
    // Replacing a connection must reject the old connection's outstanding calls.
    this.connections.get(device.id)?.socket.close(4000, 'Replaced');
    const connection: Connection = { socket, ready: false, alive: true, inFlight: 0, instanceId: randomUUID(), reconciled: false, permissionsReady: true };
    this.connections.set(device.id, connection);
    const helloTimer = setTimeout(() => { if (!connection.ready) socket.close(4400, 'Hello required'); }, 10000).unref();
    socket.on('pong', () => { connection.alive = true; });
    socket.on('error', () => { socket.terminate(); });
    socket.on('message', data => {
      try {
        if (this.connections.get(device.id) !== connection) return;
        const message = agentMessageSchema.parse(JSON.parse(data.toString()));
        if (message.type === 'hello') {
          if (connection.ready) throw new Error('Duplicate hello');
          clearTimeout(helloTimer);
          const current = this.store.get<Device>('devices', device.id);
          if (!current || current.revoked || current.paused) { socket.close(4403, 'Access disabled'); return; }
          current.platform = message.platform;
          current.projects = []; current.lastSeen = Date.now();
          current.runnerVersion = message.version;
          connection.instanceId = message.instanceId;
          current.runnerInstanceId = connection.instanceId; current.capabilities = message.capabilities;
          current.runnerProtocol = RUNNER_PROTOCOL;
          connection.permissionsReady = false;
          current.permissionAppliedRevision = undefined; current.permissionError = undefined;
          this.store.put('devices', device.id, current);
          connection.ready = true;
          const families = [...new Set(this.store.all<ClientToken>('tokens').filter(token => !token.revoked && token.expires > Date.now()).map(token => token.family))].slice(0, 10000);
          const authorizations = families.map(id => ({ id, revision: this.store.get<{ revision: number }>('authorizations', id)?.revision ?? 0 }));
          socket.send(JSON.stringify({ type: 'welcome', protocol: RUNNER_PROTOCOL, deviceId: device.id, authorizations, permissions: current.permissions ?? { revision: 0, projects: [], expiresAt: null, fallbackProjects: [] } }));
        } else if (message.type === 'permissions_applied') {
          if (!connection.ready) throw new Error('Hello required');
          const current = this.store.get<Device>('devices', device.id);
          if (!current || message.revision !== (current.permissions?.revision ?? 0)) return;
          connection.permissionsReady = !message.error;
          current.projects = message.projects; current.permissionAppliedRevision = message.error ? undefined : message.revision; current.permissionError = message.error;
          this.store.put('devices', device.id, current);
        } else if (message.type === 'result') {
          if (!connection.ready) throw new Error('Hello required');
          if (this.connections.get(device.id) !== connection) return;
          const pending = this.pending.get(message.id);
          if (!pending || pending.connection !== connection) return;
          clearTimeout(pending.timer); this.pending.delete(message.id);
          connection.inFlight--; pending.resolve(message.result);
        } else {
          if (!connection.ready || this.connections.get(device.id) !== connection) throw new Error('Current registered connection required');
          if (message.type === 'job_update') this.jobMirror.accept(device.id, connection.instanceId, message.job);
          else {
            if (message.page === 0) connection.snapshot = { id: message.snapshotId, nextPage: 0, seen: new Set() };
            const snapshot = connection.snapshot;
            if (!snapshot || snapshot.id !== message.snapshotId || snapshot.nextPage !== message.page) throw new Error('Invalid job snapshot sequence');
            this.store.transaction(() => {
              for (const job of message.jobs) {
                if (snapshot.seen.has(job.id) || snapshot.seen.size >= 10000) throw new Error('Duplicate or oversized job snapshot');
                snapshot.seen.add(job.id); this.jobMirror.accept(device.id, connection.instanceId, job);
              }
            });
            snapshot.nextPage++;
            if (message.done) { this.jobMirror.reconcile(device.id, snapshot.seen); connection.snapshot = undefined; connection.reconciled = true; }
          }
        }
      } catch { socket.close(4400, 'Invalid protocol frame'); }
    });
    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (this.connections.get(device.id) === connection) this.connections.delete(device.id);
      for (const [id, pending] of this.pending) {
        if (pending.connection === connection) {
          clearTimeout(pending.timer); this.pending.delete(id);
          pending.reject(new AppError('device_disconnected', 'Device disconnected; operation outcome may be unknown. Inspect before retrying.', 503));
        }
      }
    });
  }
  devices(principal?: Principal) {
    return this.store.all<Device>('devices').filter(device => !device.revoked && (!principal?.devices || principal.devices.includes(device.id))).map(({ tokenHash, ...device }) => ({
      ...device,
      ...(principal ? { permissions: undefined, permanentProjects: undefined } : {}),
      projects: (device.projects as { id: string }[]).filter(project => !principal || projectGranted(principal, device.id, project.id)),
      online: !!this.connections.get(device.id)?.ready,
    }));
  }
  private observedJob(job: JobRecord) {
      const connection = this.connections.get(job.deviceId);
      const device = this.store.get<Device>('devices', job.deviceId);
      const available = !!(device && !device.revoked && !device.paused && connection?.ready && connection.reconciled && connection.instanceId === job.runnerInstanceId && !job.missingSince);
      return { ...job, available, observation: available ? 'live' : terminalJob(job) ? 'retained' : job.missingSince ? 'missing' : 'unconfirmed' };
  }
  jobs(principal?: Principal, options?: { deviceId?: string; projectId?: string; limit?: number }) {
    return this.jobMirror.list(principal, options).map(job => this.observedJob(job));
  }
  async manageJob(deviceId: string, id: string, action: 'output' | 'tail' | 'stop', cursor?: number, length = 65536) {
    const record = this.jobMirror.get(deviceId, id), job = record && this.observedJob(record);
    if (!job || !job.available) throw new AppError('job_unavailable', 'Job is unavailable on its exact registered Runner instance', 503);
    const principal: Principal = { id: job.owner, scopes: [action === 'stop' ? 'execute' : 'read'], devices: [deviceId], projects: [job.projectId] };
    return this.invoke(principal, action === 'output' ? 'read_process_output' : action === 'tail' ? 'tail_process_output' : 'stop_process', { deviceId, projectId: job.projectId, processId: id, ...(action !== 'stop' ? { ...(cursor === undefined ? {} : { cursor }), length } : {}) }, undefined, { actorId: 'admin' });
  }
  disconnect(id: string, revoked = false) { this.connections.get(id)?.socket.close(revoked ? 4401 : 4403, 'Device access disabled'); }
  sendPermissions(id: string) {
    const device = this.store.get<Device>('devices', id), connection = this.connections.get(id);
    if (!device?.permissions || !connection?.ready) return;
    connection.permissionsReady = false;
    for (const pending of [...this.pending.values()]) if (pending.deviceId === id) pending.cancel(new AppError('permissions_changed', 'Device permissions changed while a call was pending', 403));
    connection.socket.send(JSON.stringify({ type: 'permissions', permissions: device.permissions }));
  }
  async invoke(principal: Principal, tool: string, input: Record<string, unknown>, signal?: AbortSignal, context?: InvocationContext): Promise<ToolResult> {
    const started = Date.now();
    let deviceId = typeof input.deviceId === 'string' ? input.deviceId : '';
    const projectId = typeof input.projectId === 'string' ? input.projectId : '';
    let status = 'error';
    try {
      if (context?.tokenHash) {
        const credential = this.store.tokenByHash(context.tokenHash);
        if (!credential || credential.revoked || credential.expires <= Date.now() || credential.id !== principal.id || credential.family !== context.family) throw new AppError('credential_revoked', 'Credential is no longer valid at dispatch', 403);
        principal = principalSchema.parse(credential);
        context = { ...context, expires: Math.min(credential.expires, credential.authorizationExpiresAt ?? Infinity) };
      }
      if (!Object.hasOwn(toolSchemas, tool)) throw new AppError('unknown_tool', 'Unknown tool');
      const name = tool as ToolName;
      if (principal.tools && !principal.tools.includes(name)) throw new AppError('tool_forbidden', 'Tool is disabled for this client authorization', 403);
      const args = toolSchemas[name].parse(input);
      if (!principal.scopes.includes(toolScope(name))) throw new AppError('forbidden', 'Token lacks the required tool scope', 403);
      if (principal.projects && !principal.projects.includes(projectId)) throw new AppError('forbidden', 'Project is outside token grants', 403);
      const devices = this.devices(principal).filter(device => device.online && !device.paused);
      if (!deviceId) {
        if (devices.length !== 1) throw new AppError('device_required', 'Specify deviceId; no unambiguous online device');
        deviceId = devices[0]!.id;
      }
      if (principal.devices && !principal.devices.includes(deviceId)) throw new AppError('forbidden', 'Device is outside token grants', 403);
      if (!projectGranted(principal, deviceId, projectId)) throw new AppError('forbidden', 'Device/project pair is outside token grants', 403);
      const device = devices.find(item => item.id === deviceId);
      if (!device) throw new AppError('device_unavailable', 'Device is offline, paused or revoked', 503);
      if (!device.projects.some(project => project.id === projectId)) throw new AppError('unknown_project', 'Project is not registered');
      const connection = this.connections.get(deviceId)!;
      if (!connection.permissionsReady) throw new AppError('permissions_updating', 'Runner has not acknowledged the current device permissions', 503);
      if (connection.inFlight >= 32 || this.pending.size >= 256) throw new AppError('busy', 'Too many concurrent calls', 429);
      const registered = this.store.get<Device>('devices', deviceId)!;
      if (registered.capabilities && !registered.capabilities.includes(name)) throw new AppError('capability_unavailable', 'Runner does not advertise this tool');
      const output = await this.dispatch(connection, deviceId, principal, name, args, signal, context);
      status = output.isError ? 'tool_error' : 'ok'; return output;
    } finally {
      this.store.audit({ principal: context?.actorId ?? principal.id, deviceId, projectId, tool, argsHash: hash(JSON.stringify(input)), status, durationMs: Date.now() - started });
    }
  }
  private dispatch(connection: Connection, deviceId: string, principal: Principal, tool: string, args: Record<string, unknown>, signal?: AbortSignal, context?: InvocationContext): Promise<ToolResult> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const cancel = (error?: AppError) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id); connection.inFlight--; clearTimeout(pending.timer);
        if (connection.socket.readyState === 1) connection.socket.send(JSON.stringify({ type: 'cancel', id }));
        signal?.removeEventListener('abort', abort);
        reject(error instanceof AppError ? error : new AppError('cancelled', 'Call cancelled or timed out; inspect state before retrying', 408));
      };
      const abort = () => cancel();
      if (signal?.aborted) { reject(new AppError('cancelled', 'Call cancelled', 408)); return; }
      const finish = <T>(callback: (value: T) => void) => (value: T) => { signal?.removeEventListener('abort', abort); callback(value); };
      const deadline = Math.min(45000, context?.expires ? context.expires - Date.now() : 45000);
      if (deadline <= 0) { reject(new AppError('credential_expired', 'Credential expired before dispatch', 401)); return; }
      const timer = setTimeout(cancel, deadline).unref();
      this.pending.set(id, { deviceId, connection, family: context?.family, cancel, timer, resolve: finish(resolve), reject: finish(reject) });
      connection.inFlight++;
      signal?.addEventListener('abort', abort, { once: true });
      connection.socket.send(JSON.stringify({ type: 'call', id, tool, args, principal: principalSchema.parse(principal) }), error => { if (error) cancel(); });
    });
  }
  close() {
    clearInterval(this.timer);
    clearInterval(this.permissionTimer);
    this.store.off('revoked', this.revoke);
    this.store.off('permissionsChanged', this.revoke);
    for (const connection of this.connections.values()) connection.socket.close(1001, 'Server shutdown');
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Server shutdown')); }
    this.pending.clear();
  }
}
