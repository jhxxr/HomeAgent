import path from 'node:path';
import { AppError, normalizePrincipal, projectGranted, type Principal } from '../shared/protocol.js';
import type { ClientToken, Device, Store } from './store.js';
import { activeProjectPolicies, configuredProjects } from './projects.js';
import type { AuthorizationPolicy, GrantPermissions } from '../shared/permissions.js';

export interface KanbanTask {
  id: string;
  revision: number;
  projectId: string | null;
  deviceId: string | null;
  title: string;
  description: string;
  status: 'todo' | 'in_progress' | 'blocked' | 'review' | 'done';
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  riskLevel: 'low' | 'medium' | 'high';
  assigneePrincipalId: string | null;
  needsWrite: boolean;
  blockReason?: string;
  needHuman?: boolean;
  dueAt: number | null;
  calendarEventId: string | null;
  assignee?: string;
  assigneeDevice?: string;
  claimedAt?: number;
  leaseExpiresAt?: number;
  targetPaths: string[];
  actualPaths: string[];
  requiresReview: boolean;
  proposedCommitMessage?: string;
  evidence?: {
    diffStat?: { files: number; additions: number; deletions: number };
    testJobId?: string;
    testPassed?: boolean;
    testDuration?: number;
    aiSummary?: string;
  };
  reviewFingerprints?: Record<string, string>;
  /** Advisory: a confirmed mutation overlapped these paths after submission. Not hash verification. */
  reviewStalePaths?: string[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  commitSha?: string;
  messages: Array<{ from: string; text: string; at: number }>;
}

const LEASE_DURATION = 30 * 60 * 1000; // 30 minutes
const SWEEP_INTERVAL = 30_000; // check every 30 seconds
const normalizePath = (value: string) => path.posix.normalize(value.replaceAll('\\', '/'));
const normalizedPaths = (values: string[]) => [...new Set(values.map(normalizePath))];
// Segment boundaries avoid false matches such as src/a versus src/ab. Ignore unsafe roots.
const safeRelativePath = (value: string) => value !== '.' && value !== '..' && !value.startsWith('../') && !path.posix.isAbsolute(value) && !/^[A-Za-z]:|\0/.test(value);
const pathsOverlap = (a: string, b: string) => a === b || (safeRelativePath(a) && safeRelativePath(b) && (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
export type KanbanAdminAction =
  | { action: 'edit'; title?: string; description?: string; targetPaths?: string[]; requiresReview?: boolean; priority?: KanbanTask['priority']; riskLevel?: KanbanTask['riskLevel']; dueAt?: number | null }
  | { action: 'comment'; message: string }
  | { action: 'release' | 'reject' | 'reopen' | 'revise'; reason: string }
  | { action: 'approve' }
  | { action: 'assign'; assignee: string; deviceId: string | null }
  | { action: 'block'; blockReason: string; needHuman?: boolean }
  | { action: 'submit'; proposedCommitMessage: string; aiSummary: string }
  | { action: 'finish'; skipReview: true };

export interface CreateTaskInput {
  title: string; description: string; targetPaths?: string[]; requiresReview: boolean;
  deviceId?: string | null; priority?: KanbanTask['priority']; riskLevel?: KanbanTask['riskLevel']; dueAt?: number | null;
  needsWrite?: boolean; assigneePrincipalId?: string | null; assignee?: string;
}

/** Idempotent, side-effect-free upgrade of the existing tasks bucket. Never resets history. */
export function normalizeTask(task: KanbanTask): KanbanTask {
  return { ...task, revision: task.revision ?? 0, projectId: task.projectId ?? null,
    deviceId: task.deviceId ?? task.assigneeDevice ?? null, priority: task.priority ?? 'P2',
    riskLevel: task.riskLevel ?? (task.requiresReview ? 'medium' : 'low'),
    assigneePrincipalId: task.assigneePrincipalId ?? task.assignee ?? null,
    needsWrite: task.needsWrite ?? true, dueAt: task.dueAt ?? null, calendarEventId: task.calendarEventId ?? null,
    targetPaths: task.targetPaths ?? [], actualPaths: task.actualPaths ?? [], messages: task.messages ?? [],
  };
}

/** Bounded MCP receipts do not copy unbounded histories into every inbox refresh. */
export function agentTaskView(task: KanbanTask) {
  return { ...task, title: task.title.slice(0, 256), description: task.description.slice(0, 4096),
    targetPaths: task.targetPaths.slice(0, 32).map(value => value.slice(0, 512)), targetPathsTotal: task.targetPaths.length,
    actualPaths: task.actualPaths.slice(0, 64).map(value => value.slice(0, 512)), actualPathsTotal: task.actualPaths.length,
    messages: task.messages.slice(-20).map(message => ({ ...message, from: message.from.slice(0, 200), text: message.text.slice(0, 1024) })), messagesTotal: task.messages.length,
    reviewFingerprints: task.reviewFingerprints ? Object.fromEntries(Object.entries(task.reviewFingerprints).slice(0, 64).map(([file, digest]) => [file.slice(0, 512), digest.slice(0, 64)])) : undefined,
    reviewFingerprintsTotal: Object.keys(task.reviewFingerprints ?? {}).length,
    reviewStalePaths: task.reviewStalePaths?.slice(0, 64).map(value => value.slice(0, 512)),
    ...(task.evidence ? { evidence: { ...task.evidence, aiSummary: task.evidence.aiSummary?.slice(0, 2048) } } : {}),
  };
}

export class Kanban {
  private lastSweep = 0;
  constructor(private store: Store) {}

  private nextId(): string {
    const meta = this.store.get<{ counter: number }>('kanbanMeta', 'counter') ?? { counter: 0 };
    meta.counter++;
    this.store.put('kanbanMeta', 'counter', meta);
    return `TASK-${String(meta.counter).padStart(3, '0')}`;
  }

  private migrate(task: KanbanTask): KanbanTask {
    // Old persisted tasks predate optimistic concurrency. Reading never writes or renews a lease.
    return normalizeTask(task);
  }

  private getTask(taskId: string, projectId: string | null): KanbanTask {
    const task = this.store.get<KanbanTask>('tasks', taskId);
    if (!task || (task.projectId ?? null) !== projectId) throw new AppError('task_not_found', `Task ${taskId} not found in project ${projectId}`, 404);
    return this.migrate(task);
  }

  private save(task: KanbanTask): KanbanTask {
    Object.assign(task, normalizeTask(task));
    task.revision = (task.revision ?? 0) + 1;
    task.updatedAt = Date.now();
    this.store.put('tasks', task.id, task);
    return task;
  }

  all(): KanbanTask[] { return this.store.all<KanbanTask>('tasks').map(normalizeTask); }

  task(taskId: string): KanbanTask {
    const task = this.store.get<KanbanTask>('tasks', taskId);
    if (!task) throw new AppError('task_not_found', 'Task not found', 404);
    return normalizeTask(task);
  }

  private checkRevision(task: KanbanTask, expectedRevision?: number): void {
    if (expectedRevision !== undefined && task.revision !== expectedRevision) throw new AppError('conflict', 'Task changed; reload before retrying', 409);
  }

  resolvePrincipalGrant(id: string): ClientToken | undefined {
    return this.store.all<ClientToken>('tokens').filter(token => token.id === id && !token.assist)
      .sort((a, b) => b.created - a.created).map(token => this.store.tokenByHash(token.tokenHash, ['pat', 'access', 'refresh']))
      .find(token => token && !token.assist && (token.kind === 'pat' || this.store.get<{ revoked: boolean }>('clients', token.clientId)?.revoked === false));
  }

  workspaceFor(principal: Principal, projectId: string, deviceId: string | null, needsWrite = false) {
    const p = normalizePrincipal(principal);
    if (p.bindingMode === 'none') throw new AppError('ERR_NO_WORKSPACE_BINDING', `${p.displayName} has no workspace binding`, 403);
    const candidates = this.store.all<Device>('devices').filter(device => !device.revoked && !device.paused && !device.assistSessionId
      && (!deviceId || device.id === deviceId) && projectGranted(p, device.id, projectId))
      .flatMap(device => activeProjectPolicies(device).filter(project => project.id === projectId).map(project => ({ device, project })));
    if (!candidates.length) throw new AppError('ERR_PROJECT_NOT_GRANTED', 'No authorized device/project pair is available', 403);
    if (candidates.length > 1) throw new AppError('device_required', 'Specify deviceId; more than one authorized device covers this project');
    const { device, project } = candidates[0]!;
    const readOnly = project.readOnly !== false || !p.scopes.includes('write') || p.agentRole === 'observer';
    if (needsWrite && readOnly) throw new AppError('ERR_WRITE_SCOPE_MISSING', 'Target Agent or device policy is read-only for this project', 403);
    return { deviceId: device.id, projectId, root: project.root ?? null, readOnly };
  }

  assertDispatchAllowed(id: string, deviceId: string | null, projectId: string | null, needsWrite: boolean) {
    const grant = this.resolvePrincipalGrant(id);
    if (!grant) throw new AppError('ERR_ASSIGNEE_NOT_FOUND', 'Select a current authorized Agent', 403);
    const p = normalizePrincipal(grant);
    if (p.agentRole === 'observer' || !p.scopes.includes('tasks:self') || p.tools && !p.tools.includes('task_claim') && (!projectId || !p.tools.includes('kanban_claim_task'))) {
      throw new AppError('assignment_forbidden', 'Target Agent cannot claim tasks', 403);
    }
    if (!projectId) {
      if (deviceId) throw new AppError('invalid_input', 'Directory-free tasks must not specify deviceId');
      return { principal: p, workspace: null };
    }
    const workspace = this.workspaceFor(p, projectId, deviceId, needsWrite);
    return { principal: p, workspace };
  }

  dispatchTask(input: CreateTaskInput & { projectId: string | null; deviceId: string | null; assigneePrincipalId: string }, actor: Principal): KanbanTask {
    const principal = normalizePrincipal(actor);
    if (principal.agentRole !== 'supervisor' || !principal.scopes.includes('tasks:dispatch') || principal.assist) throw new AppError('forbidden', 'Supervisor dispatch authorization required', 403);
    const target = this.assertDispatchAllowed(input.assigneePrincipalId, input.deviceId, input.projectId, input.needsWrite ?? true);
    return this.create(input.projectId, { ...input, deviceId: target.workspace?.deviceId ?? null, assignee: target.principal.displayName }, actor.id);
  }

  /** Claims and progress never gain authority from assignment metadata alone. */
  assertTaskAccess(principal: Principal, task: KanbanTask, own = false, deviceId?: string | null, needsWrite = task.needsWrite) {
    const p = normalizePrincipal(principal);
    if (own && task.assigneePrincipalId !== p.id) throw new AppError('task_owner_required', 'Only the assigned Agent can change this task', 403);
    if (!own && task.assigneePrincipalId && task.assigneePrincipalId !== p.id) throw new AppError('task_owner_required', 'Task is assigned to another Agent', 403);
    if (!task.projectId) {
      if (!task.assigneePrincipalId && task.createdBy !== p.id) throw new AppError('task_owner_required', 'Directory-free task is not assigned to you', 403);
      return null;
    }
    return this.workspaceFor(p, task.projectId, task.deviceId ?? deviceId ?? null, needsWrite && p.agentRole !== 'observer');
  }

  inboxForPrincipal(principal: Principal) {
    return this.list(undefined).flatMap(task => {
      if (task.assigneePrincipalId !== principal.id && (task.assigneePrincipalId || task.status !== 'todo')) return [];
      try { return [{ task, workspace: this.assertTaskAccess(principal, task, false, undefined, false) }]; }
      catch { return []; }
    });
  }

  workerAction(principal: Principal, taskId: string, expectedRevision: number, action: 'claim' | 'update' | 'block' | 'submit', input: {
    deviceId?: string; actualPaths?: string[]; message?: string; testJobId?: string;
    blockReason?: string; needHuman?: boolean; proposedCommitMessage?: string; aiSummary?: string; fileHashes?: Record<string, string>;
  }) {
    const p = normalizePrincipal(principal);
    if (p.agentRole === 'observer' || !p.scopes.includes('tasks:self')) throw new AppError('forbidden', 'Agent cannot change tasks', 403);
    return this.store.transaction(() => {
      const task = this.task(taskId);
      this.checkRevision(task, expectedRevision);
      const workspace = this.assertTaskAccess(principal, task, action !== 'claim', input.deviceId, action === 'block' ? false : task.needsWrite);
      if (action === 'claim') return this.claim(task.id, task.projectId, principal.id, workspace?.deviceId ?? null, expectedRevision);
      if (task.status !== 'in_progress') throw new AppError('invalid_state', 'Task must be in progress', 409);
      if (!task.leaseExpiresAt || task.leaseExpiresAt <= Date.now()) throw new AppError('lease_expired', 'Task lease expired; refresh your inbox before continuing', 409);
      if (input.testJobId) {
        const job = this.store.all<{ id: string; owner: string; deviceId: string; projectId: string; state: string; exitCode?: number; started: number; finished?: number }>('jobs')
          .find(job => job.id === input.testJobId && job.owner === principal.id && job.deviceId === task.deviceId && job.projectId === task.projectId);
        if (!job) throw new AppError('invalid_test_job', 'Test job must belong to this Agent and exact workspace', 403);
        task.evidence = { ...task.evidence, testJobId: job.id,
          testPassed: ['exited', 'failed', 'stopped', 'timed_out', 'interrupted'].includes(job.state) ? job.state === 'exited' && job.exitCode === 0 : undefined,
          testDuration: job.finished ? job.finished - job.started : undefined };
        // The subsequent mutation persists the validated evidence in the same transaction.
        this.store.put('tasks', task.id, task);
      }
      switch (action) {
        case 'update': return this.update(task.id, task.projectId, input, principal.id);
        case 'block': return this.administerWorkerBlock(task, input.blockReason!, input.needHuman ?? false, principal.id);
        case 'submit': return this.submitReview(task.id, task.projectId, { proposedCommitMessage: input.proposedCommitMessage ?? '', aiSummary: input.aiSummary ?? '', fileHashes: input.fileHashes ?? {} }, principal.id);
      }
    });
  }

  private administerWorkerBlock(task: KanbanTask, reason: string, needHuman: boolean, actor: string) {
    task.status = 'blocked'; task.blockReason = reason; task.needHuman = needHuman;
    delete task.leaseExpiresAt;
    task.messages.push({ from: actor, text: `Blocked: ${reason}`, at: Date.now() });
    return this.save(task);
  }

  reviewTask(principal: Principal, taskId: string, expectedRevision: number, action: 'approve' | 'reject' | 'revise' | 'reopen', reason: string) {
    const p = normalizePrincipal(principal);
    if (p.agentRole !== 'supervisor' || !p.scopes.includes('tasks:review') || p.assist) throw new AppError('forbidden', 'Supervisor review authorization required', 403);
    const task = this.task(taskId);
    this.checkRevision(task, expectedRevision);
    if (action === 'approve' && (task.riskLevel === 'high' || task.reviewStalePaths?.length)) {
      throw new AppError('admin_review_required', 'High-risk or stale-evidence approval requires browser administrator confirmation', 403);
    }
    if (action !== 'approve' && !reason.trim()) throw new AppError('invalid_input', 'A review reason is required');
    return this.administer(task.id, task.projectId, expectedRevision, action === 'approve' ? { action } : { action, reason }, principal.id);
  }

  elevateAndReopen(taskId: string, projectId: string | null, revision: number, scopes: Array<'write' | 'execute' | 'git'>, actor: string) {
    let family = '';
    const task = this.store.transaction(() => {
      const task = this.getTask(taskId, projectId); this.checkRevision(task, revision);
      if (task.status !== 'blocked' || !task.projectId || !task.assigneePrincipalId || !task.deviceId) throw new AppError('invalid_state', 'A blocked task with an exact workspace and assignee is required', 409);
      const token = this.resolvePrincipalGrant(task.assigneePrincipalId);
      if (!token || token.bindingMode === 'none' || token.agentRole === 'observer') throw new AppError('assignment_forbidden', 'Assignee is no longer available', 403);
      this.workspaceFor(token, task.projectId, task.deviceId, false);
      const device = this.store.get<Device>('devices', task.deviceId)!;
      const project = device.permissions && (device.permissions.expiresAt && device.permissions.expiresAt <= Date.now() ? device.permissions.fallbackProjects : device.permissions.projects).find(project => project.id === task.projectId);
      if (scopes.includes('write') && (!project || project.readOnly)) throw new AppError('device_policy_required', 'Enable device project writes in device permissions first', 409);
      if (scopes.includes('execute') && (!project || project.commandMode !== 'unrestricted' && !project.commands.length && !Object.keys(project.commandAliases).length)) throw new AppError('device_policy_required', 'Configure permitted commands on the device first', 409);
      if (scopes.includes('git') && (!project || !project.allowGitWrite)) throw new AppError('device_policy_required', 'Enable Git writes on the device first', 409);
      family = token.family;
      const policy = this.store.get<AuthorizationPolicy>('authorizations', family) ?? { revision: 0 };
      const devices = token.devices ?? this.store.all<Device>('devices').filter(device => !device.revoked && !device.assistSessionId).map(device => device.id);
      const permissions: GrantPermissions = { scopes: [...new Set([...token.scopes, ...scopes])], devices,
        projectGrants: Object.fromEntries(devices.map(id => { const device = this.store.get<Device>('devices', id); return [id, device ? configuredProjects(device).filter(project => projectGranted(token, id, project.id)).map(project => project.id) : []]; })),
        tools: token.tools ?? null, machineAccess: token.machineAccess ?? false, unrestrictedExecution: token.unrestrictedExecution ?? false,
        agentRole: token.agentRole, bindingMode: token.bindingMode, displayName: token.displayName,
      };
      policy.temporary = { permissions, expiresAt: Date.now() + 30 * 60000 }; policy.revision++;
      this.store.put('authorizations', family, policy);
      for (const credential of this.store.all<ClientToken>('tokens')) if (credential.family === family && credential.scopeLimit) { delete credential.scopeLimit; this.store.put('tokens', credential.tokenHash, credential); }
      task.status = 'todo'; delete task.blockReason; delete task.needHuman; delete task.leaseExpiresAt;
      task.messages.push({ from: actor, text: `Temporary scopes (${scopes.join(', ')}) granted for 30 minutes; task reopened for assigned Agent`, at: Date.now() });
      return this.save(task);
    });
    this.store.emit('permissionsChanged', family);
    return task;
  }

  list(projectId: string | null | undefined, status?: string): KanbanTask[] {
    return this.all()
      .filter(t => (projectId === undefined || t.projectId === projectId) && (!status || t.status === status))
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id === b.id ? 0 : a.id < b.id ? 1 : -1));
  }

  detail(taskId: string, projectId: string | null): { task: KanbanTask; warnings: string[] } {
    const task = this.getTask(taskId, projectId);
    return { task, warnings: this.checkPathOverlap(task) };
  }

  /** Current ordinary device/client pairs eligible for administrator metadata assignment. */
  assignmentCandidates(projectId: string): Array<{ token: ClientToken; device: Device }> {
    const devices = this.store.all<Device>('devices').filter(device => !device.revoked && !device.paused && !device.assistSessionId
      && configuredProjects(device).some(project => project.id === projectId));
    const pairs: Array<{ token: ClientToken; device: Device }> = [];
    for (const stored of this.store.all<ClientToken>('tokens')) {
      if (stored.kind !== 'pat' && stored.kind !== 'access') continue;
      const token = this.store.tokenByHash(stored.tokenHash);
      if (!token || !token.scopes.includes('write') || token.assist || (token.tools && !token.tools.includes('kanban_claim_task'))) continue;
      if (token.kind === 'access') {
        const client = this.store.get<{ revoked: boolean }>('clients', token.clientId);
        if (!client || client.revoked) continue;
      }
      for (const device of devices) if (projectGranted(token, device.id, projectId)) pairs.push({ token, device });
    }
    return pairs;
  }

  private requireAssignment(projectId: string | null, assignee: string | undefined, deviceId: string | null | undefined, needsWrite = true): void {
    if (!assignee || projectId && !deviceId) throw new AppError('assignment_forbidden', 'Select an authorized Agent and exact workspace', 403);
    try { this.assertDispatchAllowed(assignee, deviceId ?? null, projectId, needsWrite); }
    catch (error) { throw new AppError('assignment_forbidden', error instanceof Error ? error.message : 'Assignment forbidden', 403); }
  }

  /** Browser administrator metadata changes: no worker impersonation or Runner calls. */
  administer(taskId: string, projectId: string | null, expectedRevision: number, input: KanbanAdminAction, actor = 'admin'): KanbanTask {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new AppError('invalid_input', 'expectedRevision must be a non-negative integer');
    return this.store.transaction(() => {
      const task = this.getTask(taskId, projectId);
      if (task.revision !== expectedRevision) throw new AppError('conflict', 'Task changed; reload before retrying', 409);
      const allowed: Record<KanbanAdminAction['action'], KanbanTask['status'][]> = {
        edit: ['todo'], comment: ['todo', 'in_progress', 'blocked', 'review', 'done'], release: ['in_progress', 'blocked'], block: ['in_progress'],
        approve: ['review'], reject: ['review'], assign: ['todo', 'done'], submit: ['in_progress'],
        reopen: ['done', 'blocked'], revise: ['review', 'blocked'], finish: ['in_progress'],
      };
      if (!allowed[input.action].includes(task.status)) throw new AppError('invalid_state', `Cannot ${input.action} a task in status '${task.status}'`, 409);
      const now = Date.now();
      switch (input.action) {
        case 'edit':
          if (input.title !== undefined) task.title = input.title;
          if (input.description !== undefined) task.description = input.description;
          if (input.targetPaths !== undefined) task.targetPaths = normalizedPaths(input.targetPaths);
          if (input.requiresReview !== undefined) task.requiresReview = input.requiresReview;
          if (input.priority !== undefined) task.priority = input.priority;
          if (input.riskLevel !== undefined) task.riskLevel = input.riskLevel;
          if (input.dueAt !== undefined) task.dueAt = input.dueAt;
          break;
        case 'block':
          task.status = 'blocked'; task.blockReason = input.blockReason; task.needHuman = input.needHuman ?? false;
          delete task.leaseExpiresAt;
          task.messages.push({ from: actor, text: `Blocked: ${input.blockReason}`, at: now });
          break;
        case 'comment': task.messages.push({ from: actor, text: input.message, at: now }); break;
        case 'approve':
          task.status = 'done'; task.completedAt = now;
          task.messages.push({ from: actor, text: 'Review approved and completed', at: now });
          break;
        case 'assign':
          if (task.deviceId && task.deviceId !== input.deviceId) throw new AppError('assignment_forbidden', 'Task is bound to another device', 403);
          this.requireAssignment(projectId, input.assignee, input.deviceId, task.needsWrite);
          this.clearReview(task);
          task.status = 'in_progress'; task.assignee = input.assignee; task.assigneePrincipalId = input.assignee; task.assigneeDevice = input.deviceId ?? undefined;
          task.deviceId = input.deviceId;
          task.claimedAt = now; task.leaseExpiresAt = now + LEASE_DURATION;
          task.messages.push({ from: actor, text: `Assigned by administrator to ${input.assignee} on device ${input.deviceId}`, at: now });
          break;
        case 'submit':
          this.clearReview(task);
          task.status = 'review'; task.proposedCommitMessage = input.proposedCommitMessage;
          task.evidence = { aiSummary: input.aiSummary }; task.reviewFingerprints = {};
          task.messages.push({ from: actor, text: 'Submitted for review by administrator; file hashes not independently verified', at: now });
          break;
        case 'revise':
          this.requireAssignment(projectId, task.assigneePrincipalId ?? task.assignee, task.deviceId ?? task.assigneeDevice, task.needsWrite);
          this.clearReview(task);
          task.status = 'in_progress'; task.leaseExpiresAt = now + LEASE_DURATION;
          task.messages.push({ from: actor, text: `Returned to assigned worker by administrator: ${input.reason}`, at: now });
          break;
        case 'finish':
          if (input.skipReview !== true) throw new AppError('invalid_input', 'Explicit skipReview confirmation is required');
          task.status = 'done'; task.completedAt = now;
          task.messages.push({ from: actor, text: 'Completed (review skipped by administrator)', at: now });
          break;
        case 'release':
        case 'reject':
        case 'reopen':
          task.status = 'todo';
          this.clearAssignment(task);
          this.clearReview(task);
          task.messages.push({ from: actor, text: `${input.action === 'reject' ? 'Review rejected' : input.action === 'reopen' ? 'Task reopened' : 'Task released'}: ${input.reason}`, at: now });
          break;
      }
      return this.save(task);
    });
  }

  private clearReview(task: KanbanTask): void {
    // Review evidence must not survive a new work cycle. Confirmed paths remain history.
    delete task.evidence; delete task.reviewFingerprints; delete task.reviewStalePaths;
    delete task.proposedCommitMessage; delete task.completedAt; delete task.commitSha;
    delete task.blockReason; delete task.needHuman;
  }

  private clearAssignment(task: KanbanTask): void {
    delete task.assignee; delete task.assigneeDevice; delete task.claimedAt; delete task.leaseExpiresAt;
    task.assigneePrincipalId = null;
  }

  create(projectId: string | null, input: CreateTaskInput, createdBy: string): KanbanTask {
    return this.store.transaction(() => {
      const now = Date.now();
      const task: KanbanTask = {
        id: this.nextId(), revision: 0, projectId,
        deviceId: input.deviceId ?? null, priority: input.priority ?? 'P2', riskLevel: input.riskLevel ?? (input.requiresReview ? 'medium' : 'low'),
        dueAt: input.dueAt ?? null, calendarEventId: null, assigneePrincipalId: input.assigneePrincipalId ?? null,
        ...(input.assignee ? { assignee: input.assignee } : {}), needsWrite: input.needsWrite ?? true,
        title: input.title, description: input.description,
        status: 'todo',
        targetPaths: normalizedPaths(input.targetPaths ?? []), actualPaths: [],
        requiresReview: input.requiresReview,
        createdBy, createdAt: now, updatedAt: now,
        messages: [],
      };
      this.store.put('tasks', task.id, task);
      return task;
    });
  }

  claim(taskId: string, projectId: string | null, assignee: string, deviceId: string | null, expectedRevision?: number): { task: KanbanTask; warnings: string[] } {
    if (projectId && !deviceId) throw new AppError('device_required', 'A device is required to claim a task');
    const task = this.getTask(taskId, projectId);
    this.checkRevision(task, expectedRevision);
    if (task.assigneePrincipalId && task.assigneePrincipalId !== assignee) throw new AppError('task_owner_required', 'Task is assigned to another Agent', 403);
    if (task.deviceId && task.deviceId !== deviceId) throw new AppError('assignment_forbidden', 'Task is bound to another device', 403);
    if (task.status !== 'todo') throw new AppError('invalid_state', `Cannot claim task in status '${task.status}'; expected 'todo'`, 409);
    const now = Date.now();
    task.status = 'in_progress';
    task.assignee = assignee;
    task.assigneePrincipalId = assignee; task.deviceId = deviceId;
    task.assigneeDevice = deviceId ?? undefined;
    task.claimedAt = now;
    task.leaseExpiresAt = now + LEASE_DURATION;
    task.messages.push({ from: '[system]', text: `Claimed by ${assignee} on device ${deviceId}`, at: now });
    this.save(task);
    const warnings = this.checkPathOverlap(task);
    return { task, warnings };
  }

  private checkPathOverlap(task: KanbanTask): string[] {
    const warnings: string[] = [];
    const taskPaths = normalizedPaths([...task.targetPaths, ...task.actualPaths]);
    if (!taskPaths.length) return warnings;
    for (const other of this.store.all<KanbanTask>('tasks')) {
      if (other.id === task.id || other.projectId !== task.projectId || task.deviceId && other.deviceId && task.deviceId !== other.deviceId) continue;
      if (other.status !== 'in_progress' && other.status !== 'review') continue;
      const otherPaths = normalizedPaths([...(other.targetPaths ?? []), ...(other.actualPaths ?? [])]);
      const overlap = otherPaths.filter(p => taskPaths.some(target => pathsOverlap(p, target)));
      if (overlap.length) {
        warnings.push(`⚠️ ${other.id} (${other.status}) 正在修改 ${overlap.slice(0, 3).join(', ')}${overlap.length > 3 ? ` 等 ${overlap.length} 个文件` : ''}，与本任务的 targetPaths 重叠`);
      }
    }
    return warnings;
  }

  update(taskId: string, projectId: string | null, input: { actualPaths?: string[]; message?: string }, principal?: string): KanbanTask {
    const task = this.getTask(taskId, projectId);
    if (principal && task.assigneePrincipalId !== principal) throw new AppError('task_owner_required', 'Only the assigned Agent can update this task', 403);
    if (task.status !== 'in_progress') throw new AppError('invalid_state', `Cannot update task in status '${task.status}'; expected 'in_progress'`, 409);
    if (input.actualPaths) {
      task.actualPaths = normalizedPaths([...task.actualPaths, ...input.actualPaths]);
    }
    if (input.message && principal) {
      task.messages.push({ from: principal, text: input.message, at: Date.now() });
    }
    task.leaseExpiresAt = Date.now() + LEASE_DURATION;
    return this.save(task);
  }

  submitReview(taskId: string, projectId: string | null, input: { proposedCommitMessage: string; aiSummary: string; fileHashes: Record<string, string> }, principal?: string): KanbanTask {
    const task = this.getTask(taskId, projectId);
    if (principal && task.assigneePrincipalId !== principal) throw new AppError('task_owner_required', 'Only the assigned Agent can submit this task', 403);
    if (task.status !== 'in_progress') throw new AppError('invalid_state', `Cannot submit review for task in status '${task.status}'; expected 'in_progress'`, 409);
    task.status = task.requiresReview || task.riskLevel !== 'low' ? 'review' : 'done';
    task.proposedCommitMessage = input.proposedCommitMessage;
    task.evidence = { ...task.evidence, aiSummary: input.aiSummary };
    delete task.reviewStalePaths;
    task.reviewFingerprints = Object.fromEntries(Object.entries(input.fileHashes).map(([file, hash]) => [normalizePath(file), hash]));
    if (task.status === 'done') task.completedAt = Date.now();
    const now = Date.now();
    task.messages.push({ from: '[system]', text: task.requiresReview ? 'Submitted for review' : 'Completed (review not required)', at: now });
    return this.save(task);
  }

  complete(taskId: string, projectId: string | null, input: { skipReview: boolean }, principal?: string): KanbanTask {
    const task = this.getTask(taskId, projectId);
    if (principal && (task.riskLevel !== 'low' || task.requiresReview || task.reviewStalePaths?.length)) throw new AppError('admin_review_required', 'Task requires authorized review; use task_submit', 403);
    if (principal && task.assigneePrincipalId !== principal) throw new AppError('task_owner_required', 'Only the assigned Agent can complete this task', 403);
    if (input.skipReview) {
      if (task.status !== 'in_progress' && task.status !== 'review') throw new AppError('invalid_state', `Cannot complete task in status '${task.status}'`, 409);
    } else {
      if (task.status !== 'review') throw new AppError('invalid_state', `Cannot complete task in status '${task.status}'; expected 'review' (or use skipReview)`, 409);
    }
    task.status = 'done';
    task.completedAt = Date.now();
    task.messages.push({ from: principal ?? '[system]', text: input.skipReview ? 'Completed (review skipped)' : 'Review approved and completed', at: Date.now() });
    return this.save(task);
  }

  /** Check for fingerprint conflicts: is a file under review protection? */
  checkReviewFingerprint(projectId: string, filePaths: string[], deviceId?: string): string[] {
    const warnings: string[] = [];
    for (const task of this.store.all<KanbanTask>('tasks')) {
      if (task.projectId !== projectId || deviceId && (task.deviceId ?? task.assigneeDevice) && (task.deviceId ?? task.assigneeDevice) !== deviceId || task.status !== 'review' || !task.reviewFingerprints) continue;
      const protectedPaths = new Set(Object.keys(task.reviewFingerprints).map(normalizePath));
      for (const fp of normalizedPaths(filePaths)) {
        if ([...protectedPaths].some(protectedPath => pathsOverlap(protectedPath, fp))) {
          warnings.push(`该文件 ${fp} 正处于 ${task.id} 的待审核保护中，修改可能导致审核证据过期`);
        }
      }
    }
    return warnings;
  }

  private activeTasks(projectId: string, assignee: string, deviceId: string): KanbanTask[] {
    const now = Date.now();
    return this.store.all<KanbanTask>('tasks').filter(task => task.projectId === projectId
      && task.status === 'in_progress' && task.assignee === assignee && task.assigneeDevice === deviceId
      && task.leaseExpiresAt !== undefined && task.leaseExpiresAt > now);
  }

  /** Activity must not revive an already expired lease between sweeps. */
  renewLease(projectId: string, assignee: string, deviceId: string): void {
    const now = Date.now();
    for (const task of this.activeTasks(projectId, assignee, deviceId)) {
      task.leaseExpiresAt = now + LEASE_DURATION;
      // Heartbeats are deliberately invisible to form revisions and ordering.
      this.store.put('tasks', task.id, task);
    }
  }

  /** Record confirmed mutations only, never reads, failed edits or dry-run previews. */
  recordActualPaths(projectId: string, assignee: string, deviceId: string, paths: string[]): void {
    if (!paths.length) return;
    const changedPaths = normalizedPaths(paths);
    for (const task of this.activeTasks(projectId, assignee, deviceId)) {
      task.actualPaths = normalizedPaths([...task.actualPaths, ...changedPaths]);
      this.save(task);
    }
    // A principal without a claimed task can still invalidate somebody else's review evidence.
    // Prefix overlap also covers confirmed directory moves without probing Runner files.
    for (const task of this.store.all<KanbanTask>('tasks')) {
      if (task.projectId !== projectId || (task.deviceId ?? task.assigneeDevice) && (task.deviceId ?? task.assigneeDevice) !== deviceId || task.status !== 'review') continue;
      const protectedPaths = normalizedPaths([...task.targetPaths, ...task.actualPaths, ...Object.keys(task.reviewFingerprints ?? {})]);
      const stale = protectedPaths.filter(protectedPath => changedPaths.some(changed => pathsOverlap(protectedPath, changed)));
      if (!stale.length) continue;
      task.reviewStalePaths = normalizedPaths([...(task.reviewStalePaths ?? []), ...stale]);
      this.save(task);
    }
  }

  sweepLeases(): void {
    const now = Date.now();
    if (now - this.lastSweep < SWEEP_INTERVAL) return;
    this.lastSweep = now;
    for (const task of this.store.all<KanbanTask>('tasks')) {
      if (task.status === 'in_progress' && task.leaseExpiresAt && task.leaseExpiresAt < now) {
        task.status = 'todo';
        this.clearAssignment(task);
        task.messages.push({ from: '[system]', text: '租约过期，任务已释放', at: now });
        this.save(task);
      }
    }
  }
}
