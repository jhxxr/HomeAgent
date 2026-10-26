import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { AppError, projectGranted, type Principal, type Scope } from '../shared/protocol.js';
import { inside, type ProjectConfig, type RunnerConfig } from './config.js';

export class Policy {
  constructor(readonly config: RunnerConfig) {}
  project(id: string, principal: Principal, scope: Scope, deviceId?: string): ProjectConfig {
    const project = this.config.projects.find(item => item.id === id);
    if (!project) throw new AppError('unknown_project', 'Project not allowed');
    if (!principal.scopes.includes(scope) || (principal.projects && !principal.projects.includes(id))) throw new AppError('forbidden', 'Project or tool scope not granted');
    if (principal.projectGrants && (!deviceId || !projectGranted(principal, deviceId, id))) throw new AppError('forbidden', 'Device/project pair is outside the credential grant');
    if (project.readOnly && scope !== 'read') throw new AppError('read_only', 'Project is read-only');
    if (scope === 'git' && !project.allowGitWrite) throw new AppError('git_write_disabled', 'Git writes are disabled in local configuration');
    return project;
  }
  /** Reject symlinks/junctions at every component, including existing parents of a new path. */
  async resolve(project: ProjectConfig, input: string, allowMissing = false): Promise<string> {
    if (input.includes('\0')) throw new AppError('invalid_path', 'Invalid path');
    const target = path.resolve(project.root, input);
    if (!inside(project.root, target)) throw new AppError('path_escape', 'Path is outside the project');
    const parts = path.relative(project.root, target).split(path.sep).filter(Boolean);
    let current = project.root, missing = false;
    for (const part of parts) {
      // Prevent NTFS alternate data streams and trailing-dot/space aliases.
      if (project.deniedNames.some(name => name.toLowerCase() === part.toLowerCase()) || (process.platform === 'win32' && (/[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) throw new AppError('denied_path', 'Path is excluded by local policy');
      current = path.join(current, part);
      if (missing) continue;
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) throw new AppError('symlink', 'Symbolic links and junctions are not allowed');
        if (!stat.isFile() && !stat.isDirectory()) throw new AppError('special_file', 'Special files, sockets and devices are not allowed');
        if (stat.isFile() && stat.nlink > 1) throw new AppError('hardlink', 'Hard-linked files are not allowed');
        if (!inside(project.root, await realpath(current))) throw new AppError('path_escape', 'Resolved path escaped the project');
      } catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') missing = true;
        else throw error;
      }
    }
    if (await realpath(project.root) !== project.root) throw new AppError('root_changed', 'Project root changed; restart the runner');
    return target;
  }
  command(project: ProjectConfig, executable: string) {
    const equal = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (!project.commands.some(command => equal(command, executable))) throw new AppError('command_denied', 'Executable is not in the project command allowlist');
    // Shells, runtimes and build tools remain powerful if explicitly allowed.
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) throw new AppError('command_denied', 'Use an executable, not a .cmd/.bat wrapper; shell execution is never implicit');
  }
}
