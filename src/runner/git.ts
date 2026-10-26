import { spawn } from 'node:child_process';
import { lstat, readFile, realpath, open, copyFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AppError } from '../shared/protocol.js';
import type { ProjectConfig } from './config.js';
import { Policy } from './policy.js';
import { toolEnvironment } from './processes.js';
import { Files } from './files.js';
import { inside } from './config.js';

export class Git {
  constructor(private policy: Policy) {}
  private async run(project: ProjectConfig, args: string[], signal?: AbortSignal, extra: string[] = [], environment: NodeJS.ProcessEnv = {}) {
    const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
    return new Promise<string>((resolve, reject) => {
      const child = spawn('git', ['--no-pager', '-c', `core.worktree=${project.root}`, '-c', 'core.bare=false', '-c', `core.hooksPath=${nullFile}`, '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'core.pager=', '-c', 'diff.external=', ...extra, '-C', project.root, ...args], {
        env: { ...toolEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: nullFile, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', ...environment },
        windowsHide: true, shell: false, signal,
      });
      const chunks: Buffer[] = []; let size = 0, truncated = false;
      const capture = (chunk: Buffer) => { const accepted = chunk.subarray(0, Math.max(0, 262144 - size)); if (accepted.length) chunks.push(accepted); size += accepted.length; if (accepted.length !== chunk.length) truncated = true; };
      child.stdout.on('data', capture); child.stderr.on('data', capture);
      const timer = setTimeout(() => child.kill(), 20000).unref();
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        const output = Buffer.concat(chunks).toString('utf8') + (truncated ? '\n[output truncated]' : '');
        if (code === 0) resolve(output); else reject(new AppError('git_failed', output || 'Git operation failed'));
      });
    });
  }
  private async metadata(project: ProjectConfig) {
    await this.policy.resolve(project, '.');
    const entry = path.join(project.root, '.git'), stat = await lstat(entry);
    if (stat.isSymbolicLink()) throw new AppError('git_boundary', 'Symbolic Git metadata is not supported');
    if (stat.isDirectory()) return entry;
    if (!stat.isFile() || stat.nlink > 1 || !project.gitCommonDir || stat.size > 8192) throw new AppError('git_boundary', 'A linked worktree requires an explicitly configured gitCommonDir');
    const text = await readFile(entry, 'utf8');
    const match = /^gitdir: (.+)\r?\n?$/.exec(text);
    if (!match) throw new AppError('git_boundary', 'Invalid linked worktree metadata');
    const directory = path.resolve(project.root, match[1]!);
    const common = await realpath(project.gitCommonDir), base = path.join(common, 'worktrees');
    if ((await lstat(base)).isSymbolicLink()) throw new AppError('git_boundary', 'Worktree registry cannot be a symbolic link');
    if (!inside(base, directory) || directory === base) throw new AppError('git_boundary', 'Linked Git metadata is outside configured common directory');
    let current = base;
    for (const part of path.relative(base, directory).split(path.sep)) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new AppError('git_boundary', 'Linked Git metadata cannot contain symbolic links');
    }
    if (await realpath(directory) !== directory) throw new AppError('git_boundary', 'Linked Git directory changed');
    const backlink = path.resolve(directory, (await readFile(path.join(directory, 'gitdir'), 'utf8')).trim());
    const actualCommon = await realpath(path.resolve(directory, (await readFile(path.join(directory, 'commondir'), 'utf8')).trim()));
    if (backlink !== entry || actualCommon !== common) throw new AppError('git_boundary', 'Linked worktree backlink or common directory mismatch');
    return directory;
  }
  private async commitPaths(project: ProjectConfig, directory: string, args: { files: { path: string; expectedSha256: string | null }[]; expectedHead: string; message: string }, signal?: AbortSignal) {
    const files = new Files(this.policy), selected = [], paths = new Set<string>();
    for (const item of args.files) {
      const snapshot = await files.snapshot(project, item.path, true);
      if (snapshot.sha256 !== item.expectedSha256) throw new AppError('conflict', `File snapshot changed: ${item.path}`);
      const relative = path.relative(project.root, snapshot.filename).split(path.sep).join('/');
      if (!relative || paths.has(process.platform === 'win32' ? relative.toLowerCase() : relative)) throw new AppError('git_path', 'Select unique explicit files, not directories');
      paths.add(process.platform === 'win32' ? relative.toLowerCase() : relative);
      selected.push({ ...item, path: relative });
    }
    const lockPath = path.join(directory, 'index.lock'), indexPath = path.join(directory, 'index');
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('git_busy', 'Git index is locked; inspect the active Git operation before retrying'); throw error; }
    const candidate = path.join(directory, `homeagent-${randomUUID()}.index`), postIndex = `${candidate}.post`;
    let committed = '', finalized = false;
    try {
      const head = (await this.run(project, ['rev-parse', 'HEAD'], signal)).trim();
      const reference = (await this.run(project, ['rev-parse', '--symbolic-full-name', 'HEAD'], signal)).trim();
      if (head !== args.expectedHead) throw new AppError('head_changed', 'HEAD changed since review');
      const list = selected.map(item => item.path);
      if ((await this.run(project, ['diff', '--cached', '--name-only', '-z', '--', ...list], signal)).length) throw new AppError('staged_conflict', 'A selected path already has staged changes; review them explicitly before committing');
      const candidateEnv = { GIT_INDEX_FILE: candidate };
      await this.run(project, ['read-tree', head], signal, [], candidateEnv);
      await this.run(project, ['add', '--', ...list], signal, [], candidateEnv);
      if (!(await this.run(project, ['diff', '--cached', '--name-only', '--', ...list], signal, [], candidateEnv)).trim()) throw new AppError('nothing_to_commit', 'Selected snapshots contain no changes');
      const tree = (await this.run(project, ['write-tree'], signal, [], candidateEnv)).trim();
      const commit = (await this.run(project, ['commit-tree', tree, '-p', head, '-m', args.message], signal, [], candidateEnv)).trim();
      await copyFile(indexPath, postIndex);
      await this.run(project, ['reset', '-q', commit, '--', ...list], signal, [], { GIT_INDEX_FILE: postIndex });
      for (const item of selected) {
        if ((await files.snapshot(project, item.path, true)).sha256 !== item.expectedSha256) throw new AppError('conflict', `File changed during commit preparation: ${item.path}`);
      }
      if ((await this.run(project, ['rev-parse', '--symbolic-full-name', 'HEAD'], signal)).trim() !== reference) throw new AppError('head_changed', 'Active branch changed during commit preparation');
      const bytes = await readFile(postIndex);
      await lock.writeFile(bytes); await lock.sync(); await lock.close();
      if (signal?.aborted) throw new AppError('cancelled', 'Commit cancelled before ref update');
      try { await this.run(project, ['update-ref', '-m', 'HomeAgent selected-file commit', reference, commit, head]); committed = commit; }
      catch (error) {
        const observed = (await this.run(project, ['rev-parse', reference]).catch(() => 'unknown')).trim();
        if (observed === head) throw error;
        committed = commit;
        if (observed !== commit) throw new AppError('commit_reconcile_required', 'Ref update outcome is uncertain; inspect HEAD and the prepared index before retrying');
      }
      // Once the ref changes, finalize the prepared index even if the HTTP caller disconnects.
      await rename(lockPath, indexPath); finalized = true;
      return { commit, parent: head, files: list, preservedUnrelatedStagedChanges: true };
    } catch (error) {
      if (committed) throw new AppError('commit_reconcile_required', `Commit ${committed} exists, but index finalization needs operator inspection. Do not retry blindly.`);
      throw error;
    } finally {
      await lock.close().catch(() => {});
      if (!committed || finalized) await unlink(lockPath).catch(() => {});
      for (const temporary of [candidate, `${candidate}.lock`, postIndex, `${postIndex}.lock`]) await unlink(temporary).catch(() => {});
    }
  }
  async listFiles(project: ProjectConfig, scope: string, signal?: AbortSignal) {
    await this.metadata(project);
    await this.policy.resolve(project, scope);
    const output = await this.run(project, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', scope], signal);
    if (output.includes('[output truncated]')) throw new AppError('search_source_limit', 'Git file list exceeded the source budget; narrow the search path');
    return [...new Set(output.split('\0').filter(Boolean))];
  }
  async invoke(project: ProjectConfig, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const gitDirectory = await this.metadata(project);
    if (await this.run(project, ['rev-parse', '--show-toplevel'], signal).then(value => path.resolve(value.trim())) !== project.root) throw new AppError('git_boundary', 'Git repository root does not match the project');
    if (name === 'git_status') return this.run(project, ['status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=all'], signal);
    if (name === 'git_log') return this.run(project, ['log', `-${args.limit}`, '--format=%h %aI %an %s'], signal);
    if (name === 'git_branches') {
      const head = (await this.run(project, ['rev-parse', 'HEAD'], signal)).trim();
      const branch = (await this.run(project, ['rev-parse', '--abbrev-ref', 'HEAD'], signal)).trim();
      const branches = (await this.run(project, ['for-each-ref', '--count=100', '--format=%(refname:short)', 'refs/heads'], signal)).trim().split('\n').filter(Boolean);
      return { head, branch, branches, status: await this.run(project, ['status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=all'], signal) };
    }
    if (name === 'git_diff') {
      const paths: string[] = [];
      {
        if (args.path) await this.policy.resolve(project, String(args.path), true);
        const changed = await this.run(project, ['diff', '--name-only', '-z', ...(args.staged ? ['--cached'] : []), '--', ...(args.path ? [String(args.path)] : [])], signal);
        if (changed.includes('[output truncated]')) throw new AppError('diff_limit', 'Narrow the diff to a specific path');
        for (const name of changed.split('\0').filter(Boolean)) {
          try { await this.policy.resolve(project, name, true); paths.push(name); } catch {}
        }
        if (!paths.length) return '';
        if (paths.length > 100) throw new AppError('diff_limit', 'More than 100 eligible changed files; narrow the path');
      }
      return this.run(project, ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', ...(args.staged ? ['--cached'] : []), '--', ...paths], signal);
    }
    // Git clean/process filters can execute commands during staging. Refuse configured filters.
    let filters = '';
    try { filters = await this.run(project, ['config', '--includes', '--get-regexp', '^filter\\..*\\.(clean|process)$'], signal); }
    catch (error) { if (!(error instanceof AppError && error.message === 'Git operation failed')) throw error; }
    if (filters.trim()) throw new AppError('git_filter', 'Git writes refuse repositories with clean/process filters');
    for (const critical of ['config', 'index', 'objects', 'refs']) {
      try { if ((await lstat(path.join(gitDirectory, critical))).isSymbolicLink()) throw new AppError('git_boundary', 'Symlinked Git metadata is not supported'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (name === 'git_commit_paths') return this.commitPaths(project, gitDirectory, args as unknown as { files: { path: string; expectedSha256: string | null }[]; expectedHead: string; message: string }, signal);
    if (name === 'git_switch_branch') {
      const branch = String(args.branch);
      if (branch.startsWith('-')) throw new AppError('invalid_branch', 'Branch cannot start with an option prefix');
      await this.run(project, ['check-ref-format', '--branch', branch], signal);
      if ((await this.run(project, ['status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=all'], signal)).trim()) throw new AppError('dirty_worktree', 'Switching branches requires a clean working tree and index');
      await this.run(project, ['switch', ...(args.create ? ['-c'] : []), branch], signal);
      return this.invoke(project, 'git_branches', {}, signal);
    }
    if (name === 'git_add') {
      const paths = args.paths as string[];
      for (const file of paths) {
        const resolved = await this.policy.resolve(project, file, true);
        if (resolved === project.root) throw new AppError('git_path', 'Stage explicit files or subdirectories, not the entire project root');
        try { if ((await lstat(resolved)).isDirectory()) throw new AppError('git_path', 'Stage explicit files so excluded descendants cannot be included implicitly'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      return this.run(project, ['add', '--', ...paths], signal);
    }
    if (name === 'git_commit') return this.run(project, ['-c', 'core.editor=false', 'commit', '--no-verify', '--no-gpg-sign', '-m', String(args.message)], signal);
    throw new AppError('unknown_tool', 'Unknown Git tool');
  }
}
