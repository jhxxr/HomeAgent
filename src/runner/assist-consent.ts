import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { assistAnyApprovalSchema, assistAnyDescriptorSchema, assistProjects, approvedProjects, approvalEqual, type AssistAnyApproval, type AssistAnyDescriptor } from '../shared/assist.js';
import type { RemotePermissions } from '../shared/permissions.js';
import { AppError, type Principal, type Scope } from '../shared/protocol.js';
import { toolScope, type ToolName } from '../shared/tools.js';
import { inside, type ProjectConfig, type RunnerConfig } from './config.js';

export interface ConsentClock { wall(): number; monotonic(): number }
const clock: ConsentClock = { wall: Date.now, monotonic: () => performance.now() };
export class AssistConsent {
  private approval: AssistAnyApproval;
  private descriptor?: AssistAnyDescriptor;
  private started: number;
  private durationMs: number;
  private ended = false;
  private active = false;
  private timer?: NodeJS.Timeout;
  private onEnd?: () => void;
  constructor(input: AssistAnyApproval, private time: ConsentClock = clock) {
    this.approval = structuredClone(assistAnyApprovalSchema.parse(input));
    this.started = time.monotonic();
    this.durationMs = Math.min(this.approval.durationMinutes * 60000, this.approval.expiresAt - time.wall());
    if (this.approval.expiresAt <= time.wall()) throw new AppError('assist_expired', 'Local consent has expired');
  }
  static async approve(config: RunnerConfig, input: AssistAnyApproval) {
    return new AssistConsent(await this.validate(config, input));
  }
  static async validate(config: RunnerConfig, input: AssistAnyApproval): Promise<AssistAnyApproval> {
    const approval = assistAnyApprovalSchema.parse(input), projects = approvedProjects(approval);
    const privatePaths: string[] = [];
    for (const value of [config.stateDir, ...(config.protectedPaths ?? [])]) {
      privatePaths.push(path.resolve(value));
      try { privatePaths.push(await realpath(value)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    for (const project of projects) {
      if (!path.isAbsolute(project.root) || /[\p{Cc}\p{Cf}]/u.test(project.root)) throw new AppError('invalid_root', 'Choose an absolute local project directory');
      project.root = await realpath(project.root);
      if (!(await stat(project.root)).isDirectory()) throw new AppError('invalid_root', 'Choose an existing project directory');
      if (privatePaths.some(privatePath => inside(project.root, privatePath) || inside(privatePath, project.root))) throw new AppError('private_state', 'The project must exclude Runner configuration and private state');
    }
    for (let index = 0; index < projects.length; index++) {
      const project = projects[index]!;
      if (projects.slice(0, index).some(other => inside(other.root, project.root) || inside(project.root, other.root))) throw new AppError('overlapping_roots', 'Shared project directories must not overlap');
      for (let command = 0; command < project.commands.length; command++) {
        const program = project.commands[command]!;
        if (!path.isAbsolute(program) || /[\p{Cc}\p{Cf}]/u.test(program) || /\.(cmd|bat)$/i.test(program)) throw new AppError('command_denied', 'Choose an absolute executable; no shell wrappers');
        const canonical = await realpath(program);
        if (!(await stat(canonical)).isFile() || /\.(cmd|bat)$/i.test(canonical)) throw new AppError('command_denied', 'Program must be a regular executable file');
        if (projects.some(shared => inside(shared.root, canonical))) throw new AppError('command_denied', 'Allowed programs must be installed outside the shared projects');
        project.commands[command] = canonical;
      }
    }
    if ('projects' in approval) approval.projects = projects;
    else { approval.root = projects[0]!.root; approval.commands = projects[0]!.commands; }
    return assistAnyApprovalSchema.parse(approval);
  }
  snapshot() { return structuredClone(this.approval); }
  bind(input: AssistAnyDescriptor) {
    this.assertAlive();
    const descriptor = assistAnyDescriptorSchema.parse(input);
    if (this.descriptor || !approvalEqual(this.approval, descriptor.approval)) throw new AppError('assist_mismatch', 'Server changed the locally approved request');
    this.descriptor = structuredClone(descriptor);
  }
  identity(): AssistAnyDescriptor {
    if (!this.descriptor) throw new AppError('assist_not_ready', 'Local consent has not been bound to a session');
    return structuredClone(this.descriptor);
  }
  remaining() { return Math.max(0, Math.min(this.approval.expiresAt - this.time.wall(), this.durationMs - (this.time.monotonic() - this.started))); }
  assertAlive() {
    if (this.ended || this.remaining() <= 0) { this.revoke(); throw new AppError('assist_ended', 'Remote Assist has ended; new local approval is required'); }
  }
  activate() { this.assertAlive(); this.active = true; }
  arm(onEnd: () => void) {
    this.onEnd = onEnd;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.revoke(), Math.max(1, this.remaining())).unref();
  }
  revoke() {
    if (this.ended) return;
    this.ended = true; this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.onEnd?.();
  }
  close() { this.onEnd = undefined; this.revoke(); }
  assertCall(principal: Principal, name?: ToolName, projectId?: string, scope?: Scope) {
    this.assertAlive();
    const session = this.identity();
    if (!this.active || principal.assist?.sessionId !== session.sessionId || principal.assist.localConsentRevision !== session.localConsentRevision || principal.authorizationId !== session.authorizationId || principal.authorizationRevision !== session.authorizationRevision || principal.id !== session.operatorId) throw new AppError('assist_forbidden', 'Call does not match the locally approved session and authorization');
    const project = projectId ? approvedProjects(this.approval).find(project => project.id === projectId) : undefined;
    if (projectId && !project) throw new AppError('assist_forbidden', 'Project is outside local consent');
    const required = scope ?? (name ? toolScope(name) : undefined);
    if (required && (!project || !project.scopes.includes(required as 'read' | 'write' | 'execute'))) throw new AppError('assist_forbidden', 'Operation is outside local consent');
    if (principal.credentialExpiresAt && principal.credentialExpiresAt <= this.time.wall()) throw new AppError('assist_expired', 'Client credential has expired');
  }
  validatePermissions(input: RemotePermissions): RemotePermissions {
    this.assertAlive();
    const ceilings = assistProjects(this.approval);
    if (input.fallbackProjects.length || input.projects.length !== ceilings.length || new Set(input.projects.map(project => project.id)).size !== ceilings.length || !input.expiresAt || input.expiresAt > this.approval.expiresAt) throw new AppError('assist_escalation', 'Server policy exceeds local consent');
    for (const project of input.projects) this.validateProject(project);
    return structuredClone(input);
  }
  private validateProject(selected: ProjectConfig) {
    const ceiling = assistProjects(this.approval).find(project => project.id === selected.id);
    if (!ceiling || selected.name !== ceiling.name || selected.root !== ceiling.root || selected.filesystemScope !== 'project' || selected.commandMode !== 'allowlist' || selected.allowGitWrite || selected.allowGitNetwork || selected.allowGitPush || selected.gitCommonDir || Object.keys(selected.commandAliases).length || Object.keys(selected.environmentProfiles).length || selected.commands.some(command => !ceiling.commands.includes(command)) || ceiling.deniedNames.some(name => !selected.deniedNames.includes(name)) || (ceiling.readOnly && !selected.readOnly)) throw new AppError('assist_escalation', 'Server policy exceeds local consent');
  }
  assertProject(project: ProjectConfig) {
    this.assertAlive();
    this.validateProject(project);
  }
  deadline(principal: Principal) { return Math.floor(Math.min(this.time.wall() + this.remaining(), principal.credentialExpiresAt ?? Infinity, principal.authorizationExpiresAt ?? Infinity)); }
  auditHash(args: unknown) { return createHash('sha256').update(JSON.stringify(args)).digest('hex'); }
}
