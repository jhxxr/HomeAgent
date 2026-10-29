import { mkdir, readFile, writeFile, readdir, unlink, rename, chmod, open, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../shared/protocol.js';
import type { FileChange } from '../shared/tools.js';
import type { ProjectConfig, RunnerConfig } from './config.js';
import { Files, sha256 } from './files.js';

const entrySchema = z.object({ path: z.string(), before: z.string().nullable(), after: z.string().nullable(), mode: z.number().int(), index: z.number().int().min(0).max(31) });
const manifestSchema = z.object({ id: z.string().uuid(), projectId: z.string(), rootHash: z.string(), owner: z.string(), created: z.number(), entries: z.array(entrySchema).max(32) });
type Manifest = z.infer<typeof manifestSchema>;
type Receipt = { state: 'prepared' | 'applying' | 'completed' | 'rolled_back' | 'recovery_conflict'; conflicts?: string[] };
export class Editor {
  readonly ready: Promise<void>;
  private directory: string;
  private blocked = new Set<string>();
  constructor(private config: RunnerConfig, private files: Files) {
    this.directory = path.join(config.stateDir, 'edits');
    this.ready = this.initialize();
    void this.ready.catch(() => {}); // The first tool call surfaces recovery errors without an unhandled rejection.
  }
  private async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.recoverPending();
  }
  async reconcileProjects() {
    await this.ready;
    await this.recoverPending();
  }
  private async recoverPending() {
    const blocked = new Set<string>();
    for (const name of await readdir(this.directory)) {
      if (!z.string().uuid().safeParse(name).success) continue;
      const manifest = await this.manifest(name);
      const receipt = await this.receipt(name);
      if (receipt.state === 'completed' || receipt.state === 'rolled_back') continue;
      const project = this.config.projects.find(item => item.id === manifest.projectId);
      if (!project || sha256(project.root) !== manifest.rootHash) { blocked.add(manifest.projectId); continue; }
      const recovered = await this.rollback(project, manifest);
      if (recovered.state === 'recovery_conflict') blocked.add(project.id);
    }
    this.blocked = blocked;
  }
  private folder(id: string) { return path.join(this.directory, z.string().uuid().parse(id)); }
  private async manifest(id: string): Promise<Manifest> { return manifestSchema.parse(JSON.parse(await readFile(path.join(this.folder(id), 'manifest.json'), 'utf8'))); }
  private async receipt(id: string): Promise<Receipt> {
    try { return JSON.parse(await readFile(path.join(this.folder(id), 'state.json'), 'utf8')) as Receipt; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'prepared' }; throw error; }
  }
  private async save(id: string, receipt: Receipt) {
    const target = path.join(this.folder(id), 'state.json'), temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target);
  }
  private async prune() {
    const directories = await readdir(this.directory);
    if (directories.length < 220) return;
    const completed = [];
    for (const name of directories) {
      if (!z.string().uuid().safeParse(name).success) continue;
      const receipt = await this.receipt(name);
      if (receipt.state === 'completed' || receipt.state === 'rolled_back') completed.push(await this.manifest(name));
    }
    for (const manifest of completed.sort((a, b) => b.created - a.created).slice(199)) {
      const folder = this.folder(manifest.id);
      for (const entry of manifest.entries) await unlink(path.join(folder, `${entry.index}.before`)).catch(() => {});
      await unlink(path.join(folder, 'state.json'));
      await unlink(path.join(folder, 'manifest.json'));
      await rmdir(folder).catch(() => {});
    }
    if ((await readdir(this.directory)).length >= 1000) throw new AppError('edit_history_limit', 'Too many pending edit directories; operator recovery is required');
  }
  async list(project: ProjectConfig, owner: string) {
    await this.ready;
    const transactions = [];
    for (const name of await readdir(this.directory)) {
      if (!z.string().uuid().safeParse(name).success) continue;
      const manifest = await this.manifest(name);
      if (manifest.projectId === project.id && manifest.owner === owner) transactions.push({ id: name, created: manifest.created, paths: manifest.entries.map(entry => entry.path), ...await this.receipt(name) });
    }
    return transactions.sort((a, b) => b.created - a.created);
  }
  async assertWritable(project: ProjectConfig) {
    await this.ready;
    if (this.blocked.has(project.id)) throw new AppError('recovery_required', 'This project has an interrupted edit conflict. Inspect get_edit_transactions and recover it before further mutations.');
  }
  private async rollback(project: ProjectConfig, manifest: Manifest): Promise<Receipt> {
    const conflicts: string[] = [];
    for (const entry of [...manifest.entries].reverse()) {
      let current;
      try { current = await this.files.snapshot(project, entry.path, true); }
      catch { conflicts.push(entry.path); continue; }
      if (current.sha256 === entry.before) continue;
      if (current.sha256 !== entry.after) { conflicts.push(entry.path); continue; }
      try {
        if (entry.before === null) await unlink(current.filename);
        else {
          const bytes = await readFile(path.join(this.folder(manifest.id), `${entry.index}.before`));
          if (sha256(bytes) !== entry.before) throw new AppError('corrupt_backup', 'Edit backup digest mismatch; recovery stopped');
          await this.files.atomic(current.filename, bytes); await chmod(current.filename, entry.mode);
        }
      } catch { conflicts.push(entry.path); }
    }
    const receipt: Receipt = conflicts.length ? { state: 'recovery_conflict', conflicts } : { state: 'rolled_back' };
    await this.save(manifest.id, receipt);
    if (!conflicts.length) for (const entry of manifest.entries) await unlink(path.join(this.folder(manifest.id), `${entry.index}.before`)).catch(() => {});
    return receipt;
  }
  async recover(project: ProjectConfig, owner: string, id: string) {
    await this.ready;
    const manifest = await this.manifest(id);
    if (manifest.projectId !== project.id || manifest.owner !== owner || manifest.rootHash !== sha256(project.root)) throw new AppError('forbidden', 'Transaction does not belong to this project, owner and root');
    const state = await this.receipt(id);
    if (state.state === 'completed' || state.state === 'rolled_back') return { id, ...state };
    const receipt = await this.rollback(project, manifest);
    if (receipt.state === 'rolled_back') {
      this.blocked.delete(project.id);
      for (const name of await readdir(this.directory)) {
        if (!z.string().uuid().safeParse(name).success) continue;
        const other = await this.manifest(name), state = await this.receipt(name);
        if (other.projectId === project.id && !['completed', 'rolled_back'].includes(state.state)) this.blocked.add(project.id);
      }
    }
    return { id, ...receipt };
  }
  async edit(project: ProjectConfig, owner: string, changes: FileChange[], dryRun: boolean, signal?: AbortSignal) {
    await this.assertWritable(project);
    const prepared = [];
    const paths = new Set<string>();
    for (const change of changes) {
      const current = await this.files.snapshot(project, change.path, change.operation === 'create' || change.operation === 'delete');
      if (change.operation === 'create') {
        const parent = await this.files.info(project, path.relative(project.root, path.dirname(current.filename)) || '.');
        if (parent.type !== 'directory') throw new AppError('missing_parent', 'Create the parent directory before editing a new file');
      }
      const identity = process.platform === 'win32' ? current.filename.toLowerCase() : current.filename;
      if (paths.has(identity)) throw new AppError('duplicate_path', 'A file may appear only once in an edit batch');
      paths.add(identity);
      if (change.operation === 'create' && current.bytes !== null) throw new AppError('exists', `File already exists: ${change.path}`);
      if (change.operation !== 'create' && current.sha256 !== change.expectedSha256) throw new AppError('conflict', `File changed: ${change.path}`);
      let after: Buffer | null = null;
      if (change.operation === 'create' || change.operation === 'replace') after = Buffer.from(change.content);
      else if (change.operation === 'edit') {
        let text = new TextDecoder('utf-8', { fatal: true }).decode(current.bytes!);
        for (const edit of change.edits) {
          const at = text.indexOf(edit.oldText);
          if (at < 0 || text.indexOf(edit.oldText, at + 1) >= 0) throw new AppError('not_unique', `Each oldText must match exactly once: ${change.path}`);
          text = text.slice(0, at) + edit.newText + text.slice(at + edit.oldText.length);
        }
        after = Buffer.from(text);
      }
      if (after && after.length > 1024 * 1024) throw new AppError('file_limit', 'A resulting file exceeds 1 MiB');
      prepared.push({ change, current, after });
    }
    if (prepared.reduce((size, item) => size + (item.current.bytes?.length ?? 0) + (item.after?.length ?? 0), 0) > 8 * 1024 * 1024) throw new AppError('batch_limit', 'Combined before/after images exceed the 8 MiB transaction limit');
    const summary = prepared.map(item => ({ path: item.change.path, operation: item.change.operation, beforeSha256: item.current.sha256, afterSha256: item.after === null ? null : sha256(item.after) }));
    if (dryRun) return { dryRun: true, changes: summary };
    await this.prune();
    const id = randomUUID(), folder = this.folder(id);
    const staging = `${folder}.preparing`;
    await mkdir(staging, { mode: 0o700 });
    const manifest: Manifest = { id, projectId: project.id, rootHash: sha256(project.root), owner, created: Date.now(), entries: prepared.map((item, index) => ({ path: path.relative(project.root, item.current.filename), before: item.current.sha256, after: item.after === null ? null : sha256(item.after), mode: item.current.mode, index })) };
    // Backups and plans are private Runner state; no plaintext file data is sent to the relay audit.
    for (let index = 0; index < prepared.length; index++) {
      const item = prepared[index]!;
      if (item.current.bytes) {
        const handle = await open(path.join(staging, `${index}.before`), 'wx', 0o600);
        try { await handle.writeFile(item.current.bytes); await handle.sync(); } finally { await handle.close(); }
      }
    }
    await writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
    await rename(staging, folder);
    try {
      await this.save(id, { state: 'applying' });
      for (const item of prepared) {
        if (signal?.aborted) throw new AppError('cancelled', 'Edit batch cancelled');
        const current = await this.files.snapshot(project, item.change.path, true);
        if (current.sha256 !== item.current.sha256) throw new AppError('conflict', `File changed after preflight: ${item.change.path}`);
        project.assertAccess?.();
        if (item.after === null) await unlink(current.filename);
        else await this.files.atomic(current.filename, item.after, project.assertAccess);
      }
      await this.save(id, { state: 'completed' });
      for (const entry of manifest.entries) await unlink(path.join(folder, `${entry.index}.before`)).catch(() => {});
      return { transactionId: id, state: 'completed', changes: summary };
    } catch (error) {
      const recovery = await this.rollback(project, manifest);
      if (recovery.state === 'recovery_conflict') this.blocked.add(project.id);
      throw new AppError(recovery.state === 'rolled_back' ? 'edit_rolled_back' : 'recovery_required', `Edit failed; transaction ${id}: ${recovery.state}. ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
