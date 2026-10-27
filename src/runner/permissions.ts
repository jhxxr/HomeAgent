import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { permissionProjectSchema, remotePermissionsSchema, type RemotePermissions } from '../shared/permissions.js';
import { AppError } from '../shared/protocol.js';
import { inside, projectConfigSchema, type RunnerConfig, type ProjectConfig } from './config.js';
import type { Tools } from './tools.js';

export class RunnerPermissions {
  readonly baseline: ProjectConfig[];
  private revision = -1;
  private current?: RemotePermissions;
  private timer?: NodeJS.Timeout;
  private queue: Promise<void> = Promise.resolve();
  constructor(private config: RunnerConfig, private tools: Tools, private invalidate: () => Promise<void>, private changed: (revision: number, error?: string) => void) {
    this.baseline = structuredClone(config.projects);
  }
  snapshot() {
    return this.baseline.map(project => permissionProjectSchema.parse({
      id: project.id, name: project.name, root: project.root, readOnly: project.readOnly,
      commands: project.commands, commandMode: project.commandMode, filesystemScope: project.filesystemScope,
      allowGitWrite: project.allowGitWrite, allowGitNetwork: project.allowGitNetwork, allowGitPush: project.allowGitPush, deniedNames: project.deniedNames, gitCommonDir: project.gitCommonDir,
    }));
  }
  apply(input: RemotePermissions) {
    const next = this.queue.catch(() => {}).then(() => this.applyNow(input));
    this.queue = next; return next;
  }
  private async applyNow(input: RemotePermissions) {
    const policy = remotePermissionsSchema.parse(input);
    if (!this.config.allowRemotePermissions) throw new AppError('local_permissions_only', 'Runner owner disabled Web permission management');
    if (policy.revision < this.revision) throw new AppError('stale_permissions', 'Refusing an older device permission revision');
    const expired = !!policy.expiresAt && policy.expiresAt <= Date.now();
    const selected = expired ? policy.fallbackProjects ?? null : policy.projects;
    const active = selected !== null;
    if (!active && !policy.expiresAt && !this.current) { this.revision = policy.revision; return; }
    // A policy that fails validation must still stop the previous authority.
    await this.invalidate();
    await this.tools.processes.stopAllAndWait();
    const projects: ProjectConfig[] = [];
    if (active) for (const project of selected!) {
      if (!path.isAbsolute(project.root)) throw new AppError('invalid_root', 'Web project roots must be absolute paths');
      const root = await realpath(project.root);
      if (!(await stat(root)).isDirectory()) throw new AppError('invalid_root', 'Project root must be an existing directory');
      if (inside(this.config.stateDir, root) || (project.filesystemScope !== 'device' && inside(root, this.config.stateDir))) throw new AppError('private_state', 'Runner state cannot be exposed as a project');
      if (project.filesystemScope !== 'device' && this.config.protectedPaths?.some(privatePath => inside(root, privatePath))) throw new AppError('private_state', 'Project roots must exclude the Runner configuration and private state');
      const local = this.baseline.find(base => base.id === project.id && base.root === root);
      projects.push(projectConfigSchema.parse({ ...local, ...project, root, ...(project.gitCommonDir ? { gitCommonDir: await realpath(project.gitCommonDir) } : {}) }));
    }
    if (new Set(projects.map(project => project.id)).size !== projects.length) throw new AppError('duplicate_project', 'Project IDs must be unique');
    if (this.timer) clearTimeout(this.timer);
    this.revision = policy.revision; this.current = active || (!expired && !!policy.expiresAt) ? policy : undefined;
    this.config.projects = active ? projects : structuredClone(this.baseline);
    this.tools.policy.expiresAt = active && !expired ? policy.expiresAt ?? undefined : undefined;
    if (!expired && policy.expiresAt) this.timer = setTimeout(() => {
      if (this.current !== policy) return;
      // Stop and return to the local baseline before attempting a possibly
      // moved/deleted permanent root; invalid fallback paths cannot retain elevation.
      void this.reset().then(() => this.apply({ revision: policy.revision, projects: policy.fallbackProjects ?? null, expiresAt: null })).then(() => this.changed(policy.revision)).catch(error => this.changed(policy.revision, error instanceof Error ? error.message : 'Permission expiration failed'));
    }, Math.max(1, policy.expiresAt - Date.now())).unref();
  }
  reset() {
    const next = this.queue.catch(() => {}).then(() => this.resetNow());
    this.queue = next; return next;
  }
  private async resetNow() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.current) return;
    await this.invalidate();
    await this.tools.processes.stopAllAndWait();
    this.config.projects = structuredClone(this.baseline);
    this.tools.policy.expiresAt = undefined;
    this.current = undefined;
  }
  close() { if (this.timer) clearTimeout(this.timer); this.config.projects = structuredClone(this.baseline); this.tools.policy.expiresAt = undefined; }
}
