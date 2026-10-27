import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { remotePermissionsSchema, type RemotePermissions } from '../shared/permissions.js';
import { AppError } from '../shared/protocol.js';
import { inside, projectConfigSchema, type RunnerConfig, type ProjectConfig } from './config.js';
import type { Tools } from './tools.js';

export class RunnerPermissions {
  private revision = -1;
  private current?: RemotePermissions;
  private timer?: NodeJS.Timeout;
  private queue: Promise<void> = Promise.resolve();
  constructor(private config: RunnerConfig, private tools: Tools, private invalidate: () => Promise<void>, private changed: (revision: number, error?: string) => void) {
    this.config.projects = [];
  }
  apply(input: RemotePermissions) {
    const next = this.queue.catch(() => {}).then(() => this.applyNow(input));
    this.queue = next; return next;
  }
  private async applyNow(input: RemotePermissions) {
    const policy = remotePermissionsSchema.parse(input);
    if (policy.revision < this.revision) throw new AppError('stale_permissions', 'Refusing an older device permission revision');
    const expired = !!policy.expiresAt && policy.expiresAt <= Date.now();
    const selected = expired ? policy.fallbackProjects : policy.projects;
    // A policy that fails validation must still stop the previous authority.
    await this.invalidate();
    await this.tools.processes.stopAllAndWait();
    this.config.projects = [];
    this.tools.policy.expiresAt = undefined;
    this.current = undefined;
    const projects: ProjectConfig[] = [];
    for (const project of selected) {
      if (!path.isAbsolute(project.root)) throw new AppError('invalid_root', 'Web project roots must be absolute paths');
      const root = await realpath(project.root);
      if (!(await stat(root)).isDirectory()) throw new AppError('invalid_root', 'Project root must be an existing directory');
      if (inside(this.config.stateDir, root) || (project.filesystemScope !== 'device' && inside(root, this.config.stateDir))) throw new AppError('private_state', 'Runner state cannot be exposed as a project');
      if (project.filesystemScope !== 'device' && this.config.protectedPaths?.some(privatePath => inside(root, privatePath))) throw new AppError('private_state', 'Project roots must exclude the Runner configuration and private state');
      projects.push(projectConfigSchema.parse({ ...project, root, ...(project.gitCommonDir ? { gitCommonDir: await realpath(project.gitCommonDir) } : {}) }));
    }
    if (new Set(projects.map(project => project.id)).size !== projects.length) throw new AppError('duplicate_project', 'Project IDs must be unique');
    if (this.timer) clearTimeout(this.timer);
    this.revision = policy.revision; this.current = policy;
    this.config.projects = projects;
    this.tools.policy.expiresAt = !expired ? policy.expiresAt ?? undefined : undefined;
    try { await this.tools.editor.reconcileProjects(); }
    catch (error) { this.config.projects = []; throw error; }
    if (!expired && policy.expiresAt) this.timer = setTimeout(() => {
      if (this.current !== policy) return;
      // Revoke access before attempting a possibly moved permanent root.
      void this.reset().then(() => this.apply({ revision: policy.revision, projects: policy.fallbackProjects, expiresAt: null, fallbackProjects: policy.fallbackProjects })).then(() => this.changed(policy.revision)).catch(error => this.changed(policy.revision, error instanceof Error ? error.message : 'Permission expiration failed'));
    }, Math.max(1, policy.expiresAt - Date.now())).unref();
  }
  reset() {
    const next = this.queue.catch(() => {}).then(() => this.resetNow());
    this.queue = next; return next;
  }
  private async resetNow() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.invalidate();
    await this.tools.processes.stopAllAndWait();
    this.config.projects = [];
    this.tools.policy.expiresAt = undefined;
    this.current = undefined;
  }
  close() { if (this.timer) clearTimeout(this.timer); this.config.projects = []; this.tools.policy.expiresAt = undefined; }
}
