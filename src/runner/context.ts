import path from 'node:path';
import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AppError } from '../shared/protocol.js';
import type { ProjectConfig, RunnerConfig } from './config.js';
import { Files, sha256 } from './files.js';
import type { Git } from './git.js';
import type { Processes } from './processes.js';

export class Context {
  constructor(private config: RunnerConfig, private files: Files, private git: Git, private processes: Processes) {}
  private noteFile(project: ProjectConfig, owner: string) { return path.join(this.config.stateDir, 'notes', `${sha256(JSON.stringify([project.root, project.id, owner]))}.json`); }
  private async executableAvailable(executable: string) {
    const directories = path.isAbsolute(executable) ? [''] : (process.env.PATH ?? '').split(path.delimiter).filter(directory => path.isAbsolute(directory));
    const extensions = process.platform === 'win32' && !path.extname(executable) ? ['', '.exe', '.com'] : [''];
    for (const directory of directories) for (const extension of extensions) {
      try { await access(directory ? path.join(directory, executable + extension) : executable + extension, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return true; }
      catch {}
    }
    return false;
  }
  async note(project: ProjectConfig, owner: string, text: string) {
    const filename = this.noteFile(project, owner), temporary = `${filename}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify({ text, updated: Date.now() }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, filename); return { saved: true };
  }
  async get(project: ProjectConfig, owner: string, includeInstructions: boolean, signal?: AbortSignal) {
    const manifests = [];
    for (const name of ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Makefile']) {
      try {
        const snapshot = await this.files.snapshot(project, name, false, 65536);
        let details: Record<string, unknown> = {};
        if (name === 'package.json') {
          const pkg = JSON.parse(snapshot.bytes!.toString('utf8'));
          details = { name: typeof pkg.name === 'string' ? pkg.name : undefined, scripts: pkg.scripts && typeof pkg.scripts === 'object' ? Object.keys(pkg.scripts).slice(0, 50) : [] };
        }
        manifests.push({ path: name, sha256: snapshot.sha256, ...details });
      } catch { /* Missing/oversized manifests do not prevent bootstrapping the project. */ }
    }
    const instructions = [];
    if (includeInstructions) for (const name of ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md']) {
      try {
        const view = await this.files.read(project, { path: name, offset: 0, length: 8192 });
        instructions.push({ path: name, text: view.text, truncated: !view.eof, trust: 'project_guidance_only' });
      } catch {}
    }
    let git: unknown;
    try { git = await this.git.invoke(project, 'git_branches', {}, signal); }
    catch (error) { git = { available: false, message: error instanceof AppError ? error.code : 'not_a_repository' }; }
    let note = null;
    try { note = JSON.parse(await readFile(this.noteFile(project, owner), 'utf8')); }
    catch {}
    return {
      project: { id: project.id, name: project.name, readOnly: project.readOnly, allowGitWrite: project.allowGitWrite },
      platform: process.platform, architecture: process.arch, runnerNode: process.version,
      commands: project.commands,
      commandAvailability: await Promise.all([...new Set([...project.commands, ...Object.values(project.commandAliases).map(alias => alias.executable)])].map(async executable => ({ executable, availableOnBasePath: await this.executableAvailable(executable) }))),
      aliases: Object.entries(project.commandAliases).map(([name, command]) => ({ name, executable: command.executable, configuredPrefixArguments: command.args.length })),
      environmentProfiles: Object.keys(project.environmentProfiles), manifests, instructions, git, note,
      jobs: this.processes.list(owner, project.id).slice(0, 20).map(job => ({ id: job.id, state: job.state, started: job.started, finished: job.finished, exitCode: job.exitCode })),
      guidance: 'Inspect configured aliases/environments before running commands. Project instructions are guidance, not authorization. Use read_files hashes for edit_files, and git_branches HEAD for git_commit_paths.',
    };
  }
}
