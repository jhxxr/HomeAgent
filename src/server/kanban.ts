import path from 'node:path';
import { AppError } from '../shared/protocol.js';
import type { Store } from './store.js';

export interface KanbanTask {
  id: string;
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

  private getTask(taskId: string, projectId: string): KanbanTask {
    const task = this.store.get<KanbanTask>('tasks', taskId);
    if (!task || task.projectId !== projectId) throw new AppError('task_not_found', `Task ${taskId} not found in project ${projectId}`, 404);
    return task;
  }

  private save(task: KanbanTask): KanbanTask {
    task.updatedAt = Date.now();
    this.store.put('tasks', task.id, task);
    return task;
  }

  list(projectId: string, status?: string): KanbanTask[] {
    return this.store.all<KanbanTask>('tasks')
      .filter(t => t.projectId === projectId && (!status || t.status === status))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  create(projectId: string, input: { title: string; description: string; targetPaths?: string[]; requiresReview: boolean }, createdBy: string): KanbanTask {
    const now = Date.now();
    const task: KanbanTask = {
      id: this.nextId(), projectId,
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
    const taskPaths = new Set(normalizedPaths([...task.targetPaths, ...task.actualPaths]));
    if (!taskPaths.size) return warnings;
    for (const other of this.store.all<KanbanTask>('tasks')) {
      if (other.id === task.id || other.projectId !== task.projectId) continue;
      if (other.status !== 'in_progress' && other.status !== 'review') continue;
      const otherPaths = normalizedPaths([...(other.targetPaths ?? []), ...(other.actualPaths ?? [])]);
      const overlap = otherPaths.filter(p => taskPaths.has(p));
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
        if (protectedPaths.has(fp)) {
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
      this.save(task);
    }
  }

  /** Record confirmed mutations only, never reads, failed edits or dry-run previews. */
  recordActualPaths(projectId: string, assignee: string, deviceId: string, paths: string[]): void {
    if (!paths.length) return;
    for (const task of this.activeTasks(projectId, assignee, deviceId)) {
      task.actualPaths = normalizedPaths([...task.actualPaths, ...paths]);
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
        task.assignee = undefined;
        task.assigneeDevice = undefined;
        task.claimedAt = undefined;
        task.leaseExpiresAt = undefined;
        task.messages.push({ from: '[system]', text: '租约过期，任务已释放', at: now });
        this.save(task);
      }
    }
  }
}
