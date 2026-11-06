import path from 'node:path';
import { AppError, projectGranted } from '../shared/protocol.js';
import type { ClientToken, Device, Store } from './store.js';
import { configuredProjects } from './projects.js';

export interface KanbanTask {
  id: string;
  revision: number;
  projectId: string;
  title: string;
  description: string;
  status: 'todo' | 'in_progress' | 'review' | 'done';
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
  | { action: 'edit'; title?: string; description?: string; targetPaths?: string[]; requiresReview?: boolean }
  | { action: 'comment'; message: string }
  | { action: 'release' | 'reject' | 'reopen' | 'revise'; reason: string }
  | { action: 'approve' }
  | { action: 'assign'; assignee: string; deviceId: string }
  | { action: 'submit'; proposedCommitMessage: string; aiSummary: string }
  | { action: 'finish'; skipReview: true };

export class Kanban {
  private lastSweep = 0;
  constructor(private store: Store) {}

  private nextId(): string {
    return this.store.transaction(() => {
      const meta = this.store.get<{ counter: number }>('kanbanMeta', 'counter') ?? { counter: 0 };
      meta.counter++;
      this.store.put('kanbanMeta', 'counter', meta);
      return `TASK-${String(meta.counter).padStart(3, '0')}`;
    });
  }

  private migrate(task: KanbanTask): KanbanTask {
    // Old persisted tasks predate optimistic concurrency. Reading never writes or renews a lease.
    task.revision ??= 0;
    return task;
  }

  private getTask(taskId: string, projectId: string): KanbanTask {
    const task = this.store.get<KanbanTask>('tasks', taskId);
    if (!task || task.projectId !== projectId) throw new AppError('task_not_found', `Task ${taskId} not found in project ${projectId}`, 404);
    return this.migrate(task);
  }

  private save(task: KanbanTask): KanbanTask {
    task.revision = (task.revision ?? 0) + 1;
    task.updatedAt = Date.now();
    this.store.put('tasks', task.id, task);
    return task;
  }

  list(projectId: string, status?: string): KanbanTask[] {
    return this.store.all<KanbanTask>('tasks')
      .filter(t => t.projectId === projectId && (!status || t.status === status))
      .map(task => this.migrate(task))
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id === b.id ? 0 : a.id < b.id ? 1 : -1));
  }

  detail(taskId: string, projectId: string): { task: KanbanTask; warnings: string[] } {
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

  private requireAssignment(projectId: string, assignee: string | undefined, deviceId: string | undefined): void {
    if (!assignee || !deviceId || !this.assignmentCandidates(projectId).some(pair => pair.token.id === assignee && pair.device.id === deviceId)) {
      throw new AppError('assignment_forbidden', 'Select a current write-authorized client and ordinary configured device for this project', 403);
    }
  }

  /** Browser administrator metadata changes: no worker impersonation or Runner calls. */
  administer(taskId: string, projectId: string, expectedRevision: number, input: KanbanAdminAction, actor = 'admin'): KanbanTask {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new AppError('invalid_input', 'expectedRevision must be a non-negative integer');
    return this.store.transaction(() => {
      const task = this.getTask(taskId, projectId);
      if (task.revision !== expectedRevision) throw new AppError('conflict', 'Task changed; reload before retrying', 409);
      const allowed: Record<KanbanAdminAction['action'], KanbanTask['status'][]> = {
        edit: ['todo'], comment: ['todo', 'in_progress', 'review', 'done'], release: ['in_progress'],
        approve: ['review'], reject: ['review'], assign: ['todo', 'done'], submit: ['in_progress'],
        reopen: ['done'], revise: ['review'], finish: ['in_progress'],
      };
      if (!allowed[input.action].includes(task.status)) throw new AppError('invalid_state', `Cannot ${input.action} a task in status '${task.status}'`, 409);
      const now = Date.now();
      switch (input.action) {
        case 'edit':
          if (input.title !== undefined) task.title = input.title;
          if (input.description !== undefined) task.description = input.description;
          if (input.targetPaths !== undefined) task.targetPaths = normalizedPaths(input.targetPaths);
          if (input.requiresReview !== undefined) task.requiresReview = input.requiresReview;
          break;
        case 'comment': task.messages.push({ from: actor, text: input.message, at: now }); break;
        case 'approve':
          task.status = 'done'; task.completedAt = now;
          task.messages.push({ from: actor, text: 'Review approved and completed', at: now });
          break;
        case 'assign':
          this.requireAssignment(projectId, input.assignee, input.deviceId);
          this.clearReview(task);
          task.status = 'in_progress'; task.assignee = input.assignee; task.assigneeDevice = input.deviceId;
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
          this.requireAssignment(projectId, task.assignee, task.assigneeDevice);
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
  }

  private clearAssignment(task: KanbanTask): void {
    delete task.assignee; delete task.assigneeDevice; delete task.claimedAt; delete task.leaseExpiresAt;
  }

  create(projectId: string, input: { title: string; description: string; targetPaths?: string[]; requiresReview: boolean }, createdBy: string): KanbanTask {
    const now = Date.now();
    const task: KanbanTask = {
      id: this.nextId(), revision: 0, projectId,
      title: input.title, description: input.description,
      status: 'todo',
      targetPaths: normalizedPaths(input.targetPaths ?? []), actualPaths: [],
      requiresReview: input.requiresReview,
      createdBy, createdAt: now, updatedAt: now,
      messages: [],
    };
    this.store.put('tasks', task.id, task);
    return task;
  }

  claim(taskId: string, projectId: string, assignee: string, deviceId: string): { task: KanbanTask; warnings: string[] } {
    if (!deviceId) throw new AppError('device_required', 'A device is required to claim a task');
    const task = this.getTask(taskId, projectId);
    if (task.status !== 'todo') throw new AppError('invalid_state', `Cannot claim task in status '${task.status}'; expected 'todo'`, 409);
    const now = Date.now();
    task.status = 'in_progress';
    task.assignee = assignee;
    task.assigneeDevice = deviceId;
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
      if (other.id === task.id || other.projectId !== task.projectId) continue;
      if (other.status !== 'in_progress' && other.status !== 'review') continue;
      const otherPaths = normalizedPaths([...(other.targetPaths ?? []), ...(other.actualPaths ?? [])]);
      const overlap = otherPaths.filter(p => taskPaths.some(target => pathsOverlap(p, target)));
      if (overlap.length) {
        warnings.push(`⚠️ ${other.id} (${other.status}) 正在修改 ${overlap.slice(0, 3).join(', ')}${overlap.length > 3 ? ` 等 ${overlap.length} 个文件` : ''}，与本任务的 targetPaths 重叠`);
      }
    }
    return warnings;
  }

  update(taskId: string, projectId: string, input: { actualPaths?: string[]; message?: string }, principal?: string): KanbanTask {
    const task = this.getTask(taskId, projectId);
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

  submitReview(taskId: string, projectId: string, input: { proposedCommitMessage: string; aiSummary: string; fileHashes: Record<string, string> }, principal?: string): KanbanTask {
    const task = this.getTask(taskId, projectId);
    if (task.status !== 'in_progress') throw new AppError('invalid_state', `Cannot submit review for task in status '${task.status}'; expected 'in_progress'`, 409);
    task.status = task.requiresReview ? 'review' : 'done';
    task.proposedCommitMessage = input.proposedCommitMessage;
    task.evidence = { aiSummary: input.aiSummary };
    delete task.reviewStalePaths;
    task.reviewFingerprints = Object.fromEntries(Object.entries(input.fileHashes).map(([file, hash]) => [normalizePath(file), hash]));
    if (task.status === 'done') task.completedAt = Date.now();
    const now = Date.now();
    task.messages.push({ from: '[system]', text: task.requiresReview ? 'Submitted for review' : 'Completed (review not required)', at: now });
    return this.save(task);
  }

  complete(taskId: string, projectId: string, input: { skipReview: boolean }, principal?: string): KanbanTask {
    const task = this.getTask(taskId, projectId);
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
  checkReviewFingerprint(projectId: string, filePaths: string[]): string[] {
    const warnings: string[] = [];
    for (const task of this.store.all<KanbanTask>('tasks')) {
      if (task.projectId !== projectId || task.status !== 'review' || !task.reviewFingerprints) continue;
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
      if (task.projectId !== projectId || task.status !== 'review') continue;
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
